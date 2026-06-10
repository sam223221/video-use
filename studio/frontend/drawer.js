/* =============================================================================
   drawer.js — responsive chrome: the slide-in control-panel drawer (phone) and
   the bottom-sheet preview (phone/tablet), plus the docking logic that relocates
   the live <aside class="panel"> / <aside class="preview"> between their docked
   grid position and the drawer/sheet mount points as the viewport changes.
   -----------------------------------------------------------------------------
   We keep ONE live instance of each pane (so video state, listeners, and DOM
   stay intact) and physically move it with appendChild — never clone.
   Drawers are focus-trapped, ESC/overlay-closable, aria-modal, scroll-locked.
============================================================================= */

import { byId, trapFocus, focusFirst, layoutMode, debounce, prefersReducedMotion } from "./util.js";

export function initChrome() {
  const panel   = byId("panel");
  const preview = byId("preview");
  const dash    = document.querySelector(".dash");

  const drawer      = byId("drawer");
  const drawerMount = byId("drawer-mount");
  const sheet       = byId("sheet");
  const sheetMount  = byId("sheet-mount");
  const scrim       = byId("scrim");

  const drawerOpenBtn  = byId("drawer-open");
  const drawerCloseBtn = byId("drawer-close");
  const sheetOpenBtn   = byId("sheet-open");
  const sheetCloseBtn  = byId("sheet-close");

  let drawerReleaseTrap = null;
  let sheetReleaseTrap = null;
  let lastFocused = null;
  let openOverlay = null; // "drawer" | "sheet" | null

  /* ---- docking: move panel/preview to the right host for the layout ---- */
  function place() {
    const mode = layoutMode();

    // panel: docked in .dash on tablet+; in the drawer on phone.
    if (mode === "phone") {
      if (panel.parentElement !== drawerMount) drawerMount.appendChild(panel);
    } else {
      if (panel.parentElement !== dash) dash.insertBefore(panel, dash.firstChild);
      closeDrawer(true);
    }

    // preview: docked in .dash on desktop; in the sheet otherwise.
    if (mode === "desktop") {
      if (preview.parentElement !== dash) dash.appendChild(preview);
      closeSheet(true);
    } else {
      if (preview.parentElement !== sheetMount) sheetMount.appendChild(preview);
    }
  }

  /* ---- scroll lock ---- */
  function lockBody(lock) {
    document.documentElement.style.overflow = lock ? "hidden" : "";
  }

  /* ---- drawer ---- */
  function openDrawer() {
    if (openOverlay === "drawer") return;
    closeSheet(true);
    lastFocused = document.activeElement;
    drawer.hidden = false;
    // force reflow so the transition runs from the translated state
    void drawer.offsetWidth;
    drawer.dataset.open = "true";
    scrim.dataset.open = "true";
    drawerOpenBtn.setAttribute("aria-expanded", "true");
    drawerReleaseTrap = trapFocus(drawer);
    lockBody(true);
    openOverlay = "drawer";
    focusFirst(drawer);
  }
  function closeDrawer(instant) {
    if (drawer.dataset.open !== "true" && drawer.hidden) return;
    drawer.dataset.open = "false";
    drawerOpenBtn.setAttribute("aria-expanded", "false");
    if (drawerReleaseTrap) { drawerReleaseTrap(); drawerReleaseTrap = null; }
    const finish = () => { drawer.hidden = true; };
    if (instant) finish();
    else setTimeout(finish, 320);
    if (openOverlay === "drawer") { openOverlay = null; afterClose(); }
  }

  /* ---- sheet ---- */
  function openSheet() {
    if (openOverlay === "sheet") return;
    closeDrawer(true);
    lastFocused = document.activeElement;
    sheet.hidden = false;
    void sheet.offsetWidth;
    sheet.dataset.open = "true";
    scrim.dataset.open = "true";
    sheetOpenBtn.setAttribute("aria-expanded", "true");
    sheetReleaseTrap = trapFocus(sheet);
    lockBody(true);
    openOverlay = "sheet";
    focusFirst(sheet);
  }
  function closeSheet(instant) {
    if (sheet.dataset.open !== "true" && sheet.hidden) return;
    sheet.dataset.open = "false";
    sheetOpenBtn.setAttribute("aria-expanded", "false");
    if (sheetReleaseTrap) { sheetReleaseTrap(); sheetReleaseTrap = null; }
    const finish = () => { sheet.hidden = true; };
    if (instant) finish();
    else setTimeout(finish, 320);
    if (openOverlay === "sheet") { openOverlay = null; afterClose(); }
  }

  function afterClose() {
    scrim.dataset.open = "false";
    lockBody(false);
    if (lastFocused && document.contains(lastFocused)) {
      try { lastFocused.focus(); } catch { /* ignore */ }
    }
    lastFocused = null;
  }

  /* ---- jump-to-surface helpers (the red thread's tap targets) ----
     Used by the stepper, the chat empty-state CTA, and the phone topbar upload
     button. On phone the panel lives in the drawer, so the drawer opens first;
     on tablet/desktop the docked panel just scrolls. */
  function scrollAndFocus(target, focusEl) {
    if (!target) return;
    requestAnimationFrame(() => {
      try {
        target.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      } catch { try { target.scrollIntoView(); } catch { /* ignore */ } }
      if (focusEl) { try { focusEl.focus({ preventScroll: true }); } catch { try { focusEl.focus(); } catch { /* ignore */ } } }
    });
  }

  /** Open the upload surface: drawer (phone) or docked panel, scrolled to the
      dropzone with focus on it — the 1-tap "add footage" path. */
  function revealUpload() {
    if (layoutMode() === "phone") openDrawer();
    const uploadMount = byId("upload-mount");
    const target = uploadMount || byId("sec-upload");
    const dropzone = uploadMount ? uploadMount.querySelector(".dropzone") : null;
    scrollAndFocus(target, dropzone);
  }

  /** Reveal the Transcribe control (Clips section). */
  function revealTranscribe() {
    if (layoutMode() === "phone") openDrawer();
    const btn = byId("transcribe-all");
    scrollAndFocus(btn, btn && !btn.disabled ? btn : null);
  }

  // 1-tap upload affordance in the phone topbar (hidden ≥640px via CSS).
  const topbarUploadBtn = byId("topbar-upload");
  if (topbarUploadBtn) topbarUploadBtn.addEventListener("click", revealUpload);

  /* ---- wiring ---- */
  drawerOpenBtn.addEventListener("click", openDrawer);
  drawerCloseBtn.addEventListener("click", () => closeDrawer(false));
  sheetOpenBtn.addEventListener("click", openSheet);
  sheetCloseBtn.addEventListener("click", () => closeSheet(false));
  scrim.addEventListener("click", () => { closeDrawer(false); closeSheet(false); });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openOverlay) {
      e.preventDefault();
      closeDrawer(false); closeSheet(false);
    }
  });

  window.addEventListener("resize", debounce(place, 150));
  place();

  return {
    place,
    openDrawer, closeDrawer,
    openSheet, closeSheet,
    revealUpload,
    revealTranscribe,
    /** Open whichever overlay hosts the preview (used after a render and by the
        stepper's "Get your video" step). */
    revealPreview() {
      if (layoutMode() !== "desktop") openSheet();
    },
  };
}
