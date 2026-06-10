/* =============================================================================
   chat.js — the core: a streaming conversation with the agent.
   -----------------------------------------------------------------------------
   Transport: POST /api/chat with a streamed body reader (api.streamPost), parsing
   the SSE event schema in API_CONTRACT.md §13:
     turn_start, assistant_delta, tool_start, tool_progress, tool_end,
     turn_end, error.
   Also: history load (GET /api/chat/history?session_id=), cancel
   (POST /api/chat/cancel {session_id}), and the interactive ask_user answer
   (POST /api/chat/answer {…, session_id}).

   SESSIONS: every chat call carries the active `session_id` (from getSessionId()).
   Artifacts (tool_end / history) arrive EDIT-RELATIVE ("edit/…") and are resolved
   to absolute against the session's on-disk dir (getDir(), which comes from the
   /api/sessions/{id}/open response) so /api/file can serve them.

   SECURITY: all assistant/user/tool text is inserted via textContent only.
   Light markdown (bold, inline code, fenced code) is rendered with hand-built
   DOM nodes — never innerHTML on model output.
============================================================================= */

import { api, ApiError, streamPost, answerQuestion, fileUrl } from "./api.js";
import { byId, el, icon, basename, toast } from "./util.js";

export function initChat({ getSessionId, getDir, getClipCount, onAddFootage, onHistoryChanged, onArtifacts, onRenderDone }) {
  const inner    = byId("chat-inner");
  const log      = byId("chat-log");
  const textarea = byId("composer-text");
  const sendBtn  = byId("composer-send");
  const cancelBtn = byId("composer-cancel");
  const composer = byId("composer");
  const statusEl = byId("composer-status");

  let streaming = false;
  let stream = null;
  let currentTurnId = null;
  let folderReady = false;
  /* Message count for the active conversation — feeds the journey stepper
     ("Edit by chat" is done once any message exists). Set by loadHistory,
     bumped on every send. */
  let historyCount = 0;
  function notifyHistory() {
    onHistoryChanged && onHistoryChanged(historyCount);
  }
  /* The currently-open (unanswered) question card controller, or null. While set,
     the composer is locked so the user can only proceed by answering. Keyed on
     turn_id+question_id inside the controller so a duplicate ask_user event for
     the same question can't open a second card. */
  let pendingQuestion = null;

  /* ---- artifact path resolution ----------------------------------------
     The backend's tool_end events (and chat history) carry artifacts as
     EDIT-RELATIVE strings (API_CONTRACT.md §13), e.g. "edit/preview.mp4" or
     "edit/verify/cut_03.png" — never an absolute path. GET /api/file needs a
     path that resolves INSIDE the allowed roots (an absolute path), so a bare
     "edit/..." string can't be served as-is. The frontend knows the active
     SESSION's absolute on-disk dir (getDir(), supplied by the open response),
     so it joins them here to produce the absolute path the media endpoint
     expects. Returns null when the dir is unknown or the artifact can't be
     resolved (caller must no-op cleanly). */
  function resolveArtifactPath(artifact) {
    return resolveArtifact(getDir(), artifact);
  }
  /* Wrap a bare artifact string into the info object preview.openArtifact reads
     (it prefers info.path). Always carries the original string so the png/mp4/
     text branch detection still works; path is the resolved absolute path or
     null. Existing info (e.g. from /api/outputs) is preserved and never lost. */
  function artifactInfo(artifact, extra) {
    return { ...(extra || {}), path: resolveArtifactPath(artifact) };
  }

  /* ---- composer autosize + send keys ---- */
  function autosize() {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 144) + "px";
  }
  textarea.addEventListener("input", autosize);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener("click", send);
  cancelBtn.addEventListener("click", cancel);

  /* ---- enable/disable based on folder + agent auth ---- */
  function setEnabled(ready, reason) {
    folderReady = ready;
    applyComposerState(reason);
  }

  /* Single source of truth for the composer's enabled/disabled state, factoring
     in folder readiness, an in-flight stream, AND an open question card. A pending
     question always wins: the user must answer (or the turn must end/cancel)
     before they can type again — this prevents a free-text reply racing the
     paused turn. */
  function applyComposerState(reason) {
    const blockedByQuestion = pendingQuestion !== null;
    const usable = folderReady && !blockedByQuestion;
    composer.dataset.disabled = String((!folderReady && !streaming) || blockedByQuestion);
    sendBtn.disabled = !usable || streaming;
    textarea.disabled = (!folderReady && !streaming) || blockedByQuestion;
    if (blockedByQuestion) {
      statusEl.textContent = "Answer the question above to continue.";
    } else if (reason != null) {
      statusEl.textContent = reason;
    } else if (streaming) {
      // No explicit reason but the turn is still running (e.g. we just unblocked
      // after answering a question while the turn resumes) — restore the working
      // hint rather than leaving the stale "Answer the question above…" text.
      statusEl.textContent = "Editor is working…";
    } else {
      statusEl.textContent = "";
    }
  }

  /* =====================================================================
     EMPTY STATE
     ---------------------------------------------------------------------
     Two variants, keyed on whether the session has any footage yet:
       0 clips → "Step 1 — Add your footage" with a direct upload affordance
                 (on phone this opens the drawer at the Upload section) and NO
                 edit-suggestion chips (nothing to edit yet).
       ≥1 clip → the editing pitch + footage-aware suggestion chips, with
                 "What's in this footage?" first.
     refreshEmpty() re-renders ONLY while the empty state is on screen, so the
     CTA flips to chips the moment the first upload lands.
  ===================================================================== */
  function renderEmpty() {
    const clips = typeof getClipCount === "function" ? getClipCount() : null;
    if (!clips) {
      inner.replaceChildren(
        el("div", { class: "chat-empty" }, [
          el("span", { class: "brand__mark", "aria-hidden": "true" }),
          el("h2", { text: "Step 1 — Add your footage" }),
          el("p", { text: "Upload clips from this device, then tell the editor what to make — it cuts, grades, and captions for you.", style: "margin:0" }),
          el("button", {
            class: "btn btn--primary chat-empty__cta", type: "button",
            onclick: () => { onAddFootage && onAddFootage(); },
          }, [ icon("i-upload"), el("span", { text: "Add footage" }) ]),
        ]));
      return;
    }
    inner.replaceChildren(
      el("div", { class: "chat-empty" }, [
        el("span", { class: "brand__mark", "aria-hidden": "true" }),
        el("h2", { text: "Tell the editor what to make" }),
        el("p", { text: "It reads your footage, proposes a plan, and renders cuts, grades, and captions — confirming the strategy with you before it edits.", style: "margin:0" }),
        el("div", { class: "suggestions" }, [
          suggestion("What's in this footage?"),
          suggestion("Make a 60-second launch cut, warm grade, bold subtitles"),
          suggestion("Tighten the intro and add captions"),
        ]),
      ]));
  }
  function suggestion(text) {
    return el("button", { class: "suggestion", type: "button",
      onclick: () => { if (folderReady) { textarea.value = text; autosize(); textarea.focus(); } } }, [text]);
  }

  function clearEmpty() {
    const e = inner.querySelector(".chat-empty");
    if (e) e.remove();
  }

  /* Re-render the empty state in place when the clip count changes — no-op if
     a conversation is already on screen. */
  function refreshEmpty() {
    if (inner.querySelector(".chat-empty")) renderEmpty();
  }

  /* =====================================================================
     MESSAGE RENDERING
  ===================================================================== */
  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function addUserMessage(text) {
    clearEmpty();
    const bubble = el("div", { class: "msg__bubble" });
    bubble.textContent = text;
    const node = el("div", { class: "msg msg--user" }, [
      el("div", { class: "msg__role", text: "You" }),
      bubble,
    ]);
    inner.append(node);
    scrollToBottom();
  }

  /** Returns an assistant-turn controller that appends deltas + tool chips. */
  function addAssistantTurn() {
    clearEmpty();
    const role = el("div", { class: "msg__role" }, [
      el("span", { class: "brand__mark", style: "width:1rem;height:1rem;border-radius:4px" }),
      el("span", { text: "Editor" }),
    ]);
    const stack = el("div", { style: "display:flex;flex-direction:column;gap:var(--s2);width:100%" });
    const node = el("div", { class: "msg msg--assistant" }, [ role, stack ]);
    inner.append(node);

    let textBubble = null;
    let textBuf = "";
    const caret = el("span", { class: "caret", "aria-hidden": "true" });
    const toolChips = new Map();   // tool_call_id -> chip controller

    function ensureBubble() {
      if (!textBubble) {
        textBubble = el("div", { class: "msg__bubble" });
        stack.append(textBubble);
      }
      return textBubble;
    }

    return {
      node,
      appendDelta(text) {
        textBuf += text;
        const b = ensureBubble();
        renderMarkdownInto(b, textBuf);
        b.append(caret);
        scrollToBottom();
      },
      toolStart(d) {
        const chip = renderToolChip(d);
        toolChips.set(d.tool_call_id, chip);
        // tool chips render before any text that follows; append to stack in order
        stack.append(chip.node);
        scrollToBottom();
      },
      toolProgress(d) {
        const chip = toolChips.get(d.tool_call_id);
        if (chip) chip.progress(d);
      },
      toolInput(d) {
        // The relay sends a refined input_summary as a separate tool_input event
        // after tool_start. Update the chip's subtitle in place (only if truthy).
        const chip = toolChips.get(d.tool_call_id);
        if (chip) chip.setInput(d.input_summary);
      },
      askUser(d) {
        // Render an interactive question card into this turn's stack. The card
        // controller registers itself as the module's pendingQuestion (which
        // locks the composer) and clears it on answer/expire/cancel.
        const card = renderQuestionCard(d, stack);
        if (card) {
          stack.append(card.node);
          scrollToBottom();
        }
      },
      toolEnd(d) {
        const chip = toolChips.get(d.tool_call_id);
        if (chip) chip.end(d);
        if (d && d.artifacts && d.artifacts.length) {
          // Carry the resolved absolute path so preview.openArtifact (which
          // prefers info.path) can serve the bare "edit/..." string via /api/file.
          onArtifacts && onArtifacts(d.artifacts, { info: artifactInfo(d.artifacts[0]) });
        }
        // a finished render → refresh outputs/preview
        if (d && d.ok && d.artifacts && d.artifacts.some((a) => /preview|final|\.mp4$/i.test(a))) {
          onRenderDone && onRenderDone(d);
        }
        // when a new text bubble starts after a tool, force a fresh one
        textBubble = null; textBuf = "";
      },
      finish() {
        caret.remove();
        if (textBubble && textBuf === "") textBubble.remove();
        // If the turn ends while a question card is still open and unsubmitted,
        // the turn has moved on — finalize the card so it can't be answered into
        // a dead turn, and unlock the composer.
        finalizePendingQuestion("ended");
      },
      error(d) {
        caret.remove();
        finalizePendingQuestion("ended");
        const msg = (d && d.message) ? d.message : "The editor hit an error.";
        // Phone-safe copy: the fix happens on the machine RUNNING Studio, not
        // on the device showing this message.
        const hint = d && d.code === "agent_auth"
          ? " — the editor isn’t signed in on the Studio computer. On that machine, run `claude` once, then restart Studio."
          : "";
        const banner = el("div", { class: "chat-error" }, [ icon("i-alert"), el("span", { text: msg + hint }) ]);
        stack.append(banner);
        scrollToBottom();
      },
    };
  }

  /* =====================================================================
     "YOUR VIDEO IS READY" CARD
     ---------------------------------------------------------------------
     Appended to the chat flow when a render finishes (app.js onRenderDone) —
     the journey's ENDING. Play loads it in the preview; Download is a real
     <a download> against /api/file?…&download=1 (Content-Disposition:
     attachment server-side). Unmissable but not modal. If the previous chat
     entry is already a ready card (multiple renders in one turn), it is
     REPLACED rather than stacked. All text is static; the path feeds only
     the href/download attributes (encoded by fileUrl).
  ===================================================================== */
  function showReadyCard({ kind, path, onPlay }) {
    if (!path) return;
    clearEmpty();
    const isFinal = kind === "final";
    const playBtn = el("button", { class: "btn btn--sm", type: "button",
      onclick: () => { onPlay && onPlay(); } }, [ icon("i-play"), el("span", { text: "Play" }) ]);
    const downloadLink = el("a", {
      class: "btn btn--primary btn--sm", href: fileUrl(path) + "&download=1",
      download: basename(path) || "video.mp4",
    }, [ icon("i-download"), el("span", { text: "Download" }) ]);
    const node = el("div", { class: "ready-card", role: "status" }, [
      el("span", { class: "ready-card__icon", "aria-hidden": "true" }, [ icon("i-check") ]),
      el("div", { class: "ready-card__body" }, [
        el("strong", { text: isFinal ? "Your video is ready" : "Draft preview is ready" }),
        el("span", { class: "ready-card__sub", text: isFinal
          ? "Play it here, or download it to your device."
          : "Watch the draft — when you’re happy, ask the editor for the final render." }),
      ]),
      el("div", { class: "ready-card__actions" }, [ playBtn, downloadLink ]),
    ]);
    const last = inner.lastElementChild;
    if (last && last.classList.contains("ready-card")) last.replaceWith(node);
    else inner.append(node);
    scrollToBottom();
  }

  /* ---- tool chip ---- */
  function renderToolChip(d) {
    const titleStrong = el("b", { text: d.tool || "tool" });
    const sub = el("span", { class: "toolchip__sub", text: d.input_summary || "" });
    const statusSpin = el("span", { class: "toolchip__spin", "aria-hidden": "true" });
    const statusText = el("span", { text: "running" });
    const statusWrap = el("span", { class: "toolchip__status" }, [ statusSpin, statusText ]);

    const bar = el("span", { class: "progress__bar" });
    const progWrap = el("div", { class: "toolchip__progress" }, [
      el("div", { class: "progress progress--indeterminate" }, [ bar ]),
      el("span", { class: "toolchip__sub", text: "" }),
    ]);
    const artifactsWrap = el("div", { class: "toolchip__artifacts" });
    const body = el("div", { class: "toolchip__body" }, [ progWrap, artifactsWrap ]);

    const head = el("button", { class: "toolchip__head", type: "button" }, [
      el("span", { class: "toolchip__icon" }, [ icon(toolIcon(d.tool)) ]),
      el("span", {}, [
        el("span", { class: "toolchip__title" }, [ titleStrong ]),
        el("br"), sub,
      ]),
      statusWrap,
    ]);
    const node = el("div", { class: "toolchip", dataset: { state: "running" }, "aria-expanded": "true" }, [ head, body ]);

    head.addEventListener("click", () => {
      const open = node.getAttribute("aria-expanded") === "true";
      node.setAttribute("aria-expanded", String(!open));
    });

    const phaseEl = progWrap.querySelector(".toolchip__sub");
    const progEl = progWrap.querySelector(".progress");

    return {
      node,
      setInput(text) {
        // Only overwrite the subtitle when we actually have refined text, so a
        // later empty input_summary can never blank an already-set subtitle.
        if (text) sub.textContent = text;
      },
      progress(p) {
        if (p.percent != null) {
          progEl.classList.remove("progress--indeterminate");
          bar.style.width = Math.max(0, Math.min(100, p.percent)) + "%";
          statusText.textContent = Math.round(p.percent) + "%";
        }
        if (p.phase) phaseEl.textContent = p.phase;
      },
      end(r) {
        statusSpin.remove();
        progEl.classList.remove("progress--indeterminate");
        if (r && r.ok) {
          node.dataset.state = "ok";
          bar.style.width = "100%";
          statusText.textContent = "done";
          statusWrap.prepend(icon("i-check"));
          node.setAttribute("aria-expanded", "false");
        } else {
          node.dataset.state = "error";
          statusText.textContent = "failed";
          statusWrap.prepend(icon("i-alert"));
        }
        if (r && r.summary) phaseEl.textContent = r.summary;
        if (r && r.artifacts && r.artifacts.length) {
          artifactsWrap.replaceChildren(...r.artifacts.map((a) =>
            el("button", { class: "artifact", type: "button", title: a,
              // Resolve the edit-relative artifact to an absolute path so the
              // click actually opens it (video/png → preview/lightbox, text → tab).
              onclick: () => onArtifacts && onArtifacts([a], { info: artifactInfo(a, { open: true }) }) }, [
              icon(/\.png$|\.jpg$/i.test(a) ? "i-image" : /\.mp4$/i.test(a) ? "i-play" : "i-doc"),
              basename(a),
            ])));
        }
      },
    };
  }

  function toolIcon(tool) {
    const t = String(tool || "");
    if (/transcribe/.test(t)) return "i-mic";
    if (/render/.test(t)) return "i-play";
    if (/timeline|view/.test(t)) return "i-image";
    if (/grade/.test(t)) return "i-spark";
    if (/edl|pack|read|write|project/.test(t)) return "i-doc";
    return "i-spark";
  }

  /* =====================================================================
     INTERACTIVE QUESTION CARD (ask_user event)
     ---------------------------------------------------------------------
     The agent can pause a turn to ask a multiple-choice question. We render
     a card per question in the event, collect the user's choice(s) (single,
     multi, or a free-text "Other…"), and POST them all together via
     api.answerQuestion so the turn resumes. While a card is open the composer
     is locked (applyComposerState). On success the card collapses to a
     read-only summary; on a 409 (turn already moved on) it collapses with an
     "expired" note. Keyed on turn_id+question_id so a duplicate event can't
     open a second card and submit is guarded against double-fire.
  ===================================================================== */

  /* Finalize whatever question card is currently open (if any) WITHOUT a
     successful answer — used when the turn ends/errors/cancels with the card
     still pending. Idempotent. */
  function finalizePendingQuestion(kind) {
    if (!pendingQuestion) return;
    const card = pendingQuestion;
    pendingQuestion = null;
    card.expire(kind);
    applyComposerState();
  }

  function renderQuestionCard(d, stack) {
    // Defensive parse: a malformed ask_user event must never break the stream.
    if (!d || typeof d !== "object") return null;
    const turnId = typeof d.turn_id === "string" ? d.turn_id : (d.turn_id != null ? String(d.turn_id) : currentTurnId);
    const questionId = d.question_id != null ? String(d.question_id) : null;
    const rawQuestions = Array.isArray(d.questions) ? d.questions : [];
    // Keep only well-formed questions; sanitize each option.
    const questions = rawQuestions
      .filter((q) => q && typeof q === "object")
      .map((q, qi) => {
        const opts = Array.isArray(q.options) ? q.options : [];
        return {
          header: typeof q.header === "string" && q.header ? q.header : ("Question " + (qi + 1)),
          question: typeof q.question === "string" ? q.question : "",
          multiSelect: q.multiSelect === true,
          options: opts
            .filter((o) => o && typeof o === "object" && typeof o.label === "string" && o.label !== "")
            .map((o) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" })),
        };
      });
    if (questions.length === 0) return null;          // nothing answerable → skip
    if (questionId === null) return null;             // can't address an answer without it

    // De-dupe: if a card for this exact turn+question is already open, ignore.
    if (pendingQuestion &&
        pendingQuestion.turnId === turnId &&
        pendingQuestion.questionId === questionId) {
      return null;
    }
    // A different pending question is being superseded → finalize the old one.
    if (pendingQuestion) finalizePendingQuestion("ended");

    let submitted = false;            // double-submit guard
    let finalized = false;            // card reached a terminal (answered/expired) state

    // Per-question selection state. selected = Set of chosen labels; otherText =
    // the free-text "Other…" value (empty string = not used).
    const qStates = questions.map(() => ({ selected: new Set(), otherText: "" }));

    /* ---- card scaffold ---- */
    const headIcon = el("span", { class: "qcard__icon", "aria-hidden": "true" }, [ icon("i-spark") ]);
    const headTitle = el("span", { class: "qcard__title", text: questions.length > 1 ? "A few quick questions" : "Quick question" });
    const head = el("div", { class: "qcard__head" }, [ headIcon, headTitle ]);

    const body = el("div", { class: "qcard__body" });
    const qNodes = questions.map((q, qi) => buildQuestionBlock(q, qi));
    body.append(...qNodes.map((n) => n.node));

    // Submit row (always present for multi-question, multi-select, or Other-typed;
    // a lone single-select with no Other submits immediately on click).
    const submitBtn = el("button", { class: "btn btn--primary btn--sm qcard__submit", type: "button", text: "Submit answer" });
    const errSlot = el("span", { class: "qcard__error", role: "alert" });
    const actions = el("div", { class: "qcard__actions" }, [ submitBtn, errSlot ]);
    submitBtn.addEventListener("click", () => doSubmit());
    body.append(actions);

    const node = el("div", { class: "qcard", role: "group", dataset: { state: "open" },
      "aria-label": questions.length > 1 ? "Questions from the editor" : "Question from the editor" }, [ head, body ]);

    syncSubmitState();

    /* ---- per-question block builder ---- */
    function buildQuestionBlock(q, qi) {
      const labelId = "qc-" + (questionId || "q") + "-" + qi;
      const qText = el("p", { class: "qcard__q", id: labelId });
      qText.append(el("span", { class: "qcard__q-header", text: q.header }));
      if (q.question) qText.append(el("span", { class: "qcard__q-text", text: q.question }));

      const optWrap = el("div", { class: "qcard__opts",
        role: q.multiSelect ? "group" : "radiogroup",
        "aria-labelledby": labelId });

      const optButtons = [];
      q.options.forEach((opt) => {
        const labelSpan = el("span", { class: "qopt__label", text: opt.label });
        const children = [
          el("span", { class: "qopt__check", "aria-hidden": "true" }, [ icon("i-check") ]),
          el("span", { class: "qopt__text" }, opt.description
            ? [ labelSpan, el("span", { class: "qopt__desc", text: opt.description }) ]
            : [ labelSpan ]),
        ];
        const btn = el("button", {
          class: "qopt", type: "button",
          role: q.multiSelect ? "checkbox" : "radio",
          "aria-checked": "false",
          "aria-pressed": "false",
          dataset: { selected: "false" },
        }, children);
        btn.addEventListener("click", () => onOptionClick(q, qi, opt.label, btn, optButtons));
        optButtons.push(btn);
        optWrap.append(btn);
      });

      // "Other…" free-text control — always offered (it is not in options).
      // id/name (unique per turn+question via labelId) satisfy the DevTools
      // form-field audit; the aria-label is the accessible name.
      const otherInput = el("input", {
        class: "input qcard__other-input", type: "text",
        id: labelId + "-other", name: labelId + "-other",
        placeholder: "Type another answer…",
        "aria-label": "Other answer for: " + q.header,
        spellcheck: "true",
        hidden: true,
      });
      const otherBtn = el("button", {
        class: "qopt qopt--other", type: "button",
        role: q.multiSelect ? "checkbox" : "radio",
        "aria-checked": "false", "aria-pressed": "false",
        dataset: { selected: "false" },
      }, [
        el("span", { class: "qopt__check", "aria-hidden": "true" }, [ icon("i-check") ]),
        el("span", { class: "qopt__text" }, [ el("span", { class: "qopt__label", text: "Other…" }) ]),
      ]);
      otherBtn.addEventListener("click", () => onOtherClick(q, qi, otherBtn, otherInput, optButtons));
      otherInput.addEventListener("input", () => {
        qStates[qi].otherText = otherInput.value;
        // Typing in Other implicitly marks it active for the submit gate.
        if (otherInput.value && otherBtn.dataset.selected !== "true") {
          markSelected(otherBtn, true);
        } else if (!otherInput.value && q.multiSelect && otherBtn.dataset.selected === "true") {
          // leaving it blank in multi-select de-selects the Other toggle
          markSelected(otherBtn, false);
        }
        syncSubmitState();
      });
      otherInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); if (!submitBtn.disabled) doSubmit(); }
      });
      optWrap.append(otherBtn, otherInput);

      /* Roving tabindex + arrow-key navigation (standard radiogroup pattern):
         Tab enters the group on ONE stop; ArrowUp/Down/Left/Right move focus
         between options (wrapping); Enter/Space activate the focused option
         (native <button> behaviour — selection semantics unchanged). */
      const rovingGroup = [...optButtons, otherBtn];
      rovingGroup.forEach((b, i) => b.setAttribute("tabindex", i === 0 ? "0" : "-1"));
      optWrap.addEventListener("keydown", (e) => {
        if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) return;
        const idx = rovingGroup.indexOf(document.activeElement);
        if (idx === -1) return;                       // focus is on the Other input etc.
        e.preventDefault();
        const delta = (e.key === "ArrowDown" || e.key === "ArrowRight") ? 1 : -1;
        const next = rovingGroup[(idx + delta + rovingGroup.length) % rovingGroup.length];
        rovingGroup.forEach((b) => b.setAttribute("tabindex", "-1"));
        next.setAttribute("tabindex", "0");
        next.focus();
      });

      return { node: el("div", { class: "qcard__block" }, [ qText, optWrap ]),
        optButtons, otherBtn, otherInput };
    }

    function markSelected(btn, on) {
      btn.dataset.selected = String(on);
      btn.setAttribute("aria-checked", String(on));
      btn.setAttribute("aria-pressed", String(on));
    }

    function onOptionClick(q, qi, label, btn, optButtons) {
      if (finalized) return;
      const st = qStates[qi];
      const blockNode = qNodes[qi];
      if (q.multiSelect) {
        const now = btn.dataset.selected !== "true";
        markSelected(btn, now);
        if (now) st.selected.add(label); else st.selected.delete(label);
      } else {
        // single-select: clear siblings + the Other toggle
        st.selected.clear();
        optButtons.forEach((b) => markSelected(b, false));
        if (blockNode.otherBtn) { markSelected(blockNode.otherBtn, false); }
        markSelected(btn, true);
        st.selected.add(label);
        st.otherText = "";
        if (blockNode.otherInput) { blockNode.otherInput.value = ""; blockNode.otherInput.hidden = true; }
      }
      maybeImmediateSubmit();
      syncSubmitState();
    }

    function onOtherClick(q, qi, otherBtn, otherInput, optButtons) {
      if (finalized) return;
      const st = qStates[qi];
      const turningOn = otherBtn.dataset.selected !== "true";
      if (q.multiSelect) {
        markSelected(otherBtn, turningOn);
        otherInput.hidden = !turningOn;
        if (turningOn) { otherInput.focus(); } else { st.otherText = ""; otherInput.value = ""; }
      } else {
        // single-select Other: it becomes the sole selection
        st.selected.clear();
        optButtons.forEach((b) => markSelected(b, false));
        markSelected(otherBtn, true);
        otherInput.hidden = false;
        otherInput.focus();
      }
      st.otherText = otherInput.value;
      syncSubmitState();
    }

    /* A lone single-select question with no Other engaged can submit on click.
       Otherwise the explicit Submit button confirms. */
    function maybeImmediateSubmit() {
      if (questions.length !== 1) return;
      const q = questions[0];
      if (q.multiSelect) return;
      const st = qStates[0];
      const otherBtn = qNodes[0].otherBtn;
      const otherActive = otherBtn && otherBtn.dataset.selected === "true";
      if (otherActive) return;          // Other selected → let them type, use Submit
      if (st.selected.size === 1) doSubmit();
    }

    /* Whether every question has at least one usable answer. */
    function isComplete() {
      return questions.every((q, qi) => answerForQuestion(q, qi) !== null);
    }

    /* Build the answer entry for a question, or null if it has no usable choice. */
    function answerForQuestion(q, qi) {
      const st = qStates[qi];
      const selected = Array.from(st.selected);
      const otherText = st.otherText.trim();
      const otherActive = qNodes[qi].otherBtn.dataset.selected === "true";
      const other = otherActive && otherText ? otherText : null;
      if (selected.length === 0 && !other) return null;
      return { header: q.header, selected, other_text: other };
    }

    function syncSubmitState() {
      submitBtn.disabled = submitted || finalized || !isComplete();
    }

    async function doSubmit() {
      if (submitted || finalized) return;
      if (!isComplete()) { syncSubmitState(); return; }
      const answers = questions.map((q, qi) => answerForQuestion(q, qi));
      submitted = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
      node.dataset.state = "sending";
      errSlot.textContent = "";

      try {
        await answerQuestion(turnId, questionId, answers, getSessionId());
        finalized = true;
        if (pendingQuestion === controller) pendingQuestion = null;
        collapseAnswered(answers);
        applyComposerState();
      } catch (err) {
        if (err instanceof ApiError && err.code === "no_pending_question") {
          // The turn already moved on — collapse with a muted expired note.
          finalized = true;
          if (pendingQuestion === controller) pendingQuestion = null;
          collapseExpired();
          applyComposerState();
          return;
        }
        // Recoverable failure (network/500) — let the user retry.
        submitted = false;
        node.dataset.state = "open";
        submitBtn.textContent = "Submit answer";
        errSlot.textContent = (err && err.message) ? err.message : "Couldn’t send your answer. Try again.";
        syncSubmitState();
        toast("Couldn’t send your answer.", "bad");
      }
    }

    /* Collapse the card into a compact read-only summary of the chosen answers. */
    function collapseAnswered(answers) {
      node.dataset.state = "answered";
      node.setAttribute("aria-label", "Answered");
      const rows = answers.map((a) => {
        const chosen = [...a.selected];
        if (a.other_text) chosen.push(a.other_text);
        return el("div", { class: "qcard__sum-row" }, [
          el("span", { class: "qcard__sum-head", text: a.header }),
          el("span", { class: "qcard__sum-val", text: chosen.join(", ") || "—" }),
        ]);
      });
      const summary = el("div", { class: "qcard__summary" }, [
        el("span", { class: "qcard__sum-icon", "aria-hidden": "true" }, [ icon("i-check") ]),
        el("div", { class: "qcard__sum-body" }, rows),
      ]);
      body.replaceChildren(summary);
    }

    function collapseExpired() {
      node.dataset.state = "expired";
      node.setAttribute("aria-label", "Question expired");
      body.replaceChildren(el("div", { class: "qcard__expired" }, [
        icon("i-alert"),
        el("span", { text: "This question expired — the editor moved on." }),
      ]));
    }

    /* Controller surface used by finalizePendingQuestion (turn end/cancel). */
    const controller = {
      node,
      turnId,
      questionId,
      expire(kind) {
        if (finalized || submitted) return;     // already answered / mid-send
        finalized = true;
        if (kind === "cancelled") {
          node.dataset.state = "cancelled";
          node.setAttribute("aria-label", "Question cancelled");
          body.replaceChildren(el("div", { class: "qcard__expired" }, [
            icon("i-close"),
            el("span", { text: "Turn cancelled before this was answered." }),
          ]));
        } else {
          collapseExpired();
        }
      },
    };

    pendingQuestion = controller;
    applyComposerState();
    return controller;
  }

  /* =====================================================================
     SEND / STREAM
  ===================================================================== */
  async function send() {
    if (streaming) return;
    const text = textarea.value.trim();
    if (!text) return;
    const sessionId = getSessionId();
    if (sessionId == null) { toast("Open a session first.", "bad"); return; }

    addUserMessage(text);
    historyCount += 1;             // editing has begun — advance the journey stepper
    notifyHistory();
    textarea.value = "";
    autosize();

    const turn = addAssistantTurn();
    setStreaming(true);

    stream = streamPost("/api/chat", { message: text, session_id: sessionId }, {
      onEvent: (event, data) => {
        switch (event) {
          case "turn_start":      currentTurnId = data && data.turn_id; break;
          case "assistant_delta": turn.appendDelta((data && data.text) || ""); break;
          case "tool_start":      turn.toolStart(data || {}); break;
          case "tool_input":      turn.toolInput(data || {}); break;
          case "tool_progress":   turn.toolProgress(data || {}); break;
          case "tool_end":        turn.toolEnd(data || {}); break;
          case "ask_user":        turn.askUser(data || {}); break;
          case "turn_end":        turn.finish(); break;
          case "error":           turn.error(data || {}); break;
          default: break;
        }
      },
      onError: (err) => {
        turn.error({ message: err && err.message ? err.message : "Connection error." });
      },
      onClose: () => {
        turn.finish();
        setStreaming(false);
        stream = null;
        currentTurnId = null;
        textarea.focus();
      },
    });
  }

  async function cancel() {
    if (!streaming) return;
    // Finalize any open question card first so its wording reflects a user
    // cancel (the later onClose → turn.finish() "ended" path is idempotent).
    finalizePendingQuestion("cancelled");
    statusEl.textContent = "Stopping…";
    try {
      if (currentTurnId) await api.post("/api/chat/cancel", { turn_id: currentTurnId, session_id: getSessionId() });
    } catch { /* best effort */ }
    if (stream) stream.cancel();
  }

  function setStreaming(on) {
    streaming = on;
    sendBtn.hidden = on;
    cancelBtn.hidden = !on;
    // A pending question forces the composer locked regardless of stream state;
    // applyComposerState() owns that decision and the status hint.
    applyComposerState(on ? "Editor is working…" : "");
    sendBtn.disabled = on || !folderReady || pendingQuestion !== null;
  }

  /* =====================================================================
     HISTORY
  ===================================================================== */
  async function loadHistory(sessionId) {
    // Switching/reloading a conversation discards any in-flight question card
    // (its DOM is about to be replaced) so the composer lock can't dangle.
    pendingQuestion = null;
    applyComposerState();
    historyCount = 0;
    notifyHistory();
    if (sessionId == null) { renderEmpty(); return; }
    inner.replaceChildren(el("div", { class: "empty", text: "Loading conversation…" }));
    try {
      const data = await api.get("/api/chat/history?session_id=" + encodeURIComponent(sessionId));
      const messages = (data && data.messages) || [];
      historyCount = messages.length;
      notifyHistory();
      inner.replaceChildren();
      if (messages.length === 0) { renderEmpty(); return; }
      for (const m of messages) {
        if (m.role === "user") {
          addUserMessage(typeof m.content === "string" ? m.content : "");
        } else {
          const turn = addAssistantTurn();
          if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
              turn.toolStart({ tool: tc.tool || tc.name, tool_call_id: tc.tool_call_id || tc.id, input_summary: tc.input_summary || "" });
              turn.toolEnd({ tool_call_id: tc.tool_call_id || tc.id, ok: tc.ok !== false, summary: tc.summary, artifacts: tc.artifacts });
            }
          }
          if (m.content) turn.appendDelta(typeof m.content === "string" ? m.content : "");
          turn.finish();
        }
      }
      scrollToBottom();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      // history missing/unsupported → just show empty composer
      inner.replaceChildren();
      renderEmpty();
    }
  }

  renderEmpty();

  return {
    loadHistory,
    setEnabled,
    refreshEmpty,
    showReadyCard,
    focus: () => textarea.focus(),
    get streaming() { return streaming; },
  };
}

/* =============================================================================
   ARTIFACT PATH RESOLUTION (edit-relative → absolute for /api/file)
   -----------------------------------------------------------------------------
   tool_end / history artifacts are edit-relative strings (API_CONTRACT.md §13),
   e.g. "edit/preview.mp4". /api/file needs a path inside the allowed roots, so we
   join the active SESSION's absolute on-disk dir (supplied by the open response
   and tracked by the frontend) with the artifact. Already-absolute inputs
   (Windows "X:\\"/"X:/", UNC "\\\\", or POSIX "/...") are passed through
   unchanged. Returns null when nothing usable can be produced, so callers no-op
   cleanly instead of building a broken URL.
============================================================================= */
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/;

function isAbsolutePath(p) {
  return typeof p === "string" && ABSOLUTE_PATH_RE.test(p);
}

function resolveArtifact(dir, artifact) {
  if (typeof artifact !== "string" || artifact === "") return null;
  if (isAbsolutePath(artifact)) return artifact;
  if (typeof dir !== "string" || dir === "") return null;
  // Join the session dir + edit-relative artifact with a single forward slash.
  // Forward slashes are accepted by the backend's realpath/normpath confinement
  // on every platform (incl. Windows), matching how artifacts are presented in
  // the contract.
  const base = dir.replace(/[\\/]+$/, "");
  const rel = artifact.replace(/^[\\/]+/, "");
  return base + "/" + rel;
}

/* =============================================================================
   LIGHT MARKDOWN → safe DOM (no innerHTML on model output)
   Supports: paragraphs, **bold**, `inline code`, and ```fenced``` blocks.
============================================================================= */
function renderMarkdownInto(container, text) {
  container.replaceChildren();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // fenced code block (odd segments)
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      // first line may be a language hint — keep it simple, drop a leading lang token
      code.textContent = part.replace(/^[a-zA-Z0-9_-]*\n/, "");
      pre.append(code);
      container.append(pre);
    } else {
      // prose with paragraphs
      const paras = part.split(/\n{2,}/);
      for (const para of paras) {
        if (para.trim() === "" && paras.length > 1) continue;
        const p = document.createElement("p");
        appendInline(p, para);
        container.append(p);
      }
    }
  });
}

function appendInline(parent, text) {
  // split on inline code first, then bold within non-code spans
  const codeSplit = text.split(/`([^`]+)`/);
  codeSplit.forEach((seg, i) => {
    if (i % 2 === 1) {
      const c = document.createElement("code");
      c.textContent = seg;
      parent.append(c);
    } else {
      appendBold(parent, seg);
    }
  });
}

function appendBold(parent, text) {
  const boldSplit = text.split(/\*\*([^*]+)\*\*/);
  boldSplit.forEach((seg, i) => {
    if (seg === "") return;
    if (i % 2 === 1) {
      const b = document.createElement("strong");
      b.textContent = seg;
      parent.append(b);
    } else {
      parent.append(document.createTextNode(seg));
    }
  });
}
