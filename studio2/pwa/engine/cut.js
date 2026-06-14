/* =============================================================================
   engine/cut.js — MULTI-SEGMENT lossless remux (arch §6.2).
   -----------------------------------------------------------------------------
   The M0 spike's field-proven packet-copy loop, generalized: an ordered
   keep-list [{clip_id, start_s, end_s}] is copied packet-by-packet into one
   output file with per-segment timestamp re-basing. Explicitly NOT
   mediabunny's Conversion/trim (which transcodes mid-file trims) — this is
   pure packet copy: ~150-180 ms per 30 s segment on the target phone (M0),
   byte-exact, zero generation loss.

   Per segment (arch §6.2 step 3):
     • video starts at the key packet at/before start_s (start_s is already
       keyframe-snapped by §5.3 — but JOURNALED at 2 decimals, so every
       boundary comparison below is compensated by SNAP_EPSILON_S to undo
       the rounding; see the constant's comment);
     • every packet timestamp is re-based to
       (packet.ts − segmentBase) + outputOffset, where outputOffset is the
       accumulated realized duration of prior segments (the muxer requires
       non-negative timestamps and would turn a non-zero track start into an
       edit-list delay);
     • video stops at the first key packet with ts ≥ end_s (not written);
       audio stops at ts ≥ end_s — so each junction is keyframe-aligned and
       the last fraction of a second of a segment can be silent (expected,
       spike-documented, ~0 when end_s is itself a snapped keyframe time);
     • video and audio packet iterators are merged by timestamp so the output
       is interleaved like a normal recording and muxer memory stays minimal.

   Container: first clip QuickTime → MovOutputFormat, else Mp4OutputFormat;
   fastStart:false (metadata at EOF — M0-proven fastest/lowest-memory; needs
   the positioned writes OPFS supports). Rotation metadata is preserved
   (portrait footage is in every test plan).

   Multi-clip rule (M1, plan resolution #5): segments from different clips
   may be joined ONLY when the clips match exactly on video codecString,
   audio codecString (or both have no audio), dimensions and rotation —
   otherwise a clean engine_error explains that mixed-format joins need the
   re-encode tier. Single-clip multi-segment is the M1 mainline.

   Banked #1 enforced by construction: `target` MUST be the object returned
   by writers.tempThenRename() (or normalizingWritable()) — a bare
   WritableStream is refused, so a StreamTarget can never sit on a raw OPFS
   writable. Banked #6 note: the engine does NOT self-meter; callers
   (export.js / the bridge executor queue) run one engine operation at a time.
============================================================================= */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  QuickTimeInputFormat,
  EncodedPacketSink,
  Output,
  Mp4OutputFormat,
  MovOutputFormat,
  StreamTarget,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from "./mediabunny.js";
import { abandonOutput, engineError } from "./writers.js";
import { resolveCanvas } from "./canvas.js";

const PROGRESS_BATCH = 64; // onProgress fires once per this many packets

/* SNAP-ROUNDING EPSILON (reviewer P1). Journaled boundaries come from
   probe.snapRemovalRange, which round2()s the true keyframe timestamps —
   max error ±5 ms (a real keyframe at 66.1333 s journals as 66.13). Fed
   raw into getKeyPacket() (= last key ≤ t), a rounded-DOWN start selects
   the PREVIOUS keyframe, so up to a whole GOP (~2 s) of REMOVED material
   re-enters the export; a rounded-UP end makes the `>= end` stop checks
   overshoot the boundary key the same way. Compensate by 5.1 ms: strictly
   larger than the worst round2 error (5 ms) and strictly smaller than the
   minimum frame spacing (~16.7 ms at 60 fps), so the compensated value can
   never reach a DIFFERENT keyframe — it only undoes the rounding. */
const SNAP_EPSILON_S = 0.0051;

function round2(n) { return Math.round(n * 100) / 100; }

/* Open one Input per distinct clip and gather the join-validation facts. */
async function openSource(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let formatOk = false; // vendored-bundle quirk: disposing an input whose
  // format detection REJECTED mints an unhandled rejection — skip disposal
  // in that case (nothing was opened to free). See engine/DOCUMENT.md.
  try {
    const format = await input.getFormat();
    formatOk = true;
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw engineError("no video track found in this clip");
    const audio = await input.getPrimaryAudioTrack();
    const vCodec = await video.getCodec();
    if (!vCodec) {
      throw engineError("video codec not recognized: " + (await video.getCodecParameterString()));
    }
    let aCodec = null;
    let aCodecString = null;
    if (audio) {
      aCodec = await audio.getCodec();
      aCodecString = await audio.getCodecParameterString();
    }
    return {
      input,
      isMov: format instanceof QuickTimeInputFormat,
      video,
      audio: audio && aCodec ? audio : null, // an unrecognized audio codec is dropped, like the spike
      vSink: new EncodedPacketSink(video),
      aSink: audio && aCodec ? new EncodedPacketSink(audio) : null,
      vCodec,
      vCodecString: await video.getCodecParameterString(),
      aCodec,
      aCodecString,
      rotation: await video.getRotation(),
      codedWidth: await video.getCodedWidth(),
      codedHeight: await video.getCodedHeight(),
    };
  } catch (err) {
    if (formatOk) {
      try { input.dispose(); } catch { /* already dead */ }
    }
    throw err;
  }
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw engineError("the keep-list is empty — there is nothing to export");
  }
  for (const seg of segments) {
    if (!seg || typeof seg.clip_id !== "string"
      || !Number.isFinite(seg.start_s) || !Number.isFinite(seg.end_s)
      || seg.start_s < 0 || seg.end_s <= seg.start_s) {
      throw engineError("malformed keep-segment: " + JSON.stringify(seg));
    }
  }
}

/* Multi-clip join rule (arch §6.2 step 4). Mixed audio presence counts as a
   codec mismatch — one output track cannot be half-silent by construction. */
function validateJoin(sources) {
  const ids = Object.keys(sources);
  if (ids.length < 2) return;
  const first = sources[ids[0]];
  for (const id of ids.slice(1)) {
    const s = sources[id];
    const diffs = [];
    if (s.vCodecString !== first.vCodecString) diffs.push("video codec");
    if ((s.aCodecString || null) !== (first.aCodecString || null)) diffs.push("audio");
    if (s.codedWidth !== first.codedWidth || s.codedHeight !== first.codedHeight) diffs.push("resolution");
    if (s.rotation !== first.rotation) diffs.push("rotation");
    if (diffs.length > 0) {
      throw engineError(
        "these clips can't be joined losslessly (" + diffs.join(", ") +
        " differ between clips) — joining mixed-format clips needs the re-encode tier, which isn't available yet"
      );
    }
  }
}

/* ----- tier auto-selection (arch §4 / §5.1) ------------------------------------ */

/* A clip's ROTATION-AWARE display dims from its clipmeta.video (the probe's
   displayWidth/displayHeight are already rotation-applied). Falls back to coded
   dims. Returns {width, height, rotation} or null. */
function clipDisplay(clipMeta) {
  const v = clipMeta && clipMeta.video;
  if (!v) return null;
  const dw = Number(v.displayWidth), dh = Number(v.displayHeight);
  const rotation = Number.isFinite(Number(v.rotation)) ? Number(v.rotation) : 0;
  if (Number.isFinite(dw) && Number.isFinite(dh) && dw > 0 && dh > 0) {
    return { width: dw, height: dh, rotation };
  }
  const cw = Number(v.codedWidth), ch = Number(v.codedHeight);
  if (Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0) {
    return { width: cw, height: ch, rotation };
  }
  return null;
}

/* The effective fit for a clip given a render block: its sparse override, else
   default_fit. Returns "contain" | "cover" (background is irrelevant to the
   tier — only contain-on-a-matching-canvas is identity). */
function effectiveFitMode(render, clipId) {
  const r = render || {};
  const fits = r.fits || {};
  const override = fits[clipId];
  if (override && (override.mode === "contain" || override.mode === "cover")) return override.mode;
  return r.default_fit === "cover" ? "cover" : "contain";
}

/**
 * Tier auto-selection (arch §5.1). Decides whether an export can stay the
 * INSTANT lossless remux or must engage the RENDER (re-encode) tier. PURE — no
 * I/O, no mediabunny; reads the folded keep-list, the render block, and the
 * live clip metadata only.
 *
 * LOSSLESS ("lossless") IFF ALL of:
 *   • there are no music placements, AND
 *   • every involved clip's display dims EXACTLY equal the resolved canvas
 *     (rotation is already folded into display dims; a clip whose display
 *     dims match the canvas needs no scaling/bars/crop), AND
 *   • every involved clip shares ONE video codecString and ONE audio
 *     codecString (mixed audio presence counts as a mismatch — the existing
 *     validateJoin rule), AND
 *   • every involved clip's fit is identity (contain on a canvas it already
 *     fills — never cover, never contain-with-bars).
 * OTHERWISE → "render".
 *
 * A single-clip trim with the default match_primary canvas resolves to
 * "lossless" (the canvas IS that clip's dims; one codec; identity fit; no
 * music) — the M1/M2 mainline pays no re-encode. This is the load-bearing
 * regression the §11 test plan pins.
 *
 * @param {Object} foldedState  { segments:[{clip_id,…}], music:[…] } (the
 *                              edl.js fold). `music` non-empty ⇒ render.
 * @param {Object} renderBlock  the project render block (raw or normalized).
 * @param {Array}  clips        live clipmeta objects (with .video.codecString,
 *                              .displayWidth/Height, .rotation, .audio).
 * @returns {"lossless"|"render"}
 */
export function tierCheck(foldedState, renderBlock, clips = []) {
  const state = foldedState || {};
  const segments = Array.isArray(state.segments) ? state.segments : [];
  const music = Array.isArray(state.music) ? state.music : [];

  // Music ALWAYS forces the render tier (it is mixed in during the re-encode).
  if (music.length > 0) return "render";

  // No segments → nothing to render; let the lossless path raise its own
  // "nothing to export" (tier is moot, default to lossless).
  if (segments.length === 0) return "lossless";

  // The clips actually on the timeline.
  const byId = new Map();
  for (const c of clips || []) {
    if (c && typeof c.clip_id === "string") byId.set(c.clip_id, c);
  }
  const involvedIds = [];
  const seen = new Set();
  for (const seg of segments) {
    if (!seen.has(seg.clip_id)) { seen.add(seg.clip_id); involvedIds.push(seg.clip_id); }
  }
  const involved = involvedIds.map((id) => byId.get(id)).filter(Boolean);
  // A clip on the timeline whose metadata we can't read → we cannot prove it
  // matches; be conservative and render.
  if (involved.length !== involvedIds.length) return "render";

  const canvas = resolveCanvas(renderBlock, clips);

  // Single common video + audio codec (the validateJoin rule, applied to the
  // involved set; a single clip trivially passes).
  const first = involved[0];
  const firstV = first.video && first.video.codecString;
  const firstA = first.audio && first.audio.codecString ? first.audio.codecString : null;
  for (const c of involved) {
    const v = c.video && c.video.codecString;
    const a = c.audio && c.audio.codecString ? c.audio.codecString : null;
    if (v !== firstV) return "render";
    if (a !== firstA) return "render";   // mixed audio presence/codec ⇒ render
  }

  // Every clip must already fill the canvas exactly (dims match) AND have an
  // identity fit (contain on a canvas it fills — never cover).
  for (const c of involved) {
    const d = clipDisplay(c);
    if (!d) return "render";
    if (d.width !== canvas.width || d.height !== canvas.height) return "render";
    if (effectiveFitMode(renderBlock, c.clip_id) !== "contain") return "render";
  }

  return "lossless";
}

/**
 * Lossless multi-segment remux.
 *
 * @param {Object}   opts
 * @param {Array}    opts.segments   keep-list in timeline order:
 *                                   [{clip_id, start_s, end_s}] (seconds,
 *                                   start_s keyframe-snapped per §5.3).
 * @param {Object}   opts.sources    { [clip_id]: File|Blob } — the OPFS clip
 *                                   files; every clip_id in segments must be
 *                                   present. (Files, not Inputs: this module
 *                                   owns all mediabunny object creation, so
 *                                   format checks never cross module
 *                                   instances.)
 * @param {Object}   opts.target     the writers.tempThenRename() /
 *                                   normalizingWritable() result
 *                                   ({stream, stats}); a bare stream is
 *                                   REFUSED (banked #1).
 * @param {Function} [opts.onProgress] ({segment_index, segments_total,
 *                                   packets, mediaBytes}) — per packet batch.
 * @returns {Promise<Object>} stats: { container, fastStart, segments_total,
 *          videoPackets, audioPackets, mediaBytes, outputSeconds, wallMs,
 *          realizedSegments:[{clip_id, start_s, end_s, output_start_s,
 *          output_end_s}], writes } — `writes` is target.stats, what
 *          verify.verifyOutput() needs.
 *
 * On ANY failure: best-effort abandonOutput() teardown, then the original
 * error is rethrown (the .tmp cleanup itself is the caller's
 * target.abandon()).
 */
export async function losslessCut({ segments, sources, target, onProgress }) {
  validateSegments(segments);
  if (!target || !(target.stream instanceof WritableStream) || !target.stats) {
    throw engineError("cut target must come from writers.tempThenRename()/normalizingWritable() — never a raw writable");
  }
  if (!sources || typeof sources !== "object") {
    throw engineError("sources {clip_id: File} is required");
  }
  for (const seg of segments) {
    const f = sources[seg.clip_id];
    const isBlob = typeof Blob !== "undefined" && f instanceof Blob; // File extends Blob
    if (!isBlob) throw engineError("missing source file for " + seg.clip_id);
  }

  const opened = {};   // clip_id → openSource() result
  let output = null;
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());

  try {
    // 1. Open every distinct clip once; validate the join rule up front.
    for (const seg of segments) {
      if (!opened[seg.clip_id]) opened[seg.clip_id] = await openSource(sources[seg.clip_id]);
    }
    validateJoin(opened);
    const first = opened[segments[0].clip_id];
    const isMov = first.isMov;
    const hasAudio = !!first.aSink;

    // 2. Output over the (already normalized) target stream.
    const OutFmt = isMov ? MovOutputFormat : Mp4OutputFormat;
    output = new Output({
      format: new OutFmt({ fastStart: false }),
      target: new StreamTarget(target.stream, { chunked: true }),
    });
    const vSource = new EncodedVideoPacketSource(first.vCodec);
    output.addVideoTrack(vSource, { rotation: first.rotation }); // rotation preserved
    let aSource = null;
    if (hasAudio) {
      aSource = new EncodedAudioPacketSource(first.aCodec);
      output.addAudioTrack(aSource);
    }
    await output.start();

    // Decoder configs attach on each output track's FIRST packet only.
    const vMeta = { decoderConfig: await first.video.getDecoderConfig() };
    const aMeta = hasAudio ? { decoderConfig: await first.audio.getDecoderConfig() } : null;
    let vFirstPacket = true;
    let aFirstPacket = true;

    const progress = { packets: 0, mediaBytes: 0 };
    let videoPackets = 0;
    let audioPackets = 0;
    let sinceProgress = 0;
    let outputOffset = 0; // accumulated realized duration of prior segments (s)
    const realizedSegments = [];

    const reportProgress = (segIndex) => {
      if (typeof onProgress !== "function") return;
      try {
        onProgress({
          segment_index: segIndex,
          segments_total: segments.length,
          packets: progress.packets,
          mediaBytes: progress.mediaBytes,
        });
      } catch { /* a progress UI failure must never kill the remux */ }
    };

    // 3. Copy each keep-segment in timeline order.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const src = opened[seg.clip_id];

      let startKey = await src.vSink.getKeyPacket(seg.start_s + SNAP_EPSILON_S, { verifyKeyPackets: true });
      if (!startKey) startKey = await src.vSink.getFirstKeyPacket({ verifyKeyPackets: true });
      if (!startKey) throw engineError("no key frame found in " + seg.clip_id);
      const base = startKey.timestamp;
      const end = seg.end_s;
      let lastVideoEnd = base;

      const vIter = src.vSink.packets(startKey)[Symbol.asyncIterator]();
      let aIter = null;
      let a = { done: true, value: undefined };
      if (src.aSink) {
        let aStart = await src.aSink.getPacket(base);
        if (!aStart) aStart = await src.aSink.getFirstPacket();
        if (aStart) {
          aIter = src.aSink.packets(aStart)[Symbol.asyncIterator]();
          a = await aIter.next();
          while (!a.done && a.value.timestamp < base) a = await aIter.next(); // skip pre-segment audio
        }
      }
      let v = await vIter.next();
      let vDone = false;
      let aDone = false;

      // The spike's two-iterator merge loop, re-based into the output timeline.
      while ((!v.done && !vDone) || (!a.done && !aDone)) {
        const vActive = !v.done && !vDone;
        const aActive = !a.done && !aDone;
        const takeVideo = vActive && (!aActive || v.value.timestamp <= a.value.timestamp);
        if (takeVideo) {
          const p = v.value;
          if (p.timestamp >= end - SNAP_EPSILON_S && p.type === "key") { vDone = true; continue; }
          await vSource.add(
            p.clone({ timestamp: p.timestamp - base + outputOffset }),
            vFirstPacket ? vMeta : undefined,
          );
          vFirstPacket = false;
          videoPackets++;
          progress.packets++;
          progress.mediaBytes += p.byteLength;
          lastVideoEnd = Math.max(lastVideoEnd, p.timestamp + p.duration);
          v = await vIter.next();
        } else if (aActive) {
          const p = a.value;
          if (p.timestamp >= end - SNAP_EPSILON_S) { aDone = true; continue; }
          await aSource.add(
            p.clone({ timestamp: p.timestamp - base + outputOffset }),
            aFirstPacket ? aMeta : undefined,
          );
          aFirstPacket = false;
          audioPackets++;
          progress.packets++;
          progress.mediaBytes += p.byteLength;
          a = await aIter.next();
        }
        if (++sinceProgress >= PROGRESS_BATCH) {
          sinceProgress = 0;
          reportProgress(i);
        }
      }

      const realized = Math.max(0, lastVideoEnd - base);
      realizedSegments.push({
        clip_id: seg.clip_id,
        start_s: round2(base),
        end_s: round2(base + realized),
        output_start_s: round2(outputOffset),
        output_end_s: round2(outputOffset + realized),
      });
      outputOffset += realized;
      reportProgress(i);
    }

    if (videoPackets === 0) {
      throw engineError("the keep-list produced no video packets — nothing to export");
    }

    // 4. Finalize commits the .tmp through the wrapper (target.stats.closed
    //    flips true); the caller verifies, then target.commit() renames.
    await output.finalize();

    const wallMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
    return {
      container: isMov ? "MOV" : "MP4",
      fastStart: false,
      segments_total: segments.length,
      videoPackets,
      audioPackets,
      mediaBytes: progress.mediaBytes,
      outputSeconds: round2(outputOffset),
      wallMs,
      realizedSegments,
      writes: target.stats,
    };
  } catch (err) {
    // Best effort, never masks `err`. The .tmp file itself is the caller's
    // target.abandon() (which also tolerates this teardown having run).
    await abandonOutput(output, target && target.stream);
    throw err;
  } finally {
    for (const id of Object.keys(opened)) {
      try { opened[id].input.dispose(); } catch { /* already disposed */ }
    }
  }
}
