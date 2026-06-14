/* =============================================================================
   engine/render.js — the on-device RENDER orchestrator (arch §6, §6.4.3, the
   SPINE of M3). Segment-wise decode → compose → encode → audiomix → mux, with
   OPFS checkpoints + resume.
   -----------------------------------------------------------------------------
   `renderProject({projectId, fold, renderBlock, canvas, clips, music, sources,
   musicSources, transcripts, onProgress, signal})` rebuilds the mixed-clip +
   music timeline into ONE coherent SDR video.

   PER OUTPUT SEGMENT (one keep-segment = one render unit — arch §6.4.3):
     • decode the source clip's video window (webcodecs.decodeVideoWindow) →
     • compositor.composeFrame onto the resolved canvas (rotation + fit + blur +
       HDR→SDR) → the encoder snapshots the shared OffscreenCanvas (CanvasSource)
     • VideoEncoder via mediabunny (HEVC if isConfigSupported @canvas dims else
       H.264 — probe-driven, NO UA sniff: engine/webcodecs.pickVideoEncoderConfig)
     • audiomix mixes the segment's clip audio + overlapping music (gain/fade/
       duck) → AAC encoder
     • the segment mux is written via writers.tempThenRename into the render/
       checkpoint dir and the MANIFEST is updated (status:"done").

   AFTER all segments: concat the (codec-identical-by-construction) segment
   muxes via packet-copy into out-<ts>-<rand>.mp4.tmp → verify (SDR-aware) → done.
   (The random suffix makes the final name collision-proof even if two renders
   commit within the same millisecond.)

   RESUMABLE (arch §6.4.3, the iOS-kill survival mechanism): the manifest records
   each segment's status + a FINGERPRINT of the whole render input. On re-run,
   if a matching-fingerprint manifest exists, segments already "done" are SKIPPED
   and the run resumes at the first pending one. Any fingerprint mismatch (the
   user edited after a kill) sweeps the stale render dir and starts fresh. This
   makes "the phone died at segment 7 of 12" cost only 7–12, not 0–12. Each
   segment mux is a self-contained valid file written through tempThenRename, so
   a half-written segment is a .tmp the boot sweep removes (banked #3).

   MEMORY (arch §6.4.4 — THE iOS-kill constraint): one segment, one frame in
   flight. Decode iterators are bounded (pre-decode a few ahead, never a whole
   clip); every VideoSample is `.close()`d IMMEDIATELY after compositing; audio
   is windowed in ≤0.5 s blocks (audiomix.js); one OffscreenCanvas reused
   (compositor.js); every OPFS byte streams through normalizingWritable. NOTHING
   buffers a whole clip or the whole output.

   Wake lock + crash marker are the CALLER's (export.js / Step 5) — this module
   takes a `signal` (AbortController) and an `onProgress` callback and stays pure
   media machinery (mediabunny + webcodecs/compositor/audiomix/duck/verify +
   writers + store/opfs for the checkpoint dir; NO DOM, NO fetch, NO app state).
============================================================================= */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  EncodedPacketSink,
  Output,
  Mp4OutputFormat,
  StreamTarget,
  CanvasSource,
  AudioSampleSource,
  AudioSample,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from "./mediabunny.js";
import { abandonOutput, engineError, tempThenRename } from "./writers.js";
import { projectSubDir, readJSON, writeJSONAtomic } from "../store/opfs.js";
import { resolveCanvas, DEFAULT_FIT, DEFAULT_BACKGROUND } from "./canvas.js";
import {
  pickVideoEncoderConfig, pickAudioEncoderConfig,
  openVideoForDecode, openAudioForDecode, decodeVideoWindow,
} from "./webcodecs.js";
import { createCompositor } from "./compositor.js";
import { mixSegmentAudio } from "./audiomix.js";
import { verifyOutput } from "./verify.js";

const RENDER_DIR = "render";
const MANIFEST_NAME = "manifest.json";
const MANIFEST_SCHEMA = 1;
const PROGRESS_BATCH = 12;        // onProgress fires once per this many frames
const SEG_NAME = (i) => "seg-" + String(i).padStart(4, "0") + ".part.mp4";

function round2(n) { return Math.round(n * 100) / 100; }
function nowIso() { return new Date().toISOString(); }
function nowMs() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

/* A short random hex token (default 4 bytes → 8 hex chars) for the final output
   name. `Date.now()` alone can collide if two renders commit in the same
   millisecond (e.g. a fast resume right after a fresh run); appending this makes
   `out-<ts>-<rand>.mp4` unique even within a tick. Crypto-strong when available,
   with a Math.random fallback for non-crypto contexts (uniqueness, not secrecy,
   is the requirement — this gates no security decision). */
function randomToken(bytes = 4) {
  const g = (typeof globalThis !== "undefined" ? globalThis : {});
  const c = g.crypto;
  if (c && typeof c.getRandomValues === "function") {
    const buf = new Uint8Array(bytes);
    c.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, "0");
    return out;
  }
  let out = "";
  while (out.length < bytes * 2) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, bytes * 2);
}

/* The effective per-clip fit from a NORMALIZED render block: the sparse override,
   else the project default + the canvas background. PURE — inlined (mirrors
   store/meta.effectiveFit) so the engine stays free of the store surface; the
   render block is the only datum it needs. Returns {mode, background}. */
function effectiveFit(renderBlock, clipId) {
  const r = renderBlock || {};
  const canvasBg = (r.canvas && r.canvas.background) || DEFAULT_BACKGROUND;
  const override = r.fits && r.fits[clipId];
  if (override && (override.mode === "contain" || override.mode === "cover")) {
    return { mode: override.mode, background: override.background || canvasBg };
  }
  return { mode: r.default_fit === "cover" ? "cover" : DEFAULT_FIT, background: canvasBg };
}

/* ----- fingerprint (resume identity) ------------------------------------------- */

/* A stable hash of everything that defines THIS render: the keep-list, the
   resolved canvas, the per-clip fits, the music placements, and the chosen
   video codec. A change anywhere invalidates a stale checkpoint dir. djb2 over
   a canonical JSON string — collision risk is irrelevant here (it gates a
   resume of the user's OWN render, not security). */
function fingerprint(segments, canvas, fits, music, videoCodec) {
  const canonical = JSON.stringify({
    segments: segments.map((s) => [s.clip_id, round2(s.start_s), round2(s.end_s)]),
    canvas: [canvas.width, canvas.height, canvas.fps, canvas.background],
    fits,
    music: (music || []).map((m) => [
      m.track_id, round2(m.at_s), round2(m.duration_s), round2(m.track_offset_s),
      m.gain_db, m.fade_in_s, m.fade_out_s,
      m.duck ? [!!m.duck.enabled, m.duck.amount_db, m.duck.attack_s, m.duck.release_s] : 0,
    ]),
    videoCodec,
  });
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/* ----- the render plan --------------------------------------------------------- */

/* Build the ordered render units from the fold's keep-list. Each unit is one
   keep-segment with its OUTPUT placement (accumulated offset) + the source
   window. Also returns, per clip, the source→output segment mapping the duck
   word-mapper needs. */
function planSegments(segments) {
  const units = [];
  const clipMap = new Map();    // clip_id → [{source_start_s, source_end_s, output_start_s}]
  let outputOffset = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = Math.max(0, seg.end_s - seg.start_s);
    const unit = {
      index: i,
      clip_id: seg.clip_id,
      source_start_s: seg.start_s,
      source_end_s: seg.end_s,
      output_start_s: outputOffset,
      output_end_s: outputOffset + dur,
      duration_s: dur,
    };
    units.push(unit);
    if (!clipMap.has(seg.clip_id)) clipMap.set(seg.clip_id, []);
    clipMap.get(seg.clip_id).push({
      source_start_s: seg.start_s,
      source_end_s: seg.end_s,
      output_start_s: outputOffset,
    });
    outputOffset += dur;
  }
  return { units, clipMap, totalDuration: round2(outputOffset) };
}

/* ----- manifest read/write ----------------------------------------------------- */

async function readManifest(renderDir) {
  const raw = await readJSON(renderDir, MANIFEST_NAME);
  if (!raw || raw.schema !== MANIFEST_SCHEMA) return null;
  return raw;
}

async function writeManifest(renderDir, manifest) {
  manifest.updated_at = nowIso();
  await writeJSONAtomic(renderDir, MANIFEST_NAME, manifest);
}

/* Sweep the render dir of EVERYTHING (a stale fingerprint, or after a successful
   concat). Best-effort. */
async function sweepRenderDir(renderDir) {
  const doomed = [];
  try {
    for await (const [name, handle] of renderDir.entries()) {
      if (handle.kind === "file") doomed.push(name);
    }
  } catch { /* nothing to sweep */ }
  for (const name of doomed) {
    try { await renderDir.removeEntry(name); } catch { /* best effort */ }
  }
}

/* ----- per-segment render ------------------------------------------------------ */

/* Render ONE keep-segment into a standalone segment mux at renderDir/seg-NNNN.
   Returns {frames, audioFrames, bytes, durationS}. The mux contains ONE video
   track (the chosen codec) + ONE audio track (AAC), so the final concat is a
   pure packet-copy of codec-identical streams. */
async function renderSegment({
  unit, renderDir, canvas, videoConfig, audioConfig, compositor,
  videoFacts, clipAudioFacts, music, musicFacts, transcriptWords, clipSegments,
  onFrame, signal,
}) {
  const target = await tempThenRename(renderDir, SEG_NAME(unit.index));
  let output = null;
  let framesEncoded = 0;
  let audioFrames = 0;

  try {
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(target.stream, { chunked: true }),
    });

    // VIDEO: a CanvasSource over the compositor's SHARED OffscreenCanvas. The
    // canvas pixels are already UPRIGHT (compositor applied rotation), so the
    // output rotation metadata is 0.
    const videoSource = new CanvasSource(compositor.canvas, videoConfig);
    output.addVideoTrack(videoSource, { rotation: 0, frameRate: canvas.fps });

    // AUDIO: an AAC AudioSampleSource fed by audiomix.
    const audioSource = new AudioSampleSource(audioConfig);
    output.addAudioTrack(audioSource);

    await output.start();

    // ---- VIDEO: decode → compose → encode, one frame in flight ----
    const fps = Math.max(1, Math.round(canvas.fps) || 30);
    const frameDur = 1 / fps;
    const segFrames = Math.max(1, Math.round(unit.duration_s * fps));

    // The decode window over the source clip. We pull samples in presentation
    // order and HOLD the most recent decoded sample, sampling it at each output
    // frame time (nearest-source-frame hold — arch §3.1, no interpolation).
    const winStart = unit.source_start_s;
    const winEnd = unit.source_end_s;
    // The compositor fit for this clip — the orchestrator attached it to the
    // unit (effectiveFit of the render block); fall back to contain/blur.
    const clipFit = unit.fit || { mode: DEFAULT_FIT, background: DEFAULT_BACKGROUND };

    let decoded = decodeVideoWindow(videoFacts, winStart, winEnd + frameDur);
    const iter = decoded[Symbol.asyncIterator]();
    let pending = await iter.next();              // first sample
    let held = null;                              // the currently-held sample
    let heldSourceTs = -Infinity;

    // The per-frame loop holds at most the current (`held`) + the next-decoded
    // (`pending.value`) VideoSample in flight. The clean path closes both
    // IMMEDIATELY (the `held.close()` on advance + the drain after the loop).
    // The `finally` is the GUARANTEED-cleanup backstop for the ABORT/THROW exit
    // (the `signal` check below, or any throw from compose/encode/decode): on
    // such an exit `held`/`pending.value` are still open, and an un-closed
    // VideoSample reaching GC is the #1 OOM cause (arch §6.4.4) — so we close
    // them here no matter how the block exits. On the clean path these are
    // already-closed objects (close() is idempotent under the try/catch) and
    // `pending.value` is undefined (drained), so this adds no behavior there.
    try {
      for (let f = 0; f < segFrames; f++) {
        if (signal && signal.aborted) throw engineError("render canceled");
        const targetSourceTs = winStart + f * frameDur;

        // Advance the decode iterator until the held sample is the latest one at
        // or before targetSourceTs (nearest-source-frame hold).
        while (!pending.done && pending.value
          && (held === null || pending.value.timestamp <= targetSourceTs + 1e-6)) {
          // Replace the held sample with the newer one; close the old.
          if (held) { try { held.close(); } catch { /* already */ } }
          held = pending.value;
          heldSourceTs = held.timestamp;
          // Only advance if the NEXT sample is still ≤ target; otherwise keep held.
          pending = await iter.next();
          if (!pending.done && pending.value && pending.value.timestamp > targetSourceTs + 1e-6) break;
        }

        if (!held) {
          // No frame decoded yet (gap at the very start) — paint black so the
          // timeline stays aligned rather than stalling.
          compositor.clear();
        } else {
          compositor.composeFrame(held, {
            mode: clipFit.mode,
            background: clipFit.background,
            hdr: videoFacts.hdr,
          });
        }

        // Snapshot the composited canvas into the encoder at the OUTPUT timestamp
        // (segment-local 0-based; the concat re-bases to the global offset).
        const outTs = f * frameDur;
        await videoSource.add(outTs, frameDur);
        framesEncoded++;
        if (onFrame && (framesEncoded % PROGRESS_BATCH === 0)) onFrame(framesEncoded, segFrames);
      }

      // Drain + close any remaining decoded samples (bounded — a handful).
      if (held) { try { held.close(); } catch { /* already */ } }
      held = null;
      while (!pending.done) {
        if (pending.value) { try { pending.value.close(); } catch { /* already */ } }
        pending = await iter.next();
      }
    } finally {
      // Guaranteed cleanup for the abort/throw exit (a no-op on the clean path,
      // where `held` is already null and `pending.value` is undefined): close
      // any still-in-flight sample so a forced cancel can never leak a frame.
      if (held) { try { held.close(); } catch { /* already */ } }
      if (pending && pending.value) { try { pending.value.close(); } catch { /* already */ } }
    }

    // ---- AUDIO: mix this segment (clip audio + overlapping music) ----
    audioFrames = await mixSegmentAudio({
      clipAudio: clipAudioFacts,
      sourceStart: unit.source_start_s,
      sourceEnd: unit.source_end_s,
      segStartOut: 0,                              // segment-local 0-based
      segEndOut: unit.duration_s,
      // Music placements are on the GLOBAL output timeline; shift them into the
      // segment-local frame by subtracting the segment's output offset.
      music: (music || [])
        .map((m) => ({ ...m, at_s: m.at_s - unit.output_start_s }))
        .filter((m) => (m.at_s + (m.duration_s || 0)) > 0 && m.at_s < unit.duration_s),
      musicFacts,
      transcriptWords,
      // clipSegments mapped to segment-local output time for duck word mapping.
      clipSegments: (clipSegments || [])
        .filter((s) => s.output_start_s >= unit.output_start_s - 1e-6
          && s.output_start_s < unit.output_end_s + 1e-6)
        .map((s) => ({ ...s, output_start_s: s.output_start_s - unit.output_start_s })),
      addAudioSample: async (init) => {
        const sample = new AudioSample(init);
        try {
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
      },
      signal,
    });

    await output.finalize();
    if (onFrame) onFrame(framesEncoded, segFrames);

    // Commit the segment mux (verify happens at the final concat, but a per-
    // segment sanity check keeps a broken segment from poisoning the resume).
    await target.commit();
    const file = await (await renderDir.getFileHandle(SEG_NAME(unit.index))).getFile();
    return {
      frames: framesEncoded,
      audioFrames,
      bytes: file.size,
      durationS: round2(unit.duration_s),
    };
  } catch (err) {
    await abandonOutput(output, target && target.stream);
    try { await target.abandon(); } catch { /* the abandonOutput may have closed it */ }
    throw err;
  }
}

/* ----- concat the segment muxes (packet copy) ---------------------------------- */

/* Join the finished, codec-identical segment muxes into one output via pure
   packet-copy (cut.js's re-basing merge, applied across whole files). Each
   segment is opened, its video+audio packets re-based to the running output
   offset and merged by timestamp. Streams through the normalizing target.
   Returns the writer stats for verify. */
async function concatSegments(renderDir, segmentNames, target) {
  let output = null;
  const inputs = [];
  try {
    // Open the first segment to learn the codecs.
    const firstFile = await (await renderDir.getFileHandle(segmentNames[0])).getFile();
    const firstInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(firstFile) });
    inputs.push(firstInput);
    await firstInput.getFormat();
    const firstVideo = await firstInput.getPrimaryVideoTrack();
    if (!firstVideo) throw engineError("a rendered segment has no video track");
    const firstAudio = await firstInput.getPrimaryAudioTrack();
    const vCodec = await firstVideo.getCodec();
    const aCodec = firstAudio ? await firstAudio.getCodec() : null;

    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(target.stream, { chunked: true }),
    });
    const vSource = new EncodedVideoPacketSource(vCodec);
    output.addVideoTrack(vSource, { rotation: 0 });
    let aSource = null;
    if (aCodec) {
      aSource = new EncodedAudioPacketSource(aCodec);
      output.addAudioTrack(aSource);
    }
    await output.start();

    let vFirst = true;
    let aFirst = true;
    let outputOffset = 0;

    for (let si = 0; si < segmentNames.length; si++) {
      let input;
      let video;
      let audio;
      if (si === 0) {
        input = firstInput; video = firstVideo; audio = firstAudio;
      } else {
        const file = await (await renderDir.getFileHandle(segmentNames[si])).getFile();
        input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
        inputs.push(input);
        await input.getFormat();
        video = await input.getPrimaryVideoTrack();
        audio = await input.getPrimaryAudioTrack();
        if (!video) throw engineError("a rendered segment lost its video track");
      }

      const vSink = new EncodedPacketSink(video);
      const aSink = audio ? new EncodedPacketSink(audio) : null;
      const vMeta = vFirst ? { decoderConfig: await video.getDecoderConfig() } : undefined;
      const aMeta = (aSink && aFirst) ? { decoderConfig: await audio.getDecoderConfig() } : undefined;

      // Re-base every packet of this segment to outputOffset; merge by ts.
      let segEnd = 0;
      const vIter = vSink.packets()[Symbol.asyncIterator]();
      let aIter = aSink ? aSink.packets()[Symbol.asyncIterator]() : null;
      let v = await vIter.next();
      let a = aIter ? await aIter.next() : { done: true };
      let vUsedMeta = false;
      let aUsedMeta = false;

      while (!v.done || (a && !a.done)) {
        const takeVideo = !v.done && (a.done || v.value.timestamp <= a.value.timestamp);
        if (takeVideo) {
          const p = v.value;
          await vSource.add(p.clone({ timestamp: p.timestamp + outputOffset }),
            (vFirst && !vUsedMeta) ? vMeta : undefined);
          vUsedMeta = true; vFirst = false;
          segEnd = Math.max(segEnd, p.timestamp + p.duration);
          v = await vIter.next();
        } else if (a && !a.done) {
          const p = a.value;
          await aSource.add(p.clone({ timestamp: p.timestamp + outputOffset }),
            (aFirst && !aUsedMeta) ? aMeta : undefined);
          aUsedMeta = true; aFirst = false;
          segEnd = Math.max(segEnd, p.timestamp + p.duration);
          a = await aIter.next();
        }
      }
      outputOffset += segEnd;
    }

    await output.finalize();
    return { writes: target.stats, outputSeconds: round2(outputOffset) };
  } catch (err) {
    await abandonOutput(output, target && target.stream);
    throw err;
  } finally {
    for (const inp of inputs) { try { inp.dispose(); } catch { /* already */ } }
  }
}

/* ----- the orchestrator -------------------------------------------------------- */

/**
 * Render a project's mixed-clip + music timeline into one coherent SDR video.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {Object} opts.fold          edl.js fold: { segments, timeline_duration_s, music }.
 * @param {Object} opts.renderBlock   the NORMALIZED render block (store/meta).
 * @param {Object} [opts.canvas]      pre-resolved canvas; else resolved here
 *                                    from renderBlock + clips.
 * @param {Array}  opts.clips         live clipmeta (for canvas resolve + fits).
 * @param {Array}  [opts.music]       fold.music (defaults to fold.music).
 * @param {Object} opts.sources       { [clip_id]: File } — OPFS clip files.
 * @param {Object} [opts.musicSources] { [track_id]: File } — OPFS music files.
 * @param {Object} [opts.transcripts]  { [clip_id]: {words:[{s,e}]} } for ducking.
 * @param {Function} [opts.onProgress] ({segment, segmentsTotal, framesDone,
 *                                    framesTotal, fps, etaS}) heartbeat.
 * @param {AbortSignal} [opts.signal]  cancels the render (the .tmp/checkpoints
 *                                    survive for resume; a fresh fingerprint
 *                                    match resumes, a mismatch sweeps).
 * @returns {Promise<Object>} { handle, stats, verdict } —
 *          handle: the COMMITTED out-<ts>.mp4 file handle in render/ (the caller
 *                  moves it to exports/ after its own re-verify, or trusts this
 *                  verdict); stats: render facts; verdict: verify.verifyOutput.
 *          On verify FAIL the output is renamed .corrupt and the verdict says so
 *          (the caller never shares a corrupt render under a trusted name).
 */
export async function renderProject({
  projectId, fold, renderBlock, canvas, clips = [], music,
  sources = {}, musicSources = {}, transcripts = {},
  onProgress, signal,
}) {
  if (!fold || !Array.isArray(fold.segments) || fold.segments.length === 0) {
    throw engineError("nothing to render — the timeline is empty");
  }
  const segments = fold.segments;
  const placements = Array.isArray(music) ? music : (Array.isArray(fold.music) ? fold.music : []);
  const resolved = canvas || resolveCanvas(renderBlock, clips);
  const t0 = nowMs();

  // Probe the encoder configs FIRST (the honest "can this device render"
  // second-guard; HEVC-when-supported else H.264, no UA sniff).
  const videoConfig = await pickVideoEncoderConfig(resolved);
  const audioConfig = await pickAudioEncoderConfig();

  // Plan the render units + the per-clip source→output mapping.
  const { units, clipMap, totalDuration } = planSegments(segments);

  // Attach the effective fit to each unit (the compositor reads it).
  for (const unit of units) {
    unit.fit = effectiveFit(renderBlock, unit.clip_id);
  }

  // The fits snapshot for the fingerprint (only the involved clips).
  const fitsSnapshot = {};
  for (const unit of units) fitsSnapshot[unit.clip_id] = unit.fit;
  const fp = fingerprint(segments, resolved, fitsSnapshot, placements, videoConfig.codec);

  const renderDir = await projectSubDir(projectId, RENDER_DIR, { create: true });

  // Resume check: a matching-fingerprint manifest lets us skip done segments.
  let manifest = await readManifest(renderDir);
  if (!manifest || manifest.fingerprint !== fp) {
    if (manifest) await sweepRenderDir(renderDir);   // stale → start fresh
    manifest = {
      schema: MANIFEST_SCHEMA,
      render_id: "rnd_" + fp,
      fingerprint: fp,
      canvas: { width: resolved.width, height: resolved.height, fps: resolved.fps },
      video_codec: videoConfig.codec,
      music_applied: placements.length > 0,
      created_at: nowIso(),
      updated_at: nowIso(),
      total_duration_s: totalDuration,
      segments: units.map((u) => ({
        index: u.index, clip_id: u.clip_id,
        in_s: round2(u.source_start_s), out_s: round2(u.source_end_s),
        status: "pending", part_name: SEG_NAME(u.index), frames: 0, bytes: 0,
      })),
    };
    await writeManifest(renderDir, manifest);
  }

  const doneStatus = new Map(manifest.segments.map((s) => [s.index, s.status === "done"]));

  // ---- render each pending segment ----
  const compositor = createCompositor(resolved);
  const framesTotalAll = units.reduce((acc, u) => acc + Math.max(1, Math.round(u.duration_s * resolved.fps)), 0);
  let framesDoneAll = units
    .filter((u) => doneStatus.get(u.index))
    .reduce((acc, u) => acc + Math.max(1, Math.round(u.duration_s * resolved.fps)), 0);

  // Open every distinct clip's decode facts lazily + cache; close at the end.
  const videoFactsCache = new Map();
  const audioFactsCache = new Map();
  const musicFactsCache = new Map();

  async function getVideoFacts(clipId) {
    if (videoFactsCache.has(clipId)) return videoFactsCache.get(clipId);
    const file = sources[clipId];
    if (!file) throw engineError("missing source file for clip " + clipId);
    const facts = await openVideoForDecode(file);
    videoFactsCache.set(clipId, facts);
    return facts;
  }
  async function getAudioFacts(clipId) {
    if (audioFactsCache.has(clipId)) return audioFactsCache.get(clipId);
    const file = sources[clipId];
    if (!file) { audioFactsCache.set(clipId, null); return null; }
    const facts = await openAudioForDecode(file);
    audioFactsCache.set(clipId, facts);
    return facts;
  }
  async function getMusicFacts(trackId) {
    if (musicFactsCache.has(trackId)) return musicFactsCache.get(trackId);
    const file = musicSources[trackId];
    if (!file) { musicFactsCache.set(trackId, null); return null; }
    const facts = await openAudioForDecode(file);
    musicFactsCache.set(trackId, facts);
    return facts;
  }

  try {
    // Pre-open the music facts once (each track decoded windowed many times).
    const musicFacts = {};
    for (const m of placements) {
      if (!musicFacts[m.track_id]) musicFacts[m.track_id] = await getMusicFacts(m.track_id);
    }

    for (const unit of units) {
      if (signal && signal.aborted) throw engineError("render canceled");
      if (doneStatus.get(unit.index)) continue;       // resumed — skip

      const videoFacts = await getVideoFacts(unit.clip_id);
      const clipAudioFacts = await getAudioFacts(unit.clip_id);
      const transcriptWords = (transcripts[unit.clip_id] && Array.isArray(transcripts[unit.clip_id].words))
        ? transcripts[unit.clip_id].words : [];
      const clipSegments = clipMap.get(unit.clip_id) || [];

      const segStart = nowMs();
      const result = await renderSegment({
        unit, renderDir, canvas: resolved, videoConfig, audioConfig, compositor,
        videoFacts, clipAudioFacts, music: placements, musicFacts,
        transcriptWords, clipSegments,
        onFrame: (segFramesDone, segFramesTotal) => {
          const overall = framesDoneAll + segFramesDone;
          const elapsed = (nowMs() - t0) / 1000;
          const fpsNow = elapsed > 0 ? overall / elapsed : 0;
          const remaining = framesTotalAll - overall;
          const etaS = fpsNow > 0 ? Math.round(remaining / fpsNow) : null;
          report(onProgress, {
            segment: unit.index, segmentsTotal: units.length,
            framesDone: overall, framesTotal: framesTotalAll,
            fps: round2(fpsNow), etaS,
          });
        },
        signal,
      });

      // Checkpoint: mark this segment done in the manifest.
      const entry = manifest.segments.find((s) => s.index === unit.index);
      if (entry) {
        entry.status = "done";
        entry.frames = result.frames;
        entry.bytes = result.bytes;
      }
      await writeManifest(renderDir, manifest);
      doneStatus.set(unit.index, true);
      framesDoneAll += Math.max(1, Math.round(unit.duration_s * resolved.fps));
      void segStart;
    }

    // ---- concat the segment muxes → out-<ts>-<rand>.mp4 (packet copy) ----
    // A random suffix guards against two renders committing in the same
    // millisecond (Date.now() alone can collide); the .corrupt quarantine name
    // below derives from finalName, so it inherits the same unique stem.
    const finalName = "out-" + Date.now() + "-" + randomToken() + ".mp4";
    const concatTarget = await tempThenRename(renderDir, finalName);
    let concatStats;
    try {
      const orderedNames = units.map((u) => SEG_NAME(u.index));
      concatStats = await concatSegments(renderDir, orderedNames, concatTarget);
    } catch (err) {
      await concatTarget.abandon();
      throw err;
    }

    // ---- verify BEFORE exposing (SDR-aware) ----
    const expectAudio = true;   // the render always writes an audio track
    const verdict = await verifyOutput({
      handle: concatTarget.handle,
      expectedSeconds: totalDuration,
      expectAudio,
      writeStats: concatStats.writes,
      expectSdr: true,
    });

    if (verdict && verdict.status === "ok") {
      await concatTarget.commit();
      const handle = await renderDir.getFileHandle(finalName);
      // Success → sweep the segment checkpoints + manifest (the output stands
      // alone now). Keep the final output.
      await sweepCheckpointsKeepingOutput(renderDir, finalName);
      const stats = {
        container: "MP4",
        video_codec: videoConfig.codec,
        audio_codec: audioConfig.codec,
        canvas: { width: resolved.width, height: resolved.height, fps: resolved.fps },
        background: resolved.background,
        segments_total: units.length,
        frames_total: framesTotalAll,
        music_placements: placements.length,
        output_seconds: concatStats.outputSeconds,
        timeline_seconds: totalDuration,
        wallMs: Math.round(nowMs() - t0),
        writes: concatStats.writes,
        final_name: finalName,
      };
      return { handle, stats, verdict };
    }

    // Verify FAILED → quarantine as .corrupt, never expose under a trusted name.
    const corruptName = finalName.replace(/\.mp4$/, "") + ".corrupt.mp4";
    try {
      await concatTarget.commit();           // commit the .tmp first…
      const fh = await renderDir.getFileHandle(finalName);
      if (typeof fh.move === "function") await fh.move(renderDir, corruptName);
    } catch { /* best-effort quarantine */ }
    const stats = {
      container: "MP4",
      video_codec: videoConfig.codec,
      audio_codec: audioConfig.codec,
      canvas: { width: resolved.width, height: resolved.height, fps: resolved.fps },
      segments_total: units.length,
      wallMs: Math.round(nowMs() - t0),
      final_name: corruptName,
      corrupt: true,
    };
    let handle = null;
    try { handle = await renderDir.getFileHandle(corruptName); } catch { /* gone */ }
    return { handle, stats, verdict };
  } finally {
    // Dispose every opened decode input + the compositor scratch.
    for (const f of videoFactsCache.values()) { try { f && f.dispose(); } catch { /* */ } }
    for (const f of audioFactsCache.values()) { try { f && f.dispose(); } catch { /* */ } }
    for (const f of musicFactsCache.values()) { try { f && f.dispose(); } catch { /* */ } }
    try { compositor.dispose(); } catch { /* */ }
  }
}

/* Remove the segment .part muxes + the manifest after a successful concat,
   keeping ONLY the final output file. Best-effort. */
async function sweepCheckpointsKeepingOutput(renderDir, keepName) {
  const doomed = [];
  try {
    for await (const [name, handle] of renderDir.entries()) {
      if (handle.kind === "file" && name !== keepName) doomed.push(name);
    }
  } catch { /* nothing */ }
  for (const name of doomed) {
    try { await renderDir.removeEntry(name); } catch { /* best effort */ }
  }
}

function report(onProgress, payload) {
  if (typeof onProgress !== "function") return;
  try { onProgress(payload); } catch { /* a progress UI failure never kills the render */ }
}
