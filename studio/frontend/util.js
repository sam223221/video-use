/* =============================================================================
   util.js — shared, dependency-free helpers (DOM, format, focus trap, toasts).
   Kept tiny and single-purpose so the feature modules stay focused.
============================================================================= */

/* ----- DOM ----------------------------------------------------------------- */
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const byId = (id) => document.getElementById(id);

/** Create an element with attrs + children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;       // caller is responsible for safety
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** An <svg><use> icon element (safe — no user data). */
export function icon(name, cls = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "/static/assets/icons.svg#" + name);
  svg.append(use);
  return svg;
}

/** Escape text for safe insertion (we mostly use textContent, but handy for html:). */
export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ----- formatting ---------------------------------------------------------- */
export function fmtDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function basename(p) {
  if (!p) return "";
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}

/* ----- timing -------------------------------------------------------------- */
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ----- focus trap (for drawer / sheet / lightbox) -------------------------- */
const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "textarea:not([disabled])",
  "input:not([disabled])", "select:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

export function trapFocus(container) {
  function onKey(e) {
    if (e.key !== "Tab") return;
    const items = $$(FOCUSABLE, container).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  container.addEventListener("keydown", onKey);
  return () => container.removeEventListener("keydown", onKey);
}

export function focusFirst(container) {
  const first = $$(FOCUSABLE, container).find((n) => n.offsetParent !== null);
  if (first) first.focus();
}

/* ----- toasts -------------------------------------------------------------- */
let toastRoot;
export function toast(message, kind = "info", ms = 4200) {
  toastRoot = toastRoot || byId("toasts");
  if (!toastRoot) return;
  const iconName = kind === "ok" ? "i-check" : kind === "bad" ? "i-alert" : "i-spark";
  const node = el("div", { class: "toast", dataset: { kind }, role: "status" }, [
    icon(iconName), el("span", { text: message, style: "flex:1 1 auto" }),
  ]);
  toastRoot.append(node);
  const remove = () => {
    node.style.transition = "opacity .2s, transform .2s";
    node.style.opacity = "0"; node.style.transform = "translateY(8px)";
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener("click", remove);
  if (ms > 0) setTimeout(remove, ms);
  return remove;
}

/* ----- breakpoint awareness ----------------------------------------------- */
export const BP = { phone: 0, tablet: 640, desktop: 1024 };
export function layoutMode() {
  const w = window.innerWidth;
  if (w >= BP.desktop) return "desktop";
  if (w >= BP.tablet) return "tablet";
  return "phone";
}
