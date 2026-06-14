/* =============================================================================
   upload.js — chunked + resumable uploader (phone + desktop).
   -----------------------------------------------------------------------------
   Three-phase protocol:
     POST /api/upload/init      → { upload_id, chunk_size, total_chunks, received[] }
     PUT  /api/upload/{id}/chunk?index=n  (raw bytes; idempotent re-PUT)
     GET  /api/upload/{id}/status (resume reconciliation)
     POST /api/upload/{id}/complete
     DELETE /api/upload/{id}    (EXPLICIT USER CANCEL ONLY — never on failure)

   Uploads go INTO the active SESSION: /api/upload/init takes `session_id`.

   ── RESILIENCE (the phone-upload contract) ─────────────────────────────────
   • Per-chunk RETRY with exponential backoff + jitter (~1s→2s→4s→8s→15s, up to
     6 attempts) on network errors, the resumable 499 `client_disconnected`,
     and 5xx. Other 4xx fail fast. The init POST gets the same retry (it is
     idempotent under the client_id contract below). `complete` is single-shot;
     a failed complete is recovered via the Resume affordance.
     2026-06-10: UNKNOWN (non-ApiError) errors — e.g. a raw TypeError from a
     torn network read — are TRANSIENT by default (retry + Resume); ONLY
     AbortError stays permanent, preserving the user-cancel short-circuit.
   • Per-chunk STALL WATCHDOG (2026-06-10, the live-incident fix): a hung PUT
     whose response never arrives can't throw, so retries never fired. Each
     attempt arms a timer (≥90s, scaled to chunk size — see chunkTimeoutMs);
     on expiry the attempt's own AbortController aborts the fetch and the
     failure is classified as a transient timeout (`up.chunk.timeout` diag
     event) so the normal backoff retries it — the server-side chunk is
     already committed, so the re-PUT is an instant idempotent 200.
   • STABLE client_id per file (derived from name+size+lastModified, charset
     [a-f0-9], 17 chars) sent on every init. If a live upload matches
     (user+session+client_id+filename+size+chunk_size) the server returns the
     SAME upload_id with `received: [...]` — those chunks are SKIPPED. After a
     server restart that state is gone and init transparently starts fresh.
   • NEVER DELETE server state on a transient failure (that destroyed resume
     state and is why phone uploads could never finish). DELETE fires only on
     the explicit Cancel tap. Dismissing a failed row leaves server state for
     the backend's orphan GC / a later re-pick resume.
   • CANCEL ORDERING (race fix): explicit Cancel (a) ABORTS the in-flight
     fetch via the run's AbortController, (b) AWAITS the run settling, and
     only (c) THEN sends the DELETE. Firing DELETE while a chunk PUT was still
     streaming left the server-side file handle blocking dir cleanup and the
     late chunk re-created the part dir. Abort short-circuits retry/backoff
     (an AbortError is not transient), and any error after a user cancel —
     including the backend's 404 `upload_not_found` on a raced chunk — is
     swallowed silently (the row already shows "Cancelled.").
   • Terminal failure keeps the row with a visible error + a RESUME button
     that re-runs the state machine: it reconciles via GET /status when the
     upload_id is still known, else re-inits with the same client_id. If the
     page was reloaded (File object lost), re-picking the same file derives the
     same client_id and resumes the server-side partial state.
   • Screen WAKE LOCK while any upload is active (re-acquired on
     visibilitychange, released when the last upload settles). Feature-detected;
     whenever an active upload is NOT actually protected by a held lock
     (API absent — e.g. iOS over plain HTTP, a non-secure context — or the
     acquire was denied) a persistent inline notice shows above the progress
     rows: "Keep the screen on and stay in this tab until the upload
     finishes." It clears when uploads settle or a lock is acquired. The
     notice carries an inline link to /setup (the one-time secure-address
     flow, 2026-06-11) — on the https origin Wake Lock works and the notice
     never shows. The link opens in a NEW tab so it can't kill the very
     upload it appears next to.

   Critical: slice the File LAZILY per chunk (file.slice) — never read the whole
   file into memory (mobile Safari/Chrome will OOM on multi-GB clips).
   Validation mirrors the helper allowlist exactly: .mp4 .mov .mkv .avi .m4v.
============================================================================= */

import { api, ApiError } from "./api.js";
import { byId, el, icon, toast, fmtBytes, basename } from "./util.js";

const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".avi", ".m4v"];
const MAX_BYTES = 8 * 1024 ** 3;           // 8 GiB (mirror of server default)
const DEFAULT_CHUNK = 8 * 1024 * 1024;     // 8 MiB

const CONTENT_TYPES = {
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
};

/* Backoff schedule between retry attempts (so up to 6 attempts total per call).
   Each wait gets ±25% jitter so parallel uploads don't retry in lockstep. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/* ---- per-chunk stall watchdog (2026-06-10 incident fix) ---------------------
   The live failure: the server COMMITS a chunk and responds 200, but the
   response never reaches the page's JS — the PUT just hangs forever. Retries
   only fire on a THROWN error, so a silently hung fetch defeated the whole
   retry machinery. Each chunk ATTEMPT therefore arms a timer; on expiry the
   attempt's fetch is aborted and classified as a transient timeout, and the
   existing backoff retries it. The numbers:
     • floor 90s — generous headroom over any sane same-LAN/cellular round trip,
       and the plan's stated floor; small (final) chunks land here.
     • scale: chunk_bytes / 128 KiB/s (≈1 Mbit/s sustained uplink — about the
       slowest link this 8 GiB-class video pipeline is usable on) + 30s grace
       for server fsync/commit + response latency on a congested link.
       An 8 MiB chunk ⇒ max(90s, 64s + 30s) = 94s, inside the plan's 90–120s.
   Bias is deliberately toward firing EARLY: a premature abort is cheap (chunk
   PUTs are idempotent — a re-PUT of a committed chunk is an instant 200), while
   a late one means minutes of silent hang. Links slower than the budget will
   occasionally re-send a chunk and still make forward progress; retries +
   Resume cover the pathological cases. */
const CHUNK_STALL_FLOOR_MS = 90_000;
const CHUNK_STALL_BYTES_PER_SEC = 128 * 1024;
const CHUNK_STALL_GRACE_MS = 30_000;

function chunkTimeoutMs(bytes) {
  const transferMs = Math.ceil((bytes / CHUNK_STALL_BYTES_PER_SEC) * 1000);
  return Math.max(CHUNK_STALL_FLOOR_MS, transferMs + CHUNK_STALL_GRACE_MS);
}

/* ---- diagnostics shim -------------------------------------------------------
   Forward lifecycle events to the diag logger (diag.js, loaded ONCE by app.js,
   versioned, published on window.__studioDiag). Deliberately NOT an import:
   a bare `import "./diag.js"` from this ?v-versioned module would create a
   SECOND diag module instance (the documented api.js double-load trap). The
   shim is a silent no-op when diag is absent — uploads NEVER depend on
   logging, and logging can never break an upload. */
function dlog(level, msg, data) {
  try {
    const d = window.__studioDiag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* diagnostics must never interfere */ }
}

/* Compact, cap-safe error descriptor for diag data (code/status for ApiError,
   name + short message otherwise — never a full stack, never a URL). */
function errMeta(err) {
  if (err instanceof ApiError) return { code: err.code, status: err.status };
  return {
    code: (err && err.name) || "error",
    message: String((err && err.message) || err || "").slice(0, 200),
  };
}

/* ---- stable per-file client id ---------------------------------------------
   Deterministic from the file's identity (name + size + lastModified) so the
   SAME file always yields the SAME id — across retries, Resume taps, and even
   a page reload + re-pick. Two independent 32-bit hashes → 17 chars [a-f0-9],
   inside the server's [A-Za-z0-9_-]{8,64} contract. Not cryptographic — it
   only needs to be stable and collision-unlikely within one user's session. */
function clientIdFor(file) {
  const key = `${file.name}|${file.size}|${file.lastModified || 0}`;
  let h1 = 0x811c9dc5;        // FNV-1a
  let h2 = 0x12345679;        // murmur-ish mix
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x5bd1e995) + (h2 >>> 13)) >>> 0;
  }
  return "c" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/* ---- transient-vs-permanent error classification --------------------------- */
function isTransient(err) {
  if (!(err instanceof ApiError)) {
    // 2026-06-10 incident fix: a NON-ApiError used to be classified PERMANENT,
    // which made a raw TypeError (a fetch/body-read network death that slipped
    // past api.js normalization) kill the upload with ZERO retries and no
    // Resume — exactly the live failure shape. Unknown errors at this seam are
    // overwhelmingly network-shaped, and retrying them is cheap (chunk PUTs are
    // idempotent), so they are now TRANSIENT by default. The ONE exception is
    // AbortError: that is the user-cancel short-circuit (the watchdog converts
    // its own abort into ApiError(0,"timeout") before it gets here) and must
    // keep failing fast so Cancel never burns a retry/backoff cycle.
    return !(err && err.name === "AbortError");
  }
  if (err.code === "file_unreadable") return false;     // client-side, not network
  if (err.code === "network" || err.status === 0) return true;   // status 0 includes the watchdog's "timeout"
  if (err.status === 499 || err.code === "client_disconnected") return true;
  if (err.status === 408 || err.status === 429) return true;
  if (err.status >= 500) return true;
  return false;
}

/* A terminal failure that is still worth a Resume button: transient classes
   (retries exhausted — since the 2026-06-10 reclassification this includes
   non-ApiError/raw-TypeError network deaths, so those rows resume instead of
   dying), the iCloud/file-unreadable case (user downloads the file, then
   resumes), and 507 (server disk freed, then resume). Hard 4xx (401 / 404
   session_not_found / 413 …) get no Resume — retrying can't help. AbortError
   is not transient and not an ApiError → no Resume, matching the cancel path. */
function canResume(err) {
  if (isTransient(err)) return true;
  if (err instanceof ApiError) {
    if (err.code === "file_unreadable") return true;
    if (err.status === 507 || err.code === "insufficient_storage") return true;
    // Upload record gone (server restarted mid-upload): Resume self-heals — the
    // stale id 404s on /status, falls back to init with the same client_id, and
    // starts cleanly. (A missing SESSION is different and not resumable.)
    if (err.code === "upload_not_found") return true;
  }
  return false;
}

/* Abort-aware sleep: resolves early (within ~150ms) once isAborted() flips, so
   a user Cancel never waits out a 15s backoff window. */
function sleepUnlessAborted(ms, isAborted) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (isAborted() || Date.now() - t0 >= ms) { clearInterval(tick); resolve(); }
    }, 150);
  });
}

/* Run fn() with the retry/backoff policy. Throws the last error once attempts
   are exhausted, a non-transient error occurs, or the upload is aborted.
   `tag` names the guarded call ("init"/"chunk") in the diag retry events. */
async function withRetry(fn, { isAborted, onWait, tag }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (isAborted()) throw lastErr || new ApiError(0, "aborted", "Cancelled.");
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));   // ±25% jitter
      dlog("warn", "up.retry", {
        tag, attempt, of: RETRY_DELAYS_MS.length, delay_ms: delay, reason: errMeta(lastErr),
      });
      onWait && onWait(attempt, RETRY_DELAYS_MS.length, delay);
      await sleepUnlessAborted(delay, isAborted);
      if (isAborted()) throw lastErr || new ApiError(0, "aborted", "Cancelled.");
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
    }
  }
  dlog("error", "up.retry.exhausted", {
    tag, attempts: RETRY_DELAYS_MS.length + 1, reason: errMeta(lastErr),
  });
  throw lastErr;
}

/* ---- screen wake lock (module-wide, ref-counted) ----------------------------
   A phone locking its screen kills in-flight fetches mid-upload — the original
   "uploads never complete from a phone" failure mode. While ANY upload is
   active we hold a screen wake lock; the browser auto-releases it when the tab
   hides, so we re-acquire on visibilitychange while uploads remain active. */
const wakeLock = (() => {
  // NOTE (2026-06-10 incident): the Wake Lock API is secure-context-only, so on
  // plain-HTTP LAN serving (the actual deployment) iOS Safari does not expose
  // navigator.wakeLock at all → supported === false. The screen WILL sleep
  // mid-upload there; the visible keep-screen-on hint below is the mitigation
  // (HTTPS is the recorded long-term fix, out of scope here).
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  let sentinel = null;
  let active = 0;
  let lastFailed = false;   // most recent acquire attempt was rejected (low battery, policy …)
  let onChange = null;      // single subscriber: the upload panel's keep-screen-on hint

  function notify() { try { if (onChange) onChange(); } catch { /* hint is best-effort */ } }

  async function acquire() {
    if (!supported || sentinel || active === 0) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    try {
      sentinel = await navigator.wakeLock.request("screen");
      lastFailed = false;
      dlog("info", "up.wakelock.ok");
      sentinel.addEventListener("release", () => {
        sentinel = null;
        dlog("info", "up.wakelock.released");
        notify();
      });
    } catch (e) {
      sentinel = null;
      lastFailed = true; /* denied (low battery etc.) — the visible hint covers it */
      dlog("warn", "up.wakelock.fail", { err: String((e && e.message) || e || "").slice(0, 200) });
    }
    notify();
  }

  if (supported && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") acquire();
    });
  }

  return {
    supported,
    /** True while the screen is actually being held awake. */
    held: () => !!sentinel,
    /** True when the latest acquire attempt was rejected (and nothing is held). */
    failed: () => lastFailed,
    /** Register the (single) hint-refresh callback. */
    setOnChange(fn) { onChange = fn; },
    start() { active++; acquire(); },
    stop() {
      active = Math.max(0, active - 1);
      if (active === 0 && sentinel) {
        try { sentinel.release().catch(() => {}); } catch { /* ignore */ }
        sentinel = null;
      }
    },
  };
})();

export function initUpload({ getSessionId, onUploaded }) {
  // The mount lives inside the panel (which can be relocated into the drawer).
  const mount = byId("upload-mount");

  const dropzone = el("button", { class: "dropzone", type: "button", "aria-label": "Choose video files to upload" }, [
    icon("i-upload"),
    el("strong", { text: "Drop clips here" }),
    el("small", { text: "or tap to choose · .mp4 .mov .mkv .avi .m4v · up to 8 GiB" }),
  ]);
  // id/name keep DevTools' form-field audit green (autofill/label association);
  // the input stays a hidden mechanical proxy — the labeled dropzone <button>
  // is the visible, accessible control that proxies clicks to it.
  const fileInput = el("input", {
    type: "file", id: "upload-file-input", name: "footage",
    accept: "video/*,.mp4,.mov,.mkv,.avi,.m4v", multiple: true,
    style: "display:none", "aria-hidden": "true", tabindex: "-1",
  });
  /* THE KEEP-SCREEN-ON NOTICE (2026-06-10 incident fix). On iOS over plain
     HTTP the Wake Lock API is absent (secure-context-only) — the log showed
     `up.wakelock.hint reason=unsupported` while the user's screen lock
     suspended the tab and killed attempt 2. So whenever an upload is active
     and no wake lock is actually protecting it (API unavailable, OR available
     but the acquire was denied), this static, persistent inline notice shows
     right above the progress rows and stays for the whole upload; it is
     removed when the last upload settles or a wake lock is acquired. Plain
     language, existing `.upload-hint` tokens, no markup from user data.
     2026-06-11: the notice links the one-time /setup flow (trusting the local
     CA → the https origin, where Wake Lock works and this notice never
     shows). target=_blank + rel=noopener: navigating THIS tab away would
     kill the in-flight upload the notice is warning about. */
  const wakeHint = el("p", { class: "upload-hint", hidden: true }, [
    icon("i-alert"),
    el("span", {}, [
      "Keep the screen on and stay in this tab until the upload finishes — or ",
      el("a", {
        class: "upload-hint__link", href: "/setup", target: "_blank", rel: "noopener",
        "aria-label": "Set up the secure address (opens in a new tab)",
        text: "set up the secure address",
      }),
      " to make this automatic.",
    ]),
  ]);
  const list = el("div", { class: "uploads" });

  mount.replaceChildren(dropzone, fileInput, wakeHint, list);

  /* Ref-count of in-flight uploads — drives the wake lock + the keep-screen-on
     notice. The notice also refreshes on wake-lock state changes (acquire
     success/denied/released) via wakeLock.setOnChange below, so a mid-upload
     denial becomes visible too — not just the API-absent case. */
  let activeUploads = 0;
  function updateWakeHint() {
    const unprotected = !wakeLock.supported || (!wakeLock.held() && wakeLock.failed());
    const showHint = activeUploads > 0 && unprotected;
    if (showHint && wakeHint.hidden) {
      dlog("info", "up.wakelock.hint", { reason: wakeLock.supported ? "acquire_failed" : "unsupported" });
    }
    wakeHint.hidden = !showHint;
  }
  wakeLock.setOnChange(updateWakeHint);
  function uploadActivity(delta) {
    activeUploads = Math.max(0, activeUploads + delta);
    if (delta > 0) wakeLock.start(); else wakeLock.stop();
    updateWakeHint();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    // Snapshot the picked files into a real array RIGHT NOW, before anything can
    // mutate the input. On iOS Safari/WebKit a File picked from the Photos /
    // iCloud library is backed by a security-scoped resource; clearing the input
    // (`value = ""`) can RELEASE that backing store, so a File reference held for
    // a later read (file.slice per chunk) becomes unreadable — the upload then
    // sits at 0% and stalls. We therefore (a) capture the FileList synchronously,
    // (b) START the uploads (each uploadOne synchronously fires its metadata-only
    // init and holds its own File ref), and (c) DEFER the value reset to a later
    // macrotask so the synchronous neutering can never race the in-flight slices.
    const picked = Array.from(fileInput.files || []);
    handleFiles(picked);
    // Reset on a later tick so re-picking the same file still fires `change`,
    // WITHOUT clearing in the same synchronous turn that just handed the File
    // refs to uploadOne (see above).
    setTimeout(() => { try { fileInput.value = ""; } catch { /* ignore */ } }, 0);
  });

  /* drag & drop (desktop) */
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.dataset.drag = "true"; }));
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.dataset.drag = "false"; }));
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(Array.from(e.dataTransfer.files));
  });

  function ext(name) {
    const i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i).toLowerCase();
  }

  function validate(file) {
    const e = ext(file.name);
    if (!VIDEO_EXTS.includes(e)) return `Unsupported type (${e || "no extension"}). Use .mp4 .mov .mkv .avi .m4v.`;
    if (file.size > MAX_BYTES) return `Too large (${fmtBytes(file.size)}). Max is ${fmtBytes(MAX_BYTES)}.`;
    if (file.size === 0) return "Empty file.";
    return null;
  }

  function handleFiles(fileList) {
    // Accepts an array (preferred — already snapshotted by the caller) or a live
    // FileList; either way we copy into a plain array so nothing downstream
    // depends on the live picker state. Wrapped in try/catch so a synchronous
    // throw anywhere here (e.g. a hostile File getter on WebKit) becomes a
    // VISIBLE toast instead of a silent no-op (the upload would otherwise never
    // start and the user would see nothing happen at all).
    try {
      const sessionId = getSessionId();
      if (sessionId == null) {
        toast("Open a session first, then choose a video to upload.", "bad");
        return;
      }
      const files = Array.from(fileList || []);
      if (files.length === 0) return;        // picker dismissed with no selection
      for (const file of files) {
        dlog("info", "up.pick", {
          name: String(file.name || "").slice(0, 150),
          size: file.size,
          type: String(file.type || "").slice(0, 80),
          lastModified: file.lastModified || 0,
          client_id: clientIdFor(file),
        });
        const err = validate(file);
        if (err) {
          dlog("warn", "up.validate.fail", { name: String(file.name || "").slice(0, 150), reason: err });
          const row = addRow(file); row.fail(err); revealRow(row); toast(err, "bad"); continue;
        }
        // uploadOne owns its own try/catch (errors surface as a row + toast); we
        // also attach a catch on the returned promise as a final backstop so an
        // unexpected rejection can never be an unhandled, invisible failure.
        Promise.resolve(uploadOne(file, sessionId)).catch((e) => {
          try { console.error("[studio] upload crashed before it could report:", e); } catch { /* ignore */ }
          toast(`${file && file.name ? file.name : "Upload"}: ${(e && e.message) || "unexpected error"}.`, "bad", 6000);
        });
      }
    } catch (e) {
      try { console.error("[studio] could not start upload:", e); } catch { /* ignore */ }
      toast(`Couldn’t start the upload: ${(e && e.message) || "unexpected error"}.`, "bad", 6000);
    }
  }

  /* On a phone the uploads list sits at the bottom of the drawer's scroll, below
     the fold — so a freshly-started upload (and its progress bar) can be off-screen
     even though it IS uploading. Bring the new row into view so the user sees the
     progress advance instead of an apparently-idle screen. */
  function revealRow(rowApi) {
    const node = rowApi && rowApi.row;
    if (!node || typeof node.scrollIntoView !== "function") return;
    try { node.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { /* older engines */ try { node.scrollIntoView(); } catch { /* ignore */ } }
  }

  /* ---- per-file row ----
     Layout: [film] name … pct [cancel]
             [-------- progress bar --------]
             status · "X / Y"
             [Resume]            (only after a resumable terminal failure)
     The STATUS line is the anti-silent-stall guarantee: it shows "Starting…"
     the instant the row appears (BEFORE init), then "Uploading N%…", then the
     final filename or a clear error. So the row can never sit as a bare,
     unexplained "0%". `statusEl` and the byte-count share one meta line. */
  function addRow(file) {
    const bar = el("span", { class: "progress__bar" });
    const pct = el("span", { class: "uprow__pct", text: "0%" });
    const statusEl = el("span", { class: "uprow__status", text: "Starting…" });
    const bytesEl = el("span", { class: "uprow__bytes" });
    const metaEl = el("span", { class: "uprow__meta" }, [ statusEl, bytesEl ]);
    const cancelBtn = el("button", { class: "icon-btn uprow__cancel", type: "button", "aria-label": "Cancel upload" }, [ icon("i-close") ]);
    const resumeBtn = el("button", { class: "btn btn--primary btn--sm uprow__resume", type: "button", hidden: true }, [
      icon("i-refresh"), el("span", { text: "Resume upload" }),
    ]);
    const row = el("div", { class: "uprow", dataset: { state: "active" } }, [
      el("div", { class: "uprow__top" }, [
        icon("i-film"),
        el("span", { class: "uprow__name", text: file.name, title: file.name }),
        pct, cancelBtn,
      ]),
      el("div", { class: "progress" }, [ bar ]),
      metaEl,
      resumeBtn,
    ]);
    list.prepend(row);

    let onCancel = null;
    cancelBtn.addEventListener("click", () => { if (onCancel) onCancel(); });

    function setBytes(sent, total) {
      bytesEl.textContent = (sent != null && total != null) ? ` · ${fmtBytes(sent)} / ${fmtBytes(total)}` : "";
    }

    return {
      row,
      setCancel(fn) { onCancel = fn; },
      /** Set the human-readable step label (e.g. "Starting…", "Uploading 12%…"). */
      status(text) { statusEl.textContent = text || ""; },
      progress(sent, total) {
        const p = total ? Math.round((sent / total) * 100) : 0;
        bar.style.width = p + "%";
        pct.textContent = p + "%";
        statusEl.textContent = `Uploading ${p}%…`;
        setBytes(sent, total);
      },
      done(path) {
        row.dataset.state = "done";
        bar.style.width = "100%"; pct.textContent = "done";
        statusEl.textContent = "Uploaded";
        bytesEl.textContent = " · " + basename(path || file.name);
        resumeBtn.hidden = true;
        cancelBtn.replaceChildren(icon("i-check"));
        cancelBtn.disabled = true; cancelBtn.setAttribute("aria-label", "Uploaded");
      },
      /** Terminal failure. When opts.onResume is given the row keeps a visible
          Resume button; the icon button becomes Dismiss (REMOVES THE ROW ONLY —
          server-side partial state is intentionally left for a later resume /
          the backend's orphan GC; only an explicit Cancel deletes it). */
      fail(msg, opts) {
        onCancel = null;                        // dismiss must NOT trigger cancel/delete
        row.dataset.state = "error";
        pct.textContent = "failed";
        statusEl.textContent = msg;
        bytesEl.textContent = "";
        cancelBtn.replaceChildren(icon("i-trash"));
        cancelBtn.setAttribute("aria-label", "Dismiss");
        cancelBtn.disabled = false;
        cancelBtn.onclick = () => row.remove();
        if (opts && typeof opts.onResume === "function") {
          resumeBtn.hidden = false;
          resumeBtn.onclick = () => opts.onResume();
        } else {
          resumeBtn.hidden = true;
          resumeBtn.onclick = null;
        }
      },
      /** Flip an errored row back to its active visuals when Resume is tapped. */
      resuming() {
        row.dataset.state = "active";
        statusEl.textContent = "Resuming…";
        bytesEl.textContent = "";
        if (pct.textContent === "failed") pct.textContent = "…";
        resumeBtn.hidden = true;
        resumeBtn.onclick = null;
        cancelBtn.replaceChildren(icon("i-close"));
        cancelBtn.setAttribute("aria-label", "Cancel upload");
        cancelBtn.disabled = false;
        cancelBtn.onclick = null;               // restore the addEventListener path
      },
    };
  }

  /* ---- the upload state machine for one file ---- */
  async function uploadOne(file, sessionId) {
    const ui = addRow(file);
    revealRow(ui);                 // make the new row + its progress bar visible immediately
    ui.status("Starting…");        // visible the instant the row appears — never a bare 0%

    // Shared, resume-surviving context for this file. Metadata is read once,
    // synchronously, up front: `init` is metadata-only by design (it must NEVER
    // touch the file's bytes), so it fires immediately even for a large /
    // iCloud-backed .mov whose bytes haven't downloaded yet.
    const ctx = {
      aborted: false,
      running: false,
      uploadId: null,
      chunkSize: null,
      totalChunks: null,
      clientId: clientIdFor(file),
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      startedAt: Date.now(),   // whole-file clock (spans retries + resumes) for the complete event
      abortCtrl: null,     // the CURRENT run's AbortController (null between runs)
      runPromise: null,    // the CURRENT run's settle promise (runUpload never rejects)
    };

    const cancelHandler = async () => {
      ctx.aborted = true;
      dlog("info", "up.cancel", { upload_id: ctx.uploadId, client_id: ctx.clientId });
      ui.fail("Cancelled.");
      // ORDER MATTERS (cancel-race fix): (a) abort the in-flight fetch FIRST so
      // the server-side handle closes, (b) wait for the run to settle, (c) only
      // THEN delete server state. DELETE racing a still-streaming chunk PUT let
      // the late chunk re-create the part dir after cleanup.
      if (ctx.abortCtrl) { try { ctx.abortCtrl.abort(); } catch { /* ignore */ } }
      if (ctx.runPromise) { try { await ctx.runPromise; } catch { /* runUpload never rejects — backstop */ } }
      // EXPLICIT user cancel is the ONLY place server-side state is deleted.
      // A 404 here (backend already tombstoned/swept the upload) is fine.
      if (ctx.uploadId) { try { await api.del(`/api/upload/${encodeURIComponent(ctx.uploadId)}`); } catch { /* best effort */ } }
    };
    ui.setCancel(cancelHandler);

    /* runUpload owns success/failure; on a resumable failure it arms the row's
       Resume button with this re-entry. Assigned BEFORE the first run so the
       failure path can always reach it. */
    ctx.resume = () => {
      if (ctx.running || ctx.aborted) return;
      dlog("info", "up.resume.click", { upload_id: ctx.uploadId, client_id: ctx.clientId });
      ui.resuming();
      ui.setCancel(cancelHandler);
      ctx.runPromise = Promise.resolve(runUpload(file, sessionId, ui, ctx, true));
      ctx.runPromise.catch((e) => {
        try { console.error("[studio] resume crashed:", e); } catch { /* ignore */ }
      });
    };

    ctx.runPromise = runUpload(file, sessionId, ui, ctx, false);
    await ctx.runPromise;
  }

  async function runUpload(file, sessionId, ui, ctx, isResume) {
    if (ctx.running) return;
    ctx.running = true;
    const isAborted = () => ctx.aborted;
    /* One AbortController per run, threaded into EVERY network call below so an
       explicit Cancel kills the in-flight fetch immediately (the abort-aware
       sleep already covered the backoff windows; this covers the fetch itself).
       An AbortError is not an ApiError → isTransient() is false → withRetry
       rethrows at once, so cancel can never trigger a retry attempt. */
    const abortCtrl = new AbortController();
    ctx.abortCtrl = abortCtrl;
    const signal = abortCtrl.signal;
    let phase = "init";
    uploadActivity(+1);
    try {
      /* 1 ── figure out where we stand: received chunk set + upload id.
         On RESUME with a known upload_id, reconcile via GET /status first (the
         cheap path while the server still has the live upload). If that fails
         (server restarted, state gone) fall back to a fresh init — which, via
         client_id, transparently returns the same upload when it IS still live. */
      let received = null;
      if (isResume && ctx.uploadId) {
        try {
          const st = await api.get(`/api/upload/${encodeURIComponent(ctx.uploadId)}/status`, { signal });
          received = new Set(Array.isArray(st && st.received) ? st.received : []);
          if (st && st.chunk_size) ctx.chunkSize = st.chunk_size;
          if (st && st.total_chunks) ctx.totalChunks = st.total_chunks;
          dlog("info", "up.reconcile.ok", {
            upload_id: ctx.uploadId, received: received.size, total_chunks: ctx.totalChunks,
          });
        } catch (reconcileErr) {
          dlog("warn", "up.reconcile.err", {
            upload_id: ctx.uploadId, aborted: ctx.aborted, ...errMeta(reconcileErr),
          });
          // Keep the id when the "failure" is our own cancel abort — the
          // cancelHandler still needs it for the explicit DELETE.
          if (!ctx.aborted) ctx.uploadId = null;   // stale id — re-init below (same client_id)
        }
        if (ctx.aborted) return;
      }

      if (ctx.uploadId == null) {
        dlog("info", "up.init", {
          client_id: ctx.clientId, size: ctx.fileSize, chunk_size: DEFAULT_CHUNK, resume: isResume,
        });
        const init = await withRetry(() => api.post("/api/upload/init", {
          session_id: sessionId,
          filename: ctx.fileName,
          size_bytes: ctx.fileSize,
          chunk_size: DEFAULT_CHUNK,
          content_type: CONTENT_TYPES[ext(ctx.fileName)] || ctx.fileType || "application/octet-stream",
          client_id: ctx.clientId,
        }, { signal }), {
          isAborted,
          onWait: (n, total, ms) => ui.status(`Connection hiccup — retrying start (${n}/${total}) in ${Math.ceil(ms / 1000)}s…`),
          tag: "init",
        });
        if (ctx.aborted) return;
        ctx.uploadId = init.upload_id;
        ctx.chunkSize = init.chunk_size || DEFAULT_CHUNK;
        ctx.totalChunks = init.total_chunks || Math.ceil(ctx.fileSize / (init.chunk_size || DEFAULT_CHUNK));
        received = new Set(Array.isArray(init.received) ? init.received : []);
        // `mode` is the client-side inference (the response has no explicit flag):
        // any pre-received chunks prove the server matched our client_id.
        dlog("info", "up.init.ok", {
          upload_id: ctx.uploadId,
          mode: received.size > 0 ? "resumed" : "fresh",
          received: received.size,
          total_chunks: ctx.totalChunks,
          chunk_size: ctx.chunkSize,
        });
      }

      const chunkSize = ctx.chunkSize || DEFAULT_CHUNK;
      const totalChunks = ctx.totalChunks || Math.ceil(ctx.fileSize / chunkSize);

      let sentBytes = Math.min(received.size * chunkSize, ctx.fileSize);
      if (received.size > 0) ui.status(`Resuming — ${received.size} of ${totalChunks} parts already uploaded…`);
      ui.progress(sentBytes, ctx.fileSize);

      /* 2 ── stream the missing chunks, each with retry/backoff. */
      phase = "chunk";
      for (let i = 0; i < totalChunks; i++) {
        if (ctx.aborted) return;
        if (received.has(i)) continue;

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, ctx.fileSize);
        // LAZY slice — read ONLY this chunk's bytes, never the whole file. On iOS
        // a slice of an iCloud File triggers the just-in-time byte download; if
        // that fails, slice()/the PUT throws and is caught below (visible error),
        // never a silent hang. We do NOT pre-read or hash the file.
        let blob;
        try {
          blob = file.slice(start, end);
        } catch (sliceErr) {
          // WebKit can throw here if the File's backing store was released
          // (iCloud not downloaded / picker resource revoked). Surface a clear,
          // actionable reason verbatim (ApiError → errorMessage passes it through
          // without the generic "stalled" framing or a trailing-period artifact).
          throw new ApiError(0, "file_unreadable",
            "Couldn’t read the file — if it’s in iCloud, open it in Photos once to download it, then try again.");
        }

        await withRetry(async () => {
          // One start/finish pair PER ATTEMPT (withRetry re-runs this fn), so a
          // stalled chunk is visible as a start with no matching ok/err.
          const t0 = Date.now();
          dlog("debug", "up.chunk.start", { id: ctx.uploadId, i, bytes: blob.size });

          /* STALL WATCHDOG, one per attempt (see chunkTimeoutMs). The attempt
             gets its OWN AbortController so the watchdog can kill just this
             fetch; the run signal (user Cancel) is relayed into it so Cancel
             still aborts the in-flight chunk instantly. Distinguishing the two
             aborts: a watchdog abort sets `timedOut` BEFORE aborting, and ONLY
             a watchdog-induced AbortError (timedOut && !ctx.aborted) is
             rewritten into the transient ApiError(0,"timeout") that feeds the
             backoff retry. A user-cancel AbortError keeps its identity → not
             transient → withRetry rethrows → the outer catch's ctx.aborted
             silence, exactly as before. The timer is cleared in finally on
             EVERY settle (success, error, cancel), so it can never fire after
             completion or leak across attempts; real fetch errors that race the
             timer keep their own classification (only AbortError is rewritten). */
          const attemptCtrl = new AbortController();
          let timedOut = false;
          const onRunAbort = () => { try { attemptCtrl.abort(); } catch { /* ignore */ } };
          if (signal.aborted) onRunAbort();
          else signal.addEventListener("abort", onRunAbort, { once: true });
          const stallMs = chunkTimeoutMs(blob.size);
          const watchdog = setTimeout(() => {
            timedOut = true;
            dlog("warn", "up.chunk.timeout", { id: ctx.uploadId, i, ms: stallMs });
            try { attemptCtrl.abort(); } catch { /* ignore */ }
          }, stallMs);

          try {
            const r = await putChunk(ctx.uploadId, i, blob, attemptCtrl.signal);
            dlog("debug", "up.chunk.ok", { id: ctx.uploadId, i, ms: Date.now() - t0 });
            return r;
          } catch (chunkErr) {
            let err = chunkErr;
            if (timedOut && !ctx.aborted && chunkErr && chunkErr.name === "AbortError") {
              err = new ApiError(0, "timeout",
                "No response from the server — the connection stalled.");
            }
            dlog("warn", "up.chunk.err", { id: ctx.uploadId, i, ms: Date.now() - t0, ...errMeta(err) });
            throw err;
          } finally {
            clearTimeout(watchdog);
            try { signal.removeEventListener("abort", onRunAbort); } catch { /* ignore */ }
          }
        }, {
          isAborted,
          onWait: (n, total, ms) => ui.status(`Connection hiccup — retrying (${n}/${total}) in ${Math.ceil(ms / 1000)}s…`),
          tag: "chunk",
        });
        if (ctx.aborted) return;

        received.add(i);
        sentBytes = Math.min(sentBytes + (end - start), ctx.fileSize);
        ui.progress(sentBytes, ctx.fileSize);
      }

      if (ctx.aborted) return;
      /* 3 ── assemble. Single-shot: if THIS call fails on a blip, the Resume
         button re-enters runUpload, the status/init reconciliation finds every
         chunk received, the loop no-ops, and complete is attempted again. */
      phase = "complete";
      ui.status("Finishing…");
      dlog("info", "up.complete.start", { upload_id: ctx.uploadId });
      const res = await api.post(`/api/upload/${encodeURIComponent(ctx.uploadId)}/complete`, {}, { signal });
      dlog("info", "up.complete.ok", {
        upload_id: ctx.uploadId,
        ms: Date.now() - ctx.startedAt,
        stored: basename((res && res.path) || ctx.fileName).slice(0, 150),
      });
      ui.done(res && res.path);
      toast(`Uploaded ${ctx.fileName}.`, "ok");
      onUploaded && onUploaded(res, sessionId);
    } catch (err) {
      // After an explicit user cancel EVERY error is swallowed silently — the
      // AbortError from the killed fetch, and equally a backend 404
      // `upload_not_found` from a chunk PUT that raced the cancel (the server
      // tombstones cancelled uploads). The row already shows "Cancelled.".
      if (ctx.aborted) return;
      const msg = errorMessage(err, phase);
      dlog("error", "up.fail", {
        upload_id: ctx.uploadId, phase, resumable: canResume(err), ...errMeta(err),
      });
      // NEVER api.del here — a transient failure must keep the server-side
      // partial state alive so Resume / re-pick can continue from received[].
      ui.fail(msg, canResume(err) ? { onResume: () => ctx.resume && ctx.resume() } : undefined);
      revealRow(ui);                 // surface the failed row even if it scrolled out of view
      toast(`${ctx.fileName}: ${msg}`, "bad", 6000);
      // Never swallow the cause — also log it so a phone-only/server-side failure
      // is diagnosable from the desktop console / server logs.
      try { console.error(`[studio] upload failed (${phase}) for ${ctx.fileName}:`, err); } catch { /* ignore */ }
    } finally {
      ctx.running = false;
      if (ctx.abortCtrl === abortCtrl) ctx.abortCtrl = null;
      uploadActivity(-1);
    }
  }

  /* Turn any thrown error into a clear, user-facing reason that names the phase —
     so an init/chunk/complete failure is always surfaced (never a silent stall).
     ApiError already carries the backend's contract message/code; we map the few
     well-known statuses to friendlier copy and otherwise pass the reason through. */
  function errorMessage(err, phase) {
    const where = phase === "init" ? "couldn’t start" : phase === "complete" ? "couldn’t finish" : "stalled";
    if (err instanceof ApiError) {
      // A client-side "can't read the file" (iOS iCloud / revoked picker resource)
      // carries its own actionable copy — return it verbatim. Checked BEFORE the
      // status===0 network branch since this error also has status 0.
      if (err.code === "file_unreadable") return err.message;
      if (err.status === 413 || err.code === "upload_too_large") return "Too large — exceeds the server cap.";
      if (err.status === 507 || err.code === "insufficient_storage") return "Not enough free disk space on the server.";
      if (err.status === 401) return "Session expired — sign in again.";
      if (err.code === "session_not_found") return "That session no longer exists.";
      if (err.code === "upload_not_found") return "The server restarted mid-upload — tap Resume to start this file again.";
      if (err.status === 404) return "That session no longer exists.";
      if (err.code === "network" || err.status === 0 || err.status === 499 || err.code === "client_disconnected") {
        return "Lost connection — check Wi-Fi, then tap Resume to continue.";
      }
      if (err.status >= 500) return "The server hit an error — tap Resume to try again.";
      // Any other contract error: show the backend's own message (never blank).
      return err.message || `Upload ${where} (HTTP ${err.status}).`;
    }
    // Non-ApiError (unexpected client-side throw): keep the reason, don't blank it.
    return `Upload ${where}: ${(err && err.message) || "unexpected error"}.`;
  }

  /* PUT one chunk as raw bytes. (api.put sends the Blob as-is.) Idempotent on
     the server, so a retried PUT after a 499/network drop is safe. `signal` is
     the run's AbortController signal — an explicit Cancel aborts THIS fetch
     before the DELETE fires (api.js `request` forwards it and rethrows the
     AbortError untouched, so it never enters the retry classifier). */
  async function putChunk(uploadId, index, blob, signal) {
    return api.put(
      `/api/upload/${encodeURIComponent(uploadId)}/chunk?index=${index}`,
      blob,
      { headers: { "Content-Type": "application/octet-stream" }, signal },
    );
  }

  return { /* nothing external needed; mount is self-contained */ };
}
