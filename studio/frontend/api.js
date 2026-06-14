/* =============================================================================
   api.js — the single network seam for video-use Studio.
   -----------------------------------------------------------------------------
   Responsibilities:
     * Authentication transport — COOKIE SESSION only.
       POST /api/login sets an httpOnly `studio_session` cookie; the browser
       replays it automatically on every same-origin request when fetch uses
       `credentials: "same-origin"` (and EventSource uses `withCredentials`).
       GET /api/me reports {authenticated, username}. The backend enforces the
       cookie exclusively — there is no header/query token to send.
       Media (<video>/<img>) and SSE inherit the same-origin cookie too, so no
       credential ever needs to ride in a URL (which would leak into access logs).
     * JSON requests with uniform error normalization to the contract shape
       `{ error: { code, message, detail } }`.
     * SSE helpers: a POST-streamed-body reader (primary chat transport) and a
       generic EventSource opener (transcribe progress).
     * Media URL building (bare path; the cookie authenticates the request).

   Pure consumer of /api/* — holds no secret of any kind.
============================================================================= */

/** Build a media URL for a server-side absolute path via GET /api/file.
    No credential in the URL: <video>/<img>/fetch send the same-origin
    `studio_session` cookie automatically. */
export function fileUrl(absPath) {
  return "/api/file?path=" + encodeURIComponent(absPath);
}

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

async function normalizeError(res) {
  let code = "http_error";
  let message = "Request failed (HTTP " + res.status + ")";
  let detail;
  try {
    const body = await res.json();
    // FastAPI wraps deps.http_error() bodies as {"detail": {"error": {...}}},
    // so the contract envelope arrives NESTED. Unwrap it first; otherwise every
    // contract error would collapse to the generic "http_error" and err.detail
    // would be lost — breaking code-specific branches downstream
    // (e.g. panel.js `err.code === "job_in_flight"` / `err.detail.job_id`).
    const nested = body && body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? body.detail.error
      : undefined;
    if (nested && typeof nested === "object") {
      // Nested contract envelope: {"detail": {"error": {code, message, detail}}}.
      code = nested.code || code;
      message = nested.message || message;
      detail = nested.detail;
    } else if (body && typeof body.error === "object" && body.error !== null) {
      // Top-level contract envelope: {"error": {code, message, detail}}.
      code = body.error.code || code;
      message = body.error.message || message;
      detail = body.error.detail;
    } else if (body && typeof body.error === "string" && body.error) {
      // String error, e.g. POST /api/login -> {"ok": false, "error": "invalid credentials"}.
      message = body.error;
    } else if (body && typeof body.detail === "string" && body.detail) {
      // Plain string detail, e.g. {"detail": "Not Found"}.
      message = body.detail;
    }
    // FastAPI validation errors arrive as {"detail": [ {..} ]} (array) — none of
    // the branches above match, so we keep the generic message without crashing.
  } catch { /* non-JSON error body */ }
  return new ApiError(res.status, code, message, detail);
}

/* ----- core JSON request ---------------------------------------------------- */
async function request(method, path, { body, headers, signal, raw } = {}) {
  const opts = {
    method,
    credentials: "same-origin",   // send the httpOnly studio_session cookie automatically
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
    throw new ApiError(0, "network", "Cannot reach the Studio server. Is it running?");
  }
  if (!res.ok) throw await normalizeError(res);
  if (raw) return res;
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  try {
    return ct.includes("application/json") ? await res.json() : await res.text();
  } catch (err) {
    // BODY-READ GUARD (2026-06-10 incident fix). A fetch can SUCCEED — status
    // 200, headers in — and the body read still fail: the connection dies (or a
    // reload kills a hung response) between headers and body, and res.json()
    // rejects with a raw TypeError ("Load failed" on iOS Safari). That raw
    // TypeError escaped this seam un-normalized, so upload.js classified it
    // PERMANENT (not an ApiError) → zero retries, no Resume — a dead row for a
    // chunk the server had already committed. Post-fetch read failures are
    // network failures: normalize them to the same transient, retryable
    // ApiError(0, "network") the fetch guard above produces. This also folds in
    // truncated/malformed JSON on a 2xx — indistinguishable from a torn body,
    // and our backend never emits invalid JSON on success. An AbortError
    // (user-cancel / watchdog abort mid-read) passes through untouched so the
    // cancel path keeps its short-circuit identity.
    //
    // Coverage note for the streaming paths below: streamPost() needs no new
    // guard — its fetch, its !res.ok normalizeError() (internally try/caught),
    // and its reader.read() loop ALL already convert non-abort failures into
    // ApiError(0, "network"/"stream") via onError. normalizeError()'s own
    // res.json() sits inside try/catch by design. openEventSource() is
    // EventSource (auto-reconnect; no body read to guard). raw:true responses
    // hand the un-read Response to the caller on purpose (media probing) —
    // guarding there would change streaming semantics, so they are exempt.
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Connection dropped while receiving the server's reply.");
  }
}

export const api = {
  get:    (p, o) => request("GET", p, o),
  post:   (p, body, o) => request("POST", p, { ...o, body }),
  put:    (p, body, o) => request("PUT", p, { ...o, body }),
  del:    (p, o) => request("DELETE", p, o),
  raw:    (p, o) => request("GET", p, { ...o, raw: true }),
  request,
};

/* =============================================================================
   AUTH
============================================================================= */

/** GET /api/me — the auth gate. Resilient if the endpoint isn't present yet.
    Returns {authenticated, username, staleSessions, source}. `staleSessions` is
    the count of the caller's sessions idle past the stale threshold (drives the
    post-login Keep/Delete modal); it's a best-effort hint — the authoritative
    list comes from GET /api/sessions. */
export async function getMe() {
  try {
    const r = await api.get("/api/me");
    return {
      authenticated: !!(r && r.authenticated),
      username: r && r.username,
      staleSessions: r && typeof r.stale_sessions === "number" ? r.stale_sessions : 0,
      source: "me",
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { authenticated: false, staleSessions: 0, source: "me" };
    }
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      // Backend has no /api/me on this build → probe /api/status with the cookie.
      // 2xx means the session cookie is accepted (or no auth layer is enforced);
      // 401 means we are not authenticated. No token is ever involved.
      try {
        await api.get("/api/status");
        return { authenticated: true, staleSessions: 0, source: "status", fallback: true };
      } catch (e2) {
        if (e2 instanceof ApiError && e2.status === 401) return { authenticated: false, staleSessions: 0, source: "status", fallback: true };
        throw e2;
      }
    }
    throw err;
  }
}

export function login(username, password, remember) {
  return api.post("/api/login", { username, password, remember: !!remember });
}

/* =============================================================================
   SESSIONS — per-user, user-owned, upload-only projects
   -----------------------------------------------------------------------------
   A session is a project the signed-in user creates, owns, uploads videos into,
   and edits. Users only ever see/open/delete their own (the backend scopes every
   call to the cookie's username). Folder browsing is GONE — the active editing
   target is a session id, and its absolute on-disk directory (`dir`) comes back
   only from /open and is used by chat.js to resolve "edit/…" artifacts.

   Contract (FROZEN):
     GET    /api/sessions
       -> { sessions: [ { id, name, created_at, last_touched_at, age_days,
                          media_count, stale } ], stale: [id] }
     POST   /api/sessions { name }
       -> 201 { id, name, created_at, last_touched_at }
          409/400 { detail:{ error:{ code:"invalid_name" } } }  (name taken / bad)
     POST   /api/sessions/{id}/open
       -> { id, name, created_at, last_touched_at, dir:<absolute session dir> }
          (TOUCHES the session — resets its idle clock)
     POST   /api/sessions/{id}/keep   -> { ok:true, last_touched_at }
     DELETE /api/sessions/{id}        -> { ok:true }
     404 { detail:{ error:{ code:"session_not_found" } } } for any missing/not-owned id.
============================================================================= */

/** List the signed-in user's sessions (+ the ids the backend flags as stale). */
export function listSessions() {
  return api.get("/api/sessions");
}

/** Create a new session. 409/400 surface as ApiError(code:"invalid_name"). */
export function createSession(name) {
  return api.post("/api/sessions", { name });
}

/** Open a session → returns its absolute `dir` (for artifact resolution) and
    touches it. 404 surfaces as ApiError(code:"session_not_found"). */
export function openSession(id) {
  return api.post("/api/sessions/" + encodeURIComponent(id) + "/open", {});
}

/** Keep a (stale) session — resets its idle clock so it isn't flagged again. */
export function keepSession(id) {
  return api.post("/api/sessions/" + encodeURIComponent(id) + "/keep", {});
}

/** Delete a session and everything in it (the caller confirms first). */
export function deleteSession(id) {
  return api.del("/api/sessions/" + encodeURIComponent(id));
}

/* =============================================================================
   INTERACTIVE QUESTIONS — answer an agent ask_user prompt
   -----------------------------------------------------------------------------
   When a chat turn streams an `ask_user` SSE event, the user's choice is sent
   back via a NORMAL (non-streamed) POST to /api/chat/answer so the paused turn
   can continue. Cookie-auth like every other call (credentials:"same-origin").

   Contract:
     POST /api/chat/answer
       { turn_id, question_id, session_id,
         answers: [ { header, selected: [str], other_text: str|null } ] }
     200 -> { ok: true }
     409 -> { error: { code: "no_pending_question" } }  (turn already moved on)

   On 409 the backend envelope is unwrapped by `request`/`normalizeError` into an
   ApiError, so callers detect the expired question via `err.code ===
   "no_pending_question"` (never by reading the raw body). Any other failure
   throws an ApiError too, so a single try/catch at the call site covers both. */
export function answerQuestion(turn_id, question_id, answers, session_id) {
  return api.post("/api/chat/answer", { turn_id, question_id, answers, session_id });
}

export async function logout() {
  // The server clears the httpOnly studio_session cookie; nothing client-side to wipe.
  try { await api.post("/api/logout", {}); } catch { /* best-effort */ }
}

/* =============================================================================
   SSE — POST streamed body reader (primary chat transport)
   -----------------------------------------------------------------------------
   EventSource cannot POST or set headers, so for /api/chat we use fetch() with a
   ReadableStream reader and parse the `event:`/`data:` frames ourselves.
   Returns a controller with .cancel().
============================================================================= */
export function streamPost(path, body, { onEvent, onError, onClose, signal } = {}) {
  const ctrl = new AbortController();
  if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });

  (async () => {
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",   // replays the studio_session cookie
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
          if (parsed) onEvent && onEvent(parsed.event, parsed.data);
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
  const dataLines = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine;
    if (!line || line.startsWith(":")) continue;     // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? "" : line.slice(colon + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") event = val;
    else if (field === "data") dataLines.push(val);
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  let data;
  try { data = JSON.parse(dataStr); } catch { data = dataStr; }
  return { event, data };
}

/* =============================================================================
   SSE — EventSource (transcribe progress)
   -----------------------------------------------------------------------------
   `withCredentials: true` makes the browser attach the same-origin
   studio_session cookie to the SSE request — no token in the URL.
============================================================================= */
export function openEventSource(path, handlers = {}) {
  const es = new EventSource(path, { withCredentials: true });
  for (const [type, fn] of Object.entries(handlers)) {
    if (type === "onError") { es.onerror = (e) => fn(e); continue; }
    es.addEventListener(type, (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { data = ev.data; }
      fn(data, ev);
    });
  }
  return es;
}
