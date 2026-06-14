/* =============================================================================
   tabs.js — the bottom tab bar for the editor's three pages (M1.1).
   -----------------------------------------------------------------------------
   Born from live iPhone feedback ("I can barely see the conversation"): the
   editor is split into Media / Edit / Preview pages with a thumb-reachable,
   iOS-style bottom tab bar. This module owns ONLY navigation chrome + panel
   visibility — it never mounts or unmounts feature DOM. Panels are hidden
   with CSS visibility (`.page[data-active="false"]`), never removed, so:
     • the bridge stream, a streaming turn and an open ask_user card survive
       any amount of tab hopping,
     • the player keeps its <video>, blob URL and position,
     • an ingest copy keeps running with its progress bar live.

   A11y: WAI-ARIA tabs pattern — role=tablist/tab/tabpanel, aria-selected,
   aria-controls, roving tabindex, ArrowLeft/ArrowRight/Home/End with
   automatic activation (panels switch instantly and losslessly, so the
   automatic-activation variant is the right one). Focus stays on the tab;
   the panel follows in document order.

   Activity dot: setActivity(id, active) marks a tab as "working" (editor.js
   wires the Edit tab to chat activity = a streaming turn OR an open
   question). The dot renders only while that tab is NOT the current one —
   visiting the tab is the acknowledgement — and carries sr-only text so
   screen-reader users hear it too.

   XSS posture: labels are code-authored constants; everything lands via
   util.el's textContent path (no innerHTML anywhere).
============================================================================= */

import { el, icon } from "./util.js";

/**
 * Build the tab bar and take over panel visibility.
 *
 * @param {Object} opts
 * @param {Array}  opts.tabs     [{id, label, icon, panel}] — panel is a live
 *                               element with an `id` (becomes aria-controls);
 *                               this module sets its data-active attribute.
 * @param {string} opts.initial  tab id to activate immediately
 * @param {Function} [opts.onChange] (id) — fires on every activation
 *                               (including the initial one); used for
 *                               last-active-tab persistence.
 * @returns {{node, current, activate, setActivity, destroy}}
 */
export function createTabBar({ tabs, initial, onChange }) {
  let current = null;
  let destroyed = false;
  const items = new Map();        // id → {id, btn, dot, panel, activity}

  const list = el("div", { class: "tabbar__list", role: "tablist", "aria-label": "Editor pages" });
  const node = el("div", { class: "tabbar" }, [list]);

  for (const t of tabs) {
    const dot = el("span", { class: "tabbar__dot", hidden: true }, [
      el("span", { class: "sr-only", text: "— the editor is working" }),
    ]);
    const btn = el("button", {
      class: "tabbar__tab", type: "button",
      id: "tab-" + t.id,
      role: "tab",
      "aria-selected": "false",
      "aria-controls": t.panel.id,
      tabindex: "-1",
    }, [
      icon(t.icon),
      el("span", { class: "tabbar__label", text: t.label }),
      dot,
    ]);
    btn.addEventListener("click", () => activate(t.id));
    items.set(t.id, { id: t.id, btn, dot, panel: t.panel, activity: false });
    list.append(btn);
  }

  // Roving tabindex + arrow keys (automatic activation — switching is
  // instant and lossless, so focus-follows-activation is correct here).
  list.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const order = [...items.values()];
    const idx = order.findIndex((it) => it.btn === document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    let next;
    if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    else {
      const delta = e.key === "ArrowRight" ? 1 : -1;
      next = order[(idx + delta + order.length) % order.length];
    }
    activate(next.id, { focus: true });
  });

  /** The dot shows only on NON-current tabs — visiting acknowledges it. */
  function syncDots() {
    for (const it of items.values()) {
      it.dot.hidden = !(it.activity && it.id !== current);
    }
  }

  function activate(id, { focus } = {}) {
    if (destroyed) return;
    const target = items.get(id);
    if (!target) return;
    if (current === id) {
      if (focus) target.btn.focus();
      return;
    }
    current = id;
    for (const it of items.values()) {
      const active = it === target;
      it.btn.setAttribute("aria-selected", String(active));
      it.btn.setAttribute("tabindex", active ? "0" : "-1");
      it.panel.dataset.active = String(active);
    }
    syncDots();
    if (focus) target.btn.focus();
    try { if (typeof onChange === "function") onChange(id); } catch { /* persistence is best-effort */ }
  }

  activate(initial);

  return {
    node,
    current: () => current,
    activate,
    setActivity(id, active) {
      if (destroyed) return;
      const it = items.get(id);
      if (!it) return;
      it.activity = !!active;
      syncDots();
    },
    destroy() {
      destroyed = true;
      node.remove();
    },
  };
}
