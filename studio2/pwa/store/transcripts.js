/* =============================================================================
   store/transcripts.js — per-clip transcript persistence (arch §4, M2).
   -----------------------------------------------------------------------------
   The ONLY writer of transcripts/ (arch §1.4, one-writer-per-file). A clip's
   word-timestamped transcript lives at:

       projects/prj_<hex12>/transcripts/clip_<hex8>.json

   produced by the relay's normalizer, schema-validated and written by the
   device. OPFS stays the single source of truth — the durable transcript
   lives ONLY on the device; the relay forgets (arch §1.3, §3.2).

   Schema (arch §4.2) — compact, source-clip times:
     {
       schema: 1,
       clip_id: "clip_a1b2c3d4",          // == the filename's id (validated)
       provider: "elevenlabs.scribe_v2",  // provider.model_id audit trail
       transcribed_at: "2026-06-13T09:41:00Z",
       language_code: "fo",               // EL-detected or pinned
       language_probability: 0.93,        // EL confidence 0..1
       audio_duration_s: 1846.2,          // the declared duration
       text: "the full plain text…",      // EL's joined text, verbatim
       words: [ {w,s,e,c?} ],             // type:"word" only; s/e 2dp source
       audio_events: [ {label,s,e} ]      // optional; may be []
     }
   `c` (= exp(logprob), 0..1) is OMITTED when EL gave no confidence. All times
   are SOURCE-clip seconds rounded to 2 decimals — the same clock the EDL keep-
   list uses, so transcript ↔ EDL ↔ preview ↔ export never disagree (arch
   §4.2 invariant; stated in store/DOCUMENT.md too).

   Mechanics (each a hard contract):
   • ATOMIC WRITE via opfs.writeJSONAtomic (createWritable + close = OPFS
     swap-on-close; the visible file is the old or the new doc, never torn).
     "Redo transcription" overwrites the same name atomically.
   • SCHEMA-VALIDATED ON WRITE AND READ (defense in depth, arch §4.2): write
     rejects a malformed/oversized doc loudly (throws); read of a torn/foreign/
     malformed file returns null and NEVER throws (mirrors opfs.readJSON +
     meta.readClipMeta — a crash can tear at most one document, the UI must
     keep listing the rest). A file whose embedded clip_id ≠ the filename's id
     reads as null (a transcript can't describe another clip).
   • EXISTENCE IS DERIVED by listing the directory (clipmeta is NOT touched —
     one-writer-per-file holds; arch §4.1).
   • WINDOW-SINGLETON CACHE on window.__studio2Transcripts (the documented
     double-load wart — store modules load under ?v= AND bare URLs; two module
     instances MUST share one cache, exactly like edl.js / __studio2Edl). The
     cache memoizes validated docs per (projectId, clipId); writes/deletes keep
     it coherent; invalidate() drops it after an out-of-band change.

   Pure persistence (arch §1.4): OPFS only — NO media parsing, NO DOM, NO fetch.
============================================================================= */

import {
  PROJECT_ID_RE, CLIP_ID_RE,
  projectSubDir, readJSON, writeJSONAtomic,
} from "./opfs.js";

const TRANSCRIPTS_DIR = "transcripts";
const SCHEMA = 1;

/* Hard ceilings — a transcript is the user's recorded speech, not unbounded
   input. A 30-min clip is ~4,500 words / ~200 KB (arch §4.2); these bound a
   pathological/torn doc without rejecting any legitimate one. */
const MAX_WORDS = 2_000_000;        // ~7+ days of continuous speech
const MAX_AUDIO_EVENTS = 200_000;
const MAX_TEXT_CHARS = 8_000_000;   // generous vs ~25 KB/min of plain text

function round2(n) { return Math.round(n * 100) / 100; }

function dlog(level, msg, data) {
  try {
    const d = typeof window !== "undefined" && window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* diagnostics never break the store */ }
}

/* ----- singleton cache (shared across module instances) ----------------------- */

function registry() {
  const g = typeof window !== "undefined" ? window : globalThis;
  if (!g.__studio2Transcripts) g.__studio2Transcripts = { docs: new Map() };
  return g.__studio2Transcripts;
}

function cacheKey(projectId, clipId) { return projectId + "/" + clipId; }

function cacheGet(projectId, clipId) {
  const reg = registry();
  return reg.docs.has(cacheKey(projectId, clipId))
    ? reg.docs.get(cacheKey(projectId, clipId))
    : undefined; // undefined = unknown; null = known-absent; object = present
}

function cacheSet(projectId, clipId, doc) {
  registry().docs.set(cacheKey(projectId, clipId), doc);
}

function cacheDrop(projectId, clipId) {
  registry().docs.delete(cacheKey(projectId, clipId));
}

/* ----- schema validation + normalization -------------------------------------- */

function isFiniteNonNeg(n) { return typeof n === "number" && Number.isFinite(n) && n >= 0; }

/* Validate + NORMALIZE a transcript doc against the §4.2 schema for the given
   clip. Returns a clean, canonical copy (own keys only, times re-rounded to
   2dp, `c` dropped when absent/out-of-range) — or null when anything is wrong.
   Never throws; the boolean intent is "is this a usable transcript for THIS
   clip". One implementation drives both the write guard and the read guard. */
function normalizeDoc(doc, clipId) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.schema !== SCHEMA) return null;
  if (!CLIP_ID_RE.test(String(doc.clip_id))) return null;
  if (doc.clip_id !== clipId) return null;           // can't describe another clip
  if (typeof doc.provider !== "string" || doc.provider.length === 0 || doc.provider.length > 120) return null;
  if (typeof doc.transcribed_at !== "string" || doc.transcribed_at.length > 40) return null;
  if (typeof doc.language_code !== "string" || doc.language_code.length > 16) return null;
  if (typeof doc.text !== "string" || doc.text.length > MAX_TEXT_CHARS) return null;
  if (!isFiniteNonNeg(doc.audio_duration_s)) return null;

  // language_probability: optional-ish; EL always gives one, but tolerate a
  // missing/odd value by clamping rather than rejecting the whole transcript.
  let langProb = null;
  if (typeof doc.language_probability === "number" && Number.isFinite(doc.language_probability)) {
    langProb = Math.min(1, Math.max(0, doc.language_probability));
  }

  if (!Array.isArray(doc.words) || doc.words.length > MAX_WORDS) return null;
  const words = [];
  for (const raw of doc.words) {
    if (!raw || typeof raw !== "object") return null;       // a torn word ⇒ torn doc
    if (typeof raw.w !== "string") return null;
    if (!isFiniteNonNeg(raw.s) || !isFiniteNonNeg(raw.e)) return null;
    if (raw.e < raw.s) return null;
    const word = { w: raw.w, s: round2(raw.s), e: round2(raw.e) };
    if (typeof raw.c === "number" && Number.isFinite(raw.c) && raw.c >= 0 && raw.c <= 1) {
      word.c = Math.round(raw.c * 1000) / 1000; // 3dp confidence; omitted when absent
    }
    words.push(word);
  }

  // audio_events optional → default []; reject a present-but-malformed array.
  let events = [];
  if (doc.audio_events != null) {
    if (!Array.isArray(doc.audio_events) || doc.audio_events.length > MAX_AUDIO_EVENTS) return null;
    for (const raw of doc.audio_events) {
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.label !== "string") return null;
      if (!isFiniteNonNeg(raw.s) || !isFiniteNonNeg(raw.e)) return null;
      if (raw.e < raw.s) return null;
      events.push({ label: raw.label, s: round2(raw.s), e: round2(raw.e) });
    }
  }

  const clean = {
    schema: SCHEMA,
    clip_id: clipId,
    provider: doc.provider,
    transcribed_at: doc.transcribed_at,
    language_code: doc.language_code,
    audio_duration_s: round2(doc.audio_duration_s),
    text: doc.text,
    words,
    audio_events: events,
  };
  if (langProb !== null) clean.language_probability = langProb;
  return clean;
}

/* ----- public API ------------------------------------------------------------- */

/** Write (or overwrite) a clip's transcript, atomically. Schema-validates +
    normalizes first; a malformed doc or a clip_id mismatch THROWS (the caller
    must never persist garbage — arch §7.1 step 8). Returns the canonical doc
    that was written (handy for the caller to cache/render without a re-read). */
export async function writeTranscript(projectId, clipId, doc) {
  if (!CLIP_ID_RE.test(String(clipId))) throw new Error("Bad clip id");
  const clean = normalizeDoc(doc, clipId);
  if (!clean) throw new Error("transcript failed schema validation for " + clipId);
  const dir = await projectSubDir(projectId, TRANSCRIPTS_DIR, { create: true });
  await writeJSONAtomic(dir, clipId + ".json", clean);  // OPFS swap-on-close
  cacheSet(projectId, clipId, clean);
  return clean;
}

/** Read a clip's transcript. Returns the canonical doc, or null when missing,
    torn, malformed, or describing a different clip. NEVER throws (mirrors
    opfs.readJSON / meta.readClipMeta). Cached on the window singleton. */
export async function readTranscript(projectId, clipId) {
  if (!CLIP_ID_RE.test(String(clipId))) return null;
  const cached = cacheGet(projectId, clipId);
  if (cached !== undefined) return cached;            // null or doc, both cached
  let doc = null;
  try {
    const dir = await projectSubDir(projectId, TRANSCRIPTS_DIR);
    const raw = await readJSON(dir, clipId + ".json"); // null on missing/torn
    doc = normalizeDoc(raw, clipId);                   // null on schema fail
    if (raw && !doc) {
      dlog("warn", "transcripts.read.invalid", { project_id: projectId, clip_id: clipId });
    }
  } catch {
    doc = null;                                        // no transcripts/ dir yet
  }
  cacheSet(projectId, clipId, doc);
  return doc;
}

/** True iff a VALID transcript exists for the clip (a torn/foreign file counts
    as absent). Cheap — reuses the cached read. */
export async function hasTranscript(projectId, clipId) {
  return (await readTranscript(projectId, clipId)) !== null;
}

/** The clip ids that have a transcript file, in sorted order. Derived purely
    by listing transcripts/ (existence is the directory's truth — clipmeta is
    not consulted). A torn file still LISTS here (its name is valid) so the UI
    can surface/repair it; callers that need the content use readTranscript,
    which validates. Never throws. */
export async function listTranscriptClipIds(projectId) {
  const ids = [];
  try {
    const dir = await projectSubDir(projectId, TRANSCRIPTS_DIR);
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const id = name.slice(0, -5);                    // strip ".json"
      if (CLIP_ID_RE.test(id)) ids.push(id);
    }
  } catch { /* no transcripts/ dir yet */ }
  ids.sort();
  return ids;
}

/** Delete a clip's transcript (best-effort). Called when a clip is removed and
    on the degraded re-pick REPLACE path (arch §1.2, §10.7 — a transcript of
    the OLD audio must not survive the swap; ingest.js owns that wiring in T4).
    Returns true if a file was removed, false if there was none. Never throws.*/
export async function deleteTranscript(projectId, clipId) {
  if (!CLIP_ID_RE.test(String(clipId))) return false;
  let removed = false;
  try {
    const dir = await projectSubDir(projectId, TRANSCRIPTS_DIR);
    await dir.removeEntry(clipId + ".json");
    removed = true;
  } catch { /* already gone / no dir — best-effort */ }
  cacheSet(projectId, clipId, null);                   // known-absent now
  return removed;
}

/** Drop the in-memory cache for one clip, one project, or everything. Needed
    after a project delete or any out-of-band change to transcripts/ — the next
    read re-validates from disk. Mirrors edl.invalidate(). */
export function invalidate(projectId, clipId) {
  const reg = registry();
  if (projectId == null) { reg.docs.clear(); return; }
  if (clipId != null) { cacheDrop(projectId, clipId); return; }
  const prefix = projectId + "/";
  for (const key of [...reg.docs.keys()]) {
    if (key.startsWith(prefix)) reg.docs.delete(key);
  }
}
