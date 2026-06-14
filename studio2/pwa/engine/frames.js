/* =============================================================================
   engine/frames.js — AGENT VISION still-frame extraction (plan 2026-06-13).
   -----------------------------------------------------------------------------
   The decode half of `view_frames`: the chat agent asks to SEE specific
   moments; this module decodes those frames on-device (mediabunny / WebCodecs,
   the M0-proven decode path), downscales + JPEG-encodes them, and returns
   small base64 stills the model can reason over. Nothing leaves the phone but
   the few JPEGs the model needs — same data-locality story as the rest of the
   engine (arch §9).

   Pure media machinery (engine rule, see engine/DOCUMENT.md): mediabunny only,
   NO DOM beyond OffscreenCanvas, NO fetch, NO app state, NO OPFS. Reads are
   LAZY (BlobSource) — the clip is never held in memory; one VideoSample is
   decoded, drawn, and CLOSED before the next time is requested.

   Memory is THE kill constraint (iOS). Every VideoSample/VideoFrame is
   `.close()`d immediately after it is drawn to the canvas — a decoded 4K frame
   is ~30 MiB of GPU/CPU memory, so leaking even a handful crashes the tab.
   The sink is created ONCE per call and the input disposed in `finally`.

   Rotation: portrait footage carries a container rotation (90/180/270). The
   VideoSample exposes ROTATION-AWARE `displayWidth`/`displayHeight` (already
   swapped for 90/270) and `VideoSample.draw()` APPLIES the rotation when it
   paints — so a portrait phone clip comes out UPRIGHT, not sideways. We size
   the canvas to the rotated display dimensions and let `draw()` do the
   transform; we never read codedWidth/codedHeight (those are pre-rotation).

   Errors carry `.code` ("engine_error") as a plain property (duck-typed — no
   instanceof across the ?v=/bare double-load boundary), exactly like cut.js /
   probe.js. The vendored-bundle dispose quirk (an Input whose format detection
   REJECTED mints an unhandled rejection on dispose()) is handled the same way
   probe.js handles it: dispose is skipped when getFormat() threw.
============================================================================= */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  VideoSampleSink,
} from "./mediabunny.js";
import { engineError } from "./writers.js";

/* ----- tunables (server-side fixed — the model cannot request bigger) ------- */
const DEFAULT_MAX_EDGE_PX = 512;   // long-edge ceiling of the returned JPEG
const DEFAULT_QUALITY = 0.6;       // primary JPEG quality
const FALLBACK_QUALITY = 0.4;      // re-encode quality when a frame is over budget
const MIN_QUALITY = 0.3;           // floor if the 0.4 pass is still over budget
const PER_FRAME_MAX_BYTES = 400 * 1024; // per-image base64 budget (plan §2)
const MAX_TIMES = 4;               // ≤4 frames/call (the relay enforces; we re-clamp)

function round2(n) {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/* base64 of a Blob WITHOUT a DataURL prefix, via FileReader (works in a
   Worker/OffscreenCanvas context; returns the raw base64 the relay wraps into
   an MCP image block). */
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked btoa to avoid "Maximum call stack" on large frames (apply spread
  // blows up past ~100k args). 0x8000 is the field-proven safe chunk.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* Encode one already-sized OffscreenCanvas to a JPEG base64, honoring the
   per-frame BASE64 budget (~400 KB — base64 is what travels in the JSON
   result, and what the 2 MiB bridge cap measures): q=quality → if over budget,
   q=FALLBACK → if STILL over, q=MIN. Returns {b64, bytes} where `bytes` is the
   ENCODED JPEG byte size (the actual image bytes, plan §5), while the budget
   decision is made on `b64.length` (base64 chars === UTF-8 bytes, ASCII). The
   attempt with the smallest base64 that fits the budget wins; if none fit, the
   smallest produced is returned (still bounded by the downscale; the bridge's
   overall 2 MiB cap is the final backstop). */
async function encodeWithBudget(canvas, quality) {
  const tries = [quality];
  if (quality > FALLBACK_QUALITY) tries.push(FALLBACK_QUALITY);
  else if (quality > MIN_QUALITY) tries.push(MIN_QUALITY);
  if (tries[tries.length - 1] > MIN_QUALITY) tries.push(MIN_QUALITY);

  let best = null; // {b64, bytes, b64len}
  for (const q of tries) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: q });
    const b64 = await blobToBase64(blob);
    const b64len = b64.length;
    const cand = { b64, bytes: blob.size, b64len };
    if (best === null || b64len < best.b64len) best = cand;
    if (b64len <= PER_FRAME_MAX_BYTES) return { b64: cand.b64, bytes: cand.bytes };
  }
  return { b64: best.b64, bytes: best.bytes };
}

/* Compute the target canvas size: long edge ≤ maxEdge, aspect preserved,
   integers ≥1. dispW/dispH are the ROTATION-AWARE display dimensions. */
function scaledSize(dispW, dispH, maxEdge) {
  const w = Math.max(1, Math.round(dispW) || 1);
  const h = Math.max(1, Math.round(dispH) || 1);
  const longEdge = Math.max(w, h);
  if (longEdge <= maxEdge) return { w, h };
  const scale = maxEdge / longEdge;
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Decode still frames at the requested times and return downscaled JPEGs.
 *
 * @param {File|Blob} file      the source clip (OPFS clip file).
 * @param {number[]}  times     1..4 timestamps in SOURCE-clip seconds (≥0).
 *                              Order is preserved in the result. Times past the
 *                              clip end are CLAMPED to just inside it and the
 *                              ACTUAL decoded time is reported in `at_s`.
 * @param {Object}    [opts]
 * @param {number}    [opts.maxEdgePx=512]  long-edge ceiling of each JPEG.
 * @param {number}    [opts.quality=0.6]    primary JPEG quality.
 * @param {AbortSignal} [opts.signal]       aborts a slow decode (the relay
 *                                           deadline; bridge.js wires it).
 * @returns {Promise<{frames:Array<{at_s,b64,w,h,bytes}>, note?:string}>}
 *          `note` is set only when something worth telling the model happened
 *          (a time was clamped, or a frame was skipped because no sample
 *          existed). On a hard failure this THROWS engineError (the bridge
 *          executor maps it to {error:{code:"engine_error",message}}).
 */
export async function extractFrames(file, times, opts = {}) {
  const maxEdge = Number.isFinite(opts.maxEdgePx) && opts.maxEdgePx >= 16
    ? Math.floor(opts.maxEdgePx) : DEFAULT_MAX_EDGE_PX;
  const quality = Number.isFinite(opts.quality) && opts.quality > 0 && opts.quality <= 1
    ? opts.quality : DEFAULT_QUALITY;
  const signal = opts.signal;

  const isBlob = typeof Blob !== "undefined" && file instanceof Blob;
  if (!isBlob) throw engineError("a clip file is required to read frames");
  if (typeof OffscreenCanvas === "undefined") {
    throw engineError("this device cannot render frames (no OffscreenCanvas)");
  }

  // Defensive: clean, finite, ≥0 times, ≤MAX_TIMES (the relay already caps;
  // the device is the data owner and never trusts the relay blindly).
  const requested = (Array.isArray(times) ? times : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= 0)
    .slice(0, MAX_TIMES);
  if (requested.length === 0) {
    throw engineError("view_frames needs 1-4 finite times >= 0");
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let formatOk = false; // see dispose note at end (probe.js quirk parity)
  const notes = [];

  try {
    await input.getFormat();
    formatOk = true;
    const duration = await input.computeDuration(); // seconds (may be null)
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw engineError("this clip has no video track to read frames from");
    if (!(await track.canDecode())) {
      // A real per-track decodability failure (unsupported codec on THIS
      // browser) — distinct from the device-wide caps gate bridge.js applies.
      throw engineError("this device cannot decode this clip's video");
    }

    const sink = new VideoSampleSink(track);

    // Clamp each time to just inside the clip end so a past-the-end ask still
    // decodes the LAST frame rather than returning nothing. A tiny epsilon
    // keeps us strictly inside the final frame's presentation interval.
    let clampedAny = false;
    const seekTimes = requested.map((t) => {
      if (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && t > duration - 0.05) {
        clampedAny = true;
        return Math.max(0, duration - 0.05);
      }
      return t;
    });
    if (clampedAny) notes.push("some times were past the clip end and were clamped to the last frame");

    const frames = [];
    let skipped = 0;

    for (let i = 0; i < seekTimes.length; i++) {
      if (signal && signal.aborted) throw engineError("reading frames timed out");

      // getSample(t): the last sample (presentation order) with start ≤ t.
      // mediabunny seeks to the preceding keyframe and decodes forward
      // internally — the M0 decode pattern. Returns null only when t precedes
      // the very first frame (t≈0 on a clip whose first PTS > 0).
      let sample = null;
      try {
        sample = await sink.getSample(Math.max(0, seekTimes[i]));
      } catch (err) {
        // A decode failure on one time should not sink the whole call if
        // others succeed; record and continue. (A wholesale decoder failure
        // surfaces on every time → frames stays empty → we throw below.)
        sample = null;
      }
      if (!sample) { skipped++; continue; }

      try {
        // ROTATION-AWARE display dims: 90/270 already swap W/H, so a portrait
        // clip yields a portrait (taller-than-wide) target here.
        const { w, h } = scaledSize(sample.displayWidth, sample.displayHeight, maxEdge);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw engineError("could not get a 2D canvas context");
        // draw(ctx, dx, dy, dWidth, dHeight) — APPLIES this.rotation internally
        // (mediabunny rotates+scales around the destination center), so the
        // painted pixels are upright and fit the rotated-display-sized canvas.
        sample.draw(ctx, 0, 0, w, h);
        const at = round2(sample.timestamp);

        // Dispose the decoded frame NOW — before the (async) JPEG encode — so
        // peak memory is one decoded frame, never N.
        sample.close();
        sample = null;

        const { b64, bytes } = await encodeWithBudget(canvas, quality);
        frames.push({ at_s: at, b64, w, h, bytes });
      } finally {
        if (sample) { try { sample.close(); } catch { /* already closed */ } }
      }
    }

    if (frames.length === 0) {
      throw engineError("no frames could be read at the requested times");
    }
    if (skipped > 0) {
      notes.push(
        skipped === 1
          ? "one requested time had no frame (before the clip's first frame) and was skipped"
          : `${skipped} requested times had no frame and were skipped`,
      );
    }

    const out = { frames };
    if (notes.length > 0) out.note = notes.join("; ");
    return out;
  } finally {
    // Vendored-bundle quirk parity (engine/DOCUMENT.md): disposing an Input
    // whose format detection REJECTED mints an unhandled rejection — skip it.
    if (formatOk) {
      try { input.dispose(); } catch { /* already disposed */ }
    }
  }
}
