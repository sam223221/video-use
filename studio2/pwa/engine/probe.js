/* =============================================================================
   engine/probe.js — file analysis + keyframe queries (arch §6.4, §5.3).
   -----------------------------------------------------------------------------
   Pure media machinery: imports only mediabunny, no DOM, no fetch, no OPFS.
   Reads are LAZY (BlobSource) — a clip is never held in memory (arch §9).

   Three consumers (arch §6.4):
     • ingest.js   — analyzeFile() feeds clipmeta + degradation detection;
                     gopEstimate() feeds keyframe_spacing_s_estimate.
     • apply_cuts  — keyframeBefore()/keyframeAfter()/snapRemovalRange()
                     implement the §5.3 snapping contract at EDIT time, so
                     preview and export agree exactly.
     • describe_clip — gopEstimate() so the model can reason about snap
                     granularity.

   openProbe(file) returns a SESSION holding one mediabunny Input open, so a
   multi-boundary apply_cuts pays the parse cost once. The one-shot wrappers
   (analyzeFile, keyframeBefore, …) open and dispose a session per call.

   Errors thrown here carry .code "engine_error" (duck-typed — see
   writers.errorCode; no instanceof across the ?v= double-load boundary).
   analyzeFile NEVER throws on unparseable input — it returns
   { …, parseError } so ingest can show a clean "not a playable video" card.
============================================================================= */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  EncodedPacketSink,
} from "./mediabunny.js";
import { engineError } from "./writers.js";

const KEY_OPTS = { verifyKeyPackets: true };
const GOP_SCAN_PACKETS = 120;   // bounded scan (spike's computePacketStats(120) approach)
const MAX_KEY_HOPS = 256;       // keyframeAfter forward-iteration bound (≈ minutes of GOPs)

function round2(n) { return Math.round(n * 100) / 100; }

function errText(e) {
  if (!e) return "unknown error";
  const name = e.name || (e.constructor && e.constructor.name) || "Error";
  return name + ": " + (e.message || String(e));
}

/* ----- the probe session -------------------------------------------------------- */

/** Open one mediabunny Input over `file` and answer probe queries against it.
    ALWAYS dispose(): `const p = await openProbe(f); try { … } finally { p.dispose(); }`.
    Never throws on unparseable input — `parseError` is set instead and the
    keyframe/gop queries then throw a clean engine_error. */
export async function openProbe(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let container = null;
  let duration = null;
  let videoTrack = null;
  let audioTrack = null;
  let parseError = null;
  let vSink = null;
  let formatOk = false; // see dispose() below

  try {
    const format = await input.getFormat();
    formatOk = true;
    container = format.name;
    duration = await input.computeDuration();
    videoTrack = await input.getPrimaryVideoTrack();
    audioTrack = await input.getPrimaryAudioTrack();
    if (videoTrack) vSink = new EncodedPacketSink(videoTrack);
  } catch (e) {
    parseError = errText(e);
  }

  function requireVideo() {
    if (parseError) throw engineError("the file does not parse as a video (" + parseError + ")");
    if (!vSink) throw engineError("no video track found in this clip");
  }

  return {
    get container() { return container; },
    get duration_s() { return duration; },
    get parseError() { return parseError; },
    get hasVideo() { return !!videoTrack; },
    get hasAudio() { return !!audioTrack; },

    /** Full clipmeta-shaped analysis (arch §5.1 probe portion). Never throws. */
    async analyze() {
      const meta = {
        container,
        duration_s: duration == null ? null : round2(duration),
        video: null,
        audio: null,
      };
      if (parseError) {
        meta.parseError = parseError;
        return meta;
      }
      try {
        if (videoTrack) {
          const stats = await videoTrack.computePacketStats(GOP_SCAN_PACKETS);
          const color = await videoTrack.getColorSpace();
          meta.video = {
            codec: await videoTrack.getCodec(),
            codecString: await videoTrack.getCodecParameterString(),
            codedWidth: await videoTrack.getCodedWidth(),
            codedHeight: await videoTrack.getCodedHeight(),
            displayWidth: await videoTrack.getDisplayWidth(),
            displayHeight: await videoTrack.getDisplayHeight(),
            rotation: await videoTrack.getRotation(),
            fps: round2(stats.averagePacketRate),
            averageBitrate: Math.round(stats.averageBitrate),
            hdr: await videoTrack.hasHighDynamicRange(),
            colorPrimaries: color.primaries || null,
            colorTransfer: color.transfer || null,
            colorMatrix: color.matrix || null,
            fullRange: color.fullRange === undefined ? null : color.fullRange,
          };
        }
        if (audioTrack) {
          meta.audio = {
            codec: await audioTrack.getCodec(),
            codecString: await audioTrack.getCodecParameterString(),
            channels: await audioTrack.getNumberOfChannels(),
            sampleRate: await audioTrack.getSampleRate(),
          };
        }
      } catch (e) {
        meta.parseError = errText(e);
      }
      return meta;
    },

    /** Timestamp (s) of the last verified key packet at/before `t`, or null
        when no key packet exists at/before `t` (callers map null → 0 for
        remove-biased growth — §5.3). */
    async keyframeBefore(t) {
      requireVideo();
      const k = await vSink.getKeyPacket(Math.max(0, t), KEY_OPTS);
      return k ? k.timestamp : null;
    },

    /** Timestamp (s) of the first verified key packet at/after `t`, or null
        when none exists (callers map null → clip end — §5.3). Bounded forward
        iteration from the key at/before `t` (normally a single hop). */
    async keyframeAfter(t) {
      requireVideo();
      let cur = await vSink.getKeyPacket(Math.max(0, t), KEY_OPTS);
      if (!cur) cur = await vSink.getFirstKeyPacket(KEY_OPTS);
      if (!cur) return null;
      if (cur.timestamp >= t) return cur.timestamp;
      for (let hops = 0; hops < MAX_KEY_HOPS; hops++) {
        cur = await vSink.getNextKeyPacket(cur, KEY_OPTS);
        if (!cur) return null;
        if (cur.timestamp >= t) return cur.timestamp;
      }
      throw engineError("could not find a key frame after " + round2(t) + " s (scan bound hit)");
    },

    /** Average keyframe spacing from a bounded metadata-only packet scan
        (verifyKeyPackets cannot combine with metadataOnly — the container's
        own key flags are accurate enough for an ESTIMATE). Returns
        { keyframe_spacing_s_estimate, keyframes_seen, packets_scanned };
        the estimate is null when fewer than two keyframes were seen. */
    async gopEstimate(maxPackets = GOP_SCAN_PACKETS) {
      requireVideo();
      let scanned = 0;
      const keyTs = [];
      for await (const p of vSink.packets(undefined, undefined, { metadataOnly: true })) {
        if (p.type === "key") keyTs.push(p.timestamp);
        scanned++;
        if (scanned >= maxPackets) break;
      }
      const est = keyTs.length >= 2
        ? round2((keyTs[keyTs.length - 1] - keyTs[0]) / (keyTs.length - 1))
        : null;
      return {
        keyframe_spacing_s_estimate: est,
        keyframes_seen: keyTs.length,
        packets_scanned: scanned,
      };
    },

    /** §5.3 snapping for one removal range [start_s, end_s):
          mode "remove" (default) — the removed region GROWS to
            [keyframeBefore(start) … keyframeAfter(end)): what the user asked
            to remove is guaranteed gone; the keep loses up to one GOP/edge.
          mode "keep" — the removed region SHRINKS to
            [keyframeAfter(start) … keyframeBefore(end)): no kept content is
            lost; edges of the removed material may survive. Returns null when
            the shrunk region collapses to nothing (no keyframe inside it) —
            the caller reports an honest "could not remove safely".
        Boundaries are clamped to [0, duration]. */
    async snapRemovalRange(range, mode = "remove") {
      requireVideo();
      const dur = typeof duration === "number" ? duration : Infinity;
      const start = Math.min(Math.max(0, range.start_s), dur);
      const end = Math.min(Math.max(0, range.end_s), dur);
      if (!(end > start)) return null;
      if (mode === "keep") {
        const s = await this.keyframeAfter(start);
        const e = await this.keyframeBefore(end);
        if (s == null || e == null || e <= s) return null;
        return { start_s: round2(s), end_s: round2(e) };
      }
      const s = await this.keyframeBefore(start);
      const e = await this.keyframeAfter(end);
      return {
        start_s: round2(s == null ? 0 : s),
        end_s: round2(e == null ? dur : e),
      };
    },

    dispose() {
      // VENDORED-BUNDLE QUIRK: Input.dispose() does
      // `void this._demuxerPromise?.then(...)` — on an input whose format
      // detection REJECTED, that mints a fresh unhandled rejection (a console
      // error on every unplayable pick). When format detection failed there
      // is no demuxer to free, so disposal is correctly a no-op.
      if (!formatOk) return;
      try { input.dispose(); } catch { /* already disposed */ }
    },
  };
}

/* ----- one-shot wrappers (arch §6.4 surface) -------------------------------------- */

/** Analyze a file: container/duration/video/audio shape for clipmeta.
    Never throws — unparseable input yields { …, parseError }. */
export async function analyzeFile(file) {
  const p = await openProbe(file);
  try { return await p.analyze(); }
  finally { p.dispose(); }
}

export async function keyframeBefore(file, t) {
  const p = await openProbe(file);
  try { return await p.keyframeBefore(t); }
  finally { p.dispose(); }
}

export async function keyframeAfter(file, t) {
  const p = await openProbe(file);
  try { return await p.keyframeAfter(t); }
  finally { p.dispose(); }
}

export async function gopEstimate(file, maxPackets = GOP_SCAN_PACKETS) {
  const p = await openProbe(file);
  try { return await p.gopEstimate(maxPackets); }
  finally { p.dispose(); }
}

export async function snapRemovalRange(file, range, mode = "remove") {
  const p = await openProbe(file);
  try { return await p.snapRemovalRange(range, mode); }
  finally { p.dispose(); }
}
