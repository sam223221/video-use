/* =============================================================================
   transcribe.js — the per-clip TAP-TO-TRANSCRIBE controller (arch §7, M2 T4).
   -----------------------------------------------------------------------------
   The user-facing half of M2: a clip on the Media page gains a Transcribe
   affordance; tapping it opens a consent sheet (cost + the one-byte-leaves
   privacy line), and on confirm the device

     extract (engine/audio.js → audio-only .m4a in transcripts/clip_x.m4a.tmp)
       → upload (api.uploadTranscribeAudio → raw audio/mp4 body → 202 {job_id})
       → poll  (api.pollTranscribe, lock-proof, resumes on reload)
       → done  (store/transcripts.writeTranscript) → the transcript view.

   THE FOUR INVARIANTS this module is built on (arch §5.1, §2.1, §7.1):

   1. The .m4a is TRANSIENT. extractAudio writes through
      writers.tempThenRename(transcriptsDir, "clip_<id>.m4a"); the flow NEVER
      commits — it reads the committed `.tmp` back as a File, uploads that, then
      ALWAYS calls target.abandon() (success OR failure). A crash leaves a
      transcripts/*.tmp orphan the boot sweep removes (store/opfs.sweepTmp).

   2. duration_s is the EXTRACTED-file duration (result.durationS), NOT
      clipmeta's video duration — they differ by the AAC priming offset
      (engine/audio.js re-bases the track to 0). The cost estimate and the
      stored audio_duration_s both use this.

   3. Extract + upload run on the SHARED single-flight op queue (banked M0 #6 —
      never concurrent with an export/ingest/agent engine op) with a wake lock
      and the crash marker held. The POLL phase does NOT hold the queue (arch
      §7.1 step 6): once the 202 lands the heavy device work is done — the wake
      lock, op marker and queue are released and the relay job runs on its own.

   4. The poll is LOCK-PROOF. A {job_id, clip_id} marker is persisted to
      localStorage the instant the 202 lands; a reopened app re-attaches the
      poll from that marker (the phone-lock-mid-transcribe / reload case, arch
      §2.1, §7.1 step 7). The relay's 120 s delivered-grace covers a device that
      crashed between the `done` fetch and the OPFS write.

   Honest errors + FREE retry: an EL-side error or a 404 (relay restarted) shows
   a stage-specific message and a Retry that re-runs from extract (re-extraction
   is seconds and costs nothing — arch §10.8). Redo of an existing transcript is
   the same consent sheet and OVERWRITES atomically (counts against daily caps).

   XSS posture: every dynamic string lands via util.el()'s textContent path —
   no innerHTML anywhere (arch §8.7). The transcript view renders lines through
   textContent only.

   ctx (from editor.js):
     { project:{id,name}, caps, deviceId, queue, findClipFile,
       engine() → adapter|null (exposes extractAudio + tempThenRename),
       notifyTranscriptChange() }
============================================================================= */

import { el, icon, toast, fmtDuration, fmtBytes, trapFocus } from "./util.js";
import { projectSubDir, setOpMarker, clearOpMarker, quotaPreflight } from "./store/opfs.js";
import { writeTranscript, readTranscript, deleteTranscript } from "./store/transcripts.js";
import {
  uploadTranscribeAudio, pollTranscribe, cancelTranscribe, transcribeStatus,
} from "./api.js";

const POLL_INTERVAL_MS = 2500;        // arch §2.1 / §7.1 step 6
const COST_PER_AUDIO_HOUR_USD = 0.40; // arch §0 / M0 verdict (~$0.40/audio-hour)
const AUDIO_BYTES_PER_S = 24 * 1024;  // ~24 KB/s AAC quota preflight estimate (arch §7.1 step 3)
const JOB_MARKER_KEY = "studio2.transcribe.job.v1"; // {project_id, clip_id, job_id, clip_name}

function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function estCostUsd(durationS) {
  if (!Number.isFinite(durationS) || durationS <= 0) return 0;
  return Math.round((durationS / 3600) * COST_PER_AUDIO_HOUR_USD * 100) / 100;
}

function fmtCost(usd) {
  // Always two decimals, with a leading "<" for sub-cent so it never reads $0.00.
  if (!Number.isFinite(usd) || usd <= 0) return "less than $0.01";
  if (usd < 0.01) return "less than $0.01";
  return "$" + usd.toFixed(2);
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  return m + ":" + String(s % 60).padStart(2, "0");
}

/* =============================================================================
   Wake lock — capability-gated, re-acquired on visibility regain (ingest.js
   pattern). Held ONLY during extract + upload (arch §7.1 step 5). Never throws.
============================================================================= */
function makeWakeLock(enabled) {
  let sentinel = null;
  let want = false;
  async function acquire() {
    want = true;
    if (!enabled || !("wakeLock" in navigator)) return;
    try {
      sentinel = await navigator.wakeLock.request("screen");
      sentinel.addEventListener("release", () => { sentinel = null; });
    } catch { sentinel = null; }
  }
  function release() {
    want = false;
    if (sentinel) {
      try { sentinel.release(); } catch { /* already released */ }
      sentinel = null;
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === "visible" && want && !sentinel) acquire();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return {
    acquire, release,
    destroy() { release(); document.removeEventListener("visibilitychange", onVisibility); },
  };
}

/* =============================================================================
   The localStorage job marker (lock-proof poll resume, arch §7.1 step 7)
============================================================================= */
function setJobMarker(marker) {
  try { localStorage.setItem(JOB_MARKER_KEY, JSON.stringify(marker)); } catch { /* best-effort */ }
}
function clearJobMarker() {
  try { localStorage.removeItem(JOB_MARKER_KEY); } catch { /* ignore */ }
}
function readJobMarker() {
  try {
    const raw = localStorage.getItem(JOB_MARKER_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (m && typeof m === "object" && typeof m.job_id === "string" &&
        typeof m.clip_id === "string" && typeof m.project_id === "string") {
      return m;
    }
  } catch { /* torn marker */ }
  return null;
}

/* =============================================================================
   Consent sheet (arch §7.1 step 2) — a bottom sheet, ARIA dialog, focus-trapped.
   The privacy line is NON-NEGOTIABLE: this is the architecture's one
   byte-leaves-device exception and the user consents PER CLIP, every time.
============================================================================= */
function openConsentSheet({ clipName, durationS, redo, onConfirm }) {
  const cost = fmtCost(estCostUsd(durationS));
  const minutes = mmss(durationS);

  const titleId = "transcribe-consent-title";
  const descId = "transcribe-consent-desc";

  const confirmBtn = el("button", { class: "btn btn--primary", type: "button" },
    [redo ? "Redo transcription" : "Transcribe"]);
  const cancelBtn = el("button", { class: "btn", type: "button" }, ["Cancel"]);

  const card = el("div", {
    class: "sheet__card", role: "dialog", "aria-modal": "true",
    "aria-labelledby": titleId, "aria-describedby": descId,
  }, [
    el("div", { class: "sheet__head" }, [
      el("span", { class: "sheet__icon", "aria-hidden": "true" }, [icon("i-doc")]),
      el("h2", { class: "sheet__title", id: titleId, text: redo ? "Transcribe again?" : "Transcribe this clip?" }),
    ]),
    el("p", { class: "sheet__lead", id: descId }, [
      el("span", { class: "sheet__clip", text: clipName }),
      el("span", { class: "mono sheet__cost", text: minutes + " of audio · " + cost }),
    ]),
    el("p", { class: "sheet__privacy" }, [
      icon("i-shield"),
      el("span", {
        text: "The clip's audio — not the video — is sent to ElevenLabs for " +
          "transcription. Your footage stays on this device.",
      }),
    ]),
    redo ? el("p", { class: "sheet__note", text: "This replaces the current transcript and counts as a new transcription." }) : null,
    el("div", { class: "sheet__actions" }, [cancelBtn, confirmBtn]),
  ]);

  const overlay = el("div", { class: "sheet", dataset: { kind: "consent" } }, [card]);
  document.body.append(overlay);

  let closed = false;
  const releaseTrap = trapFocus(card);
  const prevFocus = document.activeElement;

  function close() {
    if (closed) return;
    closed = true;
    releaseTrap();
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* gone */ }
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  cancelBtn.addEventListener("click", close);
  confirmBtn.addEventListener("click", () => { close(); onConfirm(); });

  requestAnimationFrame(() => confirmBtn.focus());
  return { close };
}

/* =============================================================================
   Transcript view sheet (arch §7.5) — read-only, time-anchored lines, minimal.
   Each line is prefixed with its m:ss anchor; textContent only.
============================================================================= */
function lineGroups(doc) {
  // Group words into m:ss-anchored lines for the human view (same heuristic
  // family as the bridge's read_transcript text mode — sentence/gap/length).
  const words = Array.isArray(doc.words) ? doc.words : [];
  if (words.length === 0) return [];
  const lines = [];
  let cur = null;
  const endsSentence = (w) => /[.!?…]["')\]]?$/.test(String(w || ""));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const token = String(w.w || "");
    if (!cur) { cur = { s: w.s, text: token, prevW: token, prevE: w.e }; continue; }
    const gap = w.s - cur.prevE;
    const tooLong = cur.text.length + 1 + token.length > 140;
    const hardGap = gap >= 0.8;
    const sentenceBreak = endsSentence(cur.prevW) && gap >= 0.35;
    if (tooLong || hardGap || sentenceBreak) {
      lines.push({ s: cur.s, text: cur.text });
      cur = { s: w.s, text: token, prevW: token, prevE: w.e };
    } else {
      cur.text += " " + token;
      cur.prevW = token;
      cur.prevE = w.e;
    }
  }
  if (cur) lines.push({ s: cur.s, text: cur.text });
  return lines;
}

function openTranscriptView({ clipName, doc, onRedo }) {
  const titleId = "transcript-view-title";
  const closeBtn = el("button", {
    class: "icon-btn", type: "button", "aria-label": "Close transcript",
  }, [icon("i-close")]);

  const lang = typeof doc.language_code === "string" ? doc.language_code : null;
  const prob = typeof doc.language_probability === "number"
    ? Math.round(doc.language_probability * 100) : null;
  const metaBits = [
    fmtDuration(doc.audio_duration_s),
    lang ? (prob != null ? lang + " · " + prob + "%" : lang) : null,
    (Array.isArray(doc.words) ? doc.words.length : 0) + " words",
  ].filter(Boolean).join(" · ");

  const groups = lineGroups(doc);
  const bodyChildren = groups.length > 0
    ? groups.map((g) => el("p", { class: "transcript-line" }, [
        el("span", { class: "mono transcript-line__t", text: mmss(g.s) }),
        el("span", { class: "transcript-line__text", text: g.text }),
      ]))
    : [el("p", { class: "transcript-view__empty", text: "No speech was found in this clip's audio." })];

  const redoBtn = el("button", { class: "btn btn--sm", type: "button" }, [
    icon("i-refresh"), el("span", { text: "Redo" }),
  ]);
  redoBtn.addEventListener("click", () => { close(); onRedo(); });

  const card = el("div", {
    class: "sheet__card sheet__card--tall", role: "dialog", "aria-modal": "true",
    "aria-labelledby": titleId,
  }, [
    el("div", { class: "transcript-view__head" }, [
      el("div", { class: "transcript-view__heading" }, [
        el("h2", { class: "sheet__title", id: titleId, text: clipName }),
        el("span", { class: "mono transcript-view__meta", text: metaBits }),
      ]),
      closeBtn,
    ]),
    el("div", {
      class: "transcript-view__body", role: "region",
      "aria-label": "Transcript", tabindex: "0",
    }, bodyChildren),
    el("div", { class: "transcript-view__foot" }, [redoBtn]),
  ]);

  const overlay = el("div", { class: "sheet", dataset: { kind: "transcript" } }, [card]);
  document.body.append(overlay);

  let closed = false;
  const releaseTrap = trapFocus(card);
  const prevFocus = document.activeElement;
  function close() {
    if (closed) return;
    closed = true;
    releaseTrap();
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* gone */ }
  }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  closeBtn.addEventListener("click", close);

  requestAnimationFrame(() => closeBtn.focus());
  return { close };
}

/* =============================================================================
   mountTranscribe(ctx) — the controller editor.js consumes.
   -----------------------------------------------------------------------------
   Returns:
     {
       setStatus(gate)            — feed it the api.transcribeStatus() result;
                                     re-renders every clip's affordance.
       renderClip(clipMeta) → Node — the per-clip affordance/badge element the
                                     clip strip embeds. Reflects the live gate,
                                     no-audio state, transcript presence, and an
                                     in-progress job for THIS clip.
       refresh()                  — re-read transcript presence + re-render.
       resumePendingJob()         — re-attach the poll from the localStorage
                                     marker (lock-proof; called on mount).
       destroy()
     }
============================================================================= */
export function mountTranscribe(ctx) {
  const project = ctx.project;
  const projectId = project.id;
  const caps = ctx.caps || (typeof window !== "undefined" && window.__studio2Caps) || {};
  const queue = ctx.queue;

  let destroyed = false;
  let gate = null;                  // {configured, enabled, daily_remaining, reachable}
  // Per-clip live state: clip_id → { node, btnHost, meta, transcript, job }
  const clips = new Map();
  // The single active job controller (concurrency cap = 1 — arch §3.1, §8.5).
  let activeJob = null;
  const wake = makeWakeLock(!!caps.wakeLock);

  /* ---- gate predicate (arch §3.5 / §7.4) -------------------------------- */
  function gateReason(meta) {
    // Returns null when transcribing is allowed, else a {kind, text} reason
    // that disables the affordance with an honest explanation.
    if (!meta.audio) {
      return { kind: "no_audio", text: "This copy has no sound" };
    }
    if (!gate) return { kind: "checking", text: "Checking…" };
    if (!gate.reachable) {
      return { kind: "offline", text: "Needs your home connection" };
    }
    if (!gate.configured) {
      return { kind: "unconfigured", text: "Transcription isn't set up on the studio brain" };
    }
    if (!gate.enabled) {
      return { kind: "disabled", text: "Transcription is turned off" };
    }
    if (gate.daily_remaining && gate.daily_remaining.calls <= 0) {
      return { kind: "capped", text: "Daily transcription limit reached — resets at midnight" };
    }
    return null;
  }

  /* ---- per-clip affordance rendering ------------------------------------ */
  function renderClip(meta) {
    const host = el("div", { class: "clip-transcribe" });
    const entry = clips.get(meta.clip_id) || {};
    entry.meta = meta;
    entry.host = host;
    clips.set(meta.clip_id, entry);
    paintClip(meta.clip_id);
    return host;
  }

  function paintClip(clipId) {
    const entry = clips.get(clipId);
    if (!entry || !entry.host) return;
    const meta = entry.meta;
    const host = entry.host;
    host.replaceChildren();

    // 1. A job is running for THIS clip → inline stage progress (this clip only).
    if (entry.job) {
      host.append(entry.job.node);
      return;
    }

    // 2. A transcript exists → a badge that opens the view; no button.
    if (entry.transcript) {
      const t = entry.transcript;
      const lang = typeof t.language_code === "string" ? t.language_code : null;
      const badge = el("button", {
        class: "transcribe-badge", type: "button",
        "aria-label": "View transcript for " + (meta.original_name || meta.clip_id),
      }, [
        el("span", { class: "transcribe-badge__dot", "aria-hidden": "true" }, [icon("i-doc")]),
        el("span", { class: "transcribe-badge__text", text: "Transcript" }),
        el("span", {
          class: "mono transcribe-badge__meta",
          text: [fmtDuration(t.audio_duration_s), lang].filter(Boolean).join(" · "),
        }),
      ]);
      badge.addEventListener("click", () => {
        openTranscriptView({
          clipName: meta.original_name || meta.clip_id,
          doc: t,
          onRedo: () => startConsent(meta, true),
        });
      });
      host.append(badge);
      return;
    }

    // 3. No transcript → the Transcribe affordance, gated.
    const reason = gateReason(meta);
    if (reason) {
      host.append(el("div", { class: "transcribe-disabled", dataset: { kind: reason.kind } }, [
        icon(reason.kind === "no_audio" ? "i-alert" : "i-offline"),
        el("span", { class: "transcribe-disabled__text", text: reason.text }),
      ]));
      return;
    }

    const estS = Number.isFinite(meta.duration_s) ? meta.duration_s : 0;
    const btn = el("button", {
      class: "btn btn--sm transcribe-btn", type: "button",
      "aria-label": "Transcribe " + (meta.original_name || meta.clip_id),
    }, [
      icon("i-doc"),
      el("span", { text: "Transcribe" }),
      el("span", { class: "mono transcribe-btn__cost", text: "≈ " + fmtCost(estCostUsd(estS)) }),
    ]);
    btn.addEventListener("click", () => startConsent(meta, false));
    host.append(btn);
  }

  /* ---- consent → run ----------------------------------------------------- */
  function startConsent(meta, redo) {
    if (destroyed) return;
    if (activeJob) {
      toast("A transcription is already running — wait for it to finish.", "info");
      return;
    }
    // Re-check the gate cheaply: it may have changed since the last paint.
    const reason = gateReason(meta);
    if (reason && reason.kind !== "checking") {
      toast(reason.text + ".", "info");
      return;
    }
    openConsentSheet({
      clipName: meta.original_name || meta.clip_id,
      // The button's estimate is the VIDEO duration; the real declared duration
      // is the extracted audio's, computed during the run. Close enough for the
      // consent figure (they differ by ms of priming offset).
      durationS: Number.isFinite(meta.duration_s) ? meta.duration_s : 0,
      redo,
      onConfirm: () => runJob(meta, redo),
    });
  }

  /* ---- the job: extract → upload → poll → save -------------------------- */
  async function runJob(meta, redo) {
    if (destroyed || activeJob) return;
    const clipId = meta.clip_id;
    const entry = clips.get(clipId) || { meta };
    clips.set(clipId, entry);

    // The inline progress UI for this clip.
    const progress = makeClipProgress(meta);
    entry.job = progress;
    activeJob = { clipId, progress, cancel: progress.requestCancel };
    paintClip(clipId);

    // Stage 1+2 (extract + upload) run on the shared single-flight op queue
    // with the wake lock + crash marker held. Stage 3 (poll) runs OUTSIDE it.
    let target = null;
    let jobId = null;
    try {
      await queue.run(async () => {
        if (destroyed || progress.cancelled) throw makeCancelled();
        const engine = ctx.engine();
        if (!engine || typeof engine.extractAudio !== "function" ||
            typeof engine.tempThenRename !== "function") {
          throw new Error("The editing engine isn't loaded — refresh the Studio app and try again.");
        }
        const file = await ctx.findClipFile(clipId);
        if (!file) throw new Error("This clip's video file is missing from the project.");

        setOpMarker("transcribe", projectId, { clip_id: clipId });
        await wake.acquire();

        // Quota preflight BEFORE extraction (arch §7.1.3): estimate the spool
        // at ~24 KB/s of audio + headroom; pass-open (a null estimate from a
        // platform without the API never blocks). The spool is ~1% of the clip,
        // so this rarely fails — but it fails CLEAN here instead of mid-write.
        const estBytes = Math.max(1, Number.isFinite(meta.duration_s) ? meta.duration_s : 0) * AUDIO_BYTES_PER_S;
        const pre = await quotaPreflight(estBytes);
        if (!pre.ok) {
          throw new Error("Not enough space on this device to extract the audio. Free up some space and try again.");
        }

        // --- Extract (engine/audio.js) → transcripts/clip_<id>.m4a.tmp -------
        progress.stage("extract", "Extracting audio…");
        const transcriptsDir = await projectSubDir(projectId, "transcripts", { create: true });
        target = await engine.tempThenRename(transcriptsDir, clipId + ".m4a");
        const result = await engine.extractAudio({
          file,
          target,
          onProgress: ({ mediaBytes }) => progress.bytes(mediaBytes),
        });
        if (destroyed || progress.cancelled) throw makeCancelled();

        // Commit the .tmp (close, no rename) so we can read the bytes back, then
        // read it as a File for the upload. The .m4a is TRANSIENT — abandon()
        // in finally deletes it either way (arch §5.1).
        if (!target.stats.closed) await target.stream.close();
        const audioFile = await target.handle.getFile();

        // Light verify (banked #5): bytes match what the writer reports, > 0.
        if (audioFile.size !== result.writes.logicalEnd || audioFile.size <= 0) {
          throw new Error("The extracted audio looked incomplete — try again.");
        }

        // --- Upload (raw audio/mp4 body) → 202 {job_id} ----------------------
        progress.stage("upload", "Sending audio to the studio brain…");
        const declaredDuration = Number.isFinite(result.durationS) && result.durationS > 0
          ? result.durationS
          : (Number.isFinite(meta.duration_s) ? meta.duration_s : 0);
        const accepted = await uploadTranscribeAudio(audioFile, {
          project_id: projectId,
          clip_id: clipId,
          duration_s: declaredDuration,
        }, { signal: progress.signal });
        jobId = accepted && accepted.job_id;
        if (typeof jobId !== "string") throw new Error("The studio brain didn't start the job — try again.");

        dlog("info", "transcribe.accepted", {
          project_id: projectId, clip_id: clipId, job_id: jobId,
          audio_bytes: audioFile.size, duration_s: declaredDuration,
          est_cost_usd: accepted.est_cost_usd, redo: !!redo,
        });
        // 202 landed: persist the lock-proof marker, then release the heavy
        // device resources (the relay job now runs on its own — arch §7.1.5).
        setJobMarker({
          project_id: projectId, clip_id: clipId, job_id: jobId,
          clip_name: meta.original_name || meta.clip_id,
        });
      });
    } catch (err) {
      // Extract/upload failed (or was cancelled) BEFORE the 202 — no cost was
      // incurred (the 202 never landed). Clean up and offer a free retry.
      await safeAbandon(target);
      clearOpMarker();
      wake.release();
      activeJob = null;
      if (isCancelled(err)) {
        entry.job = null;
        paintClip(clipId);
        return;
      }
      dlog("warn", "transcribe.run.err", { clip_id: clipId, message: errMsg(err) });
      progress.error(humanizeUpload(err), () => {
        entry.job = null;
        runJob(meta, redo);          // free re-run from extract
      }, () => {                     // dismiss
        entry.job = null;
        paintClip(clipId);
      });
      return;
    }

    // The 202 landed — release the queue/wake/marker, the .m4a is no longer
    // needed, and the poll takes over OUTSIDE the op queue (arch §7.1 step 6).
    await safeAbandon(target);
    clearOpMarker();
    wake.release();

    // Hand the running job to the shared poll loop.
    pollUntilDone({ meta, jobId, progress, redo });
  }

  /* ---- poll loop (lock-proof; runs outside the op queue) ----------------- */
  async function pollUntilDone({ meta, jobId, progress, redo }) {
    const clipId = meta.clip_id;
    progress.stage("transcribing", "Transcribing — this can take a few minutes for long clips.");
    progress.attachPoll();

    // The loop pauses while hidden and re-polls immediately on visibility
    // regain; a locked phone costs nothing — the relay job keeps running.
    const ctl = { stop: false };
    let timer = 0;

    const onVisible = () => {
      if (document.visibilityState === "visible" && !ctl.stop) pollOnce();
    };
    document.addEventListener("visibilitychange", onVisible);

    let polling = false;
    const finish = (fn) => {
      ctl.stop = true;
      if (timer) { clearInterval(timer); timer = 0; }
      document.removeEventListener("visibilitychange", onVisible);
      activeJob = null;
      fn();
    };

    // The single active job: its Cancel button (and destroy) routes here.
    activeJob = { clipId, progress, cancel: () => requestCancelJob({ jobId, progress, meta, finish }) };

    async function pollOnce() {
      if (ctl.stop || polling) return;
      if (document.visibilityState === "hidden") return; // resume on visibility
      polling = true;
      try {
        const body = await pollTranscribe(jobId);
        if (ctl.stop) return;
        if (body && body.status === "transcribing") {
          progress.elapsed(body.elapsed_s);
          return; // keep polling on the interval
        }
        if (body && body.status === "done") {
          await onDone({ meta, jobId, transcript: body.transcript, progress, finish });
          return;
        }
        // status:"error"
        const errObj = (body && body.error) || { code: "provider_error", message: "Transcription failed." };
        finish(() => {
          clearJobMarker();
          showJobError(meta, progress, errObj, redo);
        });
      } catch (err) {
        if (err && err.name === "ApiError" && err.status === 404) {
          // Unknown/expired/post-restart (arch §3.2) — the relay forgot it.
          finish(() => {
            clearJobMarker();
            showJobError(meta, progress, {
              code: "job_not_found",
              message: "The studio brain restarted — start the transcription again.",
            }, redo);
          });
          return;
        }
        if (err && err.name === "ApiError" && err.status === 0) {
          // Network blip — keep the loop alive, the next tick retries.
          progress.note("Reconnecting…");
          return;
        }
        // Any other failure: surface honestly, retry available.
        finish(() => {
          clearJobMarker();
          showJobError(meta, progress, {
            code: "poll_error", message: errMsg(err) || "Couldn't reach the studio brain.",
          }, redo);
        });
      } finally {
        polling = false;
      }
    }

    // The clip's Cancel button stops the relay job; destroy() stops the loop.
    progress.onCancel(() => requestCancelJob({ jobId, progress, meta, finish }));
    progress.onStop(() => finish(() => { /* loop torn down on editor destroy */ }));

    pollOnce();
    timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  /* ---- done: validate + persist + show ----------------------------------- */
  async function onDone({ meta, jobId, transcript, progress, finish }) {
    const clipId = meta.clip_id;
    progress.stage("saving", "Saving the transcript…");
    // Validate: the clip must still exist; the transcript must be for THIS clip.
    let still = null;
    try { still = await ctx.findClipFile(clipId); } catch { still = null; }
    if (!still) {
      finish(() => {
        clearJobMarker();
        showJobError(meta, progress, {
          code: "clip_gone", message: "This clip was removed while it was being transcribed.",
        }, false);
      });
      return;
    }
    try {
      // writeTranscript schema-validates + rejects a clip_id mismatch (throws).
      const clean = await writeTranscript(projectId, clipId, transcript);
      const entry = clips.get(clipId) || { meta };
      entry.transcript = clean;
      entry.job = null;
      clips.set(clipId, entry);
      finish(() => {
        clearJobMarker();
        paintClip(clipId);
        notifyChange();
        const words = Array.isArray(clean.words) ? clean.words.length : 0;
        dlog("info", "transcribe.done", { clip_id: clipId, job_id: jobId, words });
        toast("Transcript ready — open it from the clip on the Media page.", "ok", 6000);
      });
    } catch (err) {
      // Invalid/mismatched payload — never write garbage (arch §7.1 step 8).
      dlog("error", "transcribe.save.err", { clip_id: clipId, message: errMsg(err) });
      finish(() => {
        clearJobMarker();
        showJobError(meta, progress, {
          code: "invalid_transcript",
          message: "The transcript came back malformed — try transcribing again.",
        }, false);
      });
    }
  }

  /* ---- cancel a running relay job (best-effort) -------------------------- */
  async function requestCancelJob({ jobId, progress, meta, finish }) {
    progress.note("Cancelling…");
    try { await cancelTranscribe(jobId); } catch { /* best-effort, 404 = already gone */ }
    clearJobMarker();
    const done = () => {
      const entry = clips.get(meta.clip_id) || { meta };
      entry.job = null;
      clips.set(meta.clip_id, entry);
      paintClip(meta.clip_id);
      toast("Transcription cancelled. If the audio already reached ElevenLabs it may still be billed.", "info", 6000);
    };
    if (typeof finish === "function") finish(done); else { activeJob = null; done(); }
  }

  /* ---- error rendering (honest + free retry) ----------------------------- */
  function showJobError(meta, progress, errObj, redo) {
    const clipId = meta.clip_id;
    const entry = clips.get(clipId) || { meta };
    progress.error(humanizeJobError(errObj), () => {
      entry.job = null;
      runJob(meta, redo);            // free re-run (re-extraction costs nothing)
    }, () => {
      entry.job = null;
      paintClip(clipId);
    });
    dlog("warn", "transcribe.job.err", { clip_id: clipId, code: errObj && errObj.code });
  }

  /* ---- lock-proof resume on mount (arch §7.1 step 7) --------------------- */
  async function resumePendingJob() {
    if (destroyed || activeJob) return;
    const marker = readJobMarker();
    if (!marker || marker.project_id !== projectId) return;
    // Make sure the clip still exists and has no transcript yet.
    const entry = clips.get(marker.clip_id);
    let meta = entry && entry.meta;
    if (!meta) {
      // The strip may not have rendered this clip yet; tolerate a thin meta.
      meta = { clip_id: marker.clip_id, original_name: marker.clip_name || marker.clip_id, audio: true };
    }
    // Re-attach the poll. A 404 (job aged out / relay restarted) shows the
    // honest restart copy + retry; a still-running job resumes to done.
    const e2 = clips.get(marker.clip_id) || { meta };
    const progress = makeClipProgress(meta);
    e2.meta = meta;
    e2.job = progress;
    clips.set(marker.clip_id, e2);
    paintClip(marker.clip_id);
    dlog("info", "transcribe.resume", { clip_id: marker.clip_id, job_id: marker.job_id });
    pollUntilDone({ meta, jobId: marker.job_id, progress, redo: false });
  }

  /* ---- transcript presence load ----------------------------------------- */
  async function loadTranscript(clipId) {
    try {
      const doc = await readTranscript(projectId, clipId);
      const entry = clips.get(clipId);
      if (entry) entry.transcript = doc;
      return doc;
    } catch {
      return null;
    }
  }

  function notifyChange() {
    try { if (typeof ctx.notifyTranscriptChange === "function") ctx.notifyTranscriptChange(); }
    catch { /* fan-out is decorative — never break the flow */ }
  }

  /* ---- public: feed the gate, refresh, render --------------------------- */
  function setStatus(nextGate) {
    gate = nextGate;
    for (const clipId of clips.keys()) paintClip(clipId);
  }

  async function refresh() {
    // Re-read transcript presence for every known clip, then repaint.
    await Promise.all([...clips.keys()].map((id) => loadTranscript(id)));
    for (const id of clips.keys()) paintClip(id);
  }

  return {
    setStatus,
    renderClip(meta) {
      const node = renderClip(meta);
      // Kick a transcript-presence read for this clip (async paint).
      loadTranscript(meta.clip_id).then(() => { if (!destroyed) paintClip(meta.clip_id); });
      return node;
    },
    refresh,
    resumePendingJob,
    /** Drop a clip's transcript+state (ingest re-pick replace owns the OPFS
        delete via store/transcripts; this keeps the in-memory view honest). */
    forgetClip(clipId) {
      clips.delete(clipId);
    },
    destroy() {
      destroyed = true;
      // Stop a running poll loop cleanly (extract/upload jobs are abandoned by
      // their own cancellation guards once `destroyed` flips).
      if (activeJob && activeJob.progress && typeof activeJob.progress.stopPoll === "function") {
        activeJob.progress.stopPoll();
      }
      wake.destroy();
      clips.clear();
    },
  };
}

/* =============================================================================
   Per-clip inline progress UI + its little controller.
   -----------------------------------------------------------------------------
   One indeterminate bar + a stage label + (extract) byte count + (poll) elapsed
   time + a Cancel affordance. Honest indeterminate states throughout (no fake
   percentage — the upload has no progress events, EL processing has no
   percentage). Errors render in place with Retry / Dismiss.
============================================================================= */
function makeClipProgress(meta) {
  const abort = new AbortController();
  let cancelled = false;
  let onCancelCb = null;
  let onStopCb = null;

  const label = el("span", { class: "transcribe-prog__label", text: "Starting…" });
  const sub = el("span", { class: "mono transcribe-prog__sub", text: "" });
  const bar = el("div", { class: "transcribe-prog__bar" }, [
    el("div", { class: "transcribe-prog__fill transcribe-prog__fill--indeterminate" }),
  ]);
  const cancelBtn = el("button", {
    class: "btn btn--sm btn--ghost transcribe-prog__cancel", type: "button",
    "aria-label": "Cancel transcription for " + (meta.original_name || meta.clip_id),
  }, [el("span", { text: "Cancel" })]);
  cancelBtn.addEventListener("click", () => {
    cancelled = true;
    cancelBtn.disabled = true;
    try { abort.abort(); } catch { /* already */ }
    if (onCancelCb) onCancelCb();
  });

  const node = el("div", {
    class: "transcribe-prog", role: "status", "aria-live": "polite",
  }, [
    el("div", { class: "transcribe-prog__row" }, [label, sub]),
    bar,
    el("div", { class: "transcribe-prog__actions" }, [cancelBtn]),
  ]);

  const api = {
    node,
    get signal() { return abort.signal; },
    get cancelled() { return cancelled; },
    requestCancel() {
      cancelled = true;
      try { abort.abort(); } catch { /* already */ }
    },
    stage(kind, text) {
      node.dataset.stage = kind;
      label.textContent = text;
      sub.textContent = "";
    },
    bytes(mediaBytes) {
      sub.textContent = fmtBytes(mediaBytes);
    },
    elapsed(seconds) {
      if (Number.isFinite(seconds) && seconds > 0) sub.textContent = mmss(seconds) + " elapsed";
    },
    note(text) {
      sub.textContent = text;
    },
    attachPoll() {
      // The poll phase no longer holds the op queue; the cancel button stays
      // live to stop the relay job.
      cancelBtn.disabled = false;
    },
    onCancel(fn) { onCancelCb = fn; },
    onStop(fn) { onStopCb = fn; },
    stopPoll() { if (onStopCb) onStopCb(); },
    error(message, onRetry, onDismiss) {
      node.dataset.stage = "error";
      const retry = el("button", { class: "btn btn--sm btn--primary", type: "button" }, ["Try again"]);
      retry.addEventListener("click", () => onRetry && onRetry());
      const dismiss = el("button", { class: "btn btn--sm btn--ghost", type: "button" }, ["Dismiss"]);
      dismiss.addEventListener("click", () => onDismiss && onDismiss());
      node.replaceChildren(
        el("div", { class: "transcribe-prog__err" }, [
          icon("i-alert"),
          el("span", { class: "transcribe-prog__err-text", text: message }),
        ]),
        el("div", { class: "transcribe-prog__actions" }, [retry, dismiss]),
      );
      node.setAttribute("role", "alert");
    },
  };
  return api;
}

/* =============================================================================
   Error humanizers — honest, phone-safe copy (no jargon, no key, arch §3.2).
============================================================================= */
function humanizeUpload(err) {
  if (!err) return "Something went wrong before sending the audio — try again.";
  const code = err.name === "ApiError" ? err.code : null;
  const status = err.name === "ApiError" ? err.status : null;
  if (status === 0) return "Couldn't reach the studio brain — check your home connection and try again.";
  switch (code) {
    case "transcribe_disabled":
      return "Transcription isn't set up on the studio brain.";
    case "transcribe_busy":
      return "A transcription is already running. Wait for it to finish, then try again.";
    case "audio_too_large":
      return "This clip's audio is too large to transcribe.";
    case "daily_cap_reached":
      return "The daily transcription limit was reached — it resets at midnight.";
    case "client_disconnected":
      return "The upload was interrupted — nothing was charged. Try again.";
    case "invalid_request":
      return err.message || "The studio brain rejected the request — try again.";
    default:
      return err.message || "Couldn't start the transcription — try again.";
  }
}

function humanizeJobError(errObj) {
  const code = errObj && errObj.code;
  switch (code) {
    case "provider_auth":
      return "The transcription key was rejected — check the relay's configuration.";
    case "provider_quota":
      return "The transcription service is over its quota — try again later.";
    case "provider_unreachable":
      return "The transcription service couldn't be reached — try again.";
    case "transcribe_timeout":
      return "Transcription took too long and timed out — try again.";
    case "cancelled":
      return "Transcription was cancelled.";
    case "job_not_found":
      return "The studio brain restarted — start the transcription again.";
    default:
      return (errObj && errObj.message) || "Transcription failed — try again.";
  }
}

/* ---- small helpers --------------------------------------------------------- */
function makeCancelled() {
  const e = new Error("cancelled");
  e.transcribeCancelled = true;
  return e;
}
function isCancelled(err) {
  return !!(err && (err.transcribeCancelled || err.name === "AbortError"));
}
async function safeAbandon(target) {
  if (!target) return;
  try { await target.abandon(); } catch { /* never throws by contract */ }
}
function errMsg(err) {
  return String((err && err.message) || err || "").slice(0, 200);
}
