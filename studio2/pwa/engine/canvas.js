/* =============================================================================
   engine/canvas.js — output-format resolver for the render tier (arch §3.1).
   -----------------------------------------------------------------------------
   PURE, dependency-free (no mediabunny, no DOM, no fetch, no OPFS). Turns a
   project's render-block canvas MODE + the live clip metadata into the concrete
   {mode, preset?, width, height, fps, background} the engine and preview read.
   `width`/`height`/`fps` are ALWAYS resolved (never re-derived downstream).

   Three modes (arch §3.1):
     • "preset"        — a fixed entry in PRESETS (16:9/9:16/1:1/4:5 × 1080/720).
     • "match_primary" — the primary (or first live) clip's ROTATION-AWARE
                         display dims; the longer edge is clamped to 1920 (a
                         4K primary downscales to a 1080-class canvas, recorded
                         as an advisory). DEFAULT for a fresh project so a
                         single-clip project "just works" + exports losslessly.
     • "custom"        — explicit even W×H within bounds. DEFERRED in M3
                         (plan §0.3): the UI/agent never produce it, but if a
                         custom block somehow appears we resolve it defensively
                         rather than throw.

   M3 ships ≤1080p only (4K render unmeasured on-device — arch §3.1/§10), so
   every resolved canvas has its longer edge ≤ MAX_LONG_EDGE and even dims.

   This file is the contract Step 2 (render engine) and Step 5 (UI/preview)
   build on — `resolveCanvas` is the single place mode→pixels happens.
============================================================================= */

/* ----- preset table (arch §3.1) ------------------------------------------------ */

/** The fixed output-format presets. Keys are the stable `preset` ids stored in
    meta.render.canvas.preset; dims are even (H.264/HEVC require even W×H). */
export const PRESETS = {
  "16x9_1080": { label: "Landscape (1080p)",      width: 1920, height: 1080, aspect: "16:9" },
  "16x9_720":  { label: "Landscape (720p)",       width: 1280, height: 720,  aspect: "16:9" },
  "9x16_1080": { label: "Portrait / Reels (1080p)", width: 1080, height: 1920, aspect: "9:16" },
  "9x16_720":  { label: "Portrait (720p)",        width: 720,  height: 1280, aspect: "9:16" },
  "1x1_1080":  { label: "Square (1080p)",         width: 1080, height: 1080, aspect: "1:1" },
  "4x5_1080":  { label: "Portrait post (4:5)",    width: 1080, height: 1350, aspect: "4:5" },
};

export const DEFAULT_PRESET = "9x16_1080";
export const DEFAULT_FPS = 30;
export const DEFAULT_BACKGROUND = "blur";    // arch §3.2 / plan §0.1 (switchable to "black")
export const DEFAULT_FIT = "contain";        // arch §3.2 — never loses pixels

const MAX_LONG_EDGE = 1920;   // M3 ≤1080p ceiling (arch §3.1)
const MIN_EDGE = 16;          // a degenerate floor; never a real canvas
const MAX_FPS = 60;           // compositor targets canvas.fps exactly; cap at 60 (arch §3.1)

const BACKGROUNDS = new Set(["blur", "black"]);
const MODES = new Set(["preset", "match_primary", "custom"]);

/* ----- helpers ----------------------------------------------------------------- */

/** Round UP to the nearest even integer in [MIN_EDGE, cap]. Even because
    H.264/HEVC require even dims; we never silently produce an odd edge. */
function evenClamp(n, cap = MAX_LONG_EDGE) {
  let v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < MIN_EDGE) v = MIN_EDGE;
  if (v > cap) v = cap;
  if (v % 2 !== 0) v -= 1;            // round toward the cap-respecting even value
  if (v < MIN_EDGE) v = MIN_EDGE;
  return v;
}

/** Scale (w,h) so the LONGER edge ≤ MAX_LONG_EDGE, preserving aspect; result
    edges are clamped even. Returns {width, height, downscaled:bool}. */
function clampToCeiling(w, h) {
  const longest = Math.max(w, h);
  let downscaled = false;
  let ow = w;
  let oh = h;
  if (longest > MAX_LONG_EDGE) {
    const k = MAX_LONG_EDGE / longest;
    ow = Math.round(w * k);
    oh = Math.round(h * k);
    downscaled = true;
  }
  return { width: evenClamp(ow), height: evenClamp(oh), downscaled };
}

/** Pick a clamped FPS (1..MAX_FPS), defaulting when absent/invalid. */
function normalizeFps(fps) {
  const v = Math.round(Number(fps));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_FPS;
  if (v > MAX_FPS) return MAX_FPS;
  return v;
}

function normalizeBackground(bg) {
  return BACKGROUNDS.has(bg) ? bg : DEFAULT_BACKGROUND;
}

/** A clip's ROTATION-AWARE display dimensions from its clipmeta.video. The
    probe's displayWidth/displayHeight are already rotation-applied (the
    presentation dims), so a 1920×1080 clip rotated 90° reports 1080×1920.
    Falls back to coded dims, then null when neither is usable. */
function clipDisplayDims(clipMeta) {
  const v = clipMeta && clipMeta.video;
  if (!v) return null;
  const dw = Number(v.displayWidth);
  const dh = Number(v.displayHeight);
  if (Number.isFinite(dw) && Number.isFinite(dh) && dw > 0 && dh > 0) {
    return { width: dw, height: dh };
  }
  const cw = Number(v.codedWidth);
  const ch = Number(v.codedHeight);
  if (Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0) {
    return { width: cw, height: ch };
  }
  return null;
}

/* ----- resolver ---------------------------------------------------------------- */

/**
 * Resolve a render block's canvas MODE into concrete pixels.
 *
 * @param {Object|null} renderBlock  meta.render (or its `.canvas`); a missing
 *                                   block resolves to the default preset.
 * @param {Array}       clips        live clipmeta objects (timeline order) —
 *                                   used by "match_primary".
 * @returns {Object} { mode, preset?, primary_clip_id?, width, height, fps,
 *                     background, advisory? } — always with even width/height,
 *                     fps in 1..MAX_FPS, a valid background. `advisory` is a
 *                     human string when a fallback/clamp happened (the agent
 *                     can surface it), absent otherwise.
 *
 * Never throws: any malformed/partial input resolves defensively to a usable
 * canvas (the render must always have concrete dims).
 */
export function resolveCanvas(renderBlock, clips = []) {
  // Accept either a full render block ({canvas, ...}) or a bare canvas object.
  const canvas = renderBlock && renderBlock.canvas ? renderBlock.canvas
    : (renderBlock && (renderBlock.mode || renderBlock.width) ? renderBlock : null);

  const live = Array.isArray(clips) ? clips.filter((c) => clipDisplayDims(c)) : [];
  const background = normalizeBackground(canvas && canvas.background);

  // No canvas at all → the documented default (match_primary if a clip exists,
  // else the default preset). A fresh project's default is match_primary so a
  // single-clip project exports losslessly (arch §3.1).
  if (!canvas || !MODES.has(canvas.mode)) {
    if (live.length > 0) {
      return resolveMatchPrimary(null, live, background);
    }
    return resolvePreset(DEFAULT_PRESET, DEFAULT_FPS, background);
  }

  if (canvas.mode === "preset") {
    return resolvePreset(canvas.preset, canvas.fps, background);
  }
  if (canvas.mode === "match_primary") {
    return resolveMatchPrimary(canvas.primary_clip_id, live, background, canvas.fps);
  }
  // mode === "custom" (DEFERRED — resolve defensively).
  return resolveCustom(canvas, background);
}

function resolvePreset(presetId, fps, background) {
  const preset = PRESETS[presetId] ? presetId : DEFAULT_PRESET;
  const p = PRESETS[preset];
  const out = {
    mode: "preset",
    preset,
    width: p.width,
    height: p.height,
    fps: normalizeFps(fps),
    background,
  };
  if (preset !== presetId && presetId != null) {
    out.advisory = "unknown preset \"" + presetId + "\" — using " + p.label;
  }
  return out;
}

function resolveMatchPrimary(primaryClipId, live, background, fps) {
  // Choose the primary clip: the named one if it's still live, else the first
  // live clip (the resolver rewrites meta when the primary was removed — §3.1).
  let chosen = null;
  if (primaryClipId) {
    chosen = live.find((c) => c.clip_id === primaryClipId) || null;
  }
  let fellBack = false;
  if (!chosen) {
    chosen = live[0] || null;
    if (primaryClipId && chosen) fellBack = true;
  }

  if (!chosen) {
    // No live clips yet — match_primary has nothing to read; fall to the
    // default preset (the engine still gets concrete dims).
    const out = resolvePreset(DEFAULT_PRESET, fps, background);
    out.advisory = "no clips to match — using " + PRESETS[DEFAULT_PRESET].label;
    return out;
  }

  const dims = clipDisplayDims(chosen);
  const clamped = clampToCeiling(dims.width, dims.height);
  const out = {
    mode: "match_primary",
    primary_clip_id: chosen.clip_id,
    width: clamped.width,
    height: clamped.height,
    fps: pickSharedFps(live, fps),
    background,
  };
  const notes = [];
  if (fellBack) notes.push("the chosen primary clip is gone — matching " + chosen.clip_id + " instead");
  if (clamped.downscaled) {
    notes.push("downscaled to " + clamped.width + "×" + clamped.height + " (1080p ceiling)");
  }
  if (notes.length) out.advisory = notes.join("; ");
  return out;
}

/** When every live clip shares one fps (≤ MAX_FPS), keep it; else DEFAULT_FPS.
    An explicit fps argument (when valid) wins. */
function pickSharedFps(live, fps) {
  if (fps != null) {
    const v = normalizeFps(fps);
    if (Number.isFinite(Number(fps)) && Number(fps) >= 1) return v;
  }
  let shared = null;
  for (const c of live) {
    const f = c.video && Number(c.video.fps);
    if (!Number.isFinite(f) || f < 1) return DEFAULT_FPS;
    const r = Math.round(f);
    if (shared == null) shared = r;
    else if (shared !== r) return DEFAULT_FPS;
  }
  if (shared == null) return DEFAULT_FPS;
  return shared > MAX_FPS ? MAX_FPS : shared;
}

function resolveCustom(canvas, background) {
  // DEFERRED in M3; resolve defensively so a stray custom block never breaks
  // the engine. Even-clamp both edges, hold the long edge under the ceiling.
  const w = evenClamp(canvas.width);
  const h = evenClamp(canvas.height);
  const clamped = clampToCeiling(w, h);
  const out = {
    mode: "custom",
    width: clamped.width,
    height: clamped.height,
    fps: normalizeFps(canvas.fps),
    background,
  };
  if (clamped.downscaled || clamped.width !== w || clamped.height !== h) {
    out.advisory = "custom canvas adjusted to " + clamped.width + "×" + clamped.height
      + " (even dims, 1080p ceiling)";
  }
  return out;
}

/** The default render block a fresh/legacy project resolves AS (arch §2.1):
    match_primary, default contain fit, blurred background, no per-clip
    overrides. Pure data; meta.js default-fills a MISSING render block with the
    semantics this represents (= lossless, as M1/M2). */
export function defaultRenderBlock() {
  return {
    canvas: {
      mode: "match_primary",
      primary_clip_id: null,
      width: PRESETS[DEFAULT_PRESET].width,
      height: PRESETS[DEFAULT_PRESET].height,
      fps: DEFAULT_FPS,
      background: DEFAULT_BACKGROUND,
    },
    default_fit: DEFAULT_FIT,
    fits: {},
  };
}
