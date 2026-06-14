/* =============================================================================
   music-ui.js — the Music panel (M3, arch §7.1 "the UI sets the same").
   -----------------------------------------------------------------------------
   The user-facing half of "Add music". Three parts, all writing through the
   SAME store/engine surfaces the agent's bridge executors use (music-ops.js +
   store/music.js) so the agent and UI never diverge (arch §3.3):

     1. UPLOAD YOUR OWN — a Files picker (a user gesture; the agent cannot read
        the filesystem — arch §7.1). The input is `multiple`, so a pick can
        carry several audio files; they import STRICTLY one at a time (a
        sequential single-flight batch mirroring ingest.js runBatch — the gate
        is held across the whole batch, one bad file is skipped and the rest
        continue). Each picked audio file is probed (engine/probe via the
        editor's adapter when present, else size-only) and imported into OPFS
        (music-ops.importUserTrack → store/music.importTrack). PLACEMENT
        DIFFERS BY COUNT (product decision): a SINGLE-file pick is also placed
        under the whole video immediately (the common case); a MULTI pick
        imports every track into the Music panel WITHOUT auto-placing — placing
        all N under the whole video would stack N overlapping beds in the mix,
        so the user places them deliberately afterward.
     2. BROWSE THE BUILT-IN LIBRARY — list_music_library (the bundled CC0
        catalog, same-origin static). Tapping "Use" places it under the whole
        video with sensible defaults (a library_id is resolved to its .m4a and
        copied into OPFS lazily by music-ops.addMusic).
     2b. YOUR SOUNDS — the project's IMPORTED user tracks (store/music.listTracks),
        the ones brought in by the upload picker (esp. a MULTI pick, which
        imports WITHOUT auto-placing — see UPLOAD above). Without this list those
        tracks are invisible and unplaceable. Each row shows the track's name +
        duration; an unplaced track gets a "Place" action (the SAME placement
        flow the single-upload path uses — import is already done, this just
        appends the placement via music-ops.addMusic) and a "Remove" action
        (store/music.deleteTrack). A track that is currently on the timeline is
        shown as "On the timeline" and its Remove is parked (delete the placement
        below first) so a placement can never reference deleted bytes. The list
        refreshes after a multi-import lands and after every place/remove.
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
import { listTracks, deleteTrack } from "./store/music.js";
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
    type: "file", accept: "audio/*", multiple: true, class: "music__file",
    "aria-hidden": "true", tabindex: "-1",
  });
  const uploadBtn = el("button", {
    class: "btn btn--sm music__upload", type: "button",
    onclick: () => { if (!busy) fileInput.click(); },
  }, [icon("i-plus"), el("span", { text: "Upload from Files" })]);

  // iOS multi-select hint: the Files app hides multi-select behind a "Select"
  // gesture, and the Photo Library lets you tap several — neither is obvious.
  // textContent-only, 390px-friendly. (Mirrors the video picker's hint.)
  const multiHint = el("p", {
    class: "music__hint",
    text: "Add several at once: in your Photo Library tap multiple, or in Files tap “Select” first.",
  });

  const libraryBtn = el("button", {
    class: "btn btn--sm music__browse", type: "button",
    "aria-expanded": "false", onclick: () => toggleLibrary(),
  }, [icon("i-film"), el("span", { text: "Browse library" })]);

  const libraryList = el("div", { class: "music__library", hidden: true, role: "list" });

  /* ---- "Your sounds": imported user tracks (uploads + any placed library
     copies). Hidden until at least one imported track exists — an empty section
     would just be noise next to the upload control. The list itself is a `role
     list`; each row a `listitem` with a Place/Remove action. */
  const tracksList = el("div", { class: "music__yours-list", role: "list" });
  const tracksSection = el("section", { class: "music__yours", hidden: true, "aria-label": "Your imported sounds" }, [
    el("h3", { class: "music__yours-title", text: "Your sounds" }),
    el("p", { class: "music__yours-sub", text: "Imported tracks ready to place under your video." }),
    tracksList,
  ]);

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
    multiHint,
    libraryList,
    tracksSection,
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
  // The "Your sounds" rows re-render only on refresh(), so their per-row Place/
  // Remove buttons must be disabled directly while an op is in flight (mirrors
  // uploadBtn/libraryBtn). Tracked here, refreshed whenever the list rebuilds.
  let trackActionBtns = [];
  function setBusy(v) {
    busy = v;
    root.dataset.busy = String(v);
    uploadBtn.disabled = v;
    libraryBtn.disabled = v;
    for (const b of trackActionBtns) b.disabled = v;
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

  /* ---- "Your sounds": imported-track list (render + place + remove) ----------
     listTracks returns every imported trkmeta (user uploads AND any library
     track copied into OPFS when it was placed). We surface them all so a
     multi-imported-but-unplaced upload is visible and placeable; a row carries
     its placed-state so the user never double-places or deletes live bytes. */

  /* The imported tracks currently sitting on the timeline (by track_id). A
     library track only lands in `tracks` once placed, so its row always reads
     placed — we still show it (honest) but park its Remove. */
  function placedTrackIds() {
    const ids = new Set();
    for (const m of placements) if (m && m.track_id) ids.add(m.track_id);
    return ids;
  }

  function trackName(t) {
    return (t && (t.title || t.original_name)) || "Untitled sound";
  }

  function renderTracks() {
    trackActionBtns = [];
    if (!tracks.length) {
      tracksSection.hidden = true;
      tracksList.replaceChildren();
      return;
    }
    const placed = placedTrackIds();
    tracksSection.hidden = false;
    tracksList.replaceChildren(...tracks.map((t) => trackRow(t, placed.has(t.track_id))));
  }

  function trackRow(t, isPlaced) {
    const name = trackName(t);
    const meta = [
      t.source === "library" ? "Library" : null,
      t.duration_s != null ? fmtDuration(t.duration_s) : null,
      isPlaced ? "On the timeline" : null,
    ].filter(Boolean).join(" · ");

    const actions = [];
    if (isPlaced) {
      // Already placed — no second whole-video bed; the placement card below is
      // where it's edited. Remove is parked (deleting live bytes would orphan
      // the placement); we say why.
      const removeBtn = el("button", {
        class: "icon-btn music__yours-remove", type: "button", disabled: true,
        "aria-label": "Remove " + name + " — it's on the timeline; remove its placement below first",
        title: "On the timeline — remove its placement below first",
      }, [icon("i-trash")]);
      actions.push(
        el("span", { class: "music__yours-state", text: "Placed", role: "status" }),
        removeBtn,
      );
    } else {
      const placeBtn = el("button", {
        class: "btn btn--sm btn--primary music__yours-place", type: "button",
        "aria-label": "Place " + name + " under the whole video",
        onclick: () => placeTrack(t),
      }, [el("span", { text: "Place" })]);
      const removeBtn = el("button", {
        class: "icon-btn music__yours-remove", type: "button",
        "aria-label": "Remove " + name,
        onclick: () => removeTrack(t),
      }, [icon("i-trash")]);
      trackActionBtns.push(placeBtn, removeBtn);
      actions.push(placeBtn, removeBtn);
    }

    return el("div", { class: "music__yours-row", role: "listitem" }, [
      el("div", { class: "music__yours-info" }, [
        el("span", { class: "music__yours-name", text: name }),
        meta ? el("span", { class: "music__yours-meta mono", text: meta }) : null,
      ]),
      el("div", { class: "music__yours-actions" }, actions),
    ]);
  }

  /* Place an already-imported track under the whole video — the SAME placement
     the single-upload convenience path uses (gain −8, fades 1 / 1.5), so a
     track placed from this list behaves identically to one auto-placed on a
     single-file pick. Import is already done; this only appends the placement. */
  async function placeTrack(t) {
    if (busy || destroyed) return;
    const name = trackName(t);
    setBusy(true);
    try {
      await addMusic(projectId, {
        track_ref: { track_id: t.track_id },
        duration_s: "whole",
        gain_db: -8,
        fade_in_s: 1,
        fade_out_s: 1.5,
      });
      ctx.notifyEdlChange();
      ctx.notifyRenderChange();
      toast("Placed “" + name + "”.", "ok");
      dlog("info", "music.place.track", { track_id: t.track_id });
      await refresh();
    } catch (err) {
      dlog("warn", "music.place.track.err", { message: String(err && err.message).slice(0, 160) });
      toast(plainErr(err, "Couldn't place that sound."), "bad");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /* Delete an imported track (bytes + trkmeta) when it isn't placed. The render
     re-derives placed-state, so a placed track never reaches here (its Remove is
     disabled) — but we re-check defensively before deleting: if a placement
     appeared between render and tap, we refuse and tell the user. */
  async function removeTrack(t) {
    if (busy || destroyed) return;
    const name = trackName(t);
    if (placedTrackIds().has(t.track_id)) {
      toast("“" + name + "” is on the timeline — remove its placement first.", "info");
      await refresh();
      return;
    }
    setBusy(true);
    try {
      const existed = await deleteTrack(projectId, t.track_id);
      if (existed) {
        toast("Removed “" + name + "”.", "info");
        dlog("info", "music.delete.track", { track_id: t.track_id });
      }
      await refresh();
    } catch (err) {
      dlog("warn", "music.delete.track.err", { message: String(err && err.message).slice(0, 160) });
      toast(plainErr(err, "Couldn't remove that sound."), "bad");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /* ----- upload (one OR many — sequential single-flight batch) ----------------
     The Files/Photo picker is `multiple`, so a pick can carry several audio
     files. They run STRICTLY one at a time (mirror ingest.js runBatch): the
     single-flight `setBusy(true)` gate is held across the WHOLE batch and
     released once in the finally, so there is never a second import in flight.
     Each file is probed → imported → (single-file only) placed; a per-iteration
     try/catch means one bad/oversized file is SKIPPED with a message and the
     rest CONTINUE (never abort the batch — mirrors ingest's degraded-mid-batch).

     PRODUCT DECISION (plan §1): a MULTI pick IMPORTS every track into the
     project (they appear in the Music panel ready to place) but does NOT
     auto-place all N overlapping under the whole video — that would stack N beds
     in the mix. A SINGLE-file pick keeps the import+place convenience. */
  async function onFilePicked() {
    // Snapshot the FileList NOW — picked handles are volatile and the awaited
    // loop reads them seconds apart (bytes are still read lazily per file).
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = "";                 // allow re-picking the same file(s)
    if (files.length === 0 || busy || destroyed) return;

    const multi = files.length > 1;
    setBusy(true);                        // held across the entire batch
    dlog("info", "music.batch.start", { project_id: projectId, count: files.length });
    let added = 0;
    let lastTrackId = null;
    try {
      for (let i = 0; i < files.length; i++) {
        if (destroyed) break;
        const file = files[i];
        try {
          const doc = await importOne(file, { place: !multi });
          lastTrackId = doc.track_id;
          added += 1;
          if (multi) {
            // Per-file feedback during a batch so the user sees progress.
            toast("Added " + added + " of " + files.length + " — " + trackLabel(doc, file), "ok");
          }
          // Keep the panel current as each track lands (cheap refold-free read).
          await refresh();
        } catch (err) {
          dlog("warn", "music.upload.err", {
            message: String(err && err.message).slice(0, 160), batch: multi,
          });
          toast(skipMsg(err, file, multi), "bad");
          // CONTINUE — one bad file never aborts the rest of the batch.
        }
      }
    } finally {
      setBusy(false);                     // single release for the whole batch
      dlog("info", "music.batch.done", {
        project_id: projectId, count: files.length, added,
      });
    }

    if (destroyed) return;
    // A closing summary for a multi-pick (single-file already toasted on place).
    if (multi && added > 0) {
      const verb = added === files.length ? "Imported all " : "Imported ";
      toast(verb + added + " of " + files.length + " — place them from the list below.", "info");
    } else if (!multi && added === 1) {
      toast("Added your music.", "ok");
      dlog("info", "music.add.upload", { track_id: lastTrackId });
    }
  }

  /* Probe → import one file; place it under the whole video ONLY when asked
     (the single-file convenience path). Returns the persisted trkmeta doc.
     Throws on a bad/oversized/non-audio file so the caller can skip+continue. */
  async function importOne(file, { place }) {
    const probed = await probeAudio(file);
    const doc = await importUserTrack(projectId, file, probed);
    if (place) {
      await addMusic(projectId, {
        track_ref: { track_id: doc.track_id },
        duration_s: "whole",
        gain_db: -8,
        fade_in_s: 1,
        fade_out_s: 1.5,
      });
      ctx.notifyEdlChange();
      ctx.notifyRenderChange();
    }
    return doc;
  }

  /* A short label for a track in batch feedback (title → original name → file
     name). Truncated so a long name can't blow out a 390px toast. */
  function trackLabel(doc, file) {
    const raw = (doc && (doc.title || doc.original_name)) || (file && file.name) || "track";
    const s = String(raw);
    return s.length > 40 ? s.slice(0, 39) + "…" : s;
  }

  /* The per-file skip message — names the file in a batch so the user knows
     WHICH one was dropped, and continues. */
  function skipMsg(err, file, multi) {
    const base = plainErr(err, "Couldn't use that file — it must be an audio file.");
    if (!multi) return base;
    const name = trackLabel({}, file);
    return "Skipped “" + name + "”: " + base;
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

    // "Your sounds" reflects every imported track + its placed-state (derived
    // from the just-read placements) — rebuilt on every refresh so a freshly
    // multi-imported track appears immediately and a place/remove updates it.
    renderTracks();

    tierNote.hidden = placements.length === 0;
    if (placements.length === 0) {
      placementsList.replaceChildren(el("p", {
        class: "music__none",
        text: "No music on your timeline yet. Place a sound from “Your sounds” or the library above, or upload your own.",
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
