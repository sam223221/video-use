/* =============================================================================
   export.js — the export flow, arch §7.3 EXACTLY.
   -----------------------------------------------------------------------------
   User taps Export (user gesture) →
     1. DISARM any previously armed share/download (banked M0 #6 — clear
        per-run state on op start).
     2. Quota preflight: kept-fraction × source bytes + 10% headroom.
     3. Fold EDL → keep-segments; tempWriter(exports/, export-<ts>.<ext>) —
        bytes land in a .tmp; the final name is NEVER a write target
        (banked #3; store/opfs.js owns the mechanics).
     4. engine cut (Step 4 cut.js) streams the remux into the .tmp with
        progress heartbeats + a screen wake lock (spike pattern).
     5. VERIFY BEFORE RENAME (banked #4/#5): close the .tmp, run Step 4
        verify.js on the committed .tmp bytes.
     6. ok      → commit() renames to the final name → arm the share
        ("Save Video" needs a FRESH user gesture, so the completion card's
        button shares the pre-built File; spike share-serialization guard +
        ~25 s never-settle watchdog) + download fallback.
        corrupt  → the .tmp is renamed export-<ts>.corrupt (never the real
        name), red verdict, share-for-inspection allowed, diag event shipped.
        error    → abandon() the .tmp, clear message.
   Exports persist in exports/ and list in the editor with re-share/delete.

   Single-flight: the whole run executes on the editor's shared op queue —
   an export can never overlap an agent engine command (banked #6).

   Crash marker: setOpMarker("export") at start / clearOpMarker() at every
   exit — an uncatchable iOS kill mid-export surfaces a notice at next boot
   and the .tmp orphan is swept (store/opfs.js).
============================================================================= */

import { el, icon, toast, fmtBytes, fmtDuration } from "./util.js";
import {
  projectSubDir, moveEntry, quotaPreflight,
  setOpMarker, clearOpMarker,
} from "./store/opfs.js";
import { listClipMetas, getRenderBlock } from "./store/meta.js";
import { resolveCanvas } from "./engine/canvas.js";
import { readTrackFile } from "./store/music.js";
import { readTranscript } from "./store/transcripts.js";

function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

/* =============================================================================
   Share serialization (spike-proven, iPhone Safari): iOS allows ONE share
   session at a time — a second navigator.share() while one is open rejects
   with InvalidStateError. Worse, after "Save Video" the share() promise can
   NEVER settle (WebKit quirk), so a naive pending flag would deadlock every
   share until reload. Belt and braces: the flag clears when the promise
   settles, when the page regains visibility/focus (returning from the sheet
   implies it closed), or after 25 s — whichever fires first. Clearing too
   early is harmless: a genuinely-open sheet makes the next share() land in
   the InvalidStateError branch, which renders a plain-English retry message.
============================================================================= */
const sharePending = { id: 0, active: false, timer: 0 };
const SHARE_PENDING_MAX_MS = 25000;

function beginSharePending() {
  sharePending.active = true;
  sharePending.id += 1;
  const id = sharePending.id;
  clearTimeout(sharePending.timer);
  sharePending.timer = setTimeout(() => endSharePending(id), SHARE_PENDING_MAX_MS);
  return id;
}

function endSharePending(id) {
  if (id !== sharePending.id) return;     // a newer share owns the flag now
  sharePending.active = false;
  clearTimeout(sharePending.timer);
  sharePending.timer = 0;
}

window.addEventListener("focus", () => endSharePending(sharePending.id));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") endSharePending(sharePending.id);
});

/* ---- wake lock (spike pattern: best-effort, reacquire on visibility) ------- */
function createWakeLock() {
  const state = { sentinel: null, want: false };
  async function acquire() {
    state.want = true;
    if (!("wakeLock" in navigator)) return;
    try {
      state.sentinel = await navigator.wakeLock.request("screen");
      state.sentinel.addEventListener("release", () => { state.sentinel = null; });
    } catch { state.sentinel = null; }
  }
  function release() {
    state.want = false;
    if (state.sentinel) {
      try { state.sentinel.release(); } catch { /* already released */ }
      state.sentinel = null;
    }
  }
  function onVisible() {
    if (document.visibilityState === "visible" && state.want && !state.sentinel) acquire();
  }
  document.addEventListener("visibilitychange", onVisible);
  return {
    acquire, release,
    destroy() { release(); document.removeEventListener("visibilitychange", onVisible); },
  };
}

function tsName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function mimeFor(name) {
  return /\.mov(\.corrupt)?$/i.test(name) ? "video/quicktime" : "video/mp4";
}

/* Phone-safe ETA copy for the render heartbeat. */
function etaCopy(s) {
  if (s == null || !Number.isFinite(s)) return "";
  if (s < 5) return "almost done";
  if (s < 60) return "about " + Math.round(s / 5) * 5 + "s left";
  const m = Math.round(s / 60);
  return "about " + m + " min left";
}

/* The render-tier output name (timestamped, always .mp4 — the compositor writes
   one common codec into an MP4 container; arch §6). */
function renderTsName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
}

/* A rough output-bitrate estimate for the render quota preflight (bits/s).
   Mirrors engine/webcodecs.bitrateFor's 0.13 bpp×fps point WITHOUT importing it
   (export.js keeps its quota math local; render.js does the real config probe).
   Clamped to the same 1.5–16 Mbps window so a degenerate canvas can't ask for
   an absurd reservation. */
function estimateRenderBitrate(canvas) {
  const w = Math.max(1, Math.round((canvas && canvas.width) || 1080));
  const h = Math.max(1, Math.round((canvas && canvas.height) || 1920));
  const fps = Math.max(1, Math.round((canvas && canvas.fps) || 30));
  const raw = w * h * 0.13 * (fps / 30) * 30;
  return Math.round(Math.min(16_000_000, Math.max(1_500_000, raw)));
}

/* Plain-English gate reasons for the gated-device card (the raw greppable
   reason codes from capability.js are for diagnostics, not the user — translate
   the blocking ones). */
function plainGateReasons(reasons) {
  const r = Array.isArray(reasons) ? reasons : [];
  const out = [];
  if (r.includes("no_video_encoder_1080p")) out.push("no video re-encoder");
  if (r.includes("no_audio_encoder_aac")) out.push("no audio re-encoder");
  if (r.includes("no_draw_context")) out.push("no graphics support");
  return out.length ? "Why: " + out.join(", ") + "." : "";
}

/**
 * Mount the export section into `container`.
 * ctx: { project, caps, engine() → adapter|null, findClipFile, queue, edlEvents }
 * Returns { refresh(), destroy() }.
 */
export function initExport(ctx, container) {
  const projectId = ctx.project.id;
  const wake = createWakeLock();

  /* ---- DOM ------------------------------------------------------------------ */
  const exportBtn = el("button", { class: "btn btn--primary export__btn", type: "button" }, [
    icon("i-share"), el("span", { text: "Export" }),
  ]);
  const progress = el("div", { class: "export__progress", hidden: true }, []);
  const resultBox = el("div", { class: "export__result", hidden: true });
  const listEl = el("div", { class: "export__list" });
  const listWrap = el("details", { class: "export__exports" }, [
    el("summary", {}, [
      icon("i-download"),
      el("span", { text: "Exports" }),
      icon("i-chevron-right", "icon export__chev"),
    ]),
    listEl,
  ]);

  const root = el("section", { class: "export", "aria-label": "Export" }, [
    el("div", { class: "export__row" }, [exportBtn]),
    progress, resultBox, listWrap,
  ]);
  container.append(root);

  /* ---- state ------------------------------------------------------------------ */
  let running = false;
  let destroyed = false;
  let armed = null;             // { file, name } — prepared for the share gesture
  let downloadUrl = null;       // blob URL behind the download fallback
  let renderNoticeAck = false;  // M3: the per-session "re-encode is slower + SDR"
                                //     confirm has been acknowledged once.

  /* ---- disarm (banked #6: clear per-run state on op start) --------------------- */
  function disarm() {
    armed = null;
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
    resultBox.hidden = true;
    resultBox.replaceChildren();
    resultBox.dataset.state = "";
  }

  /* ---- progress UI --------------------------------------------------------------- */
  let progressText = null;
  let progressFill = null;
  function showProgress(label, { determinate = false } = {}) {
    progress.hidden = false;
    progressFill = el("div", {
      class: "progressbar__fill" + (determinate ? "" : " progressbar__fill--indeterminate"),
    });
    if (determinate) progressFill.style.transform = "scaleX(0)";
    progress.replaceChildren(
      el("div", {
        class: "progressbar", role: "progressbar", "aria-label": "Export progress",
        "aria-valuemin": "0", "aria-valuemax": "100",
      }, [progressFill]),
      (progressText = el("p", { class: "export__progress-text mono", role: "status", text: label })),
    );
  }
  let lastBeat = 0;
  function heartbeat(p) {
    // Throttled heartbeat (the spike's startHeartbeat idea): packets/bytes
    // tick visibly so a minutes-long remux never looks frozen.
    const now = performance.now();
    if (now - lastBeat < 250) return;
    lastBeat = now;
    if (!progressText) return;
    const seg = p && p.segment_index != null ? "segment " + (p.segment_index + 1) : "";
    const bytes = p && p.mediaBytes != null ? fmtBytes(p.mediaBytes) + " written" : "";
    progressText.textContent = ["Cutting…", seg, bytes].filter(Boolean).join(" · ");
  }
  /* M3 render progress: determinate (frames done / total) + fps + ETA + segment
     (arch §5.2). The render onProgress payload is {segment, segmentsTotal,
     framesDone, framesTotal, fps, etaS}. */
  function renderHeartbeat(p) {
    const now = performance.now();
    if (now - lastBeat < 200) return;
    lastBeat = now;
    if (!progressText || !p) return;
    if (progressFill && p.framesTotal > 0) {
      const frac = Math.max(0, Math.min(1, p.framesDone / p.framesTotal));
      progressFill.style.transform = "scaleX(" + frac.toFixed(4) + ")";
      progress.firstChild && progress.firstChild.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
    }
    const frames = p.framesTotal
      ? p.framesDone.toLocaleString("en-US") + " / " + p.framesTotal.toLocaleString("en-US") + " frames"
      : "";
    const fps = p.fps ? "~" + Math.round(p.fps) + " fps" : "";
    const eta = p.etaS != null && p.etaS >= 0 ? etaCopy(p.etaS) : "";
    const seg = p.segment != null && p.segmentsTotal
      ? "part " + (p.segment + 1) + " of " + p.segmentsTotal : "";
    progressText.textContent = ["Rendering…", frames, fps, eta, seg].filter(Boolean).join(" · ");
  }
  function hideProgress() {
    progress.hidden = true;
    progress.replaceChildren();
    progressText = null;
    progressFill = null;
  }

  /* ---- share / download ------------------------------------------------------------ */
  async function shareFile(file, statusLine) {
    if (sharePending.active) {
      statusLine.textContent = "Close the open share sheet first, then try again.";
      return;
    }
    if (!navigator.share) {
      statusLine.textContent = "Sharing isn't available in this browser — use Download.";
      return;
    }
    if (navigator.canShare && !navigator.canShare({ files: [file] })) {
      statusLine.textContent = "This browser can't share video files — use Download.";
      return;
    }
    const pendingId = beginSharePending();
    try {
      await navigator.share({ files: [file] });
      statusLine.textContent = "Shared — check Photos.";
      dlog("info", "export.share.ok", { name: file.name });
    } catch (e) {
      if (e && e.name === "InvalidStateError") {
        statusLine.textContent = "iOS still has the previous share open. Wait a moment and tap again.";
      } else if (e && e.name === "AbortError") {
        statusLine.textContent = "Share cancelled — tap the button to try again.";
      } else {
        statusLine.textContent = "Couldn't share — use Download instead.";
        dlog("warn", "export.share.err", { message: String(e && e.message).slice(0, 200) });
      }
    } finally {
      endSharePending(pendingId);
    }
  }

  function buildShareRow(file, { corrupt } = {}) {
    const statusLine = el("p", { class: "export__share-status", role: "status" });
    const buttons = [];
    if (ctx.caps && ctx.caps.shareFiles) {
      buttons.push(el("button", {
        class: "btn btn--primary btn--sm", type: "button",
        onclick: () => shareFile(file, statusLine),
      }, [icon("i-share"), el("span", { text: corrupt ? "Share for inspection" : "Save Video" })]));
    }
    // Download fallback — always offered (desktop, and share-less browsers).
    buttons.push(el("button", {
      class: "btn btn--sm", type: "button",
      onclick: () => {
        // Lazy blob URL: created on tap, replaced on next tap, revoked on
        // disarm/destroy (never more than one alive).
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(file);
        const a = el("a", { href: downloadUrl, download: file.name });
        document.body.append(a);
        a.click();
        a.remove();
        statusLine.textContent = "Download started.";
      },
    }, [icon("i-download"), el("span", { text: "Download" })]));
    return el("div", { class: "export__share" }, [
      el("div", { class: "export__share-row" }, buttons),
      statusLine,
    ]);
  }

  function showVerdictOk(file, stats) {
    resultBox.hidden = false;
    resultBox.dataset.state = "ok";
    const sub = file.name + " · " + fmtBytes(file.size) +
      (stats && stats.duration_s ? " · " + fmtDuration(stats.duration_s) : "");
    resultBox.replaceChildren(
      el("div", { class: "export__verdict" }, [
        icon("i-check"),
        el("div", {}, [
          el("b", { text: "Export verified — safe to save." }),
          el("p", { class: "export__verdict-sub", text: sub }),
          // M3: a rendered output is standard-range, not HDR — say so once at the
          // result so the user understands the trade they already agreed to.
          (stats && stats.rendered)
            ? el("p", { class: "export__verdict-note", text: "Re-encoded · standard-range (not HDR)." })
            : null,
        ]),
      ]),
      buildShareRow(file),
    );
  }

  function showVerdictCorrupt(file, verdict) {
    resultBox.hidden = false;
    resultBox.dataset.state = "bad";
    const problems = (verdict && Array.isArray(verdict.problems) ? verdict.problems : [])
      .slice(0, 4).map((p) => el("li", { text: String(p).slice(0, 200) }));
    resultBox.replaceChildren(
      el("div", { class: "export__verdict" }, [
        icon("i-alert"),
        el("div", {}, [
          el("b", { text: "This export failed its safety check." }),
          el("p", {
            class: "export__verdict-sub",
            text: "It was kept as " + file.name + " so it can be inspected — don't save it to Photos. Try exporting again.",
          }),
          problems.length ? el("ul", { class: "export__problems" }, problems) : null,
        ]),
      ]),
      buildShareRow(file, { corrupt: true }),
    );
  }

  function showError(message) {
    resultBox.hidden = false;
    resultBox.dataset.state = "bad";
    resultBox.replaceChildren(el("div", { class: "export__verdict" }, [
      icon("i-alert"),
      el("div", {}, [el("b", { text: "Export failed." }), el("p", { class: "export__verdict-sub", text: message })]),
    ]));
  }

  /* ---- render confirm + SDR notice (M3, arch §5.2) --------------------------------------
     Once-per-session, before the first render. An inline confirm card (NOT a
     blocking native confirm — phone-first, accessible, dismissible) mounted in
     the result box. Resolves true (go), false (back out). The agent's prose
     already set this expectation; the UI repeats it at the tap. */
  function confirmRenderNotice() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const goBtn = el("button", {
        class: "btn btn--primary btn--sm", type: "button",
        onclick: () => { resultBox.hidden = true; resultBox.replaceChildren(); done(true); },
      }, [el("span", { text: "Re-encode & export" })]);
      const cancelBtn = el("button", {
        class: "btn btn--sm", type: "button",
        onclick: () => { resultBox.hidden = true; resultBox.replaceChildren(); resultBox.dataset.state = ""; done(false); },
      }, [el("span", { text: "Not now" })]);
      resultBox.hidden = false;
      resultBox.dataset.state = "info";
      resultBox.replaceChildren(el("div", { class: "export__verdict" }, [
        icon("i-spark"),
        el("div", {}, [
          el("b", { text: "This export re-encodes your video." }),
          el("p", {
            class: "export__verdict-sub",
            text: "Because you've combined different shapes or added music, Studio rebuilds the video. It takes a couple of minutes, the result is standard-range (not HDR), and the screen should stay on. Single-clip exports stay instant.",
          }),
          el("div", { class: "export__confirm-row" }, [goBtn, cancelBtn]),
        ]),
      ]));
      // Focus the primary action for keyboard users.
      try { goBtn.focus(); } catch { /* not focusable yet */ }
    });
  }

  /* Move a verified render output (a committed file handle in render/) into
     exports/ under `name`. The platform move() crosses directories where it
     exists; otherwise a streamed copy + source delete (never buffers the file —
     device RAM is the constraint). Returns the File for arming the share. */
  async function moveRenderOutput(handle, exportsDir, name) {
    const src = await handle.getFile();
    if (typeof handle.move === "function") {
      try {
        await handle.move(exportsDir, name);
        const fh = await exportsDir.getFileHandle(name);
        const raw = await fh.getFile();
        return new File([raw], name, { type: mimeFor(name) });
      } catch { /* fall through to the streamed copy */ }
    }
    const dst = await exportsDir.getFileHandle(name, { create: true });
    const writable = await dst.createWritable();
    try {
      await src.stream().pipeTo(writable);          // pipeTo closes on success
    } catch (err) {
      try { await writable.abort(); } catch { /* already dead */ }
      try { await exportsDir.removeEntry(name); } catch { /* never existed */ }
      throw err;
    }
    // Best-effort removal of the render/ source (render.js also sweeps the dir).
    try { await handle.remove(); } catch { /* leave it for the boot sweep */ }
    const fh = await exportsDir.getFileHandle(name);
    const raw = await fh.getFile();
    return new File([raw], name, { type: mimeFor(name) });
  }

  /* ---- gated-device card (M3, arch §6.2) ------------------------------------------------
     A render-tier project (different shapes / a non-identity fit / music) on a
     device whose render gate is closed (caps.render.ok === false): the Format/
     fit/music SETTINGS still worked (they're project settings), but the
     re-encode EXPORT can't run here. Honest plain-English guidance — keep it
     lossless, or render on a computer — plus the gate reasons for diagnostics. */
  function showGatedCard(reasons) {
    resultBox.hidden = false;
    resultBox.dataset.state = "warn";
    const reasonText = plainGateReasons(reasons);
    resultBox.replaceChildren(el("div", { class: "export__verdict" }, [
      icon("i-alert"),
      el("div", {}, [
        el("b", { text: "This video needs a re-encode — and this device can't do that." }),
        el("p", {
          class: "export__verdict-sub",
          text: "Combining different shapes or adding music means Studio has to rebuild the video, which this device can't do. You can either keep it lossless — remove the music and use a single shape — or open this project on a computer running Studio to make it there.",
        }),
        reasonText ? el("p", { class: "export__gate-reasons mono", text: reasonText }) : null,
      ]),
    ]));
  }

  /* ---- the run (arch §7.3 + §5 tier auto-selection) ------------------------------------ */
  async function runExport() {
    if (running || destroyed) return;
    const engine = ctx.engine();
    if (!engine || typeof engine.losslessCut !== "function") {
      toast("The cutting engine isn't loaded — refresh the app and try again.", "bad");
      return;
    }

    running = true;
    exportBtn.disabled = true;
    disarm();                                           // step 1 — disarm previous arms

    try {
      // step 2 — fold (now includes music) + read the render block + resolve.
      const fold = await engine.fold();
      const segments = (fold && fold.segments) || [];
      if (segments.length === 0) {
        toast("Nothing to export — the timeline is empty.", "bad");
        return;
      }

      const metas = await listClipMetas(projectId);
      const metaById = new Map(metas.map((m) => [m.clip_id, m]));
      const renderBlock = await getRenderBlock(projectId);

      // step 3 — TIER AUTO-SELECTION (arch §5.1). Lossless stays the instant,
      // byte-for-byte M1 path whenever nothing forces a re-encode (no music, a
      // canvas every clip already fills, one codec, identity fits). The moment
      // the user picks a different shape, a non-identity fit, or adds music,
      // export becomes a render — and the UI says so up front.
      const tier = (typeof engine.tierCheck === "function")
        ? engine.tierCheck(fold, renderBlock, metas)
        : "lossless";
      dlog("info", "export.tier", { tier, music: (fold.music || []).length, segments: segments.length });

      if (tier === "render") {
        await runRender({ fold, segments, metas, metaById, renderBlock });
      } else {
        await runLossless({ fold, segments, metaById });
      }
      await refreshList();
    } catch (err) {
      const message = String((err && err.message) || "unexpected failure").slice(0, 300);
      dlog("error", "export.err", { message, code: err && err.code });
      // Engine modules tag storage problems with .code (writers.errorCode).
      showError((err && err.code === "storage_error") || /quota/i.test(message)
        ? "The device ran out of storage mid-export. Free some space and try again."
        : message);
    } finally {
      clearOpMarker();
      wake.release();
      hideProgress();
      running = false;
      exportBtn.disabled = false;
    }
  }

  /* ---- the LOSSLESS path (unchanged from M1 — the privileged instant remux) ------------- */
  async function runLossless({ fold, segments, metaById }) {
    const engine = ctx.engine();
    // Quota preflight: kept-fraction × source bytes + 10% headroom (§7.3).
    const involved = [...new Set(segments.map((s) => s.clip_id))];
    let sourceBytes = 0;
    let sourceDuration = 0;
    for (const id of involved) {
      const m = metaById.get(id);
      if (m) {
        sourceBytes += (typeof m.size_bytes === "number" ? m.size_bytes : 0);
        sourceDuration += (typeof m.duration_s === "number" ? m.duration_s : 0);
      }
    }
    const keptFraction = sourceDuration > 0
      ? Math.min(1, (fold.timeline_duration_s || 0) / sourceDuration)
      : 1;
    const estimate = Math.ceil(sourceBytes * keptFraction);
    const quota = await quotaPreflight(estimate, 0.10);
    if (!quota.ok) {
      showError("Not enough storage: this export needs about " + fmtBytes(quota.needed) +
        " but only " + fmtBytes(quota.available) + " is free. Delete old exports or projects first.");
      return;
    }

    // Resolve every source file up front (a missing clip fails BEFORE bytes move).
    const sources = {};
    for (const id of involved) {
      const file = await ctx.findClipFile(id);
      if (!file) throw new Error("clip " + id + " has no media file");
      sources[id] = file;
    }

    // Container follows the FIRST source (MOV in → MOV out, else MP4 — §6.2).
    const firstName = String(sources[segments[0].clip_id].name || "");
    const ext = /\.mov$/i.test(firstName) ? "mov" : "mp4";
    const finalName = tsName() + "." + ext;
    const firstMeta = metaById.get(segments[0].clip_id);
    const expectAudio = !!(firstMeta && firstMeta.audio);

    setOpMarker("export", projectId, { name: finalName });
    wake.acquire();
    showProgress("Preparing…");

    const exportsDir = await projectSubDir(projectId, "exports", { create: true });
    const out = await engine.tempThenRename(exportsDir, finalName);
    let stats = null;
    try {
      stats = await engine.losslessCut({ segments, sources, target: out, onProgress: heartbeat });
    } catch (err) {
      await out.abandon();
      throw err;
    }

    // Verify BEFORE rename (banked #4/#5). Lossless preserves HDR → no expectSdr.
    if (progressText) progressText.textContent = "Checking the result…";
    const verdict = await engine.verifyOutput({
      handle: out.handle,
      expectedSeconds: fold.timeline_duration_s,
      expectAudio,
      writeStats: (stats && stats.writes) || out.stats,
    });

    if (verdict && verdict.status === "ok") {
      await out.commit();
      const fh = await exportsDir.getFileHandle(finalName);
      const raw = await fh.getFile();
      const file = new File([raw], finalName, { type: mimeFor(finalName) });
      armed = { file, name: finalName };
      dlog("info", "export.ok", {
        tier: "lossless", name: finalName, bytes: file.size,
        duration_s: fold.timeline_duration_s, segments: segments.length,
      });
      showVerdictOk(file, { duration_s: fold.timeline_duration_s });
      toast("Export verified.", "ok");
    } else {
      const corruptName = finalName + ".corrupt";
      await moveEntry(exportsDir, out.tmpName, corruptName);
      const fh = await exportsDir.getFileHandle(corruptName);
      const raw = await fh.getFile();
      const file = new File([raw], corruptName, { type: mimeFor(finalName) });
      dlog("error", "export.corrupt", {
        tier: "lossless", name: corruptName,
        status: verdict && verdict.status,
        problems: verdict && Array.isArray(verdict.problems)
          ? verdict.problems.slice(0, 5).map((p) => String(p).slice(0, 120)) : [],
      });
      showVerdictCorrupt(file, verdict);
    }
  }

  /* ---- the RENDER path (M3, arch §5.2) -------------------------------------------------- */
  async function runRender({ fold, segments, metas, metaById, renderBlock }) {
    const engine = ctx.engine();
    if (typeof engine.renderProject !== "function") {
      showError("This version can't re-encode video — refresh the app to finish updating.");
      return;
    }

    // GATE CHECK (arch §6.2): a device whose render gate is closed cannot
    // re-encode on-device. Show the honest gated-device card; no partial output.
    const render = ctx.caps && ctx.caps.render;
    if (!render || render.ok !== true) {
      dlog("warn", "export.render.gated", { reasons: (render && render.reasons) || [] });
      showGatedCard(render && render.reasons);
      return;
    }

    // CONFIRM + SDR notice (arch §5.2) — once per session. The agent's prose
    // already set the expectation; the UI repeats it at the tap.
    if (!renderNoticeAck) {
      const ok = await confirmRenderNotice();
      if (!ok) {
        dlog("info", "export.render.declined");
        return;            // the user backed out — nothing changed, no output
      }
      renderNoticeAck = true;
    }

    const canvas = resolveCanvas(renderBlock, metas);
    const music = fold.music || [];

    // Quota preflight: the output bytes (canvas bitrate × duration) + the
    // segment checkpoints (≈ the same again, transient) + 15% headroom.
    const seconds = fold.timeline_duration_s || 0;
    const approxBitrate = estimateRenderBitrate(canvas);   // bits/s
    const outputBytes = Math.ceil((approxBitrate / 8) * seconds);
    const estimate = Math.ceil(outputBytes * 2.0);          // output + checkpoints
    const quota = await quotaPreflight(estimate, 0.15);
    if (!quota.ok) {
      showError("Not enough storage to re-encode: this needs about " + fmtBytes(quota.needed) +
        " but only " + fmtBytes(quota.available) + " is free. Delete old exports or projects first.");
      return;
    }

    // Resolve the clip source files (a missing clip fails BEFORE any work).
    const involved = [...new Set(segments.map((s) => s.clip_id))];
    const sources = {};
    for (const id of involved) {
      const file = await ctx.findClipFile(id);
      if (!file) throw new Error("clip " + id + " has no media file");
      sources[id] = file;
    }

    // Resolve the music track files (lazy-copied library beds + uploads live in
    // the project's music/ store; readTrackFile reads the ORIGINAL bytes back).
    const musicSources = {};
    for (const m of music) {
      if (musicSources[m.track_id]) continue;
      const f = await readTrackFile(projectId, m.track_id);
      if (f) musicSources[m.track_id] = f;
      else dlog("warn", "export.render.music.missing", { track_id: m.track_id });
    }

    // Transcript word-times for ducking (only the clips that have one + a
    // placement that ducks; a missing transcript falls back to a fixed level in
    // audiomix). DATA, not instructions (arch §9) — only {words:[{s,e}]} is used.
    const transcripts = {};
    const anyDuck = music.some((m) => m.duck && m.duck.enabled);
    if (anyDuck) {
      for (const id of involved) {
        try {
          const doc = await readTranscript(projectId, id);
          if (doc && Array.isArray(doc.words)) transcripts[id] = { words: doc.words };
        } catch { /* no transcript — audiomix uses the fixed-level fallback */ }
      }
    }

    const finalName = renderTsName();
    setOpMarker("export", projectId, { name: finalName, tier: "render" });
    wake.acquire();
    showProgress("Preparing the render…", { determinate: true });

    // renderProject does the checkpointed decode→compose→encode→mix→concat→
    // verify (SDR-aware) internally and returns the COMMITTED render/out-<ts>.mp4
    // handle (or a .corrupt handle + a non-ok verdict). RESUME: a matching
    // fingerprint manifest skips done segments — a kill mid-render costs only
    // the unfinished segments (arch §6.4.3). The export op queue is single-
    // flight, so this never overlaps an agent edit (banked #6).
    let result;
    try {
      result = await engine.renderProject({
        projectId, fold, renderBlock, canvas, clips: metas,
        music, sources, musicSources, transcripts,
        onProgress: renderHeartbeat,
        signal: undefined,                // M3 has no in-export cancel UI yet
      });
    } catch (err) {
      dlog("error", "export.render.err", { message: String(err && err.message).slice(0, 200) });
      throw err;
    }

    const { handle, stats, verdict } = result || {};
    const exportsDir = await projectSubDir(projectId, "exports", { create: true });

    if (verdict && verdict.status === "ok" && handle) {
      // Move the verified render from render/ into exports/ under the final name
      // (cross-dir streamed copy — render.js committed + verified it already;
      // this is the verify-before-share commit point for the render path).
      if (progressText) progressText.textContent = "Saving…";
      const file = await moveRenderOutput(handle, exportsDir, finalName);
      armed = { file, name: finalName };
      dlog("info", "export.ok", {
        tier: "render", name: finalName, bytes: file.size,
        duration_s: fold.timeline_duration_s, segments: segments.length,
        codec: stats && stats.video_codec, music: music.length,
      });
      showVerdictOk(file, { duration_s: fold.timeline_duration_s, rendered: true });
      toast("Render verified.", "ok");
    } else {
      // A corrupt render is quarantined by render.js as a .corrupt handle; mirror
      // it into exports/ under a .corrupt name so it can be inspected but never
      // saved trusted (the M0 corruption lesson holds for re-encodes too).
      const corruptName = finalName.replace(/\.mp4$/, "") + ".corrupt.mp4";
      let file = null;
      if (handle) {
        try { file = await moveRenderOutput(handle, exportsDir, corruptName); }
        catch (err) { dlog("warn", "export.render.quarantine.err", { message: String(err && err.message).slice(0, 160) }); }
      }
      dlog("error", "export.corrupt", {
        tier: "render", name: corruptName,
        status: verdict && verdict.status,
        problems: verdict && Array.isArray(verdict.problems)
          ? verdict.problems.slice(0, 5).map((p) => String(p).slice(0, 120)) : [],
      });
      if (file) showVerdictCorrupt(file, verdict);
      else showError("The render failed its safety check and the result couldn't be kept. Try exporting again.");
    }
  }

  /* ---- exports list (re-share / delete) ------------------------------------------------ */
  async function refreshList() {
    const rows = [];
    try {
      const exportsDir = await projectSubDir(projectId, "exports", { create: true });
      const names = [];
      for await (const [name, handle] of exportsDir.entries()) {
        if (handle.kind === "file" && !name.endsWith(".tmp")) names.push(name);
      }
      names.sort().reverse();                           // newest first (timestamped names)
      for (const name of names) {
        const fh = await exportsDir.getFileHandle(name);
        const f = await fh.getFile();
        rows.push(exportRow(exportsDir, name, f));
      }
    } catch (err) {
      dlog("warn", "export.list.err", { message: String(err && err.message).slice(0, 200) });
    }
    listEl.replaceChildren(...(rows.length ? rows : [
      el("p", { class: "export__none", text: "No exports yet — your finished videos appear here." }),
    ]));
  }

  function exportRow(exportsDir, name, f) {
    const corrupt = name.endsWith(".corrupt");
    const statusLine = el("p", { class: "export__share-status", role: "status" });
    const shareBtn = (ctx.caps && ctx.caps.shareFiles)
      ? el("button", {
          class: "icon-btn", type: "button",
          "aria-label": (corrupt ? "Share for inspection: " : "Save to Photos: ") + name,
          onclick: () => shareFile(new File([f], name, { type: mimeFor(name) }), statusLine),
        }, [icon("i-share")])
      : null;
    const dlBtn = el("button", {
      class: "icon-btn", type: "button",
      "aria-label": "Download " + name,
      onclick: () => {
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(f);
        const a = el("a", { href: downloadUrl, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        statusLine.textContent = "Download started.";
      },
    }, [icon("i-download")]);

    /* Two-step inline delete: first tap arms, second tap (within 4 s) deletes. */
    let armTimer = 0;
    const delBtn = el("button", {
      class: "icon-btn export__delete", type: "button",
      "aria-label": "Delete " + name,
      onclick: async () => {
        if (delBtn.dataset.armed !== "true") {
          delBtn.dataset.armed = "true";
          delBtn.setAttribute("aria-label", "Tap again to permanently delete " + name);
          statusLine.textContent = "Tap delete again to remove it permanently.";
          armTimer = setTimeout(() => {
            delBtn.dataset.armed = "false";
            delBtn.setAttribute("aria-label", "Delete " + name);
            statusLine.textContent = "";
          }, 4000);
          return;
        }
        clearTimeout(armTimer);
        try {
          await exportsDir.removeEntry(name);
          if (armed && armed.name === name) disarm();
          toast("Export deleted.", "info");
        } catch {
          toast("Couldn't delete that export.", "bad");
        }
        await refreshList();
      },
    }, [icon("i-trash")]);

    return el("div", { class: "export-row", dataset: { corrupt: String(corrupt) } }, [
      el("div", { class: "export-row__info" }, [
        el("span", { class: "export-row__name mono", text: name }),
        el("span", {
          class: "export-row__meta",
          text: fmtBytes(f.size) + (corrupt ? " · failed its safety check" : ""),
        }),
        statusLine,
      ]),
      el("div", { class: "export-row__actions" }, [shareBtn, dlBtn, delBtn]),
    ]);
  }

  /* ---- wiring -------------------------------------------------------------------------- */
  exportBtn.addEventListener("click", () => {
    // The run is serialized on the shared op queue (banked #6): an export can
    // never overlap an agent engine command. The share itself happens later,
    // from the completion card's own button tap (fresh user gesture).
    ctx.queue.run(() => runExport());
  });

  refreshList();

  return {
    refresh: refreshList,
    isBusy() { return running; },
    destroy() {
      destroyed = true;
      disarm();
      wake.destroy();
    },
  };
}
