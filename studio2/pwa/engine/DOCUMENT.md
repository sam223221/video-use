# studio2/pwa/engine/ — the media engine (lossless Step 4 + M3 render tier Step 2)

Pure media machinery (arch §1.4): mediabunny only (+ documented store/opfs
exceptions), **no DOM beyond OffscreenCanvas, no fetch, no app state**.
Everything streams (`BlobSource` lazy reads, `StreamTarget` chunked writes,
windowed decode) — a clip is never held in memory (device RAM is THE
constraint, arch §9). Directly reusable on desktop (M3 desktop mode) unmodified.

Productionized from the field-proven M0 spike
(`studio/frontend/spike/spike.js`); the spike folder remains throwaway
reference and gets deleted when M1 ships.

**M3 render tier (Step 2)** adds the on-device re-encode/compositor pipeline
beside the lossless remux: `webcodecs.js` (codec config + bounded decode),
`compositor.js` (rotation + fit + blur + HDR→SDR), `duck.js` + `audiomix.js`
(music mix + ducking), `render.js` (the segment-wise checkpointed orchestrator),
and an SDR-aware `verify.js`. The render engages ONLY when `cut.tierCheck` says
"render" (format-normalize / non-identity fit / music) — the lossless path stays
the default and is byte-for-byte unchanged (arch §5.3). Desktop-harness-verified:
2 landscape + 1 PORTRAIT (rotation 270) clips on a 9:16 1080×1920 canvas,
contain+blur, with a ducked music bed → a verified HEVC **bt709 SDR** file
(ffprobe + full ffmpeg decode exit 0); the portrait clip composited UPRIGHT (red
top-marker proven at the canvas top, navy below); landscape clips letterboxed
over a dimmed blurred fill; music ducked to ~0.25× (−12 dB) under the mapped
transcript words; checkpoint/resume after a mid-render abort (killed at seg 1 →
manifest `[0]` done → resume finished `[1,2]`); heap growth ≤ ~30 MB across the
render (no whole-clip/output buffer); zero console errors even under GC pressure.

## Files

| File | Purpose |
|---|---|
| `mediabunny.js` | **VENDORED, UNMODIFIED** mediabunny **1.46.0** browser ESM bundle (`dist/bundles/mediabunny.mjs`), byte-identical to the spike's copy. SHA-256 `9076936D2F02D245630AA4BA2B556FAB7C74776A37B66C91003FABD0DE9F8D41`. MPL-2.0, license header retained, no CDN, no hand edits ever. |
| `writers.js` | `normalizingWritable()` (banked #1 — the WebKit view-write corruption defense), `tempThenRename()` (banked #3 — temp name → verify → rename; composes store's `tempWriter()`), `abandonOutput()` (never-masking failure teardown), `normalizeBufferSource()` (shared by edl.js + ingest.js writes), `errorCode()`/`engineError()` (bridge taxonomy, duck-typed `.code` — no `instanceof` across the ?v= boundary). |
| `probe.js` | `openProbe(file)` session + one-shots: `analyzeFile()` (clipmeta shape, never throws — `parseError` instead), `keyframeBefore/After()` (`EncodedPacketSink.getKeyPacket(verifyKeyPackets:true)` + bounded forward hops), `gopEstimate()` (bounded ~120-packet metadata-only scan), `snapRemovalRange()` (THE §5.3 snapping contract: `"remove"` grows the removal to cover what was asked, `"keep"` shrinks it — returns `null` when the kept-biased region collapses). |
| `cut.js` | `losslessCut({segments, sources, target, onProgress})` — multi-segment keyframe-aligned packet-copy remux (arch §6.2): per-segment timestamp re-basing with accumulated `outputOffset`, A/V iterators merged by timestamp, video stops at first key packet ≥ end / audio at ≥ end — all three boundary comparisons compensated by `SNAP_EPSILON_S` (0.0051 s: > the journal's round2() worst error 5 ms, < min frame spacing ~16.7 ms) since journaled times are 2-decimal-rounded keyframe timestamps; start lookup uses `start_s + ε`, stops use `end_s − ε`. Rotation preserved, MOV in → MOV out else MP4, `fastStart:false`. Multi-clip joins only with matching video codecString + audio + dimensions + rotation, else a clean `engine_error`. **M3:** also exports `tierCheck(foldedState, renderBlock, clips) → "lossless"\|"render"` — see below. |
| `canvas.js` (M3) | **PURE, dependency-free** (no mediabunny, no DOM, no fetch). `resolveCanvas(renderBlock, clips) → {mode, preset?, primary_clip_id?, width, height, fps, background, advisory?}` — turns a render-block canvas MODE into concrete pixels the engine + preview read; `width/height/fps` are ALWAYS resolved (even dims, long edge ≤ 1920 = the M3 ≤1080p ceiling, fps 1…60). Modes: `preset` (the fixed `PRESETS` table — 16x9/9x16/1x1/4x5 × 1080/720), `match_primary` (the named-or-first-live clip's ROTATION-AWARE `displayWidth/Height`; clamps a 4K primary to 1080-class with an `advisory`; rewrites `primary_clip_id` when the named clip is gone), `custom` (DEFERRED in M3 — resolved defensively, never thrown). Never throws — any malformed input resolves to a usable canvas. Exports `PRESETS`, `DEFAULT_PRESET`/`DEFAULT_FPS`/`DEFAULT_BACKGROUND`/`DEFAULT_FIT`, `defaultRenderBlock()` (the lossless default a fresh/legacy project resolves AS; `store/meta.js` default-fills a MISSING render block with these semantics). The single place mode→pixels happens — Step 2 (render engine) + Step 5 (UI/preview) build on it. |
| `audio.js` (M2) | `extractAudio({file, target, onProgress})` → `{durationS, audioPackets, mediaBytes, codec, writes}` — lossless packet-copy of the PRIMARY audio track into an audio-only MP4 (`.m4a`): the `cut.js` loop minus video, single contiguous track. Always `Mp4OutputFormat({fastStart:false})` (re-containering one AAC track regardless of source container, arch §5.1). Re-bases the track to start at 0 (`out_ts = ts − firstTimestamp`) — mandatory: real recordings carry a small NEGATIVE audio start (AAC priming / edit-list offset, e.g. −0.023 s on the test footage) and the muxer REJECTS negative timestamps; cut.js never hits it because every segment is already 0-based via `outputOffset`. The shift is ≤ tens of ms (sub-keyframe, far under the silence gaps the agent places cuts in), so EL word times align with the clip's source clock within the snap tolerance. Clean EARLY `engine_error` (zero bytes written) on: no audio track (the degraded/silent-copy class — UI disables first, this is the 2nd guard), unrecognized audio codec, unparseable container, or an empty audio track. The caller passes `writers.tempThenRename(transcriptsDir, "clip_<id>.m4a")` and **never commits**: it reads the committed `.tmp` back as a File for the upload, then `abandon()`s it (the `.m4a` is a transient upload artifact, arch §5.1). Light verify is the caller's (`file.size === writes.logicalEnd && >0`); the DEEP validation is EL parsing it server-side. |
| `verify.js` | `verifyOutput({handle, expectedSeconds, expectAudio, writeStats, expectSdr?})` (banked #4+#5; M3 SDR-aware): true size vs `writes.logicalEnd` (never vs an expected byte count), full mediabunny re-parse, duration ±0.5 s, A/V presence, **and (M3 `expectSdr:true`) the output `colorTransfer` is in the SDR ALLOWLIST** (`bt709`/`smpte170m`/`iec61966-2-1`[sRGB], plus the `srgb` alias; `isSdrTransfer()`) — a rendered video must be standard-range (the tone-map ran). The check is an ALLOWLIST, not a known-HDR blocklist: PQ/HLG **and** any generic 10-bit `bt2020-*` wide-gamut transfer **and** any unrecognized transfer → NOT-SDR, so an unexpected HDR/wide-gamut output can't slip through the last automated standard-range guard. A missing/unreadable transfer is the common SDR case (not asserted). The render path passes `expectSdr:true`; the lossless path omits it (HDR preserved deliberately). Verdict SHAPE unchanged (`{status, problems[], text, …colorTransfer?, isSdr?}`) so `export.js` needs no new branch — a non-SDR render is just another `corrupt`. Never throws. |
| `webcodecs.js` (M3) | Bounded codec config + capability helpers (arch §6.4.2). `pickVideoEncoderConfig(canvas)` — probe-driven codec choice (HEVC `hevc`→`hvc1.*` preferred, H.264 `avc`→`avc1.*` fallback) via mediabunny `canEncodeVideo` at the EXACT output WxH (wraps `VideoEncoder.isConfigSupported`; **NO UA/iOS-version sniff**, banked #8) + a pixels×fps bitrate ladder (`bitrateFor`, 1.5–16 Mbps); `pickAudioEncoderConfig()` — AAC-LC 48 kHz stereo ~160 kbps (`canEncodeAudio` probe). `openVideoForDecode(file)`/`openAudioForDecode(file)` open one mediabunny Input + hand back the sink + the rotation/HDR/display facts (probe.js facts, read once); `decodeVideoWindow`/`decodeAudioWindow` wrap `VideoSampleSink.samples()`/`AudioBufferSink.buffers()` — pre-decode-a-few-ahead iterators that NEVER buffer a whole clip (the caller drains + closes). mediabunny owns the WebCodecs encoder/decoder lifecycle (its `…Wrapper`s drive bounded queues + `Source.add()`-promise backpressure) — we never touch a bare encoder. A probe that THROWS is fail-safe (treated as unsupported); when the thrown error is NOT a `NotSupportedError` (the normal "unavailable" signal) — e.g. a transient OOM/quota error — the true error name/message is logged at `warn` (`engine.probe.error`) via the loose-coupled diag singleton (`window.__studio2Diag`, NEVER a static `diag.js` import — engine stays DOM/fetch-free; a no-op on desktop/test), so a gate-fail with the wrong cause is visible in the client log; the gate verdict is unchanged. Dispose-quirk parity (`formatOk`); errors carry `.code`. |
| `compositor.js` (M3) | `createCompositor(canvas) → {canvas, composeFrame(sample, fit), clear(), dispose()}` — the per-frame compositor (arch §6/§6.4.2). Per frame, in order: **(1) ROTATION** — `VideoSample.draw()` APPLIES the container rotation (Safari has no `VideoFrame.rotation`; portrait phone footage is composited UPRIGHT — THE repo bug, commit 1200463; the sample's `displayWidth/Height` are already rotation-swapped); **(2) FIT** onto the canvas — `contain` (letterbox/pillarbox; background `blur` = the cover-scaled frame heavily Gaussian-blurred + darkened behind the sharp contained frame, OR `black` solid bars) / `cover` (crop-to-fill, clipped); **(3) HDR→SDR** tone-map (a mild highlight roll-off filter when the source is HDR — the browser's HDR→sRGB decode does the heavy lifting; the 2D path is the always-correct baseline). **ONE reused OffscreenCanvas** for output + one downscaled scratch for the blur (allocated once, not per frame — arch §6.4.4); the encoder snapshots the SAME shared canvas (`render.js` builds a `CanvasSource` over `compositor.canvas`). Backend `"2d"` (WebGPU/WebGL2 shader passes are a future seam; the gate steers GPU-less devices to desktop). DOM-free (OffscreenCanvas only). |
| `duck.js` (M3) | **PURE, dependency-free**: the music DUCKING envelope (arch §6.4.2). `buildDuckEnvelope({duck, speech, fallback?, durationS, sampleRate}) → Float32Array` per-sample gain (0..1) — full music (1.0) outside speech, ducked to `dbToLinear(amount_db)` inside, with attack/release ramps (broadcast sidechain). `mapWordsToPlacement(words, segments, at_s, dur)` maps transcript WORD TIMES (source-clip seconds) through the keep-list source→output mapping onto the COMPOSED timeline, relative to the placement (words in cut-out regions are dropped). `mergeIntervals` unions adjacent words (gap-join) so music doesn't bob between every word. **SECURITY (arch §9): word TIMES only — `w.w` text is NEVER read.** No transcript → `fallback:true` = a flat gentle blanket duck. Helpers: `dbToLinear`. O(words + samples). |
| `audiomix.js` (M3) | `mixSegmentAudio({clipAudio, sourceStart/End, segStartOut/EndOut, music, musicFacts, transcriptWords, clipSegments, addAudioSample, signal}) → frames` — the PCM mixer (arch §6.4.2). Per OUTPUT SEGMENT mixes the clip's source-audio window + every overlapping music placement (per-placement `gain_db`, fade-in/out envelopes, the `duck.js` envelope from the clip's transcript word TIMES or a flat fallback), sums + soft-limits (tanh knee), at 48 kHz stereo. **WINDOWED**: decodes in ≤0.5 s blocks via `webcodecs.decodeAudioWindow` (bounded `AudioBufferSink.buffers`) and encodes each block immediately — the WHOLE track is never in RAM (arch §6.4.4). Linear resampler brings each source to 48 kHz; mono→stereo. Hands each mixed block to the caller's `addAudioSample` (render.js wraps it in `new AudioSample(...)` → `AudioSampleSource.add` AAC). Pure: mediabunny (via webcodecs) + duck + writers only. |
| `render.js` (M3, the SPINE) | `renderProject({projectId, fold, renderBlock, canvas?, clips, music?, sources, musicSources?, transcripts?, onProgress?, signal?}) → {handle, stats, verdict}` — the segment-wise checkpointed orchestrator (arch §6/§6.4.3). PER keep-segment: decode source video window → `compositor.composeFrame` (rotation+fit+blur+HDR→SDR) onto the resolved canvas → `CanvasSource`→`VideoEncoder` (HEVC-when-supported else H.264, `webcodecs.pickVideoEncoderConfig`) + `audiomix.mixSegmentAudio`→AAC; the segment mux is written via `tempThenRename` into the `render/` checkpoint dir and the **manifest** marks it `done`. After all segments: **concat** the codec-identical segment muxes via packet-copy (cut.js's re-basing merge, applied across whole files) into `out-<ts>-<rand>.mp4` (`Date.now()` + a 4-byte `crypto.getRandomValues` hex suffix — collision-proof even if two renders commit in the same millisecond) → `verify` (SDR-aware, `expectSdr:true`) → on `ok` commit + sweep the checkpoints (corrupt → `out-<ts>-<rand>.corrupt.mp4`, derived from the same unique stem, never trusted). **RESUMABLE**: a FINGERPRINT (keep-list + canvas + fits + music + codec) gates resume — a matching manifest skips `done` segments and resumes at the first pending one; a mismatch sweeps the stale dir and starts fresh (the iOS-kill survival mechanism — a kill at seg 7 costs only 7–12). **MEMORY (arch §6.4.4)**: one frame in flight, every `VideoSample.close()`d immediately after compositing (decode iterators bounded + drained), audio windowed, one OffscreenCanvas reused, output streamed through `normalizingWritable`. Wake lock + crash marker are the caller's (export.js); takes a cancellable `signal` + `onProgress({segment, segmentsTotal, framesDone, framesTotal, fps, etaS})`. Imports `store/opfs` for the checkpoint dir (the same documented exception writers.js uses) + a tiny inlined `effectiveFit` (no store/meta dependency). |
| `frames.js` (Agent Vision) | `extractFrames(file, times[], {maxEdgePx=512, quality=0.6, signal?}) → {frames:[{at_s,b64,w,h,bytes}], note?}` — the DECODE half of the bridge's `view_frames` (plan 2026-06-13). For each requested time: `VideoSampleSink.getSample(t)` (mediabunny seeks to the preceding keyframe and decodes forward — the M0 decode path) → draw the `VideoSample` to an `OffscreenCanvas` sized to the ROTATION-AWARE `displayWidth`/`displayHeight` scaled so the LONG edge ≤ `maxEdgePx` → `sample.draw()` APPLIES the container rotation (portrait clips come out UPRIGHT, never sideways — the repo's rotation history) → `convertToBlob({type:"image/jpeg",quality})` → base64. **Every `VideoSample` is `.close()`d IMMEDIATELY after draw, BEFORE the async JPEG encode** — peak memory is ONE decoded frame, never N (iOS memory is THE kill constraint; harness-proven: 20×4 extractions, ~0 MB heap growth where undisposed would leak ~208 MB). Per-frame BASE64 budget (~400 KB): re-encode steps q 0.6→0.4→0.3 and returns the smallest (the 2 MiB bridge cap is the hard backstop); `bytes` is the JPEG binary size. Times past the clip end CLAMP to the last frame (reported in `note` + the actual `at_s`); a time before the first frame is skipped (noted). Returns frames in REQUEST order; `≤4` defensively re-clamped. Dependency-pure: mediabunny + writers (`engineError`) only — no DOM beyond OffscreenCanvas, no fetch, no OPFS. Errors carry `.code="engine_error"` (duck-typed). Dispose-quirk parity with probe.js (`formatOk`). |

## Load-bearing invariants

- **No `StreamTarget` over a raw OPFS writable, ever** (banked #1).
  `tempThenRename()` only hands out the wrapped stream (the raw writable is
  locked away inside it), and `losslessCut()` / `extractAudio()` both REFUSE a
  target that did not come through the wrapper (they require the
  `{stream, stats}` shape). The M0 field defect this defends against: WebKit
  corrupts positioned writes of typed-array subarray views — files land 16 MiB-
  chunk-aligned with a smeared moov, and `fastStart:false` puts the moov
  exactly where that bites. (T2 harness: the extract's `viewsNormalized` is
  nonzero — the wrapper copies mediabunny's subarray flush on the `.m4a` too.)
- **The final name is never a write target** (banked #3): `Output.cancel()`
  COMMITS partial bytes on whatever name it was given, so all engine output
  goes to `<final>.tmp` and `commit()` renames only after the caller's
  verification passed. Orphaned `.tmp`s in `clips/`, `exports/` and (M2)
  `transcripts/` are removed by the boot sweep. The audio-extract `.m4a` is the
  one output that is DELIBERATELY never committed — its caller abandon()s the
  `.tmp` after reading it back for the upload (arch §5.1), so the `.m4a` only
  ever exists as a transient `.tmp`.
- **Verify before rename** (banked #4/#5): `verifyOutput` runs against the
  committed `.tmp` and compares the on-disk size to the wrapper's
  `logicalEnd` — reported sizes alone are not trusted on Safari.
- **Errors carry `.code`** (`engine_error` / `storage_error`, arch §3.5) as a
  plain property — duck-typed so Step 5's executors classify without
  `instanceof` across the ?v= double-load boundary. `writers.errorCode(err)`
  classifies platform errors.
- **No self-metering** (banked #6 lives elsewhere): one engine operation at a
  time is enforced by the callers — ingest's single-flight mount and Step 5's
  bridge executor queue / export disarm-on-start.
- **(M3) One frame in flight, every `VideoSample.close()`d immediately**
  (arch §6.4.4 — THE iOS-kill constraint). `render.js`'s decode loop holds at
  most the current + next decoded sample, closes the previous the instant it
  composites the next, and DRAINS + closes any pre-decoded tail before the
  segment ends; audio is windowed in ≤0.5 s blocks (`audiomix.js`); ONE
  OffscreenCanvas is reused (`compositor.js`); the output streams through
  `normalizingWritable`. **Nothing buffers a whole clip or the whole output.**
  The decode-iterate-and-draw block is wrapped in a `try/finally` so the
  ABORT/THROW exit (the `signal` cancel check, or any throw from
  compose/encode/decode) ALSO closes the in-flight `held` + `pending.value`
  samples — the clean path already disposes immediately, the `finally` is the
  guaranteed-cleanup backstop so a forced cancel can never leak a frame (it is a
  strict no-op on the clean path: `held` is nulled and the tail drained before
  it runs). Harness-proven: a full 3-clip + music render grows the JS heap
  ≤ ~30 MB and emits ZERO `VideoSample was garbage collected without being
  closed` warnings even under forced GC pressure; a desktop FinalizationRegistry
  harness over the loop confirms an ABORT mid-segment and a throw mid-loop now
  also emit ZERO such warnings (the pre-`finally` structure leaked the two
  in-flight samples on each early exit). An undisposed render would leak
  hundreds of MB.
- **(M3) Render is segment-checkpointed + resumable** (arch §6.4.3). Each
  finished keep-segment is a self-contained valid mux written through
  `tempThenRename` into `render/seg-NNNN.part.mp4`, recorded `done` in
  `render/manifest.json` (a FINGERPRINT of keep-list + canvas + fits + music +
  codec gates resume). A kill mid-render leaves a `.tmp` the boot sweep removes
  (banked #3) and a manifest whose `done` segments are skipped on re-run; a
  fingerprint mismatch (the user edited after the kill) sweeps the stale dir and
  starts fresh. The final concat is a lossless packet-copy of the
  codec-identical segments. Harness-proven: abort at segment 1 of 3 → manifest
  `[0]` done → resume renders only `[1,2]` → verified `ok`.
- **(M3) Render is probe-driven, NO UA/iOS-version sniff** (banked #8): the
  output codec is HEVC when `webcodecs.pickVideoEncoderConfig` finds
  `canEncodeVideo("hevc", …)` true at the exact canvas WxH (wrapping
  `VideoEncoder.isConfigSupported`), else H.264 — the honest capability test,
  never a version string. A device that can encode neither fails cleanly in
  `pickVideoEncoderConfig` (the caps gate's second guard). A probe that throws is
  fail-safe (unsupported), but a non-`NotSupportedError` cause (transient
  OOM/quota) is logged at `warn` via the diag singleton so the gate-fail's true
  cause is never silently misattributed — the fail-safe behavior is unchanged,
  only the diagnostic honesty is added.
- **(M3) Rendered output is SDR, verified by ALLOWLIST** (arch §0/§1): the
  compositor tone-maps HDR→SDR (no browser encodes 10-bit) and `verify.js` with
  `expectSdr:true` ADMITS an output ONLY when its `colorTransfer` is a known
  standard-range transfer (`bt709`/`smpte170m`/`iec61966-2-1`[sRGB]/`srgb`);
  PQ/HLG, a generic 10-bit `bt2020-*` wide-gamut transfer, OR any unrecognized
  transfer all fail as not-SDR. The allowlist (not a known-HDR blocklist) is the
  load-bearing choice: a blocklist would PASS a novel HDR/wide-gamut transfer it
  never enumerated. The lossless path PRESERVES HDR and passes `expectSdr`
  undefined. Harness-proven: the render emits `bt709` (ffprobe), not
  `smpte2084`/`arib-std-b67`.
- **(M3) Ducking reads transcript word TIMES only, never text** (arch §9):
  `duck.js` is a pure function of `[s,e)` intervals; there is no code path that
  touches `w.w`, so a transcript can inject nothing. No transcript → a flat
  gentle blanket duck (the fallback).

## Key decisions

- `writers.js` imports `../store/opfs.js` (`tempWriter`, `moveEntry`) instead
  of duplicating the temp/rename mechanics — a deliberate exception to
  "engine imports only mediabunny" (store/opfs.js is equally DOM-free and
  fetch-free; one implementation of banked #3 beats two). `writers.js`
  itself imports no mediabunny.
- `losslessCut` takes **Files, not mediabunny Inputs** — the module owns all
  mediabunny object creation, so `instanceof QuickTimeInputFormat` can never
  cross module instances.
- Segment starts are expected pre-snapped (§5.3, at edit time, journaled);
  the engine still snaps a start DOWN to the key packet at/before it
  (decodability requires it) — via `start_s + SNAP_EPSILON_S`, never the raw
  journaled value: the journal round2()s keyframe times, and a rounded-down
  start fed raw into the key-packet lookup selects the PREVIOUS keyframe,
  re-admitting up to a whole GOP of removed material — so an unsnapped caller
  gets a correct, slightly longer keep rather than a broken file.
- The last fraction of a second of a segment can be silent when video runs
  past the audio stop to the next keyframe — spike-documented, expected,
  ≈0 when boundaries are properly snapped.
- **`tierCheck` (M3 tier auto-selection, arch §4/§5.1) is PURE** — it reads the
  folded keep-list (`{segments, music}`), the render block, and the live
  clipmeta only (no I/O, no mediabunny). Returns `"lossless"` IFF: NO music,
  AND every involved clip's rotation-aware display dims EXACTLY equal the
  resolved canvas (`canvas.js` `resolveCanvas`), AND every involved clip shares
  one video + one audio codecString (mixed audio presence = a mismatch, the
  `validateJoin` rule), AND every clip's fit is identity (`contain` on a canvas
  it already fills — never `cover`); else `"render"`. A clip on the timeline
  whose metadata can't be read is conservatively `"render"`. **A single-clip
  trim with the default match_primary canvas resolves to `"lossless"`** — the
  canvas IS that clip's dims, one codec, identity fit, no music — so the M1/M2
  mainline never pays a re-encode (the load-bearing regression Step 6 pins).
  `export.js` (Step 5) calls it to AUTO-SELECT which engine to run; `cut.js`
  imports `resolveCanvas` from `canvas.js` for this (the only new cut.js
  dependency).
- `gopEstimate` uses container key flags (`metadataOnly:true` scan) rather
  than verified key packets — mediabunny forbids combining the two options,
  and an estimate doesn't need verification.
- **(M3) The compositor exposes its shared OffscreenCanvas; the encoder
  snapshots it.** `render.js` builds a mediabunny `CanvasSource` over
  `compositor.canvas`, so `composeFrame()` draws and the encoder captures the
  SAME surface — one allocation, no copy, no per-frame canvas. mediabunny's
  high-level `CanvasSource`/`VideoSampleSource`/`AudioSampleSource` are used
  (not bare `VideoEncoder`/`AudioEncoder`): they own the encoder lifecycle with
  internal bounded queues and the `Source.add()`-promise IS the backpressure the
  render awaits — one place responsible for the queue discipline.
- **(M3) The compositor 2D path is the always-correct baseline; WebGPU/WebGL2
  are a future seam.** Rotation (`VideoSample.draw`), contain/cover fit math,
  blurred-fill (downscaled scratch + canvas `filter:blur` + darken), and a mild
  HDR roll-off filter are all done on a 2D OffscreenCanvas — robust everywhere
  OffscreenCanvas exists. A shader path (PQ→BT.709 tone-map + separable Gaussian)
  can replace it later for speed; the gate already steers GPU-less devices to
  desktop, so the 2D path is what ships and is harness-proven correct (portrait
  upright; blur vs black distinct; pixel-checked).
- **(M3) Music placement `at_s` is OUTPUT-timeline time** (arch §2.3). The fold
  already clamps placements to the composed timeline; `render.js` shifts each
  placement into segment-local time per segment, and `duck.js`'s
  `mapWordsToPlacement` maps source word times → output time through the keep
  list, so a cut that shortens the timeline never desyncs the duck. The whole
  audio chain runs on ONE clock (the output timeline), mirroring the M2 "one
  clock" invariant.
- **(M3) `render.js` inlines a tiny `effectiveFit` instead of importing
  `store/meta`** — the render block is the only datum it needs, and the engine
  stays free of the store surface (it imports `store/opfs` only, for the
  checkpoint dir, the same documented exception `writers.js` uses).
- **Vendored-bundle quirk (worked around, bundle untouched):**
  `Input.dispose()` runs `void this._demuxerPromise?.then(d => d.dispose())`
  — on an input whose format detection REJECTED (unplayable file), that
  mints a fresh unhandled promise rejection → a console error on every
  unparseable pick. Since a format-less input has no demuxer to free,
  probe/cut/verify simply skip `dispose()` when `getFormat()` threw
  (`formatOk` flag). Harness-verified: corrupt inputs produce clean verdicts
  with zero console errors.

## Connections

- `../store/edl.js` journals what `probe.snapRemovalRange` computed; preview
  (Step 5 player.js) and export (Step 5 export.js → `cut.js` + `verify.js`)
  both consume the journal's folded keep-list, so they agree exactly.
- `../ingest.js` uses `probe` for clipmeta + degradation detection and
  `writers.normalizeBufferSource` for its copy pipe.
- `../bridge.js` imports `frames.extractFrames` BARE for the `view_frames`
  executor (Agent Vision). bridge.js gates on `caps.webcodecs.videoDecoder`
  (an unsupported device never calls in), fixes `maxEdgePx=512`/`quality=0.6`
  server-side, and wraps the `{frames,note?}` result into the relay's plan §5
  contract; `extractFrames` is stateless so the bare import is single-instance
  safe (no caches to split across the ?v=/bare seam).
- Step 5 export flow (lossless): `tempThenRename(exportsDir, name)` →
  `losslessCut` → `verifyOutput` → `commit()` → share sheet; on any failure
  `abandon()`.
- **(M3) Step 5 export flow (render):** when `cut.tierCheck` returns `"render"`,
  export.js gates on `capability.js` render-gate, holds the wake lock + crash
  marker, then calls `render.renderProject({projectId, fold, renderBlock,
  clips, music, sources, musicSources, transcripts, onProgress, signal})` →
  `{handle, stats, verdict}`. `render.js` does the checkpointed
  decode→compose→encode→mix→mux per segment, concats, and verifies (SDR-aware)
  internally, returning the committed `render/out-<ts>.mp4` handle (or a
  `.corrupt` handle + a non-`ok` verdict). export.js moves the verified output
  into `exports/` (or quarantines a corrupt one), then arms the share sheet —
  the same verify-before-share discipline as the lossless path. The fold
  (`store/edl.js`), the resolved canvas + fits (`store/meta.js` render block +
  `engine/canvas.js`), the music track Files (`store/music.js`
  `readTrackFile`), and the transcript word-times (`store/transcripts.js`) are
  what export.js assembles and hands in. `render.js` is dependency-pure
  (mediabunny + `webcodecs`/`compositor`/`audiomix`/`duck`/`verify` + `writers`
  + `store/opfs` for the checkpoint dir) — no DOM, no fetch, so it runs on
  desktop (M3 desktop mode) unchanged.
- M2 transcribe flow (T4 `transcribe.js` is the caller): `tempThenRename(
  transcriptsDir, "clip_<id>.m4a")` → `extractAudio` → read the `.tmp` back as
  a File → `api.uploadRaw` to the relay → `target.abandon()` (always — the
  `.m4a` is transient). Reuses `abandonOutput`/`engineError` from `writers.js`
  exactly like `cut.js`. `audio.js` imports only mediabunny + `writers.js`
  (transitively `store/opfs.js` via writers) — no DOM, no fetch.
