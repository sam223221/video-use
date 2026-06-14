/* =============================================================================
   sw.js — Studio v2 service worker: the offline shell (arch §7.5).
   -----------------------------------------------------------------------------
   Strategy:
     • CACHE-FIRST for the SHELL ONLY — html/js/css/fonts/icons/manifest,
       precached at install into a VERSION-KEYED cache. With the relay
       unreachable the app still opens: projects list, player previews and
       exports keep working; only chat needs the connection.
     • NETWORK-ONLY for /api/* — never cached, never served stale, no offline
       fallback (api.js turns the failure into its offline signal; serving a
       cached API response would lie to the auth gate).
     • Non-http(s) schemes (blob:, data:) and cross-origin requests are not
       touched at all (the PWA makes zero external-origin requests by
       convention — anything unexpected stays visible in devtools, not
       masked by SW handling).
     • No runtime cache growth: a request outside the precache list falls
       through to the network untouched. The shell cache is an exact,
       versioned artifact — not an accumulating mirror.

   Versioning: CACHE_NAME derives from ASSET_VERSION. BUMP IN LOCKSTEP with
   index.html's ?v= and app.js's ASSET_VERSION. On activate, every cache with
   our prefix and a different version is purged — a bump can never strand
   stale shells (bump-safe by construction). The relay serves this file with
   Cache-Control: no-cache, so browsers revalidate it on every visit and the
   new version installs promptly.

   Version "2" = Steps 4+5 (engine + editor). Version "3" = the M1 P3 cosmetic
   fixes (offline-banner lifecycle in app.js + chat run-on paragraphs in
   chat.js) — no precache list change, but the cache-first shell only
   re-fetches changed bytes on a cache-name bump. Version "4" = the
   reviewer-fix pass (cut.js snap epsilon, api.js dead openEventSource
   removal, bridge.js byte-accurate result cap). Version "5" = M1.1 phone
   navigation (Media/Edit/Preview tab bar + keyboard-aware chat; NEW tabs.js
   added to the precache). Version "6" = the M1.2 QA P2 fixes (editor.js
   init-failure teardown, chat.js dangling-turn activity dot, styles.css
   toast offset while typing) — no precache list change, cache-name bump
   only. Version "7" = M2 transcription: NEW transcribe.js (statically
   imported BARE by editor.js), NEW engine/audio.js + store/transcripts.js
   (dynamically imported BARE by editor.js) join the precache; bridge.js +
   ingest.js + api.js + editor.js + styles.css changed bytes ride the
   cache-name bump. Version "8" = the GLOBAL Agent Model Picker: NEW
   settings.js joins the precache under BOTH URLs — ?v= (dynamic-imported by
   app.js loadModules()) AND bare (static-imported by editor.js for
   mountModelIndicator, the sibling rule) — and api.js + editor.js + index.html
   + styles.css changed bytes ride the cache-name bump. Version "9" =
   MULTI-SELECT video ingest: the file input gains `multiple` and ingest.js
   drives the picked files through the smart-ingest flow STRICTLY one at a time
   (the device single-flight discipline) with batch-position progress. NO
   precache list change — ingest.js + index.html + styles.css changed bytes
   ride the cache-name bump (cache-first means any precached byte change needs
   this). Version "10" = AGENT VISION (view_frames): NEW engine/frames.js
   (still-frame decode → downscaled, rotation-correct JPEG base64) joins the
   precache under its BARE URL (bridge.js imports it bare, and bridge.js is
   itself a bare module); bridge.js (the view_frames executor + the result cap
   raised 500 KB → 2 MiB, lockstep with the relay's routers/bridge.py) +
   capability.js (the videoDecoder note is now load-bearing) changed bytes ride
   the cache-name bump.

   Version "11" = M3 RENDER TIER (format + mixed-orientation combine + music).
   NEW modules join the precache, all under their BARE URLs (editor.js
   dynamic-imports the engine/store/UI modules bare; they import each other bare;
   bridge.js — itself bare — imports music-ops bare):
     format-ui.js / music-ui.js (static-imported bare by editor.js),
     music-ops.js (the shared M3 ops — bare from bridge.js + the two UI modules),
     store/music.js (the music track store), engine/canvas.js (the output-format
     resolver), engine/render.js + webcodecs.js + compositor.js + audiomix.js +
     duck.js (the render spine), and assets/music/catalog.json (the bundled CC0
     library index — fetched same-origin by music-ops/music-ui).
     The 8 assets/music/<library_id>.m4a beds are DELIBERATELY NOT precached
     (~29 MB): they LAZY-LOAD on demand — music-ops.addMusic fetches
     /static/assets/music/<id>.m4a (cache:"force-cache", so the browser's HTTP
     cache holds a used bed) only when a library track is actually placed.
     Shipping 29 MB of audio into the install-time shell cache would bloat every
     device's offline shell for tracks most projects never touch. The changed
     bytes of bridge.js / export.js / player.js / editor.js / capability.js /
     store/meta.js / store/edl.js / styles.css / index ride the cache-name bump.

   Version "12" = MUSIC UPLOAD CAP RAISE (music-ops.js UPLOAD_MAX_BYTES → 3 GiB,
   UPLOAD_MAX_DURATION_S → 6 h, friendly "max 3 GB" label). NO precache list
   change — music-ops.js changed bytes ride the cache-name bump.
   Version "13" = MUSIC MULTI-SELECT + iOS multi-select hints: the music
   <input> gains `multiple` and music-ui.js imports a pick STRICTLY one at a
   time (a sequential single-flight batch mirroring ingest.js runBatch; a multi
   pick imports without auto-placing N overlapping whole-video beds), and a
   short iOS multi-select tip is shown on BOTH the music and video pickers. NO
   precache list change — music-ui.js + ingest.js are already precached, so
   their changed bytes (plus styles.css / index) ride the cache-name bump.
   Module URL discipline:
   app.js dynamic-imports editor.js WITH ?v=; everything below the entry modules is imported BARE
   (editor.js → bridge/chat/player/export/tabs/transcribe; editor.js
   dynamic-imports the engine/store/ingest modules bare so each has exactly
   ONE instance; engine modules import each other bare). The precache mirrors
   the exact request URLs.
============================================================================= */

const ASSET_VERSION = "13";
const CACHE_PREFIX = "studio2-shell-";
const CACHE_NAME = CACHE_PREFIX + "v" + ASSET_VERSION;
const V = "?v=" + ASSET_VERSION;

/* Exact request URLs the app shell uses — queries must match how index.html /
   app.js fetch them (versioned dynamic imports keep their ?v=; util.js is
   deliberately bare — the v1 double-load convention). */
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/static/styles.css" + V,
  "/static/app.js" + V,
  "/static/util.js",
  "/static/api.js" + V,
  "/static/diag.js" + V,
  "/static/capability.js" + V,
  "/static/login.js" + V,
  "/static/projects.js" + V,
  "/static/store/opfs.js" + V,
  "/static/store/meta.js" + V,
  "/static/editor.js" + V,
  "/static/settings.js" + V,              /* v8: dynamic-imported by app.js */
  /* bare instances reached via static imports inside feature modules
     (api.js from login.js; store modules from projects.js; util from all) */
  "/static/api.js",
  "/static/capability.js",
  "/static/store/opfs.js",
  "/static/store/meta.js",
  /* Step 5 editor modules (statically imported bare by editor.js) */
  "/static/bridge.js",
  "/static/chat.js",
  "/static/player.js",
  "/static/export.js",
  "/static/tabs.js",
  "/static/transcribe.js",                /* M2: tap-to-transcribe controller */
  "/static/settings.js",                  /* v8: static-imported bare by editor.js (model indicator) */
  /* v11 M3 render-tier UI (static-imported bare by editor.js) + the shared ops
     (bare from bridge.js + both UI modules) */
  "/static/format-ui.js",
  "/static/music-ui.js",
  "/static/music-ops.js",

  /* Step 4 engine/store/ingest (dynamically imported bare by editor.js;
     offline preview + export need the full engine in the shell cache) */
  "/static/store/edl.js",
  "/static/ingest.js",
  "/static/engine/mediabunny.js",
  "/static/engine/writers.js",
  "/static/engine/probe.js",
  "/static/engine/cut.js",
  "/static/engine/verify.js",
  /* M2 transcription (dynamically imported bare by editor.js / transcribe.js) */
  "/static/engine/audio.js",
  "/static/store/transcripts.js",
  /* v10 Agent Vision: still-frame decode (imported bare by bridge.js, which is
     itself a bare module — so the bare URL is the only one the SW needs) */
  "/static/engine/frames.js",
  /* v11 M3 render tier: the store + the output-format resolver + the render
     spine (all dynamic-imported bare by editor.js / each other). The 8 .m4a
     beds are NOT here — they lazy-load on demand (see "Versioning" above). */
  "/static/store/music.js",
  "/static/engine/canvas.js",
  "/static/engine/render.js",
  "/static/engine/webcodecs.js",
  "/static/engine/compositor.js",
  "/static/engine/audiomix.js",
  "/static/engine/duck.js",
  /* assets */
  "/static/assets/music/catalog.json",    /* the bundled CC0 library index (beds lazy-load) */
  "/static/assets/icons.svg",
  "/static/assets/icons/icon-192.png",
  "/static/assets/icons/icon-512.png",
  "/static/assets/icons/maskable-512.png",
  "/static/assets/icons/apple-touch-icon.png",
  "/static/assets/fonts/bricolage-grotesque-500.woff2",
  "/static/assets/fonts/bricolage-grotesque-600.woff2",
  "/static/assets/fonts/bricolage-grotesque-700.woff2",
  "/static/assets/fonts/schibsted-grotesk-400.woff2",
  "/static/assets/fonts/schibsted-grotesk-500.woff2",
  "/static/assets/fonts/schibsted-grotesk-600.woff2",
  "/static/assets/fonts/schibsted-grotesk-700.woff2",
  "/static/assets/fonts/spline-sans-mono-400.woff2",
  "/static/assets/fonts/spline-sans-mono-500.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:"reload" bypasses the HTTP cache so the precache holds exactly
    // what the server has NOW, not a heuristic copy.
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Purge every old version-keyed shell cache (bump-safe).
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                       // POSTs always hit the network

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;   // blob:/data: untouched
  if (url.origin !== self.location.origin) return;        // cross-origin untouched

  // /api/* is NETWORK-ONLY — never cached, never substituted.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ca.crt") return;

  // App-shell navigation: any top-level navigation (except /setup, which is
  // an online onboarding page) answers with the cached shell when offline.
  if (req.mode === "navigate") {
    if (url.pathname === "/setup") return;                // network-only page
    event.respondWith((async () => {
      try {
        return await fetch(req);                          // fresh shell when online
      } catch {
        const cached = await caches.match("/");
        if (cached) return cached;
        return new Response("Studio is offline and the app shell is not cached yet.", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }
    })());
    return;
  }

  // Shell sub-resources: CACHE-FIRST against the version-keyed precache.
  // The cache key includes the query (?v=) — an unknown URL falls through to
  // the network untouched (no runtime cache growth).
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    return fetch(req);
  })());
});
