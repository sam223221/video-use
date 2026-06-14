/* =============================================================================
   store/music.js — the per-project MUSIC TRACK store (arch §2.2).
   -----------------------------------------------------------------------------
   The ONLY writer of music/ + trkmeta/ (one writer per file — arch §1.4).
   Durable, device-side-only audio tracks: a user upload OR a copy of a bundled
   royalty-free library track, stored as ORIGINAL bytes in OPFS. Music NEVER
   transits the relay (arch §9) — these bytes are mixed locally at render time.

   Layout (per project, arch §2.2):
     projects/prj_<hex12>/
       music/
         trk_<hex8>.<ext>        ORIGINAL track bytes (audio-only)
         trkmeta/
           trk_<hex8>.json       {schema:1, track_id, source, library_id?,
                                  original_name, title?, artist?, license?,
                                  duration_s, codec, channels, sampleRate,
                                  size_bytes, ext, imported_at}

   This module owns the CRUD + metadata only. The render engine (Step 2) reads a
   track's File back via `readTrackFile`; probe/normalize-on-import is the
   ingest caller's concern (Step 5), not this store's — here a caller hands us
   already-validated bytes + a probed-metadata bundle and we persist them
   atomically. Mirrors store/meta.js: atomic whole-document writes, tolerant
   reads (null/skip, never throw), ids validated before any filesystem touch.

   Pure persistence: OPFS only — NO media parsing, NO DOM, NO fetch.
============================================================================= */

import {
  PROJECT_ID_RE, projectDir, projectSubDir,
  readJSON, writeJSONAtomic,
} from "./opfs.js";

/* trk_ + 8 hex (mirrors clip_/prj_ — arch §2.2). */
export const TRACK_ID_RE = /^trk_[0-9a-f]{8}$/;
const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;  // bundled-catalog id allowlist (arch §9)
const NAME_MAX = 120;
const EXT_RE = /^[a-z0-9]{1,5}$/;                    // sanitized container extension

const MUSIC_DIR = "music";
const TRKMETA_DIR = "trkmeta";

function nowIso() { return new Date().toISOString(); }

function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A fresh track id (trk_ + 8 hex). */
export function newTrackId() { return "trk_" + randHex(4); }

/* ----- directory helpers ------------------------------------------------------- */

/** The project's music/ dir handle (created on demand by the first writer). */
async function musicDir(projectId, { create = false } = {}) {
  return projectSubDir(projectId, MUSIC_DIR, { create });
}

/** The project's music/trkmeta/ dir handle. */
async function trkmetaDir(projectId, { create = false } = {}) {
  const music = await musicDir(projectId, { create });
  return music.getDirectoryHandle(TRKMETA_DIR, { create });
}

/* ----- validation -------------------------------------------------------------- */

function sanitizeExt(ext) {
  const e = String(ext == null ? "" : ext).toLowerCase().replace(/^\./, "");
  return EXT_RE.test(e) ? e : "m4a";
}

function clampName(s) {
  return String(s == null ? "" : s).trim().slice(0, NAME_MAX);
}

function finiteOrNull(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/* Build the canonical trkmeta document from a probed-metadata bundle. The same
   normalizer drives write AND read (defense in depth, mirroring transcripts.js):
   a malformed/foreign doc reads back as null and never reaches a consumer. */
function normalizeTrkMeta(trackId, src) {
  if (!TRACK_ID_RE.test(String(trackId))) return null;
  if (!src || typeof src !== "object") return null;
  if (src.track_id != null && src.track_id !== trackId) return null;  // can't describe another track
  const source = src.source === "library" ? "library" : "upload";
  const doc = {
    schema: 1,
    track_id: trackId,
    source,
    original_name: clampName(src.original_name),
    title: src.title != null ? clampName(src.title) : undefined,
    artist: src.artist != null ? clampName(src.artist) : undefined,
    license: src.license != null ? clampName(src.license) : undefined,
    duration_s: finiteOrNull(src.duration_s),
    codec: src.codec != null ? String(src.codec).slice(0, 40) : null,
    channels: finiteOrNull(src.channels),
    sampleRate: finiteOrNull(src.sampleRate),
    size_bytes: finiteOrNull(src.size_bytes),
    ext: sanitizeExt(src.ext),
    imported_at: typeof src.imported_at === "string" ? src.imported_at : nowIso(),
  };
  if (source === "library") {
    if (!LIBRARY_ID_RE.test(String(src.library_id || ""))) return null;  // library tracks MUST record their id
    doc.library_id = String(src.library_id);
  }
  // Drop undefined optionals so the persisted JSON stays tidy.
  for (const k of ["title", "artist", "license"]) {
    if (doc[k] === undefined || doc[k] === "") delete doc[k];
  }
  return doc;
}

/* ----- writes ------------------------------------------------------------------ */

/**
 * Persist a user-uploaded track: write the ORIGINAL bytes to
 * music/trk_<id>.<ext> then the trkmeta JSON atomically. The CALLER has
 * already probed + size/duration-capped + (per arch §9) normalized the bytes;
 * this store does not parse media.
 *
 * @param {string} projectId
 * @param {Blob}   bytes      the track's audio bytes (audio-only).
 * @param {Object} meta       probed metadata: {original_name, title?, artist?,
 *                            license?, duration_s, codec, channels, sampleRate,
 *                            ext, size_bytes?}.
 * @returns {Promise<Object>} the persisted trkmeta document (with `track_id`).
 */
export async function importTrack(projectId, bytes, meta = {}) {
  if (!PROJECT_ID_RE.test(String(projectId))) throw new Error("Bad project id");
  const isBlob = typeof Blob !== "undefined" && bytes instanceof Blob;
  if (!isBlob) throw new Error("track bytes (Blob) are required");
  const trackId = newTrackId();
  const ext = sanitizeExt(meta.ext);
  const doc = normalizeTrkMeta(trackId, {
    ...meta,
    source: "upload",
    ext,
    size_bytes: meta.size_bytes != null ? meta.size_bytes : bytes.size,
    imported_at: nowIso(),
  });
  if (!doc) throw new Error("invalid track metadata");
  await writeTrackBytes(projectId, trackId, ext, bytes);
  await writeTrkMetaDoc(projectId, doc);
  return doc;
}

/**
 * Copy a bundled LIBRARY track's bytes into this project's music/ on first use
 * (the "copy into OPFS immediately" rule — a library track is a pre-vetted
 * local source, arch §2.2). Records source:"library", library_id and license.
 *
 * @param {string} projectId
 * @param {string} libraryId   the bundled-catalog id (allowlist-checked here +
 *                             at the relay, arch §9).
 * @param {Blob}   bytes       the bundled track bytes (the CALLER fetched them
 *                             from the static catalog — never an arbitrary URL).
 * @param {Object} catalogEntry {original_name?, title?, artist?, license,
 *                             duration_s, codec, channels, sampleRate, ext}.
 * @returns {Promise<Object>} the persisted trkmeta document.
 */
export async function copyLibraryTrack(projectId, libraryId, bytes, catalogEntry = {}) {
  if (!PROJECT_ID_RE.test(String(projectId))) throw new Error("Bad project id");
  if (!LIBRARY_ID_RE.test(String(libraryId))) throw new Error("Bad library id");
  const isBlob = typeof Blob !== "undefined" && bytes instanceof Blob;
  if (!isBlob) throw new Error("library track bytes (Blob) are required");
  const trackId = newTrackId();
  const ext = sanitizeExt(catalogEntry.ext);
  const doc = normalizeTrkMeta(trackId, {
    ...catalogEntry,
    source: "library",
    library_id: libraryId,
    original_name: catalogEntry.original_name || catalogEntry.title || libraryId,
    ext,
    size_bytes: catalogEntry.size_bytes != null ? catalogEntry.size_bytes : bytes.size,
    imported_at: nowIso(),
  });
  if (!doc) throw new Error("invalid library catalog entry");
  await writeTrackBytes(projectId, trackId, ext, bytes);
  await writeTrkMetaDoc(projectId, doc);
  return doc;
}

/* Write the original track bytes (streamed, never buffered whole in JS heap
   beyond the source Blob — device RAM is the constraint). The bytes file is
   written then the trkmeta is written; a crash between the two leaves an
   orphan bytes file with no trkmeta — `listTracks` only lists tracks WITH a
   readable trkmeta, so an orphan is invisible (and reclaimable by a future
   sweep), never a half-track. */
async function writeTrackBytes(projectId, trackId, ext, bytes) {
  const dir = await musicDir(projectId, { create: true });
  const handle = await dir.getFileHandle(trackId + "." + ext, { create: true });
  const writable = await handle.createWritable();
  try {
    await bytes.stream().pipeTo(writable);   // pipeTo closes (commits) on success
  } catch (err) {
    try { await writable.abort(); } catch { /* already dead */ }
    try { await dir.removeEntry(trackId + "." + ext); } catch { /* never existed */ }
    throw err;
  }
}

async function writeTrkMetaDoc(projectId, doc) {
  const dir = await trkmetaDir(projectId, { create: true });
  await writeJSONAtomic(dir, doc.track_id + ".json", doc);
}

/* ----- reads ------------------------------------------------------------------- */

/** Read one track's metadata. Returns null when missing/torn/foreign. */
export async function readTrackMeta(projectId, trackId) {
  if (!TRACK_ID_RE.test(String(trackId))) return null;
  try {
    const dir = await trkmetaDir(projectId);
    const raw = await readJSON(dir, trackId + ".json");
    return normalizeTrkMeta(trackId, raw);   // re-validate on read (defense in depth)
  } catch {
    return null;
  }
}

/** Read one track's ORIGINAL bytes back as a File (for the render mixer, Step
    2). Returns null when the track or its bytes are missing. The extension
    comes from the trkmeta so we open the right file. */
export async function readTrackFile(projectId, trackId) {
  const meta = await readTrackMeta(projectId, trackId);
  if (!meta) return null;
  try {
    const dir = await musicDir(projectId);
    const handle = await dir.getFileHandle(meta.track_id + "." + meta.ext, { create: false });
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** Every track of a project, oldest-imported first (skips unreadable entries).
    Feeds the get_inventory executor + the Music panel browser. */
export async function listTracks(projectId) {
  const out = [];
  try {
    const dir = await trkmetaDir(projectId);
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && name.endsWith(".json")) names.push(name);
    }
    for (const name of names) {
      const id = name.slice(0, -5);
      const meta = await readTrackMeta(projectId, id);
      if (meta) out.push(meta);
    }
  } catch { /* no trkmeta dir yet */ }
  out.sort((a, b) => String(a.imported_at || "").localeCompare(String(b.imported_at || "")));
  return out;
}

/** True iff a track with this id has a readable trkmeta. */
export async function hasTrack(projectId, trackId) {
  return (await readTrackMeta(projectId, trackId)) != null;
}

/* ----- delete ------------------------------------------------------------------ */

/** Permanently delete a track (bytes + trkmeta). Best-effort: a missing entry
    is not an error. The CALLER is responsible for any edl.js remove_music ops
    that reference it (a placement of a deleted track folds as a notice, never a
    crash — arch §2.2). Returns true if the trkmeta existed. */
export async function deleteTrack(projectId, trackId) {
  if (!TRACK_ID_RE.test(String(trackId))) return false;
  const meta = await readTrackMeta(projectId, trackId);
  if (!meta) return false;
  try {
    const music = await musicDir(projectId);
    try { await music.removeEntry(meta.track_id + "." + meta.ext); } catch { /* bytes already gone */ }
    try {
      const tm = await music.getDirectoryHandle(TRKMETA_DIR, { create: false });
      await tm.removeEntry(meta.track_id + ".json");
    } catch { /* trkmeta already gone */ }
    return true;
  } catch {
    return false;
  }
}
