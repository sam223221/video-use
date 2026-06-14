/* =============================================================================
   engine/writers.js — every byte the engine writes goes through here.
   -----------------------------------------------------------------------------
   Three jobs (arch §6.1, banked M0 requirements #1 and #3):

   1. normalizingWritable(rawWritable) — THE view-normalization wrapper.
      FIELD DEFECT (M0, iPhone Safari 26.5): WebKit's
      FileSystemWritableFileStream corrupts positioned writes whose payload is
      a typed-array SUBARRAY VIEW onto a larger backing buffer — exactly what
      mediabunny's chunked StreamTarget flushes (chunk.data.subarray(a, b) on
      16 MiB chunk buffers). Files land chunk-aligned and structurally broken
      (the moov index at EOF is smeared). The wrapper tight-copies every view
      payload before forwarding, so even a platform that writes "the whole
      backing buffer" writes exactly the right bytes. Field-proven by the M0
      spike: after the fix the SAME Safari produced byte-exact, verified,
      playable output.

      CONTRACT (banked #1): no mediabunny StreamTarget is EVER constructed
      over a raw OPFS writable anywhere in this codebase. cut.js enforces it
      by refusing anything that did not come through this wrapper.

   2. tempThenRename(dirHandle, finalName) — temp-name + verify + rename
      (banked #3): Output.cancel() COMMITS partial bytes on whatever name it
      was given, so the final name is never the write target. Composes
      store/opfs.js tempWriter() (the single implementation of the temp/rename
      mechanics) with the normalization wrapper, and hands out ONLY the
      wrapped stream — the raw writable is not reachable from the result.

   3. abandonOutput(output, stream) — best-effort teardown of a failed
      Output → StreamTarget → writable pipeline; each step individually
      try/caught so cleanup can never mask the original error (spike lesson).

   Dependency note: this module imports ../store/opfs.js (pure persistence,
   no DOM/no fetch) instead of duplicating the temp/rename logic — a
   deliberate, documented exception to the "engine imports only mediabunny"
   rule (see engine/DOCUMENT.md). It does not import mediabunny at all.
============================================================================= */

import { tempWriter, moveEntry } from "../store/opfs.js";

/* ----- view normalization ------------------------------------------------- */

/** If `data` is a typed-array/DataView VIEW onto a larger buffer, copy the
    viewed range into a fresh, tightly-sized Uint8Array (byteOffset 0,
    length === buffer.byteLength). Whole-buffer views and non-buffer data pass
    through untouched. Byte-for-byte identical either way. Exported because
    store/edl.js and ingest.js normalize their own writes too (cheap insurance
    even for fresh buffers — arch §5.2). */
export function normalizeBufferSource(data) {
  if (ArrayBuffer.isView(data) && (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength)) {
    return { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), copied: true };
  }
  return { bytes: data, copied: false };
}

function bufferSourceByteLength(data) {
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return null; // a string's on-disk size needs encoding — mediabunny never sends one
}

/** Wrap a fresh OPFS FileSystemWritableFileStream in a plain WritableStream
    whose sink normalizes every payload before forwarding, and counts what
    passed through. Returns { stream, stats }:

      stream — what StreamTarget gets (positions + close/abort forward 1:1;
               this is the same wrapper pattern mediabunny's own
               AppendOnlyStreamTarget uses internally).
      stats  — { commands, viewsNormalized, bytesWritten, logicalEnd,
                 closed, aborted }. Complete by the time Output.finalize()
                 resolves (the wrapper queue fully drains before its close()
                 commits the file). `logicalEnd` = max(position + length) =
                 the true muxed file size — what verification compares the
                 on-disk size against (banked #5: never trust reported sizes
                 alone on Safari).

    NOTE: start() takes a writer lock on rawWritable — after this call the
    raw writable can only be reached through `stream`. That is intentional. */
export function normalizingWritable(rawWritable) {
  const stats = {
    commands: 0,        // write commands forwarded
    viewsNormalized: 0, // payloads that were subarray views (copied)
    bytesWritten: 0,    // payload bytes forwarded (incl. overwrites)
    logicalEnd: 0,      // max(position + length) = the true muxed file size
    closed: false,      // the sink committed (writer.close() resolved)
    aborted: false,     // the sink was aborted
  };
  let writer = null;
  let cursor = 0; // current file offset, for non-positioned writes
  const stream = new WritableStream({
    start() {
      writer = rawWritable.getWriter();
    },
    write(chunk) {
      stats.commands++;
      let out = chunk;
      const isCommand = chunk !== null && typeof chunk === "object"
        && !ArrayBuffer.isView(chunk) && !(chunk instanceof ArrayBuffer)
        && !(typeof Blob !== "undefined" && chunk instanceof Blob);
      if (isCommand && chunk.type === "write") {
        // Positioned write command — the only thing mediabunny's
        // StreamTarget ever sends here.
        const norm = normalizeBufferSource(chunk.data);
        if (norm.copied) {
          stats.viewsNormalized++;
          out = { type: "write", data: norm.bytes, position: chunk.position };
        }
        const len = bufferSourceByteLength(norm.bytes);
        if (len !== null) {
          stats.bytesWritten += len;
          cursor = (typeof chunk.position === "number" ? chunk.position : cursor) + len;
          stats.logicalEnd = Math.max(stats.logicalEnd, cursor);
        }
      } else if (isCommand && chunk.type === "seek") {
        if (typeof chunk.position === "number") cursor = chunk.position;
      } else if (isCommand && chunk.type === "truncate") {
        if (typeof chunk.size === "number") {
          stats.logicalEnd = chunk.size;
          cursor = Math.min(cursor, chunk.size);
        }
      } else if (!isCommand) {
        // Raw BufferSource chunk — sequential write at the cursor.
        const norm = normalizeBufferSource(chunk);
        if (norm.copied) {
          stats.viewsNormalized++;
          out = norm.bytes;
        }
        const len = bufferSourceByteLength(norm.bytes);
        if (len !== null) {
          stats.bytesWritten += len;
          cursor += len;
          stats.logicalEnd = Math.max(stats.logicalEnd, cursor);
        }
      }
      return writer.write(out);
    },
    async close() {
      await writer.close(); // commits the OPFS file (swap-on-close)
      stats.closed = true;
    },
    async abort(reason) {
      stats.aborted = true;
      return writer.abort(reason); // discards staged data
    },
  });
  return { stream, stats };
}

/* ----- temp-then-rename output target (banked #3) -------------------------- */

/** Open a verified-output target in `dirHandle` for `finalName`:

      const out = await tempThenRename(exportsDir, "export-x.mp4");
      … StreamTarget(out.stream, {chunked:true}) … Output.finalize() …
      → verify against out.handle + out.stats → await out.commit();
      on ANY failure: await out.abandon();

    Bytes land in "<finalName>.tmp" through the normalization wrapper.
    Output.finalize() closes `stream`, which commits the .tmp — commit() then
    ONLY renames (it closes the stream first iff the engine has not already,
    covering direct-stream callers). abandon() never throws and never masks
    the caller's original error; an abandoned .tmp that survives (page death)
    is removed by the boot sweep (store/opfs.js sweepTmp). */
export async function tempThenRename(dirHandle, finalName) {
  const t = await tempWriter(dirHandle, finalName);
  const { stream, stats } = normalizingWritable(t.writable);
  return {
    handle: t.handle,     // the .tmp file handle — verification re-opens from here
    tmpName: t.tmpName,
    stream,               // the ONLY way to write — already normalized
    stats,
    async commit() {
      if (!stats.closed) await stream.close(); // direct-stream callers only
      await moveEntry(dirHandle, t.tmpName, finalName);
    },
    async abandon() {
      if (!stats.closed && !stats.aborted) {
        try { await stream.abort(); } catch { /* locked by the muxer — t.abandon covers it */ }
      }
      await t.abandon();  // aborts the raw writable if still possible + deletes the .tmp; never throws
    },
  };
}

/* ----- failure teardown ----------------------------------------------------- */

/** Best-effort teardown of a FAILED Output → StreamTarget → writable pipeline.
    Without it, a mid-run failure leaves the writable open, pinning staged
    data until GC (on exactly the memory-fragile device this runs on) and
    possibly blocking a re-run.

    - output.cancel() releases mediabunny's muxer resources and closes the
      writer it locked on the stream (verified against the vendored bundle:
      Output.cancel → StreamTarget._close → writer.close()). NOTE: that close
      COMMITS partial bytes — which is exactly why the write target is always
      a .tmp name (banked #3).
    - stream.abort() covers the pre-start() case where the stream is still
      unlocked; once the muxer holds the lock (or the stream is closed) it
      rejects, which is swallowed.

    Each call sits in its own try/catch so cleanup can NEVER mask the original
    error. Never throws. */
export async function abandonOutput(output, stream) {
  if (output) {
    try { await output.cancel(); } catch { /* best effort only */ }
  }
  if (stream) {
    try { await stream.abort(); } catch { /* locked or already closed — fine */ }
  }
}

/* ----- error classification --------------------------------------------------- */

/** Map a thrown error to the device half of the bridge error taxonomy
    (arch §3.5): storage problems → "storage_error", everything else the
    engine throws → "engine_error". Errors created by engine modules already
    carry .code; this classifies platform errors (duck-typed — no instanceof
    across the ?v= double-load boundary). */
export function errorCode(err) {
  if (err && typeof err.code === "string") return err.code;
  const name = err && err.name;
  if (name === "QuotaExceededError" || name === "NotReadableError"
    || name === "NoModificationAllowedError" || name === "NotFoundError") {
    return "storage_error";
  }
  return "engine_error";
}

/** An Error carrying a bridge taxonomy code as a plain property. */
export function engineError(message, code = "engine_error") {
  const err = new Error(message);
  err.code = code;
  return err;
}
