/* =============================================================================
   diag.js — phone-side diagnostics for Studio v2: a tiny, self-contained event
   logger that ships the client's story to POST /api/client-log.
   -----------------------------------------------------------------------------
   Faithful port of v1's field-hardened diag.js (the 2026-06-10 incident tool);
   only the storage/singleton keys are renamed so v1 and v2 tabs on one host
   never share state. The design rules are v1's verbatim:

   API (also mirrored on window.__studio2Diag for modules that must not import
   this file directly — see SINGLETON below):
     dlog(level, msg, data?)   level ∈ debug|info|warn|error; msg = short STABLE
                               greppable code ("cap.probe"); details in data
     setAuth(bool)             gate shipping on login state (wired by app.js)
     flush()                   force a ship attempt (console / tests)
     stats()                   counters only ({ring, pending, authed, inFlight})

   SERVER CONTRACT (POST /api/client-log, auth-gated by the session cookie —
   arch §2.1, v1 contract verbatim):
     body { events: [ { t, level, msg, data? }, … ] }
     caps: ≤64 KB body, ≤200 events/request; 200 {ok:true}; 401 when signed out.
   Every cap is ALSO enforced client-side so we never trip a 413/400.

   DESIGN RULES (non-negotiable):
   • NEVER throws, NEVER blocks, NEVER recurses on its own failures — every
     entry point is try/caught; shipper failures are silent.
   • Bounded everywhere: ring ≤300, pending ≤300, msg ≤500 chars, data ≤~2 KB
     serialized, ≤20 events AND ≤56 KB per POST.
   • Two-tier retry (the v1 tester-found P1): CONNECTIVITY failures (fetch
     TypeError / navigator.onLine === false) re-queue WITHOUT burning the retry
     and shipping PAUSES while offline ('online' flushes immediately); SERVER
     rejections (non-ok, non-401 HTTP) re-queue ONCE then drop; 401 re-queues
     and flips authed=false (buffer until login).
   • Dying-tab tail via navigator.sendBeacon on pagehide/visibility→hidden.
   • Crash persistence: ring tail mirrored to localStorage (throttled ~2 s,
     immediate on hide); next boot replays the mirror FIRST, each event tagged
     data.replay:true, key claimed exactly once.
   • Privacy: never reads credential fields or cookie values; callers log short
     msg codes + small data objects; nothing renders diag events into the DOM.
   • SINGLETON: the instance hangs off window.__studio2Diag — a second module
     instance (e.g. a bare import beside the ?v= one) reuses the first
     instance instead of installing duplicate timers/listeners.
============================================================================= */

const ENDPOINT = "/api/client-log";
const RING_MAX = 300;            // all events of this run (feeds the mirror)
const PENDING_MAX = 300;         // not-yet-delivered queue bound
const PERSIST_MAX = 200;         // localStorage mirror tail
const BATCH_MAX = 20;            // events per POST (also the "ship now" trigger)
const BEACON_MAX_EVENTS = 200;   // events per dying-tab beacon (server cap)
const BODY_MAX_BYTES = 56 * 1024; // body budget, safely under the 64 KB cap
const MSG_MAX_CHARS = 500;       // server cap, enforced here too
const DATA_MAX_BYTES = 2000;     // serialized data budget (~2 KB server cap)
const SHIP_INTERVAL_MS = 5000;
const PERSIST_THROTTLE_MS = 2000;
const LS_KEY = "studio2.diag.tail.v1";

function makeInstance() {
  const TE = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  const ring = [];      // every capped event of this run (≤ RING_MAX)
  const pending = [];   // [{ ev, retried }] awaiting delivery (≤ PENDING_MAX)
  let authed = false;   // shipping is gated on the login state (set by app.js)
  let inFlight = false; // one ship cycle at a time
  let flushQueued = false;
  let persistTimer = null;
  let lastPersistAt = 0;

  /* ---- capping helpers (all server caps re-enforced client-side) ---------- */

  function byteLen(s) {
    try { return TE ? TE.encode(s).length : s.length * 2; }
    catch { return s.length * 2; }
  }

  function safeStringify(value) {
    try {
      const s = JSON.stringify(value);
      return typeof s === "string" ? s : undefined;
    } catch {
      try { return JSON.stringify(String(value)); } catch { return undefined; }
    }
  }

  function capLevel(level) {
    const l = typeof level === "string" ? level.toLowerCase() : "";
    return (l === "debug" || l === "info" || l === "warn" || l === "error") ? l : "info";
  }

  /* Snapshot + bound `data`: round-trip through JSON (decouples the stored
     event from later caller mutation) and cap the serialized size. Oversize
     data degrades to { truncated:true, preview:"…" } instead of being lost. */
  function capData(data) {
    if (data === undefined) return undefined;
    const s = safeStringify(data);
    if (s === undefined) return undefined;
    if (byteLen(s) <= DATA_MAX_BYTES) {
      try { return JSON.parse(s); } catch { return undefined; }
    }
    let preview = s.slice(0, 1400);
    while (preview.length > 0 && byteLen(preview) > 1500) {
      preview = preview.slice(0, Math.floor(preview.length * 0.8));
    }
    return { truncated: true, preview };
  }

  function makeEvent(level, msg, data) {
    const ev = {
      t: Date.now(),
      level: capLevel(level),
      msg: String(msg == null ? "" : msg).slice(0, MSG_MAX_CHARS),
    };
    const d = capData(data);
    if (d !== undefined) ev.data = d;
    return ev;
  }

  /* ---- the logger ---------------------------------------------------------- */

  function dlog(level, msg, data) {
    try {
      const ev = makeEvent(level, msg, data);
      ring.push(ev);
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
      pending.push({ ev, retried: false });
      if (pending.length > PENDING_MAX) pending.splice(0, pending.length - PENDING_MAX);
      schedulePersist();
      if (pending.length >= BATCH_MAX) scheduleFlush();
    } catch { /* diag NEVER throws */ }
  }

  /* ---- M3 render-gate boot fact (arch §6.1/§6.2) --------------------------- */

  /* Shape the render-gate result into a compact, greppable boot-fact payload.
     Mirrors capability.js's renderGateForDiag (kept in sync) so whichever side
     emits the fact produces the same `cap.render` data shape; reasons capped so
     a pathological list can't bloat the line. Tolerant of a missing/partial gate
     (an old caps object, or a probe that failed) — fields default sensibly. */
  function gateFacts(render) {
    const r = (render && typeof render === "object") ? render : {};
    return {
      ok: !!r.ok,
      vcodec: r.videoCodec || null,        // "hevc" | "h264" | null
      venc: !!r.videoEncode,
      hevc: !!r.videoEncodeHevc,
      h264: !!r.videoEncodeH264,
      aenc: !!r.audioEncode,
      gpu: r.gpu || null,                  // "webgpu" | "webgl2" | "2d" | null
      ram: typeof r.ramClass === "number" ? r.ramClass : null,
      reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 12) : [],
    };
  }

  /* Emit the render-gate boot fact. Accepts either the full caps object (reads
     caps.render) or a bare render block. Logged at `info` when the gate is open,
     `warn` when it's closed (a gated device's render reasons stand out in the
     client log). NEVER throws. This is the canonical owner of the cap.render
     boot fact; capability.js calls it at probe time. */
  function logGate(capsOrRender) {
    try {
      const render = (capsOrRender && capsOrRender.render) ? capsOrRender.render : capsOrRender;
      const facts = gateFacts(render);
      dlog(facts.ok ? "info" : "warn", "cap.render", facts);
    } catch { /* diag NEVER throws */ }
  }

  /* ---- shipping ------------------------------------------------------------ */

  /* Take a contiguous prefix of `pending` that fits BOTH the event-count cap
     and the byte budget. Always admits at least one event so an oversize lone
     event can't wedge the queue forever. */
  function takeBatch(maxEvents, maxBytes) {
    const out = [];
    let bytes = 16; // {"events":[…]} envelope overhead
    for (let i = 0; i < pending.length && out.length < maxEvents; i++) {
      const s = safeStringify(pending[i].ev);
      const len = (s === undefined ? 2 : byteLen(s)) + 1;
      if (out.length > 0 && bytes + len > maxBytes) break;
      bytes += len;
      out.push(pending[i]);
    }
    return out;
  }

  /* True while the browser KNOWS it has no network — read LIVE on every use
     so a missed event can never wedge shipping in a stale "offline" state. */
  function netDown() {
    try { return typeof navigator !== "undefined" && navigator.onLine === false; }
    catch { return false; }
  }

  async function flushNow() {
    if (inFlight) return;
    inFlight = true;
    try {
      let cycles = 0;
      while (authed && !netDown() && pending.length > 0 && cycles < 20) {
        cycles += 1;
        const batch = takeBatch(BATCH_MAX, BODY_MAX_BYTES);
        if (batch.length === 0) break;
        pending.splice(0, batch.length);
        let ok = false;
        let unauthorized = false;
        let netFail = false;
        try {
          const res = await fetch(ENDPOINT, {
            method: "POST",
            credentials: "same-origin",   // the httpOnly studio2_session cookie
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch.map((p) => p.ev) }),
          });
          ok = !!res.ok;
          unauthorized = res.status === 401;
        } catch {
          ok = false;
          netFail = true; // fetch rejected — NO HTTP response existed (connectivity)
        }
        if (!ok) {
          if (unauthorized) {
            // Not signed in (yet / anymore): keep EVERYTHING, don't burn the
            // retry budget; setAuth(true) after login resumes delivery.
            authed = false;
            pending.unshift(...batch);
          } else if (netFail || netDown()) {
            // CONNECTIVITY failure: re-queue WITHOUT burning the retry — an
            // offline phone's story survives any number of dead-network ticks
            // and ships after reconnect WITHOUT a reload.
            pending.unshift(...batch);
            if (pending.length > PENDING_MAX) pending.splice(0, pending.length - PENDING_MAX);
          } else {
            // SERVER rejection (HTTP response arrived, non-ok, non-401):
            // re-queue each event ONCE, then drop.
            const again = batch.filter((p) => !p.retried);
            for (const p of again) p.retried = true;
            pending.unshift(...again);
            if (pending.length > PENDING_MAX) pending.splice(0, pending.length - PENDING_MAX);
          }
          break; // stop this cycle; the 5 s timer / next trigger retries
        }
      }
    } catch { /* NEVER throw, NEVER dlog about our own failure */ }
    finally { inFlight = false; }
  }

  function scheduleFlush() {
    if (flushQueued || inFlight) return;
    flushQueued = true;
    setTimeout(() => { flushQueued = false; flushNow(); }, 0);
  }

  /* Dying-tab tail: ship the pending events as a beacon the browser delivers
     even after the tab is suspended/killed. Same endpoint, same JSON shape;
     the same-origin cookie rides along automatically. */
  function shipBeacon() {
    try {
      if (!authed || pending.length === 0) return;
      if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
      const batch = takeBatch(BEACON_MAX_EVENTS, BODY_MAX_BYTES);
      if (batch.length === 0) return;
      const blob = new Blob(
        [JSON.stringify({ events: batch.map((p) => p.ev) })],
        { type: "application/json" },
      );
      if (navigator.sendBeacon(ENDPOINT, blob)) pending.splice(0, batch.length);
      // queueing refused (UA buffer full) → events stay pending; the
      // localStorage mirror below still preserves them for boot replay.
    } catch { /* never throws */ }
  }

  /* ---- crash persistence (localStorage mirror + boot replay) -------------- */

  function persistNow() {
    try {
      lastPersistAt = Date.now();
      localStorage.setItem(LS_KEY, JSON.stringify({
        saved: lastPersistAt,
        events: ring.slice(-PERSIST_MAX),
      }));
    } catch { /* quota / private mode — persistence is best-effort */ }
  }

  function schedulePersist() {
    if (persistTimer) return;
    const wait = Math.max(0, PERSIST_THROTTLE_MS - (Date.now() - lastPersistAt));
    persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, wait);
  }

  /* On boot: if the previous run left a mirror behind (frozen/killed tab —
     OR a normal reload; duplicates are fine, the replay flag marks them),
     queue those events at the FRONT of pending so they ship FIRST, tag each
     with data.replay:true, and clear the key (claimed exactly once). */
  function replayLeftover() {
    let raw = null;
    try {
      raw = localStorage.getItem(LS_KEY);
      localStorage.removeItem(LS_KEY);
    } catch { return; }
    if (!raw) return;
    let events = [];
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.events)) events = parsed.events;
    } catch { return; }
    if (events.length === 0) return;
    const replays = [];
    for (const e of events.slice(-PERSIST_MAX)) {
      try {
        if (!e || typeof e !== "object") continue;
        const base = (e.data && typeof e.data === "object" && !Array.isArray(e.data))
          ? e.data
          : (e.data === undefined ? {} : { value: e.data });
        const ev = makeEvent(e.level, e.msg, { ...base, replay: true });
        if (typeof e.t === "number" && isFinite(e.t)) ev.t = e.t;   // keep the ORIGINAL time
        replays.push(ev);
      } catch { /* skip one bad record, keep the rest */ }
    }
    if (replays.length === 0) return;
    for (let i = replays.length - 1; i >= 0; i--) pending.unshift({ ev: replays[i], retried: false });
    if (pending.length > PENDING_MAX) pending.splice(PENDING_MAX); // keep the FRONT (replay-first)
    ring.unshift(...replays);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    dlog("info", "diag.replay", { count: replays.length });
  }

  /* ---- auth gate ------------------------------------------------------------ */

  function setAuth(value) {
    try {
      const next = !!value;
      if (next === authed) return;
      authed = next;
      if (authed) scheduleFlush();   // deliver buffered + replayed events promptly
    } catch { /* ignore */ }
  }

  /* ---- global capture + lifecycle hooks ------------------------------------- */

  function install() {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    try {
      window.addEventListener("error", (e) => {
        try {
          const err = e ? e.error : null;
          dlog("error", "win.error", {
            message: String((e && e.message) || (err && err.message) || "").slice(0, 300),
            source: String((e && e.filename) || "").slice(0, 200),
            line: (e && e.lineno) || 0,
            col: (e && e.colno) || 0,
            stack: err && err.stack ? String(err.stack).slice(0, 1200) : undefined,
          });
        } catch { /* never throw from a global handler */ }
      });
      window.addEventListener("unhandledrejection", (e) => {
        try {
          const r = e ? e.reason : null;
          dlog("error", "win.unhandledrejection", {
            message: String((r && r.message) || r || "").slice(0, 300),
            code: r && r.code !== undefined ? String(r.code).slice(0, 60) : undefined,
            status: r && typeof r.status === "number" ? r.status : undefined,
            stack: r && r.stack ? String(r.stack).slice(0, 1200) : undefined,
          });
        } catch { /* never throw from a global handler */ }
      });
      window.addEventListener("online", () => {
        dlog("info", "net.online");
        // Reconnected: flush EVERYTHING that piled up while offline NOW —
        // pending is FIFO, so the backlog ships first, in order.
        scheduleFlush();
      });
      window.addEventListener("offline", () => dlog("warn", "net.offline"));
      // The dlog comes FIRST so the visibility/pagehide event itself is part
      // of the persisted mirror and the beacon payload.
      document.addEventListener("visibilitychange", () => {
        dlog("info", "page.visibility", { state: document.visibilityState });
        if (document.visibilityState === "hidden") { persistNow(); shipBeacon(); }
      });
      window.addEventListener("pagehide", (e) => {
        dlog("info", "page.pagehide", { persisted: !!(e && e.persisted) });
        persistNow();
        shipBeacon();
      });
      setInterval(() => { try { flushNow(); } catch { /* ignore */ } }, SHIP_INTERVAL_MS);
      replayLeftover();
    } catch { /* even installation failures must be silent */ }
  }

  install();

  return {
    dlog,
    setAuth,
    logGate,
    flush: () => { try { flushNow(); } catch { /* ignore */ } },
    stats: () => ({ ring: ring.length, pending: pending.length, authed, inFlight }),
  };
}

/* Singleton resolution: reuse a pre-existing instance (double-eval under a
   different URL must NOT install duplicate listeners/timers), else create one
   and publish it for non-importing consumers. */
const inst = (typeof window !== "undefined" && window.__studio2Diag)
  ? window.__studio2Diag
  : makeInstance();
if (typeof window !== "undefined" && !window.__studio2Diag) {
  try { window.__studio2Diag = inst; } catch { /* ignore */ }
}

export function dlog(level, msg, data) { try { inst.dlog(level, msg, data); } catch { /* never throws */ } }
export function setAuth(value) { try { inst.setAuth(value); } catch { /* never throws */ } }
/* Emit the M3 render-gate boot fact (cap.render). Accepts the full caps object
   (reads caps.render) or a bare render block. NEVER throws. */
export function logGate(capsOrRender) { try { inst.logGate(capsOrRender); } catch { /* never throws */ } }
export function flush() { try { inst.flush(); } catch { /* never throws */ } }
export function stats() { try { return inst.stats(); } catch { return { ring: 0, pending: 0, authed: false, inFlight: false }; } }
