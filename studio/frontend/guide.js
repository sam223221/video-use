/* =============================================================================
   guide.js — the "red thread": a persistent 4-step journey stepper.
   -----------------------------------------------------------------------------
   1 Add footage → 2 Transcribe (optional) → 3 Edit by chat → 4 Get your video.

   Renders into #guide-stepper (top of the chat column, always visible on the
   dashboard at every breakpoint). State is PUSHED in by app.js via update():
     { clips, transcribed, chatCount, previewExists, finalExists }
   computed from the panel inventory, the chat history, and /api/outputs — this
   module holds no network code of its own.

   Step semantics:
     • footage    done when the session has ≥1 clip.
     • transcribe OPTIONAL ("if people talk") — done when any clip has a
                  transcript, OR implicitly skipped once chatting has started
                  with footage present (skipping is a legitimate path).
     • edit       done once the conversation has any messages.
     • video      done when a FINAL render exists (the deliverable); it is the
                  current step as soon as editing has begun.

   Steps are real <button>s — tapping one jumps to the matching surface
   (upload / transcribe control / composer / preview) via the onStep callback.
   All text is static (no user/model data) and inserted via util.el textContent.
============================================================================= */

import { byId, el, icon } from "./util.js";

const STEPS = [
  { key: "footage",    n: 1, label: "Add footage",
    hint: "Upload clips from your phone or computer." },
  { key: "transcribe", n: 2, label: "Transcribe", optional: true,
    hint: "Optional — if people talk. Turns speech into text for cut-by-quote and subtitles." },
  { key: "edit",       n: 3, label: "Edit by chat",
    hint: "Tell the editor what to make." },
  { key: "video",      n: 4, label: "Get your video",
    hint: "Play and download the finished render." },
];

export function initGuide({ onStep }) {
  const mount = byId("guide-stepper");

  let state = {
    clips: 0,
    transcribed: false,
    chatCount: 0,
    previewExists: false,
    finalExists: false,
  };

  function computed() {
    const done = {
      footage: state.clips > 0,
      // Transcribe is optional: chatting with footage present counts as
      // "handled" (skipped), so the thread never stalls on an optional step.
      transcribe: state.transcribed || (state.clips > 0 && state.chatCount > 0),
      edit: state.chatCount > 0,
      video: !!state.finalExists,
    };
    let currentKey = null;
    for (const s of STEPS) {
      if (!done[s.key]) { currentKey = s.key; break; }
    }
    // Everything done → keep the goal step visible as completed (no current).
    return { done, currentKey };
  }

  function render() {
    if (!mount) return;
    const { done, currentKey } = computed();
    const nodes = [];
    STEPS.forEach((s, i) => {
      if (i > 0) nodes.push(el("span", { class: "stepper__sep", "aria-hidden": "true", text: "›" }));
      const isDone = !!done[s.key];
      const isCurrent = !isDone && s.key === currentKey;
      const labelChildren = [s.label];
      if (s.optional) labelChildren.push(el("span", { class: "step__opt", text: "optional" }));
      const btn = el("button", {
        class: "step",
        type: "button",
        dataset: { state: isDone ? "done" : isCurrent ? "current" : "todo" },
        title: s.hint,
        "aria-label": `Step ${s.n}: ${s.label}${s.optional ? " (optional)" : ""}${isDone ? " — done" : isCurrent ? " — current step" : ""}`,
        onclick: () => { onStep && onStep(s.key); },
      }, [
        el("span", { class: "step__mark", "aria-hidden": "true" },
          isDone ? [icon("i-check")] : [String(s.n)]),
        el("span", { class: "step__label" }, labelChildren),
      ]);
      if (isCurrent) btn.setAttribute("aria-current", "step");
      nodes.push(btn);
    });
    mount.replaceChildren(...nodes);
  }

  render();

  return {
    /** Merge a partial state snapshot and re-render. */
    update(partial) {
      state = { ...state, ...(partial || {}) };
      render();
    },
    /** Reset to a fresh-session baseline (called on session switch). */
    reset() {
      state = { clips: 0, transcribed: false, chatCount: 0, previewExists: false, finalExists: false };
      render();
    },
    get state() { return { ...state }; },
  };
}
