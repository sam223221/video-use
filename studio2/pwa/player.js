/* =============================================================================
   player.js — the EDL-driven skip-preview player (arch §7.2).
   -----------------------------------------------------------------------------
   A native <video> plays the ORIGINAL clip bytes from OPFS over a blob URL —
   nothing is rendered or re-encoded for preview. The edit is PERFORMED at
   playback time: the folded keep-list (Step 4's EDL fold, via the editor's
   engine adapter) drives seeking PAST removed regions on `timeupdate` (~4 Hz)
   plus `requestVideoFrameCallback` where available (per-frame precision).
   Worst case ~100–250 ms of a removed region flashes before the seek lands —
   accepted for M1 (arch §9).

   Virtual timeline: the scrubber and timecodes live in TIMELINE time (the
   sum of kept-segment durations), mapped segment-by-segment to SOURCE time.
   Multi-clip timelines swap the <video> source per segment (M1 mainline is
   single-clip; the swap path is generic).

   Refresh: editor.js emits "change" on its edlEvents EventTarget after every
   journal-affecting operation (agent edit, undo, ingest) — see editor.js
   "EDL change fan-out". refresh() refolds, remaps the current position into
   the new timeline, and applies the skip rule immediately, so a chat edit is
   visible in the preview before the agent even finishes replying (§7.2.4).

   Blob URL hygiene: exactly one URL alive at a time; revoked on clip swap and
   on destroy() (arch §9 — device memory is THE constraint).

   M3 PREVIEW OVERLAY (arch §8b — CSS approximation, NOT the exact compositor):
   the preview now APPROXIMATES the render so format/fit/music decisions are
   visible BEFORE the minutes-long export. Three additive layers, all cheap:
     • the stage is sized to the CANVAS aspect (meta.render.canvas), so a 9:16
       output shows as a portrait frame even while a landscape clip plays;
     • each clip is CSS `object-fit: contain|cover` per its effective fit, with
       a CSS-BLURRED, cover-scaled COPY of the same <video> behind it for the
       blurred-fill background (black bars when background:"black");
     • a WebAudio graph plays the folded music track(s) under the preview with
       gain + fades + a coarse speech-duck approximation (NOT audiomix's exact
       envelope — a preview). The graph follows the timeline playhead: tracks
       start/stop as the playhead crosses their placement window.
   This is a PREVIEW — the exact pixels/mix come from the render (reusing the
   compositor live would blow the iOS memory budget). It refolds + repaints on
   the editor's "render" edlEvent (canvas/fit/music change) exactly as it
   refolds on "change" (a cut/undo).
============================================================================= */

import { el, icon, fmtDuration } from "./util.js";
import { getRenderBlock, effectiveFit, listClipMetas } from "./store/meta.js";
import { resolveCanvas } from "./engine/canvas.js";

function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

const EPS = 0.04;                 // ~one frame at 24 fps — boundary tolerance

/**
 * Mount the player into `container`.
 * ctx: { project, engine() → adapter|null, findClipFile(clipId) → Promise<File|null>,
 *        edlEvents: EventTarget }
 * Returns { refresh(), destroy() }.
 */
export function initPlayer(ctx, container) {
  /* ---- DOM ----------------------------------------------------------------- */
  // M3: the blurred-fill background — a muted, CSS-blurred, cover-scaled COPY of
  // the same source, mirrored to the foreground's currentTime each frame. It
  // sits BEHIND the sharp video inside the canvas-sized frame. Hidden (and not
  // sourced) unless the active clip's fit is contain + background:"blur".
  const bgVideo = el("video", {
    class: "player__bg", playsinline: true, "webkit-playsinline": "true",
    preload: "metadata", muted: true, "aria-hidden": "true", hidden: true,
  });
  bgVideo.muted = true;          // attribute + property (Safari needs both)
  const video = el("video", {
    class: "player__video",
    playsinline: true,
    "webkit-playsinline": "true",
    preload: "metadata",
  });
  // Custom transport — the native controls can't know about removed regions.
  // Starts disabled (like the scrubber): the first fold enables it, so a tap
  // during the initial refold can never be silently swallowed.
  const playBtn = el("button", {
    class: "icon-btn player__play", type: "button", "aria-label": "Play",
    disabled: true,
  }, [icon("i-play")]);
  const timeNow = el("span", { class: "player__time mono", text: "0:00" });
  const timeTotal = el("span", { class: "player__time player__time--total mono", text: "0:00" });
  const scrubber = el("input", {
    class: "player__scrubber", type: "range",
    min: "0", max: "1000", step: "1", value: "0",
    "aria-label": "Timeline position",
    "aria-valuetext": "0:00",
    disabled: true,
  });
  const emptyNote = el("div", { class: "player__empty" }, [
    icon("i-film"),
    el("span", { text: "Add a video to start cutting." }),
  ]);
  // M3: the canvas-aspect FRAME — sized to the output aspect (CSS aspect-ratio),
  // holding the blurred background + the sharp fit-applied video. Letterbox bars
  // (black background, or the parts a contained clip doesn't fill) show through
  // the frame's own dark fill. A music chip overlays when a bed is placed.
  const musicChip = el("div", { class: "player__music-chip", hidden: true }, [
    icon("i-spark"), el("span", { class: "player__music-chip-text", text: "" }),
  ]);
  const frame = el("div", { class: "player__frame", "data-fit": "contain", "data-bg": "blur" }, [
    bgVideo, video, musicChip,
  ]);
  const stage = el("div", { class: "player__stage" }, [frame, emptyNote]);
  const transport = el("div", { class: "player__transport" }, [
    playBtn, timeNow, scrubber, timeTotal,
  ]);
  const root = el("section", { class: "player", "aria-label": "Preview player" }, [stage, transport]);
  container.append(root);

  /* ---- state ------------------------------------------------------------------ */
  let map = [];                  // [{clip_id, start_s, end_s, tl_start, tl_end}]
  let timelineDuration = 0;
  let segIdx = -1;               // current segment index in `map`
  let activeClipId = null;
  let blobUrl = null;
  let bgBlobUrl = null;          // M3: the background copy's own blob URL
  let playing = false;
  let scrubbing = false;
  let destroyed = false;
  let loadGen = 0;               // guards async clip swaps racing each other
  let rvfcActive = false;

  /* ---- M3 preview overlay state ---- */
  let renderBlock = null;        // normalized meta.render (canvas + fits)
  let clipMetas = [];            // live clipmeta (for resolveCanvas + names)
  let musicPlacements = [];      // folded music: [{track_id, at_s, duration_s, …}]
  let bgWanted = false;          // the active clip's fit is contain+blur
  const audio = createMusicGraph(ctx);   // the WebAudio music approximation

  /* ---- timeline math ------------------------------------------------------------ */
  function buildMap(segments) {
    let acc = 0;
    const out = [];
    for (const s of segments || []) {
      const d = Math.max(0, (s.end_s || 0) - (s.start_s || 0));
      if (d <= 0) continue;
      out.push({ clip_id: s.clip_id, start_s: s.start_s, end_s: s.end_s, tl_start: acc, tl_end: acc + d });
      acc += d;
    }
    timelineDuration = acc;
    return out;
  }

  function segmentForTimeline(t) {
    for (let i = 0; i < map.length; i++) {
      if (t < map[i].tl_end || i === map.length - 1) return i;
    }
    return map.length - 1;
  }

  /** Source position of the CURRENT video element → timeline seconds. */
  function timelineNow() {
    if (segIdx < 0 || segIdx >= map.length) return 0;
    const seg = map[segIdx];
    const src = video.currentTime;
    return Math.max(seg.tl_start, Math.min(seg.tl_end, seg.tl_start + (src - seg.start_s)));
  }

  /* ---- clip loading ----------------------------------------------------------------- */
  async function ensureClip(clipId) {
    if (clipId === activeClipId && video.src) { applyFit(clipId); return true; }
    const gen = ++loadGen;
    const file = await ctx.findClipFile(clipId);
    if (destroyed || gen !== loadGen) return false;
    if (!file) {
      dlog("warn", "player.clip.missing", { clip_id: clipId });
      return false;
    }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    blobUrl = URL.createObjectURL(file);
    activeClipId = clipId;
    video.src = blobUrl;
    await new Promise((resolve) => {
      const done = () => {
        video.removeEventListener("loadedmetadata", done);
        video.removeEventListener("error", done);
        resolve();
      };
      video.addEventListener("loadedmetadata", done, { once: true });
      video.addEventListener("error", done, { once: true });
    });
    if (destroyed || gen !== loadGen) return false;
    applyFit(clipId);              // M3: size the fit + (un)source the bg copy
    return true;
  }

  /* M3: apply the active clip's effective fit (contain/cover + blur/black) to
     the canvas-aspect frame, and source/hide the blurred background copy. */
  function applyFit(clipId) {
    const eff = renderBlock ? effectiveFit(renderBlock, clipId) : { mode: "contain", background: "blur" };
    frame.dataset.fit = eff.mode;
    frame.dataset.bg = eff.background;
    bgWanted = eff.mode === "contain" && eff.background === "blur";
    if (bgWanted && blobUrl) {
      if (bgBlobUrl !== blobUrl) {
        // Reuse the SAME object URL (one decode of the blob; the bg element just
        // re-points at it). Revoking happens on clip swap with the fg URL.
        bgVideo.src = blobUrl;
        bgBlobUrl = blobUrl;
      }
      bgVideo.hidden = false;
      try { bgVideo.currentTime = video.currentTime; } catch { /* not seekable yet */ }
    } else {
      bgVideo.hidden = true;
      if (bgVideo.src) { bgVideo.removeAttribute("src"); try { bgVideo.load(); } catch { /* */ } }
      bgBlobUrl = null;
    }
  }

  /* Keep the blurred background copy in lockstep with the foreground frame —
     position only (it is muted; play/pause follow the foreground). Called from
     the transport sync + rvfc loop. Cheap: a single currentTime assignment, and
     only when the drift exceeds ~80 ms (avoids fighting the decoder). */
  function syncBg() {
    if (bgVideo.hidden || !bgVideo.src) return;
    const drift = Math.abs((bgVideo.currentTime || 0) - video.currentTime);
    if (drift > 0.08) { try { bgVideo.currentTime = video.currentTime; } catch { /* */ } }
    if (playing && bgVideo.paused) { bgVideo.play().catch(() => { /* autoplay-muted ok */ }); }
    else if (!playing && !bgVideo.paused) { try { bgVideo.pause(); } catch { /* */ } }
  }

  /* ---- seeking ------------------------------------------------------------------------ */
  async function seekTimeline(t, { resume } = {}) {
    if (map.length === 0) return;
    const clamped = Math.max(0, Math.min(timelineDuration, t));
    const i = segmentForTimeline(clamped);
    const seg = map[i];
    const wasPlaying = resume != null ? resume : playing;
    segIdx = i;
    const ok = await ensureClip(seg.clip_id);
    if (!ok) return;
    video.currentTime = seg.start_s + Math.max(0, Math.min(seg.tl_end - seg.tl_start, clamped - seg.tl_start));
    audio.seek(clamped, wasPlaying);     // M3: reposition the music approximation
    if (wasPlaying) await playInternal();
    updateTransport();
  }

  /* ---- the skip rule (arch §7.2) --------------------------------------------------------- */
  function checkSkip() {
    if (map.length === 0 || segIdx < 0 || scrubbing) return;
    const seg = map[segIdx];
    if (seg.clip_id !== activeClipId) return;       // a swap is in flight
    const src = video.currentTime;

    if (src >= seg.end_s - EPS) {
      const next = map[segIdx + 1];
      if (!next) {
        // End of the timeline — stop cleanly at the final kept frame.
        pauseInternal();
        video.currentTime = Math.max(seg.start_s, seg.end_s - EPS);
        updateTransport(timelineDuration);
        return;
      }
      segIdx += 1;
      if (next.clip_id === activeClipId) {
        video.currentTime = next.start_s;
      } else {
        // Per-segment source swap (multi-clip timeline).
        const resume = playing;
        ensureClip(next.clip_id).then((ok) => {
          if (!ok) return;
          video.currentTime = next.start_s;
          if (resume) playInternal();
        });
      }
      return;
    }

    if (src < seg.start_s - EPS) {
      // The position fell BEFORE the current segment (external seek, clip
      // metadata drift) — resync to whichever kept region owns this source
      // time, else snap forward to the segment start.
      const owner = map.findIndex((m) => m.clip_id === activeClipId &&
        src >= m.start_s - EPS && src < m.end_s + EPS);
      if (owner !== -1) segIdx = owner;
      else video.currentTime = seg.start_s;
    }
  }

  /* ---- play/pause -------------------------------------------------------------------------- */
  async function playInternal() {
    try {
      await video.play();
      playing = true;
    } catch (err) {
      playing = false;
      dlog("warn", "player.play.err", { message: String(err && err.message).slice(0, 120) });
    }
    syncPlayButton();
    syncBg();
    // M3: start the music approximation from the current timeline position.
    audio.play(timelineNow());
    startRvfc();
  }

  function pauseInternal() {
    try { video.pause(); } catch { /* not loaded */ }
    try { bgVideo.pause(); } catch { /* */ }
    playing = false;
    syncPlayButton();
    audio.pause();             // M3: stop the music approximation
  }

  function syncPlayButton() {
    playBtn.replaceChildren(icon(playing ? "i-pause" : "i-play"));
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  async function togglePlay() {
    if (map.length === 0) return;
    if (playing) { pauseInternal(); return; }
    // Starting from the very end restarts from the top.
    if (timelineNow() >= timelineDuration - EPS) {
      await seekTimeline(0, { resume: true });
      return;
    }
    if (segIdx < 0) { await seekTimeline(0, { resume: true }); return; }
    await playInternal();
  }

  /* ---- requestVideoFrameCallback loop (frame-accurate skip where available) -- */
  function startRvfc() {
    if (rvfcActive || typeof video.requestVideoFrameCallback !== "function") return;
    rvfcActive = true;
    const tick = () => {
      if (destroyed || !playing) { rvfcActive = false; return; }
      checkSkip();
      updateTransport();
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  /* ---- transport sync ------------------------------------------------------------ */
  function updateTransport(forceT) {
    const t = forceT != null ? forceT : timelineNow();
    timeNow.textContent = fmtDuration(t);
    timeTotal.textContent = fmtDuration(timelineDuration);
    if (!scrubbing) {
      const frac = timelineDuration > 0 ? t / timelineDuration : 0;
      scrubber.value = String(Math.round(frac * 1000));
    }
    scrubber.setAttribute("aria-valuetext", fmtDuration(t) + " of " + fmtDuration(timelineDuration));
    // M3: keep the blurred background + the music approximation aligned to the
    // timeline playhead while playing (cheap; bg only re-seeks on real drift).
    syncBg();
    if (playing) audio.tick(t);
  }

  /* ---- refresh (fold → map; M3: + render block, canvas, music) ----------------------- */
  async function refresh() {
    if (destroyed) return;
    let fold;
    try {
      const engine = ctx.engine();
      fold = engine ? await engine.fold() : { segments: [], timeline_duration_s: 0, music: [] };
    } catch (err) {
      dlog("error", "player.fold.err", { message: String(err && err.message).slice(0, 200) });
      fold = { segments: [], timeline_duration_s: 0, music: [] };
    }
    if (destroyed) return;

    // M3: load the render block + live clip metas (for the canvas aspect + fit).
    // Best-effort — a read failure just keeps the previous (or default) overlay.
    try {
      const [rb, cm] = await Promise.all([
        getRenderBlock(ctx.project.id),
        listClipMetas(ctx.project.id),
      ]);
      renderBlock = rb;
      clipMetas = cm;
    } catch (err) {
      dlog("warn", "player.render.read.err", { message: String(err && err.message).slice(0, 160) });
    }
    if (destroyed) return;

    // Size the canvas-aspect frame (a 9:16 output shows portrait even while a
    // landscape clip plays — that IS the preview's job).
    applyCanvasAspect();

    // M3: the folded music placements drive the WebAudio approximation + chip.
    // The chip repaints when an async track-name resolve lands (onName).
    musicPlacements = Array.isArray(fold.music) ? fold.music : [];
    audio.setPlacements(musicPlacements, clipMetas, fold, () => { if (!destroyed) paintMusicChip(); });
    paintMusicChip();

    const tBefore = timelineNow();
    map = buildMap(fold.segments);

    const empty = map.length === 0;
    emptyNote.hidden = !empty;
    frame.hidden = empty;
    scrubber.disabled = empty;
    playBtn.disabled = empty;
    if (empty) {
      pauseInternal();
      segIdx = -1;
      activeClipId = null;
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      bgBlobUrl = null;
      video.removeAttribute("src");
      bgVideo.removeAttribute("src");
      try { video.load(); } catch { /* fine */ }
      try { bgVideo.load(); } catch { /* fine */ }
      updateTransport(0);
      return;
    }

    // Keep the playhead where the user was (clamped into the new timeline),
    // then apply the skip rule instantly — a removed region under the
    // playhead jumps NOW, not at the next timeupdate.
    await seekTimeline(Math.min(tBefore, timelineDuration), { resume: playing });
    checkSkip();
    updateTransport();
  }

  /* M3: size the preview frame to the resolved output aspect (CSS aspect-ratio).
     The frame letterboxes/pillarboxes within the player stage; the per-clip fit
     places the video inside it. */
  function applyCanvasAspect() {
    let canvas = null;
    try { canvas = resolveCanvas(renderBlock, clipMetas); } catch { canvas = null; }
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      frame.style.aspectRatio = canvas.width + " / " + canvas.height;
      frame.dataset.canvas = canvas.width + "×" + canvas.height;
    } else {
      frame.style.aspectRatio = "16 / 9";
    }
  }

  /* M3: a small overlay chip naming the placed music (preview affordance). */
  function paintMusicChip() {
    if (!musicPlacements.length) { musicChip.hidden = true; return; }
    const names = musicPlacements.map((m) => {
      const t = clipMetas; void t;
      return audio.trackName(m.track_id);
    }).filter(Boolean);
    const label = names.length === 1 ? names[0] : names.length + " music tracks";
    musicChip.hidden = false;
    musicChip.querySelector(".player__music-chip-text").textContent = label || "Music";
  }

  /* ---- events -------------------------------------------------------------------------- */
  video.addEventListener("timeupdate", () => { checkSkip(); updateTransport(); });
  video.addEventListener("ended", () => {
    // Source file ran out (last segment reaches the clip's end).
    const next = map[segIdx + 1];
    if (next) {
      segIdx += 1;
      ensureClip(next.clip_id).then((ok) => {
        if (!ok) return;
        video.currentTime = next.start_s;
        if (playing) playInternal();
      });
    } else {
      playing = false;
      syncPlayButton();
      updateTransport(timelineDuration);
    }
  });
  video.addEventListener("pause", () => { if (playing && video.ended === false) { playing = false; syncPlayButton(); } });

  playBtn.addEventListener("click", togglePlay);

  scrubber.addEventListener("input", () => {
    scrubbing = true;
    const t = (parseInt(scrubber.value, 10) / 1000) * timelineDuration;
    timeNow.textContent = fmtDuration(t);
    scrubber.setAttribute("aria-valuetext", fmtDuration(t) + " of " + fmtDuration(timelineDuration));
  });
  scrubber.addEventListener("change", async () => {
    const t = (parseInt(scrubber.value, 10) / 1000) * timelineDuration;
    scrubbing = false;
    await seekTimeline(t);
  });
  scrubber.addEventListener("keydown", (e) => {
    // Arrow keys nudge by 1 s of TIMELINE time (the native step is 1/1000th).
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    seekTimeline(timelineNow() + delta);
  });

  const onEdlChange = () => { refresh(); };
  ctx.edlEvents.addEventListener("change", onEdlChange);
  // M3: a render-territory change (canvas/fit/music) repaints the overlay — the
  // SAME refold path, so a format/music edit is visible in the preview the
  // instant the agent (or the UI) writes it (arch §8b).
  ctx.edlEvents.addEventListener("render", onEdlChange);

  // Initial fold.
  refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      ctx.edlEvents.removeEventListener("change", onEdlChange);
      ctx.edlEvents.removeEventListener("render", onEdlChange);
      pauseInternal();
      audio.destroy();
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      bgBlobUrl = null;
      video.removeAttribute("src");
      bgVideo.removeAttribute("src");
      try { video.load(); } catch { /* fine */ }
      try { bgVideo.load(); } catch { /* fine */ }
    },
  };
}

/* =============================================================================
   createMusicGraph — the WebAudio music approximation (arch §8b).
   -----------------------------------------------------------------------------
   A PREVIEW, not the exact audiomix output: decode each placed track to an
   AudioBuffer (lazily, via decodeAudioData — cheap, cached), and play it under
   the preview through a per-placement GainNode that applies gain + fade-in/out
   + a coarse speech-DUCK approximation. Tracks start/stop as the timeline
   playhead crosses their placement window. The graph follows the player's
   virtual timeline (play/pause/seek/tick), NOT the <video> clock — so a cut
   that shifts the timeline simply re-positions the music next refresh.

   Memory: at most a handful of decoded beds (the placements on the timeline);
   buffers are cached by track_id and released on destroy/setPlacements when a
   track is no longer placed. The AudioContext is created lazily on first play
   (a user gesture is required to start it — the play button IS that gesture).
============================================================================= */
function createMusicGraph(ctx) {
  let actx = null;                 // AudioContext (lazy)
  let placements = [];             // [{music_seq, track_id, at_s, duration_s, gain_db, fade_in_s, fade_out_s, duck}]
  let clipMetas = [];
  const buffers = new Map();       // track_id → AudioBuffer | null (null = failed/decoding)
  const decoding = new Map();      // track_id → Promise
  const trackNames = new Map();    // track_id → display name
  let voiced = [];                 // coarse [{start,end}] timeline spans WITH speech (for duck)
  const active = new Map();        // music_seq → { src, gain }
  let started = false;             // graph is "playing"
  let baseT = 0;                   // timeline seconds at the moment play() began
  let baseCtxTime = 0;             // actx.currentTime at that moment

  function dlogm(level, msg, data) {
    try {
      const d = window.__studio2Diag;
      if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
    } catch { /* ignore */ }
  }

  function ensureCtx() {
    if (actx) return actx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    } catch { actx = null; }
    return actx;
  }

  async function loadTrack(trackId) {
    if (buffers.has(trackId)) return buffers.get(trackId);
    if (decoding.has(trackId)) return decoding.get(trackId);
    const p = (async () => {
      try {
        const mod = await import("./store/music.js");
        const file = await mod.readTrackFile(ctx.project.id, trackId);
        if (!file) { buffers.set(trackId, null); return null; }
        const ac = ensureCtx();
        if (!ac) { buffers.set(trackId, null); return null; }
        const arr = await file.arrayBuffer();
        const buf = await ac.decodeAudioData(arr.slice(0));
        buffers.set(trackId, buf);
        return buf;
      } catch (err) {
        dlogm("warn", "player.music.decode.err", { track_id: trackId, message: String(err && err.message).slice(0, 120) });
        buffers.set(trackId, null);
        return null;
      } finally {
        decoding.delete(trackId);
      }
    })();
    decoding.set(trackId, p);
    return p;
  }

  function gainAt(p, tLocal) {
    // tLocal = seconds since the placement's at_s. Apply fade-in/out around the
    // base gain (dB→linear). A coarse duck is applied in scheduleGain via the
    // voiced spans (preview only).
    const dur = p.duration_s || 0;
    let lin = Math.pow(10, (p.gain_db || -8) / 20);
    if (p.fade_in_s > 0 && tLocal < p.fade_in_s) lin *= Math.max(0, tLocal / p.fade_in_s);
    if (p.fade_out_s > 0 && dur > 0 && tLocal > dur - p.fade_out_s) {
      lin *= Math.max(0, (dur - tLocal) / p.fade_out_s);
    }
    return Math.max(0, lin);
  }

  /* Schedule a placement's gain envelope from the current timeline position to
     its end, including a coarse speech-duck (the music dips amount_db during
     voiced spans). Uses linearRamp points at a modest resolution — a preview. */
  function scheduleGain(gain, p, tlNow) {
    const ac = actx;
    if (!ac) return;
    const startTl = Math.max(p.at_s, tlNow);
    const endTl = p.at_s + (p.duration_s || 0);
    if (endTl <= startTl) { gain.gain.value = 0; return; }
    const STEP = 0.2;
    gain.gain.cancelScheduledValues(ac.currentTime);
    let first = true;
    for (let tl = startTl; tl <= endTl + 1e-6; tl += STEP) {
      const tLocal = tl - p.at_s;
      let lin = gainAt(p, tLocal);
      if (p.duck && p.duck.enabled && isVoiced(tl)) {
        lin *= Math.pow(10, (p.duck.amount_db || -12) / 20);
      }
      const when = baseCtxTime + (tl - baseT);
      const at = Math.max(ac.currentTime, when);
      if (first) { gain.gain.setValueAtTime(lin, at); first = false; }
      else gain.gain.linearRampToValueAtTime(lin, at);
    }
  }

  function isVoiced(tl) {
    for (const v of voiced) { if (tl >= v.start && tl < v.end) return true; }
    return false;
  }

  function stopAll() {
    for (const { src } of active.values()) {
      try { src.stop(); } catch { /* already */ }
      try { src.disconnect(); } catch { /* */ }
    }
    active.clear();
  }

  async function startPlacement(p, tlNow) {
    const ac = ensureCtx();
    if (!ac) return;
    const buf = await loadTrack(p.track_id);
    if (!buf || !started) return;
    // The playhead may have moved while decoding — re-check the window.
    const endTl = p.at_s + (p.duration_s || 0);
    if (tlNow >= endTl) return;
    if (active.has(p.music_seq)) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const gain = ac.createGain();
    src.connect(gain).connect(ac.destination);
    // Where in the track to start: track_offset + how far into the placement
    // the playhead already is (looping the bed if the timeline outlasts it).
    const intoPlacement = Math.max(0, tlNow - p.at_s);
    const offset = ((p.track_offset_s || 0) + intoPlacement) % buf.duration;
    if (buf.duration < (p.duration_s || 0)) src.loop = true;     // bed shorter than its window → loop
    scheduleGain(gain, p, tlNow);
    const startWhen = ac.currentTime;
    try { src.start(startWhen, offset); } catch { /* bad offset */ return; }
    active.set(p.music_seq, { src, gain });
    src.onended = () => { active.delete(p.music_seq); };
  }

  return {
    setPlacements(next, metas, fold, onName) {
      placements = (next || []).map((m) => ({ ...m }));
      clipMetas = metas || [];
      // Derive coarse voiced spans on the OUTPUT timeline from the fold's clip
      // segments + any transcript words the engine has (preview duck). We don't
      // read transcripts here (would be heavy/async per refresh); the preview
      // duck instead dips during EVERY segment that came from a clip — a useful
      // "music drops under the video's voice" approximation. The exact, word-
      // accurate envelope is the render's job (audiomix/duck.js).
      voiced = [];
      const segs = (fold && Array.isArray(fold.segments)) ? fold.segments : [];
      let acc = 0;
      for (const s of segs) {
        const d = Math.max(0, (s.end_s || 0) - (s.start_s || 0));
        if (d > 0) voiced.push({ start: acc, end: acc + d });
        acc += d;
      }
      // Release decoded buffers for tracks no longer placed (memory).
      const live = new Set(placements.map((p) => p.track_id));
      for (const id of [...buffers.keys()]) {
        if (!live.has(id)) buffers.delete(id);
      }
      // Resolve display names (best-effort, async, cached).
      for (const p of placements) {
        if (!trackNames.has(p.track_id)) {
          trackNames.set(p.track_id, "Music");
          import("./store/music.js").then((mod) => mod.readTrackMeta(ctx.project.id, p.track_id))
            .then((tm) => {
              if (tm) {
                trackNames.set(p.track_id, tm.title || tm.original_name || "Music");
                if (typeof onName === "function") { try { onName(); } catch { /* */ } }
              }
            })
            .catch(() => { /* keep the default */ });
        }
      }
      // If currently playing, re-sync which placements are live at the playhead.
      if (started) { stopAll(); this.tick(currentTl()); }
    },
    trackName(trackId) { return trackNames.get(trackId) || null; },
    play(tlNow) {
      const ac = ensureCtx();
      if (!ac) return;
      if (ac.state === "suspended") ac.resume().catch(() => { /* */ });
      started = true;
      baseT = tlNow || 0;
      baseCtxTime = ac.currentTime;
      this.tick(baseT);
    },
    pause() {
      started = false;
      stopAll();
    },
    seek(tlNow, resume) {
      // Reposition: stop everything; if (still) playing, restart from tlNow.
      stopAll();
      if (resume && started) {
        const ac = ensureCtx();
        if (ac) { baseT = tlNow; baseCtxTime = ac.currentTime; this.tick(tlNow); }
      } else {
        baseT = tlNow;
      }
    },
    /* Called on the playhead heartbeat: start placements whose window the
       playhead is inside but that aren't sounding yet; stop ones it left. */
    tick(tlNow) {
      if (!started) return;
      for (const p of placements) {
        const inWindow = tlNow >= p.at_s - 0.01 && tlNow < p.at_s + (p.duration_s || 0);
        if (inWindow && !active.has(p.music_seq) && !decoding.has(p.track_id + ":start")) {
          startPlacement(p, tlNow);
        } else if (!inWindow && active.has(p.music_seq)) {
          const a = active.get(p.music_seq);
          try { a.src.stop(); } catch { /* */ }
          active.delete(p.music_seq);
        }
      }
    },
    destroy() {
      started = false;
      stopAll();
      buffers.clear();
      decoding.clear();
      if (actx) { try { actx.close(); } catch { /* */ } actx = null; }
    },
  };

  function currentTl() {
    if (!actx) return baseT;
    return baseT + (actx.currentTime - baseCtxTime);
  }
}
