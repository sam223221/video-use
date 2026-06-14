/* =============================================================================
   ingest.js — SMART INGEST (arch §7.1, banked M0 requirement #2).
   -----------------------------------------------------------------------------
   The M0 picker discovery, productionized: the iOS Photo Library picker can
   silently transcode (1080p60 + audio → 720p30 SILENT, named
   temp_video_for_share.mp4) — and picked File handles are VOLATILE (a 920 MB
   read died with NotReadableError when iOS invalidated the handle). So:

     1. <input type="file" accept="video/*" multiple> — the library picker
        first (opportunistic: sometimes it hands over the original). v9: the
        picker now allows MULTIPLE videos in one tap (USER field request).
     2. The copy starts the INSTANT `change` fires: quota preflight
        (size + 5% headroom) → file.stream() piped through a byte-counting,
        view-normalizing TransformStream into clips/clip_<hex8>.<ext> via the
        store's tempWriter (bytes land in a .tmp; an interrupted copy is
        swept at next boot — never a half-clip under a real name). Wake lock
        held + a visible "keep this app open" notice (v1 upload UX lessons).
     3. The committed copy is probed (engine/probe.analyzeFile + gopEstimate).
     4. Degradation detection: (a) no audio track, (b) filename matches the
        iOS transcode signature temp_video_for_share*, (c) ≤720p-class H.264
        recorded as an ADVISORY reason (never triggers the card alone).
     5. Degraded → guidance card: Pick from Files (single-pick: discards this
        copy, reopens the picker — the replacement runs the full flow; since
        the journal op is only written on ACCEPT, there is never a stale op to
        replace) / Use it anyway (kept, degraded:true rides into clipmeta →
        get_inventory, so the agent knows).
     6. Accept: .tmp renamed to its final clip name → clipmeta written →
        edl.appendAddClip → crash marker cleared → onClipAdded fires.

   MULTI-SELECT (v9). When the picker returns N>1 files, they run through the
   SAME per-file flow STRICTLY ONE AT A TIME — the device single-flight +
   memory discipline (only one streamed copy / one probe / one extraction in
   flight at any instant) is load-bearing, so the batch is a sequential queue:
   file k+1 never starts until file k is fully resolved (copy → probe →
   degradation resolution → add OR skip). N=1 is just the batch-of-one case and
   behaves EXACTLY as the single-pick flow always has.

     • Progress shows the batch position: "Adding 2 of 5 — clip.mov" with the
       byte bar underneath (single picks omit the position prefix, identical to
       before).
     • The degraded guidance card still appears PER FILE that needs it, and
       resolving it for one file does NOT abort the rest of the queue:
         – N=1: the card's primary action is "Pick from Files" (reopen the
           picker for the original) — unchanged from before.
         – N>1: the card's primary action is "Skip this one" — re-opening the
           picker mid-batch would interleave a fresh pick with the remaining
           queue and break single-flight, so the in-batch choice is keep-as-is
           (Use it anyway) or drop-this-one (Skip), and the queue marches on.
           The user can re-add the original from a fresh pick afterwards.
         – "Use it anyway" is identical in both modes (kept, degraded:true).
       Either resolution SETTLES that file's run and the driver advances.
     • The wake lock is held ACROSS the whole batch (acquired once at batch
       start, released once when the queue drains) — not toggled per file.
     • The crash marker is still per file (set at that file's copy start,
       cleared after its journal append) — a kill mid-batch sweeps the one
       in-flight .tmp and leaves every already-added clip intact.
     • onClipAdded fires once per SUCCESSFULLY-added file.

   Crash windows (arch §13): the marker is set at copy start and cleared
   after the journal append; a kill anywhere between shows the "something was
   interrupted" boot notice, the .tmp is swept, and NO journal op exists —
   state stays consistent. A failure between rename and journal append rolls
   the clip file + clipmeta back (journal-last = rollback-safe).

   STEP 5 API (editor.js):
     const ingest = mountIngest(containerEl, {
       project,                       // {id, name} — the open project
       caps,                          // capability.js matrix (wake lock gate)
       onClipAdded({clip_id, clipmeta, timeline_duration_s, segments}),
     });
     ingest.openPicker(); ingest.isBusy(); ingest.destroy();

   XSS posture: every dynamic string (file names, byte counts, error text)
   lands via util.el()'s textContent path — no innerHTML anywhere.
   Single-flight: one ingest BATCH at a time per mount (the Add button is the
   only entry and hides while busy), and WITHIN a batch one file at a time;
   agent-triggered engine work is additionally serialized by Step 5's bridge
   executor queue.
============================================================================= */

import { el, icon, fmtBytes, toast } from "./util.js";
import {
  newClipId, projectSubDir, tempWriter,
  quotaPreflight, setOpMarker, clearOpMarker,
} from "./store/opfs.js";
import { writeClipMeta, touchProject } from "./store/meta.js";
import { appendAddClip } from "./store/edl.js";
import { openProbe } from "./engine/probe.js";
import { normalizeBufferSource } from "./engine/writers.js";
import { deleteTranscript } from "./store/transcripts.js";

const PROGRESS_UI_MS = 120;          // DOM progress updates throttled to ~8/s
const NAME_MAX = 120;                // original_name cap in clipmeta
const EXT_WHITELIST = [".mp4", ".mov", ".m4v"];
const TRANSCODE_NAME_RE = /^temp_video_for_share/i;   // the M0-confirmed iOS signature
const ADVISORY_MAX_SHORT_SIDE = 720; // ≤720p-class …
const ADVISORY_CODEC = "avc";        // … H.264 — advisory reason (c)

function dlog(level, msg, data) {
  try {
    const d = typeof window !== "undefined" && window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* diagnostics never block ingest */ }
}

function nowIso() { return new Date().toISOString(); }

function safeExt(name) {
  const dot = String(name || "").lastIndexOf(".");
  const ext = dot > 0 ? String(name).slice(dot).toLowerCase() : "";
  return EXT_WHITELIST.includes(ext) ? ext : ".mp4";
}

function errText(e) {
  if (!e) return "unknown error";
  const name = e.name || (e.constructor && e.constructor.name) || "Error";
  return name + ": " + (e.message || String(e));
}

/* Wake lock, capability-gated, re-acquired when the page becomes visible
   again mid-operation (spike pattern). Never throws. Held across a whole
   batch (v9): acquire() is idempotent so re-entry is harmless. */
function makeWakeLock(enabled) {
  let sentinel = null;
  let want = false;
  let onChange = null;
  async function acquire() {
    want = true;
    notify();
    if (!enabled || !("wakeLock" in navigator)) return;
    if (sentinel) return;                 // already held — idempotent across a batch
    try {
      sentinel = await navigator.wakeLock.request("screen");
      sentinel.addEventListener("release", () => { sentinel = null; notify(); });
    } catch { sentinel = null; }
    notify();
  }
  function release() {
    want = false;
    if (sentinel) {
      try { sentinel.release(); } catch { /* already released */ }
      sentinel = null;
    }
    notify();
  }
  function notify() { try { if (onChange) onChange(!!sentinel, want); } catch { /* UI only */ } }
  const onVisibility = () => {
    if (document.visibilityState === "visible" && want && !sentinel) acquire();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return {
    acquire,
    release,
    held: () => !!sentinel,
    set onStateChange(fn) { onChange = fn; },
    destroy() {
      release();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/* Best-effort rollback of a clip that was committed but never journaled
   (journal-last makes this safe). Never throws. */
async function rollbackClip(projectId, clipFileName, clipId) {
  try {
    const clips = await projectSubDir(projectId, "clips");
    await clips.removeEntry(clipFileName);
  } catch { /* never committed — fine */ }
  try {
    const metaDir = await projectSubDir(projectId, "clipmeta");
    await metaDir.removeEntry(clipId + ".json");
  } catch { /* never written — fine */ }
}

/**
 * Mount the smart-ingest UI into `container`.
 *
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {Object} opts.project       {id, name} — the open project
 * @param {Object} [opts.caps]        capability matrix (window.__studio2Caps
 *                                    fallback) — gates the wake lock
 * @param {Function} [opts.onClipAdded] ({clip_id, clipmeta,
 *                                    timeline_duration_s, segments})
 * @returns {{openPicker, isBusy, destroy}}
 */
export function mountIngest(container, { project, caps, onClipAdded } = {}) {
  if (!container || !project || typeof project.id !== "string") {
    throw new Error("mountIngest needs a container and an open project");
  }
  const capMatrix = caps || (typeof window !== "undefined" && window.__studio2Caps) || {};
  const wake = makeWakeLock(!!capMatrix.wakeLock);

  let busy = false;            // a batch (one or more files) is in flight
  let destroyed = false;

  /* ----- static DOM -------------------------------------------------------- */

  const input = el("input", { type: "file", accept: "video/*", multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
  const addBtn = el("button", { class: "btn btn--primary btn--block", type: "button" }, [
    icon("i-plus"), "Add video",
  ]);

  // progress zone — the batch-position prefix ("Adding 2 of 5 — ") + the file
  // name live in the label; the byte bar tracks the file currently copying.
  const progressLabel = el("span", { text: "" });
  const progressNumbers = el("span", { class: "mono", text: "" });
  const progressFill = el("div", { class: "quota-bar__fill" });
  const progressBar = el("div", {
    class: "quota-bar",
    role: "progressbar",
    "aria-label": "Video copy progress",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": "0",
  }, [progressFill]);
  const keepOnNote = el("p", { class: "persist-note" }, [
    icon("i-alert"), el("span", { text: "" }),
  ]);
  const progressWrap = el("div", { class: "ingest-progress", hidden: true, "aria-live": "polite" }, [
    el("div", { class: "ingest-progress__row" }, [progressLabel, progressNumbers]),
    progressBar,
    keepOnNote,
  ]);

  // card zone (degradation guidance / errors) — rebuilt per use
  const cardWrap = el("div", { hidden: true });

  const root = el("section", { class: "ingest", "aria-label": "Add a video" }, [
    input, addBtn, progressWrap, cardWrap,
  ]);
  container.append(root);

  wake.onStateChange = (held, want) => {
    const span = keepOnNote.lastChild;
    if (!span) return;
    span.textContent = held
      ? "Keep this app open until the videos finish copying — the screen will stay awake."
      : "Keep this app open and the screen on until the videos finish copying.";
    keepOnNote.hidden = !want;
  };
  keepOnNote.hidden = true;

  /* ----- batch position label -------------------------------------------------
     A single source for the "Adding 2 of 5 — name" / "Copying name…" prefix so
     every progress phase (copy / probe / finishing / guidance) shows the same
     batch context. N=1 omits the "k of N" prefix — identical to before. */
  let batchTotal = 1;
  let batchIndex = 0;          // 1-based position of the file currently running
  let batchName = "";          // original name of the file currently running

  function positionPrefix() {
    return batchTotal > 1 ? "Adding " + batchIndex + " of " + batchTotal + " — " : "";
  }

  /* ----- UI states ---------------------------------------------------------- */

  function showIdle() {
    addBtn.hidden = false;
    progressWrap.hidden = true;
    cardWrap.hidden = true;
    cardWrap.replaceChildren();
  }

  function showProgress(phase) {
    addBtn.hidden = true;
    cardWrap.hidden = true;
    cardWrap.replaceChildren();
    // phase is the verb ("Copying into Studio…", "Checking the video…",
    // "Finishing…"); the label carries the batch position + file name + phase.
    const name = batchName ? batchName + " — " : "";
    progressLabel.textContent = positionPrefix() + name + phase;
    progressWrap.hidden = false;
  }

  let lastUiUpdate = 0;
  function updateProgress(copied, total) {
    const now = performance.now();
    if (now - lastUiUpdate < PROGRESS_UI_MS && copied < total) return;
    lastUiUpdate = now;
    const pct = total > 0 ? Math.min(100, Math.round((copied / total) * 100)) : 0;
    progressFill.style.width = pct + "%";
    progressBar.setAttribute("aria-valuenow", String(pct));
    progressNumbers.textContent = fmtBytes(copied) + " / " + fmtBytes(total);
  }

  function showCard({ title, body, error = false, actions }) {
    addBtn.hidden = true;
    progressWrap.hidden = true;
    const card = el("div", {
      class: "ingest-card" + (error ? " ingest-card--error" : ""),
      role: "alert",
    }, [
      el("div", { class: "ingest-card__title" }, [icon("i-alert"), el("span", { text: title })]),
      el("p", { class: "ingest-card__body", text: body }),
      el("div", { class: "ingest-card__actions" }, actions),
    ]);
    cardWrap.replaceChildren(card);
    cardWrap.hidden = false;
    const firstBtn = card.querySelector("button");
    if (firstBtn) firstBtn.focus();
  }

  /* Error card. In a single pick "Try again" resets to idle; in a batch it
     just dismisses the card so the NEXT queued file can take over the view
     (the run that raised it has already settled — see runIngest's catch). */
  function showErrorCard(title, body, onDismiss) {
    showCard({
      title,
      body,
      error: true,
      actions: [
        el("button", {
          class: "btn btn--sm", type: "button",
          onclick: () => { if (typeof onDismiss === "function") onDismiss(); else showIdle(); },
        }, [batchTotal > 1 ? "Continue" : "Try again"]),
      ],
    });
  }

  /* ----- the ingest run ------------------------------------------------------ */

  function degradationReasons(file, meta) {
    const reasons = [];
    if (!meta.audio) reasons.push("no_audio");
    if (TRANSCODE_NAME_RE.test(String(file.name || ""))) reasons.push("picker_transcode_signature");
    const v = meta.video;
    if (v && v.codec === ADVISORY_CODEC
      && Math.min(v.displayWidth || 0, v.displayHeight || 0) > 0
      && Math.min(v.displayWidth, v.displayHeight) <= ADVISORY_MAX_SHORT_SIDE) {
      reasons.push("advisory_720p_h264");                 // advisory only — never triggers the card
    }
    const flag = reasons.some((r) => r !== "advisory_720p_h264");
    return { flag, reasons };
  }

  function degradedBody(reasons) {
    const parts = [];
    if (reasons.includes("no_audio")) parts.push("it has no sound");
    if (reasons.includes("picker_transcode_signature")) parts.push("its file name shows the iOS conversion stamp");
    const what = parts.length > 0 ? parts.join(" and ") : "it looks reduced";
    return "This copy lost quality in transfer — " + what
      + ". To bring in the original: open Photos, share the video with “Save to Files”, "
      + "then tap “Pick from Files” here and choose it from Files.";
  }

  async function acceptClip(ctx) {
    showProgress("Finishing…");
    progressNumbers.textContent = "";
    await ctx.t.commit(); // .tmp → clips/clip_<hex8>.<ext>
    try {
      await writeClipMeta(project.id, ctx.clipmeta);
      const res = await appendAddClip(project.id, { clip_id: ctx.clipId });
      clearOpMarker();
      try { await touchProject(project.id); } catch { /* best-effort */ }
      dlog("info", "ingest.done", {
        project_id: project.id, clip_id: ctx.clipId,
        size: ctx.clipmeta.size_bytes, degraded: ctx.clipmeta.degraded.flag,
        copy_ms: ctx.copyMs,
        batch_index: batchIndex, batch_total: batchTotal,
      });
      toast("Video added" + (ctx.clipmeta.degraded.flag ? " (reduced quality)" : "") + ".", "ok");
      if (typeof onClipAdded === "function") {
        try {
          onClipAdded({
            clip_id: ctx.clipId,
            clipmeta: ctx.clipmeta,
            timeline_duration_s: res.timeline_duration_s,
            segments: res.segments,
          });
        } catch (err) {
          dlog("error", "ingest.onClipAdded.err", { message: errText(err).slice(0, 200) });
        }
      }
    } catch (err) {
      // Committed but not journaled — roll the file + meta back (journal-last).
      await rollbackClip(project.id, ctx.clipFileName, ctx.clipId);
      throw err;
    }
  }

  /**
   * Run ONE file end to end. Resolves only when the file is fully settled —
   * including the user resolving any degraded-guidance card — so the batch
   * driver can safely await it before starting the next file (single-flight).
   *
   * The returned promise NEVER rejects: a failure shows the honest error card
   * and resolves, so one bad file can never abort the rest of the queue.
   */
  function runIngest(file) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };

      (async () => {
        let marker = false;
        let suspendedForCard = false; // the degraded card keeps the run "open"
        let t = null;
        const clipId = newClipId();
        const ext = safeExt(file.name);
        const clipFileName = clipId + ext;
        try {
          // 1. Quota preflight (size + 5% headroom — arch §7.1 step 2).
          const pre = await quotaPreflight(file.size);
          if (!pre.ok) {
            dlog("warn", "ingest.quota", { need: pre.needed, avail: pre.available });
            showErrorCard(
              "Not enough space on this device",
              "This video needs about " + fmtBytes(pre.needed) + " free, but only "
              + fmtBytes(pre.available || 0) + " is available. Free up space (old projects or exports), then try again.",
              settle,
            );
            suspendedForCard = true; // the card stays until the user continues
            return;
          }

          // 2. Copy IMMEDIATELY — picked handles are volatile (M0).
          setOpMarker("ingest", project.id, { size_bytes: file.size });
          marker = true;
          wake.acquire();
          showProgress("Copying into Studio…");
          updateProgress(0, file.size);
          const clipsDir = await projectSubDir(project.id, "clips", { create: true });
          t = await tempWriter(clipsDir, clipFileName);
          let copied = 0;
          const counter = new TransformStream({
            transform(chunk, controller) {
              // Same defensive view-normalization as every other write path
              // (banked #1) + the progress count.
              const norm = normalizeBufferSource(chunk);
              copied += norm.bytes.byteLength;
              updateProgress(copied, file.size);
              controller.enqueue(norm.bytes);
            },
          });
          const t0 = performance.now();
          // preventClose: tempWriter owns the commit — t.close() right after, so
          // the .tmp is committed and probe-able before any rename decision.
          await file.stream().pipeThrough(counter).pipeTo(t.writable, { preventClose: true });
          await t.close();
          const copyMs = Math.round(performance.now() - t0);

          // 3. Probe the OPFS copy, never the volatile picked handle.
          showProgress("Checking the video…");
          progressNumbers.textContent = "";
          const stored = await t.handle.getFile();
          const probe = await openProbe(stored);
          let meta;
          let gop = null;
          try {
            meta = await probe.analyze();
            if (!meta.parseError && meta.video) {
              try { gop = await probe.gopEstimate(); }
              catch { gop = null; /* estimate is optional */ }
            }
          } finally {
            probe.dispose();
          }
          if (meta.parseError || !meta.video) {
            await t.abandon();
            clearOpMarker();
            marker = false;
            dlog("warn", "ingest.unplayable", { detail: String(meta.parseError || "no video track").slice(0, 200) });
            showErrorCard(
              "That file doesn't look like a playable video",
              (meta.parseError ? "It could not be read as a video (" + meta.parseError + "). " : "No video track was found. ")
              + (batchTotal > 1 ? "It was skipped." : "Pick a different file."),
              settle,
            );
            suspendedForCard = true;
            return;
          }

          // 4. Degradation detection (arch §7.1 step 4).
          const degraded = degradationReasons(file, meta);
          const ctx = {
            t, clipId, clipFileName, copyMs,
            clipmeta: {
              schema: 1,
              clip_id: clipId,
              file_name: clipFileName,            // how player/cut/export find the OPFS file
              original_name: String(file.name || "").slice(0, NAME_MAX),
              size_bytes: stored.size,
              container: meta.container,
              duration_s: meta.duration_s,
              video: meta.video,
              audio: meta.audio,
              degraded,
              ingested_at: nowIso(),
              keyframe_spacing_s_estimate: gop ? gop.keyframe_spacing_s_estimate : null,
            },
          };

          // 5. Files-route guidance when the picker transcoded (arch §7.1 step 5).
          //    The card resolution (Pick from Files / Skip / Use it anyway) SETTLES
          //    this run; in a batch the driver then advances to the next file —
          //    resolving ONE file's card never aborts the rest of the queue.
          if (degraded.flag) {
            dlog("warn", "ingest.degraded", {
              clip_id: clipId, reasons: degraded.reasons,
              batch_index: batchIndex, batch_total: batchTotal,
            });
            suspendedForCard = true; // busy/queue stays "open" until a card action resolves it
            const inBatch = batchTotal > 1;

            // Primary action:
            //  • single pick → "Pick from Files" (reopen the picker for the
            //    original) — UNCHANGED from before.
            //  • batch       → "Skip this one" (re-opening the picker mid-batch
            //    would interleave a fresh multi-pick with the remaining queue
            //    and break single-flight; the user re-adds the original later).
            const primary = inBatch
              ? el("button", {
                  class: "btn btn--sm", type: "button",
                  onclick: () => {
                    // Discard this degraded copy; the queue continues to the
                    // next file. No picker re-entry — single-flight intact.
                    t.abandon().catch(() => { /* never throws by contract */ });
                    clearOpMarker();
                    marker = false;
                    deleteTranscript(project.id, clipId).catch(() => { /* never throws */ });
                    dlog("info", "ingest.skip", { discarded: clipId, batch_index: batchIndex, batch_total: batchTotal });
                    settle();
                  },
                }, ["Skip this one"])
              : el("button", {
                  class: "btn btn--primary btn--sm", type: "button",
                  onclick: () => {
                    // The picker MUST open inside this click (user activation);
                    // the discarded copy is cleaned up in the background. The
                    // run settles so a fresh `change` starts a new batch;
                    // cancelling the picker simply leaves the view idle.
                    input.value = "";
                    input.click();
                    clearOpMarker();
                    marker = false;
                    t.abandon().catch(() => { /* never throws by contract */ });
                    // M2 (arch §1.2, §13): a transcript of the OLD audio must never
                    // survive the swap. The discarded copy's clip_id is fresh here,
                    // so this is defensive — but if a transcript was ever associated
                    // with it, dropping it now keeps transcript ↔ clip honest.
                    deleteTranscript(project.id, clipId).catch(() => { /* never throws */ });
                    dlog("info", "ingest.repick", { discarded: clipId });
                    settle();
                  },
                }, ["Pick from Files"]);

            showCard({
              title: "This copy lost quality in transfer",
              body: degradedBody(degraded.reasons),
              actions: [
                primary,
                el("button", {
                  class: inBatch ? "btn btn--primary btn--sm" : "btn btn--sm",
                  type: "button",
                  onclick: async () => {
                    try {
                      await acceptClip(ctx); // degraded.flag stays true → agent sees it
                    } catch (err) {
                      await ctx.t.abandon(); // no-op if the rename already happened
                      clearOpMarker();
                      dlog("error", "ingest.accept.err", { message: errText(err).slice(0, 200) });
                      showErrorCard(
                        "Couldn't finish adding the video",
                        errText(err) + ". Nothing was half-added — try again.",
                        settle,
                      );
                      return; // the error card's button settles the run
                    }
                    settle();
                  },
                }, ["Use it anyway"]),
              ],
            });
            return;
          }

          // 6. Clean clip — straight on (arch §7.1 step 6).
          await acceptClip(ctx);
          marker = false;
          settle();
        } catch (err) {
          if (t) await t.abandon();
          if (marker) clearOpMarker();
          dlog("error", "ingest.err", {
            message: errText(err).slice(0, 200),
            batch_index: batchIndex, batch_total: batchTotal,
          });
          showErrorCard(
            "Adding the video failed",
            errText(err) + (batchTotal > 1
              ? ". Nothing was half-added — it was skipped; your other videos are unaffected."
              : ". Nothing was half-added — your project is unchanged. Try again."),
            settle,
          );
          suspendedForCard = true; // the error card's button settles the run
        } finally {
          // The wake lock is held across the WHOLE batch (released by the driver
          // when the queue drains), so per-file runs do NOT release it.
          // A run with no card open settles synchronously above; a run showing
          // a card settles when its button is tapped.
          if (!suspendedForCard) settle();
        }
      })();
    });
  }

  /**
   * Drive a batch of picked files STRICTLY sequentially (v9). One file fully
   * finishes (copy → probe → degradation resolution → add OR skip) before the
   * next starts — never two copies/probes/extractions at once. N=1 collapses
   * to a single runIngest, identical to the historical single-pick flow.
   */
  async function runBatch(files) {
    busy = true;
    batchTotal = files.length;
    // The wake lock is held across the whole batch — acquired once here so the
    // screen never sleeps between files, released once when the queue drains.
    wake.acquire();
    dlog("info", "ingest.batch.start", { project_id: project.id, count: files.length });
    try {
      for (let i = 0; i < files.length; i++) {
        if (destroyed) break;
        batchIndex = i + 1;
        batchName = String(files[i].name || "").slice(0, NAME_MAX);
        // AWAITED: file i is fully settled (added, skipped, or its error/guidance
        // card resolved) before file i+1 begins. This is the single-flight
        // guarantee — there is exactly one streamed copy / probe in flight.
        await runIngest(files[i]);
      }
    } finally {
      wake.release();
      busy = false;
      batchTotal = 1;
      batchIndex = 0;
      batchName = "";
      // Whatever the last file left on screen (a success toast already fired,
      // or an error/guidance card was just dismissed by its button) — the batch
      // is done, so return the entry to idle. A card dismissed via settle()
      // already advanced past; showIdle() clears any residue.
      if (!destroyed) showIdle();
      dlog("info", "ingest.batch.done", { project_id: project.id, count: files.length });
    }
  }

  /* ----- wiring ---------------------------------------------------------------- */

  function openPicker() {
    if (destroyed) return;
    if (busy) {
      toast("Videos are still being added — wait for them to finish.", "info");
      return;
    }
    input.value = ""; // re-picking the SAME clip must still fire `change`
    input.click();
  }

  addBtn.addEventListener("click", openPicker);
  input.addEventListener("change", () => {
    const picked = input.files;
    if (!picked || picked.length === 0 || destroyed) return;
    if (busy) return; // a stray change while a batch is live — ignore
    // Snapshot the FileList now: picked File handles are volatile, and the
    // sequential driver may read them seconds apart. Array.from copies the
    // references (the bytes are read lazily per file via file.stream()).
    runBatch(Array.from(picked));
  });

  showIdle();

  return {
    openPicker,
    isBusy: () => busy,
    destroy() {
      destroyed = true;
      wake.destroy();
      // M2 (deferred P3-B): reset the view to idle BEFORE removing the root, so
      // a stale "Adding 2 of 5…" / progress region (e.g. a big-batch run still
      // visible when a guarded back-tap finally lets the editor tear down)
      // cannot linger as orphaned DOM into a re-mount. showIdle() hides the
      // progress wrap and clears any card; root.remove() then drops it all.
      try { showIdle(); } catch { /* DOM already gone — fine */ }
      root.remove();
    },
  };
}
