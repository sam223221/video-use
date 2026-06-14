/*
 * THROWAWAY — M0 spike (Studio v2 on-device editing capability probe).
 * Delete this whole folder after M0 concludes. See DOCUMENT.md.
 *
 * All test logic for /static/spike/index.html. Vanilla ES module, no build step.
 * The only import is the vendored mediabunny bundle (same folder) — the page
 * makes ZERO external network requests at runtime.
 *
 * Hard rules implemented here:
 *  - Streaming discipline: picked videos are never read whole into memory.
 *    Parsing uses mediabunny BlobSource (lazy reads), the OPFS copy pipes
 *    file.stream(), the cut copies packets one at a time, the re-encode
 *    decodes/encodes frame by frame and closes every frame promptly.
 *  - Crash journal: every result/progress write lands in localStorage
 *    immediately (key "spike.results.v1"). iOS memory kills are uncatchable;
 *    the journal restored on the next load is how we DETECT them.
 *  - Failures render on-screen, never silently.
 *  - iOS write-corruption defense (field defect, Safari 26.5): every byte
 *    handed to an OPFS writable is normalized to a tightly-sized Uint8Array
 *    first (normalizingWritable / the ingest TransformStream), and every
 *    muxed output is re-opened, size-checked and re-parsed after finalize
 *    (verifyOutput) with the verdict journaled + rendered.
 */

import {
	Input,
	BlobSource,
	ALL_FORMATS,
	QuickTimeInputFormat,
	EncodedPacketSink,
	VideoSampleSink,
	Output,
	Mp4OutputFormat,
	MovOutputFormat,
	StreamTarget,
	EncodedVideoPacketSource,
	EncodedAudioPacketSource,
	EncodedPacket,
} from "./mediabunny.js";

/* ====================================================================== *
 *  Small helpers
 * ====================================================================== */

const JOURNAL_KEY = "spike.results.v1";
const OPFS_DIR = "spike";

function byId(id) { return document.getElementById(id); }

function nowIso() { return new Date().toISOString(); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtBytes(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "?";
	if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
	if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
	if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
	return n + " B";
}

function fmtSeconds(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
	if (ms >= 60000) {
		const m = Math.floor(ms / 60000);
		const s = Math.round((ms % 60000) / 1000);
		return m + " min " + s + " s";
	}
	return (ms / 1000).toFixed(1) + " s";
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

function floorEven(n) { return Math.max(2, 2 * Math.floor(n / 2)); }

function errText(e) {
	if (!e) return "unknown error";
	const name = e.name || (e.constructor && e.constructor.name) || "Error";
	return name + ": " + (e.message || String(e));
}

function guessMime(name) {
	const lower = (name || "").toLowerCase();
	if (lower.endsWith(".mov")) return "video/quicktime";
	if (lower.endsWith(".m4v")) return "video/x-m4v";
	return "video/mp4";
}

/* ====================================================================== *
 *  Crash journal — ONE JSON doc in localStorage, written on every change
 * ====================================================================== */

function defaultJournal() {
	return {
		version: 1,
		createdAt: nowIso(),
		updatedAt: nowIso(),
		pageLoads: 1,
		interruptions: [],
		device: null,
		tests: {
			picker: { status: "idle", library: null, files: null, verdict: null },
			ingest: { status: "idle" },
			cut: { status: "idle" },
			reencode: { status: "idle" },
		},
	};
}

let journal = defaultJournal();
let journalBroken = false;

function saveJournal() {
	journal.updatedAt = nowIso();
	try {
		localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
	} catch (e) {
		if (!journalBroken) {
			journalBroken = true;
			const warn = byId("journal-warning");
			if (warn) warn.hidden = false;
		}
	}
	renderJson();
}

function setTest(id, patch) {
	journal.tests[id] = Object.assign({}, journal.tests[id], patch);
	saveJournal();
}

/* A fresh run must speak only for itself: on test START, drop failure text
   left by a PREVIOUS run (runTest's catch, detectInterruption's reload
   marker, an "unsupported" branch's detail) so a successful re-run can't
   read as a crash in the copied JSON — AND drop the previous run's output
   verdict (`verify`) and write stats (`writes`), otherwise a run that FAILS
   would journal `status:"failed"` right next to the OLD run's
   `verify.status:"ok"` and the page would render a green "safe to share"
   verdict beside the failure (the stale-green-verdict bug). The
   interruptions[] history is deliberately NOT touched — that array is the
   permanent crash-detection record. (The next setTest persists the cleared
   record.) */
function clearStaleOutcome(id) {
	const t = journal.tests[id];
	if (!t) return;
	delete t.error;
	delete t.detail;
	delete t.verify;
	delete t.writes;
}

function loadJournal() {
	try {
		const raw = localStorage.getItem(JOURNAL_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !parsed.tests) return null;
		// Merge over defaults so missing keys never crash the UI.
		const base = defaultJournal();
		parsed.tests = Object.assign(base.tests, parsed.tests);
		return Object.assign(base, parsed);
	} catch (e) {
		return null;
	}
}

function renderJson() {
	const pre = byId("json-pre");
	if (pre) pre.textContent = JSON.stringify(journal, null, 2);
}

/* Heartbeat: journal partial progress every ~2s while a long test runs, so
   an uncatchable tab kill still leaves the last known progress behind. */
function startHeartbeat(testId, getProgress) {
	const iv = setInterval(() => {
		try { setTest(testId, { progress: getProgress() }); } catch (e) { /* never break a test */ }
	}, 2000);
	return () => clearInterval(iv);
}

/* ====================================================================== *
 *  Module state (not persisted — File handles don't survive a reload;
 *  what CAN be restored after a reload is re-armed from OPFS in rearmShare)
 * ====================================================================== */

const state = {
	currentFile: null,     // last picked File (used by tests 2/3)
	share: { ingest: null, cut: null }, // prepared Files for navigator.share
	activeTest: null,      // id of the currently running test, or null
	pickMode: null,        // 'library' | 'files' | 'clip'
	pickStarted: 0,        // performance.now() when the picker was opened
	resetArmed: false,
	cutUrl: null,          // object URL for the cut download link
};

/* ====================================================================== *
 *  Wake lock — best-effort, feature-detected, with a visible hint when
 *  the lock is not held while a test runs
 * ====================================================================== */

const wake = { sentinel: null, want: false };

function updateWakeHint() {
	const hint = byId("wake-hint");
	if (!hint) return;
	hint.hidden = !(wake.want && !wake.sentinel);
}

async function acquireWake() {
	wake.want = true;
	if (!("wakeLock" in navigator)) { updateWakeHint(); return; }
	try {
		wake.sentinel = await navigator.wakeLock.request("screen");
		wake.sentinel.addEventListener("release", () => {
			wake.sentinel = null;
			updateWakeHint();
		});
	} catch (e) {
		wake.sentinel = null;
	}
	updateWakeHint();
}

function releaseWake() {
	wake.want = false;
	if (wake.sentinel) {
		try { wake.sentinel.release(); } catch (e) { /* already released */ }
		wake.sentinel = null;
	}
	updateWakeHint();
}

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible" && wake.want && !wake.sentinel) {
		acquireWake();
	}
});

/* ====================================================================== *
 *  Test runner — one test at a time; status + errors always rendered
 * ====================================================================== */

function setStatus(id, text) {
	const el = byId(id + "-status");
	if (el) el.textContent = text;
}

function showTestError(id, e) {
	const box = byId(id + "-error");
	if (box) {
		box.textContent = "Problem: " + errText(e);
		box.hidden = false;
	}
}

function clearTestError(id) {
	const box = byId(id + "-error");
	if (box) { box.hidden = true; box.textContent = ""; }
}

/* Maps a journal test id to its card's status/error element prefix and its
   results renderer. runTest needs this both to surface failures on the
   RIGHT card (the ids differ: journal "cut" ↔ DOM "t3a-…"; the old code
   targeted nonexistent "cut-status"/"cut-error" elements, so a mid-session
   failure showed nothing) and to re-render the card whenever the record
   changes, so a stale verdict/result table can never outlive the record it
   came from. (Function declarations hoist — the renderers below are
   defined later in the file.) */
const TEST_UI = {
	picker: { statusId: "t1", render: renderPickerResults },
	ingest: { statusId: "t2", render: renderIngestResults },
	cut: { statusId: "t3a", render: renderCutResults },
	reencode: { statusId: "t3b", render: renderReencodeResults },
};

async function runTest(id, fn) {
	const ui = TEST_UI[id];
	if (state.activeTest) {
		setStatus(ui.statusId, "Another test is still running — wait for it to finish first.");
		return;
	}
	state.activeTest = id;
	clearTestError(ui.statusId);
	clearStaleOutcome(id);
	setTest(id, { status: "running", startedAt: nowIso() });
	ui.render(); // the old run's verdict/rows must not linger while this run works
	updateButtons();
	acquireWake();
	try {
		await fn();
	} catch (e) {
		setTest(id, { status: "failed", error: errText(e) });
		setStatus(ui.statusId, "This test failed — details below. The other tests can still run.");
		showTestError(ui.statusId, e);
		ui.render(); // failed record → renderVerify (gated on "done") hides any verdict
	} finally {
		state.activeTest = null;
		releaseWake();
		updateButtons();
	}
}

/* ====================================================================== *
 *  OPFS helpers
 * ====================================================================== */

function opfsSupported() {
	return !!(navigator.storage && navigator.storage.getDirectory);
}

function createWritableSupported() {
	return typeof FileSystemFileHandle !== "undefined"
		&& "createWritable" in FileSystemFileHandle.prototype;
}

async function opfsDir() {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

async function opfsFileHandle(name, create) {
	const dir = await opfsDir();
	return dir.getFileHandle(name, { create: !!create });
}

async function opfsRemoveAll() {
	if (!opfsSupported()) return;
	try {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry(OPFS_DIR, { recursive: true });
	} catch (e) { /* nothing to remove */ }
}

/* ====================================================================== *
 *  iOS write-corruption defense + output integrity self-check
 *  (FIELD DEFECT — iPhone, Safari 26.5)
 *
 *  What happened in the field: the lossless cut (cut.mov) was shared and
 *  saved to Photos, but Photos refused it with "unable to play this
 *  format". ingest.mov — the SAME source bytes, written sequentially via
 *  file.stream().pipeTo(createWritable()) — saved and played fine. Both
 *  cut.mov and reencode.mp4 journaled outputBytes of EXACTLY 33554432 =
 *  2 × 16 MiB (mediabunny's StreamTarget chunk size), while desktop runs
 *  of the identical code produce byte-exact, non-aligned files that
 *  ffprobe fully validates. H.264+AAC in QuickTime is universally
 *  playable on iPhone, so "can't play format" means STRUCTURAL
 *  corruption — and with fastStart:false the moov index sits at the very
 *  END of the file, exactly where chunk-boundary corruption would bite.
 *
 *  Prime suspect (hypothesis — NOT yet proven): Safari's
 *  FileSystemWritableFileStream.write({ type:"write", position, data })
 *  mishandling `data` when it is a Uint8Array SUBARRAY VIEW onto a larger
 *  backing buffer. mediabunny's chunked StreamTarget flushes
 *  `chunk.data.subarray(start, end)` views onto its 16 MiB chunk buffers;
 *  writing the full backing buffer instead (or botching byteOffset /
 *  length) would BOTH inflate the file to chunk-aligned sizes AND
 *  zero/smear real data. Desktop engines handle views correctly, which
 *  matches the desktop/phone split. The ingest path never sends views
 *  (stream chunks are standalone buffers), which matches ingest.mov
 *  surviving.
 *
 *  Defense (spike-side only; the vendored bundle stays byte-identical):
 *  normalizingWritable() wraps the OPFS writable before it is handed to
 *  StreamTarget. Every outgoing payload that is a typed-array view
 *  (byteOffset ≠ 0 or length ≠ buffer.byteLength) gets its bytes copied
 *  into a fresh, tightly-sized Uint8Array first — so even a platform
 *  that writes "the whole backing buffer" writes exactly the right
 *  bytes. Positions and close/abort semantics pass through 1:1 (the
 *  wrapper pattern is the same one mediabunny's own AppendOnlyStreamTarget
 *  uses internally). Worst-case cost: one ≤16 MiB copy in flight at a time.
 *
 *  Proof instrumentation (so the NEXT phone run adjudicates the
 *  hypothesis instead of anyone guessing): the wrapper counts write
 *  commands, how many needed normalization, bytes written, and the
 *  logical end-of-file the muxer produced; verifyOutput() then re-opens
 *  the committed file and records its TRUE size, first/last 16 bytes as
 *  hex, and a full mediabunny re-parse (container, track count, codec,
 *  duration vs expected). Reading the next phone journal:
 *    - writes.viewsNormalized > 0, verify.fileBytes === writes.logicalEnd
 *      (non-aligned), parse OK → view writes were the corruption vector
 *      and the fix holds.
 *    - size STILL 16 MiB-aligned although every payload was tightly
 *      sized → hypothesis wrong; the hex head/tail + parse error show
 *      what actually landed on disk.
 *  Either way the journal carries the verdict.
 * ====================================================================== */

const VERIFY_TOLERANCE_SECONDS = 1; // keyframe-tail slack on the duration check

/* If `data` is a typed-array/DataView VIEW onto a larger buffer, copy the
   viewed range into a fresh, tightly-sized Uint8Array (byteOffset 0,
   length === buffer.byteLength). Whole-buffer views and non-buffer data
   pass through untouched. Byte-for-byte identical either way. */
function normalizeBufferSource(data) {
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

/* Wraps a fresh OPFS FileSystemWritableFileStream in a plain WritableStream
   whose sink normalizes every payload (see above) before forwarding, and
   counts what passed through. Returns { stream, stats }: `stream` is what
   StreamTarget gets, `stats` is journaled with the test result. Stats are
   complete by the time Output.finalize() resolves (the wrapper queue fully
   drains before its close() commits the file). */
function normalizingWritable(rawWritable) {
	const stats = {
		commands: 0,        // write commands forwarded
		viewsNormalized: 0, // payloads that were subarray views (copied)
		bytesWritten: 0,    // payload bytes forwarded (incl. overwrites)
		logicalEnd: 0,      // max(position + length) = the true muxed file size
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
		close() {
			return writer.close(); // commits the OPFS file, exactly as before
		},
		abort(reason) {
			return writer.abort(reason); // discards staged data, exactly as before
		},
	});
	return { stream, stats };
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

/* Post-finalize integrity self-check for the cut / re-encode outputs.
   NEVER throws — a broken output must still journal as a completed test
   with a corrupt verdict, not flip the test to "failed". */
async function verifyOutput(kind, handle, expectedSeconds, writeStats) {
	const v = { checkedAt: nowIso(), status: "error", problems: [] };
	try {
		const f = await handle.getFile();
		v.fileBytes = f.size;
		v.fileBytesText = fmtBytes(f.size);
		v.first16Hex = await hexOfSlice(f, 0, Math.min(16, f.size));
		v.last16Hex = await hexOfSlice(f, Math.max(0, f.size - 16), f.size);
		if (writeStats && typeof writeStats.logicalEnd === "number" && writeStats.logicalEnd > 0) {
			v.expectedBytes = writeStats.logicalEnd;
			if (f.size !== writeStats.logicalEnd) {
				v.problems.push("the file on disk is " + f.size.toLocaleString("en-US")
					+ " bytes but the muxer wrote " + writeStats.logicalEnd.toLocaleString("en-US")
					+ " bytes — the browser " + (f.size > writeStats.logicalEnd ? "inflated" : "truncated") + " it");
			}
		}
		const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(f) });
		try {
			const format = await input.getFormat();
			v.container = format.name;
			v.trackCount = (await input.getTracks()).length;
			v.durationSeconds = round2(await input.computeDuration());
			const video = await input.getPrimaryVideoTrack();
			if (video) {
				v.videoCodec = await video.getCodec();
			} else {
				v.problems.push("no video track found");
			}
			if (typeof expectedSeconds === "number") {
				v.expectedSeconds = round2(expectedSeconds);
				if (Math.abs(v.durationSeconds - expectedSeconds) > VERIFY_TOLERANCE_SECONDS) {
					v.problems.push("it plays as " + v.durationSeconds + " s but about "
						+ v.expectedSeconds + " s was expected");
				}
			}
		} catch (e) {
			v.parseError = errText(e);
			v.problems.push("it does not parse as a video file (" + v.parseError + ")");
		} finally {
			input.dispose();
		}
		v.status = v.problems.length > 0 ? "corrupt" : "ok";
	} catch (e) {
		v.error = errText(e);
	}
	if (v.status === "ok") {
		v.text = "Output verified: parses as " + v.container + ", "
			+ v.durationSeconds + " s video, " + v.fileBytesText + " on disk"
			+ (kind === "cut" ? " — safe to share to Photos." : ".");
	} else if (v.status === "corrupt") {
		v.text = "OUTPUT CORRUPT: " + v.problems.join("; ") + "."
			+ (kind === "cut"
				? " Saving to Photos will most likely fail — you can still share or download it so the broken file can be inspected, but the important step now is: copy the results below and send them to Sam."
				: " Copy the results below and send them to Sam.");
	} else {
		v.text = "Could not check the output (" + (v.error || "unknown error") + ") — it may still be fine."
			+ (kind === "cut" ? " You can still try saving it to Photos." : "")
			+ " Copy the results below and send them to Sam.";
	}
	return v;
}

/* Renders a verify verdict into one of the .verdict paragraphs. Takes the
   whole test record: a verdict may only ever come from a COMPLETED run, so
   it is gated on status === "done" — a failed / interrupted / unsupported /
   running record must never display a (possibly stale) "safe to share"
   verdict. The gate also covers journals written by older builds, where a
   failed record could still carry an earlier run's verify. */
function renderVerify(elId, test) {
	const el = byId(elId);
	if (!el) return;
	const verify = test && test.status === "done" ? test.verify : null;
	if (!verify || !verify.text) { el.hidden = true; return; }
	el.textContent = verify.text;
	el.classList.toggle("verdict--bad", verify.status === "corrupt");
	el.classList.toggle("verdict--warn", verify.status === "error");
	el.hidden = false;
}

/* ====================================================================== *
 *  File analysis (mediabunny, lazy reads only)
 * ====================================================================== */

async function analyzeFile(file) {
	const meta = {
		name: file.name,
		size: file.size,
		sizeText: fmtBytes(file.size),
		type: file.type || "(none)",
		lastModified: new Date(file.lastModified).toISOString(),
	};
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	try {
		const format = await input.getFormat();
		meta.container = format.name;
		meta.durationSeconds = round2(await input.computeDuration());

		const v = await input.getPrimaryVideoTrack();
		if (v) {
			const stats = await v.computePacketStats(120);
			const color = await v.getColorSpace();
			meta.video = {
				codec: await v.getCodec(),
				codecString: await v.getCodecParameterString(),
				codedWidth: await v.getCodedWidth(),
				codedHeight: await v.getCodedHeight(),
				displayWidth: await v.getDisplayWidth(),
				displayHeight: await v.getDisplayHeight(),
				rotation: await v.getRotation(),
				fps: round2(stats.averagePacketRate),
				averageBitrate: Math.round(stats.averageBitrate),
				hdr: await v.hasHighDynamicRange(),
				colorPrimaries: color.primaries || null,
				colorTransfer: color.transfer || null,
				colorMatrix: color.matrix || null,
				fullRange: color.fullRange === undefined ? null : color.fullRange,
			};
		}
		const a = await input.getPrimaryAudioTrack();
		if (a) {
			meta.audio = {
				codec: await a.getCodec(),
				codecString: await a.getCodecParameterString(),
				channels: await a.getNumberOfChannels(),
				sampleRate: await a.getSampleRate(),
			};
		}
	} catch (e) {
		meta.parseError = errText(e);
	} finally {
		input.dispose();
	}
	return meta;
}

/* ====================================================================== *
 *  TEST 1 — picker comparison
 * ====================================================================== */

function openPicker(mode) {
	state.pickMode = mode;
	state.pickStarted = performance.now();
	const inputEl = byId("file-input");
	inputEl.value = ""; // so re-picking the SAME clip still fires `change`
	inputEl.click();
}

async function onFilePicked() {
	const inputEl = byId("file-input");
	const file = inputEl.files && inputEl.files[0];
	if (!file) return;
	const pickMs = Math.round(performance.now() - state.pickStarted);
	const mode = state.pickMode;
	state.currentFile = file;
	updateClipBar();
	updateButtons();

	if (mode !== "library" && mode !== "files") return; // 'clip' mode: selection only

	clearTestError("t1");
	setStatus("t1", "Reading the clip's details… (a big clip can take a few seconds)");
	clearStaleOutcome("picker"); // the picker starts here, not via runTest
	setTest("picker", { status: "running", running: mode });
	try {
		const meta = await analyzeFile(file);
		meta.pickToFileMs = pickMs; // long = iOS spent time "Preparing…" (= converting)
		const patch = { status: "done", running: null };
		patch[mode] = meta;
		setTest("picker", patch);
		computePickerVerdict();
		renderPickerResults();
		const both = journal.tests.picker.library && journal.tests.picker.files;
		setStatus("t1", both
			? "Both picks recorded — see the comparison below."
			: (mode === "library"
				? "Photo Library pick recorded. Now do step 2 with the SAME clip."
				: "Files pick recorded. Now do step 1 with the SAME clip (if you haven't)."));
	} catch (e) {
		setTest("picker", { status: "failed", running: null, error: errText(e) });
		setStatus("t1", "Could not read that clip — details below.");
		showTestError("t1", e);
	}
}

function computePickerVerdict() {
	const p = journal.tests.picker;
	if (!p.library || !p.files) return;
	const diffs = [];
	const lv = p.library.video || {};
	const fv = p.files.video || {};
	const sizeDelta = Math.abs(p.library.size - p.files.size) / Math.max(p.files.size, 1);
	if (sizeDelta > 0.02) diffs.push("file size");
	if (lv.codecString !== fv.codecString) diffs.push("video codec");
	if (lv.codedWidth !== fv.codedWidth || lv.codedHeight !== fv.codedHeight) diffs.push("resolution");
	if (p.library.container !== p.files.container) diffs.push("container");
	if (lv.hdr !== fv.hdr) diffs.push("HDR");
	const differs = diffs.length > 0;
	setTest("picker", {
		verdict: {
			differs,
			differences: diffs,
			text: differs
				? "The two picks are NOT the same file (" + diffs.join(", ") + " differ) — the Photo Library picker is converting the video."
				: "The two picks look identical — the Photo Library picker handed over the original bytes.",
		},
	});
}

const PICKER_ROWS = [
	["File name", (m) => m.name],
	["Size", (m) => m.sizeText + " (" + m.size.toLocaleString("en-US") + " bytes)"],
	["MIME type", (m) => m.type],
	["Last modified", (m) => m.lastModified],
	["Pick took", (m) => (typeof m.pickToFileMs === "number" ? fmtSeconds(m.pickToFileMs) : "?")],
	["Container", (m) => m.container],
	["Duration", (m) => (m.durationSeconds != null ? m.durationSeconds + " s" : null)],
	["Video codec", (m) => m.video && m.video.codec],
	["Codec string", (m) => m.video && m.video.codecString],
	["Coded size", (m) => m.video && (m.video.codedWidth + " × " + m.video.codedHeight)],
	["Display size", (m) => m.video && (m.video.displayWidth + " × " + m.video.displayHeight)],
	["Rotation", (m) => m.video && (m.video.rotation + "°")],
	["Frame rate", (m) => m.video && (m.video.fps + " fps")],
	["Video bitrate", (m) => m.video && (fmtBytes(m.video.averageBitrate / 8) + "/s (" + Math.round(m.video.averageBitrate / 1000).toLocaleString("en-US") + " kbit/s)")],
	["HDR", (m) => m.video && (m.video.hdr ? "yes" : "no")],
	["Color", (m) => m.video && [m.video.colorPrimaries, m.video.colorTransfer, m.video.colorMatrix].filter(Boolean).join(" / ")],
	["Audio", (m) => m.audio && (m.audio.codec + ", " + m.audio.channels + " ch, " + m.audio.sampleRate + " Hz")],
	["Parse problem", (m) => m.parseError],
];

function renderPickerResults() {
	const p = journal.tests.picker;
	const wrap = byId("t1-results");
	const tbody = byId("t1-tbody");
	if (!wrap || !tbody) return;
	if (!p.library && !p.files) { wrap.hidden = true; return; }
	wrap.hidden = false;
	tbody.replaceChildren();
	for (const [label, getter] of PICKER_ROWS) {
		const lVal = p.library ? getter(p.library) : null;
		const fVal = p.files ? getter(p.files) : null;
		if (lVal == null && fVal == null) continue;
		const tr = document.createElement("tr");
		const th = document.createElement("th");
		th.scope = "row";
		th.textContent = label;
		const tdL = document.createElement("td");
		tdL.textContent = lVal == null ? "—" : String(lVal);
		const tdF = document.createElement("td");
		tdF.textContent = fVal == null ? "—" : String(fVal);
		if (p.library && p.files && lVal != null && fVal != null && String(lVal) !== String(fVal) && label !== "Pick took" && label !== "Last modified" && label !== "File name") {
			tdL.classList.add("diff");
			tdF.classList.add("diff");
		}
		tr.append(th, tdL, tdF);
		tbody.append(tr);
	}
	const verdictEl = byId("t1-verdict");
	if (verdictEl) {
		if (p.verdict) {
			verdictEl.textContent = p.verdict.text;
			verdictEl.classList.toggle("verdict--bad", p.verdict.differs);
			verdictEl.hidden = false;
		} else {
			verdictEl.hidden = true;
		}
	}
}

/* ====================================================================== *
 *  Shared: which file do tests 2/3 work on?
 * ====================================================================== */

function updateClipBar() {
	const nameEl = byId("clip-name");
	if (!nameEl) return;
	if (state.currentFile) {
		nameEl.textContent = state.currentFile.name + " (" + fmtBytes(state.currentFile.size) + ")";
	} else if (journal.tests.ingest && journal.tests.ingest.status === "done") {
		nameEl.textContent = "the copy already saved by test 2 (" + (journal.tests.ingest.srcName || "earlier clip") + ")";
	} else {
		nameEl.textContent = "no clip picked yet — use test 1 first (the Files pick is best)";
	}
}

/* Returns the source file for tests 3a/3b: the picked file, or the OPFS copy
   made by test 2 (useful after a crash/reload), or null. */
async function sourceForProcessing() {
	if (state.currentFile) return state.currentFile;
	const ing = journal.tests.ingest;
	if (ing && ing.status === "done" && ing.opfsName && opfsSupported()) {
		try {
			const handle = await opfsFileHandle(ing.opfsName, false);
			return await handle.getFile();
		} catch (e) { /* fall through */ }
	}
	return null;
}

function hasProcessingSource() {
	return !!state.currentFile
		|| (journal.tests.ingest && journal.tests.ingest.status === "done" && opfsSupported());
}

/* ====================================================================== *
 *  TEST 2 — streamed copy into OPFS + share to Photos
 * ====================================================================== */

async function testIngest() {
	const file = state.currentFile;
	if (!file) throw new Error("Pick a clip first (test 1, 'Pick from Files').");

	if (!opfsSupported()) {
		setTest("ingest", { status: "unsupported", detail: "navigator.storage.getDirectory is unavailable — no private file storage in this browser." });
		setStatus("t2", "Not supported in this browser — that result has been recorded.");
		renderIngestResults();
		return;
	}
	if (!createWritableSupported()) {
		// Deliberately NOT shimmed with a worker — the gap itself is an answer.
		setTest("ingest", { status: "unsupported", createWritable: "unsupported", detail: "FileSystemFileHandle.createWritable is unavailable in this browser." });
		setStatus("t2", "This browser can't write files this way — that result has been recorded.");
		renderIngestResults();
		return;
	}

	const dot = file.name.lastIndexOf(".");
	const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : ".mp4";
	const opfsName = "ingest" + ext;
	setTest("ingest", {
		srcName: file.name,
		srcSize: file.size,
		srcType: file.type || guessMime(file.name),
		opfsName,
		createWritable: "supported",
		share: null,
		photosConfirmed: false,
	});
	byId("t2-confirm").checked = false;

	setStatus("t2", "Copying… keep this page open and the screen on.");
	const handle = await opfsFileHandle(opfsName, true);
	const writable = await handle.createWritable(); // truncates any old copy

	let copied = 0;
	let chunkCount = 0;
	let viewsNormalized = 0;
	const counter = new TransformStream({
		transform(chunk, controller) {
			chunkCount++;
			// Same defensive normalization as the cut/re-encode writers (see
			// normalizingWritable above): never hand WebKit a typed-array
			// subarray view. file.stream() chunks are normally standalone
			// buffers, so this is usually a no-op — and when it does copy,
			// the bytes are identical by construction.
			const norm = normalizeBufferSource(chunk);
			if (norm.copied) {
				viewsNormalized++;
				chunk = norm.bytes;
			}
			copied += chunk.byteLength;
			controller.enqueue(chunk);
		},
	});
	const stopBeat = startHeartbeat("ingest", () => ({ copiedBytes: copied, copiedText: fmtBytes(copied) }));
	const t0 = performance.now();
	try {
		// Streamed copy — the file is never held in memory.
		await file.stream().pipeThrough(counter).pipeTo(writable);
	} finally {
		stopBeat();
	}
	const ms = performance.now() - t0;
	const mbPerSec = round1((file.size / 1e6) / (ms / 1000));
	setTest("ingest", {
		status: "done",
		copiedBytes: copied,
		copyMs: Math.round(ms),
		copyText: fmtSeconds(ms),
		mbPerSec,
		writes: { chunks: chunkCount, viewsNormalized },
		progress: null,
	});

	// Prepare the share payload now so the share BUTTON tap stays a clean
	// user gesture (navigator.share needs transient activation).
	const stored = await handle.getFile();
	state.share.ingest = new File([stored], file.name, { type: file.type || guessMime(file.name) });

	setStatus("t2", "Copy done (" + fmtSeconds(ms) + ", " + mbPerSec + " MB/s). Now tap 'Save to Photos' below.");
	renderIngestResults();
}

function renderIngestResults() {
	renderKv("t2-results", journal.tests.ingest, [
		["Status", "status"],
		["Why", "detail"],
		["createWritable", "createWritable"],
		["Clip", "srcName"],
		["Clip size", (t) => (typeof t.srcSize === "number" ? fmtBytes(t.srcSize) : null)],
		["Copy time", "copyText"],
		["Copy speed", (t) => (typeof t.mbPerSec === "number" ? t.mbPerSec + " MB/s" : null)],
		["Share attempt", "share"],
		["Checked in Photos", (t) => (t.photosConfirmed ? "yes — plays" : (t.share ? "not confirmed yet" : null))],
		["Problem", "error"],
	]);
}

/* Share serialization (field-found fix, iPhone Safari 26.5): iOS allows only
   ONE share session at a time — a second navigator.share() while a previous
   one is open (or still being torn down) rejects with InvalidStateError.
   Worse, after "Save Video" the share() promise sometimes NEVER settles
   (known WebKit quirk), so a naive pending flag would deadlock every share
   button until reload. Belt and braces: the flag clears when the promise
   settles, when the page becomes visible / regains focus again (returning
   from the share sheet implies it closed), or after 25 s — whichever fires
   first. Clearing too early is harmless: if the sheet is genuinely still
   open, the next share() call lands in the InvalidStateError branch below,
   which renders a plain-English retry message instead of a dead button.
   Module state only — nothing here touches the journal schema. */
const sharePending = { id: 0, active: false, timer: 0 };
const SHARE_PENDING_MAX_MS = 25000;

function beginSharePending() {
	sharePending.active = true;
	sharePending.id++;
	const id = sharePending.id;
	clearTimeout(sharePending.timer);
	sharePending.timer = setTimeout(() => endSharePending(id), SHARE_PENDING_MAX_MS);
	return id;
}

function endSharePending(id) {
	if (id !== sharePending.id) return; // a newer share owns the flag now
	sharePending.active = false;
	clearTimeout(sharePending.timer);
	sharePending.timer = 0;
}

window.addEventListener("focus", () => endSharePending(sharePending.id));
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") endSharePending(sharePending.id);
});

/* Shared share-to-Photos flow for tests 2 and 3a. Must be called directly
   from a click handler (user gesture). statusId is the visible status line
   for that test card ("t2" / "t3a"). A failed/blocked share only ever writes
   the test's `share` note — its `status` (e.g. cut "done") is never touched
   and the button stays tappable for a retry. */
async function shareToPhotos(testId, statusId, f, renderFn) {
	if (sharePending.active) {
		// A share is already in flight — don't call share() (iOS would throw
		// InvalidStateError). Deliberately NOT journaled: the in-flight
		// attempt owns this test run's share record.
		setStatus(statusId, "Close the open share sheet first, then try again.");
		return;
	}
	if (!f) {
		setTest(testId, { share: "nothing to share yet" });
		renderFn();
		return;
	}
	if (!navigator.share) {
		setTest(testId, { share: "unsupported here (no navigator.share in this browser)" });
		renderFn();
		return;
	}
	if (navigator.canShare && !navigator.canShare({ files: [f] })) {
		setTest(testId, { share: "canShare({files}) returned false — file sharing not allowed here" });
		renderFn();
		return;
	}
	const pendingId = beginSharePending();
	try {
		await navigator.share({ files: [f] });
		setTest(testId, { share: "invoked ok (sheet opened and closed without error)" });
	} catch (e) {
		if (e && e.name === "InvalidStateError") {
			// iOS still holds the PREVIOUS share session open (its promise may
			// never have settled — see the WebKit quirk above). Journaled like
			// any other share failure; retry stays available.
			setTest(testId, { share: "blocked — a previous share was still open (" + errText(e) + ")" });
			setStatus(statusId, "iOS still has the previous share open. Wait a moment (or reload the page) and tap share again.");
		} else {
			const cancelled = !!(e && e.name === "AbortError");
			setTest(testId, {
				share: (cancelled ? "cancelled — the share sheet was dismissed (" : "failed (") + errText(e) + ")",
			});
			// A dismissed sheet must give visible feedback — the journal line
			// alone is easy for a non-developer to miss.
			if (cancelled) setStatus(statusId, "Share cancelled — tap the button to try again.");
		}
	} finally {
		endSharePending(pendingId);
	}
	renderFn();
}

/* ====================================================================== *
 *  TEST 3a — lossless cut (low-level packet copy; explicitly NOT
 *  mediabunny Conversion/trim, which transcodes mid-file trims)
 * ====================================================================== */

/* Best-effort teardown of a FAILED Output → StreamTarget → OPFS-writable
   pipeline (tests 3a/3b). Without it, a mid-test failure leaves the OPFS
   writable open, pinning potentially hundreds of MB of staged data until GC
   (on exactly the memory-fragile device we are probing) and possibly
   blocking a same-session re-run.
   `writable` here is whatever stream StreamTarget was handed — since the
   field fix that is the normalizingWritable() WRAPPER, whose abort/close
   forward 1:1 to the underlying OPFS stream.
   - output.cancel() releases mediabunny's muxer resources and closes the
     writer it locked on the writable (verified against the vendored bundle:
     Output.cancel → StreamTarget._close → writer.close()).
   - writable.abort() covers the pre-start case where the stream is still
     unlocked, discarding the staged data outright; once the muxer holds the
     lock (or the stream is already closed) it rejects, which we swallow.
   Each call sits in its own try/catch so cleanup can NEVER mask the original
   test error. Success paths never come here — they finalize() as before,
   which commits and closes the writable. (Test 2's ingest needs none of
   this: pipeTo() auto-aborts its destination on failure.) */
async function abandonOutput(output, writable) {
	if (output) {
		try { await output.cancel(); } catch (e) { /* best effort only */ }
	}
	if (writable) {
		try { await writable.abort(); } catch (e) { /* locked or already closed — fine */ }
	}
}

async function testCut() {
	// The instant a new run starts, the OLD run's output stops being safe to
	// share or download (this run will overwrite it — possibly partially, on
	// failure). Only this run's success re-arms them, with the NEW file.
	disarmCutOutput();
	const file = await sourceForProcessing();
	if (!file) throw new Error("Pick a clip first (test 1), or run test 2 so a copy exists.");
	if (!opfsSupported() || !createWritableSupported()) {
		// REPLACE the record (don't merge): an "unsupported" verdict must not
		// inherit a previous run's timings/sizes/share note/confirmation.
		// {status, detail} is a shape the journal schema always had, so old
		// journals are unaffected. (verify/writes were already dropped by
		// clearStaleOutcome at run start.)
		journal.tests.cut = {};
		setTest("cut", { status: "unsupported", detail: "This browser can't write the cut to private storage (no OPFS createWritable)." });
		byId("t3a-confirm").checked = false;
		setStatus("t3a", "Not supported in this browser — that result has been recorded.");
		renderCutResults();
		return;
	}

	setStatus("t3a", "Cutting… keep this page open and the screen on.");
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	let writable = null; // hoisted so the catch below can abandon them on failure
	let wrapped = null;  // normalizingWritable() wrapper around `writable`
	let output = null;
	try {
		const format = await input.getFormat();
		const isMov = format instanceof QuickTimeInputFormat;
		const duration = await input.computeDuration();
		const video = await input.getPrimaryVideoTrack();
		if (!video) throw new Error("No video track found in this clip.");
		const audio = await input.getPrimaryAudioTrack();

		const vSink = new EncodedPacketSink(video);
		// Find the key frame at/before the 40%-duration point.
		let keyPacket = await vSink.getKeyPacket(duration * 0.4, { verifyKeyPackets: true });
		if (!keyPacket) keyPacket = await vSink.getFirstKeyPacket({ verifyKeyPackets: true });
		if (!keyPacket) throw new Error("No key frame found in the video track.");
		const base = keyPacket.timestamp;
		const targetLen = Math.min(30, Math.max(1, duration - base));
		const cutEnd = base + targetLen;

		// Output container matches the source (MOV stays MOV, MP4 stays MP4).
		// fastStart: false — metadata written at the end; the OPFS writable
		// supports the random-access positioned writes that requires, and it
		// is the fastest, lowest-memory option (see DOCUMENT.md).
		const opfsName = "cut" + (isMov ? ".mov" : ".mp4");
		const handle = await opfsFileHandle(opfsName, true);
		writable = await handle.createWritable();
		// Field defect fix: StreamTarget gets the normalizing wrapper, never
		// the raw OPFS stream — WebKit must never see a subarray view.
		wrapped = normalizingWritable(writable);
		const target = new StreamTarget(wrapped.stream, { chunked: true });
		const OutFmt = isMov ? MovOutputFormat : Mp4OutputFormat;
		output = new Output({ format: new OutFmt({ fastStart: false }), target });

		const vCodec = await video.getCodec();
		if (!vCodec) throw new Error("Video codec not recognized by mediabunny: " + (await video.getCodecParameterString()));
		const vSource = new EncodedVideoPacketSource(vCodec);
		// Preserve the container rotation — packet copy never touches pixels.
		output.addVideoTrack(vSource, { rotation: await video.getRotation() });

		let aSource = null;
		let aSink = null;
		if (audio) {
			const aCodec = await audio.getCodec();
			if (aCodec) {
				aSource = new EncodedAudioPacketSource(aCodec);
				output.addAudioTrack(aSource);
				aSink = new EncodedPacketSink(audio);
			}
		}

		await output.start();
		const vMeta = { decoderConfig: await video.getDecoderConfig() };
		const aMeta = aSource ? { decoderConfig: await audio.getDecoderConfig() } : null;

		const progress = { videoPackets: 0, audioPackets: 0, mediaBytes: 0 };
		const stopBeat = startHeartbeat("cut", () => Object.assign({}, progress));
		const t0 = performance.now();
		let lastVideoEnd = base;

		try {
			// Two async packet iterators, merged by timestamp so the output
			// file is interleaved like a normal recording. Timestamps are
			// re-based to 0 (the muxer requires non-negative timestamps and
			// would otherwise delay the whole track with an edit list).
			const vIter = vSink.packets(keyPacket)[Symbol.asyncIterator]();
			let aIter = null;
			let a = { done: true, value: undefined };
			if (aSink) {
				let aStart = await aSink.getPacket(base);
				if (!aStart) aStart = await aSink.getFirstPacket();
				if (aStart) {
					aIter = aSink.packets(aStart)[Symbol.asyncIterator]();
					a = await aIter.next();
					// Skip audio from before the cut point (negative after re-base).
					while (!a.done && a.value.timestamp < base) a = await aIter.next();
				}
			}
			let v = await vIter.next();
			let vFirst = true;
			let aFirst = true;
			let vDone = false;
			let aDone = false;

			while ((!v.done && !vDone) || (!a.done && !aDone)) {
				const vActive = !v.done && !vDone;
				const aActive = !a.done && !aDone;
				const takeVideo = vActive && (!aActive || v.value.timestamp <= a.value.timestamp);
				if (takeVideo) {
					const p = v.value;
					if (p.timestamp >= cutEnd && p.type === "key") { vDone = true; continue; }
					await vSource.add(p.clone({ timestamp: p.timestamp - base }), vFirst ? vMeta : undefined);
					vFirst = false;
					progress.videoPackets++;
					progress.mediaBytes += p.byteLength;
					lastVideoEnd = Math.max(lastVideoEnd, p.timestamp + p.duration);
					v = await vIter.next();
				} else if (aActive) {
					const p = a.value;
					if (p.timestamp >= cutEnd) { aDone = true; continue; }
					await aSource.add(p.clone({ timestamp: p.timestamp - base }), aFirst ? aMeta : undefined);
					aFirst = false;
					progress.audioPackets++;
					progress.mediaBytes += p.byteLength;
					a = await aIter.next();
				}
			}
		} finally {
			stopBeat();
		}

		await output.finalize(); // also closes the OPFS writable (commits the file)
		const wallMs = Math.round(performance.now() - t0);
		const outFile = await handle.getFile();

		// Integrity self-check (field defect, see top of file): re-open the
		// committed file, record its TRUE size + hex head/tail, re-parse it
		// with mediabunny and compare the duration. Never throws.
		const verify = await verifyOutput("cut", handle, lastVideoEnd - base, wrapped.stats);

		setTest("cut", {
			status: "done",
			srcName: file.name,
			container: isMov ? "MOV" : "MP4",
			fastStart: false,
			cutStartSeconds: round2(base),
			targetSeconds: round2(targetLen),
			actualVideoSeconds: round2(lastVideoEnd - base),
			videoPackets: progress.videoPackets,
			audioPackets: progress.audioPackets,
			mediaBytes: progress.mediaBytes,
			wallMs,
			wallText: fmtSeconds(wallMs),
			outputBytes: outFile.size,
			opfsName,
			writes: Object.assign({}, wrapped.stats),
			verify,
			share: null,
			photosConfirmed: false,
			progress: null,
		});
		byId("t3a-confirm").checked = false;

		// The share/download stay armed even on a corrupt verdict — a broken
		// file can still be shared for inspection; the verdict text says
		// whether saving to Photos is worth attempting.
		state.share.cut = new File([outFile], opfsName, { type: isMov ? "video/quicktime" : "video/mp4" });
		armCutDownload(outFile, opfsName);

		if (verify.status === "ok") {
			setStatus("t3a", "Cut done in " + fmtSeconds(wallMs) + " (" + fmtBytes(outFile.size) + ") and the output checks out. Now tap 'Save the cut to Photos'.");
		} else if (verify.status === "corrupt") {
			setStatus("t3a", "Cut finished in " + fmtSeconds(wallMs) + " but the output FAILED its check — read the red box below before sharing.");
		} else {
			setStatus("t3a", "Cut done in " + fmtSeconds(wallMs) + " (" + fmtBytes(outFile.size) + "), but the result could not be checked — see below.");
		}
		renderCutResults();
	} catch (e) {
		await abandonOutput(output, wrapped ? wrapped.stream : writable); // best effort; never masks `e`
		throw e;
	} finally {
		input.dispose();
	}
}

function armCutDownload(outFile, name) {
	const link = byId("t3a-download");
	if (!link) return;
	if (state.cutUrl) URL.revokeObjectURL(state.cutUrl);
	state.cutUrl = URL.createObjectURL(outFile);
	link.href = state.cutUrl;
	link.download = name;
	link.hidden = false;
}

/* Inverse of the arming above — called the moment a NEW cut run starts (and
   from the unsupported branch). From that point the journal record is no
   longer "done", so the previously armed share File and download URL point
   at an output this run is about to overwrite — a failed run's
   abandonOutput() can even COMMIT a partial file over cut.mov (closing the
   locked writer commits the OPFS swap). Nothing re-arms these except this
   run's own success path (or rearmFromOpfs on a "done" record after a
   reload), so a failed run leaves share/download safely dead. */
function disarmCutOutput() {
	state.share.cut = null;
	if (state.cutUrl) { URL.revokeObjectURL(state.cutUrl); state.cutUrl = null; }
	const link = byId("t3a-download");
	if (link) {
		link.hidden = true;
		link.removeAttribute("href");
		link.removeAttribute("download");
	}
	updateButtons(); // t3a-share keys off state.share.cut → goes disabled
}

function renderCutResults() {
	renderVerify("t3a-verify", journal.tests.cut);
	renderKv("t3a-results", journal.tests.cut, [
		["Status", "status"],
		["Why", "detail"],
		["Source clip", "srcName"],
		["Output container", (t) => (t.container ? t.container + " (fastStart: false)" : null)],
		["Cut starts at", (t) => (typeof t.cutStartSeconds === "number" ? t.cutStartSeconds + " s into the clip (key frame)" : null)],
		["Length", (t) => (typeof t.actualVideoSeconds === "number" ? t.actualVideoSeconds + " s (aimed for " + t.targetSeconds + " s; ends on a clean frame boundary)" : null)],
		["Packets copied", (t) => (typeof t.videoPackets === "number" ? t.videoPackets + " video + " + t.audioPackets + " audio" : null)],
		["Cut took", "wallText"],
		["Output size", (t) => (typeof t.outputBytes === "number" ? fmtBytes(t.outputBytes) : null)],
		["Share attempt", "share"],
		["Checked in Photos", (t) => (t.photosConfirmed ? "yes — plays" : (t.share ? "not confirmed yet" : null))],
		["Problem", "error"],
	]);
}

/* ====================================================================== *
 *  TEST 3b — feature matrix (gathered at page load) + re-encode throughput
 * ====================================================================== */

const ENCODER_PROBES = [
	["hevc 3840×2160", "hvc1.1.6.L153.B0", 3840, 2160],
	["hevc 1920×1080", "hvc1.1.6.L153.B0", 1920, 1080],
	["avc 3840×2160", "avc1.640033", 3840, 2160],
	["avc 1920×1080", "avc1.640033", 1920, 1080],
];

async function gatherMatrix() {
	// Journal the cheap facts FIRST, so even a crash during the async probes
	// leaves the UA behind.
	const d = {
		gatheredAt: nowIso(),
		ua: navigator.userAgent,
		secureContext: window.isSecureContext,
	};
	journal.device = d;
	saveJournal();

	d.webcodecs = {
		VideoDecoder: typeof VideoDecoder !== "undefined",
		VideoEncoder: typeof VideoEncoder !== "undefined",
		AudioDecoder: typeof AudioDecoder !== "undefined",
		AudioEncoder: typeof AudioEncoder !== "undefined",
	};

	d.videoEncode = {};
	if (d.webcodecs.VideoEncoder) {
		for (const [label, codec, width, height] of ENCODER_PROBES) {
			try {
				const res = await VideoEncoder.isConfigSupported({
					codec, width, height, bitrate: 12_000_000, framerate: 30,
				});
				d.videoEncode[label] = !!res.supported;
			} catch (e) {
				d.videoEncode[label] = "error: " + errText(e);
			}
		}
	}

	try {
		d.webgpu = navigator.gpu ? !!(await navigator.gpu.requestAdapter()) : false;
	} catch (e) {
		d.webgpu = "error: " + errText(e);
	}

	d.opfs = {
		getDirectory: opfsSupported(),
		createWritable: createWritableSupported(),
	};

	try {
		if (navigator.storage && navigator.storage.estimate) {
			const est = await navigator.storage.estimate();
			d.storage = {
				quotaBytes: est.quota ?? null,
				usageBytes: est.usage ?? null,
				quotaText: fmtBytes(est.quota),
				usageText: fmtBytes(est.usage),
			};
		} else {
			d.storage = "estimate unavailable";
		}
	} catch (e) {
		d.storage = "error: " + errText(e);
	}

	d.share = { share: "share" in navigator, canShareVideoFile: null };
	try {
		if (navigator.canShare) {
			const probe = new File([new Uint8Array(16)], "probe.mp4", { type: "video/mp4" });
			d.share.canShareVideoFile = navigator.canShare({ files: [probe] });
		} else {
			d.share.canShareVideoFile = "no canShare";
		}
	} catch (e) {
		d.share.canShareVideoFile = "error: " + errText(e);
	}

	d.wakeLock = "wakeLock" in navigator;

	journal.device = d;
	saveJournal();
	renderMatrix();
	renderDeviceSummary();
}

function renderDeviceSummary() {
	const el = byId("device-summary");
	if (el && journal.device) el.textContent = "This browser: " + journal.device.ua;
}

function renderMatrix() {
	const tbody = byId("t3b-matrix-tbody");
	if (!tbody || !journal.device) return;
	const d = journal.device;
	const rows = [
		["Secure context (needed for everything below)", yn(d.secureContext)],
		["VideoDecoder / VideoEncoder", yn(d.webcodecs && d.webcodecs.VideoDecoder) + " / " + yn(d.webcodecs && d.webcodecs.VideoEncoder)],
		["AudioDecoder / AudioEncoder", yn(d.webcodecs && d.webcodecs.AudioDecoder) + " / " + yn(d.webcodecs && d.webcodecs.AudioEncoder)],
	];
	for (const [label] of ENCODER_PROBES) {
		const val = d.videoEncode ? d.videoEncode[label] : undefined;
		rows.push(["Encode " + label, typeof val === "boolean" ? yn(val) : String(val ?? "not probed")]);
	}
	rows.push(["WebGPU adapter", typeof d.webgpu === "boolean" ? yn(d.webgpu) : String(d.webgpu)]);
	rows.push(["Private file storage (OPFS)", yn(d.opfs && d.opfs.getDirectory)]);
	rows.push(["OPFS createWritable", yn(d.opfs && d.opfs.createWritable)]);
	if (d.storage && typeof d.storage === "object") {
		rows.push(["Storage available", d.storage.quotaText + " (used: " + d.storage.usageText + ")"]);
	} else {
		rows.push(["Storage available", String(d.storage)]);
	}
	rows.push(["Share sheet (navigator.share)", yn(d.share && d.share.share)]);
	rows.push(["Can share a video file", String(d.share ? d.share.canShareVideoFile : "?")]);
	rows.push(["Screen wake lock", yn(d.wakeLock)]);

	tbody.replaceChildren();
	for (const [label, value] of rows) {
		const tr = document.createElement("tr");
		const th = document.createElement("th");
		th.scope = "row";
		th.textContent = label;
		const td = document.createElement("td");
		td.textContent = value;
		tr.append(th, td);
		tbody.append(tr);
	}
}

function yn(v) { return v ? "yes" : "no"; }

async function testReencode() {
	const file = await sourceForProcessing();
	if (!file) throw new Error("Pick a clip first (test 1), or run test 2 so a copy exists.");
	if (typeof VideoEncoder === "undefined") {
		setTest("reencode", { status: "unsupported", detail: "No WebCodecs VideoEncoder in this browser." });
		setStatus("t3b", "Not supported in this browser — that result has been recorded.");
		renderReencodeResults();
		return;
	}
	if (!opfsSupported() || !createWritableSupported()) {
		setTest("reencode", { status: "unsupported", detail: "This browser can't write the result to private storage (no OPFS createWritable)." });
		setStatus("t3b", "Not supported in this browser — that result has been recorded.");
		renderReencodeResults();
		return;
	}

	setStatus("t3b", "Speed test running… keep this page open and the screen on.");
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	let encoder = null;
	let writable = null; // hoisted so the catch below can abandon them on failure
	let wrapped = null;  // normalizingWritable() wrapper around `writable`
	let output = null;
	try {
		const video = await input.getPrimaryVideoTrack();
		if (!video) throw new Error("No video track found in this clip.");
		if (!(await video.canDecode())) {
			setTest("reencode", { status: "unsupported", detail: "This browser cannot decode the clip's video codec (" + (await video.getCodecParameterString()) + ")." });
			setStatus("t3b", "This browser can't decode the clip — that result has been recorded.");
			renderReencodeResults();
			return;
		}

		const duration = await input.computeDuration();
		const segLen = Math.min(60, duration);
		const segStart = Math.min(Math.max(0, duration * 0.4), Math.max(0, duration - segLen));
		const stats = await video.computePacketStats(120);
		const fps = stats.averagePacketRate > 0 ? stats.averagePacketRate : 30;

		// Canvas at DISPLAY size = the container rotation is applied when
		// drawing (Safari WebCodecs does NOT auto-rotate; portrait iPhone
		// footage arrives sideways — mediabunny's VideoSample.draw() bakes
		// the rotation in for us).
		const width = floorEven(await video.getDisplayWidth());
		const height = floorEven(await video.getDisplayHeight());
		const bitrate = Math.min(30_000_000, Math.max(2_000_000, Math.round(stats.averageBitrate) || 8_000_000));

		// Prefer HEVC (Safari hardware), fall back to H.264 — probed at the
		// ACTUAL output dimensions.
		let chosen = null;
		for (const [, codecString] of [["hevc", "hvc1.1.6.L153.B0"], ["avc", "avc1.640033"]]) {
			try {
				const res = await VideoEncoder.isConfigSupported({ codec: codecString, width, height, bitrate, framerate: Math.round(fps) });
				if (res.supported) { chosen = codecString; break; }
			} catch (e) { /* try next */ }
		}
		if (!chosen) {
			setTest("reencode", { status: "unsupported", detail: "Neither HEVC nor H.264 encoding is supported at " + width + "×" + height + "." });
			setStatus("t3b", "No usable encoder — that result has been recorded.");
			renderReencodeResults();
			return;
		}
		const mbCodec = chosen.startsWith("hvc1") ? "hevc" : "avc";

		const opfsName = "reencode.mp4";
		const handle = await opfsFileHandle(opfsName, true);
		writable = await handle.createWritable();
		// Field defect fix: StreamTarget gets the normalizing wrapper, never
		// the raw OPFS stream — WebKit must never see a subarray view.
		wrapped = normalizingWritable(writable);
		output = new Output({
			format: new Mp4OutputFormat({ fastStart: false }),
			target: new StreamTarget(wrapped.stream, { chunked: true }),
		});
		const packetSource = new EncodedVideoPacketSource(mbCodec);
		output.addVideoTrack(packetSource); // rotation baked into pixels — no metadata needed
		await output.start();

		const canvas = typeof OffscreenCanvas !== "undefined"
			? new OffscreenCanvas(width, height)
			: (() => { const c = document.createElement("canvas"); c.width = width; c.height = height; return c; })();
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Could not create a 2D canvas context.");

		let muxChain = Promise.resolve();
		let muxError = null;
		let encError = null;
		encoder = new VideoEncoder({
			output: (chunk, meta) => {
				muxChain = muxChain
					.then(() => packetSource.add(EncodedPacket.fromEncodedChunk(chunk), meta))
					.catch((e) => { if (!muxError) muxError = e; });
			},
			error: (e) => { if (!encError) encError = e; },
		});
		encoder.configure({ codec: chosen, width, height, bitrate, framerate: Math.round(fps) });

		setTest("reencode", {
			srcName: file.name,
			codec: chosen,
			width,
			height,
			bitrate,
			segmentStartSeconds: round2(segStart),
			segmentTargetSeconds: round2(segLen),
		});

		const sink = new VideoSampleSink(video);
		const keyEvery = Math.max(1, Math.round(fps * 2));
		let frames = 0;
		let baseUs = null;
		let encodedEndUs = 0; // end of the last encoded frame — verify's expected duration
		const t0 = performance.now();
		const stopBeat = startHeartbeat("reencode", () => ({
			frames,
			elapsedMs: Math.round(performance.now() - t0),
		}));

		try {
			for await (const sample of sink.samples(segStart, segStart + segLen)) {
				try {
					if (encError) throw encError;
					if (muxError) throw muxError;
					if (baseUs === null) baseUs = sample.microsecondTimestamp;
					sample.draw(ctx, 0, 0, width, height); // applies container rotation
					const tsUs = Math.max(0, sample.microsecondTimestamp - baseUs);
					const durUs = Math.max(0, Math.round(sample.microsecondDuration)) || 0;
					encodedEndUs = Math.max(encodedEndUs, tsUs + durUs);
					const frame = new VideoFrame(canvas, {
						timestamp: tsUs,
						duration: durUs || undefined,
					});
					try {
						encoder.encode(frame, { keyFrame: frames % keyEvery === 0 });
					} finally {
						frame.close(); // Safari decoders stall when frames stay open
					}
					frames++;
					while (encoder.encodeQueueSize > 8) await sleep(5); // backpressure
				} finally {
					sample.close();
				}
			}
			await encoder.flush();
			if (encError) throw encError;
			encoder.close();
			encoder = null;
			await muxChain;
			if (muxError) throw muxError;
			await output.finalize(); // closes + commits the OPFS file
		} finally {
			stopBeat();
		}

		const wallMs = Math.round(performance.now() - t0);
		const outFile = await handle.getFile();
		const encodeFps = round1(frames / (wallMs / 1000));

		// Integrity self-check (field defect, see top of file). Never throws.
		const verify = await verifyOutput("reencode", handle, encodedEndUs / 1e6, wrapped.stats);

		setTest("reencode", {
			status: "done",
			frames,
			wallMs,
			wallText: fmtSeconds(wallMs),
			encodeFps,
			outputBytes: outFile.size,
			opfsName,
			writes: Object.assign({}, wrapped.stats),
			verify,
			progress: null,
		});
		if (verify.status === "ok") {
			setStatus("t3b", "Speed test done: " + frames + " frames in " + fmtSeconds(wallMs) + " = " + encodeFps + " fps. Output checks out.");
		} else if (verify.status === "corrupt") {
			setStatus("t3b", "Speed test finished (" + encodeFps + " fps) but the output FAILED its check — see the red box below.");
		} else {
			setStatus("t3b", "Speed test done: " + frames + " frames in " + fmtSeconds(wallMs) + " = " + encodeFps + " fps, but the result could not be checked — see below.");
		}
		renderReencodeResults();
	} catch (e) {
		await abandonOutput(output, wrapped ? wrapped.stream : writable); // best effort; never masks `e`
		throw e;
	} finally {
		if (encoder && encoder.state !== "closed") {
			try { encoder.close(); } catch (e) { /* already closed */ }
		}
		input.dispose();
	}
}

function renderReencodeResults() {
	renderVerify("t3b-verify", journal.tests.reencode);
	renderKv("t3b-results", journal.tests.reencode, [
		["Status", "status"],
		["Why", "detail"],
		["Source clip", "srcName"],
		["Encoder", (t) => (t.codec ? t.codec + " @ " + t.width + "×" + t.height : null)],
		["Bitrate", (t) => (typeof t.bitrate === "number" ? Math.round(t.bitrate / 1000).toLocaleString("en-US") + " kbit/s" : null)],
		["Segment", (t) => (typeof t.segmentStartSeconds === "number" ? t.segmentTargetSeconds + " s starting at " + t.segmentStartSeconds + " s" : null)],
		["Frames processed", "frames"],
		["Took", "wallText"],
		["Speed", (t) => (typeof t.encodeFps === "number" ? t.encodeFps + " frames per second" : null)],
		["Output size", (t) => (typeof t.outputBytes === "number" ? fmtBytes(t.outputBytes) : null)],
		["Problem", "error"],
	]);
}

/* ====================================================================== *
 *  Generic key/value results renderer
 * ====================================================================== */

function renderKv(containerId, test, rows) {
	const wrap = byId(containerId);
	if (!wrap) return;
	if (!test || test.status === "idle") { wrap.hidden = true; return; }
	const dl = document.createElement("dl");
	dl.className = "kv";
	for (const [label, key] of rows) {
		const value = typeof key === "function" ? key(test) : test[key];
		if (value == null) continue;
		const dt = document.createElement("dt");
		dt.textContent = label;
		const dd = document.createElement("dd");
		dd.textContent = String(value);
		dl.append(dt, dd);
	}
	wrap.replaceChildren(dl);
	wrap.hidden = false;
}

/* ====================================================================== *
 *  Results: copy / reset
 * ====================================================================== */

async function copyResults() {
	const text = JSON.stringify(journal, null, 2);
	const statusEl = byId("copy-status");
	try {
		await navigator.clipboard.writeText(text);
		if (statusEl) statusEl.textContent = "Copied — now paste it into a message.";
		return;
	} catch (e) { /* fall through to the textarea fallback */ }
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.left = "-9999px";
		document.body.append(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		if (statusEl) {
			statusEl.textContent = ok
				? "Copied — now paste it into a message."
				: "Couldn't copy automatically — long-press the text below and copy it by hand.";
		}
	} catch (e) {
		if (statusEl) statusEl.textContent = "Couldn't copy automatically — long-press the text below and copy it by hand.";
	}
}

async function resetResults() {
	const btn = byId("reset-results");
	if (!state.resetArmed) {
		state.resetArmed = true;
		btn.textContent = "Tap again to erase everything";
		btn.classList.add("danger--armed");
		setTimeout(() => {
			state.resetArmed = false;
			btn.textContent = "Reset all results";
			btn.classList.remove("danger--armed");
		}, 4000);
		return;
	}
	state.resetArmed = false;
	btn.textContent = "Reset all results";
	btn.classList.remove("danger--armed");

	try { localStorage.removeItem(JOURNAL_KEY); } catch (e) { /* fine */ }
	await opfsRemoveAll(); // also frees the big test files on the phone
	journal = defaultJournal();
	saveJournal();
	state.currentFile = null;
	state.share.ingest = null;
	state.share.cut = null;
	if (state.cutUrl) { URL.revokeObjectURL(state.cutUrl); state.cutUrl = null; }
	byId("t3a-download").hidden = true;
	byId("t2-confirm").checked = false;
	byId("t3a-confirm").checked = false;
	byId("restored-banner").hidden = true;
	setStatus("t1", "");
	setStatus("t2", "");
	setStatus("t3a", "");
	setStatus("t3b", "");
	clearTestError("t1");
	clearTestError("t2");
	clearTestError("t3a");
	clearTestError("t3b");
	renderPickerResults();
	renderIngestResults();
	renderCutResults();
	renderReencodeResults();
	updateClipBar();
	updateButtons();
	gatherMatrix(); // fresh matrix for the wiped journal
}

/* ====================================================================== *
 *  Button enable/disable + hints
 * ====================================================================== */

function updateButtons() {
	const busy = !!state.activeTest;
	byId("t1-pick-library").disabled = busy;
	byId("t1-pick-files").disabled = busy;
	byId("clip-pick").disabled = busy;
	byId("t2-start").disabled = busy || !state.currentFile;
	byId("t2-share").disabled = busy || !state.share.ingest;
	byId("t3a-start").disabled = busy || !hasProcessingSource();
	byId("t3a-share").disabled = busy || !state.share.cut;
	byId("t3b-start").disabled = busy || !hasProcessingSource();
	byId("t2-need").hidden = !!state.currentFile;
	byId("t3a-need").hidden = hasProcessingSource();
	byId("t3b-need").hidden = hasProcessingSource();
}

/* ====================================================================== *
 *  Restore after a reload (including crash detection)
 * ====================================================================== */

function detectInterruption() {
	for (const [id, test] of Object.entries(journal.tests)) {
		if (test && test.status === "running") {
			journal.interruptions.push({ interrupted: id, at: nowIso() });
			test.status = "interrupted";
			test.error = "The page reloaded while this test was running — on iPhone that usually means iOS killed the tab (out of memory) or the test crashed the browser. The last recorded progress is in the results JSON.";
		}
	}
}

async function rearmFromOpfs() {
	if (!opfsSupported()) return;
	const ing = journal.tests.ingest;
	if (ing && ing.status === "done" && ing.opfsName) {
		try {
			const handle = await opfsFileHandle(ing.opfsName, false);
			const stored = await handle.getFile();
			state.share.ingest = new File([stored], ing.srcName || ing.opfsName, { type: ing.srcType || guessMime(ing.opfsName) });
		} catch (e) { /* the copy is gone — share stays disabled */ }
	}
	const cut = journal.tests.cut;
	if (cut && cut.status === "done" && cut.opfsName) {
		try {
			const handle = await opfsFileHandle(cut.opfsName, false);
			const outFile = await handle.getFile();
			state.share.cut = new File([outFile], cut.opfsName, { type: guessMime(cut.opfsName) });
			armCutDownload(outFile, cut.opfsName);
		} catch (e) { /* gone */ }
	}
	updateClipBar();
	updateButtons();
}

function restoreUi(hadJournal) {
	if (hadJournal) {
		const banner = byId("restored-banner");
		const text = byId("restored-text");
		const inter = journal.interruptions;
		if (banner && text) {
			text.textContent = inter.length > 0
				? "Results from an earlier visit were restored. NOTE: the page previously reloaded during: "
					+ inter.map((x) => x.interrupted).join(", ") + " — that is recorded in the results."
				: "Results from an earlier visit were restored. You can keep going or reset at the bottom.";
			banner.hidden = false;
		}
	}
	for (const [id, statusId] of [["picker", "t1"], ["ingest", "t2"], ["cut", "t3a"], ["reencode", "t3b"]]) {
		const t = journal.tests[id];
		if (!t) continue;
		if (t.status === "interrupted") {
			setStatus(statusId, "Interrupted by a reload last time — you can run it again.");
			showTestError(statusId, { name: "Interrupted", message: t.error });
		} else if (t.status === "failed") {
			setStatus(statusId, "Failed last time — you can run it again.");
			if (t.error) showTestError(statusId, { name: "Recorded", message: t.error });
		} else if (t.status === "done") {
			setStatus(statusId, "Done earlier — results below. Run again to overwrite.");
		} else if (t.status === "unsupported") {
			setStatus(statusId, "Recorded as not supported in this browser.");
		}
	}
	const ing = journal.tests.ingest;
	if (ing) byId("t2-confirm").checked = !!ing.photosConfirmed;
	const cut = journal.tests.cut;
	if (cut) byId("t3a-confirm").checked = !!cut.photosConfirmed;
	renderPickerResults();
	renderIngestResults();
	renderCutResults();
	renderReencodeResults();
	renderMatrix();
	renderDeviceSummary();
}

/* ====================================================================== *
 *  Global error surfacing — failures must never be silent
 * ====================================================================== */

function wireGlobalErrors() {
	window.addEventListener("error", (ev) => {
		const msg = ev.message || "script error";
		journal.lastUncaughtError = { message: String(msg), at: nowIso() };
		saveJournal();
		const strip = byId("global-error");
		const text = byId("global-error-text");
		if (strip && text) {
			text.textContent = "Unexpected page error: " + msg;
			strip.hidden = false;
		}
	});
	window.addEventListener("unhandledrejection", (ev) => {
		const msg = errText(ev.reason);
		journal.lastUncaughtError = { message: msg, at: nowIso() };
		saveJournal();
		const strip = byId("global-error");
		const text = byId("global-error-text");
		if (strip && text) {
			text.textContent = "Unexpected page error: " + msg;
			strip.hidden = false;
		}
	});
}

/* ====================================================================== *
 *  Boot
 * ====================================================================== */

function wireEvents() {
	byId("file-input").addEventListener("change", () => { onFilePicked(); });
	byId("t1-pick-library").addEventListener("click", () => openPicker("library"));
	byId("t1-pick-files").addEventListener("click", () => openPicker("files"));
	byId("clip-pick").addEventListener("click", () => openPicker("clip"));

	byId("t2-start").addEventListener("click", () => runTest("ingest", testIngest));
	byId("t2-share").addEventListener("click", () => shareToPhotos("ingest", "t2", state.share.ingest, renderIngestResults));
	byId("t2-confirm").addEventListener("change", (ev) => {
		setTest("ingest", { photosConfirmed: ev.target.checked });
		renderIngestResults();
	});

	byId("t3a-start").addEventListener("click", () => runTest("cut", testCut));
	byId("t3a-share").addEventListener("click", () => shareToPhotos("cut", "t3a", state.share.cut, renderCutResults));
	byId("t3a-confirm").addEventListener("change", (ev) => {
		setTest("cut", { photosConfirmed: ev.target.checked });
		renderCutResults();
	});

	byId("t3b-start").addEventListener("click", () => runTest("reencode", testReencode));

	byId("copy-json").addEventListener("click", () => { copyResults(); });
	byId("reset-results").addEventListener("click", () => { resetResults(); });
}

function boot() {
	wireGlobalErrors();
	const restored = loadJournal();
	const hadJournal = !!restored;
	if (restored) {
		journal = restored;
		journal.pageLoads = (journal.pageLoads || 0) + 1;
		detectInterruption();
	}
	saveJournal();
	wireEvents();
	restoreUi(hadJournal);
	updateClipBar();
	updateButtons();
	// Feature matrix BEFORE any heavy test can run — a later crash still
	// leaves the matrix in the journal.
	gatherMatrix();
	rearmFromOpfs();
}

boot();
