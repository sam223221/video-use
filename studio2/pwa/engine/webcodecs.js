/* =============================================================================
   engine/webcodecs.js — bounded codec config + capability helpers for the
   RENDER tier (arch §6.2 / §6.4.2 "engine/webcodecs.js").
   -----------------------------------------------------------------------------
   PURE media-codec helpers: mediabunny + the WebCodecs probe surface only. NO
   DOM, NO fetch, NO OPFS, NO app state — same discipline as cut.js/probe.js, so
   the render engine stays reusable on desktop (M3 desktop mode) unmodified.

   This module is the single place codec CHOICE + ENCODER CONFIG happen, kept
   apart from the heavy compositor/audiomix machinery so the policy (which codec,
   what bitrate, which probe) is one small auditable file. Three jobs:

   1. CODEC SELECTION (probe-driven, banked #8 — NO UA/iOS-version sniff):
      pickVideoEncoderConfig(canvas) prefers HEVC (`hevc` → `hvc1.*`, smaller +
      Safari is the one browser with reliable HEVC encode, arch §11.7) and falls
      back to H.264 (`avc` → `avc1.*`) — chosen by mediabunny's `canEncodeVideo`
      at the EXACT output WxH (which wraps `VideoEncoder.isConfigSupported`).
      The bitrate ladder is keyed by pixels×fps. pickAudioEncoderConfig() is
      AAC-LC, 48 kHz, stereo, ~160 kbps (arch §6.4.2).

   2. BOUNDED DECODE windows (memory is THE iOS-kill constraint — arch §10):
      decodeVideoWindow()/decodeAudioWindow() wrap mediabunny's
      VideoSampleSink.samples()/AudioBufferSink.buffers() — sequential,
      pre-decode-a-few-ahead iterators that NEVER buffer a whole clip. The
      caller drains them and `.close()`s each VideoSample immediately after
      compositing (the frames.js discipline). Nothing here holds a frame.

   3. SOURCE OPEN: openVideoForDecode()/openAudioForDecode() open one mediabunny
      Input per source File and hand back the sink + the rotation/HDR/display
      facts the compositor needs — the probe.js facts, read once.

   Mediabunny does the actual WebCodecs orchestration (VideoEncoderWrapper /
   AudioEncoderWrapper drive VideoEncoder/AudioEncoder with internal bounded
   queues + dequeue backpressure; the Source.add() promise IS the backpressure
   signal the caller awaits). We never touch a bare VideoEncoder/VideoDecoder —
   the bundle's queue discipline is the field-proven path and keeps one place
   responsible for the encoder lifecycle.

   A codec PROBE that throws is fail-safe: treated as "unsupported" (the gate
   verdict is unchanged). When the thrown error is NOT a NotSupportedError (the
   normal "codec unavailable" signal) — e.g. a transient OOM/quota error — the
   true error name/message is logged at `warn` via the loose-coupled diag
   singleton (window.__studio2Diag, never a static diag.js import — the engine
   stays DOM/fetch-free), so a gate-fail with the wrong cause is no longer
   invisible. Diagnostics can never break the probe (the dlog is fully guarded).

   Errors carry `.code` ("engine_error") as a plain property (duck-typed — no
   instanceof across the ?v= double-load boundary), like every engine module.
   The vendored-bundle dispose quirk (an Input whose format detection REJECTED
   mints an unhandled rejection on dispose()) is handled exactly as probe.js:
   dispose is skipped when getFormat() threw (`formatOk`).
============================================================================= */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  VideoSampleSink,
  AudioBufferSink,
  canEncodeVideo,
  canEncodeAudio,
} from "./mediabunny.js";
import { engineError } from "./writers.js";

/* Diagnostics: the loose-coupled diag singleton (window.__studio2Diag), NEVER a
   static import of diag.js — the engine stays DOM/fetch/app-state free and
   reusable on desktop (M3 desktop mode) unmodified, exactly like ingest.js /
   store/edl.js. A no-op in non-browser/test/desktop contexts where diag isn't
   installed; wrapped so a diagnostics failure can NEVER break a codec probe. */
function dlog(level, msg, data) {
  try {
    const d = typeof window !== "undefined" && window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* diagnostics never break the engine */ }
}

/* Treat a thrown probe error as "this codec isn't supported" (the fail-safe
   gate verdict) and, when the cause is NOT the expected NotSupportedError,
   emit an honest diag warning carrying the real error name/message so a
   transient OOM/quota failure is distinguishable from a genuine "unavailable"
   in the client log. Returns false (unsupported) ALWAYS — the gate behavior is
   unchanged; only the visibility of the true cause is added. */
function probeUnsupported(err, codec, dims) {
  const name = (err && (err.name || (err.constructor && err.constructor.name))) || "Error";
  if (name !== "NotSupportedError") {
    dlog("warn", "engine.probe.error", {
      codec,
      ...(dims || {}),
      error: name,
      message: String((err && err.message) || err || "").slice(0, 300),
    });
  }
  return false;
}

/* ----- codec policy ------------------------------------------------------------ */

/* The output video codec PREFERENCE order (arch §0.4 / §11.7): HEVC first
   (smaller, the design's lean; the user receives HEVC, fine on Apple), H.264
   second (universal). These are mediabunny's codec ids — the bundle maps them
   to the concrete `hvc1.*` / `avc1.*` codec strings the muxer writes. */
export const VIDEO_CODEC_PREFERENCE = ["hevc", "avc"];

/* AAC-LC, the one audio codec we encode to (arch §6.4.2): 48 kHz stereo,
   ~160 kbps — universally playable, what every social target expects. */
export const AUDIO_CODEC = "aac";
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 160_000;

/* GOP / keyframe interval (seconds). 2 s is the recording-norm GOP and keeps
   the concat-at-the-end packet-copy keyframe-aligned per segment. */
const KEYFRAME_INTERVAL_S = 2;

/**
 * Video bitrate ladder (bits/s) by output pixels × fps. Chosen for the M3
 * ≤1080p sweet spot: a 1080×1920 / 30 fps portrait lands ~8 Mbps (visually
 * clean for re-encoded phone footage without bloating the output), a 720p
 * ~4.5 Mbps, scaled by fps above 30. Returns an integer.
 */
export function bitrateFor(width, height, fps) {
  const px = Math.max(1, Math.round(width) * Math.round(height));
  const f = Math.max(1, Math.round(fps) || 30);
  // ~0.13 bits per pixel per frame at 30 fps — a solid quality/size point for
  // re-encoded H.264/HEVC; HEVC will look better at the same number, which is
  // a free win (we keep one ladder for both — simpler, and HEVC just benefits).
  const bitsPerPixelPerSecondAt30 = 0.13;
  const raw = px * bitsPerPixelPerSecondAt30 * (f / 30) * 30;
  // Clamp to a sane window so a degenerate canvas can't ask for an absurd rate.
  const MIN = 1_500_000;       // 1.5 Mbps floor (even a tiny canvas stays clean)
  const MAX = 16_000_000;      // 16 Mbps ceiling (the on-device budget)
  return Math.round(Math.min(MAX, Math.max(MIN, raw)));
}

/**
 * Pick the output VIDEO encoder config for a resolved canvas — probe-driven,
 * NO UA sniff (banked #8). Tries each codec in VIDEO_CODEC_PREFERENCE at the
 * EXACT output WxH via mediabunny `canEncodeVideo` (which wraps
 * `VideoEncoder.isConfigSupported`), returns the first supported one as a
 * mediabunny VideoEncodingConfig.
 *
 * @param {Object} canvas  resolved canvas { width, height, fps } (engine/canvas).
 * @returns {Promise<Object>} {
 *            codec,                 // "hevc" | "avc" (mediabunny id)
 *            bitrate,               // bits/s
 *            keyFrameInterval,      // seconds
 *            latencyMode: "quality",
 *            sizeChangeBehavior: "contain",  // belt+braces: a stray off-size
 *                                            //   sample is letterboxed, never
 *                                            //   stretched (we always feed the
 *                                            //   exact canvas size anyway).
 *          }  — the object passed straight to `new CanvasSource(canvas, cfg)`
 *             / `new VideoSampleSource(cfg)`.
 *
 * Throws engineError when NEITHER HEVC nor H.264 can encode at this size (a
 * gated device — the caps gate should have caught it; this is the engine's
 * own second guard).
 */
export async function pickVideoEncoderConfig(canvas) {
  const width = Math.round(canvas.width);
  const height = Math.round(canvas.height);
  const fps = Math.max(1, Math.round(canvas.fps) || 30);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw engineError("the output canvas has invalid dimensions (" + canvas.width + "×" + canvas.height + ")");
  }
  const bitrate = bitrateFor(width, height, fps);

  let chosen = null;
  for (const codec of VIDEO_CODEC_PREFERENCE) {
    let ok = false;
    try {
      ok = await canEncodeVideo(codec, { width, height, bitrate });
    } catch (err) {
      // A probe that throws is treated as "not supported" (fail-safe gate). A
      // NotSupportedError is the normal "codec unavailable" signal; ANY other
      // error (e.g. transient OOM/quota) is logged with its true cause so the
      // gate-fail isn't silently misattributed — but still fails safe.
      ok = probeUnsupported(err, codec, { width, height, bitrate });
    }
    if (ok) { chosen = codec; break; }
  }
  if (!chosen) {
    throw engineError(
      "this device can't encode video at " + width + "×" + height +
      " — rendering needs H.264 or HEVC encode support (it isn't available here)"
    );
  }
  return {
    codec: chosen,
    bitrate,
    keyFrameInterval: KEYFRAME_INTERVAL_S,
    latencyMode: "quality",
    sizeChangeBehavior: "contain",
  };
}

/**
 * Pick the output AUDIO encoder config — AAC-LC, 48 kHz stereo, ~160 kbps
 * (arch §6.4.2). Probes `canEncodeAudio("aac", …)` so a device without AAC
 * encode fails cleanly here rather than mid-mux.
 *
 * @returns {Promise<Object>} a mediabunny AudioEncodingConfig {
 *            codec:"aac", bitrate, sampleRate, numberOfChannels }.
 */
export async function pickAudioEncoderConfig() {
  let ok = false;
  try {
    ok = await canEncodeAudio(AUDIO_CODEC, {
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: AUDIO_BITRATE,
    });
  } catch (err) {
    // Same honesty as the video probe: NotSupportedError is the normal "no AAC
    // encode" signal; any other error is logged with its true cause but still
    // fails safe (treated as unsupported).
    ok = probeUnsupported(err, AUDIO_CODEC, {
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
    });
  }
  if (!ok) {
    throw engineError("this device can't encode AAC audio — rendering needs it (it isn't available here)");
  }
  return {
    codec: AUDIO_CODEC,
    bitrate: AUDIO_BITRATE,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
  };
}

/* ----- source open (decode) ---------------------------------------------------- */

/** Round-trip a thrown platform error into the bridge taxonomy without losing
    an explicit engine_error. */
function tagOpenError(err) {
  if (err && typeof err.code === "string") return err;
  return engineError("this file can't be opened as a video — its container isn't recognized");
}

/**
 * Open one clip File for VIDEO decode and gather the compositor's inputs.
 * ALWAYS call the returned `.dispose()` in a finally.
 *
 * @param {Blob} file  the OPFS clip File/Blob.
 * @returns {Promise<Object>} {
 *            input,                 // the mediabunny Input (dispose owns it)
 *            track,                 // primary video InputVideoTrack
 *            sink: VideoSampleSink, // for decodeVideoWindow()
 *            duration_s,            // computed duration (may be null)
 *            rotation,              // container rotation 0|90|180|270
 *            codedWidth, codedHeight,
 *            displayWidth, displayHeight,   // ROTATION-AWARE (the compositor sizes to these)
 *            hdr,                   // boolean — the compositor tone-maps when true
 *            colorPrimaries, colorTransfer, colorMatrix, fullRange,
 *            dispose(),             // disposes the Input (quirk-safe)
 *          }
 */
export async function openVideoForDecode(file) {
  const isBlob = typeof Blob !== "undefined" && file instanceof Blob;
  if (!isBlob) throw engineError("a clip File/Blob is required to decode video");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let formatOk = false;
  try {
    await input.getFormat();
    formatOk = true;
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw engineError("this clip has no video track to render");
    if (!(await track.canDecode())) {
      throw engineError("this device cannot decode this clip's video");
    }
    const color = await track.getColorSpace();
    const duration = await input.computeDuration();
    const facts = {
      input,
      track,
      sink: new VideoSampleSink(track),
      duration_s: typeof duration === "number" ? duration : null,
      rotation: await track.getRotation(),
      codedWidth: await track.getCodedWidth(),
      codedHeight: await track.getCodedHeight(),
      displayWidth: await track.getDisplayWidth(),
      displayHeight: await track.getDisplayHeight(),
      hdr: await track.hasHighDynamicRange(),
      colorPrimaries: color.primaries || null,
      colorTransfer: color.transfer || null,
      colorMatrix: color.matrix || null,
      fullRange: color.fullRange === undefined ? null : color.fullRange,
      dispose() {
        if (!formatOk) return;
        try { input.dispose(); } catch { /* already disposed */ }
      },
    };
    return facts;
  } catch (err) {
    if (formatOk) { try { input.dispose(); } catch { /* dead */ } }
    throw tagOpenError(err);
  }
}

/**
 * Open one source File (a clip OR a music track) for AUDIO decode. Returns null
 * facts.sink when the file has no audio track (a video clip with no sound, or a
 * music file that didn't parse as audio) — the caller treats that as silence.
 * ALWAYS call `.dispose()` in a finally.
 *
 * @param {Blob} file
 * @returns {Promise<Object>} {
 *            input,
 *            track,                 // primary audio InputAudioTrack | null
 *            sink: AudioBufferSink|null,
 *            duration_s,            // computed duration (may be null)
 *            sampleRate, channels,  // source rate/channels (null when no audio)
 *            dispose(),
 *          }
 */
export async function openAudioForDecode(file) {
  const isBlob = typeof Blob !== "undefined" && file instanceof Blob;
  if (!isBlob) throw engineError("a File/Blob is required to decode audio");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let formatOk = false;
  try {
    await input.getFormat();
    formatOk = true;
    const track = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    let sink = null;
    let sampleRate = null;
    let channels = null;
    if (track && (await track.canDecode())) {
      sink = new AudioBufferSink(track);
      sampleRate = await track.getSampleRate();
      channels = await track.getNumberOfChannels();
    }
    return {
      input,
      track: sink ? track : null,
      sink,
      duration_s: typeof duration === "number" ? duration : null,
      sampleRate,
      channels,
      dispose() {
        if (!formatOk) return;
        try { input.dispose(); } catch { /* already disposed */ }
      },
    };
  } catch (err) {
    if (formatOk) { try { input.dispose(); } catch { /* dead */ } }
    throw tagOpenError(err);
  }
}

/* ----- bounded decode windows -------------------------------------------------- */

/**
 * A bounded async iterator of decoded VideoSamples covering [startTime, endTime)
 * in SOURCE-clip seconds — mediabunny pre-decodes a few ahead and no more, so a
 * whole clip is NEVER in memory. The caller MUST `.close()` each yielded sample
 * the instant it has been composited (frames.js discipline) — this helper does
 * not retain references.
 *
 * @param {Object} videoFacts  an openVideoForDecode() result.
 * @param {number} startTime   inclusive, source seconds.
 * @param {number} endTime     exclusive, source seconds.
 * @returns {AsyncIterable<VideoSample>}  (samples may be null at a gap — the
 *                                        compositor holds the last drawn frame.)
 */
export function decodeVideoWindow(videoFacts, startTime, endTime) {
  return videoFacts.sink.samples(Math.max(0, startTime), endTime);
}

/**
 * A bounded async iterator of decoded audio buffers covering [startTime,
 * endTime) in SOURCE seconds. Yields `{buffer: AudioBuffer, timestamp,
 * duration}` (timestamp/duration in seconds); the underlying AudioSample is
 * closed by mediabunny after each yield. Never buffers the whole track.
 *
 * @param {Object} audioFacts  an openAudioForDecode() result (sink must be non-null).
 * @param {number} startTime
 * @param {number} endTime
 * @returns {AsyncIterable<{buffer:AudioBuffer, timestamp:number, duration:number}>}
 */
export function decodeAudioWindow(audioFacts, startTime, endTime) {
  if (!audioFacts || !audioFacts.sink) {
    throw engineError("no audio track to decode");
  }
  return audioFacts.sink.buffers(Math.max(0, startTime), endTime);
}
