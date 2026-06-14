/* =============================================================================
   settings.js — app-level Settings sheet + the Agent Model Picker (GLOBAL).
   -----------------------------------------------------------------------------
   The model is ONE app-wide setting shared by both users (PM plan §1: GLOBAL,
   never per-user/per-project). This module owns two surfaces:

     1. THE SETTINGS SHEET (openSettings()) — an ARIA dialog (focus-trapped,
        Escape/backdrop close, focus restored) hosting the picker: the GET
        `available` models as a single-select RADIOGROUP, the current one
        checked, each row showing label + hint. Selecting a row POSTs, reflects
        optimistically, shows the `applies_to` note, and on a 400/failure
        reverts honestly to the server's truth. Same `.sheet` design language
        as the transcribe consent/transcript dialogs (pwa/styles.css).

     2. THE CURRENT-MODEL INDICATOR (mountModelIndicator(host)) — a compact,
        always-visible "Assistant: Opus" label (Edit-tab header) fed by GET so
        the user can SEE which model is active even though the SETTING is
        app-level. It refreshes on settings change, on editor entry, and on a
        provided refresh() (visibility regain).

   COUPLING via a window event, not imports: a successful GET/POST broadcasts
   `studio2:agent-model` with the normalized payload on `window`, so every live
   indicator (and a re-opened sheet) re-renders from one source without holding
   references to each other. The last-known payload is cached on
   `window.__studio2AgentModel` so a freshly-mounted indicator paints instantly
   from cache (then verifies via its own GET) — the singleton-state rule for the
   ?v=/bare import seam (pwa/DOCUMENT.md): state lives on a window singleton,
   never module scope.

   XSS posture: textContent-only via util.el() — no innerHTML path (the v2
   invariant). Every dynamic string (label, hint, applies-to copy) lands as text.
============================================================================= */

import { byId, el, icon, toast, trapFocus } from "./util.js";
import { getAgentModel, setAgentModel, isNetworkError } from "./api.js";

/* diag shim — the never-throws window accessor (avoids a second diag instance
   across the ?v=/bare import seam, same as projects.js/editor.js). */
function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

/* The broadcast event + the last-known-payload cache live on window (the
   singleton-state rule). A payload is {current, available, appliesTo}. */
const MODEL_EVENT = "studio2:agent-model";
const CACHE_KEY = "__studio2AgentModel";

function cachePayload(payload) {
  try { window[CACHE_KEY] = payload; } catch { /* ignore */ }
}
function cachedPayload() {
  try {
    const p = window[CACHE_KEY];
    return (p && typeof p === "object" && Array.isArray(p.available)) ? p : null;
  } catch { return null; }
}
function broadcast(payload) {
  cachePayload(payload);
  try { window.dispatchEvent(new CustomEvent(MODEL_EVENT, { detail: payload })); }
  catch { /* ignore */ }
}

/* The label the indicator shows for a given current id, resolved against the
   available list. Falls back to a tidy default copy when current === "default"
   or the id isn't (yet) in the list. */
function labelFor(payload, current) {
  const id = current != null ? current : (payload && payload.current);
  if (id == null || id === "default") return "Default";
  if (payload && Array.isArray(payload.available)) {
    const hit = payload.available.find((m) => m.id === id);
    if (hit && hit.label) return hit.label;
  }
  return id;   // honest fallback — an id we don't have a label for yet
}

/* =============================================================================
   The settings sheet (singleton — one open at a time).
============================================================================= */
let sheetOpen = false;

/**
 * Open the app-level Settings sheet. Idempotent: a second call while open is a
 * no-op (the existing sheet keeps focus). The sheet fetches the model list on
 * open; selecting a model POSTs and reflects. Closing restores focus to the
 * opener (the button that called this).
 */
export function openSettings() {
  if (sheetOpen) return;
  sheetOpen = true;

  const titleId = "settings-title";
  const groupId = "settings-model-group";
  const groupLabelId = "settings-model-label";
  const noteId = "settings-applies-note";

  const closeBtn = el("button", {
    class: "icon-btn", type: "button", "aria-label": "Close settings",
  }, [icon("i-close")]);

  /* The radiogroup host — populated once the GET resolves. While loading it
     shows a spinner row; on error an honest message + Retry. */
  const groupEl = el("div", {
    class: "model-picker__group", role: "radiogroup",
    id: groupId, "aria-labelledby": groupLabelId,
  });

  const loadingEl = el("div", { class: "model-picker__loading" }, [
    el("span", { class: "spinner", role: "status", "aria-label": "Loading models" }),
    el("span", { class: "model-picker__loading-text", text: "Loading models…" }),
  ]);

  const errorEl = el("p", {
    class: "model-picker__error", role: "alert", hidden: true,
  });

  /* The applies-to note — shown after a selection lands. role=status so it's
     announced without stealing focus. */
  const noteEl = el("p", {
    class: "model-picker__note", id: noteId, role: "status", "aria-live": "polite",
    hidden: true,
  });

  const card = el("div", {
    class: "sheet__card model-picker", role: "dialog", "aria-modal": "true",
    "aria-labelledby": titleId,
  }, [
    el("div", { class: "model-picker__head" }, [
      el("div", { class: "model-picker__heading" }, [
        el("h2", { class: "sheet__title", id: titleId, text: "Settings" }),
        el("span", {
          class: "model-picker__sub", id: groupLabelId,
          text: "Assistant model — shared across the whole app",
        }),
      ]),
      closeBtn,
    ]),
    groupEl,
    loadingEl,
    errorEl,
    noteEl,
  ]);

  const overlay = el("div", { class: "sheet", dataset: { kind: "settings" } }, [card]);
  document.body.append(overlay);

  let closed = false;
  let pendingPost = false;          // a POST is in flight — lock the group
  const ac = new AbortController(); // cancels the in-flight GET/POST on close
  const releaseTrap = trapFocus(card);
  const prevFocus = document.activeElement;

  function close() {
    if (closed) return;
    closed = true;
    sheetOpen = false;
    try { ac.abort(); } catch { /* ignore */ }
    releaseTrap();
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* gone */ }
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  closeBtn.addEventListener("click", close);

  /* ---- the radio rows -------------------------------------------------------
     One <button role="radio"> per available model + a synthetic "Default" row
     always present (server may report current:"default" with no matching list
     entry, and "Default" must always be selectable to restore CLI inheritance).
     Roving tabindex + arrow-key navigation per the WAI-ARIA radiogroup pattern;
     a selection commits immediately (a picker, not a form to submit). */
  let rows = [];                    // [{id, btn}]
  let selectedId = null;            // the id reflected as checked right now

  function rowOptions(payload) {
    // "Default" first (restores CLI inheritance), then the server's list with
    // any duplicate "default" entry removed (we render our own).
    const opts = [{ id: "default", label: "Default", hint: "Follow the studio's built-in model" }];
    for (const m of payload.available) {
      if (m.id === "default") continue;
      opts.push(m);
    }
    return opts;
  }

  function reflectSelection(id) {
    selectedId = id;
    for (const r of rows) {
      const on = r.id === id;
      r.btn.setAttribute("aria-checked", on ? "true" : "false");
      // Roving tabindex: only the checked row is tabbable (arrow keys move
      // within the group); if nothing checked, the first row is tabbable.
      r.btn.tabIndex = on ? 0 : -1;
      r.btn.dataset.checked = on ? "true" : "false";
    }
    if (!rows.some((r) => r.id === id) && rows.length > 0) {
      rows[0].btn.tabIndex = 0;
    }
  }

  function focusRowByIndex(i) {
    if (rows.length === 0) return;
    const idx = ((i % rows.length) + rows.length) % rows.length;
    rows[idx].btn.tabIndex = 0;
    rows[idx].btn.focus();
  }

  function setBusy(busy) {
    pendingPost = busy;
    groupEl.setAttribute("aria-busy", busy ? "true" : "false");
    for (const r of rows) r.btn.disabled = busy;
  }

  async function choose(id) {
    if (pendingPost || closed) return;
    if (id === selectedId) return;             // already selected — nothing to do
    const prev = selectedId;
    reflectSelection(id);                       // optimistic
    setBusy(true);
    errorEl.hidden = true;
    dlog("info", "settings.model.set", { model: id });
    try {
      const payload = await setAgentModel(id, { signal: ac.signal });
      if (closed) return;
      // Reflect the server's truth (it may normalize/expand the list) and show
      // the applies-to note.
      renderRows(payload, /* keepNote */ true);
      showAppliesNote(payload, id);
      broadcast(payload);
      toast("Assistant model updated.", "ok");
    } catch (err) {
      if (err && err.name === "AbortError") return;   // sheet closed mid-POST
      if (closed) return;
      reflectSelection(prev);                  // honest revert
      const offline = isNetworkError(err);
      const msg = offline
        ? "Couldn't reach the studio — the model is unchanged."
        : (err && err.code === "invalid_model"
            ? "That model isn't available — pick another."
            : (err && err.message) || "Couldn't change the model. Try again.");
      errorEl.textContent = msg;
      errorEl.hidden = false;
      dlog("warn", "settings.model.set.err", {
        code: err && err.code, status: err && err.status,
      });
    } finally {
      if (!closed) setBusy(false);
    }
  }

  function showAppliesNote(payload, id) {
    const labelTxt = labelFor(payload, id);
    const applies = (payload && payload.appliesTo) || "new conversations";
    noteEl.textContent = id === "default"
      ? "Back to the studio's built-in model. Applies to " + applies +
        " — your next message uses it."
      : labelTxt + " — applies to " + applies + ". Your next message uses it.";
    noteEl.hidden = false;
  }

  function onRowKeydown(e) {
    const i = rows.findIndex((r) => r.btn === e.currentTarget);
    if (i === -1) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault(); focusRowByIndex(i + 1); break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault(); focusRowByIndex(i - 1); break;
      case "Home":
        e.preventDefault(); focusRowByIndex(0); break;
      case "End":
        e.preventDefault(); focusRowByIndex(rows.length - 1); break;
      case " ":
      case "Enter":
        e.preventDefault(); choose(rows[i].id); break;
      default: break;
    }
  }

  function renderRows(payload, keepNote) {
    const opts = rowOptions(payload);
    rows = opts.map((m) => {
      const btn = el("button", {
        class: "model-row", type: "button", role: "radio",
        "aria-checked": "false", tabindex: "-1",
        dataset: { model: m.id },
      }, [
        el("span", { class: "model-row__check", "aria-hidden": "true" }, [
          el("span", { class: "model-row__dot" }),
        ]),
        el("span", { class: "model-row__text" }, [
          el("span", { class: "model-row__label", text: m.label }),
          m.hint ? el("span", { class: "model-row__hint", text: m.hint }) : null,
        ]),
      ]);
      btn.addEventListener("click", () => choose(m.id));
      btn.addEventListener("keydown", onRowKeydown);
      return { id: m.id, btn };
    });
    groupEl.replaceChildren(...rows.map((r) => r.btn));
    reflectSelection(payload.current);
    if (!keepNote) noteEl.hidden = true;
  }

  let retryBtn = null;
  function showLoadError(offline) {
    loadingEl.hidden = true;
    errorEl.hidden = true;
    groupEl.replaceChildren();
    rows = [];
    const wrap = el("div", { class: "model-picker__failed", role: "alert" }, [
      el("p", {
        class: "model-picker__failed-text",
        text: offline
          ? "Can't reach the studio brain — connect to your home network to change the model."
          : "Couldn't load the model list. Try again.",
      }),
    ]);
    retryBtn = el("button", { class: "btn btn--sm", type: "button" }, [
      icon("i-refresh"), el("span", { text: "Retry" }),
    ]);
    retryBtn.addEventListener("click", () => { load(); });
    wrap.append(retryBtn);
    groupEl.append(wrap);
  }

  async function load() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    noteEl.hidden = true;
    groupEl.replaceChildren();
    rows = [];
    try {
      const payload = await getAgentModel({ signal: ac.signal });
      if (closed) return;
      loadingEl.hidden = true;
      renderRows(payload, false);
      cachePayload(payload);
      // Land focus on the currently-selected row so keyboard users start there.
      requestAnimationFrame(() => {
        const sel = rows.find((r) => r.id === selectedId) || rows[0];
        if (sel) sel.btn.focus();
      });
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (closed) return;
      loadingEl.hidden = true;
      showLoadError(isNetworkError(err));
      requestAnimationFrame(() => { if (retryBtn) retryBtn.focus(); });
      dlog("warn", "settings.model.load.err", {
        code: err && err.code, status: err && err.status,
      });
    }
  }

  // Paint instantly from cache if we have one (then the GET verifies/replaces).
  const cached = cachedPayload();
  if (cached) {
    loadingEl.hidden = true;
    renderRows(cached, false);
  }
  load();

  // If the cache painted rows, focus the close button until the GET lands so
  // there is always a sensible initial focus target inside the trap.
  requestAnimationFrame(() => {
    if (!closed && document.activeElement === document.body) closeBtn.focus();
  });

  return { close };
}

/* =============================================================================
   The current-model indicator — a compact "Assistant: Opus" label.
   -----------------------------------------------------------------------------
   mountModelIndicator(host) appends a node into `host` and returns a controller
   with { node, refresh(), destroy() }. It paints from the window cache instantly
   (if any), fetches GET to verify, and re-renders on every `studio2:agent-model`
   broadcast. refresh() re-fetches (editor entry / visibility regain). On a
   failed GET with no cache it stays quietly hidden — an indicator is never a
   place to surface an error (the sheet owns that).
============================================================================= */
export function mountModelIndicator(host) {
  if (!host) return { node: null, refresh() {}, destroy() {} };

  const labelEl = el("span", { class: "model-indicator__model" });
  const node = el("span", {
    class: "model-indicator", hidden: true,
    title: "The assistant model — change it in Settings",
  }, [
    el("span", { class: "model-indicator__eyebrow", "aria-hidden": "true", text: "Assistant" }),
    labelEl,
  ]);
  host.append(node);

  let destroyed = false;
  const ac = new AbortController();

  function paint(payload, current) {
    if (destroyed || !payload) return;
    const txt = labelFor(payload, current);
    labelEl.textContent = txt;
    // The accessible name carries the full phrasing; the eyebrow is decorative.
    node.setAttribute("aria-label", "Assistant model: " + txt);
    node.hidden = false;
  }

  function onBroadcast(e) {
    const p = e && e.detail;
    if (p && Array.isArray(p.available)) paint(p, p.current);
  }
  window.addEventListener(MODEL_EVENT, onBroadcast);

  async function refresh() {
    if (destroyed) return;
    try {
      const payload = await getAgentModel({ signal: ac.signal });
      if (destroyed) return;
      cachePayload(payload);
      paint(payload, payload.current);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      // Stay silent on failure: keep whatever we last painted (cache), or stay
      // hidden if we never had anything. The Settings sheet is where errors live.
    }
  }

  // Instant paint from cache, then verify.
  const cached = cachedPayload();
  if (cached) paint(cached, cached.current);
  refresh();

  return {
    node,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { ac.abort(); } catch { /* ignore */ }
      window.removeEventListener(MODEL_EVENT, onBroadcast);
      node.remove();
    },
  };
}

/* =============================================================================
   wireSettingsButton(buttonEl) — attach openSettings() to a gear button.
   A tiny convenience so app.js can wire the projects-header gear and the editor
   topbar gear identically. Returns a teardown that removes the listener.
============================================================================= */
export function wireSettingsButton(buttonEl) {
  if (!buttonEl) return () => {};
  const onClick = () => openSettings();
  buttonEl.addEventListener("click", onClick);
  return () => buttonEl.removeEventListener("click", onClick);
}
