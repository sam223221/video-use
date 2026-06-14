/* =============================================================================
   format-ui.js — the Format picker + per-clip fit control (M3, arch §3.3, §7).
   -----------------------------------------------------------------------------
   The UI half of "who sets the output shape". Both controls write through the
   SAME store setters the agent's bridge executors use (store/meta.setCanvas /
   setClipFit / setDefaultFit) — so the agent and the UI never diverge (arch
   §3.3). Every write fans out on `edlEvents`: a "render" event repaints the
   preview overlay + the tier readout + the clip strip's fit chips, exactly as
   the agent's executors do (they call ctx.notifyRenderChange()).

   Two mounts:
     • mountFormatPicker(host, ctx) — the canvas chooser on the Preview page:
       aspect chips (16:9 / 9:16 / 1:1 / 4:5) + a 1080/720 resolution toggle +
       a "Match my main clip" option, and a project-wide blur/black background
       switch. Reads the current render block + live tier and reflects them.
     • mountClipFit(card, clipMeta, ctx) — the per-clip fit toggle dropped into
       each clip card in the Media-page strip: contain/cover + (for contain) a
       blur/black background, written sparsely (store/meta.setClipFit).

   Tier readout: after any change we recompute cut.tierCheck(fold, render,
   clips) and surface "Instant · keeps full quality" (lossless) vs "Re-encode ·
   a couple of minutes, standard-range" (render) so the user sees the trade the
   moment they pick a non-native shape — the same honesty the agent's prompt
   carries (arch §7.2). No surprises at Export.

   Phone-first 390px. textContent-only (util.el has no innerHTML path).
   Engine modules (canvas/cut + meta) are DYNAMICALLY imported BARE so a partial
   deploy degrades to a disabled control instead of a dead Preview page — same
   discipline as editor.js's engine adapter.
============================================================================= */

import { el, icon } from "./util.js";

function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

/* The aspect → preset mapping the chips offer (arch §3.1 table). Each aspect
   carries its 1080/720 variants; 1:1 and 4:5 are 1080-only (no 720 preset in
   the table), so their resolution toggle is hidden. */
const ASPECTS = [
  { aspect: "16:9", label: "Landscape", glyph: "16:9", presets: { 1080: "16x9_1080", 720: "16x9_720" } },
  { aspect: "9:16", label: "Portrait",  glyph: "9:16", presets: { 1080: "9x16_1080", 720: "9x16_720" } },
  { aspect: "1:1",  label: "Square",    glyph: "1:1",  presets: { 1080: "1x1_1080" } },
  { aspect: "4:5",  label: "Post",      glyph: "4:5",  presets: { 1080: "4x5_1080" } },
];

/* preset id → its aspect (for reflecting the stored canvas back onto the chips). */
const PRESET_ASPECT = {
  "16x9_1080": "16:9", "16x9_720": "16:9",
  "9x16_1080": "9:16", "9x16_720": "9:16",
  "1x1_1080": "1:1", "4x5_1080": "4:5",
};

/* ----- shared engine-module loader (bare, single instance) -------------------- */
let modsPromise = null;
function loadMods() {
  if (!modsPromise) {
    modsPromise = Promise.all([
      import("./store/meta.js"),
      import("./engine/cut.js"),
    ]).then(([meta, cut]) => ({ meta, cut })).catch((err) => {
      modsPromise = null;          // allow a later retry
      throw err;
    });
  }
  return modsPromise;
}

/* Recompute the live tier from the fold + render block + clips. Returns
   "lossless" | "render" | null (null when the engine can't load). */
async function computeTier(ctx) {
  try {
    const engine = ctx.engine();
    const { meta, cut } = await loadMods();
    const [fold, render, clips] = await Promise.all([
      engine ? engine.fold() : { segments: [], music: [] },
      meta.getRenderBlock(ctx.project.id),
      meta.listClipMetas(ctx.project.id),
    ]);
    return cut.tierCheck(fold, render, clips);
  } catch (err) {
    dlog("warn", "format.tier.err", { message: String(err && err.message).slice(0, 160) });
    return null;
  }
}

/* A small, phone-safe tier line. */
function tierCopy(tier) {
  if (tier === "render") {
    return {
      state: "render",
      label: "Re-encode",
      detail: "A couple of minutes · standard-range (not HDR)",
    };
  }
  return {
    state: "lossless",
    label: "Instant export",
    detail: "Keeps full quality",
  };
}

/* =============================================================================
   Format picker (Preview page)
============================================================================= */

/**
 * Mount the Format picker into `host`.
 * ctx: { project, engine() → adapter|null, edlEvents, notifyRenderChange() }
 * Returns { refresh(), destroy() }.
 */
export function mountFormatPicker(host, ctx) {
  let destroyed = false;
  let busy = false;
  let render = null;          // the current normalized render block

  /* ---- DOM scaffold ---- */
  const aspectRow = el("div", {
    class: "fmt__chips", role: "radiogroup", "aria-label": "Output shape",
  });
  const matchBtn = el("button", {
    class: "fmt__chip fmt__chip--match", type: "button", role: "radio",
    "aria-checked": "false",
  }, [
    el("span", { class: "fmt__chip-glyph fmt__chip-glyph--match", "aria-hidden": "true" }, [icon("i-film")]),
    el("span", { class: "fmt__chip-label", text: "Match main clip" }),
  ]);

  const chipByAspect = new Map();
  for (const a of ASPECTS) {
    const glyph = el("span", { class: "fmt__chip-glyph", "aria-hidden": "true" }, [
      el("span", { class: "fmt__chip-box", dataset: { aspect: a.aspect } }),
    ]);
    const chip = el("button", {
      class: "fmt__chip", type: "button", role: "radio", "aria-checked": "false",
      "aria-label": a.label + " (" + a.glyph + ")",
      onclick: () => pickAspect(a),
    }, [glyph, el("span", { class: "fmt__chip-label", text: a.label }),
        el("span", { class: "fmt__chip-ratio mono", text: a.glyph })]);
    chipByAspect.set(a.aspect, chip);
    aspectRow.append(chip);
  }
  matchBtn.addEventListener("click", () => pickMatch());
  aspectRow.append(matchBtn);

  /* Resolution toggle (1080 / 720) — only meaningful for preset aspects that
     have both; hidden for match-primary and 1:1/4:5. */
  const resHd = resChip("1080", "1080p");
  const resSd = resChip("720", "720p");
  const resRow = el("div", {
    class: "fmt__res", role: "radiogroup", "aria-label": "Resolution",
  }, [resHd.node, resSd.node]);

  /* Background switch (blur / black) — the contain-bar fill. */
  const bgBlur = bgChip("blur", "Blurred");
  const bgBlack = bgChip("black", "Black");
  const bgRow = el("div", {
    class: "fmt__bg", role: "radiogroup", "aria-label": "Letterbox background",
  }, [bgBlur.node, bgBlack.node]);

  const tierBadge = el("span", { class: "fmt__tier-badge mono" });
  const tierDetail = el("span", { class: "fmt__tier-detail" });
  const tierLine = el("p", { class: "fmt__tier", role: "status" }, [tierBadge, tierDetail]);

  const advisoryLine = el("p", { class: "fmt__advisory", role: "status", hidden: true });

  const root = el("section", { class: "fmt", "aria-label": "Output format" }, [
    el("div", { class: "fmt__head" }, [
      el("h3", { class: "fmt__title", text: "Output format" }),
      tierLine,
    ]),
    aspectRow,
    el("div", { class: "fmt__opts" }, [
      el("div", { class: "fmt__opt" }, [
        el("span", { class: "fmt__opt-label", text: "Quality" }), resRow,
      ]),
      el("div", { class: "fmt__opt" }, [
        el("span", { class: "fmt__opt-label", text: "Bars" }), bgRow,
      ]),
    ]),
    advisoryLine,
  ]);
  host.append(root);

  function resChip(value, label) {
    const node = el("button", {
      class: "fmt__seg", type: "button", role: "radio", "aria-checked": "false",
      text: label, onclick: () => pickResolution(value),
    });
    return { node, value };
  }
  function bgChip(value, label) {
    const node = el("button", {
      class: "fmt__seg", type: "button", role: "radio", "aria-checked": "false",
      text: label, onclick: () => pickBackground(value),
    });
    return { node, value };
  }

  /* ---- reflection: paint the controls from the stored render block ---- */
  function reflect() {
    const canvas = (render && render.canvas) || {};
    const mode = canvas.mode || "match_primary";
    const bg = canvas.background || "blur";

    // Aspect chips + match.
    let activeAspect = null;
    if (mode === "preset" && PRESET_ASPECT[canvas.preset]) {
      activeAspect = PRESET_ASPECT[canvas.preset];
    }
    for (const [aspect, chip] of chipByAspect) {
      const on = activeAspect === aspect;
      chip.setAttribute("aria-checked", String(on));
      chip.dataset.active = String(on);
    }
    const matchOn = mode === "match_primary";
    matchBtn.setAttribute("aria-checked", String(matchOn));
    matchBtn.dataset.active = String(matchOn);

    // Resolution: derive the current 1080/720 from the preset; only shown when
    // the active aspect actually has a 720 variant.
    const activeDef = ASPECTS.find((a) => a.aspect === activeAspect) || null;
    const hasRes = !!(activeDef && activeDef.presets[720]);
    resRow.hidden = !hasRes;
    if (hasRes) {
      const is720 = canvas.preset === activeDef.presets[720];
      const curRes = is720 ? "720" : "1080";
      for (const r of [resHd, resSd]) {
        const on = r.value === curRes;
        r.node.setAttribute("aria-checked", String(on));
        r.node.dataset.active = String(on);
      }
    }

    // Background.
    for (const b of [bgBlur, bgBlack]) {
      const on = b.value === bg;
      b.node.setAttribute("aria-checked", String(on));
      b.node.dataset.active = String(on);
    }

    // Resolved dims advisory (e.g. a downscaled 4K match, an unknown preset).
    const adv = (render && render.canvas && render.canvas.__advisory) || null;
    if (adv) {
      advisoryLine.hidden = false;
      advisoryLine.textContent = adv;
    } else {
      advisoryLine.hidden = true;
      advisoryLine.textContent = "";
    }
  }

  function paintTier(tier) {
    const c = tierCopy(tier);
    tierLine.dataset.state = c.state;
    tierBadge.textContent = c.label;
    tierDetail.textContent = c.detail;
  }

  /* ---- writes (through store/meta — same setters the agent uses) ---- */
  async function applyCanvas(spec) {
    if (busy || destroyed) return;
    busy = true;
    setDisabled(true);
    try {
      const { meta } = await loadMods();
      const res = await meta.setCanvas(ctx.project.id, spec);
      render = res.render;
      if (res.advisory) render.canvas.__advisory = res.advisory;
      else if (render.canvas) delete render.canvas.__advisory;
      ctx.notifyRenderChange();      // fan out to preview overlay + strip + tier
      reflect();
      paintTier(await computeTier(ctx));
      dlog("info", "format.canvas.set", { mode: res.canvas.mode, preset: res.canvas.preset || null });
    } catch (err) {
      dlog("warn", "format.canvas.err", { message: String(err && err.message).slice(0, 160) });
    } finally {
      busy = false;
      setDisabled(false);
    }
  }

  function pickAspect(a) {
    // Preserve the current resolution choice when switching aspect if the new
    // aspect supports it; else 1080.
    const curIs720 = render && render.canvas && /(_720)$/.test(String(render.canvas.preset || ""));
    const wantRes = curIs720 && a.presets[720] ? 720 : 1080;
    applyCanvas({ mode: "preset", preset: a.presets[wantRes], background: bgValue() });
  }
  function pickResolution(value) {
    const canvas = (render && render.canvas) || {};
    const aspect = PRESET_ASPECT[canvas.preset];
    const def = ASPECTS.find((a) => a.aspect === aspect);
    if (!def || !def.presets[value]) return;
    applyCanvas({ mode: "preset", preset: def.presets[value], background: bgValue() });
  }
  function pickMatch() {
    applyCanvas({ mode: "match_primary", background: bgValue() });
  }
  function pickBackground(value) {
    const canvas = (render && render.canvas) || {};
    const spec = canvas.mode === "preset"
      ? { mode: "preset", preset: canvas.preset, background: value }
      : { mode: "match_primary", background: value };
    applyCanvas(spec);
  }
  function bgValue() {
    return (render && render.canvas && render.canvas.background) || "blur";
  }

  function setDisabled(v) {
    for (const node of [matchBtn, ...chipByAspect.values(), resHd.node, resSd.node, bgBlur.node, bgBlack.node]) {
      node.disabled = v;
    }
  }

  /* ---- refresh (reload the render block + tier) ---- */
  async function refresh() {
    if (destroyed) return;
    try {
      const { meta } = await loadMods();
      render = await meta.getRenderBlock(ctx.project.id);
    } catch (err) {
      dlog("warn", "format.refresh.err", { message: String(err && err.message).slice(0, 160) });
      render = null;
      root.dataset.disabled = "true";
      return;
    }
    root.dataset.disabled = "false";
    reflect();
    paintTier(await computeTier(ctx));
  }

  const onChange = () => { refresh(); };
  ctx.edlEvents.addEventListener("change", onChange);
  ctx.edlEvents.addEventListener("render", onChange);

  refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      ctx.edlEvents.removeEventListener("change", onChange);
      ctx.edlEvents.removeEventListener("render", onChange);
    },
  };
}

/* =============================================================================
   Per-clip fit control (Media-page clip card)
============================================================================= */

/**
 * Build a fit control node for one clip card. Writes the sparse per-clip fit
 * override through store/meta.setClipFit; reads the project default + the
 * clip's override to reflect state. Returns the node (the strip appends it).
 *
 * ctx: { project, notifyRenderChange() }
 */
export function buildClipFit(clipMeta, ctx) {
  const clipId = clipMeta.clip_id;
  let busy = false;
  let render = null;

  const containBtn = fitSeg("contain", "Fit");
  const coverBtn = fitSeg("cover", "Fill");
  const fitRow = el("div", {
    class: "clipfit__seg", role: "radiogroup", "aria-label": "How this clip fits the frame",
  }, [containBtn.node, coverBtn.node]);

  const bgBlur = bgSeg("blur", "Blur");
  const bgBlack = bgSeg("black", "Black");
  const bgRow = el("div", {
    class: "clipfit__bg", role: "radiogroup", "aria-label": "Letterbox background for this clip",
  }, [bgBlur.node, bgBlack.node]);

  const root = el("div", { class: "clipfit", "aria-label": "Fit for " + (clipMeta.original_name || clipId) }, [
    fitRow, bgRow,
  ]);

  function fitSeg(value, label) {
    const node = el("button", {
      class: "clipfit__btn", type: "button", role: "radio", "aria-checked": "false",
      text: label, onclick: () => setFit(value),
    });
    return { node, value };
  }
  function bgSeg(value, label) {
    const node = el("button", {
      class: "clipfit__btn clipfit__btn--bg", type: "button", role: "radio", "aria-checked": "false",
      text: label, onclick: () => setBg(value),
    });
    return { node, value };
  }

  function effective() {
    // Mirror store/meta.effectiveFit without importing it synchronously.
    const r = render || {};
    const fits = r.fits || {};
    const canvasBg = (r.canvas && r.canvas.background) || "blur";
    const override = fits[clipId];
    if (override && (override.mode === "contain" || override.mode === "cover")) {
      return { mode: override.mode, background: override.background || canvasBg };
    }
    return { mode: (r.default_fit === "cover" ? "cover" : "contain"), background: canvasBg };
  }

  function reflect() {
    const eff = effective();
    for (const b of [containBtn, coverBtn]) {
      const on = b.value === eff.mode;
      b.node.setAttribute("aria-checked", String(on));
      b.node.dataset.active = String(on);
    }
    // Background only matters for contain (cover crops, no bars).
    bgRow.hidden = eff.mode !== "contain";
    for (const b of [bgBlur, bgBlack]) {
      const on = b.value === eff.background;
      b.node.setAttribute("aria-checked", String(on));
      b.node.dataset.active = String(on);
    }
  }

  async function write(spec) {
    if (busy) return;
    busy = true;
    setDisabled(true);
    try {
      const { meta } = await loadMods();
      render = await meta.setClipFit(ctx.project.id, clipId, spec);
      ctx.notifyRenderChange();
      reflect();
      dlog("info", "format.clipfit.set", { clip_id: clipId, mode: spec.mode });
    } catch (err) {
      dlog("warn", "format.clipfit.err", { clip_id: clipId, message: String(err && err.message).slice(0, 160) });
    } finally {
      busy = false;
      setDisabled(false);
    }
  }

  function setFit(value) {
    const eff = effective();
    write({ mode: value, background: value === "contain" ? eff.background : undefined });
  }
  function setBg(value) {
    write({ mode: "contain", background: value });
  }

  function setDisabled(v) {
    for (const n of [containBtn.node, coverBtn.node, bgBlur.node, bgBlack.node]) n.disabled = v;
  }

  // Initial load of the render block (lazy; the control disables until it lands).
  setDisabled(true);
  loadMods()
    .then(({ meta }) => meta.getRenderBlock(ctx.project.id))
    .then((r) => { render = r; reflect(); setDisabled(false); })
    .catch((err) => {
      dlog("warn", "format.clipfit.load.err", { message: String(err && err.message).slice(0, 160) });
      root.dataset.disabled = "true";
    });

  return root;
}
