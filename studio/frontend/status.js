/* =============================================================================
   status.js — system status pills + full status rows from GET /api/status.
   -----------------------------------------------------------------------------
   Tolerates BOTH the frozen full shape (API_CONTRACT.md §1) and the scaffold's
   minimal subset ({ok, ffmpeg:<bool>, elevenlabs_key:<bool>, agent_auth:<str>}).
   Normalizes everything into {state, label, detail} so the UI is stable.
============================================================================= */

import { api, ApiError } from "./api.js";
import { byId, el, icon } from "./util.js";

const PENDING = { state: "pending", label: "checking…", detail: "" };

/* Plain-language editor-login labels (shared by the object + string shapes).
   "subscription"/"api key" are developer terms — the user just needs to know
   whether the editor can work. */
const AGENT_LABELS = {
  subscription: "signed in",
  would_bill_api_key: "API key",
  not_logged_in: "not signed in",
  unavailable: "unavailable",
  unknown: "unknown",
};

function normalize(s) {
  // video engine (ffmpeg) ---------------------------------------------------
  let ffmpeg;
  if (typeof s.ffmpeg === "object" && s.ffmpeg) {
    ffmpeg = { state: s.ffmpeg.ok ? "ok" : "bad",
               label: s.ffmpeg.ok ? (s.ffmpeg.version || "ready") : "missing",
               detail: s.ffprobe && s.ffprobe.ok === false ? "ffprobe missing" : "" };
  } else {
    ffmpeg = { state: s.ffmpeg ? "ok" : "bad", label: s.ffmpeg ? "ready" : "missing", detail: "" };
  }

  // transcription key (ElevenLabs) -------------------------------------------
  // A missing key is a CONFIGURATION fact, not an emergency: neutral copy —
  // editing still works, only voice transcription is off.
  let key;
  if (typeof s.elevenlabs_key === "object" && s.elevenlabs_key) {
    key = { state: s.elevenlabs_key.present ? "ok" : "warn",
            label: s.elevenlabs_key.present ? "present" : "not set",
            detail: s.elevenlabs_key.present ? (s.elevenlabs_key.source || "") : "voice transcription disabled" };
  } else {
    key = { state: s.elevenlabs_key ? "ok" : "warn",
            label: s.elevenlabs_key ? "present" : "not set",
            detail: s.elevenlabs_key ? "" : "voice transcription disabled" };
  }

  // editor login (agent auth) -------------------------------------------------
  let agent;
  const a = s.agent_auth;
  if (typeof a === "object" && a) {
    const mode = a.mode || (a.ok ? "subscription" : "unavailable");
    const ok = a.ok === true || mode === "subscription";
    agent = {
      state: ok ? "ok" : (mode === "would_bill_api_key" ? "warn" : "bad"),
      label: AGENT_LABELS[mode] || mode,
      detail: a.detail || "",
    };
  } else {
    const mode = String(a || "unknown");
    agent = {
      state: mode === "subscription" ? "ok" : mode === "unknown" ? "pending" : "bad",
      label: AGENT_LABELS[mode] || mode,
      detail: "",
    };
  }

  return { ffmpeg, key, agent, raw: s };
}

const PILL_META = [
  { id: "ffmpeg", short: "Engine" },
  { id: "key",    short: "Transcription" },
  { id: "agent",  short: "Editor" },
];

export function initStatus() {
  const cluster = byId("status-cluster");
  const rows = byId("status-rows");
  const refreshBtn = byId("status-refresh");

  // listeners for status updates (other modules read active_folder etc.)
  const listeners = new Set();
  let last = null;

  function renderPending() {
    cluster.replaceChildren(...PILL_META.map((m) =>
      el("span", { class: "pill", dataset: { state: "pending" } }, [
        el("span", { class: "pill__dot" }), el("span", { text: m.short }),
      ])));
    rows.replaceChildren(...PILL_META.map((m) =>
      el("div", { class: "statusrow", dataset: { state: "pending" } }, [
        el("span", { class: "statusrow__dot" }),
        el("span", { class: "statusrow__name", text: rowName(m.id) }),
        el("span", { class: "statusrow__val", text: "checking…" }),
      ])));
  }

  function rowName(id) {
    return ({ ffmpeg: "Video engine", key: "Transcription key", agent: "Editor login" })[id];
  }

  function render(norm) {
    const items = [
      { id: "ffmpeg", ...norm.ffmpeg },
      { id: "key", ...norm.key },
      { id: "agent", ...norm.agent },
    ];
    // compact pills (topbar)
    cluster.replaceChildren(...items.map((it) => {
      const meta = PILL_META.find((m) => m.id === it.id);
      return el("span", {
        class: "pill", dataset: { state: it.state },
        title: `${rowName(it.id)}: ${it.label}${it.detail ? " — " + it.detail : ""}`,
      }, [ el("span", { class: "pill__dot" }), el("span", { text: meta.short }) ]);
    }));
    // full rows (panel)
    rows.replaceChildren(...items.map((it) =>
      el("div", { class: "statusrow", dataset: { state: it.state } }, [
        el("span", { class: "statusrow__dot" }),
        el("span", { class: "statusrow__name", text: rowName(it.id) }),
        el("span", { class: "statusrow__val", text: it.label, title: it.detail || it.label }),
      ])));
  }

  async function refresh() {
    try {
      const s = await api.get("/api/status");
      const norm = normalize(s);
      last = norm;
      render(norm);
      listeners.forEach((fn) => { try { fn(norm); } catch { /* ignore */ } });
      return norm;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err; // bubble auth loss
      // soft-fail: show all as bad/unreachable
      const bad = { state: "bad", label: "unreachable", detail: "" };
      render({ ffmpeg: bad, key: { ...bad }, agent: { ...bad }, raw: {} });
      return null;
    }
  }

  refreshBtn.addEventListener("click", () => { renderPending(); refresh(); });

  renderPending();

  return {
    refresh,
    get last() { return last; },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
