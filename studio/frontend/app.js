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
const ASSET_VERSION = "11";

const app = byId("app");

/** Signal the inline watchdog in index.html that the app has taken control. */
function markBooted() {
  try { window.__studioBooted = true; } catch { /* ignore */ }
}

function setView(view) { if (app) app.dataset.view = view; }

/* Reveal the login view and surface a human-readable error in its existing
   error slot — used when boot can't complete (module load failure, etc.). */
function showBootError(message) {
  markBooted();
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
  refreshBtn.addEventListener("click", () => { try { location.reload(); } catch { /* ignore */ } });
  dismissBtn.addEventListener("click", () => {
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
  bannerShownFor = v;
  banner.hidden = false;
}

async function checkAssetVersion() {
  if (!mods || !mods.apiGet) return;
  if (document.visibilityState === "hidden") return;   // don't poll a hidden tab
  try {
    const r = await mods.apiGet("/api/me");
    maybeShowUpdateBanner(r && r.asset_version);
  } catch { /* network blip — next tick will retry */ }
}

function startVersionWatch() {
  checkAssetVersion();
  setInterval(checkAssetVersion, VERSION_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkAssetVersion();
  });
}

/* ---- boot ----------------------------------------------------------------- */
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;

  // Reaching boot() already proves app.js (and the whole module graph that
  // statically imports it) loaded, so disarm the index.html watchdog up front.
  markBooted();

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

  // Phase 3 — stale-frontend watch (boot check + light periodic re-check).
  initUpdateBanner();
  startVersionWatch();
}

// Module scripts execute after the DOM is parsed; call boot directly, but guard
// in the unlikely case the document is still loading.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
