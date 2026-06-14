/* =============================================================================
   api.js — the single network seam for Studio v2.
   -----------------------------------------------------------------------------
   Responsibilities:
     * Authentication transport — COOKIE SESSION only (arch §2.1).
       POST /api/login sets an httpOnly cookie (`__Host-studio2_session` on
       https, `studio2_session` on http — server-side concern); the browser
       replays it automatically when fetch uses `credentials:"same-origin"`
       (and EventSource uses `withCredentials`). No header/query token, ever.
     * JSON requests with uniform error normalization to ApiError
       {status, code, message, detail} — the v1 envelope contract
       `{detail:{error:{code,message,detail}}}` unwrapped via normalizeError.
     * OFFLINE vs SIGNED-OUT is a first-class distinction (arch §7.5):
       connectivity failures are ApiError(status 0, code "network") — callers
       branch offline-banner vs login-view on that, never on a guess.
     * SSE helper per the arch §2.2 framing: streamPost (SSE-over-POST body
       reader for /api/chat — EventSource cannot POST). Parses `event:` /
       `data:` / `id:` fields. The persistent BRIDGE stream does NOT live
       here: bridge.js owns it (`sseRequest`, fetch-based so `: superseded`
       comments are observable — the documented Step-5 transport deviation).

   Pure consumer of /api/* — holds no secret of any kind.
============================================================================= */

/* ----- error type ----------------------------------------------------------- */
export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message || code || ("HTTP " + status));
    this.name = "ApiError";
    this.status = status;
    this.code = code || "http_error";
    this.detail = detail;
  }
}

/** True for connectivity-class failures (no HTTP response existed). Exported
    so view modules can branch offline-vs-error without instanceof checks
    (instanceof would break across the documented ?v=/bare double-load seam). */
export function isNetworkError(err) {
  return !!(err && err.name === "ApiError" && err.status === 0 &&
    (err.code === "network" || err.code === "stream" || err.code === "timeout"));
}

async function normalizeError(res) {
  let code = "http_error";
  let message = "Request failed (HTTP " + res.status + ")";
  let detail;
  try {
    const body = await res.json();
    // FastAPI wraps contract bodies as {"detail": {"error": {...}}} — the
    // envelope arrives NESTED. Unwrap it first; otherwise every contract error
    // would collapse to the generic "http_error" and err.detail would be lost.
    const nested = body && body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? body.detail.error
      : undefined;
    if (nested && typeof nested === "object") {
      code = nested.code || code;
      message = nested.message || message;
      detail = nested.detail;
    } else if (body && typeof body.error === "object" && body.error !== null) {
      // Top-level contract envelope: {"error": {code, message, detail}}.
      code = body.error.code || code;
      message = body.error.message || message;
      detail = body.error.detail;
    } else if (body && typeof body.error === "string" && body.error) {
      // String error, e.g. {"ok": false, "error": "invalid credentials"}.
      message = body.error;
    } else if (body && typeof body.detail === "string" && body.detail) {
      // Plain string detail, e.g. {"detail": "Not Found"}.
      message = body.detail;
    }
    // FastAPI validation errors arrive as {"detail":[{..}]} (array) — none of
    // the branches above match, so we keep the generic message without crashing.
  } catch { /* non-JSON error body */ }
  return new ApiError(res.status, code, message, detail);
}

/* ----- core JSON request ---------------------------------------------------- */
async function request(method, path, { body, headers, signal, raw } = {}) {
  const opts = {
    method,
    credentials: "same-origin",   // send the httpOnly session cookie automatically
    headers: { ...(headers || {}) },
    signal,
  };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      opts.body = body;
    } else {
      opts.body = JSON.stringify(body);
      opts.headers["Content-Type"] = "application/json";
    }
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Cannot reach Studio. Check the connection.");
  }
  if (!res.ok) throw await normalizeError(res);
  if (raw) return res;
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  try {
    return ct.includes("application/json") ? await res.json() : await res.text();
  } catch (err) {
    // 2xx BODY-READ GUARD (v1 incident fix, kept verbatim): a fetch can
    // SUCCEED — status 200, headers in — and the body read still fail (the
    // connection dies between headers and body; iOS Safari surfaces a raw
    // TypeError "Load failed"). Post-fetch read failures are NETWORK failures:
    // normalize them to the same transient ApiError(0,"network") the fetch
    // guard above produces, so callers classify them transient/offline instead
    // of crashing or treating them as permanent. An AbortError passes through
    // untouched so cancel paths keep their short-circuit identity. raw:true
    // responses hand the un-read Response to the caller on purpose and are
    // exempt; streamPost below has its own equivalent guards.
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Connection dropped while receiving the reply.");
  }
}

export const api = {
  get:    (p, o) => request("GET", p, o),
  post:   (p, body, o) => request("POST", p, { ...o, body }),
  del:    (p, o) => request("DELETE", p, o),
  raw:    (p, o) => request("GET", p, { ...o, raw: true }),
  request,
};

/* =============================================================================
   TRANSCRIBE (M2) — the one media upload, plus its poll/cancel/status helpers.
   -----------------------------------------------------------------------------
   The upload is the architecture's ONE deliberate byte-leaves-device exception
   (arch §3.1, §8.1): a clip's audio-only `.m4a`, streamed as a RAW request body
   — NOT multipart (the relay's "no parsing surface" property, arch §8.3). The
   Blob/File is sent verbatim with `Content-Type: audio/mp4`; the device built
   the body, so there is nothing for the server to parse.

   All four helpers ride the same cookie auth + error-envelope normalization as
   the rest of api.js. No XHR and no granular upload progress: a fetch Blob body
   gives no upload-progress events, so transcribe.js shows an honest
   indeterminate "sending…" state (arch §1.2 PWA api.js note).
============================================================================= */

/**
 * POST a clip's audio `.m4a` as a streamed RAW body → 202 {job_id, est_cost_usd}.
 *
 * @param {Blob}    blob      the extracted `.m4a` (read back from the committed
 *                            `.tmp` — see transcribe.js). Sent as the body verbatim.
 * @param {Object}  q         query params: {project_id, clip_id, duration_s,
 *                            language?}. `duration_s` MUST be the EXTRACTED
 *                            audio's duration (engine/audio.js result.durationS),
 *                            not clipmeta's video duration (arch §5.1 — they
 *                            differ by the AAC priming offset).
 * @param {Object} [opts]     {signal} — an AbortSignal to cancel the upload
 *                            (a mid-upload abort is a clean 499, no EL call).
 * @returns {Promise<{job_id:string, est_cost_usd:number}>}
 * @throws  {ApiError}        normalized envelope (400/401/403/409/413/429/499/502)
 *                            or ApiError(0,"network") on connectivity failure.
 */
export async function uploadTranscribeAudio(blob, q, { signal } = {}) {
  if (!(blob instanceof Blob)) {
    throw new ApiError(0, "client_error", "a Blob/File audio body is required");
  }
  const params = new URLSearchParams({
    project_id: String(q && q.project_id),
    clip_id: String(q && q.clip_id),
    duration_s: String(q && q.duration_s),
  });
  if (q && typeof q.language === "string" && q.language) {
    params.set("language", q.language);
  }
  // Raw body, audio/mp4 — request() forwards a Blob as the body untouched and
  // does NOT set Content-Type for blobs, so we set it explicitly here.
  return request("POST", "/api/transcribe?" + params.toString(), {
    body: blob,
    headers: { "Content-Type": "audio/mp4" },
    signal,
  });
}

/**
 * Poll a transcription job (arch §3.2). Returns the raw poll body:
 *   {status:"transcribing", stage, elapsed_s}
 * | {status:"done", transcript:{…§4.2…}, est_cost_usd}
 * | {status:"error", error:{code, message}}
 * A 404 (unknown/expired/foreign/post-restart) surfaces as ApiError(404,
 * "job_not_found") — the caller renders the honest "studio brain restarted"
 * copy. Network failure → ApiError(0,"network"); the poll loop keeps retrying.
 */
export function pollTranscribe(jobId, { signal } = {}) {
  return api.get("/api/transcribe/" + encodeURIComponent(String(jobId)), { signal });
}

/**
 * Best-effort cancel of a transcription job (arch §3.3) → {cancelled:bool}.
 * A 404 means the job is already gone (treated as cancelled by the caller).
 */
export function cancelTranscribe(jobId, { signal } = {}) {
  return api.del("/api/transcribe/" + encodeURIComponent(String(jobId)), { signal });
}

/**
 * GET /api/status and return the transcribe gate (arch §3.5). The Transcribe
 * affordance is enabled only when configured && enabled && daily_remaining
 * .calls > 0. Connectivity/other failures resolve to a safe disabled shape so
 * the caller never has to try/catch the gate.
 *
 * @returns {Promise<{configured:boolean, enabled:boolean,
 *                    daily_remaining:{calls:number, audio_mib:number},
 *                    reachable:boolean}>}
 */
export async function transcribeStatus({ signal } = {}) {
  try {
    const r = await api.get("/api/status", { signal });
    const t = (r && typeof r.transcribe === "object" && r.transcribe) || {};
    const rem = (t.daily_remaining && typeof t.daily_remaining === "object") ? t.daily_remaining : {};
    return {
      configured: !!t.configured,
      enabled: !!t.enabled,
      daily_remaining: {
        calls: Number.isFinite(rem.calls) ? rem.calls : 0,
        audio_mib: Number.isFinite(rem.audio_mib) ? rem.audio_mib : 0,
      },
      reachable: true,
    };
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return {
      configured: false,
      enabled: false,
      daily_remaining: { calls: 0, audio_mib: 0 },
      reachable: false,
    };
  }
}

/* =============================================================================
   AUTH (arch §2.1)
============================================================================= */

/** GET /api/me — the auth gate. Public endpoint; returns
    {authenticated, username?, asset_version, secure_url}.
    IMPORTANT: connectivity failures THROW (ApiError status 0) — the caller
    must distinguish "offline" (projects still work, chat doesn't) from
    "signed out" (login view). Never collapse the two. */
export async function getMe() {
  const r = await api.get("/api/me");
  return {
    authenticated: !!(r && r.authenticated),
    username: (r && r.username) || null,
    assetVersion: r && r.asset_version != null ? r.asset_version : null,
    secureUrl: (r && typeof r.secure_url === "string") ? r.secure_url : null,
  };
}

export function login(username, password, remember) {
  return api.post("/api/login", { username, password, remember: !!remember });
}

export async function logout() {
  // The server clears the httpOnly cookie(s); nothing client-side to wipe.
  try { await api.post("/api/logout", {}); } catch { /* best-effort */ }
}

/* =============================================================================
   AGENT MODEL PICKER (global) — GET/POST /api/agent/model
   -----------------------------------------------------------------------------
   The model is an APP-WIDE setting shared by both users (PM decision: GLOBAL,
   not per-user/per-project). These two helpers are the only client surface:
     GET  → {current:"<id>"|"default", available:[{id,label,hint}],
             applies_to:"new conversations"}
     POST → {model} → {current, available}; 400 `invalid_model` on a bad id.
   Cookie auth like everything else here; both normalize errors through the
   shared envelope, so a 400 surfaces as ApiError(400,"invalid_model",…) and a
   connectivity failure as ApiError(0,"network") (callers branch on
   isNetworkError). The returned shapes are normalized to a stable contract so
   settings.js never has to defensively probe missing fields.
============================================================================= */

/** Shape one model row to a stable {id, label, hint}; drops anything without a
    string id (the picker is allowlist-driven — an id-less row is meaningless). */
function normalizeModelRow(row) {
  if (!row || typeof row.id !== "string" || !row.id) return null;
  return {
    id: row.id,
    label: typeof row.label === "string" && row.label ? row.label : row.id,
    hint: typeof row.hint === "string" ? row.hint : "",
  };
}

function normalizeModelPayload(r) {
  const available = Array.isArray(r && r.available)
    ? r.available.map(normalizeModelRow).filter(Boolean)
    : [];
  return {
    current: (r && typeof r.current === "string" && r.current) ? r.current : "default",
    available,
    appliesTo: (r && typeof r.applies_to === "string" && r.applies_to)
      ? r.applies_to
      : "new conversations",
  };
}

/**
 * GET /api/agent/model — the picker's source of truth.
 * @param {Object} [opts] {signal} — an AbortSignal (settings.js cancels a
 *                         pending GET when the sheet closes before it resolves).
 * @returns {Promise<{current:string, available:Array<{id,label,hint}>, appliesTo:string}>}
 * @throws  {ApiError}    401 (auth), 0/"network" (offline) — never swallowed:
 *                         the indicator/sheet decide what to show on failure.
 */
export async function getAgentModel({ signal } = {}) {
  return normalizeModelPayload(await api.get("/api/agent/model", { signal }));
}

/**
 * POST /api/agent/model {model} — persist the global model choice.
 * @param {string}  model   an id from the GET `available` list, or "default".
 * @param {Object} [opts]   {signal}.
 * @returns {Promise<{current:string, available:Array<{id,label,hint}>, appliesTo:string}>}
 * @throws  {ApiError}      400 "invalid_model" on an out-of-allowlist id;
 *                          401 auth; 0/"network" offline.
 */
export async function setAgentModel(model, { signal } = {}) {
  return normalizeModelPayload(
    await api.post("/api/agent/model", { model: String(model) }, { signal }),
  );
}

/* =============================================================================
   SSE — POST streamed-body reader (chat transport, arch §2.2)
   -----------------------------------------------------------------------------
   EventSource cannot POST, so /api/chat is fetch() + a ReadableStream reader
   parsing `event:` / `data:` / `id:` frames ourselves. Every chat frame
   carries `id: <seq>` (the turn-survival buffer's replay cursor) — it is
   surfaced to onEvent as meta.id so Step 5's chat.js can resume via
   GET /api/chat/attach?after_seq=. Returns a controller with .cancel().
============================================================================= */
export function streamPost(path, body, { onEvent, onError, onClose, signal } = {}) {
  const ctrl = new AbortController();
  if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });

  (async () => {
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",   // replays the session cookie
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err.name !== "AbortError") onError && onError(new ApiError(0, "network", "Lost connection to Studio."));
      onClose && onClose();
      return;
    }

    if (!res.ok) {
      onError && onError(await normalizeError(res));
      onClose && onClose();
      return;
    }
    if (!res.body) {
      onError && onError(new ApiError(0, "no_stream", "Server did not return a stream."));
      onClose && onClose();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        // Frames are separated by a blank line. Handle \n\n and \r\n\r\n.
        while ((idx = indexOfFrameBreak(buf)) !== -1) {
          const frame = buf.slice(0, idx.at);
          buf = buf.slice(idx.at + idx.len);
          const parsed = parseFrame(frame);
          if (parsed) onEvent && onEvent(parsed.event, parsed.data, { id: parsed.id });
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") onError && onError(new ApiError(0, "stream", "Stream interrupted."));
    } finally {
      onClose && onClose();
    }
  })();

  return { cancel: () => ctrl.abort() };
}

function indexOfFrameBreak(s) {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1 && b === -1) return -1;
  if (a === -1) return { at: b, len: 4 };
  if (b === -1) return { at: a, len: 2 };
  return a < b ? { at: a, len: 2 } : { at: b, len: 4 };
}

function parseFrame(frame) {
  let event = "message";
  let id = null;
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;     // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? "" : line.slice(colon + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") event = val;
    else if (field === "data") dataLines.push(val);
    else if (field === "id") id = val;
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  let data;
  try { data = JSON.parse(dataStr); } catch { data = dataStr; }
  return { event, data, id };
}
