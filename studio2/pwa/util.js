/* =============================================================================
   util.js — shared, dependency-free helpers for Studio v2 (DOM, format, ids,
   focus, toasts).
   -----------------------------------------------------------------------------
   IMPORTED BARE EVERYWHERE (never with a ?v= query) — the v1 double-load
   lesson: versioning one shared import while others import it bare creates two
   module instances. This file is deliberately exempt from the ?v= convention;
   the service worker's version-keyed shell cache handles its freshness.
============================================================================= */

/* ----- DOM ----------------------------------------------------------------- */
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const byId = (id) => document.getElementById(id);

/** Create an element with attrs + children. ALL strings land via textContent /
    setAttribute — there is deliberately NO innerHTML path in v2 (the v1 `html:`
    escape hatch was removed; the app's XSS posture is textContent-only). */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
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

/** An <svg><use> icon element (safe — name is always code-authored). */
export function icon(name, cls = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "/static/assets/icons.svg#" + name);
  svg.append(use);
  return svg;
}

/* ----- ids ------------------------------------------------------------------ */

/** Cryptographically-random lowercase hex of `bytes` length × 2 chars. */
export function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

const DEVICE_ID_KEY = "studio2.device_id";
const DEVICE_ID_RE = /^dev_[0-9a-f]{16}$/;

/** The per-install device id (arch §3.3): `dev_` + 16 hex, generated once and
    persisted in localStorage. Both tabs of one origin share it by design —
    the bridge's newest-stream-wins rule handles the duplicate. Storage
    failures (private mode) fall back to an ephemeral id for this run. */
let ephemeralDeviceId = null;
export function deviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && DEVICE_ID_RE.test(existing)) return existing;
    const fresh = "dev_" + randHex(8);
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    if (!ephemeralDeviceId) ephemeralDeviceId = "dev_" + randHex(8);
    return ephemeralDeviceId;
  }
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

export function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return "—"; }
}

/* ----- timing -------------------------------------------------------------- */
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ----- focus helpers (confirm dialog) -------------------------------------- */
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
