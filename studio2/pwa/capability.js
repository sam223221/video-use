/* =============================================================================
   capability.js — the boot capability probe (arch §7.4, banked M0 reqs #7/#8).
   -----------------------------------------------------------------------------
   Feature-based detection ONLY — no UA branching anywhere (banked #8: Safari
   and Chrome-iOS behave identically post-fix; never assume Safari-only).

   probeCapabilities() runs once at boot and resolves the caps{} matrix:
     secureContext       window.isSecureContext
     opfs                navigator.storage.getDirectory exists
     createWritable      FileSystemFileHandle.prototype.createWritable exists
     move                FileSystemFileHandle.prototype.move exists
                         (absent → writers use the streamed-copy fallback)
     share / shareFiles  navigator.share / canShare({files:[probe video]})
                         (absent → export shows download only)
     webcodecs.*         VideoDecoder/VideoEncoder/AudioDecoder/AudioEncoder
                         presence. `webcodecs.videoDecoder` is now LOAD-BEARING:
                         it gates the bridge's `view_frames` executor (Agent
                         Vision — the agent reads still frames via WebCodecs
                         decode; a device without it answers a clean
                         "unsupported"). The value reaches bridge.js through the
                         editor's `ctx.caps` (editor.js sets `ctx.caps = caps`
                         from this same probe, so bridge executors read the SAME
                         matrix). videoEncoder/audio* stay display-only (recorded
                         for M3's re-encode tier; gate nothing yet).
     wakeLock            "wakeLock" in navigator
     storage             { quota, usage, persisted } from storage.estimate() /
                         storage.persisted() (nulls when unavailable)
     supported           opfs && createWritable — the Tier-1 FLOOR (banked #7).
                         false → app.js shows the full-stop unsupported screen.

   M3 RENDER GATE (arch §6.1/§6.2) — caps.render, added this pass:
     The M1/M2 webcodecs.* presence flags above are display-only. M3's on-device
     re-encode/compositor tier needs an HONEST "can this device actually encode
     1080p + composite" answer, not a presence flag. caps.render turns the
     presence flags into a real gate using LIVE feature + config probes — NO UA
     branching, NO iOS-version sniff (banked #8). The gate is:
       render.ok = (a working 1080p video encoder) &&
                   (an AAC audio encoder) &&
                   (any usable draw context: WebGPU adapter | WebGL2 | 2D canvas)
     render.reasons[] records WHY (both the passing facts and the blocking ones),
     so a gated phone's reasons are visible in the client log (diag boot facts).
     • videoEncoder probe: VideoEncoder.isConfigSupported() for HEVC
       (hvc1.1.6.L153.B0) and H.264 (avc1.640033) @1080p — at least one must
       resolve {supported:true}. This transitively covers the iOS-26.4 encode
       floor WITHOUT naming a version (the version is the REASON the probe passes
       there; the code checks the capability). render.videoCodec records which.
     • audioEncoder probe: AudioEncoder.isConfigSupported(AAC mp4a.40.2 48k stereo).
     • gpu probe: navigator.gpu.requestAdapter() (preferred) OR an OffscreenCanvas
       webgl2 context. render.gpu records "webgpu" | "webgl2" | "2d". A 2D-only
       device is the SLOW compositor fallback → ADVISORY reason, not a hard fail
       (it still renders, just without GPU compositing) — ok stays true if an
       encoder pair exists. ok is false ONLY when on-device render is genuinely
       impossible (no working video encoder, no audio encoder, or NO draw context).
     • ramClass (navigator.deviceMemory): a SOFT advisory only — low RAM + a long
       timeline → recommend 720p/segments/desktop. NEVER a hard refuse on its own.
     Export (Step 5) gates the render-tier EXPORT on render.ok; the Format/fit/
     music SETTINGS still work on a gated device (they are project settings) — only
     the render EXPORT is gated (arch §6.2). The render block also rides the diag
     boot facts (capsForDiag → app.boot, plus a dedicated cap.render event emitted
     here at probe time via the diag singleton — see logRenderGate below).

   The caps object is published on window.__studio2Caps (same singleton trick
   as diag.js) so view modules reach the SAME probe result regardless of which
   module-instance imported them; app.js also passes caps explicitly where it
   wires views. Probe results ride diag.js boot facts (app.js logs them).
============================================================================= */

function has(obj, key) {
  try { return !!obj && key in obj; } catch { return false; }
}

/* ---------------------------------------------------------------------------
   Render-gate probe configs (arch §6.1). Resolution/level chosen for 1080p:
   • HEVC  hvc1.1.6.L153.B0 — Main profile, Level 5.1 (covers ≤1080p@~60).
   • H.264 avc1.640033      — High profile, Level 5.1 (covers ≤1080p@~60).
   The 1080p probe is the honest floor; a device that can encode 1080p can also
   encode the 720p presets the budget advisory may downshift to.
--------------------------------------------------------------------------- */
const RENDER_PROBE = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  hevcCodec: "hvc1.1.6.L153.B0",
  h264Codec: "avc1.640033",
  bitrate: 8_000_000,        // ~8 Mbps — a representative 1080p target for the probe
  audioCodec: "mp4a.40.2",   // AAC-LC
  audioSampleRate: 48000,
  audioChannels: 2,
  audioBitrate: 160_000,
});

/* Resolve a VideoEncoder.isConfigSupported() probe to a plain boolean. The spec
   returns { supported, config }; older/partial implementations may resolve a
   bare truthy/throw. Any rejection/throw → false (the encoder can't be relied
   on). Never throws outward. */
async function probeVideoEncode(codec) {
  try {
    if (typeof VideoEncoder === "undefined" ||
        typeof VideoEncoder.isConfigSupported !== "function") {
      return false;
    }
    const res = await VideoEncoder.isConfigSupported({
      codec,
      width: RENDER_PROBE.width,
      height: RENDER_PROBE.height,
      bitrate: RENDER_PROBE.bitrate,
      framerate: RENDER_PROBE.fps,
    });
    // Spec shape: { supported:boolean, config }. Treat a missing `supported`
    // (older impls that resolve the config alone) as supported, a present-false
    // as unsupported.
    if (res && typeof res === "object" && "supported" in res) return !!res.supported;
    return !!res;
  } catch { return false; }
}

/* Resolve the AAC AudioEncoder probe to a boolean (same shape discipline). */
async function probeAudioEncode() {
  try {
    if (typeof AudioEncoder === "undefined" ||
        typeof AudioEncoder.isConfigSupported !== "function") {
      return false;
    }
    const res = await AudioEncoder.isConfigSupported({
      codec: RENDER_PROBE.audioCodec,
      sampleRate: RENDER_PROBE.audioSampleRate,
      numberOfChannels: RENDER_PROBE.audioChannels,
      bitrate: RENDER_PROBE.audioBitrate,
    });
    if (res && typeof res === "object" && "supported" in res) return !!res.supported;
    return !!res;
  } catch { return false; }
}

/* Probe a WebGPU adapter (preferred compositor context). Returns true only when
   navigator.gpu.requestAdapter() resolves a non-null adapter. Never throws. */
async function probeWebGPU() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu ||
        typeof navigator.gpu.requestAdapter !== "function") {
      return false;
    }
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

/* Probe a WebGL2 context on an OffscreenCanvas (the DOM-free compositor path the
   render engine uses). Falls back to a DOM <canvas> only if OffscreenCanvas is
   absent. The context is released after the probe. Never throws. */
function probeWebGL2() {
  let canvas = null;
  let gl = null;
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(2, 2);
    } else if (typeof document !== "undefined" &&
               typeof document.createElement === "function") {
      canvas = document.createElement("canvas");
      canvas.width = 2; canvas.height = 2;
    } else {
      return false;
    }
    gl = canvas.getContext("webgl2");
    return !!gl;
  } catch {
    return false;
  } finally {
    // Release the probe context promptly so it never holds a GPU process slot.
    try { gl && gl.getExtension && gl.getExtension("WEBGL_lose_context")?.loseContext(); }
    catch { /* best-effort */ }
  }
}

/* Probe a 2D OffscreenCanvas context (the slow, GPU-less compositor fallback —
   blurred-fill via canvas filter). Never throws. */
function probe2D() {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      return !!new OffscreenCanvas(2, 2).getContext("2d");
    }
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      const c = document.createElement("canvas");
      return !!c.getContext("2d");
    }
    return false;
  } catch { return false; }
}

/* The render gate (arch §6.1). Runs the live encode + draw-context probes and
   folds them into { ok, reasons[], videoCodec, gpu, … }. Pure async, never
   throws outward — every probe is independently try/caught. */
async function probeRenderGate() {
  const render = {
    videoEncode: false,        // at least one of HEVC/H.264 1080p encodes
    videoCodec: null,          // "hevc" | "h264" | null — the chosen output codec
    videoEncodeHevc: false,    // informational: HEVC available (preferred)
    videoEncodeH264: false,    // informational: H.264 available (fallback)
    audioEncode: false,        // AAC encode for the mix
    webgpu: false,             // WebGPU adapter (preferred compositor)
    webgl2: false,             // WebGL2 context (compositor fallback)
    canvas2d: false,           // 2D context (slow GPU-less fallback)
    gpu: null,                 // "webgpu" | "webgl2" | "2d" | null — chosen context
    ramClass: null,            // navigator.deviceMemory (coarse) — soft advisory
    ok: false,                 // the render FLOOR (see below)
    reasons: [],               // greppable WHY strings (pass + block facts)
  };
  const reasons = render.reasons;

  // --- Video encode: HEVC preferred, H.264 fallback (probe-driven, no UA sniff).
  const [hevc, h264] = await Promise.all([
    probeVideoEncode(RENDER_PROBE.hevcCodec),
    probeVideoEncode(RENDER_PROBE.h264Codec),
  ]);
  render.videoEncodeHevc = hevc;
  render.videoEncodeH264 = h264;
  if (hevc) {
    render.videoEncode = true;
    render.videoCodec = "hevc";
    reasons.push("video_encode_hevc_1080p");
  } else if (h264) {
    render.videoEncode = true;
    render.videoCodec = "h264";
    reasons.push("video_encode_h264_1080p");
  } else {
    reasons.push("no_video_encoder_1080p");
  }

  // --- Audio encode (AAC for the mix).
  render.audioEncode = await probeAudioEncode();
  if (render.audioEncode) reasons.push("audio_encode_aac");
  else reasons.push("no_audio_encoder_aac");

  // --- Draw context: WebGPU preferred → WebGL2 → 2D (slow advisory fallback).
  render.webgpu = await probeWebGPU();
  render.webgl2 = probeWebGL2();
  render.canvas2d = probe2D();
  if (render.webgpu) {
    render.gpu = "webgpu";
    reasons.push("gpu_webgpu");
  } else if (render.webgl2) {
    render.gpu = "webgl2";
    reasons.push("gpu_webgl2");
  } else if (render.canvas2d) {
    render.gpu = "2d";
    // GPU absent but a 2D context exists → render still possible, just the slow
    // compositor path. Advisory, NOT a hard fail (arch §6.1).
    reasons.push("gpu_absent_2d_fallback");
  } else {
    reasons.push("no_draw_context");
  }

  // --- RAM budget: a SOFT advisory only (arch §6.1) — never a hard refuse here.
  try {
    const dm = (typeof navigator !== "undefined") ? navigator.deviceMemory : undefined;
    render.ramClass = typeof dm === "number" ? dm : null;
  } catch { render.ramClass = null; }
  if (render.ramClass != null && render.ramClass <= 2) {
    // Low RAM: the export path should prefer 720p + smaller segments, or nudge
    // toward desktop. Advisory — segment-checkpointing lets even a borderline
    // device grind through, so this never flips ok.
    reasons.push("low_ram_advisory");
  }

  // --- The render FLOOR: a working video encoder AND an audio encoder AND ANY
  // usable draw context (2D counts — it's the slow fallback, not a non-starter).
  render.ok = render.videoEncode && render.audioEncode &&
    (render.webgpu || render.webgl2 || render.canvas2d);

  return render;
}

/** Run the full probe. Safe to call repeatedly — the result is cached on
    window so the matrix is gathered exactly once per page load. */
export async function probeCapabilities() {
  if (typeof window !== "undefined" && window.__studio2Caps) return window.__studio2Caps;

  const caps = {
    probedAt: new Date().toISOString(),
    secureContext: typeof window !== "undefined" ? !!window.isSecureContext : false,
    opfs: !!(typeof navigator !== "undefined" && navigator.storage &&
      typeof navigator.storage.getDirectory === "function"),
    createWritable: typeof FileSystemFileHandle !== "undefined" &&
      has(FileSystemFileHandle.prototype, "createWritable"),
    move: typeof FileSystemFileHandle !== "undefined" &&
      has(FileSystemFileHandle.prototype, "move"),
    share: typeof navigator !== "undefined" && "share" in navigator,
    shareFiles: false,
    webcodecs: {
      videoDecoder: typeof VideoDecoder !== "undefined",
      videoEncoder: typeof VideoEncoder !== "undefined",
      audioDecoder: typeof AudioDecoder !== "undefined",
      audioEncoder: typeof AudioEncoder !== "undefined",
    },
    wakeLock: typeof navigator !== "undefined" && "wakeLock" in navigator,
    storage: { quota: null, usage: null, persisted: null },
    // M3 render gate (arch §6.1) — filled by probeRenderGate() below. Default is
    // the closed gate (ok:false) so a probe failure fails safe (render disabled,
    // settings still work — arch §6.2).
    render: {
      videoEncode: false, videoCodec: null,
      videoEncodeHevc: false, videoEncodeH264: false,
      audioEncode: false,
      webgpu: false, webgl2: false, canvas2d: false, gpu: null,
      ramClass: null, ok: false, reasons: [],
    },
    supported: false,
  };

  // canShare with a file payload (spike-proven probe — a 16-byte fake mp4).
  try {
    if (caps.share && typeof navigator.canShare === "function" && typeof File !== "undefined") {
      const probe = new File([new Uint8Array(16)], "probe.mp4", { type: "video/mp4" });
      caps.shareFiles = !!navigator.canShare({ files: [probe] });
    }
  } catch { caps.shareFiles = false; }

  // Storage estimate + persistence state (never throws outward).
  try {
    if (typeof navigator !== "undefined" && navigator.storage &&
        typeof navigator.storage.estimate === "function") {
      const est = await navigator.storage.estimate();
      caps.storage.quota = typeof est.quota === "number" ? est.quota : null;
      caps.storage.usage = typeof est.usage === "number" ? est.usage : null;
    }
  } catch { /* leave nulls */ }
  try {
    if (typeof navigator !== "undefined" && navigator.storage &&
        typeof navigator.storage.persisted === "function") {
      caps.storage.persisted = !!(await navigator.storage.persisted());
    }
  } catch { /* leave null */ }

  // The Tier-1 floor (banked #7): no OPFS or no createWritable → the device
  // cannot hold projects at all → full-stop unsupported screen.
  caps.supported = caps.opfs && caps.createWritable;

  // M3 render gate (arch §6.1): the live encode + draw-context probes. Runs even
  // when supported===false (a device that can't hold projects obviously can't
  // render either, but the probe is cheap and keeps caps.render always shaped).
  try {
    caps.render = await probeRenderGate();
  } catch {
    // Fail safe: leave the default closed gate, record the failure reason.
    caps.render = {
      videoEncode: false, videoCodec: null,
      videoEncodeHevc: false, videoEncodeH264: false,
      audioEncode: false,
      webgpu: false, webgl2: false, canvas2d: false, gpu: null,
      ramClass: null, ok: false, reasons: ["render_probe_failed"],
    };
  }

  // Surface the gate result + reasons in the client log at boot (boot facts), so
  // a gated phone's render reasons are visible in diagnostics. Uses the diag
  // singleton (window.__studio2Diag) rather than a static import — same loose
  // coupling the capsForDiag boot-facts path already relies on, and it stays a
  // no-op in non-browser/test contexts where diag isn't installed. diag.js owns
  // the canonical cap.render emitter (logGate — info when open, warn when gated);
  // fall back to a bare dlog if an older diag instance lacks it.
  try {
    const diag = (typeof window !== "undefined") ? window.__studio2Diag : null;
    if (diag && typeof diag.logGate === "function") {
      diag.logGate(caps.render);
    } else if (diag && typeof diag.dlog === "function") {
      diag.dlog(caps.render.ok ? "info" : "warn", "cap.render", renderGateForDiag(caps.render));
    }
  } catch { /* never let diagnostics break the probe */ }

  if (typeof window !== "undefined") {
    try { window.__studio2Caps = caps; } catch { /* ignore */ }
  }
  return caps;
}

/* Compact, greppable render-gate payload for the diag boot facts (cap.render
   event + capsForDiag). Reasons are capped so a pathological list can't bloat a
   log line; the gate flags are always present. */
export function renderGateForDiag(render) {
  const r = render || {};
  return {
    ok: !!r.ok,
    vcodec: r.videoCodec || null,
    venc: !!r.videoEncode,
    hevc: !!r.videoEncodeHevc,
    h264: !!r.videoEncodeH264,
    aenc: !!r.audioEncode,
    gpu: r.gpu || null,
    ram: typeof r.ramClass === "number" ? r.ramClass : null,
    reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 12) : [],
  };
}

/** The cached probe result, or null before probeCapabilities() resolved. */
export function getCaps() {
  return (typeof window !== "undefined" && window.__studio2Caps) || null;
}

/** Compact diag payload — small, greppable, ships with the boot facts. */
export function capsForDiag(caps) {
  if (!caps) return null;
  return {
    secure: caps.secureContext,
    opfs: caps.opfs,
    writable: caps.createWritable,
    move: caps.move,
    share: caps.share,
    share_files: caps.shareFiles,
    wc_vd: caps.webcodecs.videoDecoder,
    wc_ve: caps.webcodecs.videoEncoder,
    wc_ad: caps.webcodecs.audioDecoder,
    wc_ae: caps.webcodecs.audioEncoder,
    wake: caps.wakeLock,
    quota: caps.storage.quota,
    usage: caps.storage.usage,
    persisted: caps.storage.persisted,
    supported: caps.supported,
    // M3 render gate summary — also rides the app.boot facts (in addition to the
    // dedicated cap.render event emitted at probe time).
    render: renderGateForDiag(caps.render),
  };
}

/** Human rows for the projects view's "Device capabilities" panel.
    Returns [{label, value, state}] where state ∈ ok|warn|bad|info.
    Plain phone-safe language (v1 copy convention — no internal jargon). */
export function capRows(caps, fmtBytes) {
  if (!caps) return [];
  const yn = (v) => (v ? "yes" : "no");
  // caps.render is always shaped by probeCapabilities(), but tolerate an older
  // cached caps object (defensive — this panel may render before a re-probe).
  const render = caps.render || { ok: false, gpu: null };
  const rows = [
    { label: "Secure connection", value: yn(caps.secureContext), state: caps.secureContext ? "ok" : "warn" },
    { label: "Private video storage", value: yn(caps.opfs && caps.createWritable), state: (caps.opfs && caps.createWritable) ? "ok" : "bad" },
    { label: "Fast file moves", value: caps.move ? "yes" : "no (slower fallback)", state: caps.move ? "ok" : "warn" },
    { label: "Save to Photos (share sheet)", value: caps.shareFiles ? "yes" : "no (download instead)", state: caps.shareFiles ? "ok" : "warn" },
    { label: "Keep screen awake", value: yn(caps.wakeLock), state: caps.wakeLock ? "ok" : "warn" },
    {
      // LOAD-BEARING now (Agent Vision): videoDecoder gates view_frames — the
      // assistant can only look at still frames where this is "yes".
      label: "Assistant can read frames",
      value: caps.webcodecs.videoDecoder ? "yes" : "no",
      state: caps.webcodecs.videoDecoder ? "ok" : "warn",
    },
    {
      // M3 render gate (arch §6.1/§6.2): the HONEST "can this device re-encode +
      // composite on-device" answer from live encode + draw-context probes.
      // ok=true → render-tier export works here; false → the Format/fit/music
      // SETTINGS still work, but a render-tier EXPORT shows the honest "keep it
      // lossless, or render on a computer" path. Plain phone-safe copy.
      label: "Make new videos on this device",
      value: render.ok
        ? ("yes" + (render.gpu === "2d" ? " (slower, no graphics chip)" : ""))
        : "no (export here stays lossless, or use a computer)",
      state: render.ok ? (render.gpu === "2d" ? "warn" : "ok") : "warn",
    },
  ];
  if (caps.storage.quota != null && typeof fmtBytes === "function") {
    rows.push({
      label: "Storage available",
      value: fmtBytes(caps.storage.quota - (caps.storage.usage || 0)) + " free of " + fmtBytes(caps.storage.quota),
      state: "info",
    });
  }
  if (caps.storage.persisted != null) {
    rows.push({
      label: "Storage protected",
      value: caps.storage.persisted ? "yes" : "not yet (asked when you create a project)",
      state: caps.storage.persisted ? "ok" : "info",
    });
  }
  return rows;
}
