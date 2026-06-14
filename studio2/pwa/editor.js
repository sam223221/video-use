/* =============================================================================
   editor.js — the editor view composition root (arch §1.3).
   -----------------------------------------------------------------------------
   Mounted into #editor-mount by app.js enterEditor(). Composes, for ONE open
   project, THREE PAGES behind a bottom tab bar (M1.1 phone navigation —
   tabs.js; born from live iPhone feedback):
     • MEDIA   — ingest entry (Step 4) + clip strip + the designed
                 "Sounds & music — coming soon" section (M1.1 PM decision:
                 the M1 engine can't place audio, so no upload control yet)
     • EDIT    — chat (chat.js), full viewport height, keyboard-aware
     • PREVIEW — player (player.js) + export (export.js, incl. exports list)
   The bridge (bridge.js) stays mounted at PROJECT level — connect on enter,
   project-bound executors, disconnect on leave. Tab switches NEVER unmount
   or disconnect anything: pages hide via CSS visibility (tabs.js), so an
   in-flight turn, an open ask_user card, the player's blob URL/position and
   a running ingest copy all survive any amount of tab hopping.

   Tab state: the last-active tab is remembered per project
   (localStorage "studio2.editor.tab.<id>"). Default for a first visit:
   MEDIA when the project has no clips (the only useful action is adding
   one), EDIT otherwise (the conversation is the product).

   Keyboard-aware viewport (the M1.1 critical fix): a window.visualViewport
   resize/scroll watcher publishes the keyboard occlusion as --kb on the
   editor root + data-kb open/closed. CSS shrinks the pages above the
   keyboard (composer stays visible) and hides the tab bar while typing;
   chat.js owns the scroll-follow behavior. No visualViewport (older
   engines) → --kb stays 0 and the plain flex layout bottom-pins the
   composer, which is correct on browsers that resize the layout viewport.

   STEP-4 INTEGRATION (the engine adapter). The engine/store modules load via
   DYNAMIC bare imports so a load failure (stale cache, partial deploy)
   degrades to a usable-but-engineless editor instead of a dead view: chat
   still works, executors answer engine_error, ingest/export explain
   themselves. The adapter binds the REAL Step-4 surfaces:
     store/edl.js    readState / appendApplyCuts / appendUndo / findCommand
     engine/probe.js openProbe (snapRemovalRange per §5.3) / gopEstimate
     engine/cut.js   losslessCut({segments, sources, target, onProgress})
     engine/writers  tempThenRename (the ONLY legal losslessCut target)
     engine/verify   verifyOutput
     ingest.js       mountIngest(container, {project, caps, onClipAdded})

   EDL change fan-out: ONE EventTarget (`edlEvents`). Every journal-affecting
   path — agent apply_cuts/undo (bridge executors), ingest add_clip — fires
   "change"; the player refolds instantly (§7.2 step 4: the preview is correct
   before the agent even answers) and the clip strip re-renders.

   One shared op queue (banked M0 #6): bridge executors and export both run
   on it — never two engine operations concurrently on the phone.
============================================================================= */

import { byId, el, icon, toast, fmtDuration, fmtBytes, deviceId } from "./util.js";
import { projectSubDir, CLIP_ID_RE } from "./store/opfs.js";
import { listClipMetas, readClipMeta } from "./store/meta.js";
import { initBridge, buildExecutors, createOpQueue } from "./bridge.js";
import { initChat } from "./chat.js";
import { initPlayer } from "./player.js";
import { initExport } from "./export.js";
import { createTabBar } from "./tabs.js";
import { mountFormatPicker, buildClipFit } from "./format-ui.js";
import { mountMusicPanel } from "./music-ui.js";
import { mountTranscribe } from "./transcribe.js";
import { transcribeStatus } from "./api.js";
import { mountModelIndicator } from "./settings.js";

/* Last-active tab per project (M1.1). Values: "media" | "edit" | "preview". */
const TAB_IDS = ["media", "edit", "preview"];
const TAB_KEY_PREFIX = "studio2.editor.tab.";

/* The keyboard is "open" past this occlusion (px) — filters the tiny
   visual-viewport jitters iOS produces around bars and rotation. */
const KB_OPEN_PX = 50;

function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

/* =============================================================================
   Engine adapter — every Step-4 touchpoint behind one object
============================================================================= */
async function loadEngineModules() {
  // Bare dynamic imports: exactly ONE module instance each (engine modules
  // hold caches/registries — the ?v=/bare double-load rule, pwa/DOCUMENT.md).
  const [edl, probe, cut, writers, verify, ingest, audio, render, webcodecs] = await Promise.all([
    import("./store/edl.js"),
    import("./engine/probe.js"),
    import("./engine/cut.js"),
    import("./engine/writers.js"),
    import("./engine/verify.js"),
    import("./ingest.js"),
    import("./engine/audio.js"),       // M2: lossless audio extraction (transcribe)
    import("./engine/render.js"),      // M3: the render-tier orchestrator
    import("./engine/webcodecs.js"),   // M3: codec config + audio decode (upload probe)
  ]);
  return { edl, probe, cut, writers, verify, ingest, audio, render, webcodecs };
}

function buildAdapter(mods, projectId) {
  const { edl, probe, cut, writers, verify, ingest, audio, render, webcodecs } = mods;

  return {
    /* ---- EDL (store/edl.js) ---------------------------------------------- */
    async fold() {
      return edl.readState(projectId);   // {segments, timeline_duration_s, ops, last_seq, notices}
    },

    /**
     * apply_cuts, end to end (§5.3 + §3.6): snap every requested range to
     * keyframes at EDIT time, journal ONE op carrying requested+snapped, and
     * return honest realized numbers. Idempotent by command_id — a bridge
     * replay returns the recorded outcome without re-probing or re-appending.
     *
     * Keep-biased snapping can collapse a removal entirely (no keyframe gap
     * inside it): such ranges are reported zero-width in `realized` and are
     * NOT journaled (the journal schema requires start < end).
     */
    async applyCuts({ clipId, file, remove, snap, commandId }) {
      const prior = await edl.findCommand(projectId, commandId);
      if (prior && prior.op === "apply_cuts") {
        const fold = await edl.readState(projectId);
        return { realized: prior.cuts, timeline_duration_s: fold.timeline_duration_s, deduped: true };
      }

      const p = await probe.openProbe(file);
      const realized = [];
      const journalCuts = [];
      try {
        for (const r of remove) {
          const snapped = await p.snapRemovalRange({ start_s: r.start_s, end_s: r.end_s }, snap);
          if (snapped == null) {
            // keep-mode collapse: nothing can be removed without touching
            // kept frames — honest zero-width realized entry, no journal op.
            realized.push({
              requested: { start_s: r.start_s, end_s: r.end_s },
              snapped: { start_s: r.start_s, end_s: r.start_s },
            });
          } else {
            const cutRec = { requested: { start_s: r.start_s, end_s: r.end_s }, snapped };
            realized.push(cutRec);
            journalCuts.push(cutRec);
          }
        }
      } finally {
        p.dispose();
      }

      if (journalCuts.length === 0) {
        // Every range collapsed — the timeline is unchanged; nothing to journal.
        const fold = await edl.readState(projectId);
        return { realized, timeline_duration_s: fold.timeline_duration_s };
      }

      const outcome = await edl.appendApplyCuts(projectId, {
        clip_id: clipId, cuts: journalCuts, snap, command_id: commandId,
      });
      return { realized, timeline_duration_s: outcome.timeline_duration_s };
    },

    async undoLast({ commandId }) {
      return edl.appendUndo(projectId, { command_id: commandId });
    },

    /* ---- probe (engine/probe.js) ------------------------------------------ */
    gopEstimate(file) { return probe.gopEstimate(file); },

    /* ---- cut / verify / writers (export.js consumes these) ----------------- */
    losslessCut(opts) { return cut.losslessCut(opts); },
    tierCheck(fold, renderBlock, clips) { return cut.tierCheck(fold, renderBlock, clips); },
    verifyOutput(opts) { return verify.verifyOutput(opts); },
    tempThenRename(dirHandle, finalName) { return writers.tempThenRename(dirHandle, finalName); },

    /* ---- M3 render tier (engine/render.js — export.js consumes) ------------- */
    renderProject(opts) { return render.renderProject(opts); },

    /* ---- audio extraction (engine/audio.js — transcribe.js consumes) ------- */
    extractAudio(opts) { return audio.extractAudio(opts); },

    /* ---- M3 music-upload probe (engine/webcodecs.js — music-ui.js consumes) - */
    openAudioForDecode(file) { return webcodecs.openAudioForDecode(file); },

    /* ---- ingest (ingest.js) ------------------------------------------------ */
    mountIngest(container, opts) { return ingest.mountIngest(container, opts); },
  };
}

/* =============================================================================
   Clip strip
============================================================================= */
function clipCard(m, transcribeNode, fitNode) {
  const degraded = m.degraded && (m.degraded.flag || m.degraded === true);
  const w = m.video && (m.video.displayWidth ?? m.video.codedWidth);
  const h = m.video && (m.video.displayHeight ?? m.video.codedHeight);
  const dims = w && h ? w + "×" + h : null;
  return el("article", {
    class: "clipcard",
    dataset: { degraded: String(!!degraded) },
    "aria-label": "Clip " + (m.original_name || m.clip_id),
  }, [
    el("div", { class: "clipcard__top" }, [
      el("div", { class: "clipcard__icon", "aria-hidden": "true" }, [icon("i-film")]),
      el("div", { class: "clipcard__body" }, [
        el("span", { class: "clipcard__name", text: m.original_name || m.clip_id }),
        el("span", {
          class: "clipcard__meta mono",
          text: [
            typeof m.duration_s === "number" ? fmtDuration(m.duration_s) : null,
            dims,
            typeof m.size_bytes === "number" ? fmtBytes(m.size_bytes) : null,
          ].filter(Boolean).join(" · "),
        }),
        degraded ? el("span", { class: "clipcard__badge" }, [
          icon("i-alert"), el("span", { text: "Reduced quality" }),
        ]) : null,
      ]),
    ]),
    // M3: the per-clip fit control (contain/cover + blur/black) — format-ui.js
    // owns this node; it writes the sparse fit override through store/meta.
    fitNode || null,
    // M2: the per-clip Transcribe affordance / transcript badge / progress
    // (transcribe.js owns this node's content and its lifecycle).
    transcribeNode || null,
  ]);
}

/* =============================================================================
   initEditor
============================================================================= */

/**
 * Mount the editor for `project` into #editor-mount.
 * Called by app.js enterEditor({id, name}); returns { destroy() }.
 */
export async function initEditor({ project, caps }) {
  const mount = byId("editor-mount");
  if (!mount) throw new Error("#editor-mount missing");
  mount.replaceChildren();

  /* ---- shared plumbing ----------------------------------------------------- */
  const edlEvents = new EventTarget();
  const queue = createOpQueue();
  const devId = deviceId();

  /** clips/<clip_id>.<ext> lookup. Primary route: `clipmeta.file_name`
      (Step 4's documented contract); fallback: scan clips/ for the id prefix
      (covers a torn clipmeta whose file survived). */
  async function findClipFile(clipId) {
    if (!CLIP_ID_RE.test(String(clipId))) return null;
    try {
      const clips = await projectSubDir(project.id, "clips");
      const meta = await readClipMeta(project.id, clipId);
      if (meta && typeof meta.file_name === "string" && meta.file_name.startsWith(clipId + ".")) {
        try {
          const fh = await clips.getFileHandle(meta.file_name);
          return await fh.getFile();
        } catch { /* fall through to the scan */ }
      }
      for await (const [name, handle] of clips.entries()) {
        if (handle.kind === "file" && name.startsWith(clipId + ".") && !name.endsWith(".tmp")) {
          return handle.getFile();
        }
      }
    } catch { /* no clips dir yet */ }
    return null;
  }

  /* ---- layout: three pages + the bottom tab bar (M1.1) ----------------------- */
  const playerSlot = el("div", { class: "editor__player" });
  const stripList = el("div", { class: "clipstrip", role: "list", "aria-label": "Clips in this project" });
  const ingestSlot = el("div", { class: "editor__ingest" });
  const exportSlot = el("div", { class: "editor__export" });
  const chatSlot = el("div", { class: "editor__chat" });
  const musicSlot = el("div", { class: "editor__music" });     // M3 Music panel host
  const formatSlot = el("div", { class: "editor__format" });   // M3 Format picker host

  const mediaPage = el("section", {
    class: "page page--media", id: "page-media",
    role: "tabpanel", "aria-labelledby": "tab-media",
  }, [
    el("div", { class: "media-section" }, [
      el("h2", { class: "media-section__eyebrow", text: "Footage" }),
      stripList,
      ingestSlot,
    ]),
    // M3: the Music panel (replaces M1.1's "coming soon" card now the render
    // tier can place + mix audio). music-ui.js owns its content + lifecycle;
    // mounted on the Media page beside the footage. Falls back to a small
    // unavailable note when the engine didn't load (engineless editor).
    musicSlot,
  ]);
  // The Edit-page header carries the always-visible current-model indicator
  // ("Assistant: Opus") so the user can SEE which model is active even though
  // the SETTING itself is app-level/global (settings.js owns the indicator's
  // data + lifecycle; this is just its mount host).
  const modelIndicatorSlot = el("div", { class: "editor__model-slot" });
  const editHeader = el("div", { class: "edit-header" }, [modelIndicatorSlot]);
  const editPage = el("section", {
    class: "page page--edit", id: "page-edit",
    role: "tabpanel", "aria-labelledby": "tab-edit",
  }, [editHeader, chatSlot]);
  const previewPage = el("section", {
    class: "page page--preview", id: "page-preview",
    role: "tabpanel", "aria-labelledby": "tab-preview",
  }, [playerSlot, formatSlot, exportSlot]);

  const rootEl = el("div", { class: "editor" }, [
    el("div", { class: "editor__pages" }, [mediaPage, editPage, previewPage]),
  ]);
  mount.append(rootEl);

  /* ---- tab bar (M1.1): last-active per project, judgment-call default -------- */
  const tabKey = TAB_KEY_PREFIX + project.id;
  let initialTab = null;
  try {
    const stored = localStorage.getItem(tabKey);
    if (TAB_IDS.includes(stored)) initialTab = stored;
  } catch { /* private mode — session-only default below */ }
  if (!initialTab) {
    let clipCount = 0;
    try { clipCount = (await listClipMetas(project.id)).length; } catch { /* empty */ }
    initialTab = clipCount === 0 ? "media" : "edit";
  }
  const tabBar = createTabBar({
    tabs: [
      { id: "media", label: "Media", icon: "i-film", panel: mediaPage },
      { id: "edit", label: "Edit", icon: "i-scissors", panel: editPage },
      { id: "preview", label: "Preview", icon: "i-play", panel: previewPage },
    ],
    initial: initialTab,
    onChange(id) {
      try { localStorage.setItem(tabKey, id); } catch { /* best-effort */ }
    },
  });
  rootEl.append(tabBar.node);

  /* ---- keyboard-aware viewport (M1.1 critical fix) ----------------------------
     iOS Safari keeps the LAYOUT viewport fixed while the keyboard shrinks the
     VISUAL viewport — a bottom-pinned composer disappears behind the keyboard.
     Publish the occlusion as --kb (CSS pads the editor's bottom by it) and
     data-kb (CSS hides the tab bar while typing — the keyboard covers it
     anyway and the reclaimed rows keep the conversation readable). The
     formula accounts for vv.offsetTop: when iOS pushes the layout viewport
     to reveal a focused input, occlusion at the bottom shrinks accordingly.
     window.scrollTo(0,0) re-pins the pushed layout viewport where possible
     (the app shell never scrolls; chat.js handles the log's own scrolling). */
  const vv = window.visualViewport || null;
  let kbOpen = false;
  function syncViewport() {
    if (!vv) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    rootEl.style.setProperty("--kb", kb + "px");
    const open = kb > KB_OPEN_PX;
    if (open !== kbOpen) {
      kbOpen = open;
      rootEl.dataset.kb = open ? "open" : "closed";
    }
    if (open && (window.scrollY > 0 || vv.offsetTop > 0)) {
      try { window.scrollTo(0, 0); } catch { /* best-effort re-pin */ }
    }
  }
  /* ---- partial-failure teardown (M1.2 P2-1) -----------------------------------
     The mount steps below attach window/document-scoped resources: the
     visualViewport watcher, chat's document visibilitychange listener, the
     bridge's live stream. If a later step throws, app.js catches the
     rejection and routes back to the projects view WITHOUT ever holding a
     destroy handle — so initEditor must unwind whatever it already mounted
     itself before rethrowing, or those listeners leak until reload.
     teardown() is the single unwind path: the init catch (partial mount —
     slots past the failure point are still null) and the success path's
     destroy() both run it, so success-path teardown is unchanged. */
  let vvWatching = false;
  let chatCtl = null;
  let playerCtl = null;
  let exportCtl = null;
  let ingestCtl = null;
  let bridgeCtl = null;
  let transcribeCtl = null;
  let modelIndicatorCtl = null;
  let formatCtl = null;          // M3 Format picker (Preview page)
  let musicCtl = null;           // M3 Music panel (Media page)
  let edlChangeHandler = null;
  let transcriptChangeHandler = null;
  let transcribeVisibilityHandler = null;
  let modelVisibilityHandler = null;

  function teardown() {
    if (bridgeCtl) bridgeCtl.disconnect();
    if (edlChangeHandler) edlEvents.removeEventListener("change", edlChangeHandler);
    if (transcriptChangeHandler) edlEvents.removeEventListener("transcript", transcriptChangeHandler);
    if (transcribeVisibilityHandler) document.removeEventListener("visibilitychange", transcribeVisibilityHandler);
    if (modelVisibilityHandler) document.removeEventListener("visibilitychange", modelVisibilityHandler);
    if (modelIndicatorCtl) modelIndicatorCtl.destroy();
    if (vvWatching && vv) {
      vv.removeEventListener("resize", syncViewport);
      vv.removeEventListener("scroll", syncViewport);
    }
    tabBar.destroy();
    if (chatCtl) chatCtl.destroy();
    if (playerCtl) playerCtl.destroy();
    if (exportCtl) exportCtl.destroy();
    if (formatCtl) formatCtl.destroy();
    if (musicCtl) musicCtl.destroy();
    if (ingestCtl && typeof ingestCtl.destroy === "function") ingestCtl.destroy();
    if (transcribeCtl && typeof transcribeCtl.destroy === "function") transcribeCtl.destroy();
    mount.replaceChildren();
  }

  /* ---- engine (Step 4) -------------------------------------------------------- */
  let adapter = null;
  try {
    const mods = await loadEngineModules();
    adapter = buildAdapter(mods, project.id);
  } catch (err) {
    // Degraded-but-alive: chat/projects still work; engine verbs explain.
    dlog("error", "editor.engine.load.err", { message: String(err && err.message).slice(0, 300) });
    toast("The editing engine didn't load — refresh the app to fix this.", "bad", 8000);
  }

  /* ---- context shared by the feature modules ----------------------------------- */
  const ctx = {
    project,
    caps,
    deviceId: devId,
    queue,
    edlEvents,
    findClipFile,
    engine: () => adapter,
    askUser: null,                        // bound to chat below
    /* Chat activity (a streaming turn, a dangling turn the relay is still
       working on, OR an open ask_user question) drives the Edit tab's
       indicator dot — visible from Media/Preview, so a turn worked on while
       the user is elsewhere is never silent (M1.1; dangling: M1.2 P2-2). */
    onChatActivity(active) {
      tabBar.setActivity("edit", active);
    },
    notifyEdlChange() {
      edlEvents.dispatchEvent(new CustomEvent("change"));
    },
    /* M3: a render-territory change (canvas/per-clip fit/music) — repaint the
       preview overlay, the Format picker's tier readout, the clip-strip fit
       chips, and the Music panel. A separate "render" type so a pure format
       change (which is NOT a journal edit) doesn't trigger a full EDL refold,
       while music ops fire BOTH "change" (refold) and "render" (arch §1.2). */
    notifyRenderChange() {
      edlEvents.dispatchEvent(new CustomEvent("render"));
    },
    /* M2: a transcript landed/was redone/was deleted — refresh the strip badge,
       the chat inventory copy, etc. Reuses edlEvents with a "transcript" type
       (arch §1.2 fan-out). The strip listens and re-renders the affordances. */
    notifyTranscriptChange() {
      edlEvents.dispatchEvent(new CustomEvent("transcript"));
    },
  };

  /* ---- clip strip ---------------------------------------------------------------- */
  async function refreshStrip() {
    let metas = [];
    try { metas = await listClipMetas(project.id); }
    catch (err) { dlog("warn", "editor.strip.err", { message: String(err && err.message).slice(0, 200) }); }
    if (metas.length === 0) {
      stripList.replaceChildren(el("p", {
        class: "clipstrip__empty",
        text: "No clips yet — add a video from your library below.",
      }));
      return;
    }
    stripList.replaceChildren(...metas.map((m) => {
      // transcribeCtl owns the per-clip affordance node (gated state, badge,
      // progress). It's null only in the engineless-degraded editor.
      const transcribeNode = transcribeCtl ? transcribeCtl.renderClip(m) : null;
      // M3: the per-clip fit control (format-ui.js owns it; writes the sparse
      // fit override). Only when the engine adapter loaded (it needs store/meta
      // + the canvas resolver); an engineless editor shows no fit control.
      const fitNode = adapter ? buildClipFit(m, ctx) : null;
      const card = clipCard(m, transcribeNode, fitNode);
      card.setAttribute("role", "listitem");
      return card;
    }));
  }

  try {
    /* The visualViewport watcher attaches here, INSIDE the guarded region —
       it used to attach before chat/player/export/bridge mounted, and a
       throw from any of those leaked it (M1.2 P2-1). Nothing observable
       changes on the success path: the keyboard cannot be open before the
       composer below even exists, and syncViewport still runs once. */
    if (vv) {
      vv.addEventListener("resize", syncViewport);
      vv.addEventListener("scroll", syncViewport);
      vvWatching = true;
      syncViewport();
    }

    /* ---- chat (needed before executors — ask_user routes through it) ------------ */
    chatCtl = initChat(ctx, chatSlot);
    ctx.askUser = (args) => chatCtl.askUser(args);

    /* ---- current-model indicator (Edit-tab header) ------------------------------ *
       The compact "Assistant: <model>" label. mountModelIndicator() fetches the
       global model on mount (= editor entry refresh) and re-renders on every
       settings change (the studio2:agent-model broadcast); we also refresh it on
       visibility regain so a model changed on the OTHER user's device shows up
       without a reload. Failures stay silent (the Settings sheet owns errors). */
    modelIndicatorCtl = mountModelIndicator(modelIndicatorSlot);
    modelVisibilityHandler = () => {
      if (document.visibilityState === "visible" && modelIndicatorCtl) {
        modelIndicatorCtl.refresh();
      }
    };
    document.addEventListener("visibilitychange", modelVisibilityHandler);

    /* ---- player / export ---------------------------------------------------------- */
    playerCtl = initPlayer(ctx, playerSlot);
    exportCtl = initExport(ctx, exportSlot);

    /* ---- M3 Format picker (Preview page) + Music panel (Media page) ----------------- *
       The Format picker + per-clip fit + Music panel are PROJECT SETTINGS — they
       work on every device (even one whose render gate is closed: only the
       render-tier EXPORT is gated, arch §6.2). They write through the SAME
       store setters the agent's executors use (format-ui.js / music-ui.js →
       store/meta + music-ops), so the agent and UI never diverge. The Music
       panel needs the engine adapter (the upload probe + the store surface); an
       engineless editor shows a small unavailable note instead.
       Failures here are non-fatal: a missing format/music control must not take
       down chat or preview. */
    try {
      formatCtl = mountFormatPicker(formatSlot, ctx);
    } catch (err) {
      dlog("error", "editor.format.mount.err", { message: String(err && err.message).slice(0, 300) });
    }
    if (adapter) {
      try {
        musicCtl = mountMusicPanel(musicSlot, ctx);
      } catch (err) {
        dlog("error", "editor.music.mount.err", { message: String(err && err.message).slice(0, 300) });
      }
    }
    if (!musicCtl) {
      musicSlot.append(el("section", { class: "media-soon", "aria-label": "Sounds and music" }, [
        el("div", { class: "media-soon__head" }, [
          el("h2", { class: "media-soon__title", text: "Sounds & music" }),
          el("span", { class: "media-soon__chip", text: "Unavailable" }),
        ]),
        el("p", {
          class: "media-soon__body",
          text: "Music needs the editing engine — refresh the app to finish updating, then try again.",
        }),
      ]));
    }

    /* ---- ingest (Step 4 UI) --------------------------------------------------------- */
    if (adapter) {
      try {
        ingestCtl = adapter.mountIngest(ingestSlot, {
          project,
          caps,
          onClipAdded(info) {
            dlog("info", "editor.clip.added", { clip_id: info && info.clip_id });
            ctx.notifyEdlChange();
            refreshStrip();
          },
        });
      } catch (err) {
        dlog("error", "editor.ingest.mount.err", { message: String(err && err.message).slice(0, 300) });
      }
    }
    if (!ingestCtl) {
      ingestSlot.append(el("div", { class: "ingest-unavailable" }, [
        icon("i-alert"),
        el("span", { text: "Adding videos isn't available right now — the app didn't finish updating. Refresh and try again." }),
      ]));
    }

    /* ---- transcribe (M2) — per-clip controller for the Media page ---------------------- *
       Only when the engine adapter loaded (extractAudio lives there); an
       engineless editor simply has no Transcribe affordance (chat/preview still
       work). Gated on /api/status.transcribe; refreshes the gate on visibility
       regain so a relay coming online enables the affordance without a reload. */
    if (adapter) {
      try {
        transcribeCtl = mountTranscribe({
          project,
          caps,
          deviceId: devId,
          queue,
          findClipFile,
          engine: () => adapter,
          notifyTranscriptChange: () => ctx.notifyTranscriptChange(),
        });
      } catch (err) {
        dlog("error", "editor.transcribe.mount.err", { message: String(err && err.message).slice(0, 300) });
        transcribeCtl = null;
      }
    }
    if (transcribeCtl) {
      // Fetch the gate (configured/enabled/remaining); re-fetch on visibility
      // regain. Failures resolve to a safe disabled gate — never throws.
      const refreshGate = async () => {
        if (!transcribeCtl) return;
        try { transcribeCtl.setStatus(await transcribeStatus()); }
        catch { /* abort/teardown — ignore */ }
      };
      refreshGate();
      transcribeVisibilityHandler = () => {
        if (document.visibilityState === "visible") refreshGate();
      };
      document.addEventListener("visibilitychange", transcribeVisibilityHandler);
    }

    /* ---- bridge ---------------------------------------------------------------------- */
    const executors = buildExecutors(ctx);
    bridgeCtl = initBridge({
      project,
      executors,
      queue,
      onState(state) {
        chatCtl.setBridgeState(state);
        rootEl.dataset.bridge = state;
      },
      onServerBootChange(bootId) {
        dlog("warn", "editor.boot.changed", { boot: bootId });
        chatCtl.notifyServerBootChange();
      },
    });
    bridgeCtl.connect();

    /* ---- EDL change fan-out (strip side; the player subscribes itself) ---------------- */
    edlChangeHandler = () => { refreshStrip(); };
    edlEvents.addEventListener("change", edlChangeHandler);

    /* ---- transcript change fan-out (M2) — a transcript landed/redone/deleted --------- *
       Re-read presence and repaint the affordances (the strip nodes the
       controller owns are repainted in place; a full strip re-render also picks
       up the badge for a freshly-transcribed clip). */
    transcriptChangeHandler = () => {
      if (transcribeCtl) transcribeCtl.refresh();
    };
    edlEvents.addEventListener("transcript", transcriptChangeHandler);

    await refreshStrip();

    /* ---- lock-proof resume (M2, arch §7.1 step 7) ------------------------------------- *
       A job whose 202 landed before a reload/lock re-attaches its poll from the
       localStorage marker and runs to completion (or the honest restart copy). */
    if (transcribeCtl) {
      try { await transcribeCtl.resumePendingJob(); }
      catch (err) { dlog("warn", "editor.transcribe.resume.err", { message: String(err && err.message).slice(0, 200) }); }
    }
  } catch (err) {
    // Partial mount — unwind it (the same path destroy() runs), then rethrow
    // so app.js's enterEditor catch shows its toast and routes to projects.
    dlog("error", "editor.init.err", { message: String(err && err.message).slice(0, 300) });
    try { teardown(); } catch { /* unwind is best-effort */ }
    throw err;
  }

  dlog("info", "editor.mounted", {
    project_id: project.id, engine: !!adapter, device_id: devId,
  });

  return {
    /** True while leaving would interrupt work that must not be unmounted
        (a live ingest copy — Step 4's contract — or a running export).
        NOT queue.busy: an open ask_user card legitimately parks the queue
        for minutes, and the user must always be able to walk away. */
    busy() {
      const ingesting = !!(ingestCtl && typeof ingestCtl.isBusy === "function" && ingestCtl.isBusy());
      const exporting = !!(exportCtl && typeof exportCtl.isBusy === "function" && exportCtl.isBusy());
      return ingesting || exporting;
    },
    destroy() {
      teardown();
    },
  };
}
