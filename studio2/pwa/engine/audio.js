/* =============================================================================
   engine/audio.js — lossless audio-track EXTRACTION (arch §5.1, M2).
   -----------------------------------------------------------------------------
   `extractAudio({file, target, onProgress})` packet-copies a clip's PRIMARY
   audio track into a fresh audio-only MP4 (an `.m4a`) — the `cut.js` machinery
   minus the video track, minus the multi-segment stitching. NO re-encode, NO
   WebCodecs, NO decode: every AAC packet's payload is copied byte-for-byte.

   Timestamp re-basing (the ONE arithmetic, same as cut.js's first segment):
   the whole track is shifted so the OUTPUT starts at 0 —
   `out_ts = packet.timestamp − firstTimestamp`. This is mandatory, not
   cosmetic: real recordings carry a small NEGATIVE audio start (AAC encoder
   priming / an edit-list offset — e.g. −0.023 s on the test footage), and the
   muxer REJECTS negative timestamps ("Timestamps must be non-negative"). cut.js
   never hits it because it re-bases every segment to a 0-based outputOffset;
   a naive "copy timestamps unchanged" full-track copy crashes on exactly the
   footage this product targets. The shift is ≤ a few tens of ms (sub-keyframe,
   far under the 0.35–0.8 s silence gaps the agent places cuts in), so EL's
   word times — relative to the uploaded audio's zero — align with the clip's
   source clock within the snapping tolerance (arch §4.2 "one clock"). A clip
   whose audio already starts at 0 is shifted by 0 (a true byte/timing copy).

   WHY this exists (arch §0, §2.1): transcription's ONE deliberate byte-leak is
   the AUDIO, not the video. Extracting just the AAC track yields a file ≈1% of
   the clip's bytes in seconds, which is then uploaded to the relay. The video
   never leaves the device. This module produces that small `.m4a`; the upload,
   consent, and poll all live in transcribe.js (T4).

   The flow NEVER COMMITS the output to its final name (arch §5.1): the caller
   passes `target = writers.tempThenRename(transcriptsDir, "clip_<id>.m4a")`,
   we write through it, and after extraction the caller reads the committed
   `.tmp` back as a File for the upload and then calls `target.abandon()` to
   delete it — the `.m4a` is a transient upload artifact, not durable state.
   A crash anywhere leaves only a `transcripts/*.tmp` orphan, removed by the
   boot sweep (store/opfs.js sweepTmp, widened to transcripts/ in M2). This
   module's only job is to fill the temp file and verify it; commit-vs-abandon
   is the caller's call (and the M2 caller always abandons).

   Banked M0 invariants, same as cut.js:
   • #1 view-normalization — enforced BY CONSTRUCTION: `target.stream` came
     through writers.normalizingWritable(); a bare WritableStream is REFUSED,
     so a StreamTarget can never sit on a raw OPFS writable.
   • #3 temp-name write — the target writes a `.tmp`; the final name is never
     a write target (Output.cancel() commits partial bytes on its given name).
   • #4/#5 verify before exposing — a light verify here (file.size ===
     writes.logicalEnd && size > 0); the DEEP validation is ElevenLabs parsing
     the `.m4a` server-side (arch §5.1) — a device that can't decode AAC still
     can't tell a good `.m4a` from a subtly-broken one, so we don't pretend to.
   • #6 no self-metering — one engine op at a time is the caller's contract
     (transcribe.js runs extract+upload on the shared single-flight op queue).

   Clean, EARLY `engine_error` (before any byte is written) on: no audio track
   (the degraded/silent-copy class — the UI disables the button first, this is
   the second guard), an unrecognized audio codec, or a container mediabunny
   can't open. Errors carry `.code` (bridge taxonomy, duck-typed — no
   instanceof across the ?v= double-load boundary), exactly like cut.js.

   Pure module: mediabunny + writers (+ transitively store/opfs via writers)
   only. NO DOM, NO fetch, NO app state — reusable by M3 unchanged (arch §1.4).
============================================================================= */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  EncodedPacketSink,
  Output,
  Mp4OutputFormat,
  StreamTarget,
  EncodedAudioPacketSource,
} from "./mediabunny.js";
import { abandonOutput, engineError } from "./writers.js";

const PROGRESS_BATCH = 64; // onProgress fires once per this many packets

function round2(n) { return Math.round(n * 100) / 100; }

/* Open the input, locate + validate the primary audio track, and gather the
   facts the copy loop needs. Mirrors cut.js openSource()'s format-quirk guard:
   disposing an input whose format detection REJECTED mints an unhandled
   rejection in the vendored bundle (Input.dispose → demuxer?.then), so we skip
   dispose() when getFormat() threw — there is no demuxer to free anyway. */
async function openAudioSource(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let formatOk = false;
  try {
    await input.getFormat();      // throws on a container mediabunny can't open
    formatOk = true;

    const audio = await input.getPrimaryAudioTrack();
    if (!audio) {
      // The degraded/silent-copy case (arch §13): the UI disables Transcribe
      // for audio-less clips; this is the engine's own second guard.
      throw engineError("this clip has no audio track — there is nothing to transcribe");
    }
    const codec = await audio.getCodec();
    if (!codec) {
      throw engineError(
        "this clip's audio format can't be packaged for transcription ("
        + (await audio.getCodecParameterString()) + ")",
      );
    }
    return {
      input,
      track: audio,
      sink: new EncodedPacketSink(audio),
      codec,                                   // e.g. "aac"
      codecString: await audio.getCodecParameterString(),
      decoderConfig: await audio.getDecoderConfig(),
    };
  } catch (err) {
    if (formatOk) {
      try { input.dispose(); } catch { /* already dead */ }
    } else {
      // getFormat() rejected — re-tag a bare platform error so the caller gets
      // the bridge taxonomy, but keep an explicit engine_error untouched.
      if (!(err && typeof err.code === "string")) {
        throw engineError("this file can't be opened as a video — its container isn't recognized");
      }
    }
    throw err;
  }
}

/**
 * Lossless extraction of a clip's primary audio track into an audio-only MP4
 * (`.m4a`) — packet copy, no re-encode.
 *
 * @param {Object}   opts
 * @param {Blob}     opts.file        the source clip (an OPFS clip File/Blob).
 * @param {Object}   opts.target      writers.tempThenRename() /
 *                                    normalizingWritable() result
 *                                    ({stream, stats, …}). A bare stream is
 *                                    REFUSED (banked #1).
 * @param {Function} [opts.onProgress] ({packets, mediaBytes}) — per packet
 *                                    batch; a throwing callback never kills the
 *                                    extract.
 * @returns {Promise<Object>} {
 *            durationS,    // the EXTRACTED audio's duration (s) = the 0-based
 *                          //   output length EL will see (last packet end −
 *                          //   the track's natural start) — the declared
 *                          //   duration_s for the upload + transcript.
 *            audioPackets, // packets copied
 *            mediaBytes,   // payload bytes copied
 *            codec,        // mediabunny codec id, e.g. "aac"
 *            writes        // target.stats — what the light verify compares to
 *          }
 *
 * On ANY failure: best-effort abandonOutput() teardown, then the original
 * error is rethrown. The `.tmp` file itself is the caller's target.abandon().
 * The caller then reads the committed `.tmp` back as a File for the upload and
 * abandon()s it (the `.m4a` is transient — arch §5.1).
 */
export async function extractAudio({ file, target, onProgress } = {}) {
  // Banked #1 by construction: refuse anything that isn't a normalizing target.
  if (!target || !(target.stream instanceof WritableStream) || !target.stats) {
    throw engineError(
      "extract target must come from writers.tempThenRename()/normalizingWritable() — never a raw writable",
    );
  }
  const isBlob = typeof Blob !== "undefined" && file instanceof Blob; // File extends Blob
  if (!isBlob) throw engineError("a source clip File/Blob is required");

  // --- 1. Open + validate UP FRONT (clean early error, zero bytes written) ---
  const src = await openAudioSource(file);

  let output = null;
  try {
    // --- 2. Audio-only MP4 output over the already-normalized target stream.
    //        Always Mp4OutputFormat — we are re-containering a single AAC
    //        track regardless of the source container (arch §5.1). fastStart
    //        :false = metadata at EOF (positioned writes, OPFS-friendly), the
    //        same M0-proven low-memory choice cut.js makes.
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(target.stream, { chunked: true }),
    });
    const aSource = new EncodedAudioPacketSource(src.codec);
    output.addAudioTrack(aSource);
    await output.start();

    // Decoder config attaches on the FIRST packet only (mediabunny contract).
    const aMeta = { decoderConfig: src.decoderConfig };
    let firstPacket = true;
    let base = 0;          // the first packet's timestamp — the whole track shifts to 0
    let lastOutputEnd = 0; // realized 0-based end of the extracted audio

    let audioPackets = 0;
    let mediaBytes = 0;
    let sinceProgress = 0;

    const reportProgress = () => {
      if (typeof onProgress !== "function") return;
      try {
        onProgress({ packets: audioPackets, mediaBytes });
      } catch { /* a progress UI failure must never kill the extract */ }
    };

    // --- 3. Copy EVERY audio packet, re-based so the output starts at 0
    //        (out_ts = ts − base). packets() with no start packet iterates the
    //        whole track in decode order; payloads are copied untouched (no
    //        re-encode) — only the presentation timestamp is shifted.
    for await (const packet of src.sink.packets()) {
      if (firstPacket) base = packet.timestamp; // capture the track's natural start
      const outTs = packet.timestamp - base;
      await aSource.add(
        packet.clone({ timestamp: outTs }),
        firstPacket ? aMeta : undefined,
      );
      firstPacket = false;
      audioPackets++;
      mediaBytes += packet.byteLength;
      lastOutputEnd = Math.max(lastOutputEnd, outTs + packet.duration);
      if (++sinceProgress >= PROGRESS_BATCH) {
        sinceProgress = 0;
        reportProgress();
      }
    }

    if (audioPackets === 0) {
      // A track that reports present but yields no packets — refuse rather
      // than upload an empty container EL would reject anyway.
      throw engineError("this clip's audio track is empty — there is nothing to transcribe");
    }

    // --- 4. Finalize commits the .tmp through the wrapper (writes.closed flips
    //        true). The caller then reads it back + uploads + abandon()s.
    await output.finalize();
    reportProgress();

    return {
      durationS: round2(lastOutputEnd),
      audioPackets,
      mediaBytes,
      codec: src.codec,
      writes: target.stats,
    };
  } catch (err) {
    // Best-effort, never masks `err`. The .tmp cleanup is the caller's
    // target.abandon() (which tolerates this teardown having already run).
    await abandonOutput(output, target.stream);
    throw err;
  } finally {
    try { src.input.dispose(); } catch { /* already disposed */ }
  }
}
