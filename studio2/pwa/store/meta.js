/* =============================================================================
   store/meta.js — project + clip metadata for Studio v2 (arch §5.1).
   -----------------------------------------------------------------------------
   The ONLY writer of meta.json and clipmeta/*.json at runtime (one writer per
   file — arch §1.4). Project CRUD (create/list/open/delete) lives here;
   projects.js renders, this module persists.

   Layout (per project, arch §5.1):
     projects/prj_<hex12>/
       meta.json            {schema:1, id, name, created_at, updated_at}
       clips/               ingested original bytes (Step 4 writes these)
       clipmeta/clip_<hex8>.json   probe results (Step 4 writes, we read/write)
       edl.jsonl            the journal — owned by store/edl.js (Step 4).
                            NOTE for Step 4: createProject() deliberately does
                            NOT write the `init` op; edl.js writes it lazily
                            when it first opens a project whose edl.jsonl is
                            missing (keeps one-writer-per-file intact).
       chat.json            device-side transcript (Step 5 writes)
       exports/             verified outputs only

   All reads tolerate missing/torn files (null → flagged, never thrown) — a
   crash can tear at most one document, and the UI must keep listing the rest.
============================================================================= */

import {
  PROJECT_ID_RE, CLIP_ID_RE, newProjectId,
  projectDir, projectSubDir, listProjectIds, removeProjectDir,
  readJSON, writeJSONAtomic,
} from "./opfs.js";
import {
  PRESETS, DEFAULT_FPS, DEFAULT_BACKGROUND, DEFAULT_FIT,
  defaultRenderBlock, resolveCanvas,
} from "../engine/canvas.js";

const NAME_MAX = 80;

/* M3 (arch §2.1): meta.json `schema` bumps 1→2 when a `render` block is
   written. A MISSING render block (schema-1 M1/M2 projects, OR a schema-2
   project that never set a format) reads as the documented default — see
   normalizeRenderBlock(): the absence of every render field means "lossless,
   as today", so old projects keep working byte-for-byte. We default-fill on
   read; we only PERSIST schema:2 + a render block once a setter runs. */
const META_SCHEMA = 2;

const FIT_MODES = new Set(["contain", "cover"]);
const BACKGROUNDS = new Set(["blur", "black"]);
const CANVAS_MODES = new Set(["preset", "match_primary", "custom"]);

function nowIso() { return new Date().toISOString(); }

/** Normalize a user-supplied project name: trim, cap length; empty → a
    friendly dated default ("Project 12 Jun"). Names are LABELS — no
    uniqueness constraint (ids are random; arch §13). */
export function normalizeName(name) {
  const n = String(name == null ? "" : name).trim().slice(0, NAME_MAX);
  if (n) return n;
  const d = new Date();
  return "Project " + d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* ----- project CRUD ------------------------------------------------------------ */

/** Create a project: id + directory skeleton + meta.json. Returns the meta. */
export async function createProject(name) {
  const meta = {
    schema: 1,
    id: newProjectId(),
    name: normalizeName(name),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const dir = await projectDir(meta.id, { create: true });
  // Pre-create the fixed subdirs so every later writer can assume they exist.
  await dir.getDirectoryHandle("clips", { create: true });
  await dir.getDirectoryHandle("clipmeta", { create: true });
  await dir.getDirectoryHandle("exports", { create: true });
  await writeJSONAtomic(dir, "meta.json", meta);
  return meta;
}

/** Read one project's meta. Returns null when missing/torn. */
export async function getProject(projectId) {
  if (!PROJECT_ID_RE.test(String(projectId))) return null;
  try {
    const dir = await projectDir(projectId);
    const meta = await readJSON(dir, "meta.json");
    if (!meta || meta.id !== projectId) return null;
    return meta;
  } catch {
    return null;
  }
}

/** Count the clips of a project (cheap directory enumeration). */
export async function countClips(projectId) {
  try {
    const clips = await projectSubDir(projectId, "clips");
    let n = 0;
    for await (const [, handle] of clips.entries()) {
      if (handle.kind === "file") n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** List every project, newest-touched first. A directory whose meta.json is
    missing/torn still lists (broken:true, id-derived label) so the user can
    see and delete it instead of it silently eating storage. */
export async function listProjects() {
  const ids = await listProjectIds();
  const out = [];
  for (const id of ids) {
    let meta = null;
    try {
      const dir = await projectDir(id);
      meta = await readJSON(dir, "meta.json");
    } catch { /* unreadable dir → broken row below */ }
    const clipCount = await countClips(id);
    if (meta && meta.id === id && typeof meta.name === "string") {
      out.push({
        id,
        name: meta.name,
        created_at: meta.created_at || null,
        updated_at: meta.updated_at || meta.created_at || null,
        clipCount,
        broken: false,
      });
    } else {
      out.push({
        id,
        name: "Damaged project (" + id.slice(4, 10) + ")",
        created_at: null,
        updated_at: null,
        clipCount,
        broken: true,
      });
    }
  }
  out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return out;
}

/** Bump updated_at (called on open and by Step 4/5 writers after edits).
    Best-effort: a failed touch never blocks the operation that caused it. */
export async function touchProject(projectId) {
  try {
    const dir = await projectDir(projectId);
    const meta = await readJSON(dir, "meta.json");
    if (!meta || meta.id !== projectId) return null;
    meta.updated_at = nowIso();
    await writeJSONAtomic(dir, "meta.json", meta);
    return meta;
  } catch {
    return null;
  }
}

/** Permanently delete a project and everything in it (clips, journal, chat,
    exports). The CALLER confirms with the user first — same UX contract as
    v1 session delete (arch §5.1). */
export async function deleteProject(projectId) {
  await removeProjectDir(projectId);
}

/* ----- render block (M3 — arch §2.1) -------------------------------------------- */
/* The `render` block is ADDITIVE + OPTIONAL. A project without one (every
   M1/M2 project, and a fresh schema-2 project) reads as defaultRenderBlock():
   match_primary canvas, contain fit, blurred background, no per-clip overrides
   — i.e. "lossless, as today". Readers default-fill; only a setter persists a
   render block (and bumps schema to 2). `fits` stays SPARSE — only clips that
   differ from `default_fit` appear, so adding a clip needs no fit write. */

function normalizeCanvasBlock(raw) {
  const def = defaultRenderBlock().canvas;
  if (!raw || typeof raw !== "object") return { ...def };
  const mode = CANVAS_MODES.has(raw.mode) ? raw.mode : def.mode;
  const out = {
    mode,
    primary_clip_id: null,
    width: def.width,
    height: def.height,
    fps: Number.isFinite(Number(raw.fps)) && Number(raw.fps) >= 1 ? Math.round(Number(raw.fps)) : DEFAULT_FPS,
    background: BACKGROUNDS.has(raw.background) ? raw.background : DEFAULT_BACKGROUND,
  };
  if (mode === "preset") {
    out.preset = PRESETS[raw.preset] ? raw.preset : def && def.preset ? def.preset : "9x16_1080";
  } else if (mode === "match_primary") {
    out.primary_clip_id = CLIP_ID_RE.test(String(raw.primary_clip_id)) ? raw.primary_clip_id : null;
  }
  // Carry RESOLVED dims when present + sane (the engine reads these directly).
  if (Number.isFinite(Number(raw.width)) && Number(raw.width) > 0) out.width = Math.round(Number(raw.width));
  if (Number.isFinite(Number(raw.height)) && Number(raw.height) > 0) out.height = Math.round(Number(raw.height));
  return out;
}

function normalizeFits(raw) {
  const fits = {};
  if (!raw || typeof raw !== "object") return fits;
  for (const [clipId, entry] of Object.entries(raw)) {
    if (!CLIP_ID_RE.test(String(clipId)) || !entry || typeof entry !== "object") continue;
    const mode = FIT_MODES.has(entry.mode) ? entry.mode : null;
    if (!mode) continue;
    const fit = { mode };
    if (BACKGROUNDS.has(entry.background)) fit.background = entry.background;
    fits[clipId] = fit;
  }
  return fits;
}

/** Normalize a stored (or absent) render block to the full, defaulted shape.
    Absent → defaultRenderBlock(); present → validated + default-filled. PURE
    (no I/O) — the single place a raw render field becomes a trusted one. */
export function normalizeRenderBlock(raw) {
  if (!raw || typeof raw !== "object") return defaultRenderBlock();
  return {
    canvas: normalizeCanvasBlock(raw.canvas),
    default_fit: FIT_MODES.has(raw.default_fit) ? raw.default_fit : DEFAULT_FIT,
    fits: normalizeFits(raw.fits),
  };
}

/** The project's render block, default-filled (never null for a live project).
    A schema-1/no-render-block project returns the lossless default. */
export async function getRenderBlock(projectId) {
  const meta = await getProject(projectId);
  if (!meta) return null;
  return normalizeRenderBlock(meta.render);
}

/** The effective per-clip fit for a clip: its sparse override, else the
    project default + the canvas background. Pure helper for the resolver /
    tierCheck / UI. `render` is a NORMALIZED block. */
export function effectiveFit(render, clipId) {
  const r = render || defaultRenderBlock();
  const override = r.fits && r.fits[clipId];
  if (override) {
    return {
      mode: override.mode,
      background: override.background || (r.canvas && r.canvas.background) || DEFAULT_BACKGROUND,
    };
  }
  return {
    mode: r.default_fit || DEFAULT_FIT,
    background: (r.canvas && r.canvas.background) || DEFAULT_BACKGROUND,
  };
}

/* Read-modify-write the render block atomically, bumping schema to 2. The
   one writer of meta.json, so this is race-free against other meta writes for
   a project (the caller serializes its own ops — banked #6). */
async function mutateRender(projectId, mutate) {
  if (!PROJECT_ID_RE.test(String(projectId))) throw new Error("Bad project id");
  const dir = await projectDir(projectId);
  const meta = await readJSON(dir, "meta.json");
  if (!meta || meta.id !== projectId) throw new Error("project not found");
  const render = normalizeRenderBlock(meta.render);
  const next = mutate(render) || render;
  meta.render = next;
  meta.schema = META_SCHEMA;
  meta.updated_at = nowIso();
  await writeJSONAtomic(dir, "meta.json", meta);
  return next;
}

/**
 * Set the output canvas (arch §2.1 / §3.1). Accepts a canvas SPEC and resolves
 * it against the live clips so the RESOLVED width/height/fps are persisted (the
 * engine never re-derives them). Spec forms:
 *   {mode:"preset", preset, fps?, background?}
 *   {mode:"match_primary", primary_clip_id?, fps?, background?}
 *   {mode:"custom", width, height, fps?, background?}   (DEFERRED — resolved defensively)
 * Returns {render, canvas} where `canvas` is the resolved block.
 */
export async function setCanvas(projectId, spec = {}) {
  const clips = await listClipMetas(projectId);
  const resolved = resolveCanvas({ canvas: spec }, clips);   // even dims, capped fps, valid bg
  const canvas = {
    mode: resolved.mode,
    width: resolved.width,
    height: resolved.height,
    fps: resolved.fps,
    background: resolved.background,
  };
  if (resolved.mode === "preset") canvas.preset = resolved.preset;
  if (resolved.mode === "match_primary") canvas.primary_clip_id = resolved.primary_clip_id || null;
  const render = await mutateRender(projectId, (r) => { r.canvas = canvas; return r; });
  return { render, canvas: { ...canvas }, advisory: resolved.advisory };
}

/** Set the project-wide default per-clip fit ("contain"|"cover"). */
export async function setDefaultFit(projectId, fit) {
  if (!FIT_MODES.has(fit)) throw new Error("fit must be \"contain\" or \"cover\"");
  return mutateRender(projectId, (r) => { r.default_fit = fit; return r; });
}

/**
 * Set (or clear) a per-clip fit override (arch §2.1, SPARSE). A fit equal to
 * the project default with the default background is written AS the override
 * (so the UI/agent can pin it); pass {clear:true} to remove the override and
 * fall back to the default. Returns the updated render block.
 */
export async function setClipFit(projectId, clipId, { mode, background, clear = false } = {}) {
  if (!CLIP_ID_RE.test(String(clipId))) throw new Error("Bad clip id");
  if (!clear && !FIT_MODES.has(mode)) throw new Error("fit mode must be \"contain\" or \"cover\"");
  if (!clear && background != null && !BACKGROUNDS.has(background)) {
    throw new Error("background must be \"blur\" or \"black\"");
  }
  return mutateRender(projectId, (r) => {
    if (clear) {
      delete r.fits[clipId];
      return r;
    }
    const fit = { mode };
    if (BACKGROUNDS.has(background)) fit.background = background;
    r.fits[clipId] = fit;
    return r;
  });
}

/* ----- clip metadata ------------------------------------------------------------ */

/** Write one clip's probe metadata (clipmeta/<clip_id>.json, atomic).
    `meta.clip_id` is required and validated — it names the file. */
export async function writeClipMeta(projectId, meta) {
  if (!meta || !CLIP_ID_RE.test(String(meta.clip_id))) {
    throw new Error("Bad clip id");
  }
  const dir = await projectSubDir(projectId, "clipmeta", { create: true });
  await writeJSONAtomic(dir, meta.clip_id + ".json", meta);
}

/** Read one clip's metadata. Returns null when missing/torn. */
export async function readClipMeta(projectId, clipId) {
  if (!CLIP_ID_RE.test(String(clipId))) return null;
  try {
    const dir = await projectSubDir(projectId, "clipmeta");
    const meta = await readJSON(dir, clipId + ".json");
    return (meta && meta.clip_id === clipId) ? meta : null;
  } catch {
    return null;
  }
}

/** All clip metadata of a project (unparseable entries skipped). Feeds the
    get_inventory executor (Step 5) and the editor clip strip. */
export async function listClipMetas(projectId) {
  const out = [];
  try {
    const dir = await projectSubDir(projectId, "clipmeta");
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && name.endsWith(".json")) names.push(name);
    }
    for (const name of names) {
      const meta = await readJSON(dir, name);
      if (meta && CLIP_ID_RE.test(String(meta.clip_id))) out.push(meta);
    }
  } catch { /* no clipmeta dir yet */ }
  out.sort((a, b) => String(a.ingested_at || "").localeCompare(String(b.ingested_at || "")));
  return out;
}
