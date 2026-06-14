/* =============================================================================
   engine/compositor.js — the per-frame GPU/canvas COMPOSITOR (arch §6 / §6.4.2).
   -----------------------------------------------------------------------------
   Turns ONE decoded source frame into ONE output frame at the resolved canvas
   WxH, applying — in order — the three transforms mixed orientation + format
   normalization needs:

     1. ROTATION. Safari has NO `VideoFrame.rotation` (M0 fact) — the container
        rotation (90/180/270, portrait phone footage) must be applied MANUALLY
        or the clip comes out sideways. This is THE recurring bug in this repo
        (commit 1200463). mediabunny's `VideoSample.draw(ctx,…)` APPLIES the
        sample's rotation when it paints (the frames.js-proven path), and the
        sample's `displayWidth/displayHeight` are already rotation-swapped — so
        we reason about the UPRIGHT display rectangle and let draw() rotate.

     2. FIT onto the canvas (arch §3.2):
        • contain — scale to fit ENTIRELY inside the canvas (letterbox/pillarbox),
          preserving aspect; bars filled by the BACKGROUND:
            – "blur" (default, plan §0.1): the SAME frame scaled to COVER the
              canvas, heavily blurred + darkened, drawn behind the sharp
              contained frame — makes a portrait clip on a landscape canvas (or
              vice-versa) look intentional, not bar-heavy.
            – "black": solid black bars (cheapest, deterministic).
        • cover — scale to COVER the whole canvas, center-crop the overflow.
          No bars, edges lost.

     3. HDR → SDR tone-map (arch §0/§1, honest limit). iPhone capture is 10-bit
        HDR (BT.2020 PQ/HLG); no browser encodes 10-bit, so the output is SDR
        (BT.709). When the source is HDR we apply a tone-map. The 2D path's
        honest approximation: the browser already decodes HDR frames to the
        canvas color space (sRGB) when we draw them, so the heavy lifting is the
        browser's; we additionally apply a mild Reinhard-style highlight
        roll-off + small desaturation via a per-frame filter so blown
        highlights don't clip harshly. (A future WebGPU/WebGL2 path can do a
        proper PQ→BT.709 shader — noted as a seam; the 2D path is the always-
        correct baseline and is what ships, since the gate steers GPU-less
        devices to desktop anyway.)

   ONE reused OffscreenCanvas per render (allocated once in the constructor),
   plus one scratch canvas for the blurred-fill pass — NOT per frame (arch
   §6.4.4 memory discipline). The compositor never holds a decoded frame: the
   caller decodes, calls composeFrame(), then `.close()`s the sample.

   DOM-free: OffscreenCanvas only (works in a Worker too). No fetch, no OPFS, no
   app state. Errors carry `.code="engine_error"` (duck-typed).

   The output is read back by the encoder via the SHARED OffscreenCanvas the
   constructor exposes as `.canvas` — `engine/render.js` builds a mediabunny
   `CanvasSource` over exactly this canvas, so composeFrame() draws and the
   encoder snapshots the same surface (one allocation, no copy).
============================================================================= */

import { engineError } from "./writers.js";

const FIT_MODES = new Set(["contain", "cover"]);
const BACKGROUNDS = new Set(["blur", "black"]);

/* Blurred-fill tuning (arch §3.2). The background copy is cover-scaled, heavily
   blurred and darkened so the sharp foreground reads clearly over it. */
const BLUR_RADIUS_PX = 28;      // gaussian radius for the fill (2D canvas filter)
const BLUR_DARKEN = 0.45;       // 0..1 — how much the blurred fill is dimmed
const BLUR_DOWNSCALE = 0.25;    // render the blur copy at 1/4 size then upscale
                                //   (a cheap, near-identical-looking speedup —
                                //   the result is blurred anyway)

/* HDR→SDR tone-map filter applied when the source is HDR. Mild: the browser's
   own HDR→sRGB decode does most of it; this rolls highlights and pulls a touch
   of saturation so re-encoded HDR doesn't clip. Kept conservative — over-
   correcting looks worse than the browser's native mapping. */
const HDR_FILTER = "brightness(0.96) saturate(0.94) contrast(0.98)";

/**
 * Build a compositor bound to a fixed output canvas.
 *
 * @param {Object} canvas  the RESOLVED canvas { width, height, background } —
 *                         engine/canvas.js resolveCanvas() output. `background`
 *                         is the project default; a per-clip fit can override.
 * @returns {Object} {
 *   canvas,            // the reused OffscreenCanvas (the encoder draws FROM it)
 *   backend,           // "2d" (the implemented path) — future "webgl2"/"webgpu"
 *   composeFrame(sample, fit),  // draw one frame; see below
 *   clear(),           // paint the canvas black (between segments / on a gap)
 *   dispose(),         // drop the scratch canvas reference
 * }
 *
 * Throws engineError when OffscreenCanvas / 2D context is unavailable (a device
 * that cannot composite — the gate steers it to desktop).
 */
export function createCompositor(canvas) {
  const width = Math.round(canvas && canvas.width);
  const height = Math.round(canvas && canvas.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw engineError("compositor needs a valid canvas size (got " + width + "×" + height + ")");
  }
  if (typeof OffscreenCanvas === "undefined") {
    throw engineError("this device cannot composite frames (no OffscreenCanvas)");
  }

  const defaultBackground = BACKGROUNDS.has(canvas && canvas.background) ? canvas.background : "blur";

  // THE reused output canvas — one allocation for the whole render.
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw engineError("could not get a 2D canvas context for compositing");

  // One scratch canvas for the blurred-fill pass (downscaled), reused.
  const scratchW = Math.max(1, Math.round(width * BLUR_DOWNSCALE));
  const scratchH = Math.max(1, Math.round(height * BLUR_DOWNSCALE));
  let scratch = new OffscreenCanvas(scratchW, scratchH);
  let scratchCtx = scratch.getContext("2d", { alpha: false });

  /* Compute the destination rectangle for a fit. The source display rectangle
     is (dispW × dispH) — already ROTATION-AWARE (90/270 swapped). Returns
     {dx, dy, dw, dh} in canvas pixels; for "cover" the rect overflows the
     canvas (clipped to it), for "contain" it sits inside. */
  function fitRect(dispW, dispH, mode) {
    const sAspect = dispW / dispH;
    const cAspect = width / height;
    let dw;
    let dh;
    if (mode === "cover") {
      // Scale so the SHORTER source edge fills — overflow is cropped.
      if (sAspect > cAspect) { dh = height; dw = height * sAspect; }
      else { dw = width; dh = width / sAspect; }
    } else {
      // contain: scale so the LONGER source edge fits — bars remain.
      if (sAspect > cAspect) { dw = width; dh = width / sAspect; }
      else { dh = height; dw = height * sAspect; }
    }
    return {
      dx: Math.round((width - dw) / 2),
      dy: Math.round((height - dh) / 2),
      dw: Math.round(dw),
      dh: Math.round(dh),
    };
  }

  /* Draw the blurred-fill background: the frame cover-scaled into the scratch
     canvas, then drawn blurred + darkened across the full output. Using the
     downscaled scratch then upscaling with a filter is both cheaper and gives
     a smoother blur than filtering at full size. */
  function drawBlurredFill(sample, dispW, dispH) {
    // Cover-fit the sample into the small scratch canvas.
    const sAspect = dispW / dispH;
    const cAspect = scratchW / scratchH;
    let dw;
    let dh;
    if (sAspect > cAspect) { dh = scratchH; dw = scratchH * sAspect; }
    else { dw = scratchW; dh = scratchW / sAspect; }
    const dx = Math.round((scratchW - dw) / 2);
    const dy = Math.round((scratchH - dh) / 2);
    scratchCtx.filter = "none";
    scratchCtx.clearRect(0, 0, scratchW, scratchH);
    // VideoSample.draw applies rotation; sizing to the rotated display rect.
    sample.draw(scratchCtx, dx, dy, Math.round(dw), Math.round(dh));

    // Upscale the small frame across the whole output, blurred + darkened.
    ctx.save();
    ctx.filter = "blur(" + BLUR_RADIUS_PX + "px)";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(scratch, 0, 0, scratchW, scratchH, -BLUR_RADIUS_PX, -BLUR_RADIUS_PX,
      width + BLUR_RADIUS_PX * 2, height + BLUR_RADIUS_PX * 2);
    ctx.filter = "none";
    // Darken so the sharp foreground stands out.
    ctx.fillStyle = "rgba(0,0,0," + BLUR_DARKEN + ")";
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /**
   * Compose ONE decoded sample onto the output canvas.
   *
   * @param {VideoSample} sample  a mediabunny VideoSample (rotation-aware
   *                              displayWidth/displayHeight; draw() applies the
   *                              container rotation). The CALLER closes it after.
   * @param {Object} [fit]  { mode:"contain"|"cover", background?:"blur"|"black",
   *                         hdr?:boolean } — per-clip fit (store/meta effectiveFit
   *                         shape) + whether the SOURCE is HDR (tone-map gate).
   *                         Defaults: mode "contain", background the canvas
   *                         default, hdr false.
   * @returns {boolean} true (drawn). Never throws on a normal frame; a hard
   *                    draw failure throws engineError so the render aborts
   *                    cleanly rather than muxing a black hole.
   */
  function composeFrame(sample, fit = {}) {
    if (!sample) throw engineError("compositor got no frame to draw");
    const mode = FIT_MODES.has(fit.mode) ? fit.mode : "contain";
    const background = BACKGROUNDS.has(fit.background) ? fit.background : defaultBackground;
    const isHdr = !!fit.hdr;

    // Rotation-aware display dims (90/270 already swapped by mediabunny).
    const dispW = Math.max(1, Math.round(sample.displayWidth) || 1);
    const dispH = Math.max(1, Math.round(sample.displayHeight) || 1);

    try {
      // 1. Background. cover never shows bars, so it gets a plain black base
      //    (covered immediately). contain gets black bars OR a blurred fill.
      ctx.filter = "none";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      if (mode === "contain" && background === "blur") {
        drawBlurredFill(sample, dispW, dispH);
      }

      // 2. The sharp foreground frame, fit onto the canvas.
      const r = fitRect(dispW, dispH, mode);

      ctx.save();
      if (mode === "cover") {
        // Clip to the canvas so the cropped overflow is discarded.
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
      }
      // 3. HDR→SDR roll-off filter on the foreground only (the blurred fill is
      //    already dimmed; double-filtering it wastes time).
      ctx.filter = isHdr ? HDR_FILTER : "none";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // VideoSample.draw(ctx, dx, dy, dWidth, dHeight) — APPLIES rotation,
      // so portrait footage paints UPRIGHT into the upright display rect.
      sample.draw(ctx, r.dx, r.dy, r.dw, r.dh);
      ctx.filter = "none";
      ctx.restore();
      return true;
    } catch (err) {
      throw engineError("failed to composite a frame: " + (err && err.message ? err.message : String(err)));
    }
  }

  /** Paint the whole canvas black — used between segments and when a decode gap
      leaves no frame to hold. */
  function clear() {
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  }

  function dispose() {
    scratch = null;
    scratchCtx = null;
  }

  return {
    canvas: out,
    backend: "2d",
    composeFrame,
    clear,
    dispose,
    width,
    height,
  };
}
