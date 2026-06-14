/* =============================================================================
   music-ops.js — the shared M3 music + format operations (arch §7).
   -----------------------------------------------------------------------------
   ONE source of truth for the device-side logic behind the six M3 tools, so the
   AGENT's bridge executors (bridge.js) and the UI controls (music-ui.js /
   format-ui.js) call the SAME code and can NEVER diverge (arch §3.3). Every
   function here re-validates the relay-validated params (defense in depth, the
   data owner — arch §8.3) and returns the EXACT Step-4 result shapes the relay
   contract documents (studio2/relay/app/agent/DOCUMENT.md).

   The functions:
     setOutputFormat(projectId, cmd)  → {canvas, tier, note}
     setClipFit(projectId, cmd)       → {clip_id, fit, background, tier}
     listMusicLibrary()               → {tracks:[{library_id,title,mood,duration_s,license}]}
     addMusic(projectId, cmd, {commandId?}) → {music_seq, placement, timeline_duration_s, tier}
     updateMusic(projectId, cmd, {commandId?}) → {music_seq, placement, tier}
     removeMusic(projectId, cmd, {commandId?}) → {removed:true, timeline_duration_s, tier}
     currentTier(projectId, fold)     → "lossless" | "render" (for inventory/read_edl)
     importUserTrack(projectId, file) → trkmeta (UI-only Files upload; arch §7.1)
     getCatalog()                     → the bundled catalog array (cached)

   The bundled music library is served STATIC (same-origin, like fonts —
   arch §9, zero external origins): catalog.json + the .m4a beds under
   /static/assets/music/. A `library_id` is checked against the catalog
   allowlist HERE (the device owns the allowlist; the relay only bounds the id
   SHAPE — arch §9). The .m4a bytes LAZY-LOAD: copyLibraryTrack fetches a bed
   only when a track is actually placed (the 8 beds are NOT precached, ~29 MB).

   Bounds re-validation mirrors store/edl.js's clamps (gain −60…+6, fades 0…10,
   duck per arch) AND store/meta canvas/fit validation, so the agent's params
   are clamped/rejected identically to the relay + the store.

   PURE-ish: imports the stores/engine (meta/edl/music/cut) + fetches the
   same-origin static catalog/beds. NO DOM. Errors thrown carry a taxonomy
   `.toolCode`/`.code` so bridge.js classifies them (engine_error/storage_error).
============================================================================= */

import {
  setCanvas, setClipFit as metaSetClipFit, getRenderBlock, listClipMetas,
} from "./store/meta.js";
import {
  appendAddMusic, appendUpdateMusic, appendRemoveMusic, readState,
} from "./store/edl.js";
import {
  copyLibraryTrack, importTrack, hasTrack, TRACK_ID_RE,
} from "./store/music.js";
import { tierCheck } from "./engine/cut.js";

/* The bundled-catalog id allowlist shape (mirrors store/music.LIBRARY_ID_RE). */
const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const CLIP_ID_RE = /^clip_[0-9a-f]{8}$/;

/* Numeric bounds (arch §7.1/§9 — same as the relay + store/edl.js). */
const GAIN_DB_MIN = -60, GAIN_DB_MAX = 6;
const FADE_S_MIN = 0, FADE_S_MAX = 10;
const DUCK_DB_MIN = -60, DUCK_DB_MAX = 0;
const DUCK_TIME_MIN = 0, DUCK_TIME_MAX = 5;

/* Upload caps (arch §9 — the user-uploaded track is bounded). */
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024 * 1024;  // 3 GiB — user-requested large music cap
const UPLOAD_MAX_DURATION_S = 360 * 60;           // 6 hours — long enough a multi-GB audio file isn't blocked by duration before the size cap matters

const CATALOG_URL = "/static/assets/music/catalog.json";
const BED_URL = (libraryId) => "/static/assets/music/" + libraryId + ".m4a";

/* ----- taxonomy error helper -------------------------------------------------- */

function opError(code, message) {
  const e = new Error(String(message || code));
  e.name = "ToolError";
  e.toolCode = code;             // bridge.js classifyError reads this
  return e;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }

/* Friendly byte-cap label: GB at ≥1024 MiB (so 3 GiB reads "3 GB", not
   "3072 MB"), MB below. Used in the size-too-large message only. */
function formatByteCap(bytes) {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1024) return round2(mib / 1024) + " GB";
  return Math.round(mib) + " MB";
}

/* ----- catalog (cached, same-origin static) ----------------------------------- */

let catalogCache = null;
let catalogPromise = null;

/** The bundled library catalog (array of {library_id,title,artist,mood,
    duration_s,license,source_url}). Cached after the first fetch. Throws an
    engine_error if the static file is unreachable/malformed. */
export async function getCatalog() {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      let res;
      try {
        res = await fetch(CATALOG_URL, { credentials: "same-origin", cache: "force-cache" });
      } catch {
        throw opError("engine_error", "the built-in music library couldn't be loaded");
      }
      if (!res.ok) throw opError("engine_error", "the built-in music library couldn't be loaded (HTTP " + res.status + ")");
      let data;
      try { data = await res.json(); } catch {
        throw opError("engine_error", "the built-in music library catalog is unreadable");
      }
      if (!Array.isArray(data)) throw opError("engine_error", "the built-in music library catalog is malformed");
      catalogCache = data.filter((e) => e && LIBRARY_ID_RE.test(String(e.library_id)));
      return catalogCache;
    })().catch((err) => { catalogPromise = null; throw err; });
  }
  return catalogPromise;
}

/** Look up one catalog entry by library_id (allowlist check). Null if unknown. */
async function catalogEntry(libraryId) {
  const cat = await getCatalog();
  return cat.find((e) => e.library_id === libraryId) || null;
}

/* ----- the live tier (used by every op's result + inventory/read_edl) --------- */

/** Recompute the current tier ("lossless"|"render") from the fold + render block
    + live clips. Defensive: any failure resolves "render" (the safe, honest
    default — a project we can't prove is lossless is treated as a re-encode). */
export async function currentTier(projectId, fold) {
  try {
    const [render, clips] = await Promise.all([
      getRenderBlock(projectId),
      listClipMetas(projectId),
    ]);
    let f = fold;
    if (!f) f = await readState(projectId);
    return tierCheck(f, render, clips);
  } catch {
    return "render";
  }
}

/* =============================================================================
   set_output_format  (arch §7.1)
   cmd: {mode:"preset", preset, fps?} | {mode:"match_primary", fps?}
        | {mode:"preset", preset, background?} (UI also sets background)
   → {canvas:{mode,preset?,width,height,fps,background}, tier, note}
============================================================================= */
export async function setOutputFormat(projectId, cmd = {}) {
  const mode = cmd.mode === "match_primary" ? "match_primary"
    : cmd.mode === "custom" ? "custom" : "preset";
  if (mode === "custom") {
    // DEFERRED (plan §0.3) — the relay already rejects custom; the device too.
    throw opError("engine_error", "custom dimensions aren't available yet — use a preset or match your main clip");
  }
  const spec = { mode };
  if (mode === "preset") {
    if (typeof cmd.preset !== "string") throw opError("engine_error", "set_output_format needs a preset");
    spec.preset = cmd.preset;
  }
  if (cmd.fps != null) {
    const fps = num(cmd.fps);
    if (fps == null || fps < 1) throw opError("engine_error", "fps must be a positive number");
    spec.fps = fps;
  }
  if (cmd.background === "blur" || cmd.background === "black") spec.background = cmd.background;

  const { canvas, advisory } = await setCanvas(projectId, spec);
  const tier = await currentTier(projectId, null);

  // The realized canvas the agent reports (arch §7.2 honesty rule).
  const out = {
    canvas: {
      mode: canvas.mode,
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      background: canvas.background,
    },
    tier,
    note: noteForCanvas(canvas, tier, advisory),
  };
  if (canvas.preset) out.canvas.preset = canvas.preset;
  return out;
}

function noteForCanvas(canvas, tier, advisory) {
  const shape = canvas.width + "×" + canvas.height;
  let note = tier === "render"
    ? ("Set to " + shape + ". Combining shapes or sizes means a re-encode — export takes a couple of minutes and the result is standard-range, not HDR.")
    : ("Set to " + shape + ". This still exports instantly and keeps full quality.");
  if (advisory) note += " (" + advisory + ")";
  return note;
}

/* =============================================================================
   set_clip_fit  (arch §7.1)
   cmd: {clip_id, fit:"contain"|"cover", background?:"blur"|"black"}
   → {clip_id, fit, background, tier}
============================================================================= */
export async function setClipFit(projectId, cmd = {}) {
  const clipId = cmd.clip_id;
  if (!CLIP_ID_RE.test(String(clipId))) throw opError("engine_error", "clip_id must match clip_<8 hex chars>");
  const fit = cmd.fit;
  if (fit !== "contain" && fit !== "cover") throw opError("engine_error", "fit must be \"contain\" or \"cover\"");
  const spec = { mode: fit };
  if (cmd.background != null) {
    if (cmd.background !== "blur" && cmd.background !== "black") {
      throw opError("engine_error", "background must be \"blur\" or \"black\"");
    }
    if (fit === "contain") spec.background = cmd.background;
  }
  const render = await metaSetClipFit(projectId, clipId, spec);
  const tier = await currentTier(projectId, null);
  // The effective background after the write (sparse override else canvas bg).
  const override = render.fits && render.fits[clipId];
  const background = (override && override.background)
    || (render.canvas && render.canvas.background) || "blur";
  return { clip_id: clipId, fit, background, tier };
}

/* =============================================================================
   list_music_library  (arch §7.1)
   → {tracks:[{library_id, title, mood, duration_s, license}]}
============================================================================= */
export async function listMusicLibrary() {
  let cat;
  try {
    cat = await getCatalog();
  } catch {
    // The relay forwards an empty/stub list until the assets land; mirror that
    // — a missing library is a degraded read, never a hard tool failure.
    return { tracks: [] };
  }
  return {
    tracks: cat.map((e) => ({
      library_id: e.library_id,
      title: typeof e.title === "string" ? e.title : e.library_id,
      mood: typeof e.mood === "string" ? e.mood : null,
      duration_s: num(e.duration_s),
      license: typeof e.license === "string" ? e.license : null,
    })),
  };
}

/* ----- placement re-validation (clamp like store/edl, reject the unfixable) --- */

function buildPlacement(cmd, { partial = false } = {}) {
  const p = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(cmd, k);

  if (has("at_s")) {
    const v = num(cmd.at_s);
    if (v == null || v < 0) throw opError("engine_error", "at_s must be a number ≥ 0");
    p.at_s = v;
  } else if (!partial) p.at_s = 0;

  if (has("duration_s")) {
    if (cmd.duration_s === "whole" || cmd.duration_s == null) {
      p.duration_s = null;        // null = under the whole video
    } else {
      const v = num(cmd.duration_s);
      if (v == null || v <= 0) throw opError("engine_error", "duration_s must be > 0 or \"whole\"");
      p.duration_s = v;
    }
  } else if (!partial) p.duration_s = null;

  if (has("track_offset_s")) {
    const v = num(cmd.track_offset_s);
    if (v == null || v < 0) throw opError("engine_error", "track_offset_s must be a number ≥ 0");
    p.track_offset_s = v;
  } else if (!partial) p.track_offset_s = 0;

  if (has("gain_db")) {
    let v = num(cmd.gain_db);
    if (v == null) throw opError("engine_error", "gain_db must be a number");
    p.gain_db = Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, v));
  } else if (!partial) p.gain_db = -8;

  if (has("fade_in_s")) p.fade_in_s = clampFade(cmd.fade_in_s, "fade_in_s");
  else if (!partial) p.fade_in_s = 0;
  if (has("fade_out_s")) p.fade_out_s = clampFade(cmd.fade_out_s, "fade_out_s");
  else if (!partial) p.fade_out_s = 0;

  if (has("duck")) {
    p.duck = buildDuck(cmd.duck);
  } else if (!partial) {
    p.duck = { enabled: false, under: "speech", amount_db: -12, attack_s: 0.25, release_s: 0.6 };
  }
  return p;
}

function clampFade(raw, label) {
  const v = num(raw);
  if (v == null) throw opError("engine_error", label + " must be a number");
  return Math.min(FADE_S_MAX, Math.max(FADE_S_MIN, v));
}

function buildDuck(raw) {
  if (raw == null) return { enabled: false, under: "speech", amount_db: -12, attack_s: 0.25, release_s: 0.6 };
  if (typeof raw !== "object") throw opError("engine_error", "duck must be an object");
  const clamp = (v, lo, hi, dflt) => {
    if (v == null) return dflt;
    const n = num(v);
    return n == null ? dflt : Math.min(hi, Math.max(lo, n));
  };
  return {
    enabled: !!raw.enabled,
    under: "speech",                 // only "speech" in M3
    amount_db: clamp(raw.amount_db, DUCK_DB_MIN, DUCK_DB_MAX, -12),
    attack_s: clamp(raw.attack_s, DUCK_TIME_MIN, DUCK_TIME_MAX, 0.25),
    release_s: clamp(raw.release_s, DUCK_TIME_MIN, DUCK_TIME_MAX, 0.6),
  };
}

/* ----- resolve a track_ref → a track_id (copying a library track on first use) */

/** Resolve add_music's track_ref to a concrete track_id that exists in the
    project's music/ store. A {library_id} fetches the bundled bed (lazy) and
    copies it into OPFS via store/music.copyLibraryTrack; a {track_id} must
    already be imported (UI upload). Returns the track_id. */
async function resolveTrackRef(projectId, trackRef) {
  if (!trackRef || typeof trackRef !== "object") {
    throw opError("engine_error", "add_music needs a track_ref ({library_id} or {track_id})");
  }
  const hasLib = trackRef.library_id != null;
  const hasTrk = trackRef.track_id != null;
  if (hasLib === hasTrk) {
    throw opError("engine_error", "track_ref must carry EXACTLY one of library_id or track_id");
  }
  if (hasTrk) {
    const id = String(trackRef.track_id);
    if (!TRACK_ID_RE.test(id)) throw opError("engine_error", "track_id must match trk_<8 hex chars>");
    if (!(await hasTrack(projectId, id))) {
      throw opError("engine_error", "that track isn't in this project — upload it first");
    }
    return id;
  }
  // Library track: allowlist-check, lazy-fetch the bed, copy into OPFS.
  const libraryId = String(trackRef.library_id);
  if (!LIBRARY_ID_RE.test(libraryId)) throw opError("engine_error", "bad library_id");
  const entry = await catalogEntry(libraryId);
  if (!entry) throw opError("engine_error", "no built-in track with id \"" + libraryId + "\"");
  let bytes;
  try {
    const res = await fetch(BED_URL(libraryId), { credentials: "same-origin", cache: "force-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    bytes = await res.blob();
  } catch {
    throw opError("engine_error", "couldn't load the built-in track \"" + (entry.title || libraryId) + "\"");
  }
  const doc = await copyLibraryTrack(projectId, libraryId, bytes, {
    title: entry.title,
    artist: entry.artist,
    license: entry.license,
    duration_s: entry.duration_s,
    original_name: entry.title || libraryId,
    ext: "m4a",
    codec: "aac",
    channels: 2,
    sampleRate: 48000,
  });
  return doc.track_id;
}

/* =============================================================================
   add_music  (arch §7.1)
   cmd: {track_ref:{library_id}|{track_id}, at_s?, duration_s?, track_offset_s?,
         gain_db?, fade_in_s?, fade_out_s?, duck?}
   → {music_seq, placement, timeline_duration_s, tier}
============================================================================= */
export async function addMusic(projectId, cmd = {}, { commandId } = {}) {
  const trackId = await resolveTrackRef(projectId, cmd.track_ref);
  const placement = buildPlacement(cmd, { partial: false });
  const outcome = await appendAddMusic(projectId, {
    track_id: trackId, placement, command_id: commandId,
  });
  // Music always forces the render tier; recompute from a full read for honesty.
  const tier = await currentTier(projectId, null);
  return {
    music_seq: outcome.music_seq,
    placement: outcome.placement,
    timeline_duration_s: outcome.timeline_duration_s,
    tier,
  };
}

/* =============================================================================
   update_music  (arch §7.1)
   cmd: {music_seq, ...partial placement fields...}
   → {music_seq, placement, tier}
============================================================================= */
export async function updateMusic(projectId, cmd = {}, { commandId } = {}) {
  const seq = num(cmd.music_seq);
  if (seq == null) throw opError("engine_error", "music_seq must be a number");
  // track_ref changes are rejected (remove+add) — mirror the relay.
  if (cmd.track_ref != null) throw opError("engine_error", "can't change the track of a placement — remove it and add the new one");
  const patch = buildPlacement(cmd, { partial: true });
  if (Object.keys(patch).length === 0) throw opError("engine_error", "update_music needs at least one field to change");
  const outcome = await appendUpdateMusic(projectId, {
    music_seq: seq, placement: patch, command_id: commandId,
  });
  // The resolved placement for the agent's report (find it in the folded music).
  const placed = (outcome.music || []).find((m) => m.music_seq === seq) || null;
  const tier = await currentTier(projectId, null);
  return { music_seq: seq, placement: placed, tier };
}

/* =============================================================================
   remove_music  (arch §7.1)
   cmd: {music_seq}
   → {removed:true, timeline_duration_s, tier}
============================================================================= */
export async function removeMusic(projectId, cmd = {}, { commandId } = {}) {
  const seq = num(cmd.music_seq);
  if (seq == null) throw opError("engine_error", "music_seq must be a number");
  const outcome = await appendRemoveMusic(projectId, { music_seq: seq, command_id: commandId });
  const tier = await currentTier(projectId, null);
  return { removed: true, timeline_duration_s: outcome.timeline_duration_s, tier };
}

/* =============================================================================
   importUserTrack — UI-only Files upload (arch §7.1). The agent CANNOT read the
   user's filesystem, so upload is a user gesture; this validates + persists the
   ORIGINAL bytes through store/music.importTrack (probe/normalize is M3-light:
   we accept the file as-is after the size/duration cap; the render mixer decodes
   it through mediabunny, which rejects a non-audio container cleanly).
============================================================================= */
export async function importUserTrack(projectId, file, probed = {}) {
  if (!(typeof Blob !== "undefined" && file instanceof Blob)) {
    throw opError("engine_error", "a music file is required");
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    throw opError("engine_error", "that file is too large (max " + formatByteCap(UPLOAD_MAX_BYTES) + ")");
  }
  const dur = num(probed.duration_s);
  if (dur != null && dur > UPLOAD_MAX_DURATION_S) {
    throw opError("engine_error", "that track is longer than " + Math.round(UPLOAD_MAX_DURATION_S / 60) + " minutes");
  }
  const name = String(file.name || "Music");
  const dot = name.lastIndexOf(".");
  const ext = dot > -1 ? name.slice(dot + 1) : "m4a";
  return importTrack(projectId, file, {
    original_name: name,
    title: probed.title != null ? probed.title : name.replace(/\.[^.]+$/, ""),
    artist: probed.artist,
    duration_s: dur,
    codec: probed.codec,
    channels: num(probed.channels),
    sampleRate: num(probed.sampleRate),
    ext,
    size_bytes: file.size,
  });
}

export { round2 as _round2 };
