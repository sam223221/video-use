/* =============================================================================
   music-ui.js — the Music panel (M3, arch §7.1 "the UI sets the same").
   -----------------------------------------------------------------------------
   The user-facing half of "Add music". Three parts, all writing through the
   SAME store/engine surfaces the agent's bridge executors use (music-ops.js +
   store/music.js) so the agent and UI never diverge (arch §3.3):

     1. UPLOAD YOUR OWN — a Files picker (a user gesture; the agent cannot read
        the filesystem — arch §7.1). The picked audio file is probed
        (engine/probe via the editor's adapter when present, else size-only),
        imported into OPFS (music-ops.importUserTrack → store/music.importTrack),
        and offered for placement.
     2. BROWSE THE BUILT-IN LIBRARY — list_music_library (the bundled CC0
        catalog, same-origin static). Tapping "Use" places it under the whole
        video with sensible defaults (a library_id is resolved to its .m4a and
        copied into OPFS lazily by music-ops.addMusic).
     3. PLACEMENTS ON THE TIMELINE — each folded music placement with live
        controls: whole-video vs a start/length range, volume (gain), fade
        in/out, and a "lower under speech" (duck) toggle. Each edit calls
        music-ops.updateMusic; remove calls removeMusic. Every write fans out a
        "change" (refold preview) + "render" (repaint format/tier) edlEvent.

   Music FORCES the render tier (it's mixed in during the re-encode) — the panel
   says so plainly the moment a placement exists, the same honesty the agent's
   prompt carries (arch §7.2 / §8). A CC0 courtesy credit is surfaced
   ("Public-domain music via FreePD / Komiku.") per the library DOCUMENT.

   Phone-first 390px. textContent-only. Single-flight: writes disable the panel
   while in flight (the device never runs two engine ops at once — banked #6;
   this panel's writes are quick store appends, not the heavy queue, but the UI
   still serializes its own taps).
============================================================================= */

import { el, icon, toast, fmtDuration } from "./util.js";
import { listTracks } from "./store/music.js";
import { readState } from "./store/edl.js";
import {
  listMusicLibrary, addMusic, updateMusic, removeMusic, importUserTrack,
} from "./music-ops.js";

function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

/* Gain UI maps a slider 0..100 → −30…+6 dB (a useful music-bed range; the store
   clamps to −60…+6, so the agent can go quieter than the UI offers). */
const GAIN_SLIDER_MIN_DB = -30;
const GAIN_SLIDER_MAX_DB = 6;
function sliderToGain(v) {
  const t = Math.max(0, Math.min(100, Number(v))) / 100;
  return Math.round((GAIN_SLIDER_MIN_DB + t * (GAIN_SLIDER_MAX_DB - GAIN_SLIDER_MIN_DB)) * 10) / 10;
}
function gainToSlider(db) {
  const clamped = Math.max(GAIN_SLIDER_MIN_DB, Math.min(GAIN_SLIDER_MAX_DB, Number(db) || -8));
  return Math.round(((clamped - GAIN_SLIDER_MIN_DB) / (GAIN_SLIDER_MAX_DB - GAIN_SLIDER_MIN_DB)) * 100);
}

/**
 * Mount the Music panel into `host`.
 * ctx: { project, engine() → adapter|null, edlEvents, notifyEdlChange(),
 *        notifyRenderChange() }
 * Returns { refresh(), destroy() }.
 */
export function mountMusicPanel(host, ctx) {
  const projectId = ctx.project.id;
  let destroyed = false;
  let busy = false;
  let tracks = [];                 // imported trkmeta (uploads + copied library)
  let placements = [];             // folded music placements (timeline)
  let timelineDuration = 0;        // current composed-timeline length (s)

  /* ---- DOM ---- */
  const fileInput = el("input", {
    type: "file", accept: "audio/*", class: "music__file",
    "aria-hidden": "true", tabindex: "-1",
  });
  const uploadBtn = el("button", {
    class: "btn btn--sm music__upload", type: "button",
    onclick: () => { if (!busy) fileInput.click(); },
  }, [icon("i-plus"), el("span", { text: "Upload from Files" })]);

  const libraryBtn = el("button", {
    class: "btn btn--sm music__browse", type: "button",
    "aria-expanded": "false", onclick: () => toggleLibrary(),
  }, [icon("i-film"), el("span", { text: "Browse library" })]);

  const libraryList = el("div", { class: "music__library", hidden: true, role: "list" });

  const placementsList = el("div", { class: "music__placements" });

  const tierNote = el("p", { class: "music__tier", role: "status", hidden: true }, [
    icon("i-spark"),
    el("span", { text: "Music re-encodes your video — export takes a couple of minutes and is standard-range." }),
  ]);

  const credit = el("p", {
    class: "music__credit",
    text: "Public-domain music via FreePD / Komiku.",
  });

  const root = el("section", { class: "music", "aria-label": "Sounds & music" }, [
    el("div", { class: "music__head" }, [
      el("h2", { class: "music__title", text: "Sounds & music" }),
    ]),
    el("p", { class: "music__sub", text: "Add a music bed under your video — upload your own, or use a built-in track." }),
    el("div", { class: "music__actions" }, [uploadBtn, libraryBtn, fileInput]),
    libraryList,
    tierNote,
    placementsList,
    credit,
  ]);
  host.append(root);

  fileInput.addEventListener("change", onFilePicked);

  /* ---- library browser ---- */
  let libraryLoaded = false;
  async function toggleLibrary() {
    const open = libraryList.hidden;
    libraryList.hidden = !open;
    libraryBtn.setAttribute("aria-expanded", String(open));
    if (open && !libraryLoaded) await loadLibrary();
  }

  async function loadLibrary() {
    libraryList.replaceChildren(el("p", { class: "music__lib-loading", text: "Loading library…" }));
    let lib;
    try {
      lib = await listMusicLibrary();
    } catch (err) {
      dlog("warn", "music.library.err", { message: String(err && err.message).slice(0, 160) });
      libraryList.replaceChildren(el("p", { class: "music__lib-empty", text: "The built-in library couldn't load." }));
      return;
    }
    libraryLoaded = true;
    const rows = (lib.tracks || []).map((t) => libraryRow(t));
    libraryList.replaceChildren(...(rows.length ? rows : [
      el("p", { class: "music__lib-empty", text: "No built-in tracks available yet." }),
    ]));
  }

  function libraryRow(t) {
    const useBtn = el("button", {
      class: "btn btn--sm btn--primary music__use", type: "button",
      "aria-label": "Add " + (t.title || t.library_id) + " under the whole video",
      onclick: () => addLibrary(t),
    }, [el("span", { text: "Use" })]);
    return el("div", { class: "music__lib-row", role: "listitem" }, [
      el("div", { class: "music__lib-info" }, [
        el("span", { class: "music__lib-name", text: t.title || t.library_id }),
        el("span", { class: "music__lib-meta mono", text: [
          t.mood || null,
          t.duration_s != null ? fmtDuration(t.duration_s) : null,
        ].filter(Boolean).join(" · ") }),
      ]),
      useBtn,
    ]);
  }

  /* ---- writes ---- */
  function setBusy(v) {
    busy = v;
    root.dataset.busy = String(v);
    uploadBtn.disabled = v;
    libraryBtn.disabled = v;
  }

  async function addLibrary(t) {
    if (busy || destroyed) return;
    setBusy(true);
    try {
      await addMusic(projectId, {
        track_ref: { library_id: t.library_id },
        duration_s: "whole",
        gain_db: -10,
        fade_in_s: 1.5,
        fade_out_s: 2,
      });
      ctx.notifyEdlChange();
      ctx.notifyRenderChange();
      toast("Added “" + (t.title || t.library_id) + "”.", "ok");
      dlog("info", "music.add.library", { library_id: t.library_id });
      libraryList.hidden = true;
      libraryBtn.setAttribute("aria-expanded", "false");
      await refresh();
    } catch (err) {
      dlog("warn", "music.add.library.err", { message: String(err && err.message).slice(0, 160) });
      toast(plainErr(err, "Couldn't add that track."), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function onFilePicked() {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";                 // allow re-picking the same file
    if (!file || busy || destroyed) return;
    setBusy(true);
    try {
      const probed = await probeAudio(file);
      const doc = await importUserTrack(projectId, file, probed);
      // Place it under the whole video immediately (the common case).
      await addMusic(projectId, {
        track_ref: { track_id: doc.track_id },
        duration_s: "whole",
        gain_db: -8,
        fade_in_s: 1,
        fade_out_s: 1.5,
      });
      ctx.notifyEdlChange();
      ctx.notifyRenderChange();
      toast("Added your music.", "ok");
      dlog("info", "music.add.upload", { track_id: doc.track_id });
      await refresh();
    } catch (err) {
      dlog("warn", "music.upload.err", { message: String(err && err.message).slice(0, 160) });
      toast(plainErr(err, "Couldn't use that file — it must be an audio file."), "bad");
    } finally {
      setBusy(false);
    }
  }

  /* Probe the uploaded audio for duration/codec via the engine adapter's audio
     open (mediabunny) when available; size-only fallback otherwise. Never
     throws — a probe failure just imports with the fields it could read. */
  async function probeAudio(file) {
    try {
      const engine = ctx.engine();
      if (engine && typeof engine.openAudioForDecode === "function") {
        const facts = await engine.openAudioForDecode(file);
        try {
          return {
            duration_s: facts.duration_s,
            codec: facts.track ? "audio" : null,
            channels: facts.channels,
            sampleRate: facts.sampleRate,
          };
        } finally {
          try { facts.dispose(); } catch { /* */ }
        }
      }
    } catch (err) {
      dlog("info", "music.probe.skip", { message: String(err && err.message).slice(0, 120) });
    }
    return {};
  }

  /* ---- placement editor rows ---- */
  function placementRow(m) {
    const track = tracks.find((t) => t.track_id === m.track_id) || null;
    const name = (track && (track.title || track.original_name)) || "Music";

    /* whole vs range */
    const wholeBtn = scopeBtn("whole", "Whole video");
    const rangeBtn = scopeBtn("range", "A part");
    // "Whole" = starts at 0 and runs to (within a frame of) the timeline end;
    // anything else is a positioned range. The fold clamps duration to the
    // timeline, so a whole-video placement reports at_s≈0 + duration≈timeline.
    const isRange = !(Math.abs(m.at_s || 0) < 0.05
      && timelineDuration > 0 && Math.abs((m.duration_s || 0) - timelineDuration) < 0.2);
    const scopeRow = el("div", {
      class: "mplace__scope", role: "radiogroup", "aria-label": "When the music plays",
    }, [wholeBtn.node, rangeBtn.node]);

    const startInput = el("input", {
      class: "input mplace__num", type: "number", min: "0", step: "1",
      "aria-label": "Start (seconds)", value: String(Math.round(m.at_s || 0)),
    });
    const lenInput = el("input", {
      class: "input mplace__num", type: "number", min: "1", step: "1",
      "aria-label": "Length (seconds)", value: String(Math.round(m.duration_s || 0)),
    });
    const rangeFields = el("div", { class: "mplace__range", hidden: true }, [
      el("label", { class: "mplace__field" }, [el("span", { text: "Start" }), startInput,
        el("span", { class: "mplace__unit mono", text: "s" })]),
      el("label", { class: "mplace__field" }, [el("span", { text: "Length" }), lenInput,
        el("span", { class: "mplace__unit mono", text: "s" })]),
    ]);

    /* volume */
    const gainSlider = el("input", {
      class: "mplace__slider", type: "range", min: "0", max: "100", step: "1",
      value: String(gainToSlider(m.gain_db)), "aria-label": "Music volume",
    });
    const gainValue = el("span", { class: "mplace__gain-val mono", text: gainLabel(m.gain_db) });

    /* fades */
    const fadeIn = el("input", {
      class: "input mplace__num", type: "number", min: "0", max: "10", step: "0.5",
      "aria-label": "Fade in (seconds)", value: String(m.fade_in_s ?? 0),
    });
    const fadeOut = el("input", {
      class: "input mplace__num", type: "number", min: "0", max: "10", step: "0.5",
      "aria-label": "Fade out (seconds)", value: String(m.fade_out_s ?? 0),
    });

    /* duck */
    const duckOn = !!(m.duck && m.duck.enabled);
    const duckToggle = el("button", {
      class: "mplace__duck", type: "button", role: "switch",
      "aria-checked": String(duckOn),
      "aria-label": "Lower music under speech",
    }, [
      el("span", { class: "mplace__duck-track", "aria-hidden": "true" }, [
        el("span", { class: "mplace__duck-knob" }),
      ]),
      el("span", { class: "mplace__duck-label", text: "Lower under speech" }),
    ]);

    const removeBtn = el("button", {
      class: "icon-btn mplace__remove", type: "button",
      "aria-label": "Remove " + name,
      onclick: () => removePlacement(m.music_seq, name),
    }, [icon("i-trash")]);

    /* ---- wiring ---- */
    function syncScope() {
      const rangeMode = rangeBtn.node.dataset.active === "true";
      rangeFields.hidden = !rangeMode;
    }
    wholeBtn.node.addEventListener("click", () => {
      setScopeActive("whole");
      patch(m.music_seq, { duration_s: "whole", at_s: 0 });
    });
    rangeBtn.node.addEventListener("click", () => {
      setScopeActive("range");
      syncScope();
    });
    function setScopeActive(which) {
      for (const b of [wholeBtn, rangeBtn]) {
        const on = b.value === which;
        b.node.setAttribute("aria-checked", String(on));
        b.node.dataset.active = String(on);
      }
      syncScope();
    }
    const commitRange = () => {
      const at = Math.max(0, Math.round(Number(startInput.value) || 0));
      const len = Math.max(1, Math.round(Number(lenInput.value) || 1));
      patch(m.music_seq, { at_s: at, duration_s: len });
    };
    startInput.addEventListener("change", commitRange);
    lenInput.addEventListener("change", commitRange);

    gainSlider.addEventListener("input", () => {
      gainValue.textContent = gainLabel(sliderToGain(gainSlider.value));
    });
    gainSlider.addEventListener("change", () => {
      patch(m.music_seq, { gain_db: sliderToGain(gainSlider.value) });
    });

    const commitFades = () => {
      patch(m.music_seq, {
        fade_in_s: Math.max(0, Math.min(10, Number(fadeIn.value) || 0)),
        fade_out_s: Math.max(0, Math.min(10, Number(fadeOut.value) || 0)),
      });
    };
    fadeIn.addEventListener("change", commitFades);
    fadeOut.addEventListener("change", commitFades);

    duckToggle.addEventListener("click", () => {
      const next = duckToggle.getAttribute("aria-checked") !== "true";
      duckToggle.setAttribute("aria-checked", String(next));
      patch(m.music_seq, { duck: { ...(m.duck || {}), enabled: next } });
    });

    // Initial scope reflection: whole if it spans from 0 to the timeline end.
    setScopeActive(isRange ? "range" : "whole");
    void rangeFields;

    return el("div", { class: "mplace", role: "group", "aria-label": "Music: " + name }, [
      el("div", { class: "mplace__top" }, [
        el("div", { class: "mplace__name-wrap" }, [
          icon("i-spark"),
          el("span", { class: "mplace__name", text: name }),
          (track && track.source === "library")
            ? el("span", { class: "mplace__tag", text: "Library" }) : null,
        ]),
        removeBtn,
      ]),
      scopeRow,
      rangeFields,
      el("div", { class: "mplace__ctl" }, [
        el("label", { class: "mplace__gain" }, [
          el("span", { class: "mplace__ctl-label", text: "Volume" }),
          gainSlider, gainValue,
        ]),
      ]),
      el("div", { class: "mplace__fades" }, [
        el("label", { class: "mplace__field" }, [el("span", { text: "Fade in" }), fadeIn,
          el("span", { class: "mplace__unit mono", text: "s" })]),
        el("label", { class: "mplace__field" }, [el("span", { text: "Fade out" }), fadeOut,
          el("span", { class: "mplace__unit mono", text: "s" })]),
      ]),
      duckToggle,
    ]);
  }

  function scopeBtn(value, label) {
    const node = el("button", {
      class: "mplace__scope-btn", type: "button", role: "radio",
      "aria-checked": "false", text: label,
    });
    return { node, value };
  }

  function gainLabel(db) {
    const v = Math.round(Number(db) * 10) / 10;
    return (v > 0 ? "+" : "") + v + " dB";
  }

  async function patch(musicSeq, fields) {
    if (busy || destroyed) return;
    setBusy(true);
    try {
      await updateMusic(projectId, { music_seq: musicSeq, ...fields });
      ctx.notifyEdlChange();
      ctx.notifyRenderChange();
      await refresh();
    } catch (err) {
      dlog("warn", "music.update.err", { message: String(err && err.message).slice(0, 160) });
      toast(plainErr(err, "Couldn't update the music."), "bad");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removePlacement(musicSeq, name) {
    if (busy || destroyed) return;
    setBusy(true);
    try {
      await removeMusic(projectId, { music_seq: musicSeq });
      ctx.notifyEdlChange();
      ctx.notifyRenderChange();
      toast("Removed “" + name + "”.", "info");
      await refresh();
    } catch (err) {
      dlog("warn", "music.remove.err", { message: String(err && err.message).slice(0, 160) });
      toast(plainErr(err, "Couldn't remove the music."), "bad");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /* ---- refresh ---- */
  async function refresh() {
    if (destroyed) return;
    try {
      const [trks, fold] = await Promise.all([
        listTracks(projectId),
        readState(projectId),
      ]);
      tracks = trks;
      placements = (fold.music || []);
      timelineDuration = Number(fold.timeline_duration_s) || 0;
    } catch (err) {
      dlog("warn", "music.refresh.err", { message: String(err && err.message).slice(0, 160) });
      tracks = [];
      placements = [];
      timelineDuration = 0;
    }
    if (destroyed) return;

    tierNote.hidden = placements.length === 0;
    if (placements.length === 0) {
      placementsList.replaceChildren(el("p", {
        class: "music__none",
        text: "No music yet. Upload your own or pick a built-in track above.",
      }));
      return;
    }
    placementsList.replaceChildren(...placements.map((m) => placementRow(m)));
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

function plainErr(err, fallback) {
  const m = err && err.message ? String(err.message) : "";
  return m && m.length < 140 ? m : fallback;
}
