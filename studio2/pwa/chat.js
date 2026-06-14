/* =============================================================================
   chat.js — the conversation with the editor brain (arch §2.2, §7.2).
   -----------------------------------------------------------------------------
   Transport:
   • POST /api/chat {message, project_id, device_id} via api.streamPost —
     SSE vocabulary: turn_start · assistant_delta · tool_start · tool_input ·
     tool_end · turn_end · error. Every frame carries `id:` (PER-TURN seq,
     starts at 1 — the turn-survival buffer's replay cursor).
   • GET /api/chat/attach?after_seq= via bridge.sseRequest (GET stream) —
     replays the live/most-recent turn. 404 no_active_turn = nothing missed.
     Called on visibilitychange→visible while a turn dangles (the phone-lock
     incident class) and once on editor entry (a turn that finished while the
     app was closed). Replays of turns already in the transcript are consumed
     silently (dedupe by turn_id).
   • 409 turn_in_progress on send → attach instead (another window or a
     previous send owns the live turn; we follow it).

   ask_user is NOT a chat event (arch §10.7) — questions arrive as BRIDGE
   commands. editor.js wires the bridge's ask_user executor to this module's
   askUser(): we render the option card (v1 chat.js card pattern: 1-4
   questions, 2-4 options, multiSelect, implicit free-text "Other"), and the
   resolved answers become the bridge result POST.

   Transcript: device-side OPFS chat.json (arch §5.1) —
   {schema:1, messages:[{role, content, ts, turn_id?, tool_calls?}]} — the
   ONLY writer is this module (one-writer-per-file, arch §1.4). The user
   message is appended at send; the assistant message at turn_end (its full
   text rides the turn_end event). Capped at 500 messages.

   Offline: a relay-unreachable state shows "Studio brain unreachable —
   editing by chat needs your home connection" (driven by the bridge's
   connection state + send failures); the rest of the editor stays usable.

   M1.1 (phone navigation): chat lives full-height on the EDIT page. This
   module owns the SCROLL-FOLLOW half of the keyboard fix — a pinned-to-bottom
   log that respects the user scrolling up, re-pins on composer focus / own
   send / question cards, and holds the pin through height changes via a
   ResizeObserver (the iOS keyboard shrinking the log via editor.js's --kb).
   It also reports chat activity (streaming turn, dangling mid-turn gap, OR
   open question) through ctx.onChatActivity for the Edit tab's indicator
   dot. Turn/transport logic is UNCHANGED from Step 5.

   XSS: every dynamic string lands via textContent (util.el has no innerHTML
   path); assistant prose renders through the v1 light-markdown DOM builder.
============================================================================= */

import { el, icon } from "./util.js";
import { api, streamPost } from "./api.js";
import { sseRequest } from "./bridge.js";
import { projectDir, readJSON, writeJSONAtomic } from "./store/opfs.js";

function dlog(level, msg, data) {
  try {
    const d = window.__studio2Diag;
    if (d && typeof d.dlog === "function") d.dlog(level, msg, data);
  } catch { /* ignore */ }
}

/* Evidence the relay answered THIS module (the bridge reporting online, a chat
   turn streaming events). app.js listens and re-verifies its GLOBAL offline
   banner via /api/me — without this signal, a banner raised on a static tab
   outlived demonstrably-working chat until the 5-minute poll or a tab switch
   (v3 fix). Fire-and-forget; dispatched only at bounded points (bridge state
   transition, turn_start), never per frame. */
function relaySeen() {
  try { window.dispatchEvent(new CustomEvent("studio2:relay-seen")); } catch { /* ignore */ }
}

const TRANSCRIPT_MAX_MESSAGES = 500;
const RENDER_MAX_MESSAGES = 200;

/* Phone-safe tool labels (v1 copy convention — no internal jargon). */
const TOOL_LABELS = {
  get_inventory: "Checking your footage",
  describe_clip: "Reading clip details",
  apply_cuts: "Cutting",
  undo_last_edit: "Undoing the last edit",
  read_edl: "Reading the edit",
  read_transcript: "Checking for a transcript",
  view_frames: "Looking at the footage",
  ask_user: "Asking you",
};

const TOOL_ICONS = {
  get_inventory: "i-film",
  describe_clip: "i-doc",
  apply_cuts: "i-scissors",
  undo_last_edit: "i-undo",
  read_edl: "i-doc",
  read_transcript: "i-doc",
  view_frames: "i-eye",
  ask_user: "i-spark",
};

/**
 * Mount the chat panel into `container`.
 * ctx: { project: {id, name} }   (deviceId comes from the bridge module's
 * util.deviceId() — editor passes it explicitly to keep one source).
 */
export function initChat(ctx, container) {
  const projectId = ctx.project.id;
  const devId = ctx.deviceId;

  /* ---- DOM ------------------------------------------------------------- */
  const logInner = el("div", { class: "chat-inner" });
  const log = el("div", {
    class: "chat-log", role: "log", "aria-live": "polite",
    "aria-label": "Conversation with the editor",
  }, [logInner]);

  const offlineNote = el("div", { class: "chat-offline", hidden: true, role: "status" }, [
    icon("i-offline"),
    el("span", {}, [
      el("b", { text: "Studio brain unreachable." }),
      " Editing by chat needs your home connection — your project, preview and export still work.",
    ]),
  ]);

  const textarea = el("textarea", {
    class: "composer__input", rows: "1",
    placeholder: "Tell the editor what to cut…",
    "aria-label": "Message to the editor",
    autocapitalize: "sentences", autocomplete: "off", spellcheck: "true",
    enterkeyhint: "send",
  });
  const sendBtn = el("button", {
    class: "btn btn--primary composer__send", type: "submit",
    "aria-label": "Send message",
  }, [icon("i-send")]);
  const stopBtn = el("button", {
    class: "btn composer__stop", type: "button", hidden: true,
    "aria-label": "Stop the editor",
  }, [icon("i-stop"), el("span", { text: "Stop" })]);
  const statusEl = el("p", { class: "composer__status", role: "status", "aria-live": "polite" });

  const composer = el("form", { class: "composer", novalidate: true }, [
    el("div", { class: "composer__row" }, [textarea, stopBtn, sendBtn]),
    statusEl,
  ]);

  container.append(
    el("section", { class: "chat", "aria-label": "Chat" }, [log, offlineNote, composer]),
  );

  /* ---- state ------------------------------------------------------------ */
  let streaming = false;          // a send/attach reader is consuming a live turn
  let stream = null;              // active reader controller (cancel())
  let currentTurn = null;         // controller for the turn being rendered
  let currentTurnId = null;
  let lastSeq = 0;                // last seen `id:` of the CURRENT turn (per-turn)
  let dangling = false;           // stream died mid-turn → attach on visibility
  let pendingCard = null;         // open ask_user card controller
  let offline = false;
  let destroyed = false;
  let transcript = null;          // {schema:1, messages:[...]} (loaded at init)
  let transcriptChain = Promise.resolve();   // serialize chat.json writes

  /* Pending-turn marker (localStorage, per project): set when a turn starts,
     cleared when its turn_end is SEEN. Editor entry only attaches when the
     marker says a turn may have been missed — the common path stays free of
     by-contract 404 noise, while the phone-lock/reload case still recovers
     (the marker survives both). */
  const PENDING_KEY = "studio2.chat.pending." + projectId;
  function setPendingMarker() {
    try { localStorage.setItem(PENDING_KEY, String(Date.now())); } catch { /* best-effort */ }
  }
  function clearPendingMarker() {
    try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  }
  function hasPendingMarker() {
    try { return localStorage.getItem(PENDING_KEY) !== null; } catch { return false; }
  }

  /* ---- composer state machine ------------------------------------------- */
  function applyComposerState(hint) {
    const blocked = pendingCard !== null;
    textarea.disabled = blocked;
    sendBtn.disabled = streaming || blocked;
    sendBtn.hidden = streaming;
    stopBtn.hidden = !streaming;
    if (blocked) statusEl.textContent = "Answer the question above to continue.";
    else if (hint != null) statusEl.textContent = hint;
    else if (streaming) statusEl.textContent = "The editor is working…";
    else statusEl.textContent = "";
    notifyActivity();
  }

  /* Chat activity = a streaming turn, a DANGLING turn (the stream died
     mid-turn — the phone-lock class — while the relay keeps working; attach
     catches up on visibility), OR an open question. Every transition funnels
     through applyComposerState, so this single hook keeps the Edit tab's
     indicator dot honest (M1.1 — visible while the user is on another page;
     `dangling` joined the predicate in M1.2 P2-2: without it the dot went
     dark across the lock gap while the turn was still running). Fired only
     on change; the editor's hook never throws into here. Every `dangling`
     transition already funnels here too — set/cleared next to endStream() /
     applyComposerState() on all paths, and both stream readers guarantee
     onClose after onError, so the dot can never stick. */
  let lastActivity = false;
  function notifyActivity() {
    const active = streaming || dangling || pendingCard !== null;
    if (active === lastActivity) return;
    lastActivity = active;
    try {
      if (typeof ctx.onChatActivity === "function") ctx.onChatActivity(active);
    } catch { /* indicator is decorative — never break chat over it */ }
  }

  function setOffline(value) {
    const next = !!value;
    if (next === offline) return;
    offline = next;
    offlineNote.hidden = !offline;
    if (offline) dlog("warn", "chat.offline");
  }

  /* ---- scroll-follow (M1.1) -----------------------------------------------
     The log follows the newest message ONLY while the user is at (or near)
     the bottom — scrolling up to read pauses the follow; streaming deltas no
     longer yank the view down. `force` callers (the user's own send, the
     initial transcript render, a question card that needs answering) re-pin.
     A ResizeObserver keeps the pin through height changes — the iOS keyboard
     opening (visualViewport → --kb padding) shrinks the log, and a pinned
     view must keep showing the latest messages while typing. */
  let pinned = true;
  let programmaticFocus = false;          // guards the focus→re-pin handler
  function scrollToBottom(force) {
    if (!force && !pinned) return;
    log.scrollTop = log.scrollHeight;
    pinned = true;
  }
  /** Code-driven focus (end of turn) — must not look like typing intent. */
  function focusComposer() {
    programmaticFocus = true;
    try { textarea.focus(); } finally { programmaticFocus = false; }
  }
  log.addEventListener("scroll", () => {
    pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  });
  let logResizeObserver = null;
  if (typeof ResizeObserver === "function") {
    logResizeObserver = new ResizeObserver(() => { scrollToBottom(); });
    logResizeObserver.observe(log);
  }

  /* ---- transcript (OPFS chat.json — this module is the only writer) ------ */
  async function loadTranscript() {
    try {
      const dir = await projectDir(projectId);
      const doc = await readJSON(dir, "chat.json");
      if (doc && doc.schema === 1 && Array.isArray(doc.messages)) {
        transcript = doc;
      } else {
        transcript = { schema: 1, messages: [] };
      }
    } catch {
      transcript = { schema: 1, messages: [] };
    }
  }

  function appendTranscript(message) {
    if (!transcript) transcript = { schema: 1, messages: [] };
    transcript.messages.push(message);
    if (transcript.messages.length > TRANSCRIPT_MAX_MESSAGES) {
      transcript.messages = transcript.messages.slice(-TRANSCRIPT_MAX_MESSAGES);
    }
    const snapshot = { schema: 1, messages: transcript.messages.slice() };
    transcriptChain = transcriptChain.then(async () => {
      try {
        const dir = await projectDir(projectId);
        await writeJSONAtomic(dir, "chat.json", snapshot);
      } catch (err) {
        dlog("error", "chat.transcript.err", { message: String(err && err.message).slice(0, 200) });
      }
    });
  }

  function turnKnown(turnId) {
    if (!turnId || !transcript) return false;
    return transcript.messages.some((m) => m && m.turn_id === turnId);
  }

  /* ---- message rendering (v1 patterns, textContent-only) ----------------- */
  function addUserMessage(text) {
    clearEmpty();
    const bubble = el("div", { class: "msg__bubble" });
    bubble.textContent = text;
    logInner.append(el("div", { class: "msg msg--user" }, [
      el("div", { class: "msg__role", text: "You" }),
      bubble,
    ]));
    scrollToBottom(true);     // the user's own message always re-pins
  }

  /** Streaming assistant-turn controller: deltas, tool chips, errors. */
  function addAssistantTurn() {
    clearEmpty();
    const stack = el("div", { class: "msg__stack" });
    const node = el("div", { class: "msg msg--assistant" }, [
      el("div", { class: "msg__role" }, [
        el("span", { class: "brand__mark brand__mark--chat", "aria-hidden": "true" }),
        el("span", { text: "Editor" }),
      ]),
      stack,
    ]);
    logInner.append(node);

    let textBubble = null;
    let textBuf = "";
    const caret = el("span", { class: "caret", "aria-hidden": "true" });
    const chips = new Map();      // tool_call_id → chip controller
    const toolCalls = [];         // transcript record

    function ensureBubble() {
      if (!textBubble) {
        textBubble = el("div", { class: "msg__bubble" });
        stack.append(textBubble);
      }
      return textBubble;
    }

    return {
      node,
      stack,
      toolCalls,
      appendDelta(text) {
        textBuf += text;
        const b = ensureBubble();
        renderMarkdownInto(b, textBuf);
        b.append(caret);
        scrollToBottom();
      },
      toolStart(d) {
        const chip = renderToolChip(d);
        chips.set(d.tool_call_id, chip);
        toolCalls.push({
          tool_call_id: d.tool_call_id || null,
          tool: d.tool || null,
          input_summary: d.input_summary || "",
          ok: null,
          summary: "",
        });
        stack.append(chip.node);
        textBubble = null; textBuf = "";   // text after a tool starts fresh
        scrollToBottom();
      },
      toolInput(d) {
        const chip = chips.get(d.tool_call_id);
        if (chip) chip.setInput(d.input_summary);
        const rec = toolCalls.find((t) => t.tool_call_id === d.tool_call_id);
        if (rec && d.input_summary) rec.input_summary = d.input_summary;
      },
      toolEnd(d) {
        const chip = chips.get(d.tool_call_id);
        if (chip) chip.end(d);
        const rec = toolCalls.find((t) => t.tool_call_id === d.tool_call_id);
        if (rec) { rec.ok = d.ok !== false; rec.summary = d.summary || ""; }
        textBubble = null; textBuf = "";
      },
      /* Break the running text flow so the NEXT delta starts a FRESH bubble
         appended after whatever was just mounted. Same contract toolStart/
         toolEnd already apply; used when an ask_user card lands inside this
         turn — ask_user is a BRIDGE command, not a chat event, so without
         this the pre-question text and the post-answer continuation
         concatenate into one run-on paragraph ABOVE the card (v3 fix). */
      breakText() {
        textBubble = null; textBuf = "";
      },
      error(d) {
        caret.remove();
        const msg = (d && d.message) ? d.message : "The editor hit an error.";
        const hint = d && d.code === "agent_auth"
          ? " — the editor isn't signed in on the Studio computer. On that machine, run `claude` once, then restart Studio."
          : "";
        stack.append(el("div", { class: "chat-error" }, [
          icon("i-alert"), el("span", { text: msg + hint }),
        ]));
        scrollToBottom();
      },
      note(text) {
        stack.append(el("div", { class: "chat-note", text }));
        scrollToBottom();
      },
      finish() {
        caret.remove();
        if (textBubble && textBuf === "") textBubble.remove();
      },
    };
  }

  function renderToolChip(d) {
    const tool = String(d.tool || "");
    const label = TOOL_LABELS[tool] || tool || "Working";
    const sub = el("span", { class: "toolchip__sub", text: d.input_summary || "" });
    const spin = el("span", { class: "toolchip__spin", "aria-hidden": "true" });
    const statusText = el("span", { class: "toolchip__state", text: "running" });
    const node = el("div", { class: "toolchip", dataset: { state: "running" }, role: "status" }, [
      el("span", { class: "toolchip__icon", "aria-hidden": "true" }, [icon(TOOL_ICONS[tool] || "i-spark")]),
      el("span", { class: "toolchip__body" }, [
        el("span", { class: "toolchip__title", text: label }),
        sub,
      ]),
      el("span", { class: "toolchip__status" }, [spin, statusText]),
    ]);
    return {
      node,
      setInput(text) { if (text) sub.textContent = text; },
      end(r) {
        spin.remove();
        if (r && r.ok !== false) {
          node.dataset.state = "ok";
          statusText.textContent = "done";
          statusText.before(icon("i-check"));
        } else {
          node.dataset.state = "error";
          statusText.textContent = "failed";
          statusText.before(icon("i-alert"));
        }
        if (r && r.summary) sub.textContent = r.summary;
      },
    };
  }

  /* ---- empty state -------------------------------------------------------- */
  function renderEmpty() {
    if (logInner.childElementCount > 0) return;
    logInner.append(el("div", { class: "chat-empty" }, [
      el("span", { class: "brand__mark", "aria-hidden": "true" }),
      el("h2", { text: "Tell the editor what to cut" }),
      el("p", { text: "Say things like “cut out 0:42 to 1:05”. Cuts snap to keyframes, the preview updates instantly, and nothing is destroyed — you can always undo." }),
    ]));
  }

  function clearEmpty() {
    const e = logInner.querySelector(".chat-empty");
    if (e) e.remove();
  }

  /* ---- transcript render --------------------------------------------------- */
  function renderTranscript() {
    logInner.replaceChildren();
    const messages = transcript.messages.slice(-RENDER_MAX_MESSAGES);
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "user") {
        addUserMessage(typeof m.content === "string" ? m.content : "");
      } else if (m.role === "assistant") {
        const turn = addAssistantTurn();
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            turn.toolStart({
              tool: tc.tool, tool_call_id: tc.tool_call_id,
              input_summary: tc.input_summary || "",
            });
            turn.toolEnd({
              tool_call_id: tc.tool_call_id, ok: tc.ok !== false, summary: tc.summary || "",
            });
          }
        }
        if (typeof m.content === "string" && m.content) turn.appendDelta(m.content);
        turn.finish();
      }
    }
    // A bridge-replayed ask_user can mount its card while the transcript is
    // still loading (editor re-entry replay race) — replaceChildren above
    // must never orphan a live question. Re-mount it at the end of the log.
    if (pendingCard && pendingCard.node && !pendingCard.node.isConnected) {
      logInner.append(pendingCard.node);
    }
    if (logInner.childElementCount === 0) renderEmpty();
    scrollToBottom(true);     // initial render starts at the newest message
  }

  /* =====================================================================
     TURN EVENT PUMP — shared by send() and attach()
     `silent` consumes a replayed, already-known turn without rendering.
  ===================================================================== */
  function makeTurnSink({ userText, silentIfKnown }) {
    let silent = false;
    let sawTurnEnd = false;

    return {
      get sawTurnEnd() { return sawTurnEnd; },
      onEvent(event, data, meta) {
        const seqN = meta && meta.id != null ? parseInt(meta.id, 10) : NaN;
        if (event === "turn_start") {
          const tid = data && data.turn_id;
          if (silentIfKnown && turnKnown(tid)) {
            // A replay of a turn we already hold — consume invisibly.
            silent = true;
            currentTurnId = tid;
            if (Number.isFinite(seqN)) lastSeq = seqN;
            return;
          }
          silent = false;
          currentTurnId = tid || null;
          lastSeq = Number.isFinite(seqN) ? seqN : 1;
          if (!currentTurn) currentTurn = addAssistantTurn();
          return;
        }
        if (Number.isFinite(seqN)) lastSeq = Math.max(lastSeq, seqN);
        if (silent) {
          if (event === "turn_end" || event === "error") {
            sawTurnEnd = true;
            clearPendingMarker();
          }
          return;
        }
        if (!currentTurn) currentTurn = addAssistantTurn();
        switch (event) {
          case "assistant_delta": currentTurn.appendDelta((data && data.text) || ""); break;
          case "tool_start":      currentTurn.toolStart(data || {}); break;
          case "tool_input":      currentTurn.toolInput(data || {}); break;
          case "tool_end":        currentTurn.toolEnd(data || {}); break;
          case "turn_end": {
            sawTurnEnd = true;
            clearPendingMarker();
            currentTurn.finish();
            expirePendingCard("ended");
            // Persist the exchange: turn_end carries the full assistant text.
            if (userText != null) {
              appendTranscript({ role: "user", content: userText, ts: new Date().toISOString() });
            }
            appendTranscript({
              role: "assistant",
              content: (data && typeof data.text === "string") ? data.text : "",
              ts: new Date().toISOString(),
              turn_id: (data && data.turn_id) || currentTurnId || null,
              tool_calls: currentTurn.toolCalls.slice(),
            });
            break;
          }
          case "error":
            sawTurnEnd = true;        // the turn is over either way
            clearPendingMarker();
            currentTurn.error(data || {});
            expirePendingCard("ended");
            break;
          default: break;
        }
      },
    };
  }

  function endStream() {
    streaming = false;
    stream = null;
    applyComposerState();
  }

  /* =====================================================================
     SEND
  ===================================================================== */
  async function send() {
    if (streaming || destroyed) return;
    const text = textarea.value.trim();
    if (!text) return;
    if (pendingCard) { applyComposerState(); return; }

    textarea.value = "";
    autosize();
    addUserMessage(text);
    setPendingMarker();              // cleared when this turn's turn_end is seen
    // The user message is durable even if the turn never completes.
    const userTs = new Date().toISOString();

    currentTurn = addAssistantTurn();
    currentTurnId = null;
    lastSeq = 0;
    dangling = false;
    streaming = true;
    applyComposerState("The editor is working…");

    const sink = makeTurnSink({ userText: null, silentIfKnown: false });
    let userPersisted = false;
    let followViaAttach = false;     // 409 turn_in_progress → follow the live turn
    let failedBeforeStart = false;   // POST failed before any turn_start arrived
    const persistUser = () => {
      if (userPersisted) return;
      userPersisted = true;
      appendTranscript({ role: "user", content: text, ts: userTs });
    };

    stream = streamPost("/api/chat", {
      message: text, project_id: projectId, device_id: devId,
    }, {
      onEvent: (event, data, meta) => {
        setOffline(false);
        if (event === "turn_start") { persistUser(); relaySeen(); }
        // The sink persists the ASSISTANT side at turn_end; the user side is
        // persisted above (so a crash mid-turn still keeps the user's words).
        sink.onEvent(event, data, meta);
      },
      onError: (err) => {
        persistUser();
        if (err && err.code === "turn_in_progress") {
          // Another reader owns the live turn (second window / earlier send
          // that lost its stream) — follow it instead of failing. The actual
          // attach happens in onClose (this stream is still registered here).
          followViaAttach = true;
          currentTurn && currentTurn.note("The editor is already working on a turn — following it here.");
          return;
        }
        failedBeforeStart = currentTurnId === null;
        if (isNetworkish(err)) {
          setOffline(true);
          currentTurn && currentTurn.note(
            "Studio brain unreachable — editing by chat needs your home connection. Your message wasn't lost; try again when connected.");
        } else {
          currentTurn && currentTurn.error({ code: err && err.code, message: err && err.message });
        }
      },
      onClose: () => {
        const finished = sink.sawTurnEnd;
        if (followViaAttach && !destroyed) {
          endStream();
          attach(0, { silentIfKnown: true });
          return;
        }
        if (!finished && !destroyed && currentTurnId !== null) {
          // Stream died mid-turn (phone lock class) AFTER the turn started.
          // The TURN SURVIVES on the relay (arch §2.2) — attach catches us
          // up shortly and on visibility regain.
          dangling = true;
          dlog("warn", "chat.stream.dangling", { turn_id: currentTurnId, last_seq: lastSeq });
          endStream();
          applyComposerState("Connection dropped — the editor keeps working. Reconnecting…");
          scheduleCatchup();
          return;
        }
        if (finished || failedBeforeStart) {
          if (failedBeforeStart && currentTurn) currentTurn.finish();
          currentTurn = null;
          currentTurnId = null;
        }
        endStream();
        if (!destroyed) focusComposer();
      },
    });
  }

  /* =====================================================================
     ATTACH — replay/resume the live or most-recent turn
  ===================================================================== */
  function attach(afterSeq, { silentIfKnown } = {}) {
    if (destroyed || stream) return;
    streaming = true;
    applyComposerState("Catching up…");
    const sink = makeTurnSink({ userText: null, silentIfKnown: silentIfKnown !== false });
    let restarted = false;

    const url = "/api/chat/attach?project_id=" + encodeURIComponent(projectId) +
      "&device_id=" + encodeURIComponent(devId) +
      "&after_seq=" + encodeURIComponent(String(afterSeq));

    stream = sseRequest(url, {
      onEvent: (event, data, meta) => {
        setOffline(false);
        if (event === "turn_start") relaySeen();
        // Cursor safety: per-turn seqs restart at 1. If we attached with a
        // stale cursor and the buffer now holds a DIFFERENT turn, we'd be
        // consuming its middle. Detect and restart once from 0.
        if (!restarted && afterSeq > 0 && event !== "turn_start" &&
            currentTurnId && data && data.turn_id && data.turn_id !== currentTurnId) {
          restarted = true;
          dlog("warn", "chat.attach.restart", { expected: currentTurnId, got: data.turn_id });
          if (stream) stream.cancel();
          if (currentTurn) { currentTurn.finish(); currentTurn = null; }
          currentTurnId = null;
          endStream();
          attach(0, { silentIfKnown: true });
          return;
        }
        sink.onEvent(event, data, meta);
      },
      onError: (err) => {
        if (err && err.status === 404) {
          // no_active_turn — nothing was missed (or it aged out). Benign.
          dangling = false;
          clearPendingMarker();
          if (currentTurn && !sink.sawTurnEnd) {
            currentTurn.note("The editor's reply to this was lost (the studio brain moved on). Say it again.");
            currentTurn.finish();
            currentTurn = null;
            currentTurnId = null;
          }
          return;
        }
        if (isNetworkish(err)) setOffline(true);
        dlog("warn", "chat.attach.err", { status: err && err.status, code: err && err.code });
      },
      onClose: () => {
        if (restarted) return;            // the restarted attach owns state now
        if (sink.sawTurnEnd) {
          dangling = false;
          currentTurn = null;
          currentTurnId = null;
        } else if (!destroyed && dangling) {
          // Still mid-turn and the stream died again — try again on visibility.
          dlog("info", "chat.attach.dangling");
        }
        endStream();
      },
    });
  }

  function scheduleCatchup() {
    // Try once shortly after the drop (transient blips), then rely on
    // visibilitychange (the lock/unlock case).
    setTimeout(() => {
      if (!destroyed && dangling && !stream) attach(lastSeq, { silentIfKnown: true });
    }, 1500);
  }

  function onVisible() {
    if (document.visibilityState !== "visible" || destroyed) return;
    if (dangling && !stream) attach(lastSeq, { silentIfKnown: true });
  }
  document.addEventListener("visibilitychange", onVisible);

  /* =====================================================================
     CANCEL
  ===================================================================== */
  async function cancelTurn() {
    if (!streaming) return;
    expirePendingCard("cancelled");
    applyComposerState("Stopping…");
    try {
      await api.post("/api/chat/cancel", { project_id: projectId, device_id: devId });
    } catch { /* best effort */ }
    if (stream) stream.cancel();
    dangling = false;
  }

  /* =====================================================================
     ASK_USER CARD (bridge command → option card → bridge result)
     Returns Promise<answers|null>: answers = [{header, selected[],
     other_text?}] per the agent DOCUMENT.md contract; null = the card
     expired (turn ended / cancelled / timed out / brain restarted) and NO
     result must be POSTed.
  ===================================================================== */
  async function askUser({ questions, command, signal }) {
    // Never mount a card before the transcript render: a bridge replay can
    // deliver ask_user within milliseconds of editor entry, and
    // renderTranscript()'s replaceChildren would wipe an early card (found
    // in the Step-5 Playwright run; belt-and-braces with renderTranscript's
    // re-mount guard).
    await ready;
    if (destroyed) return null;
    return askUserMount({ questions, command, signal });
  }

  function askUserMount({ questions, command, signal }) {
    return new Promise((resolve) => {
      // Only one open card at a time — a newer question supersedes the old.
      expirePendingCard("ended");

      let settled = false;
      const finish = (answers, state, label) => {
        if (settled) return;
        settled = true;
        if (pendingCard === controller) pendingCard = null;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (state) collapse(state, label);
        applyComposerState();
        resolve(answers);
      };
      const onAbort = () => {
        // Relay-deadline self-abort (arch §3.1): the question timed out.
        finish(null, "expired", "This question timed out — the editor moved on.");
      };
      if (signal) {
        if (signal.aborted) { resolve(null); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      /* ---- card DOM (v1 qcard pattern) ---- */
      const qStates = questions.map(() => ({ selected: new Set(), otherText: "" }));
      const body = el("div", { class: "qcard__body" });
      const submitBtn = el("button", {
        class: "btn btn--primary btn--sm qcard__submit", type: "button", text: "Submit answer",
      });
      const node = el("div", {
        class: "qcard", role: "group", dataset: { state: "open" },
        "aria-label": questions.length > 1 ? "Questions from the editor" : "Question from the editor",
      }, [
        el("div", { class: "qcard__head" }, [
          el("span", { class: "qcard__icon", "aria-hidden": "true" }, [icon("i-spark")]),
          el("span", { class: "qcard__title", text: questions.length > 1 ? "A few quick questions" : "Quick question" }),
        ]),
        body,
      ]);

      const qNodes = questions.map((q, qi) => buildQuestionBlock(q, qi));
      qNodes.forEach((n) => body.append(n.node));
      body.append(el("div", { class: "qcard__actions" }, [submitBtn]));
      submitBtn.addEventListener("click", () => doSubmit());

      function buildQuestionBlock(q, qi) {
        const labelId = "qc-" + command.command_id + "-" + qi;
        const qText = el("p", { class: "qcard__q", id: labelId }, [
          el("span", { class: "qcard__q-header", text: q.header }),
          q.question ? el("span", { class: "qcard__q-text", text: q.question }) : null,
        ]);
        const optWrap = el("div", {
          class: "qcard__opts",
          role: q.multiSelect ? "group" : "radiogroup",
          "aria-labelledby": labelId,
        });
        const optButtons = [];
        q.options.forEach((opt) => {
          const btn = el("button", {
            class: "qopt", type: "button",
            role: q.multiSelect ? "checkbox" : "radio",
            "aria-checked": "false",
            dataset: { selected: "false" },
          }, [
            el("span", { class: "qopt__check", "aria-hidden": "true" }, [icon("i-check")]),
            el("span", { class: "qopt__text" }, opt.description
              ? [el("span", { class: "qopt__label", text: opt.label }),
                 el("span", { class: "qopt__desc", text: opt.description })]
              : [el("span", { class: "qopt__label", text: opt.label })]),
          ]);
          btn.addEventListener("click", () => onOptionClick(q, qi, opt.label, btn, optButtons));
          optButtons.push(btn);
          optWrap.append(btn);
        });

        // Implicit "Other…" free-text (always offered; not part of options).
        const otherInput = el("input", {
          class: "input qcard__other-input", type: "text",
          id: labelId + "-other", name: labelId + "-other",
          placeholder: "Type another answer…",
          "aria-label": "Other answer for: " + q.header,
          hidden: true,
        });
        const otherBtn = el("button", {
          class: "qopt qopt--other", type: "button",
          role: q.multiSelect ? "checkbox" : "radio",
          "aria-checked": "false", dataset: { selected: "false" },
        }, [
          el("span", { class: "qopt__check", "aria-hidden": "true" }, [icon("i-check")]),
          el("span", { class: "qopt__text" }, [el("span", { class: "qopt__label", text: "Other…" })]),
        ]);
        otherBtn.addEventListener("click", () => onOtherClick(q, qi, otherBtn, otherInput, optButtons));
        otherInput.addEventListener("input", () => {
          qStates[qi].otherText = otherInput.value;
          if (otherInput.value && otherBtn.dataset.selected !== "true") markSelected(otherBtn, true);
          else if (!otherInput.value && q.multiSelect && otherBtn.dataset.selected === "true") markSelected(otherBtn, false);
          syncSubmitState();
        });
        otherInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); if (!submitBtn.disabled) doSubmit(); }
        });
        optWrap.append(otherBtn, otherInput);

        // Roving tabindex + arrow keys (standard radiogroup pattern).
        const roving = [...optButtons, otherBtn];
        roving.forEach((b, i) => b.setAttribute("tabindex", i === 0 ? "0" : "-1"));
        optWrap.addEventListener("keydown", (e) => {
          if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) return;
          const idx = roving.indexOf(document.activeElement);
          if (idx === -1) return;
          e.preventDefault();
          const delta = (e.key === "ArrowDown" || e.key === "ArrowRight") ? 1 : -1;
          const next = roving[(idx + delta + roving.length) % roving.length];
          roving.forEach((b) => b.setAttribute("tabindex", "-1"));
          next.setAttribute("tabindex", "0");
          next.focus();
        });

        return { node: el("div", { class: "qcard__block" }, [qText, optWrap]), optButtons, otherBtn, otherInput };
      }

      function markSelected(btn, on) {
        btn.dataset.selected = String(on);
        btn.setAttribute("aria-checked", String(on));
      }

      function onOptionClick(q, qi, label, btn, optButtons) {
        if (settled) return;
        const st = qStates[qi];
        const blockNode = qNodes[qi];
        if (q.multiSelect) {
          const now = btn.dataset.selected !== "true";
          markSelected(btn, now);
          if (now) st.selected.add(label); else st.selected.delete(label);
        } else {
          st.selected.clear();
          optButtons.forEach((b) => markSelected(b, false));
          markSelected(blockNode.otherBtn, false);
          markSelected(btn, true);
          st.selected.add(label);
          st.otherText = "";
          blockNode.otherInput.value = "";
          blockNode.otherInput.hidden = true;
        }
        maybeImmediateSubmit();
        syncSubmitState();
      }

      function onOtherClick(q, qi, otherBtn, otherInput, optButtons) {
        if (settled) return;
        const st = qStates[qi];
        const turningOn = otherBtn.dataset.selected !== "true";
        if (q.multiSelect) {
          markSelected(otherBtn, turningOn);
          otherInput.hidden = !turningOn;
          if (turningOn) otherInput.focus();
          else { st.otherText = ""; otherInput.value = ""; }
        } else {
          st.selected.clear();
          optButtons.forEach((b) => markSelected(b, false));
          markSelected(otherBtn, true);
          otherInput.hidden = false;
          otherInput.focus();
        }
        st.otherText = otherInput.value;
        syncSubmitState();
      }

      function maybeImmediateSubmit() {
        if (questions.length !== 1) return;
        const q = questions[0];
        if (q.multiSelect) return;
        if (qNodes[0].otherBtn.dataset.selected === "true") return;
        if (qStates[0].selected.size === 1) doSubmit();
      }

      function answerForQuestion(q, qi) {
        const st = qStates[qi];
        const selected = Array.from(st.selected);
        const otherActive = qNodes[qi].otherBtn.dataset.selected === "true";
        const other = otherActive && st.otherText.trim() ? st.otherText.trim() : null;
        if (selected.length === 0 && !other) return null;
        const out = { header: q.header, selected };
        if (other) out.other_text = other;
        return out;
      }

      function isComplete() {
        return questions.every((q, qi) => answerForQuestion(q, qi) !== null);
      }

      function syncSubmitState() {
        submitBtn.disabled = settled || !isComplete();
      }

      function doSubmit() {
        if (settled || !isComplete()) { syncSubmitState(); return; }
        const answers = questions.map((q, qi) => answerForQuestion(q, qi));
        collapseAnswered(answers);
        finish(answers, null);
      }

      function collapseAnswered(answers) {
        node.dataset.state = "answered";
        node.setAttribute("aria-label", "Answered");
        body.replaceChildren(el("div", { class: "qcard__summary" }, [
          el("span", { class: "qcard__sum-icon", "aria-hidden": "true" }, [icon("i-check")]),
          el("div", { class: "qcard__sum-body" }, answers.map((a) => {
            const chosen = [...a.selected];
            if (a.other_text) chosen.push(a.other_text);
            return el("div", { class: "qcard__sum-row" }, [
              el("span", { class: "qcard__sum-head", text: a.header }),
              el("span", { class: "qcard__sum-val", text: chosen.join(", ") || "—" }),
            ]);
          })),
        ]));
      }

      function collapse(state, label) {
        node.dataset.state = state;
        node.setAttribute("aria-label", label);
        body.replaceChildren(el("div", { class: "qcard__expired" }, [
          icon(state === "cancelled" ? "i-close" : "i-alert"),
          el("span", { text: label }),
        ]));
      }

      const controller = {
        node,
        expire(kind) {
          if (kind === "cancelled") finish(null, "cancelled", "Turn stopped before this was answered.");
          else if (kind === "restart") finish(null, "expired", "The studio brain restarted — this question expired.");
          else finish(null, "expired", "This question expired — the editor moved on.");
        },
      };
      pendingCard = controller;

      // Mount: inside the live turn's stack when one is rendering, else at
      // the end of the log (the question still deserves a home). Mounting
      // inside a turn BREAKS the text run: the continuation after the answer
      // must start a fresh bubble BELOW the card — pre-question text, card,
      // and continuation render as three distinct blocks (.msg__stack's gap
      // provides the spacing), never one run-on paragraph.
      if (currentTurn) {
        currentTurn.stack.append(node);
        currentTurn.breakText();
      } else {
        logInner.append(node);
      }
      syncSubmitState();
      applyComposerState();
      scrollToBottom(true);   // an open question must be seen to be answered
      requestAnimationFrame(() => {
        const first = node.querySelector(".qopt");
        if (first) first.focus();
      });
    });
  }

  function expirePendingCard(kind) {
    if (!pendingCard) return;
    const card = pendingCard;
    pendingCard = null;
    card.expire(kind);
  }

  /* ---- bridge state hookups (wired by editor.js) -------------------------- */
  function setBridgeState(state) {
    if (state === "online") { setOffline(false); relaySeen(); }
    else if (state === "offline") setOffline(true);
    else if (state === "superseded") {
      applyComposerState("Another window took over this device's connection.");
    }
  }

  function notifyServerBootChange() {
    // Every relay-side Future and the model conversation died (arch §13).
    expirePendingCard("restart");
    if (streaming && stream) stream.cancel();
    dangling = false;
    if (currentTurn) {
      currentTurn.note("The studio brain restarted — say that again.");
      currentTurn.finish();
      currentTurn = null;
      currentTurnId = null;
    }
    applyComposerState();
  }

  /* ---- composer wiring ------------------------------------------------------ */
  function autosize() {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 132) + "px";
  }
  textarea.addEventListener("input", autosize);
  // Typing intent (M1.1 keyboard fix): focusing the composer re-pins the log
  // to the newest message. The rAF lets the keyboard-driven resize start
  // first; the log's ResizeObserver keeps the pin as the keyboard animates.
  // ONLY user-driven focus counts — the end-of-turn programmatic refocus
  // (focusComposer below) must not yank a reader who scrolled up. A tap on
  // an ALREADY-focused textarea fires no focus event, so pointerdown covers
  // that path (deliberately touching the composer is always typing intent).
  textarea.addEventListener("focus", () => {
    if (programmaticFocus) return;
    requestAnimationFrame(() => scrollToBottom(true));
  });
  textarea.addEventListener("pointerdown", () => {
    requestAnimationFrame(() => scrollToBottom(true));
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  composer.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  stopBtn.addEventListener("click", cancelTurn);

  /* ---- init ------------------------------------------------------------------ */
  const ready = (async () => {
    await loadTranscript();
    if (destroyed) return;
    renderTranscript();
    applyComposerState();
    // Editor (re-)entry catch-up — ONLY when the pending-turn marker says a
    // turn may have been missed (set at send, cleared at turn_end; survives
    // reload/lock). after_seq=0 replays the most-recent turn; known turn_ids
    // are consumed silently; 404 = it aged out (marker cleared). (§7.2 step 8)
    if (hasPendingMarker()) attach(0, { silentIfKnown: true });
  })();

  return {
    ready,
    askUser,
    setBridgeState,
    notifyServerBootChange,
    destroy() {
      destroyed = true;
      if (stream) { stream.cancel(); stream = null; }
      expirePendingCard("ended");
      if (logResizeObserver) logResizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

function isNetworkish(err) {
  if (!err) return false;
  const status = typeof err.status === "number" ? err.status : null;
  const code = err.code;
  return status === 0 && (code === "network" || code === "stream" || code === "timeout");
}

/* =============================================================================
   Light markdown → safe DOM (v1 pattern verbatim in spirit — paragraphs,
   **bold**, `inline code`, ```fenced``` blocks; never innerHTML).
============================================================================= */
function renderMarkdownInto(container, text) {
  container.replaceChildren();
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = part.replace(/^[a-zA-Z0-9_-]*\n/, "");
      pre.append(code);
      container.append(pre);
    } else {
      for (const para of part.split(/\n{2,}/)) {
        if (para.trim() === "") continue;
        const p = document.createElement("p");
        appendInline(p, para);
        container.append(p);
      }
    }
  });
}

function appendInline(parent, text) {
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
