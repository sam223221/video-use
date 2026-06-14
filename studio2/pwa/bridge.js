/* =============================================================================
   bridge.js — THE DEVICE-TOOL BRIDGE, device half (arch §2.3 + §3).
   -----------------------------------------------------------------------------
   The relay's agent runs tools ON THIS DEVICE: a persistent SSE stream
   (`GET /api/bridge/events?device_id=`) delivers `command` frames; this module
   executes them against the project's OPFS/engine state and answers with
   `POST /api/bridge/result`. The protocol contract (arch §3):

   • Dedupe by command_id — MANDATORY. Reconnect replay re-sends every
     still-pending command; a command already executing is ignored, a command
     already completed re-POSTs its cached result (≤50-entry LRU map).
   • SINGLE-FLIGHT execution (banked M0 #6): every executor runs through ONE
     promise queue — never two engine operations concurrently on the phone.
     The queue is shared with export.js via editor.js (`createOpQueue`), so a
     user-triggered export and an agent edit also serialize. Consequence
     (documented, accepted): an open ask_user card holds the queue — the
     agent awaits tools sequentially, so this never stalls real work.
   • Result POST retry ladder: 1→2→4→8→15 s backoff (6 attempts total),
     ABORT on 409 `no_pending_command` (the relay resolved/timed-out/cancelled
     it — benign) and on any other 4xx (a malformed body will not fix itself).
     Network failures / 5xx retry; after exhaustion the result is dropped
     (the relay's own timeout fired; local journal state remains correct).
   • project_id binding: a command for a project other than the one this
     editor session has open answers `project_mismatch` immediately.
   • server_boot_id: carried in `hello`. A change (relay restart) clears
     pending turn UI via onServerBootChange — all relay-side Futures died.

   TRANSPORT NOTE (deliberate deviation from "EventSource", documented):
   the stream is read with fetch + ReadableStream (`sseRequest` below, the
   same framing parser contract as api.streamPost) instead of EventSource,
   because the relay ends a replaced stream with a `: superseded` COMMENT —
   and the EventSource API cannot observe comments. With EventSource the
   superseded tab would silently auto-reconnect and supersede the newer one
   back, ping-ponging forever. With sseRequest we see the comment, stop
   reconnecting, and show "another window took over"; returning to the tab
   (visibilitychange → visible) reconnects, making the visible window the
   newest — exactly the arch §2.3 newest-wins rule. Last-Event-ID is sent
   manually on reconnect; heartbeat comments feed a liveness watchdog.

   This module also exports `sseRequest` for chat.js (`GET /api/chat/attach`
   is a GET stream — api.streamPost only POSTs).

   XSS posture: this module renders nothing; all strings it produces travel
   as JSON to the relay or through chat.js's textContent-only rendering.
============================================================================= */

import { deviceId } from "./util.js";
import { api } from "./api.js";
import { CLIP_ID_RE } from "./store/opfs.js";
import { listClipMetas, readClipMeta, getProject, getRenderBlock, effectiveFit } from "./store/meta.js";
import { readTranscript, listTranscriptClipIds } from "./store/transcripts.js";
import { listTracks } from "./store/music.js";
import { extractFrames } from "./engine/frames.js";
import {
  setOutputFormat, setClipFit, listMusicLibrary,
  addMusic, updateMusic, removeMusic, currentTier,
} from "./music-ops.js";

/* diag shim — never-throws global accessor (window singleton survives the
   ?v=/bare double-load seam; see pwa/DOCUMENT.md "Import discipline"). */
function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

const COMMAND_ID_RE = /^cmd_[0-9a-f]{12}$/;
const DEDUPE_MAX = 50;                       // arch §3.6 cached-result cap
const RESULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];
const LIVENESS_TIMEOUT_MS = 65 * 1000;       // 3 missed 20 s heartbeats + slack
const RESULT_MAX_BYTES = 2 * 1024 * 1024;    // 2 MiB — MUST match the relay's
                                             // routers/bridge.py _RESULT_MAX_BYTES
                                             // (Agent Vision, plan §3 LOCKSTEP).
                                             // Raised from 512 KB so a ≤4-frame
                                             // view_frames image result fits both
                                             // ends; a >2 MiB result is rejected
                                             // here AND 413'd at the relay.
                                             // (UTF-8 BYTES — JSON.stringify().length
                                             // counts UTF-16 chars and undercounts)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =============================================================================
   Tool-error taxonomy helpers (arch §3.5 device subset)
============================================================================= */

/** An error carrying a bridge taxonomy code (project_mismatch / engine_error /
    storage_error). Executors and the editor's engine adapter throw these. */
export function toolError(code, message) {
  const e = new Error(String(message || code));
  e.name = "ToolError";
  e.toolCode = code;
  return e;
}

/** Sentinel for "do not POST a result at all" (card expired / turn moved on —
    the relay already resolved or dropped the Future on its side). */
export function cancelledError(message) {
  const e = new Error(message || "cancelled");
  e.name = "BridgeCancelled";
  e.bridgeCancelled = true;
  return e;
}

const TAXONOMY_CODES = new Set(["project_mismatch", "engine_error", "storage_error"]);

function classifyError(err) {
  if (err && typeof err.toolCode === "string" && TAXONOMY_CODES.has(err.toolCode)) {
    return { code: err.toolCode, message: String(err.message || "").slice(0, 1000) };
  }
  // Step 4's engine modules tag taxonomy codes as `.code` (writers.engineError).
  if (err && typeof err.code === "string" && TAXONOMY_CODES.has(err.code)) {
    return { code: err.code, message: String(err.message || "").slice(0, 1000) };
  }
  if (err && (err.name === "QuotaExceededError" || err.name === "NotReadableError" ||
      err.name === "NoModificationAllowedError" || err.name === "NotFoundError" ||
      /quota/i.test(String(err && err.message)))) {
    return { code: "storage_error", message: String(err.message || "storage failure").slice(0, 1000) };
  }
  return {
    code: "engine_error",
    message: String((err && err.message) || "unexpected device failure").slice(0, 1000),
  };
}

/* =============================================================================
   Transcript reads — device-side windowing / search (arch §5.3, §5.4)
   -----------------------------------------------------------------------------
   read_transcript and find_in_transcript answer ON THE DEVICE now (the M1
   relay stub is gone — arch §5.5). The token-budgeting that protects the
   MODEL's context lives HERE: a 30-min clip is ~4,500 words / ~25 k tokens at
   full word-timing, so the executors page text (≤14,000 chars/call + a
   next_from_s cursor), window words (≤120 s/call), and return only the
   cut-relevant words plus the silence gaps a cut needs. Results stay ≪ the
   bridge's 2 MiB cap by construction (arch §8.4).

   All times are SOURCE-clip seconds (arch §4.2 invariant) — the same clock the
   EDL keep-list, preview and export share.
============================================================================= */

const READ_TEXT_MAX_CHARS = 14000;   // arch §5.3 line-mode hard cap (~3.5k tokens)
const READ_WORDS_MAX_WINDOW_S = 120; // arch §5.3 words-mode window ceiling
const LINE_MAX_CHARS = 140;          // arch §5.3 line wrap
const LINE_GAP_HARD_S = 0.8;         // any inter-word gap ≥ this breaks a line
const LINE_GAP_SENTENCE_S = 0.35;    // sentence-final punctuation + this gap breaks
const FIND_CONTEXT_WORDS = 8;        // arch §5.4 "~8 words before/after" snippet
const FIND_MAX_RESULTS_CAP = 10;     // arch §5.4 max_results ceiling

/* Agent Vision (view_frames, plan §5). The relay already expands around_s →
   at_seconds and caps the count; the device re-clamps as the data owner. */
const VIEW_FRAMES_MAX = 4;           // plan §5: 1-4 frames/call
const VIEW_FRAMES_MAX_EDGE_PX = 512; // long-edge ceiling (server-fixed downscale)
const VIEW_FRAMES_QUALITY = 0.6;     // JPEG quality (server-fixed)

function round2(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/** A transcript header summary for get_inventory + the overview (arch §5.2):
    {language, words, duration_s} or null when there is no transcript. */
function transcriptSummary(doc) {
  if (!doc) return null;
  return {
    language: typeof doc.language_code === "string" ? doc.language_code : null,
    words: Array.isArray(doc.words) ? doc.words.length : 0,
    duration_s: round2(doc.audio_duration_s),
  };
}

/** Sentence-final punctuation at the end of a word token (line-break heuristic). */
function endsSentence(w) {
  return /[.!?…]["')\]]?$/.test(String(w || ""));
}

/** Group a slice of words[] into time-anchored LINES (arch §5.3 text mode).
    Breaks on: an inter-word gap ≥0.8 s; sentence-final punctuation followed by
    a ≥0.35 s gap; or a running length of 140 chars. Each line:
    {s, e, text}. */
function groupLines(words) {
  const lines = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const token = String(w.w || "");
    if (!cur) {
      cur = { s: w.s, e: w.e, text: token };
      continue;
    }
    const prev = words[i - 1];
    const gap = w.s - prev.e;
    const tooLong = cur.text.length + 1 + token.length > LINE_MAX_CHARS;
    const hardGap = gap >= LINE_GAP_HARD_S;
    const sentenceBreak = endsSentence(prev.w) && gap >= LINE_GAP_SENTENCE_S;
    if (tooLong || hardGap || sentenceBreak) {
      lines.push({ s: round2(cur.s), e: round2(cur.e), text: cur.text });
      cur = { s: w.s, e: w.e, text: token };
    } else {
      cur.text += " " + token;
      cur.e = w.e;
    }
  }
  if (cur) lines.push({ s: round2(cur.s), e: round2(cur.e), text: cur.text });
  return lines;
}

/** Normalize a token for matching (arch §5.4): casefold, strip surrounding
    punctuation, collapse internal apostrophes are kept (they're part of words). */
function normToken(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/^[^0-9a-zÀ-ɏ']+/i, "")
    .replace(/[^0-9a-zÀ-ɏ']+$/i, "");
}

/** Split a free-text query into normalized word tokens (arch §5.4). */
function queryTokens(query) {
  return String(query || "")
    .split(/\s+/)
    .map(normToken)
    .filter((t) => t.length > 0);
}

/* =============================================================================
   The single-flight operation queue (banked M0 #6)
   -----------------------------------------------------------------------------
   ONE chain for everything heavy on the device: bridge executors AND the
   user-gesture export (editor.js creates one queue and hands it to both).
   Each job clears its own per-run state at start (the banked requirement) —
   enforcement lives in the jobs; the queue guarantees never-two-at-once.
============================================================================= */
export function createOpQueue() {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    /** Run `job` after everything already queued. Returns job's promise. */
    run(job) {
      depth += 1;
      const p = tail.then(() => job()).finally(() => { depth -= 1; });
      tail = p.catch(() => { /* a failed job never blocks the queue */ });
      return p;
    },
    get busy() { return depth > 0; },
  };
}

/* =============================================================================
   sseRequest — GET an SSE stream over fetch (comments + ids visible)
   -----------------------------------------------------------------------------
   Same `event:`/`data:`/`id:` framing as api.streamPost (arch §2 framing),
   plus: comment lines (`: hb`, `: superseded`, `: connected`) surface through
   onComment, and a Last-Event-ID header rides reconnects. Errors are passed
   to onError as PLAIN objects {status, code, message} (no class identity —
   the documented ?v=/bare double-load seam forbids instanceof).
============================================================================= */
export function sseRequest(path, { lastEventId, onEvent, onComment, onOpen, onError, onClose } = {}) {
  const ctrl = new AbortController();
  let cancelled = false;

  (async () => {
    let res;
    try {
      const headers = { Accept: "text/event-stream" };
      if (lastEventId != null) headers["Last-Event-ID"] = String(lastEventId);
      res = await fetch(path, {
        method: "GET",
        credentials: "same-origin",
        headers,
        cache: "no-store",
        signal: ctrl.signal,
      });
    } catch (err) {
      if (!cancelled) onError && onError({ status: 0, code: "network", message: "Cannot reach Studio." });
      onClose && onClose();
      return;
    }

    if (!res.ok) {
      onError && onError(await readErrorEnvelope(res));
      onClose && onClose();
      return;
    }
    if (!res.body) {
      onError && onError({ status: 0, code: "no_stream", message: "Server did not return a stream." });
      onClose && onClose();
      return;
    }

    onOpen && onOpen();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let brk;
        while ((brk = frameBreak(buf)) !== null) {
          const frame = buf.slice(0, brk.at);
          buf = buf.slice(brk.at + brk.len);
          emitFrame(frame, onEvent, onComment);
        }
      }
    } catch (err) {
      if (!cancelled) onError && onError({ status: 0, code: "stream", message: "Stream interrupted." });
    } finally {
      onClose && onClose();
    }
  })();

  return {
    cancel() {
      cancelled = true;
      try { ctrl.abort(); } catch { /* already done */ }
    },
  };
}

function frameBreak(s) {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1 && b === -1) return null;
  if (a === -1) return { at: b, len: 4 };
  if (b === -1) return { at: a, len: 2 };
  return a < b ? { at: a, len: 2 } : { at: b, len: 4 };
}

function emitFrame(frame, onEvent, onComment) {
  let event = "message";
  let id = null;
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(":")) {
      // Comment line (heartbeat / superseded / connected).
      let c = line.slice(1);
      if (c.startsWith(" ")) c = c.slice(1);
      onComment && onComment(c);
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? "" : line.slice(colon + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") event = val;
    else if (field === "data") dataLines.push(val);
    else if (field === "id") id = val;
  }
  if (dataLines.length === 0) return;
  const dataStr = dataLines.join("\n");
  let data;
  try { data = JSON.parse(dataStr); } catch { data = dataStr; }
  onEvent && onEvent(event, data, { id });
}

/** Read a failed response's v1 error envelope into {status, code, message}. */
async function readErrorEnvelope(res) {
  let code = "http_error";
  let message = "Request failed (HTTP " + res.status + ")";
  try {
    const body = await res.json();
    const nested = body && body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? body.detail.error : undefined;
    if (nested && typeof nested === "object") {
      code = nested.code || code;
      message = nested.message || message;
    } else if (body && typeof body.detail === "string" && body.detail) {
      message = body.detail;
    }
  } catch { /* non-JSON body */ }
  return { status: res.status, code, message };
}

/* =============================================================================
   Executor registry (arch §4 device column)
   -----------------------------------------------------------------------------
   Built per editor session; ctx comes from editor.js:
     { project, engine() → adapter|null, findClipFile(clipId) → File,
       askUser({questions, command, signal}) → Promise<answers|null>,
       notifyEdlChange() }
   The relay validated every param already (arch §8.3); the device REVALIDATES
   anyway — it is the data owner and must not trust the relay blindly.
   Executors throw toolError(code, …) for taxonomy failures; anything else
   classifies as engine_error / storage_error.
============================================================================= */
export function buildExecutors(ctx) {
  const projectId = ctx.project.id;

  // M3: a render-territory change (canvas/fit/music) repaints the preview
  // overlay + format/music panels. Optional on ctx (older editors): a no-op
  // when absent never breaks an executor.
  function notifyRenderChange() {
    if (typeof ctx.notifyRenderChange === "function") {
      try { ctx.notifyRenderChange(); } catch { /* UI must not break the bridge */ }
    }
  }

  function requireEngine() {
    const engine = ctx.engine();
    if (!engine) {
      throw toolError("engine_error",
        "the editing engine is not loaded on the device — ask the user to refresh the Studio app");
    }
    return engine;
  }

  async function requireClipFile(clipId) {
    const file = await ctx.findClipFile(clipId);
    if (!file) {
      throw toolError("engine_error", `clip ${clipId} has no media file in this project`);
    }
    return file;
  }

  function validClipId(value) {
    if (typeof value !== "string" || !CLIP_ID_RE.test(value)) {
      throw toolError("engine_error", "clip_id must match clip_<8 hex chars>");
    }
    return value;
  }

  /* Mirror of the relay's range validation (defense in depth, arch §8.3). */
  function validCutRanges(raw) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
      throw toolError("engine_error", "remove must be 1-50 {start_s, end_s} ranges");
    }
    const out = raw.map((r, i) => {
      const start = Number(r && r.start_s);
      const end = Number(r && r.end_s);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw toolError("engine_error", `remove[${i}] must satisfy 0 <= start_s < end_s (finite)`);
      }
      return { start_s: start, end_s: end };
    });
    out.sort((a, b) => (a.start_s - b.start_s) || (a.end_s - b.end_s));
    for (let i = 1; i < out.length; i++) {
      if (out[i].start_s < out[i - 1].end_s) {
        throw toolError("engine_error", "remove ranges overlap after sorting");
      }
    }
    return out;
  }

  async function foldOrEmpty() {
    const engine = ctx.engine();
    if (!engine) return { segments: [], ops: [], timeline_duration_s: 0 };
    return engine.fold();
  }

  return {
    /* ---- get_inventory --------------------------------------------------- */
    async get_inventory() {
      const [projMeta, clipMetas, fold, transcribedIds, renderBlock, tracks] = await Promise.all([
        getProject(projectId),
        listClipMetas(projectId),
        foldOrEmpty(),
        listTranscriptClipIds(projectId),
        getRenderBlock(projectId),
        listTracks(projectId),
      ]);
      // Per-clip transcript summaries (arch §5.2) — cached reads, only for the
      // clips that have a transcript file (the rest carry `transcript: null`).
      const transcribed = new Set(transcribedIds);
      const summaries = new Map();
      await Promise.all(
        clipMetas
          .filter((m) => transcribed.has(m.clip_id))
          .map(async (m) => {
            const doc = await readTranscript(projectId, m.clip_id);
            summaries.set(m.clip_id, transcriptSummary(doc));
          }),
      );
      let anyTranscript = false;
      const clips = clipMetas.map((m) => {
        const summary = summaries.get(m.clip_id) || null;
        if (summary) anyTranscript = true;
        return {
          clip_id: m.clip_id,
          name: m.original_name || m.clip_id,
          duration_s: numberOrNull(m.duration_s),
          // Step 4 clipmeta carries display/coded dims (rotation-aware).
          width: numberOrNull(m.video && (m.video.displayWidth ?? m.video.codedWidth)),
          height: numberOrNull(m.video && (m.video.displayHeight ?? m.video.codedHeight)),
          fps: numberOrNull(m.video && m.video.fps),
          codec: (m.video && m.video.codec) || null,
          has_audio: !!m.audio,
          hdr: !!(m.video && m.video.hdr),
          rotation: numberOrNull(m.video && m.video.rotation) || 0,
          size_bytes: numberOrNull(m.size_bytes),
          degraded: isDegraded(m),
          transcript: summary,                 // null | {language, words, duration_s}
          // M3: the effective per-clip fit (sparse override else project default).
          fit: effectiveFit(renderBlock, m.clip_id),   // {mode, background}
        };
      });
      // M3 render context (canvas / music placements / current tier) so the
      // agent's live context already knows whether the project is in render
      // territory (arch §7.1 — get_inventory is EXTENDED, not a new tool).
      const tier = await currentTier(projectId, fold);
      return {
        project: { id: projectId, name: (projMeta && projMeta.name) || ctx.project.name },
        clips,
        edl: {
          ops: Array.isArray(fold.ops) ? fold.ops.length : 0,
          segments: Array.isArray(fold.segments) ? fold.segments.length : 0,
          timeline_duration_s: round3(fold.timeline_duration_s || 0),
        },
        canvas: renderBlock && renderBlock.canvas ? { ...renderBlock.canvas } : null,
        music: musicSummary(fold.music, tracks),
        tier,                                  // "lossless" | "render"
        has_transcript: anyTranscript,         // M1 shape preserved, now honest
      };
    },

    /* ---- describe_clip --------------------------------------------------- */
    async describe_clip(params) {
      const clipId = validClipId(params && params.clip_id);
      const meta = await readClipMeta(projectId, clipId);
      if (!meta) throw toolError("engine_error", `no clip ${clipId} exists in this project`);
      let spacing = numberOrNull(meta.keyframe_spacing_s_estimate);
      if (spacing == null) {
        const engine = ctx.engine();
        if (engine && typeof engine.gopEstimate === "function") {
          try {
            spacing = numberOrNull(await engine.gopEstimate(await requireClipFile(clipId)));
          } catch (err) {
            dlog("warn", "bridge.gop.err", { clip_id: clipId, message: errMsg(err) });
          }
        }
      }
      return { ...meta, keyframe_spacing_s_estimate: spacing };
    },

    /* ---- read_edl -------------------------------------------------------- *
       M3: surfaces the folded `music` placements (clamped to the timeline) +
       the current tier alongside the keep-list segments (arch §7.1 — read_edl
       is EXTENDED, the music/tier fields are pure device passthrough). */
    async read_edl() {
      const fold = await foldOrEmpty();
      const ops = Array.isArray(fold.ops) ? fold.ops : [];
      const tier = await currentTier(projectId, fold);
      return {
        segments: (fold.segments || []).map((s) => ({
          clip_id: s.clip_id, start_s: round3(s.start_s), end_s: round3(s.end_s),
        })),
        music: (fold.music || []).map((m) => ({
          music_seq: m.music_seq,
          track_id: m.track_id,
          at_s: round3(m.at_s),
          duration_s: round3(m.duration_s),
          gain_db: m.gain_db,
          fade_in_s: m.fade_in_s,
          fade_out_s: m.fade_out_s,
          duck: m.duck ? { ...m.duck } : null,
        })),
        ops: ops.slice(-20),
        timeline_duration_s: round3(fold.timeline_duration_s || 0),
        tier,                                  // "lossless" | "render"
      };
    },

    /* ---- read_transcript ------------------------------------------------- *
       REAL device-executed read (arch §5.3) — the M1 relay stub is gone
       (arch §5.5). Three modes, all token-budgeted on the device:
         • no clip_id        → a transcripts overview (cheap orientation)
         • detail:"text"     → window words grouped into time-anchored LINES,
                               ≤14,000 chars/call + a next_from_s cursor
         • detail:"words"    → per-word precision, window REQUIRED and ≤120 s
       A clip with no transcript → a friendly non-error has_transcript:false
       result the prompt leans on. */
    async read_transcript(params) {
      const p = params || {};
      const detail = p.detail === "words" ? "words" : "text";

      // No clip_id → overview across every transcribed clip (arch §5.3).
      if (p.clip_id == null) {
        const ids = await listTranscriptClipIds(projectId);
        const metas = await listClipMetas(projectId);
        const nameById = new Map(metas.map((m) => [m.clip_id, m.original_name || m.clip_id]));
        const out = [];
        for (const m of metas) {
          const has = ids.includes(m.clip_id);
          const doc = has ? await readTranscript(projectId, m.clip_id) : null;
          const sum = transcriptSummary(doc);
          out.push({
            clip_id: m.clip_id,
            name: nameById.get(m.clip_id) || m.clip_id,
            has_transcript: !!sum,
            language: sum ? sum.language : null,
            words: sum ? sum.words : 0,
            duration_s: sum ? sum.duration_s : numberOrNull(m.duration_s),
          });
        }
        return {
          clips: out,
          hint: "Call read_transcript again with a clip_id to read its lines, " +
            "or find_in_transcript to jump to specific words.",
        };
      }

      const clipId = validClipId(p.clip_id);
      const doc = await readTranscript(projectId, clipId);
      if (!doc) {
        return {
          has_transcript: false,
          message: "No transcript for this clip yet. The user can create one from " +
            "the Media page (Transcribe button — about $0.40 per hour of audio). " +
            "Until then, ask for cut points by time.",
        };
      }

      const words = Array.isArray(doc.words) ? doc.words : [];
      const clipDuration = round2(doc.audio_duration_s);

      // Window bounds (defense in depth — the relay validated these already).
      const fromS = numberOrNull(p.from_s);
      const toS = numberOrNull(p.to_s);
      const winFrom = fromS != null && fromS >= 0 ? fromS : 0;

      if (detail === "words") {
        // Words mode: window REQUIRED, ≤120 s (arch §5.3).
        if (fromS == null || toS == null || toS <= fromS) {
          throw toolError("engine_error",
            "read_transcript detail:'words' needs a from_s < to_s window");
        }
        if (toS - fromS > READ_WORDS_MAX_WINDOW_S) {
          throw toolError("engine_error",
            `read_transcript detail:'words' window must be <= ${READ_WORDS_MAX_WINDOW_S}s`);
        }
        const inWin = words
          .filter((w) => w.e > fromS && w.s < toS)
          .map((w) => {
            const o = { w: w.w, s: round2(w.s), e: round2(w.e) };
            if (typeof w.c === "number") o.c = w.c;
            return o;
          });
        return {
          clip_id: clipId,
          window: { from_s: round2(fromS), to_s: round2(toS) },
          words: inWin,
        };
      }

      // Text mode: group windowed words into lines, page at 14,000 chars.
      const winTo = toS != null && toS > winFrom ? toS : clipDuration || Infinity;
      const windowed = words.filter((w) => w.e > winFrom && w.s < winTo);
      const allLines = groupLines(windowed);

      const lines = [];
      let chars = 0;
      let truncated = false;
      let nextFromS = null;
      for (const line of allLines) {
        const cost = line.text.length + 1;
        if (chars + cost > READ_TEXT_MAX_CHARS && lines.length > 0) {
          truncated = true;
          nextFromS = line.s;            // resume at this line's start (arch §5.3)
          break;
        }
        lines.push(line);
        chars += cost;
      }

      const result = {
        clip_id: clipId,
        language: typeof doc.language_code === "string" ? doc.language_code : null,
        clip_duration_s: clipDuration,
        window: {
          from_s: round2(winFrom),
          to_s: round2(Number.isFinite(winTo) ? winTo : clipDuration),
        },
        lines,
        truncated,
        word_count_total: words.length,
      };
      if (truncated && nextFromS != null) result.next_from_s = round2(nextFromS);
      return result;
    },

    /* ---- find_in_transcript ---------------------------------------------- *
       NEW M2 tool (arch §5.4). Normalized word-sequence search across one clip
       (clip_id given) or every transcribed clip. Returns the matched words plus
       the silence gaps to the previous/next word — the load-bearing
       gap_before_s/gap_after_s the model places cut boundaries in (arch §6). */
    async find_in_transcript(params) {
      const p = params || {};
      const tokens = queryTokens(p.query);
      if (tokens.length === 0) {
        throw toolError("engine_error", "find_in_transcript needs a non-empty query");
      }
      let maxResults = numberOrNull(p.max_results);
      maxResults = maxResults == null ? 5 : Math.max(1, Math.min(FIND_MAX_RESULTS_CAP, Math.floor(maxResults)));

      // Which clips to search (one, or all transcribed).
      let clipIds;
      if (p.clip_id != null) {
        clipIds = [validClipId(p.clip_id)];
      } else {
        clipIds = await listTranscriptClipIds(projectId);
      }

      const matches = [];
      const searched = [];
      let anyTranscript = false;
      for (const clipId of clipIds) {
        const doc = await readTranscript(projectId, clipId);
        if (!doc) continue;
        anyTranscript = true;
        searched.push(clipId);
        const words = Array.isArray(doc.words) ? doc.words : [];
        const norm = words.map((w) => normToken(w.w));
        for (let i = 0; i + tokens.length <= norm.length; i++) {
          let hit = true;
          for (let k = 0; k < tokens.length; k++) {
            if (norm[i + k] !== tokens[k]) { hit = false; break; }
          }
          if (!hit) continue;
          const first = words[i];
          const last = words[i + tokens.length - 1];
          const prev = i > 0 ? words[i - 1] : null;
          const next = i + tokens.length < words.length ? words[i + tokens.length] : null;
          const ctxStart = Math.max(0, i - FIND_CONTEXT_WORDS);
          const ctxEnd = Math.min(words.length, i + tokens.length + FIND_CONTEXT_WORDS);
          const snippet = [];
          for (let j = ctxStart; j < ctxEnd; j++) {
            if (j === i) snippet.push("[");
            snippet.push(words[j].w);
            if (j === i + tokens.length - 1) snippet.push("]");
          }
          matches.push({
            clip_id: clipId,
            start_s: round2(first.s),
            end_s: round2(last.e),
            text: snippet.join(" ").replace(/\[ /g, "[").replace(/ \]/g, "]"),
            words: words.slice(i, i + tokens.length).map((w) => ({
              w: w.w, s: round2(w.s), e: round2(w.e),
            })),
            gap_before_s: prev ? round2(Math.max(0, first.s - prev.e)) : null,
            gap_after_s: next ? round2(Math.max(0, next.s - last.e)) : null,
          });
          if (matches.length >= maxResults) break;
        }
        if (matches.length >= maxResults) break;
      }

      if (!anyTranscript) {
        return {
          has_transcript: false,
          message: "No transcript on any clip yet. The user can create one from " +
            "the Media page (Transcribe button — about $0.40 per hour of audio). " +
            "Until then, ask for cut points by time.",
        };
      }

      return {
        total_matches: matches.length,
        searched_clips: searched,
        matches,
      };
    },

    /* ---- view_frames ----------------------------------------------------- *
       AGENT VISION (plan §5). The agent's ONLY way to SEE the pixels: decode
       the requested still frames on-device, downscale (≤512px long edge,
       rotation applied so portrait frames are upright) + JPEG-encode them, and
       return base64 stills the relay wraps into MCP image blocks.

       GATE: webcodecs.videoDecoder. A device whose WebCodecs decode is
       unavailable returns a CLEAN {error:{code:"unsupported"}} (NOT a throw) —
       the relay renders it as a clean _err and the prompt tells the agent to
       fall back to transcript/time. Any decode failure on a capable device →
       {error:{code:"engine_error"}}.

       This executor's RESULT is an in-band shape ({frames}|{error}) — NOT the
       bridge taxonomy. It NEVER throws to the runner (so it never becomes a
       bridge ok:false): success and both error codes are ordinary results, so
       the relay's _render_view_frames sees exactly the plan §5 contract. */
    async view_frames(params, { signal }) {
      // No command_id needed: view_frames is naturally idempotent (re-decoding
      // the same stills is safe) and the bridge's dedupe map handles replays at
      // the transport layer. The abort `signal` carries the relay's deadline.
      const caps = ctx.caps;
      const canDecode = !!(caps && caps.webcodecs && caps.webcodecs.videoDecoder);
      if (!canDecode) {
        return { error: { code: "unsupported", message: "this device can't read video frames" } };
      }

      try {
        const clipId = validClipId(params && params.clip_id);
        // Defensive re-clamp (the relay validated & capped already, arch §8.3):
        // 1-4 finite times >= 0, in request order, duplicates collapsed.
        const seen = new Set();
        const times = [];
        const raw = Array.isArray(params && params.at_seconds) ? params.at_seconds : [];
        for (const v of raw) {
          const t = Number(v);
          if (!Number.isFinite(t) || t < 0) continue;
          const key = Math.round(t * 1000); // collapse near-identical asks
          if (seen.has(key)) continue;
          seen.add(key);
          times.push(t);
          if (times.length >= VIEW_FRAMES_MAX) break;
        }
        if (times.length === 0) {
          return { error: { code: "engine_error", message: "view_frames needs 1-4 times in seconds (>= 0)" } };
        }

        const file = await requireClipFile(clipId);
        const out = await extractFrames(file, times, {
          maxEdgePx: VIEW_FRAMES_MAX_EDGE_PX,
          quality: VIEW_FRAMES_QUALITY,
          signal,
        });
        // out = {frames:[{at_s,b64,w,h,bytes}], note?} — the exact §5 shape.
        const result = { frames: out.frames };
        if (out.note) result.note = out.note;
        return result;
      } catch (err) {
        const { message } = classifyError(err);
        dlog("warn", "bridge.view_frames.err", { message: message.slice(0, 120) });
        return { error: { code: "engine_error", message } };
      }
    },

    /* ---- apply_cuts ------------------------------------------------------ */
    async apply_cuts(params, { command }) {
      const engine = requireEngine();
      const clipId = validClipId(params && params.clip_id);
      const remove = validCutRanges(params && params.remove);
      const snap = params && params.snap === "keep" ? "keep" : "remove";
      const file = await requireClipFile(clipId);
      const outcome = await engine.applyCuts({
        clipId, file, remove, snap,
        commandId: command.command_id,
      });
      ctx.notifyEdlChange();
      return {
        applied: true,
        realized: outcome.realized,
        timeline_duration_s: round3(outcome.timeline_duration_s),
      };
    },

    /* ---- undo_last_edit -------------------------------------------------- */
    async undo_last_edit(params, { command }) {
      const engine = requireEngine();
      const outcome = await engine.undoLast({ commandId: command.command_id });
      ctx.notifyEdlChange();
      return {
        undone_op_seq: outcome.undone_op_seq,
        timeline_duration_s: round3(outcome.timeline_duration_s),
      };
    },

    /* ---- ask_user ---------------------------------------------------------
       chat.js renders the option card; the user's selection IS the bridge
       result (arch §10.7). A null answer means the card expired (turn ended /
       boot id changed / timeout) — no result is POSTed (the relay's Future
       is already gone; a late POST would just 409). */
    async ask_user(params, { command, signal }) {
      const questions = sanitizeQuestions(params && params.questions);
      if (questions.length === 0) {
        throw toolError("engine_error", "ask_user carried no answerable questions");
      }
      const answers = await ctx.askUser({ questions, command, signal });
      if (!answers) throw cancelledError("question card expired unanswered");
      return { answers };
    },

    /* =====================================================================
       M3 RENDER-TIER executors (arch §7.1). Each writes through the SAME
       store/engine surfaces the UI uses (music-ops.js) and returns the EXACT
       Step-4 result shape the relay contract documents. The relay validated +
       bounded every param; music-ops re-validates (defense in depth, the data
       owner — arch §8.3) and clamps/rejects identically. A render-territory
       change fans out to the UI ("render" edlEvent) via ctx.notifyRenderChange.

       NOTE: these tools are flag-gated OFF in the live relay (the dormant M3
       deploy); the relay never registers them while dormant, so the model
       cannot call one. They are built + verified now and turn on with the
       [render] flag at M3 integration — the executors are the device contract.
    ===================================================================== */

    /* ---- set_output_format ---------------------------------------------- */
    async set_output_format(params) {
      const result = await setOutputFormat(projectId, params || {});
      notifyRenderChange();
      return result;
    },

    /* ---- set_clip_fit --------------------------------------------------- */
    async set_clip_fit(params) {
      const result = await setClipFit(projectId, params || {});
      notifyRenderChange();
      return result;
    },

    /* ---- list_music_library --------------------------------------------- */
    async list_music_library() {
      return listMusicLibrary();
    },

    /* ---- add_music ------------------------------------------------------- */
    async add_music(params, { command }) {
      const result = await addMusic(projectId, params || {}, { commandId: command.command_id });
      ctx.notifyEdlChange();          // music is timeline data — refold preview
      notifyRenderChange();
      return result;
    },

    /* ---- update_music ---------------------------------------------------- */
    async update_music(params, { command }) {
      const result = await updateMusic(projectId, params || {}, { commandId: command.command_id });
      ctx.notifyEdlChange();
      notifyRenderChange();
      return result;
    },

    /* ---- remove_music ---------------------------------------------------- */
    async remove_music(params, { command }) {
      const result = await removeMusic(projectId, params || {}, { commandId: command.command_id });
      ctx.notifyEdlChange();
      notifyRenderChange();
      return result;
    },
  };
}

/* M3 get_inventory music summary: each folded placement joined to its track's
   title (from listTracks) so the agent reads "calm acoustic under the whole
   video" not a bare track id. */
function musicSummary(folded, tracks) {
  const byId = new Map((tracks || []).map((t) => [t.track_id, t]));
  return (folded || []).map((m) => {
    const t = byId.get(m.track_id) || null;
    return {
      music_seq: m.music_seq,
      track_id: m.track_id,
      title: (t && (t.title || t.original_name)) || null,
      source: (t && t.source) || null,
      at_s: round3(m.at_s),
      duration_s: round3(m.duration_s),
      gain_db: m.gain_db,
      duck: !!(m.duck && m.duck.enabled),
    };
  });
}

function numberOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round3(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

function isDegraded(m) {
  if (!m || m.degraded == null) return false;
  if (typeof m.degraded === "boolean") return m.degraded;
  return !!m.degraded.flag;
}

function errMsg(err) {
  return String((err && err.message) || err || "").slice(0, 200);
}

/* Device-side defensive sanitize of ask_user questions (the relay validated
   them already — arch §8.3 defense in depth; same tolerances as v1 chat.js). */
function sanitizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => q && typeof q === "object")
    .slice(0, 4)
    .map((q, qi) => ({
      header: typeof q.header === "string" && q.header ? q.header.slice(0, 12) : ("Question " + (qi + 1)),
      question: typeof q.question === "string" ? q.question : "",
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => o && typeof o === "object" && typeof o.label === "string" && o.label !== "")
        .slice(0, 4)
        .map((o) => ({
          label: o.label,
          description: typeof o.description === "string" ? o.description : "",
        })),
    }))
    .filter((q) => q.options.length >= 2);
}

/* =============================================================================
   initBridge — the connection state machine
============================================================================= */

/**
 * Open and maintain the device's bridge stream for one editor session.
 *
 * opts:
 *   project            {id, name} — the OPEN project (command binding)
 *   executors          buildExecutors(ctx) result
 *   queue              createOpQueue() — SHARED with export.js
 *   onState(state)     "connecting"|"online"|"offline"|"superseded"|"closed"
 *   onServerBootChange(bootId)  relay restarted — clear pending turn UI
 *
 * Returns { connect(), disconnect(), get state, get serverBootId }.
 */
export function initBridge({ project, executors, queue, onState, onServerBootChange }) {
  const devId = deviceId();
  let state = "closed";
  let stream = null;
  let lastEventId = null;        // per-device monotonic seq (null until hello)
  let serverBootId = null;
  let reconnectAttempt = 0;
  let reconnectTimer = 0;
  let livenessTimer = 0;
  let closed = true;

  /** command_id → {status:"executing"} | {status:"done", payload} |
      {status:"expired"} — insertion-ordered Map doubles as the LRU. */
  const dedupe = new Map();

  function setState(next) {
    if (state === next) return;
    state = next;
    dlog("info", "bridge.state", { state: next });
    try { onState && onState(next); } catch { /* UI must not break the bridge */ }
  }

  function bumpLiveness() {
    clearTimeout(livenessTimer);
    livenessTimer = setTimeout(() => {
      // 3 missed heartbeats — the connection is a zombie (iOS resume case).
      dlog("warn", "bridge.liveness.dead");
      if (stream) { stream.cancel(); stream = null; }
      scheduleReconnect();
    }, LIVENESS_TIMEOUT_MS);
  }

  function clearLiveness() { clearTimeout(livenessTimer); livenessTimer = 0; }

  function trimDedupe() {
    while (dedupe.size > DEDUPE_MAX) {
      const oldest = dedupe.keys().next().value;
      dedupe.delete(oldest);
    }
  }

  /* ---- result POST with the retry ladder (arch §3.6) ----------------------- */
  async function postResult(payload) {
    for (let attempt = 0; ; attempt++) {
      try {
        await api.post("/api/bridge/result", payload);
        return "delivered";
      } catch (err) {
        const status = err && err.name === "ApiError" ? err.status : 0;
        if (status === 409) {
          // no_pending_command — resolved/timed out/cancelled. Benign; stop.
          dlog("info", "bridge.result.409", { command_id: payload.command_id });
          return "stale";
        }
        if (status >= 400 && status < 500) {
          // A body the relay rejects will not fix itself by retrying.
          dlog("error", "bridge.result.rejected", {
            command_id: payload.command_id, status, code: err.code,
          });
          return "rejected";
        }
        if (attempt >= RESULT_RETRY_DELAYS_MS.length) {
          dlog("warn", "bridge.result.dropped", { command_id: payload.command_id });
          return "dropped";
        }
        await sleep(RESULT_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /* ---- command intake ------------------------------------------------------ */
  function handleCommand(cmd) {
    if (!cmd || typeof cmd !== "object" ||
        typeof cmd.command_id !== "string" || !COMMAND_ID_RE.test(cmd.command_id) ||
        typeof cmd.tool !== "string") {
      dlog("warn", "bridge.cmd.malformed");
      return;
    }
    const known = dedupe.get(cmd.command_id);
    if (known) {
      // Replay dedupe (arch §3.6): executing → ignore; done → re-POST cache.
      if (known.status === "done") {
        dlog("info", "bridge.cmd.replay", { command_id: cmd.command_id });
        postResult(known.payload);
      }
      return;
    }
    dedupe.set(cmd.command_id, { status: "executing" });
    trimDedupe();
    dlog("info", "bridge.cmd", { command_id: cmd.command_id, tool: cmd.tool, turn_id: cmd.turn_id });

    // project binding (arch §3.5): answered immediately, never queued — the
    // device does not hold that project open in this session.
    if (cmd.project_id !== project.id) {
      const payload = {
        device_id: devId, command_id: cmd.command_id, ok: false,
        error: {
          code: "project_mismatch",
          message: "the device has a different project open than this conversation",
        },
      };
      dedupe.set(cmd.command_id, { status: "done", payload });
      postResult(payload);
      return;
    }

    const exec = executors[cmd.tool];
    if (typeof exec !== "function") {
      // Fixed registry, no dynamic dispatch (arch §8.6).
      const payload = {
        device_id: devId, command_id: cmd.command_id, ok: false,
        error: { code: "engine_error", message: `unknown tool '${String(cmd.tool).slice(0, 64)}'` },
      };
      dedupe.set(cmd.command_id, { status: "done", payload });
      postResult(payload);
      return;
    }

    queue.run(() => runCommand(cmd, exec));
  }

  async function runCommand(cmd, exec) {
    const t0 = performance.now();
    // Self-abort signal at the relay's own deadline (arch §3.1 timeout_s):
    // hopeless work (an unanswered question) stops holding UI past the point
    // the relay would call it command_timeout anyway.
    const abort = new AbortController();
    const timeoutS = Number.isFinite(cmd.timeout_s) ? cmd.timeout_s : 120;
    const deadline = setTimeout(() => abort.abort(), Math.max(1000, timeoutS * 1000));

    let payload;
    try {
      const result = await exec(cmd.params || {}, { command: cmd, signal: abort.signal });
      payload = {
        device_id: devId,
        command_id: cmd.command_id,
        ok: true,
        result: result && typeof result === "object" ? result : {},
        duration_ms: Math.round(performance.now() - t0),
      };
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > RESULT_MAX_BYTES) {
        payload = {
          device_id: devId, command_id: cmd.command_id, ok: false,
          error: { code: "engine_error", message: "the result was too large to send" },
        };
      }
    } catch (err) {
      if (err && err.bridgeCancelled) {
        // Card expired / turn moved on — the relay's Future is gone; do not
        // POST (it would only 409). Replay of this id is ignored.
        dedupe.set(cmd.command_id, { status: "expired" });
        clearTimeout(deadline);
        return;
      }
      const { code, message } = classifyError(err);
      dlog("warn", "bridge.cmd.err", { command_id: cmd.command_id, tool: cmd.tool, code });
      payload = {
        device_id: devId, command_id: cmd.command_id, ok: false,
        error: { code, message },
        duration_ms: Math.round(performance.now() - t0),
      };
    } finally {
      clearTimeout(deadline);
    }
    dedupe.set(cmd.command_id, { status: "done", payload });
    trimDedupe();
    await postResult(payload);
  }

  /* ---- stream lifecycle ----------------------------------------------------- */
  function openStream() {
    if (closed || stream) return;
    setState(state === "online" ? "online" : "connecting");
    stream = sseRequest(
      "/api/bridge/events?device_id=" + encodeURIComponent(devId),
      {
        lastEventId,
        onOpen() { bumpLiveness(); },
        onComment(text) {
          bumpLiveness();
          if (text === "superseded") {
            // Another window with this device_id took over (arch §2.3 newest
            // wins). STOP reconnecting — auto-reconnect would ping-pong the
            // two streams forever. Returning to this tab resumes (below).
            dlog("warn", "bridge.superseded");
            if (stream) { stream.cancel(); stream = null; }
            clearLiveness();
            setState("superseded");
          }
        },
        onEvent(event, data, meta) {
          bumpLiveness();
          if (meta && meta.id != null) {
            const n = parseInt(meta.id, 10);
            if (Number.isFinite(n)) lastEventId = n;
          }
          if (event === "hello") {
            reconnectAttempt = 0;
            const boot = data && data.server_boot_id;
            if (typeof boot === "string") {
              if (serverBootId !== null && serverBootId !== boot) {
                // Relay restarted: every relay-side Future died with it.
                dlog("warn", "bridge.boot.changed", { from: serverBootId, to: boot });
                try { onServerBootChange && onServerBootChange(boot); } catch { /* ignore */ }
              }
              serverBootId = boot;
            }
            dlog("info", "bridge.hello", {
              boot, replayed: data && data.replayed, last_event_id: lastEventId,
            });
            setState("online");
          } else if (event === "command") {
            handleCommand(data);
          } else if (event === "error") {
            // In-stream error frame (e.g. too_many_devices race) — stream ends.
            dlog("error", "bridge.stream.err", { code: data && data.code });
          }
        },
        onError(err) {
          dlog("warn", "bridge.stream.fail", { status: err && err.status, code: err && err.code });
        },
        onClose() {
          clearLiveness();
          stream = null;
          if (closed || state === "superseded") return;
          scheduleReconnect();
        },
      },
    );
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer || state === "superseded") return;
    setState("offline");
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      openStream();
    }, delay);
  }

  function onVisible() {
    if (document.visibilityState !== "visible" || closed) return;
    if (state === "superseded") {
      // The user came back to THIS window — take the stream over (newest wins).
      setState("connecting");
      openStream();
    } else if (!stream && !reconnectTimer) {
      openStream();
    }
  }
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);

  return {
    get state() { return state; },
    get serverBootId() { return serverBootId; },
    get deviceId() { return devId; },
    connect() {
      if (!closed) return;
      closed = false;
      reconnectAttempt = 0;
      openStream();
    },
    disconnect() {
      closed = true;
      clearTimeout(reconnectTimer); reconnectTimer = 0;
      clearLiveness();
      if (stream) { stream.cancel(); stream = null; }
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      setState("closed");
    },
  };
}
