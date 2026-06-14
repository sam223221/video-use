# `studio/frontend/spike/` — M0 Spike: On-Device Editing Capability Probe

> **THROWAWAY CODE — DELETE THIS WHOLE FOLDER AFTER M0 CONCLUDES.**
> This is the M0 spike from `PM/plan-2026-06-11-m0-spike.md` (parent design:
> `PM/design-2026-06-11-studio-v2-ondevice.md`). Once both iPhones have been
> tested and the results are recorded into `PM/`, this folder has no further
> purpose and must be removed. PM tracks the removal.

## What this is

A single self-contained, login-free test page that answers the four open
questions blocking the Studio v2 (on-device editing) design:

1. **Picker test** — does the iOS Photo Library picker still re-compress video
   handed to a web page, vs. the Files picker delivering original bytes?
2. **Ingest + share test** — streamed copy of a ~1 GB clip into OPFS (timed),
   then `navigator.share({files})` → "Save Video" → Photos.
3. **Throughput test** — (a) lossless ~30 s packet-copy cut via mediabunny's
   low-level API; (b) feature matrix + video-only re-encode speed run
   (WebCodecs decode → canvas (rotation applied) → `VideoEncoder` → MP4 in OPFS).
4. **Device report** — UA, storage estimate, full feature matrix, all timings,
   as a readable page + one copyable JSON blob.

All processing is local to the phone. The page makes **zero network requests
at runtime** beyond loading its own three files; nothing is uploaded.

## How to run

- The existing Studio v1 server serves this folder as-is via its `/static`
  mount (recursive, public/pre-login, `Cache-Control: no-cache`). **No backend
  change, no server restart needed** — landing these files on disk is enough.
- On the iPhone (HTTPS origin already trusted via Secure Setup):
  `https://<host>:8443/static/spike/index.html`
  — the full file name is REQUIRED: the v1 static mount serves files only
  (no directory indexes), so `…/static/spike/` without `index.html` is a 404.
- The user runs the page on BOTH target iPhones, walks the four numbered test
  cards, then taps **Copy results** and sends the JSON to Sam.
- Desktop harness check: any local server over the `studio/frontend/` folder
  works (e.g. `python -m http.server` → `http://localhost:<port>/spike/index.html`);
  `localhost` counts as a secure context, so OPFS + WebCodecs work in
  Chrome/Edge. `navigator.share` is typically unavailable on desktop — the
  page records that as a clean "unsupported here" result, by design.

## Files

| File | What |
|---|---|
| `index.html` | The test page. Phone-first (390 px), self-contained styles, plain-English numbered steps a non-developer can follow. Carries the THROWAWAY header comment. |
| `spike.js` | All test logic. Vanilla ES module, no build step, no framework. |
| `mediabunny.js` | **Vendored, UNMODIFIED** mediabunny browser ESM bundle — see below. |
| `DOCUMENT.md` | This file. |

## Vendored mediabunny

- **Version: 1.46.0** (exact pin; npm `latest` as of 2026-06-11).
- Source artifact: `mediabunny-1.46.0.tgz` → `package/dist/bundles/mediabunny.mjs`
  (the single-file **browser ESM bundle**, unminified on purpose so iPhone
  Safari stack traces stay readable), copied byte-identical and renamed to
  `mediabunny.js`.
- SHA-256: `9076936D2F02D245630AA4BA2B556FAB7C74776A37B66C91003FABD0DE9F8D41`
  (verified equal to the file inside the npm tarball; tarball integrity
  `sha512-HIaMQ6PVMndrF[...]LDtwTcdKo7yQw==`, shasum
  `892621d4f70989023bc1eb08422788a0f48b3ba8`).
- License: MPL-2.0 (Vanilagy/mediabunny). The bundle retains its own license
  header. No hand edits of any kind.
- No npm/package.json was added anywhere in the repo — the file was fetched
  once at build time (`npm pack mediabunny@1.46.0` in a temp dir) and vendored.

### mediabunny APIs used (names verified against this exact dist's `.d.ts`)

- Reading: `Input` + `BlobSource` + `ALL_FORMATS` (lazy reads — picked files
  are never read whole), `QuickTimeInputFormat` (instanceof check to match the
  output container), `InputVideoTrack`/`InputAudioTrack` getters
  (`getCodec`, `getCodecParameterString`, `getCodedWidth/Height`,
  `getDisplayWidth/Height`, `getRotation`, `getColorSpace`,
  `hasHighDynamicRange`, `computePacketStats`, `getDecoderConfig`, `canDecode`).
- Lossless cut (packet copy — explicitly **NOT** `Conversion`/`trim`, which
  transcodes mid-file trims): `EncodedPacketSink`
  (`getKeyPacket(t, {verifyKeyPackets:true})`, `getFirstKeyPacket`,
  `getPacket`, `packets()` async iteration), `EncodedPacket.clone()` for
  timestamp re-basing, `Output` + `Mp4OutputFormat`/`MovOutputFormat` +
  `StreamTarget` + `EncodedVideoPacketSource`/`EncodedAudioPacketSource`.
- Re-encode probe: `VideoSampleSink.samples()` → `VideoSample.draw()` (chosen
  over `CanvasSink` because `draw()` applies the container rotation while
  letting us own one reusable canvas) + `EncodedPacket.fromEncodedChunk()`.
- Output self-check (`verifyOutput`): `Input` + `BlobSource` over the
  committed OPFS file, `getFormat()`, `getTracks()`, `computeDuration()`,
  `getPrimaryVideoTrack().getCodec()`.

## Key implementation decisions

- **`fastStart: false`** on both outputs (cut + re-encode): metadata is
  written at the END of the file, which is the fastest, lowest-memory option;
  it requires random-access positioned writes, which OPFS
  `FileSystemWritableFileStream` supports (mediabunny's `StreamTarget` is
  documented compatible with it and `Output.finalize()` closes the writable,
  committing the OPFS file). `'fragmented'` was the alternative; not needed
  since positioned writes work, and plain MP4/MOV is more widely playable
  (the whole point of the share-to-Photos validation).
- **Timestamp re-basing in the cut:** the muxer requires non-negative
  timestamps and turns a non-zero track start into an edit-list delay, so
  packets are `clone()`d with `timestamp - cutStart` (common base for video
  and audio = the chosen key frame; audio packets from before that point are
  skipped). The cut ends at the first key frame at/after the 30 s mark, so it
  is keyframe-aligned on both sides (exactly what v2's Tier-1 will do).
  Consequence: audio packets stop at the 30 s mark itself while video runs on
  to that key frame, so the last ~0–2 s of the cut can be silent — EXPECTED,
  not a bug; the page says so in test 3's on-screen instructions so it does
  not get reported as one.
- **Manual A/V interleaving:** video and audio packet iterators are merged by
  timestamp so the output file is laid out like a normal recording and memory
  held by the muxer stays minimal.
- **Failed-output cleanup (cut + re-encode):** if either test throws mid-run,
  `abandonOutput()` best-effort-cancels the mediabunny `Output`
  (`Output.cancel()` releases muxer resources and closes the writer it locked
  on the OPFS writable) and then tries `writable.abort()` (covers the
  pre-`start()` case where the stream is still unlocked). Each call is
  individually try/caught so cleanup can never mask the original error;
  without it a failure would leave the writable open, pinning staged data
  until GC and possibly blocking a same-session re-run. Success paths are
  unchanged (`finalize()` commits + closes); test 2's ingest needs nothing —
  `pipeTo()` auto-aborts its destination on failure.
- **Streaming discipline everywhere:** no `file.arrayBuffer()` anywhere;
  ingest pipes `file.stream()` through a byte-counting `TransformStream`
  (progress for the crash journal) into the OPFS writable; share payloads are
  `new File([opfsFile], …)` wrappers (lazy blob references, no byte copy).
- **`createWritable` feature-detected, NOT shimmed:** if absent the test
  records `createWritable: unsupported` and stops — that gap itself is one of
  the spike's answers (the plan forbids a worker shim).
- **Crash journal:** every result/timing/heartbeat write goes to
  `localStorage["spike.results.v1"]` immediately (single JSON doc). On load
  the journal is restored into the UI; any test left `running` is marked and
  `{interrupted: "<test id>"}` is appended — iOS memory kills are uncatchable,
  so this is how they are DETECTED. Starting a test clears the PREVIOUS run's
  `error`/`detail`/`verify`/`writes` from that test's record (each run's
  record speaks only for itself — without this, a failed re-run journals
  `status:"failed"` next to the old run's green `verify`: the stale-green-
  verdict bug); the `interruptions[]` history is never cleared by a re-run.
  The cut's "unsupported" branch likewise REPLACES its record instead of
  merging, so it can't inherit a previous run's timings/share note.
  "Reset all results" clears the journal AND
  deletes the OPFS `spike/` working directory (frees the ~GB of copies).
- **Feature matrix gathered at page load** (before any heavy test can run) and
  journaled immediately, so a later crash still yields the matrix.
- **Share serialization (field-found fix, iPhone Safari 26.5):** iOS allows
  only ONE share session at a time — a second `navigator.share()` while a
  previous one is open (or still tearing down) rejects with
  `InvalidStateError`; worse, after "Save Video" the first share() promise
  sometimes NEVER settles (WebKit quirk), so a naive pending flag would
  deadlock every share button until reload. `shareToPhotos` therefore sets a
  module-level pending guard around share() that clears on promise settle,
  on `visibilitychange`→visible / window `focus` (returning from the sheet
  implies it closed), or after 25 s — whichever fires first (a guard id makes
  a zombie settle unable to clear a newer share's flag). While pending, a tap
  on ANY share button shows "Close the open share sheet first, then try
  again." instead of calling share(); an `InvalidStateError` that still gets
  through renders "iOS still has the previous share open. Wait a moment (or
  reload the page) and tap share again." and is journaled like other share
  failures. A failed/blocked share only ever writes the test's `share` note —
  test `status` (e.g. cut "done") is never touched, buttons stay tappable for
  retry, and the journal schema is unchanged (old journals load as-is).
- **FIELD-CONFIRMED DEFECT (iPhone, Safari 26.5) — muxed outputs corrupt on
  disk; Photos refuses them ("unable to play this format"):** what was first
  logged as an `outputBytes` measurement artifact is a real corruption. The
  evidence triangulates: `cut.mov` saved to Photos but would not play, while
  `ingest.mov` (same source bytes, written SEQUENTIALLY via
  `file.stream().pipeTo(createWritable())`) saved and played fine; BOTH
  `cut.mov` and `reencode.mp4` reported `outputBytes: 33554432` — exactly
  2 × 16 MiB, mediabunny's `DEFAULT_CHUNK_SIZE` — where desktop runs of the
  identical code produce byte-exact, non-aligned, ffprobe-clean files; and
  H.264+AAC-in-QuickTime is universally playable on iPhone, so the refusal
  implies STRUCTURAL corruption (with `fastStart: false` the moov index sits
  at the very END of the file — exactly where chunk-boundary corruption
  bites). **Prime suspect (hypothesis, not yet proven):** Safari's
  `FileSystemWritableFileStream.write({type:"write", position, data})`
  mishandles `data` when it is a `Uint8Array` SUBARRAY VIEW onto a larger
  backing buffer — mediabunny's chunked `StreamTarget` flushes
  `chunk.data.subarray(start, end)` views onto its 16 MiB chunk buffers;
  writing the whole backing buffer (or botching byteOffset/length) would both
  inflate the file to chunk-aligned sizes and smear/zero the moov.
  **Fix (spike-side; vendored bundle untouched):** `normalizingWritable()` in
  `spike.js` wraps the OPFS writable before `StreamTarget` sees it and copies
  every view payload into a fresh, tightly-sized `Uint8Array` (the ingest
  path's `TransformStream` normalizes the same way, defensively — its chunks
  are normally standalone buffers already). Positions and close/abort
  semantics forward 1:1; desktop-verified that the cut output stays
  byte-identical to the pre-fix build.
  **Self-check:** after `finalize()`, `verifyOutput()` re-opens the OPFS file
  and journals its TRUE size, first/last 16 bytes as hex, a full mediabunny
  re-parse (container, track count, codec, duration) and a duration-vs-
  expected comparison (±1 s keyframe-tail tolerance); the verdict renders
  prominently in the test card ("Output verified … safe to share" /
  "OUTPUT CORRUPT: …"). The share/download buttons stay armed even on a
  corrupt verdict (a broken file may be wanted for inspection) — the verdict
  text says whether saving to Photos is worth attempting. The verdict renders
  ONLY for a record whose status is `done`, and starting a NEW cut run
  disarms share/download (and drops the old `verify`/`writes`) until that
  run's own success re-arms them with the new file — a failed or interrupted
  re-run can never show the previous run's green verdict or hand out its
  stale (possibly part-overwritten) output. Known limit: the self-check
  cannot detect a same-size mdat smear (media bytes corrupted in place, with
  the length and moov intact, still parse and duration-match) — the "plays
  in Photos" checkbox is the human backstop.
  **The NEXT phone run adjudicates the hypothesis:** new journal fields
  `writes` ({commands, viewsNormalized, bytesWritten, logicalEnd}) and
  `verify` ({fileBytes, first16Hex, last16Hex, container, trackCount,
  videoCodec, durationSeconds, expectedSeconds, problems[]}) under
  `tests.cut` / `tests.reencode` (plus a small `writes` on `tests.ingest`).
  If `viewsNormalized > 0` and `fileBytes === logicalEnd` (non-aligned) with
  a clean parse → the WebKit view-write hypothesis is confirmed and the fix
  holds. If the size STILL lands 16 MiB-aligned despite every payload being
  tightly sized → the hypothesis is wrong, and the hex tail + parse error
  pin down what actually reached disk. All fields are additive — journals
  written by the previous build still load (`spike.results.v1` unchanged).
- **Wake lock** (`navigator.wakeLock.request('screen')`) held while any test
  runs, re-acquired on `visibilitychange`, feature-detected; a visible
  "keep the screen on" hint shows when no lock is held.
- **Re-encode codec choice:** prefers HEVC (`hvc1.1.6.L153.B0`, Safari has the
  hardware encoder), falls back to `avc1.640033`, probed via
  `VideoEncoder.isConfigSupported` at the clip's actual display dimensions.
  Every decoded `VideoSample` and constructed `VideoFrame` is closed promptly
  (Safari decoders stall otherwise). Output frames are muxed through a
  serialized promise chain with encoder-queue backpressure (`encodeQueueSize`).
- OPFS files live under one directory (`spike/`): `ingest.<ext>`, `cut.mov|mp4`,
  `reencode.mp4` — fixed names so re-runs overwrite instead of accumulating.

## Connections

- Served by `studio/app/main.py`'s existing `_RevalidatingStaticFiles` mount of
  `studio/frontend/` — this folder rides along with zero changes there.
- No imports from the main SPA (`../app.js` etc.) and nothing imports from
  here. No `?v=` cache-bust needed: the page is standalone and `/static/*`
  responses are `Cache-Control: no-cache` (always revalidated).
- Results feed `PM/` and the M1 plan; after that, **delete this folder**.
