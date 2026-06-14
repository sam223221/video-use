/* =============================================================================
   engine/audiomix.js — the PCM AUDIO MIXER for the render tier (arch §6.4.2).
   -----------------------------------------------------------------------------
   Mixes, per OUTPUT SEGMENT, the clip's own audio + every overlapping music
   placement into one stereo 48 kHz PCM stream and feeds it to the caller's AAC
   encoder (render.js owns the single Output + AudioSampleSource; this module
   produces the mixed AudioSamples and hands them over via a callback).

   The mix (arch §6.1 AUDIO block):
     • clip audio — the segment's source audio window, decoded and re-based to
       the segment's OUTPUT start.
     • each music placement overlapping the segment — decoded from its
       track_offset, with: per-placement gain_db, fade_in/fade_out envelopes,
       and the DUCK envelope (engine/duck.js) computed from the clip's
       transcript word TIMES (or a flat fallback when untranscribed).
     • sum + soft-limit (tanh-style) so overlapping loud sources never clip.

   MEMORY (arch §6.4.4 — THE constraint): audio is WINDOWED. Decode iterators
   (webcodecs.decodeAudioWindow → mediabunny AudioBufferSink.buffers) pre-decode
   a few buffers ahead and no more; we accumulate the mixed PCM in fixed BLOCK_S
   chunks (≤1 s) and encode each block immediately. The WHOLE track is never in
   RAM — neither the clip's nor the music's.

   Resampling: sources arrive at their native rate; a simple linear resampler
   brings each to 48 kHz before summing (sub-sample phase is inaudible for a
   music bed + speech; a polyphase resampler is overkill for this product and
   would cost memory). Channel handling: mono → duplicated to stereo, >2 →
   first two channels (the bed is stereo or mono in practice).

   PURE engine module: mediabunny (via webcodecs.js) + duck.js + writers
   (engineError) only. NO DOM, NO fetch, NO OPFS, NO app state. The caller
   passes already-opened decode facts + the transcript words (TIMES only) — this
   module does no I/O of its own beyond draining the bounded decode iterators.
============================================================================= */

import { engineError } from "./writers.js";
import { decodeAudioWindow } from "./webcodecs.js";
import { buildDuckEnvelope, mapWordsToPlacement, dbToLinear } from "./duck.js";

const OUT_RATE = 48000;
const OUT_CHANNELS = 2;
const BLOCK_S = 0.5;                 // mix + encode in ≤0.5 s blocks (windowed)
const BLOCK_FRAMES = Math.round(OUT_RATE * BLOCK_S);

/* ----- small PCM helpers ------------------------------------------------------- */

/** Soft-limit a sample to [-1, 1] with a smooth knee so summed sources never
    clip harshly. tanh keeps unity gain for quiet signal and rolls the loud
    tail. */
function softLimit(x) {
  // Below ~0.7 this is ≈ identity; above it compresses toward ±1.
  if (x > -0.7 && x < 0.7) return x;
  return Math.tanh(x);
}

/**
 * Linear-resample one channel of f32 PCM from `srcRate` to OUT_RATE, writing
 * `outFrames` samples starting at `outOffset` into `dst` (ADDING, for mixing).
 * `src` is the source channel data; `srcStartFrame` is the source frame index
 * corresponding to dst[outOffset]. Out-of-range source reads contribute 0.
 */
function addResampledChannel(dst, outOffset, outFrames, gainEnv, gainScalar, src, srcRate, srcStartFrame) {
  const ratio = srcRate / OUT_RATE;     // source frames advanced per output frame
  const n = src.length;
  for (let i = 0; i < outFrames; i++) {
    const srcPos = srcStartFrame + i * ratio;
    const i0 = Math.floor(srcPos);
    if (i0 < -1 || i0 >= n) {
      // fully out of range — silence (still advance the envelope)
      continue;
    }
    const frac = srcPos - i0;
    const a = (i0 >= 0 && i0 < n) ? src[i0] : 0;
    const b = (i0 + 1 >= 0 && i0 + 1 < n) ? src[i0 + 1] : a;
    let s = a + (b - a) * frac;
    s *= gainScalar;
    if (gainEnv) s *= gainEnv[outOffset + i];
    dst[outOffset + i] += s;
  }
}

/** Pull the two output channels from an AudioBuffer (mono → both, stereo →
    L/R, >2 → first two). Returns {l, r, rate, frames}. */
function bufferChannels(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const l = audioBuffer.getChannelData(0);
  const r = ch >= 2 ? audioBuffer.getChannelData(1) : l;
  return { l, r, rate: audioBuffer.sampleRate, frames: audioBuffer.length };
}

/* ----- the per-source windowed PCM reader -------------------------------------- */

/* Drains a decodeAudioWindow iterator and assembles a CONTIGUOUS f32 PCM window
   (L+R at the SOURCE rate) covering [startTime, endTime) source seconds. The
   window is ≤ (endTime−startTime) seconds — for a ≤0.5 s mix block plus a small
   guard this is tiny (a few tens of KB), so it never approaches the whole-track
   budget. Returns {l, r, rate, baseTime} where baseTime is the source time of
   l[0], or null when the iterator yielded nothing. */
async function readSourceWindow(facts, startTime, endTime) {
  if (!facts || !facts.sink) return null;
  const rate = facts.sampleRate || OUT_RATE;
  // Pad the read a touch so resampling at the edges has a neighbor sample.
  const padded = Math.max(0, startTime - 0.02);
  const span = Math.max(0, endTime - padded) + 0.04;
  const cap = Math.ceil(span * rate) + 8;
  const l = new Float32Array(cap);
  const r = new Float32Array(cap);
  let written = 0;
  let baseTime = null;
  let iterator = null;
  try {
    iterator = decodeAudioWindow(facts, padded, endTime + 0.02);
    for await (const item of iterator) {
      if (!item || !item.buffer) continue;
      const { l: bl, r: br, frames } = bufferChannels(item.buffer);
      if (baseTime === null) baseTime = item.timestamp;
      const room = cap - written;
      const take = Math.min(frames, room);
      if (take <= 0) break;     // window full — stop draining (bounded)
      l.set(bl.subarray(0, take), written);
      r.set(br.subarray(0, take), written);
      written += take;
      if (written >= cap) break;
    }
  } catch (err) {
    throw engineError("failed to decode audio: " + (err && err.message ? err.message : String(err)));
  }
  if (written === 0 || baseTime === null) return null;
  return {
    l: l.subarray(0, written),
    r: r.subarray(0, written),
    rate,
    baseTime,
  };
}

/* ----- fade + gain scalar ------------------------------------------------------ */

/** The per-frame music gain ENVELOPE for one block: placement gain (constant) ×
    fade-in/out (position in the whole placement) × duck (precomputed for the
    whole placement). Returns a Float32Array of `blockFrames`, OR null when the
    constant parts collapse to a flat scalar (caller then uses gainScalar). We
    always build the envelope when a duck or fade is active so the resampler
    applies it per-sample. `placementFrameOffset` is the frame index of this
    block's first sample within the WHOLE placement window. */
function musicGainEnvelope(blockFrames, placementFrameOffset, placementFrames,
  fadeInFrames, fadeOutFrames, duckEnv) {
  const env = new Float32Array(blockFrames);
  for (let i = 0; i < blockFrames; i++) {
    const p = placementFrameOffset + i;       // frame within the whole placement
    let g = 1;
    if (fadeInFrames > 0 && p < fadeInFrames) {
      g *= p / fadeInFrames;
    }
    if (fadeOutFrames > 0 && p >= placementFrames - fadeOutFrames) {
      const into = placementFrames - p;       // frames remaining
      g *= Math.max(0, into / fadeOutFrames);
    }
    if (duckEnv && p >= 0 && p < duckEnv.length) {
      g *= duckEnv[p];
    }
    env[i] = g;
  }
  return env;
}

/* ----- music placement prep (per segment) -------------------------------------- */

/* For a music placement overlapping THIS segment, precompute the constant facts:
   its frame window on the OUTPUT timeline, fade frame counts, gain scalar, and
   the FULL duck envelope (computed once per placement per segment — O(words +
   frames), trivial). Returns null when the placement does not overlap. */
function prepPlacement(music, transcriptWords, clipSegments, segStartOut, segEndOut) {
  const at = Number(music.at_s) || 0;
  const dur = Number(music.duration_s) || 0;
  const placeStart = at;
  const placeEnd = at + dur;
  // Overlap of the placement with this output segment.
  const ovStart = Math.max(placeStart, segStartOut);
  const ovEnd = Math.min(placeEnd, segEndOut);
  if (ovEnd <= ovStart) return null;

  const placementFrames = Math.max(1, Math.round(dur * OUT_RATE));
  const fadeInFrames = Math.max(0, Math.round((Number(music.fade_in_s) || 0) * OUT_RATE));
  const fadeOutFrames = Math.max(0, Math.round((Number(music.fade_out_s) || 0) * OUT_RATE));
  const gainScalar = dbToLinear(music.gain_db);

  // The duck envelope spans the WHOLE placement (output time, relative to the
  // placement start). Speech intervals come from the clip's transcript word
  // TIMES mapped onto the output timeline (duck.js), or a flat fallback.
  const hasTranscript = Array.isArray(transcriptWords) && transcriptWords.length > 0;
  const duckOn = !!(music.duck && music.duck.enabled);
  let duckEnv = null;
  if (duckOn) {
    const speech = hasTranscript
      ? mapWordsToPlacement(transcriptWords, clipSegments, at, dur)
      : [];
    duckEnv = buildDuckEnvelope({
      duck: music.duck,
      speech,
      fallback: duckOn && !hasTranscript,   // no transcript → gentle blanket duck
      durationS: dur,
      sampleRate: OUT_RATE,
    });
  }

  return {
    music,
    at,
    placementFrames,
    fadeInFrames,
    fadeOutFrames,
    gainScalar,
    duckEnv,
  };
}

/* ----- the segment mixer ------------------------------------------------------- */

/**
 * Mix one OUTPUT SEGMENT's audio and feed the result to the encoder, block by
 * block (windowed). The segment occupies OUTPUT time [segStartOut, segEndOut);
 * its source audio is the clip window [sourceStart, sourceEnd).
 *
 * @param {Object} opts
 * @param {Object|null} opts.clipAudio    openAudioForDecode() facts for the
 *                                        clip (null/sinkless → no clip audio,
 *                                        the music still mixes).
 * @param {number} opts.sourceStart       clip source seconds at segStartOut.
 * @param {number} opts.sourceEnd         clip source seconds at segEndOut.
 * @param {number} opts.segStartOut       output seconds (segment start).
 * @param {number} opts.segEndOut         output seconds (segment end).
 * @param {Array}  opts.music             folded music placements (whole project;
 *                                        we pick the ones overlapping here).
 * @param {Object} opts.musicFacts        { [track_id]: openAudioForDecode facts }
 *                                        — the caller opened each track once.
 * @param {Array}  opts.transcriptWords   the CLIP's transcript words (TIMES only)
 *                                        for ducking; [] when untranscribed.
 * @param {Array}  opts.clipSegments      the clip's kept segments with
 *                                        source→output mapping (for duck word
 *                                        mapping) — [{source_start_s,
 *                                        source_end_s, output_start_s}].
 * @param {Function} opts.addAudioSample  async (AudioSampleInit) → awaits encoder
 *                                        backpressure. render.js wires this to
 *                                        its AudioSampleSource.add(new AudioSample(init)).
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<number>} the number of audio frames encoded for this segment.
 */
export async function mixSegmentAudio({
  clipAudio, sourceStart, sourceEnd, segStartOut, segEndOut,
  music = [], musicFacts = {}, transcriptWords = [], clipSegments = [],
  addAudioSample, signal,
}) {
  if (typeof addAudioSample !== "function") {
    throw engineError("mixSegmentAudio needs an addAudioSample callback");
  }
  const segDur = Math.max(0, segEndOut - segStartOut);
  const totalFrames = Math.round(segDur * OUT_RATE);
  if (totalFrames <= 0) return 0;

  // Prep each overlapping placement once (gain/fade/duck constants).
  const placements = [];
  for (const m of Array.isArray(music) ? music : []) {
    const facts = musicFacts[m.track_id];
    if (!facts || !facts.sink) continue;          // track missing/undecodable → skip
    const prepped = prepPlacement(m, transcriptWords, clipSegments, segStartOut, segEndOut);
    if (prepped) placements.push(prepped);
  }

  const hasClipAudio = !!(clipAudio && clipAudio.sink);
  // If there's literally nothing to mix (no clip audio, no music), the segment
  // contributes silence — but the caller still wants a contiguous audio track,
  // so we emit silent blocks to keep A/V aligned.
  let framesDone = 0;

  while (framesDone < totalFrames) {
    if (signal && signal.aborted) throw engineError("render canceled");
    const blockFrames = Math.min(BLOCK_FRAMES, totalFrames - framesDone);
    const outStartFrame = framesDone;
    const outStartOut = segStartOut + outStartFrame / OUT_RATE;
    const outEndOut = segStartOut + (outStartFrame + blockFrames) / OUT_RATE;

    // Interleaved stereo f32 for the encoder; built planar then interleaved.
    const mixL = new Float32Array(blockFrames);
    const mixR = new Float32Array(blockFrames);

    // 1. Clip audio (the voice). Source window for this block.
    if (hasClipAudio) {
      const srcBlockStart = sourceStart + (outStartOut - segStartOut);
      const srcBlockEnd = sourceStart + (outEndOut - segStartOut);
      const win = await readSourceWindow(clipAudio, srcBlockStart, srcBlockEnd);
      if (win) {
        // The first sample of this block corresponds to source time
        // srcBlockStart; find its frame index in the decoded window.
        const srcStartFrame = (srcBlockStart - win.baseTime) * win.rate;
        addResampledChannel(mixL, 0, blockFrames, null, 1, win.l, win.rate, srcStartFrame);
        addResampledChannel(mixR, 0, blockFrames, null, 1, win.r, win.rate, srcStartFrame);
      }
    }

    // 2. Each overlapping music placement.
    for (const p of placements) {
      const m = p.music;
      // The placement's own time range that intersects this block (output).
      const pOutStart = Math.max(p.at, outStartOut);
      const pOutEnd = Math.min(p.at + (m.duration_s || 0), outEndOut);
      if (pOutEnd <= pOutStart) continue;

      // Source (track) time for the intersecting span: track_offset + (output −
      // placement start).
      const trackOffset = Number(m.track_offset_s) || 0;
      const srcStart = trackOffset + (pOutStart - p.at);
      const srcEnd = trackOffset + (pOutEnd - p.at);
      const facts = musicFacts[m.track_id];
      const win = await readSourceWindow(facts, srcStart, srcEnd);

      // The output frame offset (within this block) where the placement audio lands.
      const blockOffset = Math.round((pOutStart - outStartOut) * OUT_RATE);
      const placeBlockFrames = Math.min(blockFrames - blockOffset,
        Math.round((pOutEnd - pOutStart) * OUT_RATE));
      if (placeBlockFrames <= 0) continue;

      // The placement-frame offset of this block's first placement sample (for
      // fade/duck lookup), then the per-sample envelope.
      const placementFrameOffset = Math.round((pOutStart - p.at) * OUT_RATE);
      const env = musicGainEnvelope(placeBlockFrames, placementFrameOffset,
        p.placementFrames, p.fadeInFrames, p.fadeOutFrames, p.duckEnv);

      if (win) {
        const srcStartFrame = (srcStart - win.baseTime) * win.rate;
        addResampledChannel(mixL, blockOffset, placeBlockFrames, env, p.gainScalar, win.l, win.rate, srcStartFrame);
        addResampledChannel(mixR, blockOffset, placeBlockFrames, env, p.gainScalar, win.r, win.rate, srcStartFrame);
      }
    }

    // 3. Soft-limit + interleave to one stereo f32 buffer.
    const interleaved = new Float32Array(blockFrames * OUT_CHANNELS);
    for (let i = 0; i < blockFrames; i++) {
      interleaved[i * 2] = softLimit(mixL[i]);
      interleaved[i * 2 + 1] = softLimit(mixR[i]);
    }

    // 4. Hand the block to the encoder (AudioSample init shape — render.js
    //    wraps it). timestamp is the OUTPUT seconds of this block.
    await addAudioSample({
      format: "f32",                 // interleaved 32-bit float
      sampleRate: OUT_RATE,
      numberOfChannels: OUT_CHANNELS,
      timestamp: outStartOut,
      data: interleaved,
    });

    framesDone += blockFrames;
  }

  return framesDone;
}

export const AUDIO_MIX_RATE = OUT_RATE;
export const AUDIO_MIX_CHANNELS = OUT_CHANNELS;
