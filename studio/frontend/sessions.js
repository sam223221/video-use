/* =============================================================================
   sessions.js — the Sessions screen + the post-login stale-cleanup modal.
   -----------------------------------------------------------------------------
   Studio is per-user, user-owned, upload-only SESSIONS. A session is a project
   the signed-in user creates, owns, uploads videos into, and edits. This module
   owns the screen the user lands on after login:

     • a grid of MY session cards (name · "touched {age}" · media_count · stale badge)
     • a "New session" control (name → createSession → openSession → dashboard)
     • Open  (openSession → store {id, dir} → dashboard)
     • Delete (confirm dialog → deleteSession → refresh)
     • an empty state when the user has no sessions yet
     • a STALE-CLEANUP modal that pops right after login (and on authenticated
       app load) listing sessions idle past the threshold, with per-session
       Keep / Delete. Dismissible. Non-stale users go straight to the list.

   SECURITY: session names are user-supplied — EVERY name is inserted via
   textContent only (el(..,{text}) / .textContent), never innerHTML. The backend
   scopes all calls to the cookie's user, so a user only ever sees/acts on their
   own sessions.

   Contract (see api.js): listSessions/createSession/openSession/keepSession/
   deleteSession. openSession returns the absolute `dir` used downstream to
   resolve chat "edit/…" artifacts.
============================================================================= */

import {
  listSessions, createSession, openSession, keepSession, deleteSession, ApiError,
} from "./api.js";
import { byId, el, icon, toast, focusFirst, trapFocus } from "./util.js";

/* Human "touched …" label from an integer age in days. Defensive against
   missing / non-numeric values (renders a neutral "recently"). */
function touchedLabel(ageDays) {
  if (ageDays == null || isNaN(ageDays)) return "touched recently";
  const d = Math.max(0, Math.round(ageDays));
  if (d === 0) return "touched today";
  if (d === 1) return "touched yesterday";
  return `touched ${d}d ago`;
}

function mediaLabel(count) {
  const n = count == null || isNaN(count) ? 0 : Math.max(0, Math.round(count));
  return `${n} clip${n === 1 ? "" : "s"}`;
}

/* "How it works" onboarding card — three lines, dismissible once, persisted in
   localStorage (guarded: private-mode/storage-denied just shows it again). */
const HOWIT_KEY = "studio.howItWorks.dismissed";
function howItWorksDismissed() {
  try { return localStorage.getItem(HOWIT_KEY) === "1"; } catch { return false; }
}
function persistHowItWorksDismissed() {
  try { localStorage.setItem(HOWIT_KEY, "1"); } catch { /* ignore */ }
}

export function initSessions({ onOpen }) {
  const view = byId("view-sessions");
  const listEl = byId("sessions-list");
  const usernameEl = byId("sessions-username");
  const nameInput = byId("session-name");
  const createBtn = byId("session-create");
  const refreshBtn = byId("sessions-refresh");

  /* Confirm + stale modal scaffolding (created lazily, reused). */
  const confirmHost = byId("session-confirm");
  const staleHost = byId("stale-modal");

  let busy = false;          // a create/open is in flight (debounce the controls)
  let lastFocusBeforeModal = null;

  /* ---- create ---------------------------------------------------------- */
  createBtn.addEventListener("click", () => doCreate());
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doCreate(); }
  });

  async function doCreate() {
    if (busy) return;
    const name = nameInput.value.trim();
    if (!name) {
      toast("Give your session a name first.", "bad");
      nameInput.focus();
      return;
    }
    setBusy(true);
    try {
      const created = await createSession(name);
      nameInput.value = "";
      // Created → immediately open it so the user lands in the editor.
      // `internal: true` bypasses openAndEnter's `busy` guard (doCreate already
      // owns busy) and tells it NOT to toggle busy itself — doCreate's finally
      // is the single owner, so busy is always reset exactly once even on error.
      await openAndEnter(created.id, created.name, true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_name") {
        toast(err.message || "That name is taken or not allowed. Try another.", "bad");
        nameInput.focus();
        nameInput.select && nameInput.select();
      } else if (err instanceof ApiError && err.status === 401) {
        throw err;
      } else {
        toast(err instanceof ApiError ? err.message : "Could not create the session.", "bad");
      }
    } finally {
      setBusy(false);
    }
  }

  /* ---- open ------------------------------------------------------------ */
  /* `internal` = called from doCreate, which already owns the busy state.
     User-facing entry points (Open buttons) call openAndEnter(id, name) with
     no flag → the `busy` guard debounces double-clicks and openAndEnter owns
     busy via its own finally. doCreate calls openAndEnter(id, name, true) →
     guard bypassed, busy NOT toggled here (doCreate's finally is the sole
     owner), so the create→open chain can't self-collide and busy is always
     reset exactly once. */
  async function openAndEnter(id, name, internal = false) {
    if (!internal) {
      if (busy) return;
      setBusy(true);
    }
    try {
      const opened = await openSession(id);
      // Hand the active session up to app.js: {id, dir, name}. `dir` is the
      // absolute on-disk folder chat.js needs to resolve "edit/…" artifacts.
      onOpen && onOpen({
        id: opened.id != null ? opened.id : id,
        dir: opened.dir || "",
        name: opened.name || name || "",
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "session_not_found") {
        // It was deleted out from under us (e.g. another tab) — drop it and refresh.
        toast("That session no longer exists.", "bad");
        await load();
      } else if (err instanceof ApiError && err.status === 401) {
        throw err;
      } else {
        toast(err instanceof ApiError ? err.message : "Could not open the session.", "bad");
        // From the create flow the session WAS made on disk; if the open step
        // failed we stay on the list, so refresh it to show the new session
        // (the user can retry Open from its card).
        if (internal) await load();
      }
    } finally {
      if (!internal) setBusy(false);
    }
  }

  function setBusy(on) {
    busy = on;
    createBtn.disabled = on;
    nameInput.disabled = on;
  }

  /* ---- "How it works" onboarding card ----------------------------------- */
  function renderHowItWorks() {
    const mount = byId("howitworks-mount");
    if (!mount) return;
    if (howItWorksDismissed()) { mount.replaceChildren(); return; }
    if (mount.childElementCount > 0) return;   // already rendered this visit
    const close = el("button", { class: "icon-btn howit__close", type: "button",
      "aria-label": "Dismiss how it works" }, [ icon("i-close") ]);
    close.addEventListener("click", () => {
      persistHowItWorksDismissed();
      mount.replaceChildren();
    });
    mount.replaceChildren(el("aside", { class: "howit", "aria-label": "How Studio works" }, [
      el("div", { class: "howit__head" }, [
        el("h2", { class: "howit__title", text: "How it works" }),
        close,
      ]),
      el("ol", { class: "howit__steps" }, [
        el("li", {}, [ el("b", { text: "Create a project" }), " — each session is its own edit." ]),
        el("li", {}, [ el("b", { text: "Add footage" }), " — upload clips straight from this device." ]),
        el("li", {}, [ el("b", { text: "Chat to edit" }), " — you get a finished video to download." ]),
      ]),
    ]));
  }

  /* ---- load + render the list ------------------------------------------ */
  refreshBtn.addEventListener("click", () => { renderLoading(); load(); });

  function renderLoading() {
    listEl.replaceChildren(skeletonCard(), skeletonCard(), skeletonCard());
  }

  /* Returns the raw list payload so callers (the stale-modal flow) can reuse it. */
  async function load() {
    try {
      const data = await listSessions();
      renderList(data);
      return data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      listEl.replaceChildren(el("div", { class: "empty" }, [
        "Couldn’t load your sessions. ",
        el("button", { class: "linklike", type: "button", text: "Try again",
          onclick: () => { renderLoading(); load(); } }),
      ]));
      return null;
    }
  }

  function renderList(data) {
    const sessions = (data && Array.isArray(data.sessions)) ? data.sessions : [];
    if (sessions.length === 0) {
      listEl.replaceChildren(el("div", { class: "sessions-empty" }, [
        el("span", { class: "sessions-empty__mark", "aria-hidden": "true" }, [ icon("i-folder-plus") ]),
        el("h3", { text: "No sessions yet" }),
        el("p", { text: "Create one above to start uploading footage and editing by conversation." }),
      ]));
      return;
    }
    listEl.replaceChildren(...sessions.map((s) => sessionCard(s)));
  }

  /* A single session card. `name` is user-supplied → textContent only. */
  function sessionCard(s) {
    const id = s.id;
    const name = typeof s.name === "string" ? s.name : "Untitled session";

    const title = el("h3", { class: "scard__name", title: name });
    title.textContent = name;                 // explicit: XSS guard on user name

    const badges = el("div", { class: "scard__badges" });
    if (s.stale) {
      badges.append(el("span", { class: "scard__stale", text: "Stale" }));
    }

    const openBtn = el("button", {
      class: "btn btn--primary btn--sm scard__open", type: "button",
      onclick: () => openAndEnter(id, name),
    }, [ icon("i-play"), el("span", { text: "Open" }) ]);

    const delBtn = el("button", {
      class: "icon-btn scard__del", type: "button",
      "aria-label": "Delete session " + name,
      onclick: () => confirmDelete(id, name),
    }, [ icon("i-trash") ]);

    const card = el("article", { class: "scard", dataset: { stale: String(!!s.stale) } }, [
      el("div", { class: "scard__top" }, [ title, badges ]),
      el("div", { class: "scard__meta" }, [
        el("span", { class: "scard__media" }, [ icon("i-film"), el("span", { text: mediaLabel(s.media_count) }) ]),
        el("span", { class: "scard__dot", "aria-hidden": "true", text: "·" }),
        el("span", { class: "scard__touched", text: touchedLabel(s.age_days) }),
      ]),
      el("div", { class: "scard__actions" }, [ openBtn, delBtn ]),
    ]);
    return card;
  }

  /* =====================================================================
     CONFIRM DIALOG (delete) — accessible, focus-trapped, ESC/overlay close
  ===================================================================== */
  function confirmDelete(id, name) {
    openConfirm({
      title: "Delete this session?",
      body: el("p", { class: "confirm__body" }, [
        "“", el("b", { text: name }), "” and everything uploaded into it will be permanently removed. This can’t be undone.",
      ]),
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async (close) => {
        try {
          await deleteSession(id);
          close();
          toast("Session deleted.", "ok");
          await load();
        } catch (err) {
          if (err instanceof ApiError && err.code === "session_not_found") {
            close();
            await load();                  // already gone — just refresh
            return;
          }
          if (err instanceof ApiError && err.status === 401) { close(); throw err; }
          toast(err instanceof ApiError ? err.message : "Could not delete the session.", "bad");
        }
      },
    });
  }

  let confirmReleaseTrap = null;
  let confirmLastFocus = null;
  function openConfirm({ title, body, confirmLabel, danger, onConfirm, onCancel }) {
    confirmLastFocus = document.activeElement;
    // True once the user commits via the OK button — lets `close()` tell a
    // genuine dismissal (Cancel / ESC / overlay) from a confirm-driven close, so
    // `onCancel` (e.g. restore a row's controls) fires ONLY on dismissal.
    let confirmed = false;

    const cancelBtn = el("button", { class: "btn btn--sm", type: "button", text: "Cancel" });
    const okBtn = el("button", {
      class: "btn btn--sm " + (danger ? "btn--danger" : "btn--primary"),
      type: "button", text: confirmLabel || "Confirm",
    });

    const dialog = el("div", { class: "confirm__dialog", role: "alertdialog", "aria-modal": "true",
      "aria-label": title }, [
      el("h2", { class: "confirm__title", text: title }),
      body,
      el("div", { class: "confirm__actions" }, [ cancelBtn, okBtn ]),
    ]);

    const close = () => {
      confirmHost.dataset.open = "false";
      confirmHost.hidden = true;
      confirmHost.replaceChildren();
      confirmHost.removeEventListener("click", onOverlay);
      if (confirmReleaseTrap) { confirmReleaseTrap(); confirmReleaseTrap = null; }
      document.removeEventListener("keydown", onKey);
      if (confirmLastFocus && document.contains(confirmLastFocus)) {
        try { confirmLastFocus.focus(); } catch { /* ignore */ }
      }
      // Dismissed without committing → let the caller undo any pre-confirm state.
      if (!confirmed && typeof onCancel === "function") onCancel();
    };
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    }
    // Backdrop click closes (only when the host itself, not a child, is the
    // target). NOT `{once:true}` — a click inside the dialog must not consume it.
    function onOverlay(e) { if (e.target === confirmHost) close(); }

    cancelBtn.addEventListener("click", close);
    okBtn.addEventListener("click", () => { confirmed = true; onConfirm(close); });

    confirmHost.replaceChildren(dialog);
    confirmHost.hidden = false;
    confirmHost.dataset.open = "true";
    confirmHost.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
    confirmReleaseTrap = trapFocus(dialog);
    okBtn.focus();
  }

  /* =====================================================================
     STALE-CLEANUP MODAL (post-login)
     ---------------------------------------------------------------------
     Pops over the sessions list right after login (and on authenticated app
     load) IF the user has stale sessions. Per-session Keep / Delete. The list
     mutates in place as the user acts; when none remain the modal closes.
     Always dismissible — the user can keep them all by closing.
  ===================================================================== */
  let staleReleaseTrap = null;

  function openStaleModal(staleSessions) {
    if (!Array.isArray(staleSessions) || staleSessions.length === 0) return;
    lastFocusBeforeModal = document.activeElement;

    const intro = el("p", { class: "stale__intro" }, [
      "These sessions haven’t been touched in a while. Keep the ones you still need; delete the rest to tidy up.",
    ]);
    const rowsWrap = el("div", { class: "stale__rows" });
    const remaining = new Map();   // id -> row node

    const closeBtn = el("button", { class: "icon-btn stale__close", type: "button", "aria-label": "Dismiss" }, [ icon("i-close") ]);
    const doneBtn = el("button", { class: "btn btn--primary btn--sm", type: "button", text: "Done" });

    const dialog = el("div", { class: "stale__dialog", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "stale-title" }, [
      el("div", { class: "stale__head" }, [
        el("h2", { id: "stale-title", class: "stale__title", text: "Tidy up stale sessions" }),
        closeBtn,
      ]),
      intro,
      rowsWrap,
      el("div", { class: "stale__foot" }, [ doneBtn ]),
    ]);

    const close = () => {
      staleHost.dataset.open = "false";
      staleHost.hidden = true;
      staleHost.replaceChildren();
      staleHost.removeEventListener("click", onOverlay);
      if (staleReleaseTrap) { staleReleaseTrap(); staleReleaseTrap = null; }
      document.removeEventListener("keydown", onKey);
      if (lastFocusBeforeModal && document.contains(lastFocusBeforeModal)) {
        try { lastFocusBeforeModal.focus(); } catch { /* ignore */ }
      }
    };
    function onKey(e) {
      // The delete-confirm dialog stacks ABOVE this modal and has its own ESC
      // handler; while it's open ESC must dismiss only it, not this modal too.
      if (confirmHost && confirmHost.dataset.open === "true") return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
    }
    function onOverlay(e) { if (e.target === staleHost) close(); }

    function makeRow(s) {
      const name = typeof s.name === "string" ? s.name : "Untitled session";
      const nameEl = el("span", { class: "stale-row__name", title: name });
      nameEl.textContent = name;            // XSS guard on user name

      const keepBtn = el("button", { class: "btn btn--sm stale-row__keep", type: "button" }, [
        icon("i-check"), el("span", { text: "Keep" }),
      ]);
      const delBtn = el("button", { class: "btn btn--sm btn--danger stale-row__del", type: "button" }, [
        icon("i-trash"), el("span", { text: "Delete" }),
      ]);

      const setRowBusy = (on) => { keepBtn.disabled = on; delBtn.disabled = on; };

      keepBtn.addEventListener("click", async () => {
        setRowBusy(true);
        try {
          await keepSession(s.id);
          dropRow(s.id);
          toast("Kept “" + name + "”.", "ok");
        } catch (err) {
          if (err instanceof ApiError && err.code === "session_not_found") { dropRow(s.id); return; }
          setRowBusy(false);
          toast(err instanceof ApiError ? err.message : "Could not keep the session.", "bad");
        }
      });
      // Delete is PERMANENT (rmtree of the session's videos + edits). Match the
      // session-card flow: confirm first via the shared confirm dialog (which
      // renders above this modal — .confirm z-130 > .stale z-125). The actual
      // delete runs only on confirm; cancelling restores the row controls.
      delBtn.addEventListener("click", () => {
        setRowBusy(true);
        openConfirm({
          title: "Delete this session?",
          body: el("p", { class: "confirm__body" }, [
            "“", el("b", { text: name }), "” and everything uploaded into it will be permanently removed. This can’t be undone.",
          ]),
          confirmLabel: "Delete",
          danger: true,
          onCancel: () => { setRowBusy(false); },
          onConfirm: async (close) => {
            try {
              await deleteSession(s.id);
              close();
              dropRow(s.id);
              toast("Deleted “" + name + "”.", "ok");
            } catch (err) {
              if (err instanceof ApiError && err.code === "session_not_found") {
                close();
                dropRow(s.id);
                return;
              }
              if (err instanceof ApiError && err.status === 401) { close(); setRowBusy(false); throw err; }
              setRowBusy(false);
              toast(err instanceof ApiError ? err.message : "Could not delete the session.", "bad");
            }
          },
        });
      });

      const row = el("div", { class: "stale-row" }, [
        el("div", { class: "stale-row__info" }, [
          nameEl,
          el("span", { class: "stale-row__meta", text: touchedLabel(s.age_days) + " · " + mediaLabel(s.media_count) }),
        ]),
        el("div", { class: "stale-row__actions" }, [ keepBtn, delBtn ]),
      ]);
      return row;
    }

    function dropRow(id) {
      const row = remaining.get(id);
      if (row) { row.remove(); remaining.delete(id); }
      if (remaining.size === 0) { close(); }
      load();   // keep the underlying list fresh as we act
    }

    for (const s of staleSessions) {
      const row = makeRow(s);
      remaining.set(s.id, row);
      rowsWrap.append(row);
    }

    closeBtn.addEventListener("click", close);
    doneBtn.addEventListener("click", close);

    staleHost.replaceChildren(dialog);
    staleHost.hidden = false;
    staleHost.dataset.open = "true";
    staleHost.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
    staleReleaseTrap = trapFocus(dialog);
    focusFirst(dialog);
  }

  /* =====================================================================
     ENTRY POINT — called by app.js when showing the sessions screen.
     Loads the list, and if any session is stale, pops the cleanup modal
     OVER it. `me` carries the username (topbar) + a stale-count hint.
  ===================================================================== */
  async function show(me) {
    if (usernameEl) {
      usernameEl.textContent = (me && me.username) ? me.username : "";
      usernameEl.hidden = !(me && me.username);
    }
    renderHowItWorks();
    renderLoading();
    const data = await load();
    // The authoritative stale set comes from the list payload's `stale` ids
    // (resolved against the full session objects so the modal can show name/meta).
    if (data && Array.isArray(data.sessions)) {
      const staleIds = Array.isArray(data.stale) ? new Set(data.stale.map(String)) : null;
      const staleSessions = data.sessions.filter((s) =>
        staleIds ? staleIds.has(String(s.id)) : !!s.stale);
      if (staleSessions.length) openStaleModal(staleSessions);
    }
  }

  return {
    show,
    refresh: () => { renderLoading(); return load(); },
  };
}

/* ----- render helpers ------------------------------------------------------ */
function skeletonCard() {
  return el("article", { class: "scard scard--skeleton" }, [
    el("div", { class: "scard__top" }, [
      el("div", { class: "skeleton", style: "height:1.1rem;width:55%;border-radius:6px" }),
    ]),
    el("div", { class: "scard__meta" }, [
      el("div", { class: "skeleton", style: "height:0.7rem;width:40%;border-radius:6px" }),
    ]),
    el("div", { class: "scard__actions" }, [
      el("div", { class: "skeleton", style: "height:2.1rem;width:6rem;border-radius:10px" }),
    ]),
  ]);
}
