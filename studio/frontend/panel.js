/* =============================================================================
   panel.js — control panel for the ACTIVE session: clip inventory, transcribe-all
   (driving the transcribe SSE progress), and the outputs list. The session topbar
   chip + a "back to sessions" affordance live here too.
   -----------------------------------------------------------------------------
   Studio is now per-user SESSIONS (no folder browsing). The active editing target
   is a session id, set by app.js after the user opens a session on the Sessions
   screen. Every data call carries `session_id`:
     GET  /api/inventory?session_id=
     POST /api/transcribe { session_id }  (+ /{job}/events?session_id= SSE)
     GET  /api/outputs?session_id=
   The folder-browser UI (roots/browse/select/mkdir) has been REMOVED along with
   the /api/fs/* endpoints. The session's absolute on-disk dir is kept here only so
   chat.js can resolve "edit/…" artifacts against it.
   Fails soft on 403/empty/404/409 with clear states.
============================================================================= */

import { api, ApiError, openEventSource, fileUrl } from "./api.js";
import {
  byId, el, icon, toast, fmtDuration, fmtBytes, basename,
} from "./util.js";

export function initPanel({ onBackToSessions, onStartEditing, status }) {
  const clipsEl     = byId("clips");
  const clipsCount  = byId("clips-count");
  const transcribeBtn = byId("transcribe-all");
  const jobMount    = byId("job-mount");
  const nextstepMount = byId("nextstep-mount");

  const outputsEl   = byId("outputs");
  const outputsRefresh = byId("outputs-refresh");
  const refreshClipsBtn = byId("clips-refresh");

  const topbarSession = byId("topbar-session-text");
  const backBtn     = byId("back-to-sessions");

  let activeSessionId = null;
  let activeDir = null;          // absolute session dir (for chat artifact resolution)
  let activeName = null;
  let transcribeES = null;
  let clipsCache = [];

  /* ---- back to sessions ------------------------------------------------ */
  if (backBtn) {
    backBtn.addEventListener("click", () => { onBackToSessions && onBackToSessions(); });
  }

  function setTopbarSession(name) {
    if (!topbarSession) return;
    topbarSession.textContent = name || "No session";
    topbarSession.title = name || "";
  }

  /* =====================================================================
     ACTIVATE A SESSION → inventory + outputs
     ---------------------------------------------------------------------
     Called by app.js once the user opens a session. `dir` is the absolute
     on-disk folder (used by chat.js for "edit/…" artifacts); we never browse.
  ===================================================================== */
  function setSession({ id, dir, name }) {
    activeSessionId = id != null ? id : null;
    activeDir = dir || null;
    activeName = name || null;
    setTopbarSession(activeName);
    hideNextStep();                          // card belongs to the previous session
    if (activeSessionId == null) {
      clipsCache = [];
      clipsCount.textContent = "0";
      clipsEl.replaceChildren(emptyRow("Open a session to see clips."));
      outputsEl.replaceChildren(emptyRow("No outputs yet."));
      transcribeBtn.disabled = true;
      notifyInventory();
      return;
    }
    loadInventory();
    loadOutputs();
  }

  function qs() {
    return "?session_id=" + encodeURIComponent(activeSessionId);
  }

  /* When a call comes back 404 session_not_found, the session was deleted out
     from under us — bounce back to the Sessions screen with a toast. Returns
     true if it handled (so callers stop). */
  function handleSessionGone(err) {
    if (err instanceof ApiError && err.code === "session_not_found") {
      toast("That session no longer exists.", "bad");
      onBackToSessions && onBackToSessions();
      return true;
    }
    return false;
  }

  /* =====================================================================
     INVENTORY
  ===================================================================== */
  if (refreshClipsBtn) refreshClipsBtn.addEventListener("click", () => loadInventory());

  /* inventory-change callback (set after construction via onInventory()) —
     feeds the journey stepper + the chat empty-state CTA in app.js. */
  let _onInventoryChanged = null;
  function notifyInventory() {
    if (!_onInventoryChanged) return;
    const count = clipsCache.length;
    const transcribedCount = clipsCache.filter((c) => c.has_transcript).length;
    _onInventoryChanged({ count, transcribedCount });
  }

  async function loadInventory() {
    if (activeSessionId == null) return;
    clipsEl.replaceChildren(skeletonClip(), skeletonClip(), skeletonClip());
    try {
      const data = await api.get("/api/inventory" + qs());
      clipsCache = data.clips || [];
      renderClips(data);
      notifyInventory();
    } catch (err) {
      if (handleSessionGone(err)) return;
      if (err instanceof ApiError && err.status === 409) {
        clipsCache = [];
        clipsCount.textContent = "0";
        clipsEl.replaceChildren(emptyRow("No clips yet — add footage above."));
        transcribeBtn.disabled = true;
        notifyInventory();
      } else if (err instanceof ApiError && err.status === 401) {
        throw err;
      } else {
        clipsEl.replaceChildren(emptyRow("Could not read clips."));
        transcribeBtn.disabled = true;
      }
    }
  }

  function renderClips(data) {
    const clips = data.clips || [];
    clipsCount.textContent = String(data.count != null ? data.count : clips.length);
    if (clips.length === 0) {
      clipsEl.replaceChildren(emptyRow("No video files yet (.mp4 .mov .mkv .avi .m4v). Add footage above."));
      transcribeBtn.disabled = true;
      return;
    }
    clipsEl.replaceChildren(...clips.map((c) =>
      el("div", { class: "clip" }, [
        el("span", { class: "clip__thumb" }, [ icon(c.portrait ? "i-image" : "i-film") ]),
        el("div", { class: "clip__body" }, [
          el("div", { class: "clip__name", text: c.name, title: c.path || c.name }),
          el("div", { class: "clip__meta" }, [
            el("span", { class: "tc", text: fmtDuration(c.duration_s) }),
            el("span", { text: "·" }),
            el("span", { text: c.width && c.height ? `${c.width}×${c.height}` : "—" }),
            el("span", { text: "·" }),
            el("span", { text: fmtBytes(c.size_bytes) }),
          ]),
        ]),
        el("span", { class: "clip__badge", dataset: { t: c.has_transcript ? "yes" : "no" },
          text: c.has_transcript ? "transcribed" : "no transcript" }),
      ])));
    const allDone = clips.every((c) => c.has_transcript);
    transcribeBtn.disabled = allDone;
    transcribeBtn.querySelector(".btn__label")?.remove();
    transcribeBtn.lastChild && (transcribeBtn.childNodes[transcribeBtn.childNodes.length - 1].textContent =
      allDone ? " All transcribed" : " Transcribe all");
  }

  /* =====================================================================
     TRANSCRIBE ALL (job + SSE progress)
  ===================================================================== */
  transcribeBtn.addEventListener("click", startTranscribe);

  async function startTranscribe() {
    if (activeSessionId == null) { toast("Open a session first.", "bad"); return; }
    transcribeBtn.disabled = true;
    let job;
    try {
      job = await api.post("/api/transcribe", { pack: true, session_id: activeSessionId });
    } catch (err) {
      if (handleSessionGone(err)) return;
      if (err instanceof ApiError && err.status === 409 && err.code === "job_in_flight") {
        // Another transcription is already running — attach to it; keep the
        // button disabled while that job is live (the SSE 'done'/'error' handlers
        // re-enable it).
        toast("A transcription is already running.", "info");
        if (err.detail && err.detail.job_id) attachJob(err.detail.job_id);
      } else if (err instanceof ApiError && err.status === 409) {
        // no clips (or any other 409) — nothing started, re-enable.
        toast("Nothing to transcribe — upload clips first.", "bad");
        transcribeBtn.disabled = false;
      } else {
        toast(err instanceof ApiError ? err.message : "Could not start transcription.", "bad");
        transcribeBtn.disabled = false;
      }
      return;
    }
    toast(
      job.already_cached
        ? `Transcribing ${Math.max(0, (job.files || 0) - (job.already_cached || 0))} of ${job.files} (rest cached).`
        : `Transcribing ${job.files} clip${job.files === 1 ? "" : "s"}.`,
      "info");
    attachJob(job.job_id, job.files || 0);
  }

  function attachJob(jobId, total) {
    const card = renderJobCard(total);
    jobMount.replaceChildren(card.node);

    if (transcribeES) { transcribeES.close(); transcribeES = null; }
    transcribeES = openEventSource(
      `/api/transcribe/${encodeURIComponent(jobId)}/events?session_id=${encodeURIComponent(activeSessionId)}`, {
      progress: (d) => card.update(d),
      file_done: (d) => card.fileDone(d),
      done: (d) => {
        card.finish(d);
        transcribeES && transcribeES.close(); transcribeES = null;
        toast(`Transcription complete — ${d.transcribed || 0} new, ${d.cached || 0} cached.`, "ok");
        setTimeout(() => { jobMount.replaceChildren(); }, 2500);
        loadInventory();
      },
      error: (d) => {
        card.error(d);
        transcribeES && transcribeES.close(); transcribeES = null;
        toast(d && d.message ? d.message : "Transcription failed.", "bad");
        transcribeBtn.disabled = false;
      },
      onError: () => {
        // EventSource auto-reconnects; if the job is gone the server closes it.
      },
    });
  }

  function renderJobCard(total) {
    const bar = el("span", { class: "progress__bar" });
    const phase = el("span", { class: "jobcard__phase", text: "starting…" });
    const node = el("div", { class: "jobcard" }, [
      el("div", { class: "jobcard__top" }, [
        icon("i-mic"),
        el("span", { text: "Transcribing" }),
        phase,
      ]),
      el("div", { class: "progress progress--indeterminate" }, [ bar ]),
    ]);
    const progress = node.querySelector(".progress");
    return {
      node,
      update(d) {
        if (d.percent != null) {
          progress.classList.remove("progress--indeterminate");
          bar.style.width = Math.max(0, Math.min(100, d.percent)) + "%";
        }
        const parts = [];
        if (d.done != null && d.total != null) parts.push(`${d.done}/${d.total}`);
        if (d.current) parts.push(basename(d.current));
        else if (d.phase) parts.push(d.phase);
        phase.textContent = parts.join(" · ") || "working…";
      },
      fileDone(d) {
        if (d && d.name) phase.textContent = `done ${basename(d.name)}`;
      },
      finish() {
        progress.classList.remove("progress--indeterminate");
        bar.style.width = "100%";
        phase.textContent = "complete";
      },
      error(d) {
        progress.classList.remove("progress--indeterminate");
        node.style.borderColor = "var(--bad)";
        phase.textContent = (d && d.code) ? d.code : "failed";
        phase.style.color = "var(--bad)";
      },
    };
  }

  /* =====================================================================
     OUTPUTS
  ===================================================================== */
  outputsRefresh.addEventListener("click", loadOutputs);

  async function loadOutputs() {
    if (activeSessionId == null) return null;
    try {
      const data = await api.get("/api/outputs" + qs());
      renderOutputs(data);
      onOutputsChanged(data);
      return data;
    } catch (err) {
      if (handleSessionGone(err)) return null;
      if (err instanceof ApiError && err.status === 409) {
        outputsEl.replaceChildren(emptyRow("No outputs yet."));
      } else if (err instanceof ApiError && err.status === 401) {
        throw err;
      } else {
        outputsEl.replaceChildren(emptyRow("No outputs yet."));
      }
      return null;
    }
  }

  /* outputs-change callback is set after construction via onOutputs(). */
  let _onOutputsChanged = null;
  function onOutputsChanged(data, action) {
    if (_onOutputsChanged) _onOutputsChanged(data, action);
  }

  /* Humanized outputs: the deliverables get plain names ("Final video",
     "Draft preview", "Subtitles (.srt)") with a per-row DOWNLOAD link
     (/api/file?…&download=1 → Content-Disposition: attachment); the developer
     artifacts (edl.json / project.md) collapse under an "Advanced" disclosure.
     The Final row is visually primary — it is the journey's ending. */
  function renderOutputs(data) {
    const rows = [];

    function downloadLink(info, label) {
      if (!info || !info.path) return null;
      return el("a", {
        class: "icon-btn output__dl",
        href: fileUrl(info.path) + "&download=1",
        download: basename(info.path) || "",
        "aria-label": "Download " + label,
        title: "Download " + label,
      }, [ icon("i-download") ]);
    }

    function openButton(label, info, iconName, kind, metaText) {
      return el("button", { class: "output", type: "button",
        dataset: { kind: kind || "", path: info.path || "" },
        onclick: () => onOutputsChanged(data, { open: kind, info }) }, [
        icon(iconName),
        el("span", { class: "name", text: label }),
        el("span", { class: "meta", text: metaText || "" }),
      ]);
    }

    function addPrimary(label, info, iconName, kind, metaText) {
      if (!info || !info.exists) return;
      rows.push(el("div", { class: "outputrow", dataset: { kind: kind || "" } }, [
        openButton(label, info, iconName, kind, metaText),
        downloadLink(info, label),
      ]));
    }

    addPrimary("Final video", data.final, "i-play", "final",
      data.final && data.final.duration_s ? fmtDuration(data.final.duration_s) : "");
    addPrimary("Draft preview", data.preview, "i-play", "preview",
      data.preview && data.preview.duration_s ? fmtDuration(data.preview.duration_s) : "");
    addPrimary("Subtitles (.srt)", data.master_srt, "i-doc", "srt",
      data.master_srt && data.master_srt.ranges != null ? `${data.master_srt.ranges} cues` : "");

    const adv = [];
    function addAdvanced(label, info, kind, fname) {
      if (!info || !info.exists) return;
      adv.push(openButton(label, info, "i-doc", kind, fname));
    }
    addAdvanced("Edit decision list", data.edl, "edl", "edl.json");
    addAdvanced("Project notes", data.project_md, "project", "project.md");
    if (adv.length) {
      rows.push(el("details", { class: "adv" }, [
        el("summary", { class: "adv__summary" }, [
          icon("i-chevron-right", "icon adv__chev"),
          el("span", { text: "Advanced" }),
        ]),
        el("div", { class: "adv__body" }, adv),
      ]));
    }

    if (rows.length === 0) rows.push(emptyRow("Nothing rendered yet — ask the editor for a cut."));
    outputsEl.replaceChildren(...rows);
  }

  /* =====================================================================
     POST-UPLOAD NEXT-STEP CARD
     ---------------------------------------------------------------------
     Shown by app.js right after a successful upload: "Transcribe the speech
     (recommended if people talk)" wires the existing startTranscribe flow;
     "Skip — start editing" hands off to the composer (app.js closes the
     drawer + focuses it). Dismissible; cleared on session switch.
  ===================================================================== */
  function showNextStep() {
    if (!nextstepMount || activeSessionId == null) return;
    const allTranscribed = clipsCache.length > 0 && clipsCache.every((c) => c.has_transcript);
    const actions = [];
    if (!allTranscribed) {
      actions.push(el("button", { class: "nextstep__action", type: "button",
        onclick: () => { hideNextStep(); startTranscribe(); } }, [
        icon("i-mic"),
        el("span", { class: "nextstep__text" }, [
          el("span", { class: "nextstep__label", text: "Transcribe the speech" }),
          el("span", { class: "nextstep__sub", text: "Recommended if people talk — enables cut-by-quote and subtitles." }),
        ]),
      ]));
    }
    actions.push(el("button", { class: "nextstep__action", type: "button",
      onclick: () => { hideNextStep(); onStartEditing && onStartEditing(); } }, [
      icon("i-send"),
      el("span", { class: "nextstep__text" }, [
        el("span", { class: "nextstep__label", text: allTranscribed ? "Start editing" : "Skip — start editing" }),
        el("span", { class: "nextstep__sub", text: "Tell the editor what to make." }),
      ]),
    ]));
    const dismiss = el("button", { class: "icon-btn nextstep__close", type: "button", "aria-label": "Dismiss" }, [ icon("i-close") ]);
    dismiss.addEventListener("click", hideNextStep);
    nextstepMount.replaceChildren(el("div", { class: "nextstep", role: "status" }, [
      el("div", { class: "nextstep__head" }, [
        icon("i-check"),
        el("span", { text: "Footage added — what’s next?" }),
        dismiss,
      ]),
      ...actions,
    ]));
  }
  function hideNextStep() {
    if (nextstepMount) nextstepMount.replaceChildren();
  }

  return {
    setSession,
    loadInventory,
    loadOutputs,
    showNextStep,
    /** Register the outputs-changed callback (preview wiring lives in app.js). */
    onOutputs(fn) { _onOutputsChanged = fn; },
    /** Register the inventory-changed callback ({count, transcribedCount}). */
    onInventory(fn) { _onInventoryChanged = fn; },
    get activeSessionId() { return activeSessionId; },
    /** Absolute on-disk session dir — chat.js joins this with "edit/…" artifacts. */
    get activeDir() { return activeDir; },
    get activeName() { return activeName; },
  };
}

/* ----- small render helpers ------------------------------------------------ */
function emptyRow(text) { return el("div", { class: "empty", text }); }
function skeletonClip() {
  return el("div", { class: "clip" }, [
    el("span", { class: "clip__thumb skeleton", style: "border:0" }),
    el("div", { class: "clip__body" }, [
      el("div", { class: "skeleton", style: "height:.9rem;width:60%;margin-bottom:.4rem" }),
      el("div", { class: "skeleton", style: "height:.7rem;width:40%" }),
    ]),
  ]);
}
