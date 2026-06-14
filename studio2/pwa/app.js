/* =============================================================================
   app.js — bootstrap + view orchestration for Studio v2.
   -----------------------------------------------------------------------------
   Boot flow (arch §7.4):
     0. register the service worker (offline shell, §7.5)
     1. diagnostics (diag.js — best-effort, never required)
     2. capability probe (capability.js) → no OPFS/createWritable ⇒ FULL-STOP
        unsupported screen (Tier-1 floor, banked #7)
     3. storage housekeeping: sweep *.tmp orphans + reconcile the crash marker
     4. auth gate: GET /api/me —
          authenticated        → PROJECTS view
          401 / not authed     → LOGIN view
          NETWORK FAILURE      → OFFLINE: the projects view still opens (they
                                 live in OPFS), with the offline banner up.
        Never collapse offline into signed-out (arch §7.5).
     5. update banner via /api/me asset_version (v1 pattern; v2 lineage starts
        at "1") + secure-context banner.

   Views: loading → unsupported | login | projects | editor.
   The EDITOR view is an intentional shell in Step 2 — #editor-mount is the
   clean mount point Step 5's editor.js takes over (see DOCUMENT.md: add the
   module to loadModules() + sw.js PRECACHE, call initEditor in enterEditor).

   ── ROBUST BOOT (v1 safety net, kept) ───────────────────────────────────────
   Feature modules load via DYNAMIC import() inside boot()'s try/catch — a
   failed static import would abort this module before any catch could run and
   strand the user on the splash. index.html carries the inline watchdog for
   the case where THIS file fails to load at all.
============================================================================= */

import { byId, toast } from "./util.js";

/* Cache-busting version for dynamically imported feature modules. v2 has its
   OWN lineage (PM resolution #7); "2" = the Step-5 editor landing; "3" = the
   M1 P3 cosmetic fixes (offline-banner lifecycle + chat run-on paragraphs);
   "4" = the reviewer-fix pass (cut.js snap epsilon, api.js dead-export
   removal, bridge.js byte-accurate result cap); "5" = M1.1 phone navigation
   (Media/Edit/Preview tab bar + keyboard-aware chat; new tabs.js); "6" = the
   M1.2 QA P2 fixes (editor.js init-failure teardown, chat.js dangling-turn
   activity dot, styles.css toast offset while typing); "7" = M2 transcription
   (tap-to-transcribe UI + bridge read_transcript/find_in_transcript executors
   + engine/audio.js extraction + store/transcripts.js; new transcribe.js);
   "8" = the GLOBAL Agent Model Picker (new settings.js: the app-level Settings
   sheet hosting the GET/POST /api/agent/model picker + the Edit-tab current-model
   indicator; gear buttons on the projects header and the editor topbar); "9" =
   multi-select video ingest (the picker now accepts several videos in one tap;
   ingest.js drives them through the smart-ingest flow STRICTLY one at a time
   with batch progress — no precache list change, cache-name bump only); "10" =
   AGENT VISION (view_frames): NEW engine/frames.js (still-frame decode →
   downscaled rotation-correct JPEGs) joins the precache; bridge.js gains the
   view_frames executor + the 2 MiB result cap (lockstep with the relay).
   "13" = MUSIC MULTI-SELECT + iOS multi-select hints (the music picker gains
   `multiple` and imports a pick STRICTLY one at a time — a sequential
   single-flight batch mirroring ingest.js; a multi pick imports without
   auto-placing N overlapping beds; an on-screen iOS multi-select tip appears
   on both the music and video pickers — no precache list change, cache-name
   bump only).
   BUMP IN LOCKSTEP, four places: index.html's two ?v= references, this
   constant, sw.js's ASSET_VERSION (the SW cache name derives from it — the
   cache-first shell only re-fetches on a cache-name change), and setup.html's
   styles.css ?v=. The update banner keys off this. */
const ASSET_VERSION = "13";

const app = byId("app");

/** Signal the inline watchdog in index.html that the app has taken control. */
function markBooted() {
  try { window.__studio2Booted = true; } catch { /* ignore */ }
}

/* ---- diagnostics (diag.js) --------------------------------------------------
   Loaded FIRST in boot() so module-load failures and the boot facts are
   captured. The app NEVER depends on it: helpers are silent no-ops while diag
   is absent or broken. */
let diag = null;

function dlog(level, msg, data) {
  try { if (diag && typeof diag.dlog === "function") diag.dlog(level, msg, data); } catch { /* ignore */ }
}

function syncDiagAuth(authed) {
  try { if (diag && typeof diag.setAuth === "function") diag.setAuth(!!authed); } catch { /* ignore */ }
}

function setView(view) { if (app) app.dataset.view = view; }

/* Reveal the login view with a visible, actionable error (boot failures). */
function showBootError(message) {
  markBooted();
  dlog("error", "app.boot.error", { message: String(message || "").slice(0, 300) });
  setView("login");
  const errEl = byId("login-error");
  const errText = byId("login-error-text");
  if (errText) errText.textContent = message;
  if (errEl) errEl.dataset.show = "true";
}

/* ---- shared state ----------------------------------------------------------- */
let me = { authenticated: false, username: null, assetVersion: null, secureUrl: null };
let caps = null;
let offline = false;          // true while /api/me is unreachable (network-fail)
let activeProject = null;     // { id, name } the editor view is bound to

let mods = null;              // resolved feature-module exports (lazy)
let loginCtl = null;
let projectsCtl = null;

/* ---- module loading ----------------------------------------------------------- */
async function loadModules() {
  if (mods) return mods;
  const v = "?v=" + ASSET_VERSION;
  const [login, projects, capability, opfs, apiMod, editor, settings] = await Promise.all([
    import("./login.js" + v),
    import("./projects.js" + v),
    import("./capability.js" + v),
    import("./store/opfs.js" + v),
    import("./api.js" + v),
    import("./editor.js" + v),
    import("./settings.js" + v),
  ]);
  mods = {
    initLogin: login.initLogin,
    initProjects: projects.initProjects,
    probeCapabilities: capability.probeCapabilities,
    capsForDiag: capability.capsForDiag,
    sweepTmp: opfs.sweepTmp,
    takeOpMarker: opfs.takeOpMarker,
    getMe: apiMod.getMe,
    logout: apiMod.logout,
    isNetworkError: apiMod.isNetworkError,
    apiGet: apiMod.api.get,
    initEditor: editor.initEditor,
    openSettings: settings.openSettings,
  };
  return mods;
}

/* ---- service worker ------------------------------------------------------------ */
/* Registered at ROOT scope (/sw.js) so the offline shell covers start_url "/".
   The relay must alias GET /sw.js → pwa/sw.js (and /manifest.webmanifest →
   pwa/manifest.webmanifest) — same pattern as GET / → index.html.
   Registration failure is journaled, never fatal: the app simply isn't
   offline-capable this run. */
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    dlog("info", "sw.unsupported");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    dlog("info", "sw.registered", { scope: reg.scope });
  } catch (err) {
    dlog("warn", "sw.register.err", { message: String(err && err.message).slice(0, 200) });
  }
}

/* ---- offline banner -------------------------------------------------------------
   Shown while Studio's brain (the relay) is unreachable. Projects, preview and
   export keep working — only chat needs the connection (arch §7.5).

   LIFECYCLE (v3 fix): the banner must also CLEAR without a reload or tab
   switch. The 5-minute version poll is far too slow for that, so while the
   banner is up a 10s recheck runs on a visible tab, and other modules signal
   relay evidence via the "studio2:relay-seen" window event (chat.js fires it
   when the bridge comes online or a chat turn streams — the exact situation
   where chat demonstrably works while a stale banner still shows). Both paths
   VERIFY via /api/me instead of blind-clearing, so a spurious signal can
   never flicker the banner; setOffline() no-ops on same-state. */
const OFFLINE_RECHECK_MS = 10 * 1000;
let offlineRecheckTimer = null;

function setOffline(value) {
  const next = !!value;
  if (next === offline) return;
  offline = next;
  const banner = byId("offline-banner");
  if (banner) banner.hidden = !offline;
  dlog(offline ? "warn" : "info", offline ? "app.offline" : "app.online");
  syncOfflineRecheck();
}

/* Run the fast recheck ONLY while offline; tear it down the moment the relay
   answers (no background polling in the healthy state). */
function syncOfflineRecheck() {
  if (offline && offlineRecheckTimer === null) {
    offlineRecheckTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;   // visibility regain rechecks anyway
      recheckConnectivity();
    }, OFFLINE_RECHECK_MS);
  } else if (!offline && offlineRecheckTimer !== null) {
    clearInterval(offlineRecheckTimer);
    offlineRecheckTimer = null;
  }
}

let recheckInFlight = false;   // collapse overlapping triggers (interval + events)

async function recheckConnectivity() {
  if (!mods || recheckInFlight) return;
  recheckInFlight = true;
  try {
    const r = await mods.getMe();
    me = r;
    setOffline(false);
    syncDiagAuth(r.authenticated);
    maybeShowUpdateBanner(r.assetVersion);
    maybeShowSecureBanner(r.secureUrl);
  } catch (err) {
    if (mods.isNetworkError(err)) setOffline(true);
    // a non-network error keeps the current state; next tick retries
  } finally {
    recheckInFlight = false;
  }
}

/* ---- views ----------------------------------------------------------------------- */

function showLogin(reset) {
  leaveEditor();
  setView("login");
  activeProject = null;
  const bootErr = byId("login-error");
  if (bootErr) bootErr.dataset.show = "false";
  if (!loginCtl) {
    loginCtl = mods.initLogin({
      onSuccess: (info) => {
        if (info && info.username) me.username = info.username;
        me.authenticated = true;
        // Bare boolean only — never a credential field.
        syncDiagAuth(true);
        dlog("info", "app.login.ok");
        showProjects();
      },
    });
  }
  if (reset) loginCtl.reset();
  requestAnimationFrame(() => loginCtl.focus());
}

function showProjects() {
  leaveEditor();
  setView("projects");
  activeProject = null;
  const userEl = byId("projects-user");
  if (userEl) {
    userEl.textContent = me.username || "";
    userEl.hidden = !me.username;
  }
  if (!projectsCtl) {
    projectsCtl = mods.initProjects({
      caps,
      onOpen: (project) => enterEditor(project),
    });
    const logoutBtn = byId("projects-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        await mods.logout();
        syncDiagAuth(false);   // cookie cleared — diag buffers until next login
        me = { ...me, authenticated: false, username: null };
        showLogin(true);
        toast("Signed out.", "info");
      });
    }
    // App-level Settings gear (hosts the GLOBAL agent-model picker). Wired once,
    // alongside logout, inside the same projectsCtl-init guard.
    const settingsBtn = byId("projects-settings");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", () => {
        dlog("info", "app.settings.open", { from: "projects" });
        mods.openSettings();
      });
    }
  }
  projectsCtl.show();
}

/* Enter the editor for an opened project: bind the chrome, switch the view,
   then mount editor.js (Step 5) into #editor-mount. A generation token guards
   the async mount against a fast back-tap; leaveEditor() tears the previous
   session down before a new one starts (bridge stream, blob URLs, listeners). */
let editorCtl = null;
let editorGen = 0;

function leaveEditor() {
  if (!editorCtl) return;
  try { editorCtl.destroy(); } catch (err) {
    console.error("[studio2] editor teardown error:", err);
  }
  editorCtl = null;
}

async function enterEditor(project) {
  leaveEditor();
  activeProject = project;
  const gen = ++editorGen;
  dlog("info", "app.editor.enter", { project_id: project.id });
  const nameEl = byId("editor-project-name");
  if (nameEl) nameEl.textContent = project.name;
  setView("editor");
  try {
    const ctl = await mods.initEditor({ project, caps });
    if (gen !== editorGen || app.dataset.view !== "editor") {
      // The user left before the mount finished — tear it straight down.
      try { ctl.destroy(); } catch { /* already clean */ }
      return;
    }
    editorCtl = ctl;
  } catch (err) {
    console.error("[studio2] editor failed to open:", err);
    dlog("error", "app.editor.err", { message: String(err && err.message).slice(0, 300) });
    toast("Couldn't open the editor — refresh the page and try again.", "bad", 6000);
    showProjects();
  }
}

function initEditorChrome() {
  const backBtn = byId("editor-back");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      // Step-4 contract: never unmount mid-ingest (the streamed OPFS copy
      // dies with the DOM); a running export gets the same respect.
      if (editorCtl && typeof editorCtl.busy === "function" && editorCtl.busy()) {
        toast("Hang on — a video is still being processed. You can leave when it finishes.", "info", 5000);
        return;
      }
      dlog("info", "app.editor.leave", { project_id: activeProject && activeProject.id });
      editorGen += 1;          // cancels an in-flight mount
      leaveEditor();
      showProjects();
    });
  }
  // Editor topbar Settings gear — same GLOBAL picker, reachable while editing.
  // Wired once at boot (the topbar chrome is a fixed shell, not per-project).
  const settingsBtn = byId("editor-settings");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      dlog("info", "app.settings.open", { from: "editor" });
      if (mods && typeof mods.openSettings === "function") mods.openSettings();
    });
  }
}

/* ---- unsupported screen (Tier-1 floor) -------------------------------------------- */
function showUnsupported(capsResult) {
  markBooted();
  setView("unsupported");
  const detailEl = byId("unsupported-detail");
  if (detailEl) {
    const missing = [];
    if (!capsResult.opfs) missing.push("private file storage");
    if (capsResult.opfs && !capsResult.createWritable) missing.push("the ability to save large files");
    detailEl.textContent = "This browser is missing " +
      (missing.join(" and ") || "a required feature") +
      ", which Studio needs to keep your videos on this device.";
  }
  dlog("error", "cap.unsupported", { opfs: capsResult.opfs, writable: capsResult.createWritable });
}

/* ---- stale-frontend detection (v1 pattern, v2 lineage) ----------------------------- */
const VERSION_POLL_MS = 5 * 60 * 1000;
let bannerShownFor = null;
let bannerDismissedFor = null;

function initUpdateBanner() {
  const banner = byId("update-banner");
  const refreshBtn = byId("update-refresh");
  const dismissBtn = byId("update-dismiss");
  if (!banner || !refreshBtn || !dismissBtn) return;
  refreshBtn.addEventListener("click", () => {
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
  if (!Number.isFinite(sv) || !Number.isFinite(lv) || sv <= lv) return;   // strictly newer only
  const v = String(serverVersion);
  if (v === bannerDismissedFor) return;
  const banner = byId("update-banner");
  if (!banner) return;
  const firstShow = !(bannerShownFor === v && banner.hidden === false);
  bannerShownFor = v;
  banner.hidden = false;
  if (firstShow) dlog("info", "app.banner.show", { server_v: v, page_v: ASSET_VERSION });
}

function startConnectivityWatch() {
  setInterval(() => {
    if (document.visibilityState === "hidden") return;   // don't poll a hidden tab
    recheckConnectivity();
  }, VERSION_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recheckConnectivity();
  });
  window.addEventListener("online", () => recheckConnectivity());
  window.addEventListener("offline", () => setOffline(true));
  // Relay evidence from another module (chat stream / bridge online) while the
  // banner is up → verify and clear NOW, not at the next 10s tick.
  window.addEventListener("studio2:relay-seen", () => {
    if (offline) recheckConnectivity();
  });
}

/* ---- secure-context banner (v1 pattern) ---------------------------------------------
   Shown ONLY when this page is NOT a secure context AND the server reports a
   secure_url. On a phone that did v1's Secure Setup the https origin already
   works (shared CA) — the banner just routes them to it. Dismissal persists
   7 days (gently re-shown; secure context gates wake lock + install). */
const SECURE_DISMISS_KEY = "studio2.secureBanner.dismissedAt";
const SECURE_RESHOW_MS = 7 * 24 * 60 * 60 * 1000;
let secureDismissedThisRun = false;

function secureBannerDismissed() {
  if (secureDismissedThisRun) return true;
  try {
    const raw = localStorage.getItem(SECURE_DISMISS_KEY);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < SECURE_RESHOW_MS;
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
    try { localStorage.setItem(SECURE_DISMISS_KEY, String(Date.now())); } catch { /* tab-lifetime only */ }
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
  const firstShow = banner.hidden;
  banner.hidden = false;
  if (firstShow) dlog("info", "app.securebanner.show");
}

/* ---- boot ------------------------------------------------------------------------- */
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  markBooted();

  // Phase 0 — service worker first (so even THIS visit primes the offline
  // shell), then diagnostics. Both best-effort.
  registerServiceWorker();
  try {
    diag = await import("./diag.js?v=" + ASSET_VERSION);
  } catch (err) {
    console.error("[studio2] diagnostics unavailable (continuing without):", err);
  }

  // Phase 1 — feature modules. A failure must NOT leave a blank screen.
  try {
    await loadModules();
  } catch (err) {
    console.error("[studio2] Failed to load app modules:", err);
    showBootError("Couldn't load the app. Refresh the page — if it persists, restart Studio on the computer.");
    return;
  }

  // Phase 2 — capability probe (arch §7.4). The matrix rides the boot facts.
  try {
    caps = await mods.probeCapabilities();
  } catch (err) {
    console.error("[studio2] capability probe failed:", err);
    caps = { supported: false, opfs: false, createWritable: false, webcodecs: {}, storage: {} };
  }
  dlog("info", "app.boot", {
    v: ASSET_VERSION,
    ua: String(navigator.userAgent || "").slice(0, 200),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio || 1,
    online: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
    standalone: window.matchMedia && window.matchMedia("(display-mode: standalone)").matches,
    caps: mods.capsForDiag(caps),
  });

  if (!caps.supported) {
    // Tier-1 floor (banked #7): no OPFS/createWritable → full stop. No degraded
    // half-app — the product promise (videos stay on the device) cannot hold.
    showUnsupported(caps);
    return;
  }

  // Phase 3 — storage housekeeping (arch §5.1): sweep .tmp orphans, then
  // reconcile the crash marker (an op recorded as started but never finished).
  initEditorChrome();
  try {
    const swept = await mods.sweepTmp();
    if (swept.length > 0) dlog("warn", "store.sweep", { count: swept.length, names: swept.slice(0, 10) });
  } catch { /* sweep is best-effort */ }
  try {
    const marker = mods.takeOpMarker();
    if (marker) {
      dlog("warn", "store.crashmarker", marker);
      toast("Something was interrupted last time (" + String(marker.op) + "). Your edits are safe — finished work is never lost mid-step.", "info", 8000);
    }
  } catch { /* marker is best-effort */ }

  // Phase 4 — auth gate, OFFLINE-AWARE (arch §7.5).
  try {
    me = await mods.getMe();
    setOffline(false);
    syncDiagAuth(me.authenticated);
    if (me.authenticated) {
      showProjects();
    } else {
      showLogin();
    }
  } catch (err) {
    if (mods.isNetworkError(err)) {
      // Relay unreachable ≠ signed out: projects/preview/export are local.
      setOffline(true);
      dlog("warn", "app.boot.offline");
      showProjects();
    } else {
      console.error("[studio2] Boot error during auth gate:", err);
      showLogin();
      toast("Couldn't check the sign-in state. You can keep working — projects live on this device.", "bad", 6000);
    }
  }

  // Phase 5 — banners + watches (update / secure / connectivity).
  initUpdateBanner();
  initSecureBanner();
  maybeShowUpdateBanner(me.assetVersion);
  maybeShowSecureBanner(me.secureUrl);
  startConnectivityWatch();
}

// Module scripts execute after the DOM is parsed; guard the unlikely case the
// document is still loading.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
