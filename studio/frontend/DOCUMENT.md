# studio/frontend/ — DOCUMENT

## What this is
The buildless SPA, served as static assets by `app.main` (`/` → `index.html`,
`/static/*` → this folder). **No npm, no bundler** — hand-authored ES modules + a
single CSS file + self-hosted fonts. The only thing it knows about the backend is
`API_CONTRACT.md`. Authentication is the httpOnly `studio_session` cookie set by
`POST /api/login`; the client never holds, stores, or transmits any token.

> Note: `ARCHITECTURE.md §3` sketched this as `app/web/`. The brief names
> `studio/frontend/` explicitly, so that path wins. `app/main.py` already serves
> from here.

## Scaffold status (Setup Engineer)
A tasteful but minimal **placeholder** that proves the app boots and shows
`GET /api/status`:
- `index.html` — status page with semantic landmarks.
- `styles.css` — dark near-black ground, warm orange accent (NOT purple), system
  grotesque + mono stack (NOT Inter), explicit spacing scale, one subtle motion,
  `prefers-reduced-motion` respected. This is a tone-setter, **not** the design
  system of record.
- `app.js` — auth gate via `/api/me` (cookie), then calls `/api/status`, renders it.
- `assets/` — empty placeholder dirs for fonts + icons (see assets/DOCUMENT.md).

Everything here is **replaced by the Frontend Engineer**.

## File structure
```
frontend/
├── index.html    # SPA shell: 4 views (loading/login/sessions/dashboard); modal hosts; .banner-stack (update +
│                 #   secure banners); stepper mount; ?v=16
├── setup.html    # STANDALONE Secure Setup page (NEW, 2026-06-11) — served login-free at /setup on BOTH schemes;
│                 #   no SPA boot; links styles.css?v=16 for tokens (inline fallback <style> degrades gracefully);
│                 #   one tiny inline script fetches /api/tls/info and fills the live https URLs via textContent
├── styles.css    # tokens, layout, responsive, motion (no framework); banner-stack + secure-banner + setup-page
│                 #   sections; ?v=16
├── app.js        # bootstrap + view orchestration: login → SESSIONS → dashboard; guide-state aggregation; version
│                 #   watch + secure-address banner (both ride the same /api/me read); ASSET_VERSION "16";
│                 #   loads diag.js FIRST (versioned), logs boot facts + banner/session events, gates diag on auth
├── diag.js       # phone-side diagnostics (NEW, 2026-06-10): dlog() ring buffer → batched POST /api/client-log;
│                 #   sendBeacon dying-tab tail; localStorage crash replay; window error/rejection capture;
│                 #   singleton on window.__studioDiag (NEVER import it bare from a versioned module)
├── guide.js      # the "red thread" 4-step journey stepper (NEW, 2026-06-10) — render-only, state pushed by app.js
├── sessions.js   # the Sessions screen + post-login stale-cleanup modal + "How it works" onboarding card
├── api.js        # fetch wrapper (cookie, credentials:same-origin), SSE helpers, error normalization; session CRUD
├── chat.js       # chat view: send, render deltas, tool-call chips, ask_user card (roving tabindex), empty-state CTA, ready card
├── panel.js      # project panel: clip inventory, transcribe, humanized outputs + Advanced, next-step card (session-scoped)
├── preview.js    # preview player + Download anchor + Frame checks (collapsed) + verify-PNG lightbox
├── upload.js     # chunked/RESUMABLE uploader: retry/backoff, client_id resume, Wake Lock, Resume button (slice lazily!);
│                 #   keep-screen-on notice now links /setup (new tab); fully diag-instrumented (up.* lifecycle events)
├── drawer.js     # responsive drawer/sheet + focus trap + scroll lock + revealUpload/revealTranscribe jumps
├── status.js     # system status pills + rows (/api/status) — plain-language labels
├── login.js      # login view
├── qr.js         # optional in-page QR (desktop convenience; terminal QR is primary)
├── util.js       # shared DOM/format/focus-trap/toast helpers (import intentionally UNversioned)
└── assets/
    ├── fonts/    # self-hosted woff2 faces (NOT Inter)
    └── icons.svg # UI icon sprite (i-download now in active use)
```

## Key decisions / constraints (from ARCHITECTURE.md §7)
- **Chat-first responsive shell:** phone `<640` (single column + drawer), tablet
  `640–1024` (two-pane), desktop `>1024` (three-pane). `dvh`/`visualViewport`
  for the mobile-keyboard-aware sticky composer.
- **Authentication (cookie-only):** the backend enforces the httpOnly
  `studio_session` cookie set by `POST /api/login` and validates nothing else.
  Every fetch uses `credentials: "same-origin"` and EventSource uses
  `withCredentials: true` so the cookie rides automatically. **No credential is
  ever placed in a URL** — media (`fileUrl`) and SSE (`openEventSource`) URLs are
  bare, since putting a token in the query string leaks it into access logs and
  (because the backend ignores it) authenticated nothing. The former QR
  `?token=` capture/storage/header plumbing has been removed.
- **Anti-generic design:** no Inter, no purple gradient, no 3-equal-card hero.
  Dark-first, single warm accent, timecodes in mono.
- **A11y:** semantic landmarks, labeled controls, keyboard-operable chat +
  drawer, visible focus, AA contrast, `prefers-reduced-motion`.
- **Chat transport:** `POST /api/chat` read as a streamed fetch body
  (`api.streamPost`), parsing the SSE event frames per `API_CONTRACT.md §13`.
  There is no `GET /api/chat/stream` EventSource path.
- **Blank-screen bug (FIXED) — the view-switcher CSS hid the whole app.** The
  `#app` shell carries its own `data-view` state attribute
  (`loading|login|dashboard`), and each inner view (`#view-loading`, `#view-login`,
  `#view-dashboard`) carries a bare `data-view` marker attribute. The old rule
  `[data-view] { display: none }` was an UNSCOPED attribute selector, so it matched
  `#app` itself too — setting the entire container to `display:none`. The reveal
  rules only un-hid the inner `#view-*` children, never `#app`, so the page
  rendered as a blank near-black screen (CSS loaded, so the ground colour showed;
  nothing else did). This was a pure CSS bug — present regardless of JS; every JS
  module loaded fine and `data-view` was set correctly, but the shell stayed
  hidden. Fix in `styles.css`: scope the hide to direct children only —
  `#app > [data-view] { display: none }` plus `#app[data-view="…"] > #view-…
  { display: flex }`, and give `#app` an explicit `display: flex`.
- **Resilient boot safety-net (so a future boot error can't blank the screen):**
  `app.js` keeps only `util.js` as a static import and pulls the feature modules
  (`login, status, drawer, panel, chat, preview, upload, api`) via **dynamic
  `import()` inside `boot()`'s `try/catch`**. A static `import` aborts the whole
  module at evaluation time if any one fetch fails (e.g. a 404 on a renamed/removed
  module) — which a `try/catch` can't catch — so dynamic import is what makes
  failure recoverable. On a module-load or auth-gate error the LOGIN view is
  revealed (`data-view="login"`) with a visible message in the existing
  `#login-error` slot plus a `console.error`, never a dead screen. `boot()` sets
  `window.__studioBooted = true` once it has taken control.
- **Inline boot watchdog (`index.html`):** a tiny classic (non-module) inline
  `<script>` runs independently of the module system. If `window.__studioBooted`
  is still falsey after 8s and `#app` is still on `data-view="loading"`, it forces
  `data-view="login"` and shows the visible error — the last line of defence if
  `app.js` itself fails to load at all. **`boot()` now calls `markBooted()` as its
  very first step** (right after the already-booted guard, before
  `loadModules()`): reaching `boot()` already proves `app.js` loaded, so a slow LAN
  first load whose dynamic imports exceed the 8s window no longer false-fires the
  "didn't finish loading" error. `showBootError()` still covers genuine
  module-load failures. `showLogin()` also clears any stale `#login-error` banner.

## Bug-fix pass (2026-06-08)
Surgical fixes to seven verified bugs (no behavioural redesign):
- **BUG-06 (`styles.css` `#app`):** added `flex-direction: column`. `#app` is a
  full-viewport flex container whose single visible view child must stretch to the
  full width; the missing direction defaulted to `row`, sizing the view to its
  content width and leaving a dead strip on the right at every breakpoint.
- **BUG-07 (`styles.css` `.dash`, `.chat`, `.msg__bubble`, responsive grids):**
  changed every chat `1fr` grid track to `minmax(0, 1fr)` (default, 640px, 1024px)
  and added `min-width: 0` to `.chat` and `.msg__bubble`. A `1fr` track has an
  implicit `min-width: min-content`, so unbreakable `<pre><code>` blocks forced the
  column past the viewport (page-wide horizontal scroll on mobile). `minmax(0,1fr)`
  lets the track shrink and `min-width:0` lets the `<pre>`'s own `overflow-x:auto`
  scroll internally.
- **BUG-08 (`preview.js` `openArtifact`):** added a text-artifact fallthrough
  (`.srt`/`.json`/`.md`/etc.) that opens the absolute `info.path` via
  `fileUrl()` in a new tab (`window.open(..., "noopener,noreferrer")`). Previously
  only images and `.mp4` matched; text artifacts were a silent no-op. Requires the
  backend-supplied absolute `path` (a bare edit-relative string can't be resolved
  by `/api/file`).
- **BUG-21 (`panel.js` `startTranscribe`):** the two 409 catch branches keyed on
  the identical condition, so the second (no-folder) branch was dead code. Now
  distinguishes on `err.code` (`job_in_flight` vs anything else, matching the
  backend codes `job_in_flight`/`no_active_folder`) and re-enables `transcribeBtn`
  on every non-success path except the live-job attach (re-enabled by the SSE
  `done`/`error` handlers).
- **BUG-24 (`chat.js`):** added `case "tool_input"` to the stream switch plus a
  `toolInput(d)` turn method and a `setInput(text)` chip method that updates the
  tool-chip subtitle only when the text is truthy (so a later empty
  `input_summary` can't blank an already-set subtitle). The relay's refined
  `tool_input` event was previously dropped by `default:`.
- **BUG-28 (`app.js`):** moved `markBooted()` to the start of `boot()` (see the
  watchdog note above).
- **BUG-29 (`index.html`):** added an inline SVG data-URI favicon (orange brand
  square + dark play triangle, `%23`-encoded) for `rel="icon"` and
  `rel="apple-touch-icon"` — kills the `/favicon.ico` 404 with zero new requests.

## Artifact resolution follow-up (2026-06-08)
> **Superseded in part by the per-user SESSIONS feature (see below):** the
> resolver now joins the session's absolute `dir` (from `/api/sessions/{id}/open`)
> instead of the old active folder. The references to `getFolder()` /
> `/api/fs/select` / `active_folder` below describe the pre-sessions wiring; the
> join logic itself (already-absolute passthrough + forward-slash join, returns
> `null` when unusable) is unchanged.

Closes the chat→preview artifact gap left after BUG-02 (backend). `tool_end`
events and chat history carry artifacts as **edit-relative** strings
(`API_CONTRACT.md §13`), e.g. `edit/preview.mp4` / `edit/verify/cut_03.png` — the
relay deliberately normalizes every artifact to that form and never sends an
absolute `path`. But `GET /api/file` only serves paths that resolve **inside the
allowed roots** (i.e. absolute), so a bare `edit/...` string can't be turned into
a working media URL. The fix resolves the path **on the frontend**, which is the
only side that knows the active footage folder:
- **`chat.js` — `resolveArtifact(folder, artifact)` (module-scope, pure):** if the
  artifact is already absolute (Windows `X:\`/`X:/`, UNC `\\`, or POSIX `/…`) it is
  returned as-is; otherwise it joins `getFolder()` (the active folder, absolute,
  from `/api/fs/select` → `active_folder` or `/api/status` → `raw.active_folder`)
  with the edit-relative string using a single forward slash
  (`<folder>/edit/preview.mp4`). Forward slashes are accepted by the backend's
  `realpath`/`normpath` confinement on every OS. Returns `null` when the folder is
  unknown or the artifact is unusable. A `resolveArtifactPath`/`artifactInfo`
  closure wraps the result into `{ ...extra, path }`.
- **Wiring (chat.js):** both artifact entry points now carry the resolved absolute
  path to `preview.openArtifact` via `info.path` — (a) the per-artifact tool-chip
  buttons (`onArtifacts([a], { info: artifactInfo(a, { open: true }) })`) and
  (b) the auto `tool_end` artifact open. `app.js` already unwraps `info.info`.
- **`preview.js` — `openArtifact` hardened:** new `absPathFor(relOrAbs, info)`
  prefers `info.path`, falls back to `relOrAbs` only when it is already absolute
  (local `isAbsolutePath`), else returns `null`. png/jpg → lightbox, `.mp4` →
  player, text (`.srt`/`.json`/`.md`) → new tab — each **no-ops cleanly** (no
  console error, no 403 URL) when no absolute path is available. This supersedes
  the BUG-08 caveat for chat artifacts: text artifacts now open from chat too,
  because the path is resolved client-side instead of requiring a backend `path`.
- **Untouched / preserved:** the `onRenderDone` autoplay path (`app.js` →
  `panel.loadOutputs()` → `/api/outputs` → `preview.setOutputs(…, {autoplay:true})`)
  already uses absolute `path`s from `/api/outputs` and is NOT routed through the
  resolver. The `tool_end` render-detection regex (`/preview|final|\.mp4$/i`) still
  matches the edit-relative string and is unchanged. `verify_pngs` from
  `/api/outputs` (absolute `path`) are likewise unaffected; the verify-PNG
  **chat** path (a `.png` artifact in `tool_end`) now resolves correctly.
- **No new deps, no build step.** `preview.js` keeps a local copy of
  `isAbsolutePath` rather than importing from `chat.js`, so the view modules stay
  self-contained (they load in parallel in `app.js`).

## Latent-issue fix pass (2026-06-08)
Two verification-found latent issues, surgical fixes only (no behavioural redesign):
- **ISSUE-1 (`api.js` `normalizeError`):** the normalizer only read the TOP-LEVEL
  `body.error`, but FastAPI serializes `deps.http_error()` bodies NESTED as
  `{"detail": {"error": {code, message, detail}}}`. So every contract error
  collapsed to the generic `http_error` and `err.detail` was dropped — making
  code-specific consumers dead (notably `panel.js` `err.code === "job_in_flight"`
  / `err.detail.job_id`, which mishandled a real concurrent-transcription 409).
  Fix: unwrap the nested envelope FIRST (`body.detail.error` when `body.detail` is
  a non-array object), then fall back through the existing shapes — top-level
  `body.error` object → `{code, message, detail}`; `body.error` string (e.g.
  `POST /api/login` → `{"ok":false,"error":"invalid credentials"}`) → message;
  `body.detail` string (e.g. `{"detail":"Not Found"}`) → message; else the generic
  fallback. FastAPI validation arrays (`{"detail":[{…}]}`) match no branch and no
  longer risk a crash. All branches are `typeof`-guarded so none throw. After the
  fix `err.code` carries the backend code (`no_active_folder`, `job_in_flight`,
  `folder_mismatch`, …) and `err.detail` carries the backend detail (e.g.
  `{job_id}`).
- **ISSUE-2 (`app.js` `loadModules`):** `index.html` bumps `app.js?v=3` /
  `styles.css?v=3`, but the eight dynamic `import()` URLs in `loadModules()`
  (`login, status, drawer, panel, chat, preview, upload, api`) carried NO version
  query, so a returning client (e.g. a phone that already loaded the app) could
  keep running STALE cached feature modules after a deploy even though it fetched
  the fresh `app.js`. Fix: a single module-scope `const ASSET_VERSION = "3"` and
  every dynamic import built as `"./<mod>.js" + "?v=" + ASSET_VERSION`, mirroring
  the `index.html` `?v=`. Future bumps are one line, kept in lockstep with
  `index.html`. (`qr.js` is not imported anywhere yet — `[TODO FE]` — so it is not
  versioned here.)

## Interactive question options (ask_user) — 2026-06-08
When a chat turn pauses to ask a multiple-choice question, the backend streams an
`ask_user` SSE event and the UI renders an in-chat **question card**, captures the
choice, and POSTs it back so the turn resumes.

- **Event consumed (`chat.js` stream switch):**
  `event: ask_user`, `data: { turn_id, question_id, questions: [ { question,
  header, multiSelect, options: [ { label, description } ] } ] }` — 1–4 questions,
  2–4 options each. An **"Other…"** free-text choice is always offered by the UI
  (it is not in `options`).
- **Answer round-trip (`api.js` `answerQuestion`):** a NORMAL (non-streamed)
  `POST /api/chat/answer` with body `{ turn_id, question_id, answers: [ { header,
  selected: [str], other_text: str|null } ] }` — one entry per question, cookie
  auth (`credentials:"same-origin"` via `api.post`). `200 {ok:true}` on success;
  `409 {error:{code:"no_pending_question"}}` is unwrapped by `normalizeError` into
  an `ApiError`, so the card detects an expired question via
  `err.code === "no_pending_question"`.
- **Card UX (`chat.js` `renderQuestionCard`):**
  - **Single-select** (`multiSelect:false`): options are radio-role buttons; a lone
    single-select question with no "Other" engaged **submits immediately on click**.
  - **Multi-select** (`multiSelect:true`): options are checkbox-role toggles; a
    **Submit** button confirms.
  - **Other…**: always present; selecting it reveals a text input. Enter in the
    input submits when complete.
  - **Multiple questions** in one event render together and submit **once** (a
    single POST with all answers in order).
  - On success the card **collapses to a compact read-only summary** of the chosen
    answer(s) (green check, header → value rows — echoes the answered tool-chip
    tone). On `409 no_pending_question` it collapses to a muted **"this question
    expired"** note. A recoverable failure (network/500) shows an inline error and
    lets the user retry (no double-submit — guarded by `submitted`/`finalized`).
  - **Composer lock:** while a card is open (`pendingQuestion !== null`), the
    message composer (textarea + send) is disabled and the hint reads *"Answer the
    question above to continue."* `applyComposerState()` is the single source of
    truth (folder-ready AND no-pending-question → usable); `setEnabled` /
    `setStreaming` both route through it. The card is finalized + composer
    re-enabled on **answer**, on **`turn_end`/`error`** (`turn.finish()` →
    `finalizePendingQuestion("ended")`), on **user cancel** (`finalizePendingQuestion
    ("cancelled")`), and on **folder switch** (`loadHistory` clears it).
  - **Keyed on `turn_id`+`question_id`:** a duplicate `ask_user` for the same
    question won't open a second card; a different pending question supersedes the
    old one (finalized).
- **Defensive:** malformed/empty `questions`/`options`, or a missing
  `question_id`, fail gracefully (`renderQuestionCard` returns `null`) without
  breaking the stream. All option labels/descriptions/headers/answer text are
  inserted via `textContent` (`util.el` `text:`) — never `innerHTML`.
- **Styling (`styles.css` `.qcard*`/`.qopt*`):** reuses the surface/line/accent
  tokens + the tool-chip aesthetic (no new visual style). Real `<button>`s with
  `role="radio"`/`"checkbox"` + `aria-checked`, labeled "Other…" input, visible
  focus rings, AA contrast. Tap targets ≥40px high; options stack at 390px and go
  two-up at ≥560px with no horizontal overflow.
- **Cache-bust:** this feature bumped `index.html` `?v=3 → ?v=4` (styles.css +
  app.js) and `app.js` `ASSET_VERSION "3" → "4"` in lockstep, so returning clients
  refetch the new `chat.js`/`api.js`/`styles.css`.

## Per-user SESSIONS (major feature) — 2026-06-08
Studio moved from a single shared global footage folder to **per-user,
user-owned, upload-only SESSIONS**. A session is a project the signed-in user
creates, owns, uploads videos into, and edits — users only ever see/open/delete
their own (the backend scopes every call to the cookie's username). Folder
browsing (`/api/fs/*`, the path input + server-side browser) is **REMOVED**.

### New app flow (`app.js`)
`login → SESSIONS screen → (open/create) → editor DASHBOARD`. Four `#app`
`data-view` states now: `loading | login | sessions | dashboard`.
- **Shared state:** `me = {authenticated, username, staleSessions}` and
  `activeSession = {id, dir, name}`. `dir` is the session's **absolute on-disk
  folder** from the open response — it is what `chat.js` joins with `edit/…` to
  resolve artifacts (replacing the old active-folder path).
- `getMe()` (`api.js`) now also returns `username` (topbar) and `stale_sessions`
  (count hint). On login success / authenticated boot, app.js lands on the
  sessions screen.
- `enterDashboard(session)` binds `panel.setSession`, `chat.loadHistory(id)`,
  populates `#topbar-user`, and refreshes status. `onBackToSessions` (topbar
  back arrow) and logout (topbar / sessions screen) return to the right view.

### Sessions screen + stale modal (`sessions.js`, NEW)
- **List:** `GET /api/sessions → {sessions:[{id,name,created_at,last_touched_at,
  age_days,media_count,stale}], stale:[id]}`. Each card shows the name, a
  "touched {age_days}d ago"/"today"/"yesterday" label, `media_count`, and a
  **Stale** badge. **Open** (→ `openSession` → store `{id,dir}` → dashboard) and
  **Delete** (confirm dialog → `deleteSession` → refresh). Empty state when none.
- **New session:** name input → `createSession(name)` → `openSession` → dashboard.
  `409/400 {detail:{error:{code:"invalid_name"}}}` surfaces via `err.code` (the
  existing `normalizeError`) as an inline toast.
- **Post-login stale-cleanup modal:** if the `/api/sessions` payload flags any
  session stale (via the `stale` id list, resolved against the full objects),
  a dismissible modal pops OVER the list with per-session **Keep** (`keepSession`)
  / **Delete** (`deleteSession`). Rows drop as the user acts; it closes when none
  remain. Non-stale users go straight to the list.
- **Confirm + modal** are accessible: `role=alertdialog`/`dialog`,
  `aria-modal`, focus-trapped (`util.trapFocus`/`focusFirst`), ESC + overlay
  close, focus restored on close. Hosts are `#session-confirm` / `#stale-modal`
  (outside the `#app` view-switcher, populated lazily).
- **XSS guard:** session names are **user-supplied** — every name is inserted via
  `textContent` only (never `innerHTML`), in the cards, the confirm body, and the
  stale rows.

### Session-scoped editor calls (FROZEN contract)
Every editor call now carries `session_id`:
- `POST /api/chat {message, session_id}`, `POST /api/chat/cancel {turn_id,
  session_id}`, `POST /api/chat/answer {turn_id, question_id, answers,
  session_id}`, `GET /api/chat/history?session_id=` (`chat.js`).
- `GET /api/inventory?session_id=`, `POST /api/transcribe {session_id}` +
  `GET /api/transcribe/{job}/events?session_id=`, `GET /api/outputs?session_id=`
  (`panel.js`).
- `POST /api/upload/init {session_id, filename, size_bytes, chunk_size}` —
  `dest_folder` is **gone** (`upload.js`); chunking/validation unchanged.
- `POST /api/sessions/{id}/open → {…, dir:<absolute>}` stores `dir`; `keep`/
  `DELETE`/list per the contract. `404 {detail:{error:{code:"session_not_found"}}}`
  on opening a just-deleted session → bounce back to the sessions screen with a
  toast (`panel.handleSessionGone` / sessions.js open path).

### Topbar (dashboard)
The old folder-path chip is replaced by a **session-name chip**
(`#topbar-session-text`), a signed-in **username chip** (`#topbar-user`), and a
**back-to-sessions** arrow (`#back-to-sessions`). The folder-picker `<section>`
is removed from the panel.

### `ask_user` + artifact resolution — PRESERVED
The interactive question card, composer lock, and answer POST are unchanged
except the answer now also sends `session_id`. The composer-hint flicker right
after answering (stale "Answer the question above" while the turn resumed) is
fixed in `applyComposerState()` (restores "Editor is working…" when unblocked
mid-stream). `resolveArtifact(dir, artifact)` now joins the session's absolute
`dir` (from open) instead of the old active folder — same join logic, same
forward-slash + already-absolute passthrough. The render→preview / verify-PNG
flows are untouched.

### Tap targets / cache-bust
`.qcard__submit` bumped `2.4rem → 2.5rem` (40px) to satisfy the tap-target
guideline at mobile (was 38.4px). Sessions list, cards, modal, and confirm are
mobile-first (usable at 390px, tap targets ≥40px). This feature bumped
`index.html` `?v=4 → ?v=5` (styles.css + app.js) and `app.js`
`ASSET_VERSION "4" → "5"` in lockstep.

## Sessions live-test fix pass (2026-06-08)
Three issues from the per-user SESSIONS live integration test, surgical fixes only:
- **P1 — create-and-enter was a UX dead-end (`sessions.js`).** `doCreate()` set
  `busy=true` then `await openAndEnter(...)`, but `openAndEnter` opened with
  `if (busy) return;` — so it returned immediately. The session was created on
  disk but the user was NOT taken into the editor and the list didn't refresh
  (it only appeared after a manual refresh; Open from the card worked). **Fix:**
  `openAndEnter(id, name, internal=false)` gained an `internal` flag. User-facing
  Open buttons call it with no flag → the `busy` guard still debounces
  double-clicks and `openAndEnter` owns busy via its own `finally`. `doCreate`
  calls `openAndEnter(id, name, true)` → the guard is bypassed AND `openAndEnter`
  does NOT toggle busy (doCreate's `finally setBusy(false)` is the sole owner), so
  the create→open chain can't self-collide and `busy` is always reset exactly
  once, even on error. If the open step fails for a non-404 reason from the create
  flow, the list is refreshed (`if (internal) await load()`) so the just-created
  session is visible for a retry. **Before:** `doCreate` setBusy(true) →
  `openAndEnter` sees busy → returns → no navigation, no refresh, busy reset by
  doCreate's finally. **After:** `doCreate` setBusy(true) → `openAndEnter(...,true)`
  bypasses guard, opens, calls `onOpen` (→ dashboard) → doCreate's finally resets
  busy. Returning via "Back to sessions" re-runs `show()` → fresh list shows it.
- **Minor — "Refresh sessions" tap target (`styles.css`).** `#sessions-refresh`
  carried an inline `width:2.2rem;height:2.2rem` (35.2px), below the 40px
  guideline every other control meets. Added `#sessions-refresh { min-width:
  2.5rem; min-height: 2.5rem; }` (40px) — `min-*` overrides the inline `width`/
  `height`, so no index.html change was needed.
- **Minor (safety) — stale-modal Delete now confirms (`sessions.js`).** The
  post-login stale modal's Delete deleted immediately while the session-card
  Delete confirmed first. Since deletion is PERMANENT (rmtree of videos+edits),
  the stale-row Delete now routes through the SAME `openConfirm` dialog. To do
  this cleanly, `openConfirm` gained an `onCancel` callback that fires only on a
  genuine dismissal (Cancel / ESC / overlay) — guarded by a `confirmed` flag set
  when OK is clicked — so the stale row's controls are re-enabled if the user
  backs out (and are NOT touched on a confirm-driven close, which the row's own
  handler manages). The confirm dialog stacks above the stale modal
  (`.confirm` z-130 > `.stale` z-125); the stale modal's ESC handler now bails
  while the confirm is open (`confirmHost.dataset.open === "true"`) so ESC
  dismisses only the confirm, not both modals. Keep needs no confirm (unchanged).
- **Cache-bust:** bumped `index.html` `?v=5 → ?v=6` (styles.css + app.js) and
  `app.js` `ASSET_VERSION "5" → "6"` in lockstep (covers the dynamic import of
  `sessions.js`). No `?v=5` remnants on live assets.

## Mobile upload fix pass (2026-06-08)
Fixes a real-phone "video selected but no upload progress" report. Verified at
390×844 AND desktop (1440×900) on an isolated runtime (a temp clone of `studio/`
with a fresh `.runtime`; the real `studio/.runtime` was never touched).

### How an upload starts (no change to the trigger — it was already correct)
`upload.js` auto-starts on the hidden file input's **`change`** event:
`fileInput.addEventListener("change", () => { handleFiles(fileInput.files); … })`
→ `handleFiles` → `uploadOne` immediately runs the three-phase protocol
(`init` → per-chunk `PUT` (lazy `file.slice`) → `complete`). There is **no
separate "start" button** — picking a file IS the start. So the bug was never the
trigger; it was that the **progress UI rendered off-canvas in the drawer at
390px** (so the upload looked idle), compounded by errors that could be missed.

### Root cause of the off-screen UI (the flagged `x ≈ -327` dropzone)
Two things combined inside the phone drawer (`#drawer` → `#drawer-mount` →
relocated `.panel` → `#upload-mount`):
1. **`#drawer-mount` (a flex column) and `.panel` had no `min-width: 0`.** A flex
   item defaults to `min-width: auto` (content-based), so a wide descendant
   (the dropzone, or a long upload filename in `.uprow__name`) could size the
   panel by its widest child instead of shrinking to the 343px drawer — pushing
   the dropzone/rows horizontally off-canvas. (`x ≈ -327` is also exactly the
   *closed*-drawer offset — `translateX(-100%)` of a 343px drawer — so any
   measurement taken while the drawer was shut reads the dropzone at ≈ -327;
   either way the fix is to keep the open-drawer content on-screen.)
2. Long filenames couldn't ellipsize: `.uprow__name` lacked `min-width: 0`, so a
   flex row kept its min-content width and overflowed.

### Fixes (file:line is approximate — buildless, no hashing)
- **`styles.css` `.panel` / `.panel__scroll`:** added `min-width: 0; width: 100%;
  max-width: 100%` to `.panel` and `min-width: 0; overflow-x: hidden` to
  `.panel__scroll` (+ `min-width:0` on its `.section` children). The panel now
  shrinks to its host (the narrow drawer-mount on phone, the 336px grid track on
  desktop) and can never scroll horizontally.
- **`styles.css` `.drawer > #drawer-mount`:** new rule `min-width: 0;
  overflow-x: hidden` (the inline `#drawer-mount` style had `display:flex;
  flex-direction:column` but no `min-width:0`) so the docked panel can't be sized
  by a wide child. `.drawer > #drawer-mount > .panel { flex: 1 1 auto }`.
- **`styles.css` `.dropzone` / `.uploads` / `.uprow*`:** `.dropzone` gets
  `width:100%; max-width:100%` and its `small` wraps (`overflow-wrap:anywhere`);
  `.uprow` + `.uprow__top` + `.uploads` get `min-width:0`; `.uprow__name` gets
  `min-width:0` (so the ellipsis actually engages and the % + cancel button stay
  on-screen); `.uprow__pct` is `flex:none`; `.uprow__meta` wraps.
- **`upload.js` — reveal + error surfacing (no silent stalls):**
  - `revealRow()` scrolls a freshly-started (and a failed) upload row into view
    via `scrollIntoView({block:"nearest"})` — on a phone the uploads list sits at
    the bottom of the drawer scroll, so without this the advancing bar could be
    below the fold and look idle. Called at start of `uploadOne` and on failure.
  - `handleFiles` no-ops cleanly when the picker is dismissed with no files, and
    its "open a session first" copy is clearer.
  - `uploadOne` tracks a `phase` (`init`/`chunk`/`complete`) and a new
    `errorMessage(err, phase)` maps every failure to a clear, user-facing reason —
    413/`upload_too_large`, 507/`insufficient_storage`, 401 (session expired),
    404/`session_not_found`, `network`/status 0 ("Lost connection — check Wi-Fi"),
    and otherwise the backend's own contract message (never blank). On failure the
    row shows `failed` + the reason inline, a **6s `bad` toast** fires
    (`"<filename>: <reason>"`), the row is revealed, and the cause is
    `console.error`-logged so a server-side/phone-only failure is diagnosable.
    The `init`/chunk/complete error path can no longer look like "no progress."
- **Cache-bust:** bumped `index.html` `?v=6 → ?v=7` (styles.css + app.js) and
  `app.js` `ASSET_VERSION "6" → "7"` in lockstep — so a returning phone refetches
  the fixed `styles.css`/`app.js` AND the version-tagged dynamic feature modules
  (`upload.js`, etc.). No `?v=6` remnants on live assets.

### Verification (390×844 and desktop, isolated runtime)
Open session → pick a 17 MiB / 3-chunk `.mp4` → upload **starts on selection**,
runs `init` + 3 chunk PUTs + `complete` (all 200), assembles to the session dir.
With the drawer open at 390px the dropzone is at `x:16` (not −327) and the active
upload row's **progress bar is on-screen and advances** (captured at 47–62% with
"24–32 MB / 51.4 MB" using a ≈400 KB/s upload throttle on a ~50 MiB / 7-chunk
file); `panel__scroll` horizontal overflow = 0px. An offline upload surfaces both
a `bad` toast and an inline row error ("Lost connection — check Wi-Fi and try
again."). Desktop (1440×900) keeps the panel docked in `.dash` and uploads fine.
Residual cause that can only be confirmed on the user's phone/network: if their
real upload still stalls after this build, the visible toast/row error will now
name the failing phase + reason (e.g. a `499 client_disconnected` on weak Wi-Fi,
a `507 insufficient_storage`, or a stalled chunk on a flaky connection) instead of
silently showing nothing.

## iOS-Safari large-`.mov` "no init request / stuck 0%" fix pass (2026-06-08)
Targets a real-iPhone report: open a session, pick a ~104 MB `.mov`
(`img_4537.mov`), the upload row shows **"0%  0 / 104 MB"** and sits there, and
**`POST /api/upload/init` never reaches the server** — i.e. the upload fails
CLIENT-SIDE before any network call. iOS Safari = WebKit with a real (likely
HEVC, possibly iCloud-stored) clip; the earlier mobile pass used Chromium + a
small synthetic file and missed it.

### What was verified (Playwright **WebKit**, the Safari engine, @390×844)
A temp clone of `studio/` with a fresh `.runtime` was booted on an isolated port
(the real `studio/.runtime` was never touched), then driven with the WebKit
engine against a real ~98 MB **HEVC/`hvc1` `.mov`** (ffmpeg-generated):
- **Synthetic happy path** (`set_input_files`): the SHIPPED code already fired
  `init`, streamed all 13 chunks, and completed. So the bug is **not** in the
  `uploadOne` state machine and **not** a generic WebKit `file.slice`/init-fetch
  problem.
- **Deferred/iCloud File** (a `File` whose `name`/`size` are real but whose
  `slice()`/byte reads hang or throw — the one condition `set_input_files`
  cannot reproduce): `init` STILL fired (it is metadata-only), proving init is
  not what stalls. The pre-fix UI surfaced the failure only at the chunk phase.

The "0% 0 / 104 MB **with no init request**" state could not be reproduced on the
shipped code on WebKit (init always fires, because the meta byte-count
"0 / size" is itself only written AFTER init resolves). The most likely
real-device cause is therefore (a) the phone running a **stale cached** older
`upload.js`, and/or (b) iOS **releasing the picked File's security-scoped backing
store** when the input is cleared (`fileInput.value = ""`) in the same
synchronous turn the File ref was handed to the uploader — neutering a later
`file.slice()`. The fix hardens against both and makes any failure loud.

### Fixes (`upload.js`, `styles.css`, version bump)
- **Defer the input reset (`upload.js` `change` handler).** The picked files are
  snapshotted synchronously (`Array.from(fileInput.files)`), `handleFiles` starts
  the uploads (each `uploadOne` synchronously fires its metadata-only `init` and
  holds its own File ref), and **`fileInput.value = ""` is deferred to a later
  macrotask** (`setTimeout(0)`) so the synchronous neutering can never race the
  in-flight per-chunk slices. Re-picking the same file still re-fires `change`.
- **`init` is provably metadata-only and fires first.** `uploadOne` reads
  `file.name`/`file.size`/`file.type` **once, synchronously, up front**, then the
  FIRST `await` is the `init` POST — nothing touches file BYTES before it. So a
  large / not-yet-downloaded iCloud `.mov` cannot delay or block `init`. Bytes are
  read **lazily per chunk** (`file.slice(start,end)`) — never a whole-file read,
  arrayBuffer, FileReader, or hash.
- **Per-chunk slice is guarded (`upload.js`).** `file.slice()` is wrapped in
  try/catch; if WebKit throws because the backing store was released (iCloud not
  downloaded / picker resource revoked) it raises an `ApiError(code:
  "file_unreadable")` with actionable copy — *"Couldn't read the file — if it's in
  iCloud, open it in Photos once to download it, then try again."* — passed
  verbatim by `errorMessage` (checked BEFORE the `status===0` network branch).
- **Visible step status — a stall is never a silent 0% again (`upload.js`
  `addRow` + `styles.css`).** Each row now has a `.uprow__status` line that reads
  **"Starting…"** the instant the row appears (before `init`), then
  **"Uploading N%…"** per chunk, then **"Finishing…"** and **"Uploaded"** (or the
  error reason). The byte count moved to a `.uprow__bytes` span on the same meta
  line. New `ui.status(text)` method; `progress()`/`done()`/`fail()` keep the
  status coherent. Status is mono, `min-width:0` + `overflow-wrap:anywhere` so it
  stays on-screen at 390px.
- **Pre-send exceptions surface as a toast (`upload.js`).** `handleFiles` is
  wrapped in try/catch (a hostile File getter / synchronous throw → a visible
  `bad` toast, never a silent no-op), and each `uploadOne(...)` is `Promise.resolve
  (...).catch(...)` as a final backstop so an unexpected rejection always shows a
  toast + `console.error`.
- **Drag-and-drop** now also snapshots into an array (`Array.from(dataTransfer.
  files)`) for the same lifetime safety.
- **Cache-bust:** bumped `index.html` `?v=7 → ?v=8` (styles.css + app.js) and
  `app.js` `ASSET_VERSION "7" → "8"` in lockstep — this is the load-bearing fix
  for a phone stuck on a stale cached `upload.js`: combined with the existing
  `Cache-Control: no-cache` on the shell + `/static/*`, the returning phone
  revalidates and refetches the fixed modules.

### Verification result (WebKit @390 + Chromium @1366, isolated runtime)
- **WebKit happy path:** `?v=8` served; `init` fired; 13 chunk PUTs streamed;
  `complete` 200; status advanced "Starting…" → "Uploading 0/16/33/66/90%…" →
  "Finishing…" → "Uploaded"; the row stayed on-screen (left 16px, right 325px of a
  390px viewport — no horizontal overflow); the `.mov` assembled into the session
  dir.
- **WebKit stall path:** "Starting…" visible immediately; ends in a clear inline
  error + toast (the iCloud copy above) — never a silent 0%.
- **Chromium desktop (1366×900):** still works end-to-end (`init` + 13 chunks +
  `complete`, status advances, final state `done`) — no regression.
- **Residual cause only confirmable on the user's device:** if their real iPhone
  STILL shows "no init / stuck 0%" after loading `?v=8`, it is almost certainly a
  WebKit build that releases the iCloud File's backing store even before `init`'s
  metadata read — but that path now shows **"Starting…"** then the explicit
  unreadable-file error/toast (with the "open it in Photos once" guidance) instead
  of a silent stall, making the next attempt diagnosable.

## Reliable phone uploads + the guided "red thread" (2026-06-10)
Two-part feature pass (frontend half; backend built the matching contract in
parallel): make phone uploads actually COMPLETE, and give the journey a
beginning, a middle, and an ENDING.

### A. Upload resilience (`upload.js` — restructured)
The old client tried each chunk exactly ONCE, and ANY failure fell into a catch
that `DELETE`d the server-side upload — destroying the resume state the backend
already kept. Phones (screen lock kills fetches; flaky Wi-Fi) could therefore
never finish a large upload. Now:
- **Per-chunk retry + backoff:** `withRetry()` wraps every chunk PUT (and the
  idempotent init POST) — up to 6 attempts with ~1s→2s→4s→8s→15s waits ±25%
  jitter — on network errors (`code:"network"`/status 0), the resumable 499
  `client_disconnected`, 408/429, and 5xx. Other 4xx fail fast. The backoff
  sleep is abort-aware (`sleepUnlessAborted`, 150ms granularity) so Cancel never
  waits out a window. Retry waits are VISIBLE ("Connection hiccup — retrying
  (2/5) in 4s…").
- **client_id resume:** every init sends a stable `client_id` derived from the
  file's identity (name+size+lastModified → two 32-bit hashes → 17 chars
  `[a-f0-9]`, inside the server's `[A-Za-z0-9_-]{8,64}` contract). A matching
  live upload (user+session+client_id+filename+size+chunk_size) returns the SAME
  `upload_id` + `received:[...]`; received chunks are SKIPPED. After a server
  restart the state is gone and init transparently starts fresh. Re-picking the
  same file after a page reload derives the same id → resumes server state.
- **DELETE only on explicit Cancel.** The failure path never deletes; Dismiss on
  a failed row removes only the row (server partial state is left for resume /
  the backend's orphan GC). `fail()` also nulls the row's cancel hook so Dismiss
  can't trigger a delete.
- **Resume button:** a resumable terminal failure (transient classes exhausted,
  `file_unreadable`, 507, `upload_not_found`) keeps the row with a clear error +
  a "Resume upload" button. Resume re-enters the state machine: reconciles via
  `GET /api/upload/{id}/status` when the id is still live, else re-inits with the
  same client_id; the chunk loop skips `received[]` and `complete` runs again.
  `ctx.running` guards double-entry; `ui.resuming()` restores active visuals.
- **Screen Wake Lock:** a module-wide ref-counted manager holds
  `navigator.wakeLock.request("screen")` while ANY upload is active, re-acquires
  on `visibilitychange`, and releases when the last upload settles. Feature-
  detected; when unsupported a small "Keep your screen on while uploading." hint
  shows beside the dropzone instead.
- Everything else preserved: lazy per-chunk `file.slice`, metadata-only init,
  the iCloud `file_unreadable` copy, `errorMessage(err, phase)` (extended:
  network/499 says "…tap Resume to continue", 404 now distinguishes
  `upload_not_found` from `session_not_found`), `revealRow`, "Starting…" status.

### B. Stale-frontend banner (`app.js` + `index.html`)
`GET /api/me` now reports the server's `asset_version`. `startVersionWatch()`
checks once at boot, then every 5 minutes while the tab is VISIBLE, plus
immediately on `visibilitychange→visible` (there was NO pre-existing /api/me
polling loop to piggyback on — status refreshes are event-driven). A strictly
NEWER numeric server version (never null/equal/older) shows the slim fixed
`#update-banner` ("Studio was updated — refresh to get the latest" + Refresh =
`location.reload()`); dismissal is remembered per-version for the page's
lifetime. Raw payload read via `mods.apiGet` so `api.js` stayed untouched.

### C. The guided red thread
- **`guide.js` (NEW):** persistent 4-step stepper at the top of the chat column
  ("1 Add footage → 2 Transcribe (optional) → 3 Edit by chat → 4 Get your
  video"). Pure renderer — app.js aggregates state (`panel.onInventory` →
  clips/transcripts, `chat.onHistoryChanged` → message count, `panel.onOutputs`
  → preview/final exists) into `guideState` and pushes `guide.update()`.
  Transcribe counts as done when any transcript exists OR implicitly skipped
  once chatting starts with footage. Steps are buttons: footage →
  `chrome.revealUpload()`, transcribe → `chrome.revealTranscribe()`, edit →
  focus composer, video → reveal preview. Compact at every width (marks + the
  CURRENT step's label; full labels ≥1440px where the chat column fits them);
  `aria-current="step"`, full text in title/aria-label. Reset on session switch.
- **Endings:** preview pane header gains an `<a download>` (`#preview-download`,
  href = `fileUrl(path)+"&download=1"`, prefers FINAL, label "Download" /
  "Download draft"); Outputs rows each carry a download link; and on
  `onRenderDone` the chat shows a **"Your video is ready"** card (Play +
  Download, ok-green, replaces a trailing duplicate) + a success toast.
- **Beginnings:** empty session (0 clips) → chat empty state becomes "Step 1 —
  Add your footage" with an Add-footage button (opens the drawer at the upload
  section on phone); suggestion chips are SUPPRESSED until clips exist, then
  reappear footage-aware ("What's in this footage?" first). `chat.refreshEmpty()`
  re-renders only while the empty state is on screen.
- **Middles:** post-upload card in the panel ("Footage added — what's next?" →
  Transcribe the speech / Skip — start editing, dismissible,
  `panel.showNextStep()` from app.js' onUploaded); one-sentence transcribe
  explainer under the button; clip badge "not yet" → "no transcript".
- **Humanized outputs (`panel.js`):** "Final video" (visually primary), "Draft
  preview", "Subtitles (.srt)" with download links; `edl.json`/`project.md`
  collapse under a native `<details class="adv">` "Advanced" disclosure.
  Preview's verify strip renamed **"Frame checks"** and likewise collapsed.
- **Panel reorder (`index.html`):** Add footage → Clips → Outputs, with System
  demoted to a compact footer row; `status.js` labels went plain-language:
  "Video engine" / "Transcription key" (missing = neutral "not set — voice
  transcription disabled") / "Editor login" ("signed in"/"not signed in").
  Drawer title "Control panel" → "Project".
- **Phone orientation:** the session name chip now shows at EVERY breakpoint
  (below 640px the brand yields its topbar space to it and it truncates); the
  back control is a labeled "‹ Sessions" button (chevron + visible text); a
  phone-only topbar upload button (44px) opens the drawer at Add footage.
- **Jargon pass:** agent-auth failure copy is phone-safe ("The editor isn't
  signed in on the Studio computer — on that machine, run `claude` once, then
  restart Studio.") in both `app.js` canChat and `chat.js` turn errors; the
  Sessions screen gains a dismissible 3-line "How it works" card
  (`sessions.js`, dismissal persisted in localStorage
  `studio.howItWorks.dismissed`, guarded for private mode).

### A11y + correctness fixes in the same pass
- **`ask_user` option groups:** roving tabindex (one Tab stop per group) +
  ArrowUp/Down/Left/Right moves focus with wrap; Enter/Space still activate
  (native buttons). Selection semantics unchanged.
- **Tap targets:** the 1.8rem inline refresh buttons (clips/outputs) and the
  2rem status refresh → 2.75rem (44px); `#sessions-refresh` min 40→44px; new
  controls (Resume, stepper steps, CTA, download links) are ≥44px tall.
  QA follow-up (CSS-only, same `?v=9` — the no-cache headers deliver it): the
  update-banner Refresh (`btn--sm`, 2.1rem) + banner dismiss (2.2rem) and the
  `.nextstep__close` dismiss (2.2rem) keep their compact visible chrome (the
  banner overlays the topbar and must stay slim) but gain a ≥2.75rem (44px)
  invisible centered `::after` hit area — a rule in the update-banner section
  of `styles.css` scoped to those controls, deliberately NOT a global
  `.btn--sm`/`.icon-btn` change. Verified at 390px + 1440px: geometry identical
  with the rule disabled, ±21px probes hit on all three controls, and the two
  banner targets never overlap (dead zone in the 12px gap).
- **`[hidden] { display:none !important }` added to the reset.** Author
  `display:` rules (e.g. `.btn`'s inline-flex) override the UA's non-important
  `[hidden]` rule, so `el.hidden = true` was silently ineffective wherever an
  author display existed (latent: the streaming send/cancel swap, topbar user
  chip, verify section). All hidden-attribute toggles now behave.
  Belt-and-braces `.adv:not([open]) > .adv__body { display:none }` keeps the
  disclosure closed even where author flex might defeat the UA slot hiding.
- **Newest-wins autoplay (`preview.js`):** on render-done autoplay with no
  explicit preference, the newest `mtime` wins — a fresh draft no longer loses
  to a stale final (ordering-based pick would have).

### Cache-bust
`index.html` `?v=8 → ?v=9` (styles.css + app.js) and `app.js`
`ASSET_VERSION "8" → "9"` in lockstep (covers all dynamic feature-module
imports incl. the new `guide.js`). `util.js` import intentionally UNversioned.

### Verified (static-serve smoke, Chromium; backend was mid-change in parallel)
All 13 modules parse as ESM (`node --check`). At 390/640/900/1280/1440: no
horizontal scroll; phone topbar shows truncated session name + labeled back +
upload button (brand hidden <640); stepper states correct for
empty/footage-only/all-done; empty-session CTA shows with chips suppressed,
chips appear after clips land; drawer titled "Project" with section order
Add footage → Clips → Outputs → System footer; preview Download href carries
`&download=1` + `download` attr; "Frame checks" renders collapsed; live retry
exercised against a POST-rejecting server (escalating visible backoff →
terminal failure with Resume → Resume re-arms → Cancel aborts cleanly mid-
backoff, no DELETE-on-failure). Full end-to-end (real init/resume/wake-lock on
a phone) needs the parallel backend — covered by the plan's §8 Test Plan.

## Live-test fix pass (2026-06-10, after the red-thread feature)
The App Tester's live browser run found one P1 + four P2s, all frontend. Fixes:

- **P1 — Play/autoplay never actually played (`preview.js` + `app.js`).** The
  ready-card Play and the render-done autoplay loaded the source but the video
  sat paused at 0:00 (`emptied → loadstart → canplay`, never `play`). Root
  cause: `playPath` queued the deferred play on a ONE-SHOT `loadedmetadata`
  listener that ANY later `playPath` call removed (`clearPendingPlay`) — and
  the chat `tool_end` flow does exactly that: the artifact auto-open loads the
  same mp4 under an UNBUSTED URL while the outputs path loads it WITH the
  `&_=<mtime>` bust, so the second touch of the same file silently killed the
  queued play. **New design:** a play request is ARMED per video, keyed on the
  src minus the trailing cache-bust (`stripBust` — the bust is always appended
  last, so the strip is exact). `play()` is called synchronously (preserving
  the click's user-gesture context); PERSISTENT readiness listeners
  (`loadedmetadata`/`loadeddata`/`canplay`) retry while the armed request
  matches the current source, so reloads of the SAME file can no longer drop
  it. The request is cancelled only by: switching to a DIFFERENT video
  (stale-pick protection preserved), a genuine `pause` event (native controls
  stay authoritative — `load()` never fires `pause`), or a `NotAllowedError`
  (autoplay-policy block fails silent by design; the ready-card button is the
  gesture affordance). `app.js` additionally reorders both paths to
  `chrome.revealPreview()` BEFORE `setOutputs({autoplay:true})` so nothing acts
  on the element after play is requested. Verified in Chromium against a
  Range-serving harness + ffmpeg test mp4 (see below): real render-done event
  order plays; arm-then-same-file-reload plays (the canplay retry resurrects an
  aborted play); ready-card output-switch plays; user pause sticks across a
  seek; a different-video open cancels.
- **P2 — horizontal overflow at 640px (`styles.css`).** Three compounding
  causes: (1) the `.topbar__back-label--long/--short` swap rules never existed,
  so the back button rendered BOTH "Sessions" and "Back"; (2) the status-pill
  cluster + username chip were revealed at ≥640 where they cannot fit (pushed
  `#sheet-open`/`#logout-btn` to x≈729); (3) `.brand__name` could wrap. Fixes:
  exclusive back labels (phone "Back", ≥640 "Sessions"); **`.topbar__user` now
  reveals at ≥900 and `.statuscluster` at ≥1024** (the same facts live in the
  docked panel's System section from 640 up); `white-space: nowrap` on the
  wordmark. Verified 390/640/660/700/900/1024/1280: zero document/topbar
  overflow, no control past the viewport edge.
- **P2 — session pill truncated to one character at 390px (`styles.css`).**
  `#topbar-session-text` gets `min-width: 6ch` (floors the ellipsis at a
  meaningful prefix) and the <640 topbar tightens one spacing step
  (`gap: var(--s1); padding: 0 var(--s2)`) so the floor + four 44px icon
  targets + labeled Back all fit. At 390: ~63px of name ("QA test 2…"), no
  overflow even with a 90-char name (ellipsis engages).
- **P2 — empty-state placeholder overlapped the disabled video controls
  (`styles.css` + `index.html`).** `preview.js` already set
  `videoFrame.dataset.empty`, but the `[data-empty]` CSS rule it relied on was
  never written, and the attribute wasn't in the HTML for first paint. Added
  `.video-frame[data-empty="true"] video { visibility: hidden; }` (visibility,
  not display — keeps the box/pipeline) and `data-empty="true"` on
  `#video-frame` in index.html. Verified: empty → video chrome hidden,
  placeholder owns the frame; loaded → video visible, placeholder gone; flips
  both ways.
- **P2 a11y — form field without id/name.** The hidden upload file input
  (`upload.js`) now carries `id="upload-file-input" name="footage"` (+
  `tabindex="-1"`; the labeled dropzone button remains the accessible
  control), and the `ask_user` "Other…" input (`chat.js`) gets a unique
  id/name derived from its question's `labelId` (its aria-label remains the
  accessible name). DOM audit after mounting the upload UI: zero
  input/textarea/select missing both id and name.

**Cache-bust:** `index.html` `?v=9 → ?v=10` (styles.css + app.js) and `app.js`
`ASSET_VERSION "9" → "10"` in lockstep; `util.js` import still UNversioned.

**Verification method (backend was mid-change in parallel):** all four touched
modules pass `node --check` as ESM. A throwaway harness in `%TEMP%` (never in
the repo) served this folder at `/static`, `index.html` at `/`, a 401
`/api/me`, and an ffmpeg-generated 4s mp4 behind a Range/206-capable
`/api/file` — then Playwright-Chromium drove `initPreview()`/`initUpload()`
directly (video muted in-harness to neutralize autoplay policy) for the play
scenarios, and measured the dashboard topbar with realistic content (session
name, username chip, 3 status pills) at 390/640/660/700/900/1024/1280.

## Cancel-race + clip-badge fix pass (2026-06-10, after the live-test fix pass)
Two tester-confirmed bugs, both frontend-only (a backend engineer concurrently
hardened `routers/upload.py` with cancel tombstoning — no file overlap):

- **P1 — upload Cancel raced the in-flight chunk PUT (`upload.js`).** The
  cancel handler fired `DELETE /api/upload/{id}` while the chunk PUT fetch was
  STILL streaming — the server-side file handle blocked dir cleanup and the
  late chunk re-created the part dir (tester-reproduced ×2). **New ordering
  contract:** explicit Cancel (a) ABORTS the in-flight fetch first, (b) AWAITS
  the run settling, (c) only THEN sends the DELETE. Mechanics: one
  `AbortController` per `runUpload` run (`ctx.abortCtrl`), its `signal`
  threaded into EVERY network call of the run (status reconcile, init, chunk
  PUT via `putChunk(…, signal)`, complete) — `api.js` needed NO change (its
  `request()` already forwards `signal` and rethrows `AbortError` untouched,
  which also means the abort can never enter the retry classifier:
  `isTransient(AbortError)` is false, so `withRetry` rethrows immediately and
  cancel short-circuits the backoff schedule, complementing the existing
  abort-aware sleep). `ctx.runPromise` records the current run so the cancel
  handler can await settle; the status-reconcile catch preserves
  `ctx.uploadId` when the "failure" is our own cancel abort (the DELETE still
  needs it). After a user cancel, EVERY late error is swallowed silently by
  the existing `if (ctx.aborted) return` — including the backend's new 404
  `upload_not_found` on a raced chunk PUT (the row already shows
  "Cancelled."). Non-cancel transient failures still retry and NEVER DELETE;
  the Resume flow is unchanged (now also records `ctx.runPromise`).
- **P3 — "transcribed" badge overlapped the clip size text (`styles.css`).**
  `.clip__meta` was a flex row whose spans couldn't shrink (`min-width:auto`),
  so they overflowed the shrinkable `.clip__body` (`min-width:0`) and painted
  under `.clip__badge` at narrow panel widths (geometric overlap confirmed at
  1280 AND 640). Fix: `.clip__meta` is now ONE clipped line — `display:block;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap` with
  `span + span { margin-left: var(--s2) }` standing in for the old flex gap
  (mirrors `.clip__name`'s treatment), and `.clip__badge` gets `flex:none;
  white-space:nowrap` so the pill never shrinks or wraps. No `panel.js`
  markup change was needed.

**Cache-bust:** `index.html` `?v=10 → ?v=11` (styles.css + app.js) and `app.js`
`ASSET_VERSION "10" → "11"` in lockstep; `util.js` import still UNversioned.

**Verification (throwaway `%TEMP%` harness, never in the repo):** `upload.js` +
`app.js` pass `node --check` as ESM. A Node mock server served this folder at
`/static` plus an instrumented upload API (ordered event log, per-mode failure
injection, 2.5s chunk holds) and Playwright-Chromium drove the REAL
`initUpload()`: cancel mid-chunk → client issued exactly init → one chunk PUT →
DELETE at +2ms after the abort (fetch-level instrumentation; zero retry
dispatches across the full first backoff window), server log ordered
`PUT_ABORTED` → `DELETE`, the held chunk never completed (`PUT_END` absent),
row "Cancelled.", zero toasts; a one-shot 503 on chunk 1 retried once,
completed, ZERO DELETEs; a fail-fast resumable 404 armed Resume, which
reconciled via GET /status, skipped received chunks, completed, ZERO DELETEs.
Clip-card geometry: a harness replicating `panel.js` markup exactly ran a
visible-paint overlap check (rects intersected with overflow-clipping
ancestors) at viewports 390/640/1280, ten fixed container widths, and a
180→1240px sweep in 20px steps — ZERO overlaps; re-injecting the OLD css
reproduced 18 overlaps (the checker is not vacuous).

## Phone-side diagnostics — `diag.js` (2026-06-10, live-incident tooling)
Built for the live incident where a phone upload stalled in TOTAL client
silence (server saw init + chunk 0, then nothing; a retry from a new browser
also "no progress"). Server logs cannot explain a silent phone — `diag.js`
makes the phone's browser ship its own story to the backend's new
`POST /api/client-log` (auth-gated; body `{events:[{t,level,msg,data?}…]}`;
caps ≤64 KB body / ≤200 events / msg ≤500 chars / data ≤~2 KB → `{ok:true}`).

### The logger (`diag.js`, NEW)
- **`dlog(level, msg, data?)`** pushes `{t:Date.now(), level, msg, data}` into a
  bounded ring buffer (≤300; a separate pending queue, also ≤300, tracks
  undelivered events — oldest dropped when over). `msg` is a SHORT, STABLE,
  greppable code ("up.chunk.err"); details ride in `data`.
- **Every server cap is re-enforced client-side** so a batch can never trip a
  413/400: level normalized to debug|info|warn|error, msg sliced to 500 chars,
  `data` JSON-snapshotted and bounded to ~2 KB serialized (oversize degrades to
  `{truncated:true, preview}`; circular/BigInt/function data degrade safely),
  ≤20 events AND ≤56 KB per POST.
- **Shipping:** fire-and-forget batches every ~5 s OR immediately when ≥20
  events are pending; a backlog drains in successive ≤20-event batches. The
  failure policy is BY CAUSE (P1 fix 2026-06-10 — see the dated section below):
  a CONNECTIVITY failure (fetch TypeError — no HTTP response existed — or
  `navigator.onLine === false`) re-queues the batch WITHOUT burning the retry,
  so a dead network can never destroy events (only the ≤300 pending cap bounds
  them, oldest dropped; the localStorage mirror keeps the tail regardless); a
  SERVER rejection (an HTTP response arrived, non-ok, non-401, e.g. 4xx/5xx)
  is re-queued ONCE, then dropped (no infinite loop on a server that refuses
  us); a 401 re-queues WITHOUT burning the retry and flips the auth gate off
  (events buffer until login). While the browser reports offline the shipper
  PAUSES — a cheap `navigator.onLine` guard in the ship loop means ZERO POST
  attempts and no spin — and the `online` event triggers an IMMEDIATE flush of
  everything pending (sequential ≤20-event batches, FIFO order), so the offline
  story arrives without a page reload. Diag **never throws, never blocks,
  never recurses** on its own failures — every entry point is try/caught and
  shipper failures are silent (no dlog-about-dlog).
- **Auth gate:** shipping only runs while `setAuth(true)` — wired by `app.js`
  at boot (`getMe`), on login success, on logout, and self-healing via the
  5-minute version-watch `/api/me` read (covers mid-run session expiry).
- **Dying-tab tail:** `pagehide` + `visibilitychange→hidden` ship the pending
  tail via `navigator.sendBeacon` (Blob, `application/json`, same-origin cookie
  rides along) — a suspended/killed phone tab still delivers its last moments.
  The visibility/pagehide event is dlog'd FIRST so it is part of the beacon.
- **Crash persistence:** the last ≤200 ring events mirror to localStorage
  (`studio.diag.tail.v1`, throttled ~2 s; immediate on hide). On next boot any
  leftover mirror is claimed exactly once (read + remove), queued at the FRONT
  of pending (ships FIRST), each event tagged `data.replay:true` with its
  ORIGINAL timestamp — a frozen tab's history reaches the server when the user
  reopens Studio. Normal reloads replay too (duplicates are expected and
  marked; server-side the replay flag distinguishes them).
- **Global capture:** `window error` + `unhandledrejection` → `dlog("error",
  "win.error"/"win.unhandledrejection", {message, stack ≤1200 chars, …})`;
  `online`/`offline` and every `document.visibilityState` change are logged.
- **SINGLETON — the one wiring rule:** the instance is published on
  `window.__studioDiag`. `app.js` loads `diag.js` ONCE, dynamically and
  VERSIONED (`?v=ASSET_VERSION`), as boot Phase 0 (before the feature modules,
  so a Phase-1 load failure is itself captured). Feature modules must NOT
  `import "./diag.js"` — a bare import from a `?v`-versioned module would
  create a SECOND module instance (the documented api.js double-load trap).
  Instead they use a 3-line shim reading `window.__studioDiag` (silent no-op
  when diag is absent — see `upload.js`). Double-eval is also guarded inside
  diag.js itself (an existing instance is reused; no duplicate listeners/timers).
- **Privacy/XSS:** no credential fields, no cookie values (httpOnly anyway), no
  tokens, no usernames in events (the server tags identity from the session);
  `login.js` is NOT instrumented — app.js logs a bare-boolean `app.login.ok`
  after success. Diag data is never rendered into the DOM by anyone (verified).

### Instrumentation map (grep these msg codes in `studio/.runtime/logs/studio.log`)
- **upload.js (`up.*` — the incident's heart):** `up.pick` (name/size/type/
  lastModified/client_id), `up.validate.fail`, `up.init` (request) /
  `up.init.ok` (upload_id, mode fresh|resumed — inferred from received>0 —
  received count, total_chunks, chunk_size), `up.reconcile.ok/.err` (Resume's
  GET /status result), `up.chunk.start/.ok/.err` (id, index, bytes, per-ATTEMPT
  duration_ms, err code/status — one pair per attempt, so a stalled chunk shows
  as a start with no finish), `up.retry` (tag init|chunk, attempt #, delay_ms,
  reason) + `up.retry.exhausted` (logged centrally inside `withRetry`),
  `up.resume.click`, `up.cancel`, `up.fail` (phase, code/status, resumable),
  `up.complete.start` / `up.complete.ok` (whole-file duration_ms incl. retries/
  resumes via ctx.startedAt, stored basename), `up.wakelock.ok/.released/.fail`
  (with the error) / `up.wakelock.hint` (the "keep your screen on" fallback).
- **app.js (`app.*`):** `app.boot` (ASSET_VERSION, userAgent ≤200 chars, screen
  + viewport + dpr, online, visibility), `app.boot.error`, `app.login.ok`
  (bare boolean), `app.session.open` (session_id), `app.banner.show` (transition-
  guarded, server_v/page_v) / `app.banner.dismiss` / `app.banner.refresh` (the
  reload's pagehide beacon ships it).
- **diag.js itself:** `diag.replay` (count), `win.error`, `win.unhandledrejection`,
  `net.online`/`net.offline`, `page.visibility`, `page.pagehide`.

### Cache-bust
`index.html` `?v=11 → ?v=12` (styles.css + app.js) and `app.js`
`ASSET_VERSION "11" → "12"` in lockstep (versions the dynamic imports incl. the
new `diag.js`); `util.js` import still UNversioned. styles.css is byte-unchanged
this pass — the bump keeps the pair moving together per convention.

### Verified (throwaway `%TEMP%` harness, deleted after; Playwright-Chromium)
`diag.js`/`upload.js`/`app.js` pass `node --check` as ESM. A Node stub served
this folder + a recording `POST /api/client-log` + a fake chunked upload API:
boot ships `app.boot` (v "12", real UA/screen); 3 sub-threshold events arrived
on the ~5 s timer tick (+4.3 s, not immediate); a 25-event burst flushed
IMMEDIATELY as 20 + 5 (every batch across all runs ≤20 events); 400 events
while signed out → ring/pending both bounded at 300, ZERO batches shipped, and
`setAuth(true)` drained exactly 300 (15×20, oldest 100 dropped, order kept);
`visibilitychange→hidden` shipped the tail via sendBeacon 2 ms after dispatch
(application/json, visible in the network log, includes the visibility event
itself) and wrote the 200-event mirror; reload replayed all 200 FIRST tagged
`replay:true` (claimed once — not 400), then `diag.replay` + the new `app.boot`,
and the real pagehide beacon from the dying page arrived too; a simulated
3-chunk upload with an injected one-shot 503 on chunk 1 produced the COMPLETE
zero-loss thread (pick → init → init.ok → chunk0 ok → chunk1 err 503 →
up.retry 1/5 @1050 ms with reason → chunk1 ok → chunk2 ok → complete.ok
1118 ms + stored name, wakelock ok/released bracketing) and the row finished
"done"; hostile dlog inputs (circular, BigInt, function, 50 KB string, nullish,
bad level) never threw and arrived capped (`truncated:true`, preview 1400,
level→"info"); XSS sentinels logged through diag never appeared in
`document.documentElement.innerHTML`.

### Micro-fix (2026-06-10, post-QA): replayLeftover pending trim
QA caught a wrong-direction splice in `diag.js` `replayLeftover()`: the
post-replay trim used `pending.splice(pending.length - PENDING_MAX)`, which
DELETES the last 300 entries (keeping `length−300`) instead of capping at 300.
Fixed to `pending.splice(PENDING_MAX)` — keep the FIRST 300 (the FRONT, where
replays were unshifted, so the crash-replay story survives the trim and ships
first). Note this trim intentionally differs from the file's other trim sites
(`dlog`, the retry re-queue, the ring), which `splice(0, length−MAX)` to keep
the NEWEST: those protect a live stream; this one protects the replay-first
contract. Unreachable today (replay runs at module eval with pending empty and
replays ≤200 < 300) but corrected before it could bite. Cache-bust: `index.html`
`?v=12 → ?v=13` (styles.css + app.js) and `app.js` `ASSET_VERSION "12" → "13"`
in lockstep; `util.js` import still UNversioned. `node --check` re-passed for
`diag.js` + `app.js`.

### P1 fix (2026-06-10, post-tester): offline batches were DROPPED, not delivered
Tester-confirmed live failure: while the network was down, the shipper's batch
POSTs died (`ERR_INTERNET_DISCONNECTED`) and the once-then-drop policy counted
every dead-network tick as a burned retry — 7 batches burned out in a row, so
after reconnect the first batch carried only `net.online`, and the whole
offline story (`up.chunk.err` / `up.retry` / `up.retry.exhausted` / `up.fail`)
reached the server ONLY via the localStorage boot replay after a page reload.
Real incident shape (phone drops Wi-Fi, reconnects, user never reloads): the
critical evidence stayed invisible. Fix, entirely inside `flushNow()` + the
`online` listener in `diag.js`:
- **Failure classification by cause:** a fetch rejection (TypeError — no HTTP
  response existed) OR `navigator.onLine === false` is a CONNECTIVITY failure →
  the batch is re-queued WITHOUT setting `retried`. A dead network can never
  drop events; the ≤300 pending cap is the only bound (oldest dropped — the
  mirror still preserves the tail for boot replay). Once-then-drop now applies
  ONLY when an HTTP response actually arrived non-ok and non-401 (4xx/5xx — a
  server actively refusing us must not cause an infinite loop). The 401 branch
  is byte-identical to before.
- **Pause while offline:** the ship loop gained a `!netDown()` guard
  (`navigator.onLine === false`, read LIVE on every use so a missed event can
  never wedge shipping in a stale state) — while the browser KNOWS it is
  offline there are ZERO POST attempts; the 5 s timer keeps ticking cheaply.
  When `onLine` lies `true` on a dead link, the TypeError path above still
  classifies correctly (the guard is an optimization, not the only defense).
- **Flush on reconnect:** the `online` listener now calls `scheduleFlush()`
  after logging `net.online` — pending drains immediately in sequential
  ≤20-event batches, FIFO, so the offline story ships first and in order,
  with `net.online` riding in the tail batch.
All design rules preserved: never throws / never blocks / never recurses,
401-gating unchanged, beacon path unchanged, every client-side cap unchanged.
**Cache-bust:** `index.html` `?v=13 → ?v=14` (styles.css + app.js) and `app.js`
`ASSET_VERSION "13" → "14"` in lockstep; `util.js` import still UNversioned;
styles.css byte-unchanged (the bump keeps the pair moving together).
**Verified (throwaway `%TEMP%` harness driving REAL Chromium via DevTools,
deleted after; never in the repo):** `diag.js`/`app.js` re-pass `node --check`
as ESM. Against a recording stub server serving the real `diag.js`:
(1) the EXACT failed scenario — REAL CDP offline emulation mid-activity, 45
events generated offline (+ `net.offline`) sat through 3+ shipper ticks with
pending=46, ZERO dropped and ZERO network attempts (pause guard confirmed at
the browser network log: the only `/api/client-log` request was the pre-offline
baseline); flipping back online delivered the ENTIRE story within 1.5 s
(event-driven — well under the 5 s tick) as sequential batches 20/20/7, in
order, zero duplicates, NO reload. (2) the `navigator.onLine`-lies-true dead
link (fetch TypeError, the tester's burnout case): 7 consecutive failed cycles
kept all 25 events pending; restoring the network delivered all 25 in order
(20+5), exactly once. (3) server-rejection discipline preserved: a
400-returning server received the batch exactly TWICE (initial + the one
retry), then it was dropped — no loop — and normal shipping resumed
immediately after.

### P1 fix (2026-06-10, late evening): hung-chunk stall → dead non-resumable row
The diagnostic system's first live catch (twice tonight, log-confirmed): the
phone's chunk-0 PUT was COMMITTED server-side (200 written) but the response
never reached the page's JS — the fetch hung forever (no per-chunk timeout),
and when a reload finally killed it the failure surfaced as a **raw
`TypeError`** ("Load failed"), which `isTransient()` classified PERMANENT
(`!(err instanceof ApiError)`) → **0 of 6 retries fired** (zero `up.retry`
lines in the log) and `canResume()` said no → dead "failed" row. Separately,
Wake Lock is secure-context-only, so on plain-HTTP iOS it does not exist
(`up.wakelock.hint reason=unsupported`) and screen lock suspended attempt 2.
Four fixes, frontend-only:
- **`api.js` body-read guard (additive):** in `request()`, the post-fetch body
  read (`res.json()`/`res.text()` on a 2xx) is now wrapped — any read failure
  becomes the same transient `ApiError(0, "network")` the fetch guard produces;
  AbortError passes through untouched. Streaming paths needed nothing new:
  `streamPost`'s fetch/normalizeError/reader loop already convert non-abort
  failures to ApiError, `normalizeError`'s own `res.json()` was already
  try/caught, `raw:true` responses are exempt by design (un-read Response
  handed to the caller). No call-site changes.
- **`upload.js` reclassification:** non-ApiError errors are now TRANSIENT by
  default (retry + Resume via the unchanged `canResume(isTransient(...))`
  chain) — EXCEPT `AbortError`, which keeps short-circuiting so user-cancel
  never burns a retry. Defense-in-depth behind the api.js guard.
- **`upload.js` per-chunk stall watchdog (the load-bearing fix):** retries only
  fire on a THROWN error, so a silently hung PUT defeated the whole v14
  machinery. Each chunk ATTEMPT now arms a timer — `chunkTimeoutMs(bytes)` =
  max(90s floor, bytes/128 KiB/s + 30s grace) ⇒ 94s for an 8 MiB chunk
  (deliberately biased EARLY: a premature abort is a cheap idempotent re-PUT;
  a late one is minutes of silent hang). On expiry it aborts that attempt's
  OWN AbortController (the run/cancel signal is relayed in), emits
  `up.chunk.timeout {id, i, ms}`, and ONLY a watchdog-induced AbortError
  (`timedOut && !ctx.aborted && name==="AbortError"`) is rewritten to transient
  `ApiError(0,"timeout")` → normal backoff retries → committed chunk re-PUTs
  to an instant 200. Timer cleared in `finally` on every settle (no leaks, no
  post-completion firing); user-cancel aborts keep their AbortError identity →
  the existing post-cancel silence is byte-identical.
- **Visible keep-screen-on notice:** the previously feature-gate-only hint is
  now driven by ACTUAL protection state — shown while uploads are active AND
  no wake lock is held (API absent — iOS/plain-HTTP — OR acquire denied, via a
  new `wakeLock.setOnChange` subscription + `held()`/`failed()`), with plain
  copy: "Keep the screen on and stay in this tab until the upload finishes."
  Static text on the existing `.upload-hint` tokens (styles.css untouched),
  sits directly above the progress rows, clears when uploads settle or a lock
  lands. `up.wakelock.hint` now reports reason `unsupported` | `acquire_failed`.
**Cache-bust:** `index.html` `?v=14 → ?v=15` (styles.css + app.js) and `app.js`
`ASSET_VERSION "14" → "15"` in lockstep; `util.js` import still UNversioned;
styles.css byte-unchanged (the bump keeps the pair moving together). Remember
"shipped ≠ deployed": restart the server so v15 is actually served.
**Verified (throwaway `%TEMP%` harness + stub server driving REAL Chromium via
Playwright, deleted after; never in the repo):** `api.js`/`upload.js`/`app.js`
pass `node --check` as ESM. Against a stub that serves THESE files and scripts
the failure shapes: (1) THE INCIDENT REPRO — chunk accepted + committed,
response never sent → `up.chunk.timeout` → `up.chunk.err code=timeout` →
`up.retry` (the line the live log had zero of) → idempotent re-PUT 200 →
`up.complete.ok`, row "Uploaded" — run BOTH with a compressed clock (constants
rewritten only in the served copy) and once at FULL FIDELITY (byte-exact files,
real 90s watchdog). (2) torn body after a 200 (partial JSON + socket destroy) →
`ApiError(0,"network")` (not a raw TypeError) → retry → complete. (3) cancel
during a watchdog-armed stalled chunk → "Cancelled.", clean AbortError (NOT
rewritten to timeout), DELETE after the run settled, NO timeout/retry events in
the 12s after (timer cleared). (4) wake-lock-absent emulation → notice visible
with the exact copy during a normal 3-chunk upload, gone on completion,
`reason=unsupported` emitted; wake-lock-working runs showed NO notice.
(5) Resume unregressed (complete→500 → Resume → `/status` reconcile →
idempotent complete 200) and offline→online cycle unregressed (init retries
burned `code=network` while offline, completed on reconnect).

## Secure Studio onboarding UX — HTTPS on the LAN (2026-06-11)
The frontend half of the "Secure Studio" feature (plan
`PM/plan-2026-06-11-https.md`): the backend now serves the app on BOTH
`http://<ip>:8420/` and `https://<ip>:8443/` with an app-generated local CA,
because iOS only grants the Screen Wake Lock API in a secure context — over
plain http, phone uploads die when the screen locks. This pass builds the
path that walks a NON-TECHNICAL household member from the http origin to the
trusted https one.

- **`setup.html` (NEW) — the standalone Secure Setup page.** Served login-free
  at `/setup` on both schemes (backend `FileResponse`, no-cache). Deliberately
  NOT part of the SPA: no module graph, no boot, no auth — it must work on a
  phone that has never signed in. It links `styles.css?v=16` purely for the
  design tokens (Space Grotesk/Public Sans, the warm near-black ground,
  orange accent) and carries a tiny inline `<style>` fallback BEFORE the link
  (equal specificity → the real stylesheet wins when present) so a failed CSS
  fetch still yields a readable dark page with native `<ol>` numbering.
  Content, phone-first at 390px (no horizontal scroll; every control ≥44px):
  - Title + promise ("one-time setup… upload with the screen allowed to
    lock"), plus "do this once on each phone or computer".
  - An iPhone "use Safari" callout (the Camera-app QR scan can land in a
    browser that can't install configuration profiles).
  - Four steps as cards in an `<ol role="list">` (explicit "Step N" eyebrows
    carry the numbering under `list-style:none`; `role=list` keeps Safari/
    VoiceOver list semantics): 1) big full-width Download button → `/ca.crt`
    (NO `download` attribute — the backend serves it inline so iOS opens the
    profile flow); 2) install path chips (Settings → Profile Downloaded →
    Install); 3) **THE COMMONLY-MISSED STEP, visually dominant** — 2px accent
    border + accent-glow gradient + warning icon + larger type/padding +
    shadow: Settings → General → About → **Certificate Trust Settings** →
    toggle ON for "video-use Studio CA…", with the plain warning "Skipping
    this step means the secure address still shows a warning."; 4) the live
    secure addresses.
  - Collapsed `<details class="setup-more">` sections: Android (Chrome),
    Windows desktop, and Troubleshooting (warning → you missed step 3; can't
    connect → run `open-firewall.ps1` once as admin; old address says "not
    secure" → expected, the http address stays as-is).
  - **The page's only script** (inline, classic, ~40 lines) fetches
    `GET /api/tls/info` (public, never-5xx contract) and fills `https_url` +
    `host_local_url` as tappable links — **textContent ONLY**, and `href` is
    assigned only after an explicit `https://` scheme check (defense in
    depth; the value comes from our own server). The `.local` link carries
    the "bookmark this one — it survives address changes" note. The trouble
    callout is TWO-STATE (2026-06-11 QA P2 fix — a transient blip must not
    overclaim that TLS is off): an EXPLICIT `enabled:false` from a successful
    response shows "Secure mode isn't on right now. Restart the Studio server
    on the computer, then reload this page." AND de-arms the download CTA
    (href removed + `aria-disabled` + faded) since `/ca.crt` would 404; a
    fetch failure (network error / non-OK) shows the softer "Couldn't reach
    the Studio server just now. Check you're on the home Wi-Fi and reload
    this page." and leaves the download armed. ONLY explicit `enabled:false`
    ever de-arms. The enabled-but-no-usable-URLs shape failure shares the
    soft state (armed, reload advice). Copy is injected via `textContent`
    into `#tls-state-lead`/`#tls-state-rest`; the step-4 pending line splits
    the same way ("…once secure mode is on." vs "…after a reload.").
- **`#secure-banner` (`index.html` + `app.js`) — the in-app nudge.** Mirrors
  the `#update-banner` pattern (same visual recipe, same invisible
  `::after` ≥44px hit-areas). Shown ONLY when `!window.isSecureContext` AND
  `/api/me` reports a non-null `secure_url` — i.e. NEVER on the https origin
  and NEVER while TLS is off. Copy: "Uploads currently need the screen kept
  on. Set up the secure address for hands-off uploads — a one-time, 2-minute
  setup." with a "Set up" link (→ `/setup`, `target=_blank rel=noopener` so
  it can't kill an in-flight upload in this tab) and a dismiss. **Dismissal
  is gently persistent:** localStorage key
  **`studio.secureBanner.dismissedAt`** (ms-epoch string); the banner stays
  away for 7 days, then becomes eligible again. Storage failures (private
  mode) fail open to a tab-lifetime dismissal. Visibility re-evaluates on
  every `checkAssetVersion()` tick — the secure banner rides the SAME
  `/api/me` raw read as the update banner (boot + 5-min visible-tab poll +
  visibilitychange), so no new polling and no `api.js` change (`getMe()`'s
  mapped shape is untouched; the raw `apiGet` payload carries `secure_url`).
  It also HIDES itself if `secure_url` goes null mid-run.
- **Banner coexistence (`.banner-stack`):** both banners can be due at once
  (e.g. a deploy while still on http). They now live in a fixed top-center
  flex COLUMN (`.banner-stack`, index.html) — the fixed positioning moved
  from `.update-banner` to the stack (a lone banner renders pixel-identical
  to before), heights stay content-driven so wrapped text at 390px can't
  overlap, and the stack itself is `pointer-events:none` (children re-enable)
  so the usually-empty fixed region never blocks the topbar.
- **`upload.js` keep-screen-on notice:** gains the inline escape hatch — 
  "…or **set up the secure address** to make this automatic" (anchor to
  `/setup`, `target=_blank rel=noopener` + an "(opens in a new tab)"
  aria-label, built from text nodes via `el()` — XSS discipline unchanged).
  On the https origin Wake Lock works, so the notice (and the link) simply
  never appears there.
- **`styles.css`:** existing tokens ONLY. New sections: `.banner-stack` +
  shared `.update-banner,.secure-banner` rules (the refactor above), the
  `.upload-hint__link` accent, and the `setup-*` family (page scroll
  override `body.setup-page` — the app shell sets `body{overflow:hidden}`,
  the setup page must scroll; step cards; the dominant `--critical` card;
  path chips; break-all URL links; `details` summaries ≥44px; reduced-motion
  respected on every new transition/animation).
**Cache-bust:** `index.html` `?v=15 → ?v=16` (styles.css + app.js) and
`app.js` `ASSET_VERSION "15" → "16"` in lockstep (setup.html links
styles.css?v=16 too); `util.js` import still UNversioned. Frontend-only — no
server restart needed for these files; the backend half (the /setup route,
/ca.crt, /api/tls/info, /api/me secure_url) ships separately and DOES need
the restart.
**Verified (throwaway `%TEMP%` stub server + real Chromium via Playwright,
deleted after; never in the repo):** `app.js`/`upload.js` pass `node --check`
as ESM and setup.html's extracted inline script as a classic script. Against
stubs of the §5 contract on a NON-localhost LAN-IP origin (a genuine
insecure context — localhost is always secure): setup.html at 390px/1440px —
URLs filled via textContent, zero h-scroll, all tap targets ≥44px, step 3
measurably dominant (2px accent border, +padding, +type, shadow vs 1px
plain); no-CSS + tls-info-404 degradation readable (dark fallback, native
list numbers, friendly off-state, download stays live); explicit
`enabled:false` de-arms the download. Banner matrix: insecure+url → shows;
dismiss → hidden + persists across reload; timestamp faked to 8 days →
re-shows; `http://localhost` (secure ctx) → never; null `secure_url` →
never. Both banners forced together at 390px → stacked with an 8px gap, no
overlap, all four controls report 44px ::after hit areas. `initUpload`
mounted against the real module → notice contains the `/setup` anchor
(new-tab, noopener, text-node-only). Zero unexpected console errors.

## How it connects
Pure consumer of `/api/*` per `API_CONTRACT.md` (now per-user sessions). Holds no
secret of any kind — authentication is the server-managed httpOnly
`studio_session` cookie, and the backend scopes every session call to that
cookie's user. Do not introduce a build step. `setup.html` is the one
deliberate exception to the SPA shape: a standalone, login-free document
(served at `/setup`) whose only API touch is the public `GET /api/tls/info`.
