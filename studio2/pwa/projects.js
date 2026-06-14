/* =============================================================================
   projects.js — the project-list view (arch §1.3, §5.1).
   -----------------------------------------------------------------------------
   Projects live ENTIRELY in this device's OPFS — listing, creating and
   deleting need no server and therefore work offline by construction
   (arch §7.5). This view renders:
     • the create row (name optional — store/meta.js supplies a dated default)
     • the project cards (open / two-step delete-confirm)
     • the storage line (quota usage via storage.estimate(), persist state)
     • the collapsed "Device capabilities" matrix (capability.js rows)

   navigator.storage.persist() is requested ONCE — when the user creates
   their FIRST project (arch §5.1) — and the outcome is journaled to diag.

   XSS posture: every dynamic string (project names, ids, quota text) lands
   via textContent / util.el's `text:`. There is no innerHTML path.
============================================================================= */

import { byId, el, icon, toast, fmtBytes, fmtDate, trapFocus } from "./util.js";
import { capRows } from "./capability.js";
import {
  createProject, listProjects, deleteProject, touchProject,
} from "./store/meta.js";
import { storageEstimate, requestPersist } from "./store/opfs.js";

/* diag shim — same never-throws global accessor pattern as v1 (avoids a
   second diag module instance across the ?v=/bare import seam). */
function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

export function initProjects({ caps, onOpen }) {
  const listEl = byId("projects-list");
  const emptyEl = byId("projects-empty");
  const nameEl = byId("project-name");
  const createBtn = byId("project-create");
  const quotaTextEl = byId("quota-text");
  const quotaBarEl = byId("quota-bar");
  const quotaFillEl = byId("quota-fill");
  const persistNoteEl = byId("persist-note");
  const capsBody = byId("caps-rows");
  const confirmRoot = byId("confirm");

  let projects = [];
  let busy = false;

  /* ---- storage line ---------------------------------------------------------- */

  async function renderQuota() {
    const est = await storageEstimate();
    if (est.quota == null) {
      quotaTextEl.textContent = "Storage: size unknown on this browser";
      quotaBarEl.hidden = true;
      return;
    }
    const used = est.usage || 0;
    const frac = est.quota > 0 ? used / est.quota : 0;
    quotaTextEl.textContent =
      fmtBytes(used) + " used · " + fmtBytes(est.available) + " free of " + fmtBytes(est.quota);
    quotaBarEl.hidden = false;
    quotaFillEl.style.width = Math.min(100, Math.max(0.5, frac * 100)).toFixed(1) + "%";
    quotaBarEl.dataset.state = frac > 0.85 ? "warn" : "ok";
    quotaBarEl.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
  }

  async function renderPersistNote() {
    try {
      const persisted = navigator.storage && navigator.storage.persisted
        ? await navigator.storage.persisted()
        : null;
      if (persisted === true || persisted === null) { persistNoteEl.hidden = true; return; }
      persistNoteEl.hidden = projects.length === 0;   // only worth saying once data exists
    } catch { persistNoteEl.hidden = true; }
  }

  /* ---- capability matrix ------------------------------------------------------ */

  function renderCaps() {
    if (!capsBody) return;
    capsBody.replaceChildren();
    for (const row of capRows(caps, fmtBytes)) {
      capsBody.append(el("div", { class: "caprow", dataset: { state: row.state } }, [
        el("dt", { class: "caprow__label", text: row.label }),
        el("dd", { class: "caprow__value", text: row.value }),
      ]));
    }
  }

  /* ---- delete confirm (two-step: card button → modal confirm) ----------------- */

  function confirmDelete(project) {
    return new Promise((resolve) => {
      confirmRoot.replaceChildren();
      const title = el("h2", { class: "confirm__title", id: "confirm-title", text: "Delete this project?" });
      const body = el("p", { class: "confirm__body" }, [
        el("strong", { text: project.name }),
        " and every video, edit and export inside it will be permanently removed from this device. This cannot be undone.",
      ]);
      let done = false;
      const finish = (answer) => {
        if (done) return;
        done = true;
        untrap();
        confirmRoot.dataset.open = "false";
        confirmRoot.hidden = true;
        document.removeEventListener("keydown", onKey);
        confirmRoot.removeEventListener("click", onBackdrop);
        resolve(answer);
      };
      const cancelBtn = el("button", {
        class: "btn", type: "button", text: "Keep it",
        onclick: () => finish(false),
      });
      const deleteBtn = el("button", {
        class: "btn btn--danger", type: "button",
        onclick: () => finish(true),
      }, [icon("i-trash"), el("span", { text: "Delete forever" })]);
      const card = el("div", {
        class: "confirm__card", role: "alertdialog", "aria-modal": "true",
        "aria-labelledby": "confirm-title",
      }, [title, body, el("div", { class: "confirm__row" }, [cancelBtn, deleteBtn])]);
      const onKey = (e) => { if (e.key === "Escape") finish(false); };
      const onBackdrop = (e) => { if (e.target === confirmRoot) finish(false); };
      document.addEventListener("keydown", onKey);
      confirmRoot.addEventListener("click", onBackdrop);
      confirmRoot.append(card);
      confirmRoot.hidden = false;
      confirmRoot.dataset.open = "true";
      const untrap = trapFocus(card);
      // Land focus on the SAFE action.
      cancelBtn.focus();
    });
  }

  /* ---- list ------------------------------------------------------------------- */

  function projectCard(p) {
    const meta = el("span", { class: "project-card__meta mono" }, [
      (p.clipCount === 1 ? "1 clip" : p.clipCount + " clips"),
      p.created_at ? " · " + fmtDate(p.created_at) : "",
    ]);
    const openBtn = el("button", {
      class: "project-card__open", type: "button",
      "aria-label": "Open project " + p.name,
      onclick: () => openProject(p),
    }, [
      el("span", { class: "project-card__name", text: p.name }),
      meta,
    ]);
    const delBtn = el("button", {
      class: "icon-btn project-card__delete", type: "button",
      "aria-label": "Delete project " + p.name,
      onclick: async (e) => {
        e.stopPropagation();
        const yes = await confirmDelete(p);
        if (!yes) return;
        try {
          await deleteProject(p.id);
          dlog("info", "prj.delete", { project_id: p.id });
          toast("Project deleted.", "info");
        } catch (err) {
          dlog("error", "prj.delete.err", { project_id: p.id, message: String(err && err.message).slice(0, 200) });
          toast("Couldn't delete that project. Try again.", "bad");
        }
        await refresh();
      },
    }, [icon("i-trash")]);
    return el("article", { class: "project-card", dataset: { broken: String(!!p.broken) } }, [
      openBtn, delBtn,
    ]);
  }

  async function refresh() {
    try {
      projects = await listProjects();
    } catch (err) {
      dlog("error", "prj.list.err", { message: String(err && err.message).slice(0, 200) });
      projects = [];
    }
    listEl.replaceChildren(...projects.map(projectCard));
    emptyEl.hidden = projects.length > 0;
    await renderQuota();
    await renderPersistNote();
  }

  /* ---- open / create ----------------------------------------------------------- */

  async function openProject(p) {
    if (p.broken) {
      toast("This project's records are damaged — you can delete it, but it can't open.", "bad");
      return;
    }
    await touchProject(p.id);    // best-effort; never blocks the open
    dlog("info", "prj.open", { project_id: p.id });
    onOpen && onOpen({ id: p.id, name: p.name });
  }

  async function create() {
    if (busy) return;
    busy = true;
    createBtn.disabled = true;
    try {
      const firstEver = projects.length === 0;
      const meta = await createProject(nameEl.value);
      nameEl.value = "";
      dlog("info", "prj.create", { project_id: meta.id, name_len: meta.name.length });
      if (firstEver) {
        // First project on this device → ask the browser to protect the
        // origin's storage from automatic eviction (arch §5.1).
        const granted = await requestPersist();
        dlog("info", "prj.persist", { granted });
        if (granted === false) {
          toast("Heads up: this browser may clear Studio's storage if the device runs low. Keep exports saved to Photos.", "info", 7000);
        }
      }
      toast("Project created.", "ok");
      await refresh();
      // Straight into the new project — one less tap on the phone.
      onOpen && onOpen({ id: meta.id, name: meta.name });
    } catch (err) {
      dlog("error", "prj.create.err", { message: String(err && err.message).slice(0, 200) });
      toast("Couldn't create the project — storage may be unavailable.", "bad");
    } finally {
      busy = false;
      createBtn.disabled = false;
    }
  }

  createBtn.addEventListener("click", create);
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); create(); }
  });
  renderCaps();

  /** (Re)enter the view: reload the list + storage numbers. */
  async function show() {
    await refresh();
  }

  return { show, refresh };
}
