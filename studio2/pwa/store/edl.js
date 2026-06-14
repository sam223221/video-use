/* =============================================================================
   store/edl.js — the EDL journal (arch §5.2). The ONLY writer of edl.jsonl.
   -----------------------------------------------------------------------------
   One JSON object per line, APPEND-ONLY: ops are never edited or removed;
   undo is itself an op. Crash-safe by construction — iOS memory kills are
   uncatchable, so the journal IS the recovery mechanism: state is whatever
   folds from the lines that parse.

   Ops (M1):
     {"seq":1,"ts":…,"op":"init","schema":1,"project_id":"prj_…"}
     {"seq":2,"ts":…,"op":"add_clip","clip_id":"clip_a1b2c3d4"}
     {"seq":3,"ts":…,"op":"apply_cuts","clip_id":…,"command_id":"cmd_…",
      "snap":"remove","cuts":[{"requested":{start_s,end_s},"snapped":{start_s,end_s}}]}
     {"seq":4,"ts":…,"op":"remove_clip","clip_id":…}
     {"seq":5,"ts":…,"op":"undo","of_seq":3,"command_id":"cmd_…"}
   UI-driven edits use the same ops without command_id.

   Ops (M3 — music; arch §2.2). Music placement IS timeline edit data (append-
   only, undoable, command_id-idempotent — the same machinery), so it lives in
   THIS journal, not a separate file:
     {"seq":7,"ts":…,"op":"add_music","command_id":"cmd_…","track_id":"trk_…",
      "placement":{at_s,duration_s|null,track_offset_s,gain_db,fade_in_s,
                   fade_out_s,duck:{enabled,under,amount_db,attack_s,release_s}}}
     {"seq":8,"ts":…,"op":"update_music","music_seq":7,"placement":{…partial…}}
     {"seq":9,"ts":…,"op":"remove_music","music_seq":7}
     {"seq":10,"ts":…,"op":"undo","of_seq":7}        ← existing undo covers music
   `add_music` introduces music_seq = its own seq — the stable handle
   update_music/remove_music target (parallel to undo's of_seq). at_s is on the
   COMPOSED (post-cut) output timeline; the fold clamps/drops placements past
   the timeline end (a notice, never a crash).

   Mechanics (each is a hard contract):
   • LAZY INIT — createProject() deliberately does not write the journal;
     the `init` op is appended on the first edl.js call for a project
     (one-writer-per-file, see store/DOCUMENT.md).
   • APPEND = read-modify-write via createWritable({keepExistingData:true})
     + ONE positioned write at the end of the last GOOD line + truncate +
     close() (OPFS swap-on-close = atomic commit: the visible file is either
     the old or the new journal, never a torn middle). The write payload
     passes the view-normalization helper (banked #1 — cheap insurance even
     for fresh buffers).
   • TORN-TAIL TOLERANCE — a final line that fails JSON.parse (crash
     mid-append by an OLDER build, or external tampering) is dropped at load
     with a logged notice; the NEXT append overwrites it (writes at the end
     of the last good line and truncates), healing the file. Mid-file
     garbage is skipped with a notice, never silently.
   • IDEMPOTENCY — before appending an op carrying command_id, the journal
     is consulted; a known id returns the ORIGINAL op's outcome without
     appending (bridge replay safety, arch §3.6).
   • FOLD CACHE — the folded keep-list is cached in memory per open project
     and invalidated on append; the journal is read once per project open.
   • SINGLETON STATE — cache + per-project append mutex live on
     window.__studio2Edl, because store modules can load under two URLs
     (?v= and bare — the documented double-load wart); two module instances
     MUST share one writer chain.

   Fold (arch §5.2): replay ops in seq order. add_clip appends one full-range
   segment {clip_id, 0, duration(clipmeta)}. apply_cuts subtracts each
   SNAPPED range from that clip's segments (splitting as needed). remove_clip
   drops the clip's segments. undo {of_seq} marks the target op inert and the
   fold recomputes. Result: segments[] in timeline order — the multi-segment
   keep-list that player.js previews and cut.js exports.
============================================================================= */

import { PROJECT_ID_RE, CLIP_ID_RE, projectDir } from "./opfs.js";
import { readClipMeta } from "./meta.js";
import { normalizeBufferSource, engineError } from "../engine/writers.js";

const JOURNAL_NAME = "edl.jsonl";
const COMMAND_ID_RE = /^cmd_[0-9a-f]{12}$/;
const TRACK_ID_RE = /^trk_[0-9a-f]{8}$/;   // music track ids (mirrors store/music.js)
const MAX_CUTS = 50;            // relay caps at 50 (arch §4); device re-validates
const EPS = 1e-6;

/* Music placement numeric bounds (arch §7.1/§9 — device re-validates the
   relay's caps). A placement that survives normalization is always safe to
   fold + mix. */
const GAIN_DB_MIN = -60, GAIN_DB_MAX = 6;
const FADE_S_MIN = 0, FADE_S_MAX = 10;
const DUCK_DB_MIN = -60, DUCK_DB_MAX = 0;
const DUCK_TIME_MIN = 0, DUCK_TIME_MAX = 5;

function nowIso() { return new Date().toISOString(); }
function round2(n) { return Math.round(n * 100) / 100; }

function dlog(level, msg, data) {
  try {
    const d = typeof window !== "undefined" && window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* diagnostics never break the journal */ }
}

/* ----- singleton registry (shared across module instances) -------------------- */

function registry() {
  const g = typeof window !== "undefined" ? window : globalThis;
  if (!g.__studio2Edl) g.__studio2Edl = { projects: new Map() };
  return g.__studio2Edl;
}

function projectEntry(projectId) {
  const reg = registry();
  let entry = reg.projects.get(projectId);
  if (!entry) {
    entry = { chain: Promise.resolve(), loaded: null };
    reg.projects.set(projectId, entry);
  }
  return entry;
}

/** Serialize every journal operation per project: one writer, one reader at
    a time, across BOTH possible module instances. */
function withProject(projectId, fn) {
  if (!PROJECT_ID_RE.test(String(projectId))) {
    return Promise.reject(engineError("Bad project id"));
  }
  const entry = projectEntry(projectId);
  const run = entry.chain.then(() => fn(entry));
  entry.chain = run.then(() => undefined, () => undefined); // failures never wedge the chain
  return run;
}

/* ----- load + lazy init -------------------------------------------------------- */

const encoder = new TextEncoder();

/* Parse the journal text into { ops, lastSeq, goodEnd, endsWithNewline,
   notices, byCommandId }. goodEnd = byte offset just past the last
   PARSEABLE line — the position the next append writes at (a torn tail
   beyond it gets overwritten + truncated away: the heal). */
function parseJournal(text) {
  const ops = [];
  const notices = [];
  const byCommandId = new Map();
  let lastSeq = 0;
  let goodEnd = 0;
  let endsWithNewline = true;
  let pos = 0;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastChunk = i === lines.length - 1;
    if (line === "" && isLastChunk) break; // the trailing-newline empty tail
    const lineBytes = encoder.encode(line).byteLength;
    const hasNewline = !isLastChunk;
    let op = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.op === "string"
        && Number.isFinite(parsed.seq)) {
        op = parsed;
      }
    } catch { /* unparseable line */ }
    if (op) {
      if (lastSeq > 0 && op.seq !== lastSeq + 1) {
        notices.push("journal sequence jumps from " + lastSeq + " to " + op.seq + " — a line was lost");
      }
      ops.push(op);
      lastSeq = Math.max(lastSeq, op.seq);
      if (typeof op.command_id === "string") byCommandId.set(op.command_id, op);
      goodEnd = pos + lineBytes + (hasNewline ? 1 : 0);
      endsWithNewline = hasNewline;
    } else if (isLastChunk) {
      notices.push("dropped a torn final journal line (" + lineBytes + " bytes) — an append was interrupted");
    } else {
      notices.push("skipped an unreadable journal line (line " + (i + 1) + ")");
    }
    pos += lineBytes + (hasNewline ? 1 : 0);
  }
  return { ops, lastSeq, goodEnd, endsWithNewline, notices, byCommandId };
}

async function readJournalText(dir) {
  try {
    const handle = await dir.getFileHandle(JOURNAL_NAME, { create: false });
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null; // no journal yet — lazy init below
  }
}

/* The one physical append. Writes at loaded.goodEnd (overwriting any torn
   tail), truncates to the new end, closes (atomic swap commit), then updates
   the in-memory state + invalidates the fold cache. */
async function appendOp(projectId, loaded, op) {
  const dir = await projectDir(projectId);
  const handle = await dir.getFileHandle(JOURNAL_NAME, { create: true });
  const prefix = loaded.endsWithNewline ? "" : "\n";
  const raw = encoder.encode(prefix + JSON.stringify(op) + "\n");
  const bytes = normalizeBufferSource(raw).bytes; // banked #1 insurance
  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await writable.write({ type: "write", position: loaded.goodEnd, data: bytes });
    await writable.truncate(loaded.goodEnd + bytes.byteLength);
  } catch (err) {
    try { await writable.abort(); } catch { /* already errored */ }
    throw err;
  }
  await writable.close(); // the atomic commit (swap-on-close)
  loaded.goodEnd += bytes.byteLength;
  loaded.endsWithNewline = true;
  loaded.ops.push(op);
  loaded.lastSeq = op.seq;
  if (typeof op.command_id === "string") loaded.byCommandId.set(op.command_id, op);
  loaded.foldDirty = true; // fold cache invalidated on append (arch §5.2)
}

/* Ensure the journal is loaded (and lazily initialized) for this project.
   Returns entry.loaded. */
async function load(projectId, entry) {
  if (entry.loaded) return entry.loaded;
  const dir = await projectDir(projectId); // validates the id, throws if absent
  const text = await readJournalText(dir);
  const parsed = parseJournal(text || "");
  const loaded = {
    ops: parsed.ops,
    lastSeq: parsed.lastSeq,
    goodEnd: parsed.goodEnd,
    endsWithNewline: parsed.endsWithNewline,
    byCommandId: parsed.byCommandId,
    loadNotices: parsed.notices,
    folded: null,
    foldDirty: true,
  };
  for (const n of parsed.notices) dlog("warn", "edl.load.notice", { project_id: projectId, notice: n });
  entry.loaded = loaded;
  if (loaded.ops.length === 0) {
    // Lazy init (the deliberate Step-2 contract): first open writes seq 1.
    await appendOp(projectId, loaded, {
      seq: 1, ts: nowIso(), op: "init", schema: 1, project_id: projectId,
    });
  }
  return loaded;
}

/* ----- fold ---------------------------------------------------------------------- */

/* Subtract [cutStart, cutEnd) from one clip's keep-segments, splitting as
   needed. Sub-microsecond slivers are dropped. */
function subtractRange(segments, clipId, cutStart, cutEnd) {
  const out = [];
  for (const seg of segments) {
    if (seg.clip_id !== clipId || cutEnd <= seg.start_s + EPS || cutStart >= seg.end_s - EPS) {
      out.push(seg);
      continue;
    }
    if (cutStart > seg.start_s + EPS) {
      out.push({ clip_id: clipId, start_s: seg.start_s, end_s: Math.min(cutStart, seg.end_s) });
    }
    if (cutEnd < seg.end_s - EPS) {
      out.push({ clip_id: clipId, start_s: Math.max(cutEnd, seg.start_s), end_s: seg.end_s });
    }
  }
  return out;
}

function clampNum(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** Normalize a raw music placement into the canonical, bounded shape. PURE.
    Out-of-range numbers are CLAMPED (not rejected) so a folded placement is
    always mixable; a malformed-beyond-repair placement returns null and the
    fold drops it with a notice. `partial:true` keeps only the fields present
    (for update_music merges) and skips defaulting. */
function normalizePlacement(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== "object") return partial ? {} : null;
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);

  if (!partial || has("at_s")) out.at_s = Math.max(0, clampNum(raw.at_s, 0, Number.MAX_SAFE_INTEGER, 0));
  if (!partial || has("duration_s")) {
    // null = "under the whole video" (clamped to timeline end at fold time).
    out.duration_s = raw.duration_s == null ? null
      : Math.max(0, clampNum(raw.duration_s, 0, Number.MAX_SAFE_INTEGER, null));
  }
  if (!partial || has("track_offset_s")) {
    out.track_offset_s = Math.max(0, clampNum(raw.track_offset_s, 0, Number.MAX_SAFE_INTEGER, 0));
  }
  if (!partial || has("gain_db")) out.gain_db = clampNum(raw.gain_db, GAIN_DB_MIN, GAIN_DB_MAX, -8);
  if (!partial || has("fade_in_s")) out.fade_in_s = clampNum(raw.fade_in_s, FADE_S_MIN, FADE_S_MAX, 0);
  if (!partial || has("fade_out_s")) out.fade_out_s = clampNum(raw.fade_out_s, FADE_S_MIN, FADE_S_MAX, 0);

  if (!partial || has("duck")) {
    const d = raw.duck;
    if (d == null) {
      out.duck = { enabled: false, under: "speech", amount_db: -12, attack_s: 0.25, release_s: 0.6 };
    } else if (typeof d === "object") {
      out.duck = {
        enabled: !!d.enabled,
        under: d.under === "speech" ? "speech" : "speech",   // only "speech" in M3
        amount_db: clampNum(d.amount_db, DUCK_DB_MIN, DUCK_DB_MAX, -12),
        attack_s: clampNum(d.attack_s, DUCK_TIME_MIN, DUCK_TIME_MAX, 0.25),
        release_s: clampNum(d.release_s, DUCK_TIME_MIN, DUCK_TIME_MAX, 0.6),
      };
    }
  }
  return out;
}

/** PURE fold: replay ops in order against the given clip durations
    ({clip_id: duration_s}). Exported for tests and for callers that hold
    their own op lists. Returns { segments, timeline_duration_s, music,
    notices }. `music` (M3) is the live folded placements, at_s/duration_s
    clamped to the composed timeline. */
export function foldOps(ops, durations = {}) {
  const notices = [];
  const inert = new Set();
  for (const op of ops) {
    if (op.op === "undo" && Number.isFinite(op.of_seq)) inert.add(op.of_seq);
  }
  let segments = [];
  // Music is keyed by its add_music seq (music_seq); update merges, remove drops.
  const musicBySeq = new Map();        // music_seq → { track_id, placement }
  for (const op of ops) {
    if (inert.has(op.seq)) continue;
    switch (op.op) {
      case "init":
        break;
      case "add_clip": {
        const dur = durations[op.clip_id];
        if (typeof dur !== "number" || !(dur > 0)) {
          notices.push("clip " + op.clip_id + " has no readable metadata — left off the timeline");
          break;
        }
        segments.push({ clip_id: op.clip_id, start_s: 0, end_s: dur });
        break;
      }
      case "remove_clip":
        segments = segments.filter((s) => s.clip_id !== op.clip_id);
        break;
      case "apply_cuts": {
        for (const cut of Array.isArray(op.cuts) ? op.cuts : []) {
          const r = cut && cut.snapped;
          if (!r || !Number.isFinite(r.start_s) || !Number.isFinite(r.end_s)) continue;
          segments = subtractRange(segments, op.clip_id, r.start_s, r.end_s);
        }
        break;
      }
      case "add_music": {
        if (!TRACK_ID_RE.test(String(op.track_id))) {
          notices.push("add_music (seq " + op.seq + ") has a bad track id — ignored");
          break;
        }
        const placement = normalizePlacement(op.placement);
        if (!placement) {
          notices.push("add_music (seq " + op.seq + ") has a malformed placement — ignored");
          break;
        }
        musicBySeq.set(op.seq, { music_seq: op.seq, track_id: op.track_id, placement });
        break;
      }
      case "update_music": {
        const target = musicBySeq.get(op.music_seq);
        if (!target) {
          notices.push("update_music (seq " + op.seq + ") points at unknown/removed music " + op.music_seq);
          break;
        }
        const patch = normalizePlacement(op.placement, { partial: true });
        target.placement = { ...target.placement, ...patch };
        break;
      }
      case "remove_music": {
        if (!musicBySeq.delete(op.music_seq)) {
          notices.push("remove_music (seq " + op.seq + ") points at unknown/removed music " + op.music_seq);
        }
        break;
      }
      case "undo":
        if (!ops.some((o) => o.seq === op.of_seq)) {
          notices.push("undo (seq " + op.seq + ") points at unknown op " + op.of_seq);
        }
        break;
      default:
        // Forward compatibility: a future op type folds as a no-op, visibly.
        notices.push("unknown op '" + op.op + "' (seq " + op.seq + ") ignored");
    }
  }
  const timeline = round2(segments.reduce((acc, s) => acc + (s.end_s - s.start_s), 0));

  // Fold music onto the COMPOSED timeline: flatten {music_seq, track_id, …
  // placement fields} (arch §2.3), clamp at_s/duration_s to the timeline end,
  // drop placements that start at/after the end (a notice, never a crash).
  const music = [];
  for (const m of [...musicBySeq.values()].sort((a, b) => a.music_seq - b.music_seq)) {
    const p = m.placement;
    if (p.at_s >= timeline - EPS) {
      notices.push("music (seq " + m.music_seq + ") starts past the end of the video — left off");
      continue;
    }
    const room = timeline - p.at_s;
    const duration_s = p.duration_s == null ? round2(room) : round2(Math.min(p.duration_s, room));
    music.push({
      music_seq: m.music_seq,
      track_id: m.track_id,
      at_s: round2(p.at_s),
      duration_s,
      track_offset_s: round2(p.track_offset_s),
      gain_db: p.gain_db,
      fade_in_s: p.fade_in_s,
      fade_out_s: p.fade_out_s,
      duck: { ...p.duck },
    });
  }

  return {
    segments,
    timeline_duration_s: timeline,
    music,
    notices,
  };
}

/* Fold with the cache: clip durations come from clipmeta (store/meta.js is
   their only writer). Recomputed only when an append dirtied the cache. */
async function foldLoaded(projectId, loaded) {
  if (!loaded.foldDirty && loaded.folded) return loaded.folded;
  const durations = {};
  const ids = new Set();
  for (const op of loaded.ops) {
    if (op.op === "add_clip" && CLIP_ID_RE.test(String(op.clip_id))) ids.add(op.clip_id);
  }
  for (const id of ids) {
    const meta = await readClipMeta(projectId, id);
    durations[id] = meta && typeof meta.duration_s === "number" ? meta.duration_s : null;
  }
  loaded.folded = foldOps(loaded.ops, durations);
  loaded.foldDirty = false;
  return loaded.folded;
}

/* ----- validation helpers --------------------------------------------------------- */

function validateClipId(clipId) {
  if (!CLIP_ID_RE.test(String(clipId))) throw engineError("Bad clip id");
  return clipId;
}

/* command_id is optional (UI-driven ops have none) but must be well-formed
   when present — the device re-validates independently of the relay
   (arch §8.3 defense in depth). */
function validateCommandId(commandId) {
  if (commandId == null) return undefined;
  if (!COMMAND_ID_RE.test(String(commandId))) throw engineError("Bad command id");
  return commandId;
}

function validateRange(r, label) {
  if (!r || !Number.isFinite(r.start_s) || !Number.isFinite(r.end_s)
    || r.start_s < 0 || r.end_s <= r.start_s) {
    throw engineError("malformed " + label + " range");
  }
  return { start_s: r.start_s, end_s: r.end_s };
}

/* The clip must have a live add_clip (not undone, not later removed). */
function assertClipLive(loaded, clipId) {
  const inert = new Set();
  for (const op of loaded.ops) {
    if (op.op === "undo" && Number.isFinite(op.of_seq)) inert.add(op.of_seq);
  }
  let live = false;
  for (const op of loaded.ops) {
    if (inert.has(op.seq)) continue;
    if (op.clip_id !== clipId) continue;
    if (op.op === "add_clip") live = true;
    else if (op.op === "remove_clip") live = false;
  }
  if (!live) throw engineError("clip " + clipId + " is not in this project");
}

/* Dedupe hit → the ORIGINAL outcome, never a second append (arch §3.6). */
async function dedupedOutcome(projectId, loaded, op) {
  const folded = await foldLoaded(projectId, loaded);
  const out = {
    deduped: true,
    seq: op.seq,
    timeline_duration_s: folded.timeline_duration_s,
  };
  if (op.op === "apply_cuts") out.realized = op.cuts;
  if (op.op === "undo") out.undone_op_seq = op.of_seq;
  if (op.op === "add_music") {
    out.music_seq = op.seq;
    out.placement = op.placement;
    out.music = folded.music;
  }
  if (op.op === "update_music" || op.op === "remove_music") {
    out.music_seq = op.music_seq;
    out.music = folded.music;
  }
  return out;
}

/* The live (not-undone, not-removed) music_seq set — for update/remove
   targeting validation. Mirrors assertClipLive's inert handling. */
function liveMusicSeqs(loaded) {
  const inert = new Set();
  for (const op of loaded.ops) {
    if (op.op === "undo" && Number.isFinite(op.of_seq)) inert.add(op.of_seq);
  }
  const live = new Set();
  for (const op of loaded.ops) {
    if (inert.has(op.seq)) continue;
    if (op.op === "add_music") live.add(op.seq);
    else if (op.op === "remove_music" && live.has(op.music_seq)) live.delete(op.music_seq);
  }
  return live;
}

function validateMusicSeq(loaded, musicSeq) {
  if (!Number.isFinite(musicSeq)) throw engineError("music_seq must be a number");
  const live = liveMusicSeqs(loaded);
  if (!live.has(musicSeq)) throw engineError("no live music placement with seq " + musicSeq);
  return musicSeq;
}

function validateTrackId(trackId) {
  if (!TRACK_ID_RE.test(String(trackId))) throw engineError("Bad track id");
  return trackId;
}

/* ----- public API ------------------------------------------------------------------ */

/** Folded journal state (lazily initializes the journal on first call for a
    project — THE entry point that writes the `init` op). Returns
    { segments, timeline_duration_s, ops, last_seq, notices }. The returned
    arrays are copies — callers can't corrupt the cache. */
export async function readState(projectId) {
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    const folded = await foldLoaded(projectId, loaded);
    return {
      segments: folded.segments.map((s) => ({ ...s })),
      timeline_duration_s: folded.timeline_duration_s,
      music: (folded.music || []).map((m) => ({ ...m, duck: { ...m.duck } })),
      ops: loaded.ops.map((o) => ({ ...o })),
      last_seq: loaded.lastSeq,
      notices: [...loaded.loadNotices, ...folded.notices],
    };
  });
}

/** Append `add_clip` (ingest step 6). Returns { seq, deduped,
    timeline_duration_s, segments }. */
export async function appendAddClip(projectId, { clip_id, command_id } = {}) {
  validateClipId(clip_id);
  const cmd = validateCommandId(command_id);
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    if (cmd && loaded.byCommandId.has(cmd)) {
      return dedupedOutcome(projectId, loaded, loaded.byCommandId.get(cmd));
    }
    const op = { seq: loaded.lastSeq + 1, ts: nowIso(), op: "add_clip", clip_id };
    if (cmd) op.command_id = cmd;
    await appendOp(projectId, loaded, op);
    const folded = await foldLoaded(projectId, loaded);
    return {
      seq: op.seq,
      deduped: false,
      timeline_duration_s: folded.timeline_duration_s,
      segments: folded.segments.map((s) => ({ ...s })),
    };
  });
}

/** Append `remove_clip` (ingest's degraded-replace flow; the caller also
    deletes the clip file + clipmeta). Returns like appendAddClip. */
export async function appendRemoveClip(projectId, { clip_id, command_id } = {}) {
  validateClipId(clip_id);
  const cmd = validateCommandId(command_id);
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    if (cmd && loaded.byCommandId.has(cmd)) {
      return dedupedOutcome(projectId, loaded, loaded.byCommandId.get(cmd));
    }
    assertClipLive(loaded, clip_id);
    const op = { seq: loaded.lastSeq + 1, ts: nowIso(), op: "remove_clip", clip_id };
    if (cmd) op.command_id = cmd;
    await appendOp(projectId, loaded, op);
    const folded = await foldLoaded(projectId, loaded);
    return {
      seq: op.seq,
      deduped: false,
      timeline_duration_s: folded.timeline_duration_s,
      segments: folded.segments.map((s) => ({ ...s })),
    };
  });
}

/** Append one `apply_cuts` op. `cuts` carry BOTH requested and snapped
    boundaries (snapped by probe.snapRemovalRange at EDIT time — §5.3), so
    preview and export agree exactly and the agent reports honest numbers.
    Returns { seq, deduped, realized, timeline_duration_s }. A known
    command_id returns the original outcome without appending. */
export async function appendApplyCuts(projectId, { clip_id, cuts, snap, command_id } = {}) {
  validateClipId(clip_id);
  const cmd = validateCommandId(command_id);
  const mode = snap == null ? "remove" : snap;
  if (mode !== "remove" && mode !== "keep") throw engineError("snap must be \"remove\" or \"keep\"");
  if (!Array.isArray(cuts) || cuts.length < 1 || cuts.length > MAX_CUTS) {
    throw engineError("cuts must be 1-" + MAX_CUTS + " ranges");
  }
  const cleanCuts = cuts.map((c) => ({
    requested: validateRange(c && c.requested, "requested"),
    snapped: validateRange(c && c.snapped, "snapped"),
  }));
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    if (cmd && loaded.byCommandId.has(cmd)) {
      return dedupedOutcome(projectId, loaded, loaded.byCommandId.get(cmd));
    }
    assertClipLive(loaded, clip_id);
    const op = {
      seq: loaded.lastSeq + 1,
      ts: nowIso(),
      op: "apply_cuts",
      clip_id,
      snap: mode,
      cuts: cleanCuts,
    };
    if (cmd) op.command_id = cmd;
    await appendOp(projectId, loaded, op);
    const folded = await foldLoaded(projectId, loaded);
    return {
      seq: op.seq,
      deduped: false,
      realized: cleanCuts,
      timeline_duration_s: folded.timeline_duration_s,
    };
  });
}

/** Append `undo` pointing at the LAST un-undone apply_cuts op (the
    undo_last_edit contract, arch §4). add_clip/remove_clip are clip
    lifecycle, not edits — they are not undo targets in M1 (a resurrected
    remove_clip could not bring the deleted clip FILE back). Throws a clean
    engine_error("nothing to undo") when no edit remains. Returns
    { seq, deduped, undone_op_seq, timeline_duration_s }. */
export async function appendUndo(projectId, { command_id } = {}) {
  const cmd = validateCommandId(command_id);
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    if (cmd && loaded.byCommandId.has(cmd)) {
      return dedupedOutcome(projectId, loaded, loaded.byCommandId.get(cmd));
    }
    const undone = new Set();
    for (const op of loaded.ops) {
      if (op.op === "undo" && Number.isFinite(op.of_seq)) undone.add(op.of_seq);
    }
    let target = null;
    for (let i = loaded.ops.length - 1; i >= 0; i--) {
      const op = loaded.ops[i];
      if (op.op === "apply_cuts" && !undone.has(op.seq)) { target = op; break; }
    }
    if (!target) throw engineError("nothing to undo");
    const op = { seq: loaded.lastSeq + 1, ts: nowIso(), op: "undo", of_seq: target.seq };
    if (cmd) op.command_id = cmd;
    await appendOp(projectId, loaded, op);
    const folded = await foldLoaded(projectId, loaded);
    return {
      seq: op.seq,
      deduped: false,
      undone_op_seq: target.seq,
      timeline_duration_s: folded.timeline_duration_s,
    };
  });
}

/** Append `add_music` (arch §2.2). The music_seq returned IS the op's seq —
    the stable handle update_music/remove_music target. `placement` is
    normalized + clamped here (device re-validation, defense in depth). The
    CALLER has already ensured the track exists in store/music.js (a placement
    of a missing track folds as a notice, never a crash). Returns
    { seq, music_seq, deduped, placement, timeline_duration_s, music }. */
export async function appendAddMusic(projectId, { track_id, placement, command_id } = {}) {
  validateTrackId(track_id);
  const cmd = validateCommandId(command_id);
  const clean = normalizePlacement(placement);
  if (!clean) throw engineError("malformed music placement");
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    if (cmd && loaded.byCommandId.has(cmd)) {
      return dedupedOutcome(projectId, loaded, loaded.byCommandId.get(cmd));
    }
    const op = {
      seq: loaded.lastSeq + 1, ts: nowIso(), op: "add_music",
      track_id, placement: clean,
    };
    if (cmd) op.command_id = cmd;
    await appendOp(projectId, loaded, op);
    const folded = await foldLoaded(projectId, loaded);
    return {
      seq: op.seq,
      music_seq: op.seq,
      deduped: false,
      placement: clean,
      timeline_duration_s: folded.timeline_duration_s,
      music: folded.music.map((m) => ({ ...m, duck: { ...m.duck } })),
    };
  });
}

/** Append `update_music` — a PARTIAL placement patch against a live music_seq.
    Only the provided fields change (the fold merges). Returns
    { seq, music_seq, deduped, timeline_duration_s, music }. */
export async function appendUpdateMusic(projectId, { music_seq, placement, command_id } = {}) {
  const cmd = validateCommandId(command_id);
  const seqNum = Number(music_seq);
  const patch = normalizePlacement(placement, { partial: true });
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    if (cmd && loaded.byCommandId.has(cmd)) {
      return dedupedOutcome(projectId, loaded, loaded.byCommandId.get(cmd));
    }
    validateMusicSeq(loaded, seqNum);
    const op = {
      seq: loaded.lastSeq + 1, ts: nowIso(), op: "update_music",
      music_seq: seqNum, placement: patch,
    };
    if (cmd) op.command_id = cmd;
    await appendOp(projectId, loaded, op);
    const folded = await foldLoaded(projectId, loaded);
    return {
      seq: op.seq,
      music_seq: seqNum,
      deduped: false,
      timeline_duration_s: folded.timeline_duration_s,
      music: folded.music.map((m) => ({ ...m, duck: { ...m.duck } })),
    };
  });
}

/** Append `remove_music` against a live music_seq. Returns
    { seq, music_seq, deduped, timeline_duration_s, music }. */
export async function appendRemoveMusic(projectId, { music_seq, command_id } = {}) {
  const cmd = validateCommandId(command_id);
  const seqNum = Number(music_seq);
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    if (cmd && loaded.byCommandId.has(cmd)) {
      return dedupedOutcome(projectId, loaded, loaded.byCommandId.get(cmd));
    }
    validateMusicSeq(loaded, seqNum);
    const op = { seq: loaded.lastSeq + 1, ts: nowIso(), op: "remove_music", music_seq: seqNum };
    if (cmd) op.command_id = cmd;
    await appendOp(projectId, loaded, op);
    const folded = await foldLoaded(projectId, loaded);
    return {
      seq: op.seq,
      music_seq: seqNum,
      deduped: false,
      timeline_duration_s: folded.timeline_duration_s,
      music: folded.music.map((m) => ({ ...m, duck: { ...m.duck } })),
    };
  });
}

/** The recorded op for a command_id, or null (bridge replay dedupe lookup —
    arch §3.6). */
export async function findCommand(projectId, commandId) {
  if (!COMMAND_ID_RE.test(String(commandId))) return null;
  return withProject(projectId, async (entry) => {
    const loaded = await load(projectId, entry);
    const op = loaded.byCommandId.get(commandId);
    return op ? { ...op } : null;
  });
}

/** Drop the in-memory cache for a project (or all). Needed after a project
    delete or any out-of-band change to edl.jsonl — the next call re-reads. */
export async function invalidate(projectId) {
  const reg = registry();
  if (projectId == null) {
    for (const [, entry] of reg.projects) {
      await withProjectEntry(entry, async () => { entry.loaded = null; });
    }
    return;
  }
  if (!PROJECT_ID_RE.test(String(projectId))) return;
  const entry = projectEntry(projectId);
  await withProjectEntry(entry, async () => { entry.loaded = null; });
}

/* invalidate() needs the mutex without the id re-validation. */
function withProjectEntry(entry, fn) {
  const run = entry.chain.then(() => fn(entry));
  entry.chain = run.then(() => undefined, () => undefined);
  return run;
}
