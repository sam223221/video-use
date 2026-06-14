/* =============================================================================
   engine/duck.js — the music DUCKING envelope (arch §6.4.2 "duck.js").
   -----------------------------------------------------------------------------
   PURE, dependency-free (no mediabunny, no DOM, no fetch, no OPFS). Computes a
   per-sample GAIN ENVELOPE that lowers the music under speech — "duck the music
   when someone is talking" — from the transcript WORD TIMES.

   SECURITY (plan §5 / arch §9): the envelope is computed from word TIMES ONLY
   — the [start,end) seconds of each spoken word. Word TEXT is never read here.
   There is no code path that touches `w.w`; ducking is a numeric function of
   intervals, so a transcript can never inject anything.

   The model (arch §2.2 duck shape):
     • A music placement carries duck:{enabled, amount_db, attack_s, release_s}.
     • "Under speech" = inside any speech interval the music drops to
       amount_db (e.g. −12 dB → linear ~0.25); outside, it stays at 1.0 (full
       music). attack_s ramps DOWN entering speech, release_s ramps UP leaving
       it — a smooth, broadcast-style sidechain, not a hard gate.
     • When the clip has NO transcript, the caller passes an EMPTY speech list
       and a fallback flag → a flat, gentle reduction for the whole placement
       (arch §6.4.2: "fall back to a fixed lower level when it isn't
       transcribed"), so music under an untranscribed talking clip still sits
       politely below the voice.

   TIMELINE MAPPING (the one subtlety): transcript word times are SOURCE-clip
   seconds; the music placement and the envelope live on the COMPOSED OUTPUT
   timeline (after cuts). The caller (audiomix.js) builds the speech intervals
   already mapped into output time using the keep-list segment mapping, and
   hands them here in OUTPUT seconds relative to the placement start. This module
   never sees source time — it is pure interval→envelope math on one clock.

   Output: a Float32Array gain multiplier (0..1) of `frames` samples at
   `sampleRate`, one value per audio frame for the placement window, ready to be
   multiplied into the music PCM. O(words + frames) — trivial (arch §10).
============================================================================= */

const DB_FLOOR = -60;       // a duck amount below this is treated as silence-ish
const MIN_TIME = 0.001;     // attack/release floor (s) — avoid divide-by-zero

/** decibels → linear amplitude. −12 dB ≈ 0.251, 0 dB = 1. Clamped at the floor. */
export function dbToLinear(db) {
  const v = Number(db);
  if (!Number.isFinite(v)) return 1;
  if (v <= DB_FLOOR) return 0;
  if (v >= 0) return 1;
  return Math.pow(10, v / 20);
}

/**
 * Merge raw [start,end) intervals (output seconds) into a sorted, non-
 * overlapping list. PURE. Negative/degenerate intervals are dropped; touching
 * or overlapping intervals are unioned (so adjacent words read as one speech
 * span and the music doesn't bob between every word).
 *
 * @param {Array<{s:number,e:number}>} intervals
 * @param {number} [joinGapS=0.25]  intervals closer than this are merged (a
 *                                  natural pause between words is not "music up
 *                                  then immediately down" — keep it ducked).
 * @returns {Array<{s:number,e:number}>}
 */
export function mergeIntervals(intervals, joinGapS = 0.25) {
  const clean = [];
  for (const iv of Array.isArray(intervals) ? intervals : []) {
    if (!iv) continue;
    const s = Number(iv.s);
    const e = Number(iv.e);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    clean.push({ s, e });
  }
  clean.sort((a, b) => a.s - b.s);
  const gap = Number.isFinite(joinGapS) && joinGapS >= 0 ? joinGapS : 0;
  const merged = [];
  for (const iv of clean) {
    const last = merged[merged.length - 1];
    if (last && iv.s <= last.e + gap) {
      if (iv.e > last.e) last.e = iv.e;
    } else {
      merged.push({ s: iv.s, e: iv.e });
    }
  }
  return merged;
}

/**
 * Build the duck gain envelope for ONE music placement window.
 *
 * @param {Object} opts
 * @param {Object} opts.duck         the placement.duck { enabled, amount_db,
 *                                   attack_s, release_s }. enabled:false → a
 *                                   flat 1.0 envelope (no ducking).
 * @param {Array<{s:number,e:number}>} opts.speech  speech intervals in OUTPUT
 *                                   seconds RELATIVE TO THE PLACEMENT START
 *                                   (i.e. 0 = the placement's at_s). The caller
 *                                   has already mapped source word times →
 *                                   output time and clipped to the window.
 * @param {boolean} [opts.fallback]  true when the clip has NO transcript but the
 *                                   caller still wants a gentle blanket duck —
 *                                   the whole window sits at amount_db (no
 *                                   ramps; the music just rides lower under an
 *                                   untranscribed talking clip).
 * @param {number} opts.durationS    the placement window length, seconds.
 * @param {number} opts.sampleRate   output sample rate (e.g. 48000).
 * @returns {Float32Array} a gain multiplier per audio frame (length =
 *          round(durationS × sampleRate)), values in [duckLinear, 1].
 */
export function buildDuckEnvelope({ duck, speech, fallback = false, durationS, sampleRate }) {
  const sr = Math.max(1, Math.round(Number(sampleRate) || 48000));
  const frames = Math.max(0, Math.round(Number(durationS) * sr) || 0);
  const env = new Float32Array(frames);

  const enabled = !!(duck && duck.enabled);
  const duckLinear = enabled ? dbToLinear(duck.amount_db) : 1;

  // No ducking, or nothing to duck under → full music throughout.
  if (!enabled || (frames === 0)) {
    env.fill(1);
    return env;
  }

  // FALLBACK (no transcript): a flat blanket duck for the whole window. The
  // music rides at amount_db under the talking clip — gentle, ramp-free.
  if (fallback) {
    env.fill(duckLinear);
    return env;
  }

  const merged = mergeIntervals(speech);
  if (merged.length === 0) {
    // Transcript present but no words inside this window → music stays full.
    env.fill(1);
    return env;
  }

  const attack = Math.max(MIN_TIME, Number(duck.attack_s) || 0.25);
  const release = Math.max(MIN_TIME, Number(duck.release_s) || 0.6);
  const attackFrames = Math.max(1, Math.round(attack * sr));
  const releaseFrames = Math.max(1, Math.round(release * sr));

  // Walk samples; at each frame the target is duckLinear inside a speech span,
  // 1 outside. We ramp toward the target with a linear slope sized by
  // attack/release so the transition is smooth (the broadcast sidechain shape).
  // A single forward pass with a per-frame slope toward the current target is
  // O(frames) and gives clean symmetric ramps.
  let intervalIdx = 0;
  let cur = 1; // start at full music
  const downStep = (1 - duckLinear) / attackFrames;     // per-frame ramp DOWN
  const upStep = (1 - duckLinear) / releaseFrames;      // per-frame ramp UP

  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    // Advance the interval cursor so `merged[intervalIdx]` is the first
    // interval whose end is after t.
    while (intervalIdx < merged.length && merged[intervalIdx].e <= t) intervalIdx++;
    const iv = merged[intervalIdx];
    const inSpeech = !!iv && t >= iv.s && t < iv.e;
    const target = inSpeech ? duckLinear : 1;
    if (cur > target) {
      cur = Math.max(target, cur - downStep);
    } else if (cur < target) {
      cur = Math.min(target, cur + upStep);
    }
    env[i] = cur;
  }
  return env;
}

/**
 * Map a transcript's word times (SOURCE-clip seconds) for ONE clip onto the
 * OUTPUT timeline, then express them RELATIVE TO a music placement start —
 * ready to feed buildDuckEnvelope().
 *
 * The keep-list maps source time → output time per segment: a segment
 * {clip_id, source_start_s, source_end_s} sits at output [output_start_s,
 * output_start_s + (source_end_s − source_start_s)). A source word at time `s`
 * inside that segment appears at output `output_start_s + (s − source_start_s)`.
 * Words inside CUT-OUT regions never reach the output, so they are dropped.
 *
 * @param {Array<{w?:string,s:number,e:number}>} words  transcript words (only
 *                                   s/e are read — TEXT is ignored, arch §9).
 * @param {Array<{source_start_s:number, source_end_s:number, output_start_s:number}>}
 *        segments  the clip's kept segments with their source→output mapping.
 * @param {number} placementAtS   the music placement start on the OUTPUT
 *                                 timeline (placement.at_s).
 * @param {number} placementDurS  the placement window length (output seconds).
 * @returns {Array<{s:number,e:number}>}  speech intervals in OUTPUT seconds,
 *          RELATIVE TO placementAtS, clipped to [0, placementDurS].
 */
export function mapWordsToPlacement(words, segments, placementAtS, placementDurS) {
  const out = [];
  const atS = Number(placementAtS) || 0;
  const durS = Math.max(0, Number(placementDurS) || 0);
  const segs = Array.isArray(segments) ? segments : [];
  for (const word of Array.isArray(words) ? words : []) {
    if (!word) continue;
    const ws = Number(word.s);
    const we = Number(word.e);
    if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) continue;
    for (const seg of segs) {
      const ss = Number(seg.source_start_s);
      const se = Number(seg.source_end_s);
      const os = Number(seg.output_start_s);
      if (!Number.isFinite(ss) || !Number.isFinite(se) || !Number.isFinite(os)) continue;
      // Intersect the word with the kept source span.
      const cs = Math.max(ws, ss);
      const ce = Math.min(we, se);
      if (ce <= cs) continue;                 // word not in this kept segment
      // Map the intersected source span into output time, then make it
      // relative to the placement and clip to the placement window.
      const outStart = os + (cs - ss) - atS;
      const outEnd = os + (ce - ss) - atS;
      const s = Math.max(0, outStart);
      const e = Math.min(durS, outEnd);
      if (e > s) out.push({ s, e });
    }
  }
  return out;
}
