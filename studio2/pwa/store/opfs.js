/* =============================================================================
   store/opfs.js — OPFS plumbing for Studio v2 (arch §5.1).
   -----------------------------------------------------------------------------
   Pure persistence: directory helpers under projects/prj_<hex12>/, atomic
   write helpers (swap-on-close for documents; temp+rename for streamed
   outputs), the boot sweep of *.tmp orphans, quota estimate/preflight, and
   the localStorage crash marker (op-in-flight journal).

   NO media parsing here (engine/ owns that), NO DOM, NO fetch.

   Atomicity model (banked M0 reqs #3, design §5):
   • Whole-document writes (meta.json, clipmeta, chat.json) use
     writeJSONAtomic(): createWritable() stages into a swap file and close()
     commits it — the visible file is either the old or the new document,
     never a torn middle.
   • Streamed outputs (exports — written over minutes) use tempWriter():
     bytes land in "<final>.tmp" and commit() RENAMES to the final name only
     after the caller's verification passed (FileSystemFileHandle.move(),
     with a streamed-copy + delete fallback when move is unsupported).
     The final name is NEVER the write target — Output.cancel() commits
     partial bytes on whatever name it was given (banked #3).
   • A crash between write and rename leaves only a *.tmp orphan; sweepTmp()
     removes those at boot. The localStorage op marker makes the interruption
     itself visible at next boot (iOS memory kills are uncatchable).
============================================================================= */

export const PROJECT_ID_RE = /^prj_[0-9a-f]{12}$/;
export const CLIP_ID_RE = /^clip_[0-9a-f]{8}$/;

const PROJECTS_DIR = "projects";
const OP_MARKER_KEY = "studio2.op.marker.v1";

function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export function newProjectId() { return "prj_" + randHex(6); }
export function newClipId() { return "clip_" + randHex(4); }

/* ----- directory helpers ----------------------------------------------------- */

export async function opfsRoot() {
  return navigator.storage.getDirectory();
}

export async function projectsRoot({ create = false } = {}) {
  const root = await opfsRoot();
  return root.getDirectoryHandle(PROJECTS_DIR, { create });
}

/** The directory handle for one project. Throws on a malformed id BEFORE any
    filesystem access (defense in depth — ids also come from bridge commands,
    and the device must not trust the relay blindly, arch §8.3). */
export async function projectDir(projectId, { create = false } = {}) {
  if (!PROJECT_ID_RE.test(String(projectId))) {
    throw new Error("Bad project id");
  }
  const parent = await projectsRoot({ create });
  return parent.getDirectoryHandle(projectId, { create });
}

/** A named subdirectory of a project (clips/, clipmeta/, exports/). */
export async function projectSubDir(projectId, name, { create = false } = {}) {
  const dir = await projectDir(projectId, { create });
  return dir.getDirectoryHandle(name, { create });
}

/** List existing project ids (directory names matching the id format).
    Non-matching entries are ignored, never deleted (forward compat). */
export async function listProjectIds() {
  const ids = [];
  let parent;
  try { parent = await projectsRoot({ create: false }); }
  catch { return ids; }                       // no projects/ dir yet
  for await (const [name, handle] of parent.entries()) {
    if (handle.kind === "directory" && PROJECT_ID_RE.test(name)) ids.push(name);
  }
  return ids;
}

/** Permanently remove a project's whole tree. User-confirmed by the caller. */
export async function removeProjectDir(projectId) {
  if (!PROJECT_ID_RE.test(String(projectId))) throw new Error("Bad project id");
  const parent = await projectsRoot({ create: false });
  await parent.removeEntry(projectId, { recursive: true });
}

/* ----- document reads/writes -------------------------------------------------- */

/** Read + parse a JSON file from a directory. Returns null when the file is
    missing OR unparseable (torn write from a crash) — callers treat null as
    "absent" and may rewrite; the loss is logged by the caller, never thrown. */
export async function readJSON(dirHandle, name) {
  try {
    const fh = await dirHandle.getFileHandle(name, { create: false });
    const file = await fh.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic whole-document JSON write: createWritable() stages, close() commits
    (OPFS swap-on-close). The visible file is never a torn middle state. */
export async function writeJSONAtomic(dirHandle, name, obj) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();   // truncating stage file
  try {
    await writable.write(new TextEncoder().encode(JSON.stringify(obj)));
  } catch (err) {
    try { await writable.abort(); } catch { /* already errored */ }
    throw err;
  }
  await writable.close();                       // the atomic commit
}

/* ----- temp-then-rename (streamed outputs; banked #3) ------------------------- */

/** Rename/move a file within `dirHandle`. Uses FileSystemFileHandle.move()
    when the platform has it; otherwise falls back to a STREAMED copy + delete
    (never buffers the file in memory — device RAM is the constraint). */
export async function moveEntry(dirHandle, fromName, toName) {
  const src = await dirHandle.getFileHandle(fromName, { create: false });
  if (typeof src.move === "function") {
    await src.move(dirHandle, toName);
    return;
  }
  // Streamed-copy fallback: pipe source → destination, then delete the source.
  const file = await src.getFile();
  const dst = await dirHandle.getFileHandle(toName, { create: true });
  const writable = await dst.createWritable();
  try {
    await file.stream().pipeTo(writable);       // pipeTo closes (commits) on success
  } catch (err) {
    try { await writable.abort(); } catch { /* already dead */ }
    try { await dirHandle.removeEntry(toName); } catch { /* never existed */ }
    throw err;
  }
  await dirHandle.removeEntry(fromName);
}

/** Open a temp-named writable whose bytes only ever become visible under the
    final name via an explicit, post-verification commit():

      const t = await tempWriter(exportsDir, "export-x.mp4");
      … stream into t.writable …  → verify the .tmp …  → await t.commit();
      on ANY failure: await t.abandon();

    `handle` is the .tmp file's handle (verification re-opens it from here).
    commit() closes the writable if still open, then renames .tmp → final.
    abandon() aborts the writable and best-effort deletes the .tmp; it never
    throws (cleanup must never mask the original error — spike lesson). */
export async function tempWriter(dirHandle, finalName) {
  const tmpName = finalName + ".tmp";
  const handle = await dirHandle.getFileHandle(tmpName, { create: true });
  const writable = await handle.createWritable();
  let open = true;
  return {
    tmpName,
    handle,
    writable,
    /** Close (commit the .tmp) without renaming — callers that must verify
        the COMMITTED bytes call this first, then verify, then commit(). */
    async close() {
      if (open) { open = false; await writable.close(); }
    },
    async commit() {
      if (open) { open = false; await writable.close(); }
      await moveEntry(dirHandle, tmpName, finalName);
    },
    async abandon() {
      if (open) {
        open = false;
        try { await writable.abort(); } catch { /* locked or closed — fine */ }
      }
      try { await dirHandle.removeEntry(tmpName); } catch { /* already gone */ }
    },
  };
}

/* ----- boot sweep of *.tmp orphans (arch §5.1) -------------------------------- */

async function sweepDirTmp(dirHandle, swept) {
  const doomed = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && name.endsWith(".tmp")) doomed.push(name);
  }
  for (const name of doomed) {
    try { await dirHandle.removeEntry(name); swept.push(name); }
    catch { /* best-effort — a locked entry stays for the next boot */ }
  }
}

/** Delete *.tmp orphans left by interrupted writes: scans each project dir
    and its clips/, exports/ and transcripts/ subdirs. Returns the swept names
    (for diag). Never throws. */
export async function sweepTmp() {
  const swept = [];
  try {
    const ids = await listProjectIds();
    for (const id of ids) {
      try {
        const dir = await projectDir(id);
        await sweepDirTmp(dir, swept);
        try {
          const clips = await dir.getDirectoryHandle("clips", { create: false });
          await sweepDirTmp(clips, swept);
        } catch { /* no clips dir yet */ }
        try {
          const exports = await dir.getDirectoryHandle("exports", { create: false });
          await sweepDirTmp(exports, swept);
        } catch { /* no exports dir yet */ }
        try {
          // M2 (arch §5.1): the audio-extraction spool (transcripts/clip_*.m4a
          // .tmp) — an `.m4a` that never committed to upload, or a crash
          // between extract and abandon. store/transcripts.js owns the JSON in
          // here; the .tmp orphans are ours to sweep, same as clips/exports.
          const transcripts = await dir.getDirectoryHandle("transcripts", { create: false });
          await sweepDirTmp(transcripts, swept);
        } catch { /* no transcripts dir yet */ }
      } catch { /* skip a broken project dir, keep sweeping the rest */ }
    }
  } catch { /* OPFS unavailable — nothing to sweep */ }
  return swept;
}

/* ----- quota ------------------------------------------------------------------ */

/** {quota, usage, available} in bytes (nulls when the API is unavailable). */
export async function storageEstimate() {
  try {
    const est = await navigator.storage.estimate();
    const quota = typeof est.quota === "number" ? est.quota : null;
    const usage = typeof est.usage === "number" ? est.usage : null;
    return {
      quota,
      usage,
      available: (quota != null && usage != null) ? Math.max(0, quota - usage) : null,
    };
  } catch {
    return { quota: null, usage: null, available: null };
  }
}

/** Pre-flight a write of `bytesNeeded` (+ headroom, default 5% — the design's
    pre-ingest check). Returns {ok, quota, usage, available, needed}.
    When the estimate API is unavailable the check PASSES (ok:true, nulls) —
    the write itself will surface a real quota error if there is one. */
export async function quotaPreflight(bytesNeeded, headroom = 0.05) {
  const est = await storageEstimate();
  const needed = Math.ceil(bytesNeeded * (1 + headroom));
  const ok = est.available == null ? true : est.available >= needed;
  return { ok, needed, ...est };
}

/** Ask the browser to protect this origin's storage from automatic eviction.
    Called once, when the user creates their first project (arch §5.1).
    Returns true/false/null(unsupported); never throws. */
export async function requestPersist() {
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== "function") return null;
    return !!(await navigator.storage.persist());
  } catch {
    return null;
  }
}

/* ----- crash marker (localStorage op-in-flight journal) ------------------------ */
/* iOS memory kills are uncatchable; the marker is how an interrupted heavy
   operation is DETECTED at the next boot (spike's crash journal,
   productionized). Owners (ingest/export, Steps 4/5) set the marker when a
   heavy op starts and clear it when the op completes; boot calls
   takeOpMarker() and shows a "something was interrupted" notice on a hit.
   The journal itself needs no repair beyond torn-tail tolerance — the marker
   is a USER-FACING signal, not a recovery mechanism. */

export function setOpMarker(op, projectId, data) {
  try {
    localStorage.setItem(OP_MARKER_KEY, JSON.stringify({
      op: String(op || "").slice(0, 40),
      project_id: typeof projectId === "string" ? projectId.slice(0, 20) : null,
      data: data && typeof data === "object" ? data : undefined,
      started_at: Date.now(),
    }));
  } catch { /* private mode — marker is best-effort */ }
}

export function clearOpMarker() {
  try { localStorage.removeItem(OP_MARKER_KEY); } catch { /* ignore */ }
}

/** Read AND clear the marker (claimed exactly once, like diag's boot replay).
    Returns the parsed marker {op, project_id, started_at} or null. */
export function takeOpMarker() {
  try {
    const raw = localStorage.getItem(OP_MARKER_KEY);
    localStorage.removeItem(OP_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" && parsed.op) ? parsed : null;
  } catch {
    return null;
  }
}
