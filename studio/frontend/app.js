/* =============================================================================
   app.js — bootstrap + view orchestration for video-use Studio.
   -----------------------------------------------------------------------------
   Flow (per-user SESSIONS):
     1. GET /api/me — auth gate. Authenticated → SESSIONS screen; else → login.
        Auth is the httpOnly studio_session cookie only; there is no token to
        capture from the URL. (Resilient: if /api/me is absent, falls back to a
        cookie-authenticated /api/status probe.) /api/me also reports the
        username (for the topbar) and a stale-session count hint.
     2. SESSIONS screen — the user picks/creates a session (their own, scoped by
        the cookie's username). Right after login (and on authenticated load) a
        stale-cleanup modal pops if any session is idle past the threshold.
     3. Opening a session stores {id, dir, name} as the ACTIVE session and enters
        the editor DASHBOARD. `dir` (absolute, from the open response) is what
        chat.js joins with "edit/…" to resolve artifacts. Every editor call
        (chat / inventory / outputs / transcribe / upload) carries session_id.
     4. "Back to sessions" returns to the list; Logout returns to login.

   This is the only module that knows about view switching. Feature modules
   (login, sessions, status, panel, chat, preview, upload, drawer, qr) are
   self-contained.

   ── ROBUST BOOT (safety net) ────────────────────────────────────────────────
   Feature modules are pulled in with DYNAMIC import() inside boot()'s try/catch
   rather than top-level static imports. A failed STATIC import (e.g. a 404 on a
   renamed/removed /static/<module>.js) aborts this whole module at evaluation
   time — before any try/catch can run — so boot() would never run, the loading
   splash would never lift, and the user would see a blank near-black screen with
   no way to recover. With dynamic import(), any load/boot failure is caught and
   the LOGIN view is revealed with a visible, actionable error instead of an empty
   screen. (index.html also carries a tiny inline watchdog that lifts the splash
   even if THIS file fails to load at all.)
============================================================================= */

import { byId, toast } from "./util.js";

/* Cache-busting version for DYNAMICALLY imported feature modules. Must mirror the
   ?v= on app.js/styles.css in index.html: this file is fetched fresh (index.html
   already bumps app.js?v=N), but its dynamic import() URLs carry no query of their
   own, so a returning client could keep running STALE cached modules after a
   deploy. Bump this in lockstep with the index.html ?v= to close that gap. */
const ASSET_VERSION = "16";

const app = byId("app");

/** Signal the inline watchdog in index.html that the app has taken control. */
function markBooted() {
  try { window.__studioBooted = true; } catch { /* ignore */ }
}

/* ---- diagnostics (diag.js) --------------------------------------------------
   Loaded FIRST in boot() (versioned, like every feature module) so module-load
   failures and the boot facts are captured and shipped to /api/client-log.
   The app NEVER depends on it: both helpers are silent no-ops while diag is
   absent or broken. `syncDiagAuth` gates shipping on the login state — diag
   buffers events until the session cookie can authenticate the POST. */
let diag = null;   // resolved diag.js module (or null — diagnostics optional)

function dlog(level, msg, data) {
  try { if (diag && typeof diag.dlog === "function") diag.dlog(level, msg, data); } catch { /* ignore */ }
}

function syncDiagAuth(authed) {
  try { if (diag && typeof diag.setAuth === "function") diag.setAuth(!!authed); } catch { /* ignore */ }
}

function setView(view) { if (app) app.dataset.view = view; }

/* Reveal the login view and surface a human-readable error in its existing
   error slot — used when boot can't complete (module load failure, etc.). */
function showBootError(message) {
  markBooted();
  dlog("error", "app.boot.error", { message: String(message || "").slice(0, 300) });
  setView("login");
  const errEl = byId("login-error");
  const errText = byId("login-error-text");
  if (errText) errText.textContent = message;
  if (errEl) errEl.dataset.show = "true";
}

/* ---- shared state --------------------------------------------------------- */
let me = { authenticated: false, username: null, staleSessions: 0 };
/* The active session the editor is bound to: { id, dir, name }. `dir` is the
   absolute on-disk folder used by chat.js to resolve "edit/…" artifacts. */
let activeSession = null;

/* ---- module singletons (created once on first use) ---- */
let dash = null;
let sessionsCtl = null;
let loginCtl = null;
let mods = null; // resolved feature-module exports (lazy)

/* Load every feature module the dashboard/login/sessions need. Dynamic import()
   means a failed fetch rejects a promise we can catch — it does NOT abort this
   module. */
async function loadModules() {
  if (mods) return mods;
  const v = "?v=" + ASSET_VERSION;   // mirror index.html's ?v= so deploys aren't served stale
  const [login, sessions, status, drawer, panel, chat, preview, upload, guide, api] = await Promise.all([
    import("./login.js" + v),
    import("./sessions.js" + v),
    import("./status.js" + v),
    import("./drawer.js" + v),
    import("./panel.js" + v),
    import("./chat.js" + v),
    import("./preview.js" + v),
    import("./upload.js" + v),
    import("./guide.js" + v),
    import("./api.js" + v),
  ]);
  mods = {
    initLogin: login.initLogin,
    initSessions: sessions.initSessions,
    initStatus: status.initStatus,
    initChrome: drawer.initChrome,
    initPanel: panel.initPanel,
    initChat: chat.initChat,
    initPreview: preview.initPreview,
    initUpload: upload.initUpload,
    initGuide: guide.initGuide,
    getMe: api.getMe,
    logout: api.logout,
    // Raw GET (cookie-auth) — used by the asset-version check, which needs the
    // unmapped /api/me payload (`asset_version`) without changing api.getMe.
    apiGet: api.api.get,
  };
  return mods;
}

/* ---- dashboard wiring ----------------------------------------------------- */
function buildDashboard() {
  if (dash) return dash;
  const { initStatus, initChrome, initPreview, initChat, initPanel, initUpload, initGuide, logout } = mods;

  const status = initStatus();
  const chrome = initChrome();
  const preview = initPreview();

  /* ---- red-thread guide state (drives the 4-step stepper) ----
     Aggregated here because the pieces live in three modules: clips/transcripts
     from the panel inventory, message count from chat, render outputs from
     /api/outputs. guide.js only renders. */
  const guideState = { clips: 0, transcribed: false, chatCount: 0, previewExists: false, finalExists: false };
  function syncGuide(partial) {
    Object.assign(guideState, partial || {});
    guide.update({ ...guideState });
  }

  const chat = initChat({
    getSessionId: () => (activeSession ? activeSession.id : null),
    getDir: () => (activeSession ? activeSession.dir : null),
    getClipCount: () => guideState.clips,
    onAddFootage: () => { chrome.revealUpload(); },
    onHistoryChanged: (count) => { syncGuide({ chatCount: count }); },
    onArtifacts: (artifacts, info) => {
      // open the first media/png artifact in the preview/lightbox
      const a = artifacts[0];
      preview.openArtifact(a, info && info.info ? info.info : info);
      chrome.revealPreview();
    },
    onRenderDone: async () => {
      const data = await panel.loadOutputs();
      // Reveal FIRST, then request playback: nothing may touch/reset the
      // preview element AFTER play is requested (the play-never-starts P1).
      chrome.revealPreview();
      if (data) preview.setOutputs(data, { autoplay: true });
      // "Your video is ready" moment — unmissable but not modal: a card in the
      // chat flow (Play + Download) plus a success toast.
      const best = data && data.final && data.final.exists ? { info: data.final, kind: "final" }
        : data && data.preview && data.preview.exists ? { info: data.preview, kind: "preview" }
        : null;
      if (best && best.info.path) {
        chat.showReadyCard({
          kind: best.kind,
          path: best.info.path,
          onPlay: () => {
            // Same ordering rule: reveal, THEN play — setOutputs(autoplay) is
            // the last thing to act on the <video> in this click.
            chrome.revealPreview();
            preview.setOutputs(data, { prefer: best.kind, autoplay: true });
          },
        });
        toast(best.kind === "final" ? "Your video is ready." : "Draft preview is ready.", "ok");
      }
    },
  });

  const panel = initPanel({
    status,
    onBackToSessions: () => { showSessions(); },
    onStartEditing: () => { chrome.closeDrawer(false); chat.focus(); },
  });

  // outputs-change wiring (preview reacts to panel's /api/outputs payloads)
  panel.onOutputs((data, action) => {
    preview.setOutputs(data, action && action.open === "final" ? { prefer: "final" } : {});
    if (action && action.open && action.info) {
      preview.openArtifact(action.info.path || "", action.info);
      chrome.revealPreview();
    }
    syncGuide({
      previewExists: !!(data && data.preview && data.preview.exists),
      finalExists: !!(data && data.final && data.final.exists),
    });
  });

  // inventory-change wiring (stepper + the chat empty state react to clips)
  panel.onInventory(({ count, transcribedCount }) => {
    syncGuide({ clips: count, transcribed: transcribedCount > 0 });
    chat.refreshEmpty();
  });

  const upload = initUpload({
    getSessionId: () => (activeSession ? activeSession.id : null),
    onUploaded: () => {
      panel.loadInventory();
      panel.showNextStep();        // "Transcribe / Skip — start editing" card
    },
  });

  // the 4-step journey stepper — steps jump to the matching surface
  const guide = initGuide({
    onStep: (key) => {
      if (key === "footage") chrome.revealUpload();
      else if (key === "transcribe") chrome.revealTranscribe();
      else if (key === "edit") { chrome.closeDrawer(false); chat.focus(); }
      else if (key === "video") chrome.revealPreview(true);
    },
  });
  function resetGuide() {
    Object.assign(guideState, { clips: 0, transcribed: false, chatCount: 0, previewExists: false, finalExists: false });
    guide.reset();
  }

  // status drives chat-enable
  status.onUpdate(() => {
    enable(chat, canChat(status));
  });

  // logout
  byId("logout-btn").addEventListener("click", async () => {
    await logout();
    syncDiagAuth(false);   // cookie cleared — diag buffers until the next login
    activeSession = null;
    showLogin(true);
    toast("Signed out.", "info");
  });

  dash = { status, chrome, panel, chat, preview, upload, guide, resetGuide };
  return dash;
}

function canChat(status) {
  if (!activeSession) return { ready: false, reason: "Open a session to start editing." };
  const last = status.last;
  if (last && last.agent && last.agent.state === "bad") {
    return { ready: false, reason: "The editor isn’t signed in on the Studio computer — on that machine, run `claude` once, then restart Studio." };
  }
  return { ready: true, reason: "" };
}

/* normalize canChat result into setEnabled signature */
function enable(chat, res) {
  chat.setEnabled(res.ready, res.reason);
}

/* ---- view transitions ----------------------------------------------------- */

/* SESSIONS screen — list the user's sessions + (post-login) stale-cleanup modal.
   Opening a session from here calls enterDashboard() with {id, dir, name}. */
function showSessions() {
  setView("sessions");
  activeSession = null;
  if (!sessionsCtl) {
    sessionsCtl = mods.initSessions({
      onOpen: (session) => { enterDashboard(session); },
    });
    // Logout from the sessions screen (bound once; app.js owns view transitions).
    const logoutBtn = byId("sessions-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        await mods.logout();
        syncDiagAuth(false);   // cookie cleared — diag buffers until the next login
        activeSession = null;
        me = { authenticated: false, username: null, staleSessions: 0 };
        showLogin(true);
        toast("Signed out.", "info");
      });
    }
  }
  // (re)load the list + maybe pop the stale modal; pass username for the header
  sessionsCtl.show(me).catch((err) => {
    if (err && err.status === 401) { showLogin(); }
  });
}

/* Enter the editor for a freshly-opened session. */
async function enterDashboard(session) {
  activeSession = session;
  dlog("info", "app.session.open", { session_id: session && session.id });
  setView("dashboard");
  const d = buildDashboard();
  // fresh session → reset the journey stepper before async loads repopulate it
  d.resetGuide();
  // show the signed-in username in the topbar (textContent — no injection)
  const userEl = byId("topbar-user");
  if (userEl) {
    userEl.textContent = me && me.username ? me.username : "";
    userEl.hidden = !(me && me.username);
  }
  d.chrome.place();
  // bind the panel to this session (loads inventory + outputs)
  d.panel.setSession(session);
  // load this session's conversation + enable the composer
  d.chat.loadHistory(session.id);
  enable(d.chat, canChat(d.status));
  // refresh system status (ffmpeg / agent auth); 401 bounces to login
  await d.status.refresh().catch((err) => {
    if (err && err.status === 401) { showLogin(); return null; }
    return null;
  });
  enable(d.chat, canChat(d.status));
}

function showLogin(reset) {
  setView("login");
  activeSession = null;
  // Clear any stale boot/watchdog error banner now that login is shown normally.
  const bootErr = byId("login-error");
  if (bootErr) bootErr.dataset.show = "false";
  if (!loginCtl) {
    loginCtl = mods.initLogin({
      onSuccess: (info) => {
        if (info && info.username) me.username = info.username;
        me.authenticated = true;
        // Deliberately a bare boolean event — never the username or any
        // credential field; the server logs identity from the session itself.
        syncDiagAuth(true);
        dlog("info", "app.login.ok");
        // Re-read /api/me so the stale-session hint is current right after login,
        // then land on the sessions screen (which pops the cleanup modal itself
        // from the authoritative /api/sessions payload).
        refreshMe().finally(() => showSessions());
      },
    });
  }
  if (reset) loginCtl.reset();
  // focus after the view is painted
  requestAnimationFrame(() => loginCtl.focus());
}

/* Pull the current auth/identity snapshot into shared state. */
async function refreshMe() {
  try {
    me = await mods.getMe();
    syncDiagAuth(me.authenticated);
  } catch { /* keep prior snapshot; sessions screen will surface load failures */ }
  return me;
}

/* ---- stale-frontend detection ----------------------------------------------
   GET /api/me now reports the server's parsed `asset_version`. A long-lived tab
   (a phone left open across a deploy) that sees a NEWER server version shows a
   slim, dismissible "refresh to get the latest" banner. Shown ONLY when the
   server version is strictly newer — never on null / equal / older.
   Cadence: once at boot, then a light 5-minute check while the tab is visible,
   plus an immediate re-check whenever the tab becomes visible again (there is
   no pre-existing /api/me polling loop to piggyback on — status refreshes are
   event-driven — so this is the minimal interval that satisfies "within
   minutes" without hammering the server). */
const VERSION_POLL_MS = 5 * 60 * 1000;
let bannerShownFor = null;       // server version currently displayed
let bannerDismissedFor = null;   // server version the user dismissed

function initUpdateBanner() {
  const banner = byId("update-banner");
  const refreshBtn = byId("update-refresh");
  const dismissBtn = byId("update-dismiss");
  if (!banner || !refreshBtn || !dismissBtn) return;
  refreshBtn.addEventListener("click", () => {
    // The reload tears the tab down — diag's pagehide beacon ships this event.
    dlog("info", "app.banner.refresh", { v: bannerShownFor });
    try { location.reload(); } catch { /* ignore */ }
  });
  dismissBtn.addEventListener("click", () => {
    dlog("info", "app.banner.dismiss", { v: bannerShownFor });
    bannerDismissedFor = bannerShownFor;
    banner.hidden = true;
  });
}

function maybeShowUpdateBanner(serverVersion) {
  if (serverVersion == null) return;
  const sv = parseInt(String(serverVersion), 10);
  const lv = parseInt(ASSET_VERSION, 10);
  if (!Number.isFinite(sv) || !Number.isFinite(lv) || sv <= lv) return;   // null/equal/older → never
  const v = String(serverVersion);
  if (v === bannerDismissedFor) return;          // user already dismissed this one
  const banner = byId("update-banner");
  if (!banner) return;
  // Log only the SHOW transition — the poll re-runs this every cycle while the
  // banner stays up, and re-logging each tick would just be noise.
  const firstShow = !(bannerShownFor === v && banner.hidden === false);
  bannerShownFor = v;
  banner.hidden = false;
  if (firstShow) dlog("info", "app.banner.show", { server_v: v, page_v: ASSET_VERSION });
}

async function checkAssetVersion() {
  if (!mods || !mods.apiGet) return;
  if (document.visibilityState === "hidden") return;   // don't poll a hidden tab
  try {
    const r = await mods.apiGet("/api/me");
    // Self-healing diag auth signal: this is the only periodic /api/me read,
    // so a mid-run session expiry (or a re-login in another tab) re-gates
    // diag shipping without any extra polling.
    if (r && typeof r.authenticated === "boolean") syncDiagAuth(r.authenticated);
    maybeShowUpdateBanner(r && r.asset_version);
    // The same raw payload carries `secure_url` (the HTTPS origin, when TLS is
    // up) — drive the secure-address onboarding banner off this read too, so
    // boot + the 5-minute poll + visibilitychange all keep it current.
    maybeShowSecureBanner(r ? r.secure_url : null);
  } catch { /* network blip — next tick will retry */ }
}

function startVersionWatch() {
  checkAssetVersion();
  setInterval(checkAssetVersion, VERSION_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkAssetVersion();
  });
}

/* ---- secure-address onboarding banner (#secure-banner) ----------------------
   The Wake Lock API needs a secure context, so on the plain-http origin phone
   uploads only survive while the screen is kept on by hand. When the server
   reports a secure_url on /api/me AND this page is NOT a secure context, a
   slim banner nudges the user to the one-time /setup flow (CA trust → https).
   Hard gates — the banner can NEVER appear when:
     • window.isSecureContext is true (already on the https origin), or
     • secure_url is null/absent (TLS off or an older backend).
   Dismissal is gently persistent: the dismiss tap stores a timestamp in
   localStorage under SECURE_DISMISS_KEY ("studio.secureBanner.dismissedAt",
   ms-since-epoch as a string) and the banner stays away for 7 days
   (SECURE_RESHOW_MS), then becomes eligible again — hands-off uploads matter
   enough to re-ask occasionally, but never to nag every visit. Visibility is
   re-evaluated on every checkAssetVersion() tick (boot + 5-min poll +
   visibilitychange), which also HIDES a showing banner if secure_url goes
   null mid-run (TLS turned off). Storage failures (private mode) fail open:
   the banner shows, and dismissal lasts for the tab's lifetime only. */
const SECURE_DISMISS_KEY = "studio.secureBanner.dismissedAt";
const SECURE_RESHOW_MS = 7 * 24 * 60 * 60 * 1000;   // re-show after 7 days
let secureDismissedThisRun = false;   // private-mode fallback (no localStorage)

function secureBannerDismissed() {
  if (secureDismissedThisRun) return true;
  try {
    const raw = localStorage.getItem(SECURE_DISMISS_KEY);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;            // garbage → eligible
    return Date.now() - ts < SECURE_RESHOW_MS;         // expired → eligible again
  } catch { return false; }
}

function initSecureBanner() {
  const banner = byId("secure-banner");
  const dismissBtn = byId("secure-dismiss");
  const setupLink = byId("secure-setup-link");
  if (!banner || !dismissBtn) return;
  if (setupLink) {
    setupLink.addEventListener("click", () => { dlog("info", "app.securebanner.setup"); });
  }
  dismissBtn.addEventListener("click", () => {
    secureDismissedThisRun = true;
    try { localStorage.setItem(SECURE_DISMISS_KEY, String(Date.now())); } catch { /* tab-lifetime dismissal only */ }
    banner.hidden = true;
    dlog("info", "app.securebanner.dismiss");
  });
}

function maybeShowSecureBanner(secureUrl) {
  const banner = byId("secure-banner");
  if (!banner) return;
  const eligible =
    !window.isSecureContext &&
    typeof secureUrl === "string" && secureUrl.length > 0 &&
    !secureBannerDismissed();
  if (!eligible) { banner.hidden = true; return; }
  // Log only the SHOW transition (the poll re-runs this every cycle).
  const firstShow = banner.hidden;
  banner.hidden = false;
  if (firstShow) dlog("info", "app.securebanner.show");
}

/* ---- boot ----------------------------------------------------------------- */
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;

  // Reaching boot() already proves app.js (and the whole module graph that
  // statically imports it) loaded, so disarm the index.html watchdog up front.
  markBooted();

  // Phase 0 — diagnostics (best-effort; the app never depends on it). Loaded
  // BEFORE the feature modules so a Phase-1 load failure is itself captured,
  // and versioned like every other dynamic import. diag replays any leftover
  // events a previous (frozen/killed) run persisted, then this run's boot
  // facts open the new thread: version, device, viewport, connectivity.
  try {
    diag = await import("./diag.js?v=" + ASSET_VERSION);
    dlog("info", "app.boot", {
      v: ASSET_VERSION,
      ua: String(navigator.userAgent || "").slice(0, 200),
      screen: (typeof screen !== "undefined" && screen) ? `${screen.width}x${screen.height}` : "",
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio || 1,
      online: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
      visibility: document.visibilityState,
    });
  } catch (err) {
    console.error("[studio] diagnostics unavailable (continuing without):", err);
  }

  // Phase 1 — load the feature modules. A failure here (e.g. a 404 on any
  // /static/*.js) must NOT leave a blank screen: reveal login + a visible error.
  try {
    await loadModules();
  } catch (err) {
    console.error("[studio] Failed to load app modules:", err);
    showBootError("Couldn’t load the app. Refresh the page — if it persists, restart the Studio server.");
    return;
  }

  // Phase 2 — auth gate. Any unexpected error still lands the user on a usable
  // login view rather than a frozen splash.
  try {
    me = await mods.getMe();
    syncDiagAuth(me.authenticated);
    if (me.authenticated) {
      showSessions();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error("[studio] Boot error during auth gate:", err);
    showLogin();
    toast("Cannot reach the Studio server. Is it running?", "bad", 6000);
  }

  // Phase 3 — stale-frontend + secure-address watch (boot check + light
  // periodic re-check; both banners ride the same /api/me read).
  initUpdateBanner();
  initSecureBanner();
  startVersionWatch();
}

// Module scripts execute after the DOM is parsed; call boot directly, but guard
// in the unlikely case the document is still loading.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
