/* =============================================================================
   engine/verify.js — post-finalize output integrity self-check (arch §6.3,
   banked M0 requirements #4 + #5; M3 SDR-aware extension §6.4.2).
   -----------------------------------------------------------------------------
   Runs BEFORE the .tmp → final rename: export gates the rename on an "ok"
   verdict, so a structurally broken file can never sit in exports/ under a
   trusted name (the M0 field corruption shipped to Photos precisely because
   nothing re-checked the muxed bytes).

   SDR is asserted by an ALLOWLIST, not a blocklist (M3 hardening): an output is
   "SDR" ONLY when its colorTransfer is one of the known standard-range transfers
   (bt709 / smpte170m / iec61966-2-1[sRGB]). ANY other transfer — PQ/HLG, a
   generic 10-bit bt2020-* wide-gamut transfer, or an unrecognized tag — is
   treated as NOT-SDR, so an unexpected HDR/wide-gamut output can never slip
   through the last automated standard-range guard. (A blocklist of the known
   HDR transfers would PASS a novel one it had never seen — exactly the gap this
   closes.)

   Checks, in order:
     1. size — the file's TRUE on-disk size vs writeStats.logicalEnd (the
        muxer's own end-of-file from the normalization wrapper). NOT vs any
        expected byte count: Safari's corrupted outputs landed exactly
        chunk-aligned, so "size looks plausible" proves nothing — equality
        with the logical end is the only honest size check (banked #5).
     2. re-parse — a full mediabunny re-open of the committed bytes:
        container, track count, primary video codec, audio presence.
     3. duration — computed duration within ±0.5 s (arch §6.3) of the folded
        timeline duration the caller expected.
     4. A/V presence — a video track must parse; when the caller expected
        audio (expectAudio), an output without it is a corruption.
     5. SDR (M3, `expectSdr`) — a RENDERED output must be standard-range. The
        output's colorTransfer must be in the SDR ALLOWLIST (bt709 / smpte170m /
        iec61966-2-1[sRGB]); ANY other transfer — PQ/HLG or a generic 10-bit
        bt2020-* wide-gamut transfer — fails the check. The render tone-maps
        HDR→SDR (no browser encodes 10-bit, arch §0/§1); a non-SDR colorTransfer
        in the output would mean the tone-map was bypassed — a corruption for the
        render path. The LOSSLESS path passes expectSdr:false (it deliberately
        preserves the source's HDR), so this check fires ONLY for renders. The
        verdict SHAPE is unchanged (status/problems/text) so export.js needs no
        new branch — a non-SDR render is just another "corrupt".

   NEVER throws — a broken output must still produce a verdict, not an
   exception: { status: "ok" | "corrupt" | "error", problems[], text, … }.
   "error" = the check itself could not run (the file may still be fine);
   callers treat anything but "ok" as not-shippable.

   Known limit (spike-documented): a same-size mdat smear (media bytes
   corrupted in place, length and moov intact) parses and duration-matches —
   "plays on the device" remains the human backstop.
============================================================================= */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
} from "./mediabunny.js";

export const DURATION_TOLERANCE_S = 0.5;

function round2(n) { return Math.round(n * 100) / 100; }

/* The KNOWN standard-range color transfers (lowercased). mediabunny reports the
   WebCodecs `VideoTransferCharacteristics` tag from its TRANSFER_CHARACTERISTICS
   map — `bt709` (BT.709), `smpte170m` (BT.601), `iec61966-2-1` (sRGB) — and
   ffprobe/other tooling may surface `srgb` for the same sRGB transfer; all four
   are admitted. Anything NOT in this set (PQ/HLG, a bt2020-* 10-bit transfer, or
   an unrecognized tag) is treated as NOT-SDR — allowlist, never blocklist, so an
   unexpected HDR/wide-gamut transfer can't pass as standard-range. */
const SDR_TRANSFERS = new Set(["bt709", "smpte170m", "iec61966-2-1", "srgb"]);

/* True only for a recognized standard-range transfer. An empty/unreadable
   transfer is NOT decided here — the caller treats a missing color signal as
   the common SDR case (no HDR transfer present); this function speaks only to a
   transfer string that WAS read. */
function isSdrTransfer(transfer) {
  const t = String(transfer || "").toLowerCase().trim();
  if (t === "") return false;                 // no signal — decided by the caller
  if (t.startsWith("bt2020")) return false;   // any bt2020-* (e.g. bt2020-10) wide-gamut transfer is not SDR
  return SDR_TRANSFERS.has(t);
}

function errText(e) {
  if (!e) return "unknown error";
  const name = e.name || (e.constructor && e.constructor.name) || "Error";
  return name + ": " + (e.message || String(e));
}

async function hexOfSlice(blob, start, end) {
  if (end <= start) return "";
  const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (i ? " " : "") + bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Verify a finalized output file.
 *
 * @param {Object} opts
 * @param {FileSystemFileHandle} [opts.handle]  the committed file's handle
 *                                              (normally the .tmp — verify
 *                                              runs BEFORE the rename).
 * @param {Blob}   [opts.file]                  alternative to handle.
 * @param {number} [opts.expectedSeconds]       the folded timeline duration.
 * @param {boolean}[opts.expectAudio]           the source/keep-list carried
 *                                              audio, so the output must too.
 * @param {Object} [opts.writeStats]            target.stats from the writer
 *                                              wrapper ({logicalEnd, …}).
 * @param {boolean}[opts.expectSdr]             M3: the output MUST be standard-
 *                                              range (not PQ/HLG). The render
 *                                              path passes true; the lossless
 *                                              path omits it (HDR preserved).
 * @returns {Promise<Object>} verdict — never rejects:
 *   { status, problems[], text, fileBytes, expectedBytes?, first16Hex,
 *     last16Hex, container?, trackCount?, videoCodec?, hasAudio?,
 *     durationSeconds?, expectedSeconds?, colorTransfer?, isSdr?, parseError? }
 */
export async function verifyOutput({ handle, file, expectedSeconds, expectAudio, writeStats, expectSdr } = {}) {
  const v = { checkedAt: new Date().toISOString(), status: "error", problems: [] };
  try {
    const f = file || (handle ? await handle.getFile() : null);
    if (!f) {
      v.error = "nothing to verify (no handle/file given)";
      v.text = "Could not check the output (" + v.error + ").";
      return v;
    }
    v.fileBytes = f.size;
    v.first16Hex = await hexOfSlice(f, 0, Math.min(16, f.size));
    v.last16Hex = await hexOfSlice(f, Math.max(0, f.size - 16), f.size);

    // 1. True size vs the muxer's logical end (banked #5).
    if (writeStats && typeof writeStats.logicalEnd === "number" && writeStats.logicalEnd > 0) {
      v.expectedBytes = writeStats.logicalEnd;
      if (f.size !== writeStats.logicalEnd) {
        v.problems.push("the file on disk is " + f.size.toLocaleString("en-US")
          + " bytes but the muxer wrote " + writeStats.logicalEnd.toLocaleString("en-US")
          + " bytes — the browser " + (f.size > writeStats.logicalEnd ? "inflated" : "truncated") + " it");
      }
    }

    // 2-4. Full re-parse of the committed bytes.
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(f) });
    let formatOk = false; // vendored-bundle quirk: disposing an input whose
    // format detection REJECTED mints an unhandled rejection (dispose() does
    // `void this._demuxerPromise?.then(...)`) — skip disposal in that case
    // (there is no demuxer to free).
    try {
      const format = await input.getFormat();
      formatOk = true;
      v.container = format.name;
      v.trackCount = (await input.getTracks()).length;
      v.durationSeconds = round2(await input.computeDuration());
      const video = await input.getPrimaryVideoTrack();
      if (video) {
        v.videoCodec = await video.getCodec();
        // 5. SDR sanity (M3 render path): the output's colorTransfer must be a
        //    KNOWN standard-range transfer (allowlist — bt709 / smpte170m /
        //    iec61966-2-1[sRGB]). The colorTransfer characteristic is the honest
        //    signal: PQ ("pq"/"smpte2084") / HLG ("hlg"/"arib-std-b67") and any
        //    generic 10-bit bt2020-* wide-gamut transfer mean an HDR transfer the
        //    render is supposed to have tone-mapped away. A render that reports
        //    ANY non-allowlisted transfer bypassed the tone-map → corrupt. The
        //    allowlist (vs a known-HDR blocklist) is deliberate: an unexpected
        //    HDR/wide-gamut transfer the blocklist never enumerated would slip
        //    through as "SDR"; allowlisting the known-good transfers fails it.
        try {
          const color = await video.getColorSpace();
          v.colorTransfer = (color && color.transfer) || null;
          if (v.colorTransfer == null) {
            // Color signal present but no transfer field — can't assert; the
            // absence of an HDR transfer is the common (SDR) case.
            v.isSdr = true;
          } else {
            v.isSdr = isSdrTransfer(v.colorTransfer);
          }
          if (expectSdr && !v.isSdr) {
            v.problems.push("the output is not standard-range (color transfer \"" + v.colorTransfer
              + "\") but a rendered video must be SDR — the tone-map did not apply");
          }
        } catch {
          // Color space unreadable — not fatal; SDR can't be asserted but the
          // absence of an HDR transfer is the common (SDR) case.
          v.colorTransfer = null;
          v.isSdr = true;
        }
      } else {
        v.problems.push("no video track found");
      }
      const audio = await input.getPrimaryAudioTrack();
      v.hasAudio = !!audio;
      if (expectAudio && !audio) {
        v.problems.push("the sound track is missing from the output");
      }
      if (typeof expectedSeconds === "number" && Number.isFinite(expectedSeconds)) {
        v.expectedSeconds = round2(expectedSeconds);
        if (Math.abs(v.durationSeconds - expectedSeconds) > DURATION_TOLERANCE_S) {
          v.problems.push("it plays as " + v.durationSeconds + " s but about "
            + v.expectedSeconds + " s was expected");
        }
      }
    } catch (e) {
      v.parseError = errText(e);
      v.problems.push("it does not parse as a video file (" + v.parseError + ")");
    } finally {
      if (formatOk) {
        try { input.dispose(); } catch { /* already disposed */ }
      }
    }

    v.status = v.problems.length > 0 ? "corrupt" : "ok";
  } catch (e) {
    v.error = errText(e);
  }

  // Phone-safe verdict copy (v1 plain-language convention).
  if (v.status === "ok") {
    v.text = "Output verified: parses as " + v.container + ", "
      + v.durationSeconds + " s" + (v.hasAudio ? " with sound" : "") + ", "
      + v.fileBytes.toLocaleString("en-US") + " bytes on disk — safe to save.";
  } else if (v.status === "corrupt") {
    v.text = "OUTPUT FAILED ITS CHECK: " + v.problems.join("; ")
      + ". It was NOT saved under a trusted name.";
  } else {
    v.text = "Could not check the output (" + (v.error || "unknown error")
      + ") — it has not been treated as safe.";
  }
  return v;
}
