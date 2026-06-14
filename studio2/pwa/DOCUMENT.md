# studio2/pwa/ — the Studio v2 PWA (device side)

Vanilla-JS ES-module PWA, **no build step**. Served by the relay: `GET /` →
`index.html`, assets under `/static/*`. This directory is the *device half* of
Studio v2 — everything that touches media bytes lives here; the relay
(`studio2/relay/`) carries only JSON.

Built in **Step 2** of the M1 plan (`PM/arch-2026-06-12-m1-core-loop.md` §12):
app shell + store + capability gate + login + projects. **Step 4** added
`engine/`, `store/edl.js`, `ingest.js`; **Step 5** added `bridge.js`,
`chat.js`, `player.js`, `export.js`, `editor.js` and wired them into the
shell (version triple bumped to `2`).

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell: loading / unsupported / login / projects / editor views, banner stack (update / secure / offline), boot watchdog, `?v=` busted entry (currently `13`). Viewport meta carries `viewport-fit=cover` (safe-area insets) + `interactive-widget=resizes-content` (Chromium resizes the layout viewport for the keyboard; iOS ignores it — editor.js's visualViewport watcher covers iOS). |
| `setup.html` | Secure Setup page (login-free, both schemes). v1 flow adapted; carries the **shared-CA shortcut callout** (phones with v1 trust skip to step 4). Renders `/api/tls/info` values textContent-only. |
| `manifest.webmanifest` | `start_url "/"`, `scope "/"`, standalone, icons 192/512 + maskable. |
| `sw.js` | Service worker: **version-keyed cache-first shell**, network-only `/api/*`, old-cache purge on activate. See "Versioning" below. |
| `styles.css` | The v2 design system ("cutting room": blue-slate ground, timecode-teal accent; Bricolage Grotesque / Schibsted Grotesk / Spline Sans Mono — all vendored). Phone-first 390px, safe-area aware, AA contrast, `[hidden]` guard. M1.1: the editor section is paged — `.editor__pages` grid-stacks the three `.page`s (inactive = `visibility:hidden`, never unmounted), `.tabbar` bottom bar with active notch + activity dot, `--kb`/`data-kb` keyboard rules, `.media-soon` coming-soon card. v9: the `.ingest-progress__row` now baseline-aligns and lets its label (which carries the batch position "Adding 2 of 5 — name — Copying…") flex-grow + ellipsize while the `.mono` byte readout keeps its own line on a 390px phone. **v11 (M3)**: the `.player__frame` canvas-aspect preview overlay (CSS `aspect-ratio` set by player.js, `data-fit`/`data-bg` driving `object-fit` + a blurred `.player__bg` copy + the `.player__music-chip`); the `.fmt` Format picker (aspect chips with proportional `.fmt__chip-box` glyphs, segmented resolution/background toggles, tier badge); the `.clipfit` per-clip fit control; the `.music` panel (library browser, `.mplace` placement cards with a volume slider, fade fields, an accessible `.mplace__duck` switch); the export render states (`.export__result[data-state="warn"]` gated card / `[data-state="info"]` confirm, `.export__confirm-row`, `.export__verdict-note`); and `.progressbar__fill` gains a `transform: scaleX()` determinate variant for the render's frames-done bar. All on existing tokens; reduced-motion-gated. |
| `app.js` | Entry: SW registration → diag → capability probe → unsupported gate → tmp-sweep + crash-marker reconcile → offline-aware auth gate → view router. `ASSET_VERSION = "12"`. Owns the editor lifecycle (enter mounts `editor.js`, back/logout tears it down; back is blocked while ingest/export runs — PROJECT exit only, never tab switches). Offline-banner lifecycle (v3): while the banner is up, a 10s visible-tab recheck runs and the `studio2:relay-seen` window event (fired by chat.js) triggers an immediate recheck — both verify via `/api/me`, so the banner clears without a reload/tab switch and can't flicker. |
| `api.js` | The network seam: cookie-only auth, v1 error-envelope `normalizeError`, the 2xx **body-read guard**, `streamPost` (SSE-over-POST, parses `id:` seq) per arch §2.2. The bridge stream does NOT live here — `bridge.js` `sseRequest` owns it (the documented Step-5 transport deviation below). **M2**: `uploadTranscribeAudio(blob, {project_id, clip_id, duration_s, language?}, {signal})` — POSTs the `.m4a` as a RAW `audio/mp4` body (NOT multipart — the relay's no-parsing-surface property) → 202 `{job_id, est_cost_usd}`; `pollTranscribe(jobId)` / `cancelTranscribe(jobId)`; `transcribeStatus()` → the `/api/status.transcribe` gate (safe disabled shape on any failure, never throws). **v8**: `getAgentModel({signal})` → `{current, available:[{id,label,hint}], appliesTo}` and `setAgentModel(model, {signal})` → same shape, both normalized to a stable contract (id-less rows dropped; missing fields defaulted); a bad id surfaces as `ApiError(400,"invalid_model")`, offline as `ApiError(0,"network")` — settings.js branches on those. |
| `util.js` | Shared helpers (DOM, `el()` with **no innerHTML path**, formats, `deviceId()`, focus trap, toasts). Imported **bare** everywhere — never versioned. |
| `diag.js` | v1-pattern diagnostics shipper: dlog ring → `/api/client-log`, sendBeacon tail, claim-once boot replay, never-throws. Singleton `window.__studio2Diag`; LS key `studio2.diag.tail.v1`. |
| `capability.js` | Boot probe matrix (arch §7.4): OPFS / createWritable / move / share-files / WebCodecs / storage / wake lock. `supported = opfs && createWritable` is the Tier-1 floor. Singleton `window.__studio2Caps`. **v10**: `webcodecs.videoDecoder` is now LOAD-BEARING — it gates the bridge's `view_frames` executor (Agent Vision); the value reaches bridge.js via the editor's `ctx.caps`. A new "Assistant can read frames" capability row surfaces it to the user. videoEncoder/audio* stay display-only (M3 re-encode tier). |
| `login.js` | Login view against `POST /api/login` (arch §2.1). Uniform 401 copy; offline-aware error copy. |
| `projects.js` | Project list: create (name optional) / open / two-step delete confirm, quota display + persist note, capability matrix panel, `navigator.storage.persist()` on first creation. |
| `store/` | OPFS persistence layer (incl. Step 4's `edl.js` journal) — see `store/DOCUMENT.md`. |
| `assets/` | Icons + vendored fonts — see `assets/DOCUMENT.md`. |
| `engine/` | Step 4: vendored mediabunny 1.46.0 + writers/probe/cut/verify — the lossless engine; M2 added `audio.js`; **v10 (Agent Vision) added `frames.js`** (still-frame decode → downscaled, rotation-correct JPEG base64 for `view_frames`). See `engine/DOCUMENT.md`. |
| `ingest.js` | Step 4: SMART INGEST (arch §7.1) — picker → immediate streamed OPFS copy (volatile handles!) with progress + wake lock → probe → degradation detection (no-audio / `temp_video_for_share*` / advisory 720p-H.264) → Files-route guidance card or straight to clipmeta + `add_clip`. Exports `mountIngest()` — see "Step 4 delivered" below. **M2**: the degraded re-pick (Pick from Files) path now `transcripts.deleteTranscript`s the discarded clip's id (arch §1.2/§13 — a transcript of the OLD audio must never survive the swap); `destroy()` resets the view to idle before removing the root (deferred P3-B: no stale "Finishing…" progress DOM can linger into a re-mount). **v9 (multi-select)**: the `<input>` carries `multiple`; on `change` the picked `files` run through the SAME per-file flow as a STRICTLY SEQUENTIAL queue (`runBatch` → awaited `runIngest` per file) — file k+1 never starts until file k is fully settled (copy → probe → degradation resolution → add/skip), so the device single-flight (one streamed copy / probe at a time) is intact by construction; instrumented `ingest.batch.start`/`.done` diag bracket the run. Progress shows the position ("Adding 2 of 5 — name — Copying…"); the degraded guidance card still appears per-file, and its primary action is mode-aware — **single pick: "Pick from Files"** (reopen the picker, unchanged); **batch: "Skip this one"** (no picker re-entry mid-batch — that would interleave a fresh pick with the queue and break single-flight; the user re-adds the original from a fresh pick afterward); "Use it anyway" is identical in both modes. Resolving one file's card (or an error/quota/unplayable card, now "Continue" in a batch) NEVER aborts the rest of the queue. The wake lock is held ACROSS the batch (acquired once, released when the queue drains; `acquire()` is idempotent); the crash marker stays per-file. `onClipAdded` fires once per successfully-added file. N=1 is the batch-of-one case — behaves EXACTLY as the historical single pick. `mountIngest`/`isBusy`/`destroy` surface unchanged (additive only). **v13 (iOS hint)**: a `.ingest__hint` line under the "Add video" button tells iOS users how to grab several at once ("…in your Photo Library tap multiple, or in Files tap 'Select' first."), riding with the button (hidden during progress/cards). The picker MECHANICS are unchanged — the input has been `multiple` since v9; only the textContent-only hint is new. |
| `bridge.js` | Step 5: THE DEVICE-TOOL BRIDGE, device half (arch §2.3/§3) — persistent SSE stream, command dedupe by `command_id` (≤50 LRU, cached-result re-POST on replay), single-flight op queue (`createOpQueue`, shared with export), executor registry (arch §4 device column), result POST with the 1→2→4→8→15 s retry ladder (abort on 409/4xx), `project_mismatch` binding, `server_boot_id` change handling, `: superseded` handling. Also exports `sseRequest` (GET SSE reader) — see "Step 5 delivered" below. **M2**: `read_transcript` is now REAL (the M1 stub is gone) — token-budgeted device-side over `store/transcripts.js`: overview (no clip_id), text mode (lines ≤14k chars + `next_from_s` cursor), words mode (≤120s window); NEW `find_in_transcript` (normalized word-sequence search w/ `gap_before_s`/`gap_after_s`); `get_inventory` clips gain per-clip `transcript:{language, words, duration_s}` and `has_transcript` is now honest. All results ≪ the 512 KB cap by construction. **v10 (Agent Vision)**: NEW `view_frames` executor — gates on `ctx.caps.webcodecs.videoDecoder` (unsupported device → in-band `{error:{code:"unsupported"}}`, NEVER a throw), re-clamps `at_seconds` to ≤4 finite ≥0 (dups collapsed), resolves the clip via `findClipFile`, calls `engine/frames.extractFrames` (server-fixed 512px/q0.6) and returns the plan §5 `{frames:[{at_s,b64,w,h,bytes}], note?}` shape; any decode failure → in-band `{error:{code:"engine_error"}}` (the executor's result is the §5 contract, NOT the bridge taxonomy — it never becomes a bridge `ok:false`). The device `RESULT_MAX_BYTES` moved 500 KB → **2 MiB** in LOCKSTEP with the relay's `routers/bridge.py` `_RESULT_MAX_BYTES` (plan §3 — base64 JPEGs need the headroom; both ends 413 a >2 MiB result). **M3 (v11)**: the 6 RENDER-TIER executors — `set_output_format`, `set_clip_fit`, `list_music_library`, `add_music`, `update_music`, `remove_music` — each a thin wrapper around the shared `music-ops.js` ops (so the agent and the UI run identical code), returning the EXACT Step-4 result shapes (verified). `get_inventory`/`read_edl` are EXTENDED to surface `canvas`, per-clip `fit` ({mode,background}), the folded `music` placements (joined to track titles), and the current `tier` ("lossless"\|"render"). A render-territory change fans out via `ctx.notifyRenderChange()` (the `"render"` edlEvent); music ops also `notifyEdlChange()` (music is timeline data). These tools are flag-gated OFF in the live relay (the dormant M3 deploy never registers them with the model) — the executors are built + verified now and turn on with the `[render]` flag at M3 integration. |
| `chat.js` | Step 5: the conversation UI (arch §2.2/§7.2) — streamPost turn consumption (deltas, tool chips, errors), ask_user option cards (bridge-commanded, v1 card pattern), OPFS `chat.json` transcript (sole writer), attach-based turn recovery (visibility regain + editor re-entry), 409 `turn_in_progress` follow, offline state. v3: an ask_user card mounting into the live turn breaks the text run (`breakText()`) so pre-question text, card, and post-answer continuation render as three distinct blocks (run-on fix); fires `studio2:relay-seen` on bridge-online and `turn_start` (feeds the app.js banner fix). v5 (M1.1): pinned scroll-follow (deltas follow only while the user is at the bottom; own send / transcript render / question cards force re-pin; composer focus re-pins; a ResizeObserver holds the pin through keyboard-driven log resizes) + `ctx.onChatActivity(active)` (feeds the Edit tab's dot). v6 (M1.2 P2-2): the activity predicate is `streaming \|\| dangling \|\| pendingCard` — a DANGLING turn (stream died mid-turn, relay still working) keeps the dot lit through the phone-lock gap until attach resolves it. Turn/transport logic untouched. |
| `player.js` | Step 5: EDL-driven skip preview (arch §7.2) — native `<video>` on a blob URL of the ORIGINAL clip, seek-past-removed-regions on `timeupdate` + `requestVideoFrameCallback`, virtual-timeline scrubber (timeline↔source mapping), per-segment source swap, instant refresh on `edlEvents` "change". **M3 (v11) — the §8b PREVIEW OVERLAY (CSS approximation, NOT the exact compositor):** a canvas-aspect `.player__frame` sized to `meta.render.canvas` (a 9:16 output shows portrait even while a landscape clip plays); each clip is CSS `object-fit: contain\|cover` per its effective fit (`store/meta.effectiveFit`), with a muted, CSS-blurred, cover-scaled COPY of the same `<video>` behind it for blurred-fill (black bars when `background:"black"`); and a **WebAudio** graph (`createMusicGraph`) plays the folded music under the preview with gain + fades + a COARSE speech-duck approximation (every clip-segment span dips the bed — NOT audiomix's word-accurate envelope; the exact mix is the render's job), following the virtual timeline (play/pause/seek/tick), buffers decoded lazily via `decodeAudioData` + released when a track is unplaced. Repaints on the new `"render"` edlEvent as it refolds on `"change"`. A `.player__music-chip` names the placed bed. The exact-pixel compositor path is export-only (reusing it live would blow the iOS memory budget — arch §8b). |
| `export.js` | Step 5: the §7.3 export flow — disarm → quota preflight (kept-fraction × source + 10%) → `tempThenRename` + `losslessCut` (progress heartbeats, wake lock, crash marker) → **verify before rename** → commit + arm share (spike share-serialization guard, ~25 s never-settle watchdog) / download fallback; corrupt → `.corrupt` rename + red verdict + share-for-inspection; exports list with re-share/delete. **M3 (v11) — TIER AUTO-SELECTION (arch §5):** the fold now carries `music`; export reads `meta.render` (`getRenderBlock`), resolves the canvas (`engine/canvas.resolveCanvas`), and calls `cut.tierCheck(fold, renderBlock, clips)`. `"lossless"` → exactly today's instant remux path (`runLossless`, byte-for-byte the M1 export — the load-bearing regression: a single-clip trim never re-encodes). `"render"` → `runRender`: GATE on `caps.render.ok` (false → the honest GATED-DEVICE card "keep it lossless or render on a computer" + translated reasons, no partial output), a once-per-session CONFIRM + SDR notice ("re-encodes… a couple of minutes… standard-range, not HDR"), render-sized quota preflight, wake lock + crash marker, then `engine.renderProject({projectId, fold, renderBlock, canvas, clips, music, sources, musicSources, transcripts, onProgress, signal})` (the checkpointed decode→compose→encode→mix→concat→verify spine; resumes a matching-fingerprint manifest). Progress is DETERMINATE (frames done/total + fps + ETA + segment). The verified `render/out-<ts>.mp4` handle is moved into `exports/` (streamed cross-dir copy); a corrupt render quarantines `.corrupt` (verify-before-share holds for re-encodes too). Music files come from `store/music.readTrackFile`; duck word-times from `store/transcripts.readTranscript` (only when a placement ducks). |
| `editor.js` | Step 5: editor composition root — mounts player/clip strip/ingest/export/chat into `#editor-mount`, builds the Step-4 engine adapter (dynamic bare imports, degrades engineless), owns `edlEvents` + the shared op queue + `findClipFile`, wires the bridge lifecycle (connect on enter, disconnect on leave). M1.1: composes THREE PAGES (Media = ingest + clip strip + music; Edit = chat full-height; Preview = player + format picker + export incl. exports list) behind `tabs.js`; owns the visualViewport keyboard watcher (`--kb` + `data-kb` on the editor root) and per-project last-tab persistence. v6 (M1.2 P2-1): the mount sequence (vv watcher → chat → player/export → ingest → bridge) runs inside a guarded region whose catch runs `teardown()` — the same unwind `destroy()` uses — then rethrows to app.js, so a mid-init throw can no longer leak the window/document-scoped listeners or a connected bridge. **M2**: the adapter exposes `extractAudio` (engine/audio.js); `mountTranscribe` mounts the per-clip controller and provides the clip strip's Transcribe affordance node (`clipCard(m, transcribeNode)`); the gate is fetched via `api.transcribeStatus()` and re-fetched on visibility regain; a `"transcript"` event on `edlEvents` fans transcript changes to the strip; `resumePendingJob()` runs after the strip renders (lock-proof poll resume). **M3 (v11)**: the adapter gains `tierCheck`/`renderProject` (engine/render.js) + `openAudioForDecode` (engine/webcodecs.js — the music-upload probe); the editor mounts the Format picker (`format-ui.mountFormatPicker`) on the Preview page, the Music panel (`music-ui.mountMusicPanel`) on the Media page (replacing M1.1's "coming soon" card; an engineless editor shows an unavailable note), and a per-clip fit control (`format-ui.buildClipFit`) in each clip card (`clipCard(m, transcribeNode, fitNode)`); `ctx.notifyRenderChange()` fires the new `"render"` edlEvent (canvas/fit changes — NOT a journal edit — repaint the preview/format/music without a full refold; music ops fire BOTH). |
| `tabs.js` | M1.1: the bottom tab bar (Media / Edit / Preview) — WAI-ARIA tabs (tablist/tab/tabpanel, aria-selected, roving tabindex, arrow keys w/ automatic activation), panel visibility via `data-active` (CSS `visibility`, never unmount), per-tab activity dot with sr-only text (shown only while that tab is not current). Navigation chrome only — mounts/unmounts nothing. |
| `transcribe.js` | **M2**: the per-clip TAP-TO-TRANSCRIBE controller mounted into the Media-page clip cards. `mountTranscribe(ctx)` → `{setStatus, renderClip, refresh, resumePendingJob, forgetClip, destroy}`. Owns: the affordance state machine (gated on `/api/status.transcribe`: configured && enabled && remaining.calls > 0; no-audio clip → disabled w/ reason), the consent sheet (cost + the non-negotiable "the audio, not the video, is sent to ElevenLabs" privacy line, EVERY time), and the run: extract (`engine/audio.extractAudio` → `transcripts/clip_<id>.m4a.tmp`) → streamed raw upload (`api.uploadTranscribeAudio`) → poll (`api.pollTranscribe`, lock-proof) → done (`store/transcripts.writeTranscript`) → the read-only transcript view (time-anchored `m:ss` lines, textContent-only). Extract+upload run on the SHARED op queue w/ wake lock + crash marker; the POLL phase does NOT hold the queue. LOCK-PROOF: a `{job_id, clip_id}` marker (localStorage `studio2.transcribe.job.v1`) is persisted on the 202 so a reopened app re-attaches the poll. Honest errors + FREE retry (re-extraction costs nothing); redo = same consent, overwrites. Statically imported BARE by editor.js (sibling rule). |
| `settings.js` | **v8 (Agent Model Picker, GLOBAL)**: the app-level Settings sheet + the current-model indicator. `openSettings()` opens an ARIA `dialog` (focus-trapped, Escape/backdrop close, focus restored) hosting the picker — the GET `available` models as a `role="radiogroup"` of `<button role="radio">` rows (label + hint), the current one checked, roving tabindex + arrow-key/Enter/Space activation. A selection POSTs (`api.setAgentModel`), reflects optimistically, shows the `applies_to` note ("…applies to new conversations. Your next message uses it."), broadcasts, and on 400 `invalid_model`/failure REVERTS honestly with an inline error. `mountModelIndicator(host)` → `{node, refresh, destroy}` is the compact "Assistant · <model>" label (Edit-tab header) — paints from cache, GETs to verify, re-renders on every `studio2:agent-model` broadcast + on `refresh()` (editor entry / visibility regain); stays silent on failure (the sheet owns errors). `wireSettingsButton(btn)` attaches `openSettings()` to a gear. State (last-known payload) lives on the `window.__studio2AgentModel` singleton (the ?v=/bare seam rule), broadcast via the `studio2:agent-model` window event. textContent-only. Dynamic-imported `?v=` by app.js (`loadModules`); static-imported BARE by editor.js (the indicator). |
| `music-ops.js` | **M3 (v11)**: the SHARED device-side logic behind the 6 render-tier tools — ONE source of truth so the agent's bridge executors AND the UI controls (format-ui/music-ui) call identical code and can never diverge (arch §3.3). `setOutputFormat`/`setClipFit`/`listMusicLibrary`/`addMusic`/`updateMusic`/`removeMusic` write through `store/meta` + `store/edl` + `store/music`, re-validate + clamp every param (gain −60…+6, fades 0…10, duck per arch — defense in depth, the data owner), and return the EXACT Step-4 result shapes. `addMusic` resolves a `track_ref`: a `{library_id}` is allowlist-checked against the bundled catalog, its `.m4a` LAZY-FETCHED same-origin (`/static/assets/music/<id>.m4a`, `cache:"force-cache"`) and copied into OPFS (`copyLibraryTrack`); a `{track_id}` must already be imported. `getCatalog()` caches the same-origin `catalog.json`; `currentTier(projectId, fold)` is the inventory/read_edl tier readout; `importUserTrack` is the UI-only Files upload (size/duration-capped). Errors carry a taxonomy `.toolCode` so bridge.js classifies them. Imports the stores/`engine/cut` + fetches the same-origin static catalog/beds; NO DOM. |
| `format-ui.js` | **M3 (v11)**: the Format picker + per-clip fit control (arch §3.3, §7). `mountFormatPicker(host, ctx)` — the Preview-page canvas chooser: aspect chips (16:9/9:16/1:1/4:5 with proportional glyphs) + a 1080/720 resolution toggle + "Match main clip" + a blur/black background switch, plus a live TIER readout ("Instant · keeps full quality" vs "Re-encode · a couple of minutes, standard-range") recomputed from `cut.tierCheck`. `buildClipFit(clipMeta, ctx)` — the per-clip contain/cover + blur/black control dropped into each clip card (sparse override via `store/meta.setClipFit`). Both write through the SAME `store/meta` setters the agent uses; every write fans out a `"render"` edlEvent. Engine modules dynamic-imported BARE (degrades to a disabled control on a partial deploy). textContent-only, 390px, a11y (radiogroup + aria-checked). |
| `music-ui.js` | **M3 (v11)**: the Music panel (`mountMusicPanel(host, ctx)`) on the Media page (replaces M1.1's "coming soon" card). Three parts: UPLOAD YOUR OWN (a Files picker — a user gesture; the agent can't read the filesystem — probed via the adapter's `openAudioForDecode`, imported via `music-ops.importUserTrack`), BROWSE THE LIBRARY (`list_music_library` → the bundled CC0 catalog; "Use" places under the whole video), and per-PLACEMENT controls (whole-video vs a start/length range, volume slider [-30…+6 dB UI → store clamps -60…+6], fade in/out, and a "Lower under speech" duck switch) — each edit calls `music-ops.updateMusic`/`removeMusic`. A tier note ("Music re-encodes your video…") + the CC0 courtesy credit ("Public-domain music via FreePD / Komiku."). Writes fan out `"change"` (refold) + `"render"` (repaint). textContent-only, 390px, a11y. **v13 (multi-select)**: the upload `<input>` carries `multiple`; `onFilePicked` snapshots `Array.from(fileInput.files)` (volatile handles) and runs the pick as a SEQUENTIAL awaited single-flight batch (mirrors `ingest.js` `runBatch` — `setBusy(true)` held across the whole batch, released once in `finally`; per-iteration try/catch skips one bad file and continues; per-file "Added k of N" feedback + a closing summary). PLACEMENT BY COUNT: a SINGLE pick imports+places under the whole video (the convenience path, unchanged); a MULTI pick imports every track WITHOUT auto-placing (no N overlapping beds — placement is a deliberate per-track action). A `.music__hint` iOS multi-select tip sits under the upload control. **v13 (Your sounds list — closes the multi-select UX loop)**: a new `.music__yours` section (between the library browser and the tier note) lists the project's IMPORTED user tracks via `store/music.listTracks` (uploads + any placed library copy) so a multi-imported-but-unplaced track is VISIBLE and PLACEABLE (previously it was invisible — the panel showed only the library catalog + timeline placements). Each row shows name + duration (+ a "Library" tag for a placed library copy); an UNPLACED track gets a **"Place"** action (the SAME placement `music-ops.addMusic` whole-video defaults the single-upload path uses — gain −8, fades 1 / 1.5) and a **Remove** (`store/music.deleteTrack`, bytes + trkmeta); a PLACED track shows an "On the timeline" / "Placed" state with its Remove PARKED (deleting live bytes would orphan the placement — the user removes the placement card below first; `removeTrack` re-checks placed-state defensively before deleting). The list rebuilds on every `refresh()` (placed-state derived from the just-read folded placements), so a freshly multi-imported track appears immediately and a place/remove updates it; the section hides when no track is imported. Per-row Place/Remove buttons are disabled while any op is in flight (tracked in `setBusy`). textContent-only, 390px, a11y (`role list`/`listitem`, labelled buttons, `role=status` state). Reuses the library-row rhythm — only `.music__yours*` CSS is new. |

## Key decisions

- **Offline ≠ signed out** (arch §7.5). `api.js` raises `ApiError(status 0,
  code "network")` for connectivity failures (including post-2xx body-read
  failures); `app.js` routes those to the **projects view + offline banner**
  (projects are pure OPFS), while a real 401 routes to login. Never collapse
  the two.
- **Root-scope SW (RELAY CONTRACT ADDITION).** The service worker must control
  `/` for the offline shell, and the manifest is safest at root scope on iOS.
  The relay must therefore serve, no-cache, same pattern as `GET /`:
  - `GET /sw.js` → `pwa/sw.js`
  - `GET /manifest.webmanifest` → `pwa/manifest.webmanifest`
- **Versioning lockstep (v2 lineage; currently "13" — MUSIC MULTI-SELECT + iOS
  multi-select hints: the music/sound `<input>` in `music-ui.js` gains
  `multiple`, and `onFilePicked` now SNAPSHOTS the FileList (`Array.from` — the
  picked handles are volatile) and imports the pick STRICTLY one file at a time
  — a sequential, awaited single-flight batch mirroring `ingest.js` `runBatch`:
  the `setBusy(true)` gate is HELD across the whole batch and released once in a
  `finally`, so there is never a second import in flight; a per-iteration
  try/catch SKIPS one bad/oversized/non-audio file (with a "Skipped …" toast)
  and the rest CONTINUE; per-file "Added k of N — name" feedback during the
  batch, a closing summary at the end. **Placement product decision (plan §1):**
  a SINGLE-file pick keeps the import+place-under-whole-video convenience; a
  MULTI pick IMPORTS every track (they appear in the Music panel ready to place)
  but does NOT auto-place all N overlapping under the whole video (that would
  stack N beds in the mix) — the user places them deliberately FROM THE NEW
  "Your sounds" LIST (`.music__yours`, same "13" drop): it enumerates the
  project's imported tracks (`store/music.listTracks`) with a per-row Place
  (`music-ops.addMusic` whole-video defaults) + Remove (`store/music.deleteTrack`,
  parked while the track is on the timeline), so a multi-imported track is now
  VISIBLE and PLACEABLE instead of invisible. The 3 GiB / 6 h
  per-file caps (the "12" change) still apply per file. A short on-screen iOS
  multi-select tip ("…in your Photo Library tap multiple, or in Files tap
  'Select' first.") now renders on BOTH the music picker (`music-ui.js`
  `.music__hint`) and the video picker (`ingest.js` `.ingest__hint`, shown with
  the "Add video" button) — textContent-only, 390px-friendly. The VIDEO picker's
  MECHANICS are unchanged (its input has been `multiple` since "9"); only the
  hint is added. No precache list change — `music-ui.js` + `ingest.js` are
  already precached, so their changed bytes (plus `styles.css` / index) ride the
  cache-name bump. PRE-DEPLOY POLISH (rides the SAME undeployed "13", no lockstep
  bump): both hint classes moved `var(--ink-faint)` → `var(--ink-dim)` for WCAG
  AA — `#a2b0bd` on `--surface` (`#10141a`) measures 8.3:1 (was 4.1:1, below the
  4.5:1 floor); these hints are the only on-screen multi-select instruction, so
  they must be legible. Layout/position/size unchanged. The placements empty-state
  copy in `music-ui.js` was also refreshed for the new layout — now reads "No
  music on your timeline yet. Place a sound from "Your sounds" or the library
  above, or upload your own." (the old "No music yet…" predated the "Your sounds"
  section; still textContent-only via `el()`); "12" — MUSIC UPLOAD CAP RAISE:
  `music-ops.js`'s `UPLOAD_MAX_BYTES` raised to 3 GiB (user-requested large music
  cap) and `UPLOAD_MAX_DURATION_S` raised 15 min → 6 hours (so a multi-GB/long
  audio file isn't blocked by duration before the size cap matters); the size
  error now renders a friendly unit — "max 3 GB" at ≥1024 MiB, else "max N MB"
  (via the `formatByteCap` helper). Music bytes go straight to OPFS on-device and
  never transit the relay, so there is NO server-side cap to raise in tandem; the
  uncapped VIDEO ingest path is untouched. `music-ops.js` is precached BARE, so
  only the cache-name bump ships the changed bytes to installed phones on reload;
  "11" — M3 RENDER TIER (format +
  mixed-orientation combine + music): NEW modules join the precache under their
  BARE URLs — `format-ui.js` / `music-ui.js` (static-imported bare by editor.js),
  `music-ops.js` (the shared ops — bare from bridge.js + both UI modules),
  `store/music.js`, `engine/canvas.js`, and the render spine `engine/render.js` +
  `webcodecs.js` + `compositor.js` + `audiomix.js` + `duck.js` (dynamic-imported
  bare by editor.js / each other), plus `assets/music/catalog.json` (the bundled
  CC0 library index). The 8 `assets/music/<id>.m4a` beds are DELIBERATELY NOT
  precached (~29 MB) — they LAZY-LOAD on demand (`music-ops.addMusic` fetches a
  bed only when a library track is placed; `cache:"force-cache"` keeps a used bed
  in the HTTP cache). bridge.js (6 M3 executors + inventory/edl extension) /
  export.js (tier auto-select + render export) / player.js (§8b preview overlay) /
  editor.js (format/music/fit mounts) / store/meta.js + store/edl.js (the M3 data
  model) / styles.css / index changed bytes ride the cache-name bump; "10" AGENT
  VISION (view_frames):
  NEW `engine/frames.js` (still-frame decode → downscaled, rotation-correct
  JPEG base64) joins the precache under its BARE URL (bridge.js imports it bare);
  bridge.js (the `view_frames` executor + the result cap raised 500 KB → 2 MiB,
  LOCKSTEP with the relay's `routers/bridge.py`) + capability.js (videoDecoder
  note now load-bearing) changed bytes ride the cache-name bump; "9" MULTI-SELECT
  video ingest:
  the `<input>` gains `multiple`, ingest.js drives the picked files STRICTLY one
  at a time with batch progress; NO precache list change, ingest/index/styles
  changed bytes ride the cache-name bump; "8" the GLOBAL Agent Model Picker:
  NEW `settings.js` in the precache under BOTH the `?v=` URL
  (dynamic-imported by app.js) AND bare (static-imported by editor.js for the
  indicator), api/editor/index/styles changed bytes ride the cache-name bump;
  "7" M2 transcription: NEW `transcribe.js` + `engine/audio.js` +
  `store/transcripts.js` in the precache; "6" the M1.2 QA P2 fixes; "5" M1.1
  phone navigation, NEW `tabs.js`; "4" the reviewer-fix pass; "3" the M1 P3
  cosmetic fixes; "2" the Step-5 editor).** A frontend bump touches FOUR
  places: `index.html` (`?v=` ×2),
  `app.js` (`ASSET_VERSION`), `sw.js` (`ASSET_VERSION` — the cache name
  derives from it; activate purges old caches, so bumps can never strand a
  stale shell), and `setup.html` (`?v=` on styles.css). NOTE: because the SW
  shell is CACHE-FIRST, **any** byte change to a precached file needs this
  bump to reach installed clients — even when the precache list itself is
  unchanged.
- **Import discipline.** `util.js` is imported bare everywhere (v1 lesson).
  `app.js` dynamic-imports feature modules with `?v=`; feature modules import
  siblings bare. `api.js`/`capability.js`/`store/*` therefore load under two
  URLs (one `?v=`, one bare) — the v1-documented, accepted wart for stateless
  modules. Anything with **state** must use a window singleton
  (`__studio2Diag`, `__studio2Caps`) or explicit DI (caps is passed into
  `initProjects`). Never rely on module-level mutable state crossing that seam,
  and never use `instanceof` across it (`api.isNetworkError()` exists for
  that).
- **XSS posture: textContent-only.** `util.el()` has **no innerHTML branch**
  (removed from the v1 helper on purpose). Every dynamic string — project
  names, usernames, quota text, TLS URLs — lands via `textContent`.
- **Crash visibility.** `store/opfs.js` owns the localStorage op-marker;
  `app.js` boot claims it (`takeOpMarker`) and shows a "something was
  interrupted" notice + diag event, then sweeps `*.tmp` orphans.

## Step 4/5 integration notes

- **Step 4 (`engine/`, `store/edl.js`, `ingest.js`):** `store/opfs.js` already
  provides `tempWriter()` (temp-name + verify + rename commit, banked #3),
  `moveEntry()` (move() with streamed-copy fallback), `quotaPreflight()`,
  `setOpMarker`/`clearOpMarker`, and `newClipId()`. `createProject()` does
  **not** write the EDL `init` op — `edl.js` writes it lazily on first open
  (one-writer-per-file). Clip metadata goes through `store/meta.js`
  `writeClipMeta()`.
- **Step 5 (`editor.js` & co.):** mount into `#editor-mount` (replace
  `#editor-placeholder`), wire `initEditor` in `app.js` `enterEditor()`, add
  the new module URLs to `app.js` `loadModules()` **and** `sw.js` PRECACHE,
  then bump the version (all three places). `util.deviceId()` is the
  `dev_<hex16>` source for the bridge. `api.streamPost` and `bridge.js`
  `sseRequest` (the bridge/attach stream reader — see "Step 5 delivered")
  parse `id:` (the seq/replay cursor).
- **Icon sprite:** add Step-5 symbols (send/stop/etc.) to `assets/icons.svg`
  on the existing 24×24 / 1.8-stroke grid.

## Step 4 delivered (engine + EDL + ingest) — what Step 5 wires up

- **Ingest API (`ingest.js`):**
  ```js
  const ingest = mountIngest(containerEl, {
    project,                  // {id, name} — the open project
    caps,                     // capability matrix (gates the wake lock)
    onClipAdded({ clip_id, clipmeta, timeline_duration_s, segments }) {…},
  });
  ingest.openPicker();        // programmatic open (must be in a user gesture)
  ingest.isBusy();            // true while a copy/probe/card is live —
                              //   editor must not unmount mid-ingest
  ingest.destroy();
  ```
  `clipmeta.file_name` (`clip_<hex8>.<ext>`) is how player/export resolve the
  OPFS file under `clips/`. `clipmeta.degraded = {flag, reasons[]}` rides
  into `get_inventory` (reasons: `no_audio`, `picker_transcode_signature`,
  advisory `advisory_720p_h264` — the advisory never sets the flag).
- **EDL API (`store/edl.js`):** `readState` / `appendApplyCuts` /
  `appendUndo` / `appendAddClip` / `appendRemoveClip` / `findCommand` /
  `invalidate` — see `store/DOCUMENT.md`. The `apply_cuts` executor flow is:
  `probe.openProbe(clipFile)` → `snapRemovalRange(range, snap)` per range
  (§5.3; `null` = keep-biased collapse, report honestly, don't journal it) →
  `edl.appendApplyCuts` (pass the bridge `command_id` — replays dedupe to the
  original outcome). Engine errors carry `.code`
  (`engine_error`/`storage_error`); classify platform errors with
  `writers.errorCode(err)` — never `instanceof`.
- **Export flow:** `writers.tempThenRename(exportsDir, "export-….<ext>")` →
  `cut.losslessCut({segments, sources, target, onProgress})` →
  `verify.verifyOutput({handle: target.handle, expectedSeconds, expectAudio,
  writeStats: target.stats})` → verdict `ok` → `target.commit()`; anything
  else → `target.abandon()` (and the corrupt-verdict UX of arch §7.3 step 5).
  `losslessCut` REFUSES a bare WritableStream — only the `tempThenRename`
  result is accepted (banked #1 by construction).
- **sw.js PRECACHE + `app.js` loadModules() additions** (Step 5 does both,
  then bumps the version triple): `engine/mediabunny.js`, `engine/writers.js`,
  `engine/probe.js`, `engine/cut.js`, `engine/verify.js`, `store/edl.js`,
  `ingest.js`. Engine/store modules import siblings bare, so the SW cache
  covers them under their bare URLs.
- **CSS classes Step 5 must add to `styles.css`** (Step 4 does not touch the
  shell stylesheet; everything else reuses `.btn*`, `.quota-bar*`,
  `.persist-note`, `.mono`, `.icon`):
  ```css
  /* ingest (Step 4) — see pwa/ingest.js */
  .ingest { display: flex; flex-direction: column; gap: var(--s3); padding: var(--s4); background: var(--surface); border: 1px solid var(--line-soft); border-radius: var(--r-lg); }
  .ingest-progress { display: flex; flex-direction: column; gap: var(--s2); }
  .ingest-progress__row { display: flex; justify-content: space-between; gap: var(--s3); font-family: var(--font-mono); font-size: 0.8rem; color: var(--ink-dim); }
  .ingest-card { display: flex; flex-direction: column; gap: var(--s3); padding: var(--s4); background: var(--surface-2); border: 1px solid rgba(227, 179, 65, 0.45); border-radius: var(--r-lg); }
  .ingest-card--error { border-color: rgba(240, 101, 90, 0.45); }
  .ingest-card__title { display: flex; align-items: center; gap: var(--s2); font-family: var(--font-display); font-weight: 600; }
  .ingest-card__title .icon { color: var(--warn); }
  .ingest-card--error .ingest-card__title .icon { color: var(--bad); }
  .ingest-card__body { margin: 0; color: var(--ink-dim); font-size: 0.92rem; }
  .ingest-card__actions { display: flex; flex-wrap: wrap; gap: var(--s2); }
  ```
  (No new icons needed — ingest uses the existing `i-plus` / `i-alert`.)

## Step 5 delivered (bridge client + chat + player + export + editor shell)

- **Bridge transport — documented deviation.** The arch names EventSource,
  but the relay ends a REPLACED stream with a `: superseded` comment — and
  the EventSource API cannot observe comments, so a superseded tab would
  silently auto-reconnect and ping-pong the two streams forever. `bridge.js`
  therefore reads the stream with fetch + ReadableStream (`sseRequest`, the
  api.streamPost framing parser plus comments + manual `Last-Event-ID`):
  superseded → stop + "another window took over"; returning to the tab
  (visibility) reconnects, making the visible window newest (arch §2.3).
  Heartbeat comments feed a 65 s liveness watchdog (3 missed `: hb`). Chat's
  `GET /api/chat/attach` rides the same helper (a GET stream — streamPost
  only POSTs).
- **Single-flight queue (banked #6):** ONE `createOpQueue()` per editor
  session, shared by every bridge executor AND export. Known, accepted
  consequence (arch-mandated "all executors"): an open `ask_user` card parks
  the queue — harmless for agent work (the SDK awaits tools sequentially),
  and an export tapped mid-question simply runs after the answer. Back-nav
  is blocked only while ingest/export actually runs (`editorCtl.busy()`),
  never for a parked question.
- **Result POST retry:** 6 attempts total (initial + 1/2/4/8/15 s).
  Abort on 409 `no_pending_command` (benign — relay resolved/timed out) and
  any other 4xx (a rejected body never fixes itself); retry network/5xx.
- **Dedupe map:** `command_id` → executing | done(payload) | expired, ≤50
  insertion-ordered (LRU). Replay of `done` re-POSTs the cached payload;
  `executing` is ignored; `expired` (card lapsed / cancelled) stays silent.
- **apply_cuts realized semantics:** snapping happens in the editor adapter
  via `probe.openProbe` → `snapRemovalRange` per range; a keep-biased
  collapse (`null`) is reported as a ZERO-WIDTH `snapped` range in
  `realized` and is NOT journaled (the journal schema requires start < end).
- **chat.json (sole writer: chat.js):** `{schema:1, messages:[{role, content,
  ts, turn_id?, tool_calls?}]}` via `opfs.writeJSONAtomic`, capped at 500
  messages, writes serialized on a promise chain. The user message persists
  at `turn_start` (durable even if the turn dies); the assistant message at
  `turn_end` (its full text rides that event).
- **Attach semantics (the phone-lock fix, arch §2.2):** chat tracks the
  PER-TURN `id:` seq (each turn restarts at 1). Stream death after
  `turn_start` ⇒ dangling ⇒ attach(`after_seq`) ~1.5 s later and on every
  visibility regain. Editor (re-)entry attaches from 0 ONLY when the
  per-project localStorage pending-turn marker (`studio2.chat.pending.<id>`,
  set at send, cleared at turn_end / 404) says a turn may have been missed —
  the common entry path stays free of by-contract 404 console noise.
  Already-transcribed turns are consumed silently (dedupe by `turn_id`); 404
  `no_active_turn` = nothing missed; a stale cursor against a DIFFERENT live
  turn is detected and restarted from 0. 409 on send ⇒ follow via attach.
- **ask_user:** the bridge executor calls `chat.askUser({questions, command,
  signal})` → option card (radiogroup/checkbox semantics, roving tabindex,
  implicit "Other…" free text) → resolves `{answers:[{header, selected[],
  other_text?}]}` (the agent/DOCUMENT.md contract) → bridge POSTs it as the
  command result. `null` resolution (turn ended / relay-deadline signal /
  boot change) means NO result POST — the relay's Future is already gone.
- **server_boot_id change:** bridge detects it on `hello` → chat expires any
  open card, finalizes a dangling turn with "the studio brain restarted —
  say that again", and pending-turn UI clears (arch §13).
- **Player skip:** fold → `[{clip_id, start_s, end_s, tl_start, tl_end}]`;
  `timeupdate` (~4 Hz) + `requestVideoFrameCallback` seek past removed
  regions (worst case ~100–250 ms flash — accepted, arch §9). Scrubber and
  timecodes live in timeline time. One blob URL alive at a time, revoked on
  swap/close. Multi-clip timelines swap sources per segment.
- **EDL change fan-out:** editor.js owns ONE `EventTarget` (`edlEvents`);
  apply_cuts/undo executors and ingest's `onClipAdded` fire `"change"`;
  player refolds instantly (preview correct before the agent replies, §7.2)
  and the clip strip re-renders. Step 4's fold cache makes refolds cheap.
- **Engine adapter:** editor.js dynamic-imports the Step-4 modules BARE
  (single instance each) and exposes one adapter object; a load failure
  degrades to an engineless editor (chat works, executors answer
  `engine_error`, ingest/export explain themselves) instead of a dead view.

## M1.1 delivered (phone navigation: Media / Edit / Preview pages, v "5")

Born from live iPhone feedback during the M1 acceptance run ("I can barely
see the conversation"). Plan: `PM/plan-2026-06-12-m1-1-phone-nav.md`. The
single crammed editor screen became three pages behind a bottom tab bar;
nothing was re-architected — same modules, new placement.

- **Pages (editor.js) — hide, never destroy.** `.editor__pages` grid-stacks
  the three `role=tabpanel` sections in ONE cell; the inactive ones get
  `visibility:hidden` + `pointer-events:none` via `data-active` (NOT
  `display:none` — visibility keeps layout AND scroll state alive, removes
  the page from focus order and the a11y tree, and lets chat keep
  scroll-pinning correctly while its page is hidden). Consequences, by
  construction: the bridge never reconnects on a tab switch, a streaming
  turn keeps rendering, an open ask_user card stays answerable, the player
  keeps its single blob URL + position (player.js untouched), an ingest
  copy keeps streaming with live progress (ingest.js untouched). The
  app.js leave-guard still fires only on PROJECT exit (back button) —
  tab switches never consult it.
- **Tab bar (tabs.js, NEW).** WAI-ARIA tabs pattern with automatic
  activation on ArrowLeft/Right/Home/End (switching is instant and
  lossless, so focus-follows-activation is the right variant); 52px-tall
  buttons (44px floor cleared); active state = timecode-teal ink + a 2px
  notch on the top hairline; `padding-bottom: env(safe-area-inset-bottom)`
  (home-indicator clearance — the composer dropped its own inset since the
  bar now carries it). Statically imported BARE by editor.js (sibling rule),
  so it lives in the sw.js PRECACHE bare and NOT in app.js `loadModules()`.
- **Activity dot.** chat.js reports `streaming || open ask_user card`
  through `ctx.onChatActivity` (single funnel: `applyComposerState`); tabs.js
  shows a pulsing teal dot on Edit only while the user is on ANOTHER tab
  (visiting acknowledges it), with sr-only text for screen readers. An open
  question counts as activity deliberately — it's exactly when the editor is
  waiting on the user.
- **THE keyboard fix (the user's actual complaint).** iOS keeps the layout
  viewport fixed under the keyboard, so a bottom composer vanishes while
  typing. editor.js watches `visualViewport` resize+scroll and publishes
  `--kb = innerHeight − vv.height − vv.offsetTop` (clamped ≥0) on the editor
  root + `data-kb` open/closed (threshold 50px); CSS pads the editor's
  bottom by `--kb` (composer rides above the keyboard) and hides the tab
  bar while open (the OS covers it anyway; the rows go to the conversation).
  `window.scrollTo(0,0)` re-pins when iOS pushes the layout viewport
  (`vv.offsetTop > 0` rides the formula either way). chat.js owns the other
  half: a pinned-to-bottom log (48px slack) that respects the user
  scrolling up, force-re-pins on own send / transcript render / question
  card / composer focus, and holds the pin through resizes via a
  ResizeObserver. Fallback without visualViewport: `--kb` stays 0 and the
  plain flex layout bottom-pins the composer — correct on engines that
  resize the layout viewport, which the new
  `interactive-widget=resizes-content` viewport key requests on Chromium —
  with one caveat: on those engines the tab bar stays visible while typing,
  so the keyboard-open scroll pin can land one bar-height short and unpin
  (see Known accepted behaviors; the iOS visualViewport path is unaffected).
- **Tab memory + default (judgment call, documented).** Last-active tab per
  project in localStorage `studio2.editor.tab.<project_id>`; first visit
  defaults to **Media when the project has zero clips** (the only useful
  action is adding footage) **else Edit** (the conversation is the
  product). Preview is never a default — it's where you go on purpose.
- **"Sounds & music" — now LIVE (M3, v11).** The M1.1 coming-soon card is
  replaced by the real Music panel on Media (`music-ui.js`): upload your own
  from Files + browse the bundled CC0 library + per-placement volume/fade/duck.
  Music mixes in during the M3 render (re-encode) tier, so ANY placement forces
  the render tier — the panel says so plainly (the same honesty the agent
  carries). An engineless-degraded editor falls back to a small "unavailable"
  note (it needs the engine adapter + store surface).
- **Known accepted behaviors:** a playing preview keeps playing (audibly)
  when the user switches tabs — position is the contract, pause-on-switch
  is a one-line follow-up if the USER wants it; toasts lift above the tab
  bar via a `:has()` rule, scoped since v6 to when the bar is actually
  visible — `:not(:has(.editor[data-kb="open"]))` drops the lift while the
  keyboard hides the bar (engines without `:has()` get the old overlap,
  cosmetic only); desktop gets the same three tabs (plan: accepted); on
  layout-viewport-resizing engines (Android Chrome — not iOS) the tab bar
  stays visible while typing, so the keyboard-open scroll pin can land one
  tab-bar height (53px) short and unpin — the iOS path is unaffected.

## M1.2 delivered (QA P2 fixes, v "6")

Three scoped fixes from the M1.1 QA pass; no behavior re-architected.

- **P2-1 (editor.js):** init-failure listener leak closed. The visualViewport
  watcher used to attach mid-init; a throw from a later mount step
  (initChat / initPlayer / initExport / buildExecutors / initBridge) bubbled
  to app.js, which routes away without a destroy handle — the vv listeners,
  chat's document `visibilitychange` listener, and a connected bridge leaked
  until reload. Now the whole mount sequence runs guarded; the catch runs
  `teardown()` (the single unwind path `destroy()` also uses) and rethrows,
  so app.js's toast-and-route-to-projects behavior is unchanged and
  re-entering the editor afterwards is clean.
- **P2-2 (chat.js):** the Edit-tab activity dot now includes the DANGLING
  state: `streaming || dangling || pendingCard`. Previously the dot went
  dark the moment the SSE stream died mid-turn (phone lock) even though the
  relay kept working; it now stays lit through the gap and clears when
  attach delivers `turn_end` / 404 `no_active_turn` (both stream readers
  guarantee `onClose` after `onError`, so it cannot stick).
- **P2-5 (styles.css):** the toast tab-bar lift no longer applies while
  `data-kb="open"` has hidden the bar (see Known accepted behaviors above).
- Deferred by assignment: P2-3 (localStorage key sweep on project delete —
  next projects.js touch), P2-4 (tabpanel/tablist DOM order, informational).

## M2 delivered (transcription — cut by what's said, v "7")

Plan: `PM/plan-2026-06-12-m2-transcription.md`; contract:
`PM/arch-2026-06-12-m2-transcription.md`. M2 T4 is the device UI + bridge
executors + wiring (T1 relay + T2 device data layer + T3 agent surface are
separate lanes). Nothing was re-architected — the M1 core loop is the floor.

- **THE upload exception (arch §3.1, §8.1).** `api.uploadTranscribeAudio`
  sends the extracted `.m4a` as a **raw `audio/mp4` body** (a Blob), NOT
  multipart — preserving the relay's reviewer-verified no-parsing-surface
  property. No XHR / no granular upload progress (a fetch Blob body gives no
  upload events): `transcribe.js` shows an honest indeterminate "Sending…"
  state. `pollTranscribe`/`cancelTranscribe`/`transcribeStatus` round it out
  (cookie auth + the existing error-envelope normalization).

- **The four run invariants (`transcribe.js`).**
  1. The `.m4a` is TRANSIENT: extraction writes through
     `writers.tempThenRename(transcriptsDir, "clip_<id>.m4a")`; the flow never
     commits — it reads the committed `.tmp` back as a File, uploads that, and
     ALWAYS `target.abandon()`s (success or failure). A crash leaves a
     `transcripts/*.tmp` orphan the boot sweep removes.
  2. `duration_s` is the EXTRACTED-file duration (`result.durationS`), NOT
     clipmeta's video duration — they differ by the AAC priming offset
     (audio.js re-bases to 0). Verified live: a 12.00 s video declared
     `duration_s=12.02`.
  3. Extract + upload run on the SHARED single-flight op queue (banked #6)
     with the wake lock + crash marker held; the POLL phase does NOT hold the
     queue — once the 202 lands the heavy device work is released and the
     relay job runs on its own.
  4. LOCK-PROOF poll: a `{project_id, clip_id, job_id, clip_name}` marker is
     persisted to localStorage (`studio2.transcribe.job.v1`) the instant the
     202 lands; `editor.js` calls `transcribeCtl.resumePendingJob()` after the
     strip renders, so a reopened app re-attaches the poll and completes (the
     phone-lock-mid-transcribe / reload case). Verified live: reload mid-poll →
     reopen → transcript landed; marker cleared.

- **Affordance states (arch §7.4), all reachable + verified live:**
  has-audio + gate-ok + no-transcript → **Transcribe** button + a cost hint;
  no-audio clip → disabled "This copy has no sound"; transcript present →
  **Transcript · m:ss · lang** badge opening the read-only view (overflow:
  Redo = same consent, overwrites); relay not configured/disabled/0-remaining
  → disabled with the honest reason (gated on `/api/status.transcribe`); job
  running → inline stage progress on that clip only.

- **Consent sheet, EVERY time (arch §7.1.2, PM resolution #3).** An ARIA
  `dialog` (focus-trapped, Escape-closes) with the cost estimate AND the
  non-negotiable privacy line — "The clip's audio — not the video — is sent to
  ElevenLabs for transcription. Your footage stays on this device." This is
  the architecture's one byte-leaves-device exception; the user consents per
  clip.

- **Honest errors + FREE retry (arch §10.8).** An EL-side error (`provider_*`
  / `transcribe_timeout` / `cancelled`) or a 404 (relay restarted — "the
  studio brain restarted, start again") shows a stage-specific `role="alert"`
  message with **Try again** (re-extracts from scratch, costs nothing) +
  Dismiss. A mid-upload failure incurs no cost (the 202 never landed).

- **Bridge executors (arch §4, the T3↔T4 contract; verified live against a
  seeded transcript):**
  - `read_transcript {clip_id?, from_s?, to_s?, detail?}` →
    - no `clip_id`: `{clips:[{clip_id, name, has_transcript, language, words,
      duration_s}], hint}`
    - `detail:"text"` (default): `{clip_id, language, clip_duration_s,
      window:{from_s,to_s}, lines:[{s,e,text}], truncated, word_count_total,
      next_from_s?}` — lines break on a ≥0.8 s gap, sentence-final
      punctuation + a ≥0.35 s gap, or 140 chars; the page hard-caps at 14,000
      chars with `next_from_s` as the cursor.
    - `detail:"words"`: window REQUIRED and ≤120 s (else `engine_error`) →
      `{clip_id, window, words:[{w,s,e,c?}]}`.
    - no transcript on the clip → `{has_transcript:false, message:…}`.
  - `find_in_transcript {query, clip_id?, max_results?}` → `{total_matches,
    searched_clips:[…], matches:[{clip_id, start_s, end_s, text (±8 words of
    context, [MATCH] markers), words:[{w,s,e}], gap_before_s, gap_after_s}]}`
    — normalized (casefold + strip surrounding punctuation) contiguous
    word-sequence match; no transcripts anywhere → `{has_transcript:false,
    message:…}`.
  - `get_inventory` clips gain `transcript: null | {language, words,
    duration_s}` and top-level `has_transcript` is now honest.
  - The relay-side M1 `read_transcript` stub is being removed in T3 — transcript
    truth lives device-side now; `device_offline` is the honest answer when the
    phone is gone.

- **Transcript view (arch §7.5, PM resolution #5).** A read-only sheet on the
  Media page: `m:ss`-anchored lines, textContent-only (XSS posture intact),
  header carries duration · language · confidence% · word count. A "tap a line
  to seek Preview there" cross-link is the noted P3 polish (player.js has no
  by-time public seek today — deliberately not wired).

- **ingest.js (small, M2).** The degraded re-pick (Pick from Files) path
  `transcripts.deleteTranscript`s the discarded clip's id; `destroy()` resets
  the view to idle before removing the root (deferred P3-B stale-progress fix).

- **Verification (desktop harness, outside repo: Chromium + a mock relay
  implementing the T1 endpoints + a fake `done` transcript + the
  `/api/status` gate; ffmpeg-built H.264+AAC clip).** Confirmed end-to-end:
  affordance → consent w/ cost → real audio extraction (`.m4a`, lossless AAC
  packet copy, `durationS` ≠ video duration) → raw streamed upload → poll →
  `writeTranscript` → badge → transcript view; lock-proof reload-mid-poll
  resume; no-audio disabled; EL-error → honest message + free retry → success;
  gate hidden when not configured; the bridge executors against arch §4 shapes;
  the M1.1 three-tab regression; **zero external origins, zero console errors**
  on the clean run.

## v8 delivered (Agent Model Picker — GLOBAL, v "8")

Plan: `PM/plan-2026-06-13-agent-model-picker.md` (USER request "choose which
model is used"; USER decision: GLOBAL — one model setting for the whole app,
shared by both users). The relay endpoint + allowlist are a separate
(pm-backend) lane; this is the PWA side, built against the plan's §6 API
contract. Nothing was re-architected.

- **Placement decision (mine, documented).** A NEW `settings.js` hosts an
  app-level **Settings sheet**, opened by a gear (`i-settings`, NEW sprite
  symbol) added to TWO app-level surfaces: the **projects-list header** (the
  natural home — the model is global, not per-project) and the **editor
  topbar** (so it's reachable while editing). Both gears call the SAME
  `openSettings()` — one global sheet, no per-project control. I folded the
  picker into a new dedicated module rather than an existing one because it's a
  distinct app-level concern (settings ≠ projects ≠ editor) and it owns both
  the sheet AND the indicator; co-locating them keeps the broadcast/cache glue
  in one file.
- **The picker (settings.js `openSettings()`).** The shared `.sheet`/
  `.sheet__card` ARIA `dialog` (focus-trapped, Escape + backdrop close, focus
  restored to the opener — same proven lifecycle as the transcribe sheets). The
  GET `available` models render as a `role="radiogroup"` of `<button
  role="radio">` rows (label + hint), the GET `current` one checked. WAI-ARIA
  radiogroup keyboard model: roving tabindex (only the checked row tabbable),
  Arrow/Home/End move focus, Space/Enter commit. A "Default" row is ALWAYS
  present first (restores CLI inheritance) even if the server omits it.
  Selecting a row POSTs, reflects optimistically, shows the `applies_to` note,
  toasts, and broadcasts; a **400 `invalid_model`** / failure REVERTS to the
  prior selection with an honest inline `role="alert"` message (offline copy
  vs. invalid-model copy vs. generic). A failed initial GET shows a Retry.
- **The current-model indicator (settings.js `mountModelIndicator`).** A
  compact, always-visible "Assistant · &lt;model&gt;" pill in the **Edit-tab
  header** (`editor.js` `.edit-header` → `.editor__model-slot`) so the user can
  SEE the active model even though the SETTING is global. Fed by GET on editor
  entry; re-renders on every `studio2:agent-model` broadcast (a change in the
  sheet updates it live, no reload) and on `refresh()` — wired to editor
  visibility-regain so a change on the OTHER user's device shows up. Hidden
  until it has data; SILENT on GET failure (the sheet owns errors). The
  accessible name is the full "Assistant model: &lt;model&gt;".
- **Coupling = a window event + window cache, not imports** (the ?v=/bare seam
  rule). A successful GET/POST broadcasts `studio2:agent-model` and caches the
  payload on `window.__studio2AgentModel`; a freshly-mounted indicator paints
  from cache instantly, then its own GET verifies. settings.js is therefore
  safe to load under both URLs (it holds no module-scope mutable state).
- **Wiring.** `app.js` `loadModules()` dynamic-imports `settings.js` `?v=` and
  exposes `openSettings`; the projects-header gear is wired in `showProjects()`
  (inside the one-time `projectsCtl` guard, beside logout) and the editor
  topbar gear in `initEditorChrome()`. `editor.js` static-imports
  `mountModelIndicator` BARE (sibling rule), mounts it into the Edit header,
  and tears it + its visibility listener down in `teardown()`. sw.js PRECACHE
  gains `/static/settings.js` under BOTH `?v=8` and bare.
- **Verification (desktop harness, outside repo: Chromium 390px + a MOCK relay
  implementing GET/POST `/api/agent/model` to the §6 contract + `/api/me` +
  `/api/status`).** Confirmed: gear on projects header AND editor topbar →
  same sheet; picker lists the mocked models with the current one checked;
  pick a different one → POSTs, the current-model indicator updates live, the
  applies-to note shows, toast fires; **400 path** → honest error + selection
  reverts to current; the indicator reflects GET on load AND on editor entry
  (persisted "Sonnet" painted on a fresh open) AND after change (broadcast);
  Escape closes + restores focus to the gear; keyboard radiogroup (Arrow nav +
  Enter commit) works; the M1.1 three-tab + hide-never-destroy regression
  intact; lockstep "8" + cache name `studio2-shell-v8` + settings.js precached
  (both URLs); **zero console errors, zero external origins** on the clean run.

## v9 delivered (multi-select video ingest, shipped under lockstep "10")

Plan: `PM/plan-2026-06-13-multiselect-ingest.md` (USER field request: "when
adding videos I can select more than just one video"). A small, scoped change
to the EXISTING smart-ingest flow — nothing re-architected, the M0 single-flight
+ memory discipline is the floor and stays exactly that.

- **The picker (`ingest.js`).** The `<input type="file" accept="video/*">` gains
  `multiple`. On `change`, the picked `files` are snapshotted (`Array.from` —
  picked File handles are volatile and the driver reads them seconds apart;
  only the references are copied, bytes are still read lazily per file via
  `file.stream()`) and handed to a sequential batch driver.
- **STRICTLY one at a time (the load-bearing guarantee).** `runBatch(files)`
  loops the queue with `await runIngest(files[i])` — file k+1 NEVER starts until
  file k's promise resolves, and that promise resolves only when the file is
  fully settled: copy → probe → degradation-card resolution → add OR skip. So
  there is exactly ONE streamed OPFS copy / ONE probe in flight at any instant
  (no two extractions/copies concurrent — the device memory discipline). The run
  is bracketed by `ingest.batch.start` / `ingest.batch.done` diag events (and
  each clip still logs `ingest.done` with `batch_index`/`batch_total`), which is
  the never-concurrent evidence in the diag stream. `runIngest` was refactored
  to return a Promise that NEVER rejects (a failure shows the honest card and
  resolves) so one bad file can't abort the queue.
- **N=1 is the batch-of-one case.** A single pick runs through the identical
  `runBatch` → `runIngest` path; `batchTotal === 1` suppresses the position
  prefix and restores the single-pick card wording ("Pick from Files",
  "Try again"). Net behavior is byte-for-byte the historical single-pick flow.
- **Per-file progress with batch position.** The progress label carries
  `"Adding 2 of 5 — <name> — Copying into Studio…"` (the position prefix is
  dropped for N=1); the byte bar underneath tracks the file currently copying.
  A single `positionPrefix()` + `batchName` feed every phase (copy / probe /
  finishing / guidance) so the context is consistent.
- **Degraded-mid-batch handling (the decision, documented).** The degraded
  guidance card still appears PER FILE that needs it, and resolving it never
  aborts the rest of the queue. The PRIMARY action is mode-aware:
  - **Single pick → "Pick from Files"** (reopen the picker for the original) —
    UNCHANGED from before.
  - **Batch → "Skip this one"** (discard this degraded copy, the queue
    continues). Re-opening the picker mid-batch would interleave a fresh
    multi-pick with the remaining queue and break single-flight, so the in-batch
    choice is keep-as-is or drop-this-one; the user re-adds the original from a
    fresh pick afterward.
  - **"Use it anyway"** is identical in both modes (kept, `degraded:true` rides
    into clipmeta → `get_inventory`). In a batch the destructive default flips:
    "Use it anyway" becomes the primary-styled button (the non-destructive keep)
    and "Skip this one" the secondary.
  Either resolution `settle()`s the file's run; the driver advances. The same
  applies to the error / quota / unplayable cards — in a batch their button
  reads "Continue" and settles the run (the unplayable copy says "It was
  skipped"); the next queued file takes over the view.
- **Wake lock across the batch; crash marker per file.** The wake lock is
  acquired ONCE at batch start and released ONCE when the queue drains (the
  screen never sleeps between files); `wake.acquire()` is now idempotent so the
  per-file `acquire()` calls inside `runIngest` are harmless no-ops. The crash
  marker stays per-file — set at that file's copy start, cleared after its
  journal append — so a kill mid-batch sweeps the single in-flight `.tmp` and
  leaves every already-added clip intact.
- **`onClipAdded` per success.** Fires once per successfully-added file, exactly
  as before; editor.js's handler (`notifyEdlChange` + `refreshStrip` + toast)
  already re-renders the strip per call, so N clips land correctly with no
  editor.js change.
- **Public surface preserved (additive only).** `mountIngest(container,
  {project, caps, onClipAdded})` → `{openPicker, isBusy, destroy}` is unchanged;
  `isBusy()` now reports the whole batch (true until the queue drains), which is
  what editor.js's `busy()` leave-guard already wanted (back-nav blocked while a
  batch copies).
- **No editor.js / minimal CSS.** editor.js untouched (the clip strip already
  re-renders per `onClipAdded`). styles.css gains only two `.ingest-progress__row`
  rules so the longer batch label ellipsizes and the byte readout keeps its line
  at 390px — within the existing design system, no new tokens.
- **Verification (desktop harness, outside repo: Chromium 390px + ffmpeg-built
  H.264+AAC clips incl. one `-an` no-audio and one named
  `temp_video_for_share.mp4`; instrumented diag to assert never-concurrent).**
  Confirmed: pick 3–5 clips at once → they ingest ONE AT A TIME (the
  `ingest.batch.start`/per-file copy/`ingest.done`/`ingest.batch.done` diag
  ordering proves no overlap; only one progress bar ever animates), each with
  correct metadata + the reduced-quality badge where applicable, batch progress
  shows the position; a no-audio clip mid-batch shows its guidance and the rest
  continue; "Skip this one" and "Use it anyway" on a degraded clip both leave
  the queue running; N=1 single-pick identical to before; streamed per file,
  nothing buffered; lockstep "10" + cache name `studio2-shell-v10` + precache
  intact (no list change); M1.1 three-tab + chat + (mock) transcribe regressions
  intact; **zero console errors, zero external origins** on the clean run.
  (NOTE: this multi-select pass shipped bundled into the v10 drop alongside
  Agent Vision — there was no standalone "9" deploy; the lockstep moved 8 → 10.)

## v10 delivered (Agent Vision — `view_frames`, v "10")

Plan: `PM/plan-2026-06-13-agent-vision.md` (USER: "I need him to show up the
frames and watch what is going on and analyse them"). The DEVICE half of a new
agent tool that lets the chat agent SEE specific still frames on demand. The
relay half (tools.py `view_frames` + `_ok_images`, prompt softening, the
relay-side cap) is a separate (pm-backend) lane; this is the PWA decode + bridge
side, built EXACTLY to the plan §5 / agent/DOCUMENT.md "device-half contract".
Nothing was re-architected — the M0 decode discipline + single-flight queue are
the floor.

- **`engine/frames.js` (NEW).** `extractFrames(file, times[], {maxEdgePx=512,
  quality=0.6, signal?})` → `{frames:[{at_s,b64,w,h,bytes}], note?}`. mediabunny
  `VideoSampleSink.getSample(t)` (seek to the preceding keyframe, decode forward
  — the M0 path) → draw to an `OffscreenCanvas` sized to the ROTATION-AWARE
  `displayWidth`/`displayHeight` scaled so the long edge ≤ `maxEdgePx` →
  `sample.draw()` (APPLIES container rotation — portrait frames come out UPRIGHT)
  → JPEG `convertToBlob` → base64. Every `VideoSample` is `.close()`d
  IMMEDIATELY after draw, before the async encode (peak memory = ONE decoded
  frame). Per-frame base64 budget ~400 KB with a q 0.6→0.4→0.3 re-encode ladder;
  `bytes` = the JPEG binary size. Past-end times clamp to the last frame (noted),
  before-first-frame times skip (noted), request order preserved, ≤4 re-clamped.
  Dependency-pure (mediabunny + writers only; OffscreenCanvas the only DOM).
- **`bridge.js` `view_frames` executor.** In the single-flight registry. Gates
  on `ctx.caps.webcodecs.videoDecoder` — false → in-band
  `{error:{code:"unsupported",message:"this device can't read video frames"}}`
  (NEVER a throw). Else re-clamps `at_seconds`, resolves the clip via
  `findClipFile`, calls `extractFrames` (server-fixed 512px/q0.6, the relay
  deadline wired through as the abort `signal`), and returns the §5
  `{frames,note?}`. Any decode/clip error → in-band
  `{error:{code:"engine_error"}}`. The executor's RESULT is the §5 contract, not
  the bridge taxonomy — it never becomes a bridge `ok:false`, so the relay's
  `_render_view_frames` always sees the exact shape.
- **The result-cap PAIR (plan §3, LOCKSTEP).** `bridge.js` `RESULT_MAX_BYTES`
  moved 500 KB → **2 MiB** to match the relay's `routers/bridge.py`
  `_RESULT_MAX_BYTES`; base64 JPEGs inflate ~33% and a ≤4-frame result needs the
  headroom (a real 4-frame result measured 8.7 KiB on the synthetic test clips,
  far under). A >2 MiB result is rejected on BOTH ends.
- **`capability.js`.** `webcodecs.videoDecoder` (probed since M1, display-only)
  is now the LOAD-BEARING gate for `view_frames`; reaches bridge.js via
  `ctx.caps`. A user-facing "Assistant can read frames" capability row was added.
- **Lockstep "10".** index.html (`?v=` ×2), app.js `ASSET_VERSION`, sw.js
  `ASSET_VERSION` + PRECACHE gains `/static/engine/frames.js` (bare — bridge.js
  imports it bare), setup.html `?v=`.
- **Verification (desktop harness, outside repo: Playwright Chromium over
  `http://localhost` — a secure context, so WebCodecs `VideoDecoder` is present
  and H.264 supported; ffmpeg-built clips incl. a coded-landscape clip carrying a
  90° Display Matrix rotation, and a high-entropy noise clip).** Confirmed:
  `extractFrames` at `[0.5, 5, 10]` → 3 valid JPEGs (externally `ffprobe`-opened,
  mjpeg, 512×288, correct dominant colors red/green/white at the right times);
  the PORTRAIT (rotation=90) clip → an UPRIGHT 288×512 JPEG (h>w) with the
  red/blue marker bands intact across the full width (rotation applied, NOT
  sideways — saved + visually inspected); `>4` times clamped to 4; the per-frame
  byte clamp demonstrably steps quality down (315 KB clamped vs 794 KB raw q0.95
  at 1280×720); **VideoFrame disposal — 20×4 = 80 extractions, ~0 MB JS-heap
  growth where undisposed would leak ~208 MB**; the bridge executor returns the
  EXACT §5 keys `{at_s,b64,w,h,bytes}`; `caps.videoDecoder=false` →
  `{error:{code:"unsupported"}}` (no throw); a missing clip →
  `{error:{code:"engine_error"}}`; a 4-frame result well under 2 MiB; an aborted
  signal → engine error; `node --check` frames.js + bridge.js; lockstep "10" +
  cache name `studio2-shell-v10` + frames.js precached; **zero console errors,
  zero external origins** on the clean run.
