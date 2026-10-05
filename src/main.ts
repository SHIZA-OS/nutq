import "./style.css";
import { Transcriber, type VADThresholdOptions } from "./vendor/transcriber";
import { micConstraints } from "./mic-constraints";
import { TurnPolicy, endHint, transcriptToSend, waitFromParams } from "./turn-policy";
import { MIC_REARM_MS, REPLY_TIMEOUT_MS, ReplyState } from "./turn-state";
import { pickVoice, speechText, ttsErrorEvent, voiceLines } from "./voice";
import { browserEngine } from "./tts-engine";
import { SentenceSplitter } from "./sentence-splitter";
import { replyPrefix, speakable } from "./speech-text";
import { SpeechQueue, type SpeechEvent } from "./speech-queue";

// Starting point only, not calibrated: stricter than vad-web's v5 defaults
// (positiveSpeechThreshold 0.5, negativeSpeechThreshold 0.35, minSpeechFrames 9,
// redemptionFrames 24) to cut down on background noise misfiring as speech.
// Real tuning needs the eval harness's WER metric once it exists (see
// docs/eval-harness-design.md) to check this isn't also dropping real speech.
const VAD_OPTIONS: VADThresholdOptions = {
  positiveSpeechThreshold: 0.65,
  minSpeechFrames: 12,
};

// Frames of audio from just before the VAD fires that are prepended to the recording on every
// speech start. One frame is 512 samples at 16 kHz = 32 ms, so 4 frames = 128 ms. This includes
// the frame that crossed the threshold, which is otherwise never recorded. First pass, not
// calibrated: eval/runner/vad-onset.mjs on the 37 recorded cases needed 2 frames to reach the
// energy onset (3 in the worst clean case), so 4 leaves one frame of margin for soft onsets.
const PRE_ROLL_FRAMES = 4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const wsUrlInput = $<HTMLInputElement>("ws-url");
const agentAliasInput = $<HTMLInputElement>("agent-alias");
const authTokenInput = $<HTMLInputElement>("auth-token");
const connectBtn = $<HTMLButtonElement>("connect-btn");
const connStatus = $<HTMLSpanElement>("conn-status");
const pairCodeInput = $<HTMLInputElement>("pair-code");
const pairBtn = $<HTMLButtonElement>("pair-btn");
const pairStatus = $<HTMLSpanElement>("pair-status");
const pairFallback = $<HTMLDivElement>("pair-fallback");
const pairFallbackCurl = $<HTMLPreElement>("pair-fallback-curl");
const pairFallbackTokenInput = $<HTMLInputElement>("pair-fallback-token");
const pairFallbackSaveBtn = $<HTMLButtonElement>("pair-fallback-save-btn");
const micBtn = $<HTMLButtonElement>("mic-btn");
const micStatus = $<HTMLSpanElement>("mic-status");
const liveTranscriptEl = $<HTMLDivElement>("live-transcript");
const committedTranscriptEl = $<HTMLDivElement>("committed-transcript");
const replyBoxEl = $<HTMLDivElement>("reply-box");
const logEl = $<HTMLPreElement>("log");

function log(msg: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(el: HTMLSpanElement, text: string, kind: "idle" | "ok" | "error" | "warn") {
  el.textContent = text;
  el.className = `status status-${kind}`;
}

// --- Eval instrumentation (docs/eval-harness-design.md section 4) ------
// Structured timestamp events for staged-latency measurement. Uses Date.now()
// to match the timestamping already used by log(), rather than introducing a
// second (performance.now()) convention.

type EvalEvent =
  | "mic_button_press"
  | "mic_button_release"
  | "mic_press_ignored"
  | "session_start"
  | "speech_start"
  | "pre_roll"
  | "speech_end"
  | "vad_misfire"
  | "endpoint"
  | "stt_committed"
  | "stt_error"
  | "stt_model_call"
  | "mic_settings"
  | "transcript_final"
  | "send_skipped"
  | "send_held"
  | "held_sent"
  | "held_dropped"
  | "stt_model"
  | "ws_message_sent"
  | "first_chunk_received"
  | "done_received"
  | "tts_requested"
  | "tts_start"
  | "tts_sentence_start"
  | "speech_text"
  | "tts_dropped"
  | "tts_text_mismatch"
  | "tts_muted"
  | "tts_skipped"
  | "tts_end"
  | "tts_error"
  | "tts_cancelled"
  | "turn_timeout"
  | "ws_error"
  | "ws_closed"
  | "turn_error_frame"
  | "turn_aborted"
  | "js_error";

type EvalEventRecord = { event: EvalEvent; timestamp_ms: number; [extra: string]: unknown };

// Kept in memory (not just the log panel's text) so the events can be
// exported as real JSONL. Only filled when ?eval=1 is set, otherwise it
// would grow unbounded for the lifetime of every ordinary session.
const urlParams = new URLSearchParams(window.location.search);
// Eval mode and everything gated on it (the eval-only params below, the events, the export button) exist only outside
// production builds: import.meta.env.PROD is a build-time constant, so `vite build` drops that code and its strings.
const isEvalMode = !import.meta.env.PROD && urlParams.get("eval") === "1";
// Eval-only: enables the mic button without a gateway and skips the send, so
// WER runs never touch ZeroClaw. Does nothing unless eval=1 is also set.
const isNoSend = isEvalMode && urlParams.get("nosend") === "1";
// Eval-only: ?rawmic=1 opens the mic with echo cancellation, noise suppression and auto gain off.
const isRawMic = isEvalMode && urlParams.get("rawmic") === "1";
const DEFAULT_MODEL = "model/base";
// Eval-only: ?model= picks the Moonshine model. model.ts only sets the layer/head
// shape for URLs containing "tiny" or "base", so anything else would load with
// an undefined shape; reject it up front instead.
const sttModel = (isEvalMode && urlParams.get("model")) || DEFAULT_MODEL;
const sttModelValid = sttModel.includes("tiny") || sttModel.includes("base");
const evalEvents: EvalEventRecord[] = [];

function logEvent(event: EvalEvent, extra?: Record<string, unknown>) {
  if (import.meta.env.PROD) return; // empty in a production build, so the minifier drops every call and its event name
  const record: EvalEventRecord = { event, timestamp_ms: Date.now(), ...extra };
  if (isEvalMode) evalEvents.push(record);
  log(`EVENT ${JSON.stringify(record)}`);
}

// Uncaught JS errors were previously invisible to the eval harness entirely
// (no log() call, no logEvent). These are the only global catch-all; a
// caught error already logged by its own call site is not re-logged here.
window.onerror = (message) => {
  logEvent("js_error", { message: String(message) });
};
window.addEventListener("unhandledrejection", (ev) => {
  logEvent("js_error", { message: String(ev.reason) });
});

// Export button: hidden by default, only shown for eval harness runs
// (?eval=1) so ordinary users never see internal instrumentation UI.
const evalDownloadBtn = isEvalMode ? $<HTMLButtonElement>("eval-download-btn") : null;
if (evalDownloadBtn) {
  evalDownloadBtn.hidden = false;
}

// The mic is only usable once the model and VAD are loaded (the mic never opens
// before that, so no speech is lost to a load) and there is somewhere to send:
// an open socket, or nosend eval mode.
let modelState: "idle" | "loading" | "ready" | "failed" = sttModelValid ? "idle" : "failed";
let socketOpen = false;
let loadPromise: Promise<void> | null = null;
const micHint = $<HTMLParagraphElement>("mic-hint");
const retryModelBtn = $<HTMLButtonElement>("retry-model-btn");
const envNote = $<HTMLParagraphElement>("env-note");

// What the first-time user is told when something is missing or goes wrong.
const MODEL_LOADING = "Loading the speech model (about 63 MB). This happens only on first use; your browser keeps it for next time.";
const MODEL_LOAD_FAILED = "The speech model could not be loaded. This is usually a network problem or a blocked download, so check the connection and any content blocker, then try again.";
const NO_WASM = "This browser has no WebAssembly support, so the speech model cannot run. Use a current desktop browser.";
const NO_SPEECH = "This browser has no speech synthesis, so replies are shown as text and not spoken.";
const MIC_BLOCKED = "Microphone access is blocked. Allow the microphone for this site in your browser, then tap the button again.";
const MIC_INSECURE = "The microphone needs a secure page: open this app over https, or on localhost.";
const MIC_MISSING = "No microphone was found. Connect one, then tap the button again.";
// Why the model is not usable, shown as the hint once its state is "failed"; null for the eval-only invalid model.
let loadProblem: string | null = null;

function updateMicState() {
  micBtn.disabled = !(modelState === "ready" && (socketOpen || isNoSend));
  retryModelBtn.hidden = loadProblem !== MODEL_LOAD_FAILED; // only a failed download is worth retrying
  micHint.textContent =
    notice ??
    (held
      ? "Will send when the answer finishes"
      : modelState === "failed"
      ? (loadProblem ?? "Speech model unavailable")
      : modelState === "idle"
        ? "Connect to load the speech model"
        : modelState === "loading"
          ? MODEL_LOADING
          : micBtn.disabled
            ? "Connect to start listening"
            : "Tap to start listening");
}

if (!sttModelValid) {
  const msg = `Invalid model "${sttModel}": must contain "tiny" or "base"`;
  setStatus(micStatus, msg, "error");
  log(msg);
} else if (isEvalMode) {
  logEvent("stt_model", { model: sttModel });
}

if (evalDownloadBtn) {
  evalDownloadBtn.addEventListener("click", () => {
    const jsonl = evalEvents.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const blob = new Blob([jsonl], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nutq-events-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
    log(`Downloaded ${evalEvents.length} events as JSONL`);
  });
}

let socket: WebSocket | null = null;
let replyBuffer = "";
// Whether a reply is in flight (src/turn-state.ts): a message sent mid-turn is steering, not a new turn, so
// nothing is sent until the running turn ends.
const replyState = new ReplyState();
let replyTimer: ReturnType<typeof setTimeout> | null = null;
// An utterance that finished while a reply was in flight, waiting for the turn to end (see sendTranscript and sendHeld).
// At most one: a later utterance is appended. `at` is when the first part was held. The hint under the mic button shows it.
let held: { text: string; at: number } | null = null;
// A one-off line for the hint under the mic button, shown over the others until the next connect or mic press.
let notice: string | null = null;

// Keeps one timer in step with the reply state: it exists exactly while a reply is in flight, so every normal
// clear (a done, an abort, a turn-failure error, a closed socket) cancels it just by calling this. If it fires,
// the turn is given up on (replyTimedOut) so the user is not blocked forever.
function syncReplyTimer() {
  if (replyTimer !== null) {
    clearTimeout(replyTimer);
    replyTimer = null;
  }
  const at = replyState.timesOutAt();
  if (at === null) return;
  replyTimer = setTimeout(() => {
    replyTimer = null;
    if (replyState.tick(at)) replyTimedOut();
  }, Math.max(0, at - Date.now()));
}

// No frame ended the turn in REPLY_TIMEOUT_MS. The gateway has no turn id, so a late done could clear the flag of the next turn,
// and ZeroClaw may still be running the old turn, so any new message on this connection would be steering. So the socket is
// closed (ZeroClaw then takes its cancel path), speech is cancelled, a held message is dropped, and the page connects once more
// with the stored token (connect() reads the same inputs; the model load is reused). The old socket is let go of first, so
// whatever it still delivers is ignored (see connect()). If the reconnect fails the state is the ordinary disconnected one.
function replyTimedOut() {
  log(`WARNING: no reply ended the turn after ${REPLY_TIMEOUT_MS / 1000} s, closing the connection and connecting again once.`);
  logEvent("turn_timeout", { ms: REPLY_TIMEOUT_MS });
  cancelSpeech();
  dropHeld("timeout");
  const old = socket;
  socket = null;
  socketOpen = false;
  updateMicState(); // no connection until the new one opens
  old?.close();
  reconnectedAfterTimeout = true;
  connect();
}

// Set by replyTimedOut(), taken by the next connect() so only that socket reports "Answer timed out, reconnected".
let reconnectedAfterTimeout = false;

// The reply state changed to "not in flight" (an ending frame or a close): drop the timer.
function replyEnded() {
  syncReplyTimer();
  updateMicState();
}
let receivedSessionStart = false;
let receivedFirstChunkThisTurn = false;

function buildWsUrl(): string {
  const base = wsUrlInput.value.trim();
  const url = new URL(base);
  const alias = agentAliasInput.value.trim();
  const token = authTokenInput.value.trim();
  if (alias) url.searchParams.set("agent", alias);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

// --- Pairing -----------------------------------------------------------

function deriveHttpBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  let pathname = url.pathname;
  if (pathname.endsWith("/ws/chat")) {
    pathname = pathname.slice(0, -"/ws/chat".length);
  }
  return `${protocol}//${url.host}${pathname}`;
}

function pairingStorageKey(gatewayUrl: string): string {
  return `nutq:pairing-token:${gatewayUrl}`;
}

// Show/Hide toggle for a masked (type=password) token field. Returns a reset
// that re-masks the field, so a revealed state never carries over to the next value.
function wireRevealToggle(input: HTMLInputElement, toggle: HTMLButtonElement, noun: string) {
  const setRevealed = (reveal: boolean) => {
    input.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(reveal));
    toggle.setAttribute("aria-label", `${reveal ? "Hide" : "Show"} ${noun}`);
  };
  toggle.addEventListener("click", () => setRevealed(input.type === "password"));
  return () => setRevealed(false);
}

wireRevealToggle(authTokenInput, $<HTMLButtonElement>("auth-token-toggle"), "pairing token");
const remaskFallbackToken = wireRevealToggle(
  pairFallbackTokenInput,
  $<HTMLButtonElement>("pair-fallback-token-toggle"),
  "pasted token",
);

// True while the token field holds a value we filled in ourselves (from
// storage or a fresh pairing), rather than something the user typed. Used to
// decide whether to clear it when the gateway URL changes.
let tokenAutoFilled = false;

function setAuthToken(token: string) {
  authTokenInput.value = token;
  tokenAutoFilled = true;
}

function savePairingToken(gatewayUrl: string, token: string) {
  localStorage.setItem(pairingStorageKey(gatewayUrl), token);
  setAuthToken(token);
}

function showPairFallback(httpBase: string, code: string) {
  pairFallbackCurl.textContent = `curl -X POST ${httpBase}/pair -H "X-Pairing-Code: ${code}"`;
  pairFallback.hidden = false;
}

function hidePairFallback() {
  pairFallback.hidden = true;
  pairFallbackTokenInput.value = "";
  remaskFallbackToken();
}

pairFallbackSaveBtn.addEventListener("click", () => {
  const token = pairFallbackTokenInput.value.trim();
  if (!token) {
    log("Paste the token from the curl output before saving.");
    return;
  }
  const gatewayUrl = wsUrlInput.value.trim();
  savePairingToken(gatewayUrl, token);
  setStatus(pairStatus, "paired (manual)", "ok");
  log(`Saved manually-pasted pairing token for ${gatewayUrl}`);
  hidePairFallback();
});

function loadSavedTokenForCurrentUrl() {
  const gatewayUrl = wsUrlInput.value.trim();
  if (!gatewayUrl) return;
  const saved = localStorage.getItem(pairingStorageKey(gatewayUrl));
  if (saved) {
    setAuthToken(saved);
    setStatus(pairStatus, "paired (saved token)", "ok");
    log(`Auto-filled saved pairing token for ${gatewayUrl}`);
  }
}

wsUrlInput.addEventListener("change", () => {
  hidePairFallback();
  if (tokenAutoFilled) {
    authTokenInput.value = "";
    tokenAutoFilled = false;
    setStatus(pairStatus, "not paired", "warn");
    log("Gateway URL changed: cleared the previous pairing token, it's only valid for the instance it was paired with.");
  }
  loadSavedTokenForCurrentUrl();
});

authTokenInput.addEventListener("input", () => {
  tokenAutoFilled = false;
});

async function pair() {
  const code = pairCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    setStatus(pairStatus, "invalid code", "error");
    log("Pairing code must be exactly 6 digits.");
    return;
  }

  let httpBase: string;
  try {
    httpBase = deriveHttpBase(wsUrlInput.value.trim());
  } catch (e) {
    setStatus(pairStatus, "invalid url", "error");
    log(`Cannot derive pairing URL from gateway URL: ${e}`);
    return;
  }

  setStatus(pairStatus, "pairing…", "idle");
  log(`Pairing with ${httpBase}/pair`);
  hidePairFallback();

  let response: Response;
  try {
    response = await fetch(`${httpBase}/pair`, {
      method: "POST",
      headers: { "X-Pairing-Code": code },
    });
  } catch (e) {
    setStatus(pairStatus, "manual pairing needed", "error");
    log(
      `Pairing request failed: ${e}. This is most commonly a cross-origin (CORS) restriction ` +
        "the browser enforces when this page and the gateway are on different origins; the " +
        "browser doesn't expose the specific reason to JavaScript, so any fetch failure here " +
        "is treated the same way. Falling back to a manual pairing command below.",
    );
    showPairFallback(httpBase, code);
    return;
  }

  let body: any;
  try {
    body = await response.json();
  } catch (e) {
    setStatus(pairStatus, "error", "error");
    log(`Pairing response was not valid JSON: ${e}`);
    return;
  }

  if (response.status === 200 && body.paired && body.token) {
    const gatewayUrl = wsUrlInput.value.trim();
    savePairingToken(gatewayUrl, body.token);
    setStatus(pairStatus, "paired", "ok");
    log(`Paired successfully: ${body.message ?? "token saved"}`);
    return;
  }

  if (response.status === 403) {
    setStatus(pairStatus, "invalid code", "error");
    log(`Pairing rejected: ${body.error ?? "invalid pairing code"}`);
    return;
  }

  if (response.status === 429) {
    const retryAfter = body.retry_after != null ? ` (retry after ${body.retry_after}s)` : "";
    setStatus(pairStatus, "rate limited", "error");
    log(`Pairing rate limited: ${body.error ?? "too many attempts"}${retryAfter}`);
    return;
  }

  setStatus(pairStatus, "error", "error");
  log(`Pairing failed: ${body.message ?? body.error ?? `unexpected response (HTTP ${response.status})`}`);
}

pairBtn.addEventListener("click", () => {
  pair();
});

// For display only (log panel + console via log()): never the URL actually
// used to connect. Keeps a short prefix of the token so the log still shows
// which token was used, without exposing the full bearer value. A plain
// string replace, not URLSearchParams.set(), which would percent-encode the
// "…" into an unreadable "%E2%80%A6".
function redactedUrlForDisplay(url: string): string {
  const parsed = new URL(url);
  const token = parsed.searchParams.get("token");
  if (!token) return url;
  return url.replace(`token=${encodeURIComponent(token)}`, `token=${token.slice(0, 3)}…REDACTED`);
}

function connect() {
  const afterTimeout = reconnectedAfterTimeout; // taken first, so a connect that fails early does not leave it for the next one
  reconnectedAfterTimeout = false;
  let url: string;
  try {
    url = buildWsUrl();
  } catch (e) {
    log(`Invalid WebSocket URL: ${e}`);
    setStatus(connStatus, "invalid url", "error");
    return;
  }

  ensureModelLoaded(); // in parallel with the connection; reuses an in-flight or finished load
  log(`Connecting to ${redactedUrlForDisplay(url)}`);
  setStatus(connStatus, "connecting…", "idle");
  receivedSessionStart = false;
  // Every handler ignores a socket that is no longer `socket`: one let go of after a timeout can still deliver a frame or its
  // close, and they must not touch the connection that replaced it (its status, its in-flight flag, its speech).
  const sock = new WebSocket(url);
  socket = sock;

  sock.onopen = () => {
    if (sock !== socket) return;
    log("WebSocket open");
    setStatus(connStatus, afterTimeout ? "Answer timed out, reconnected" : "connected", "ok");
    socketOpen = true;
    if (!afterTimeout) notice = null; // after a timeout the notice (a dropped message) stays until the next mic press
    updateMicState();
  };

  sock.onmessage = (ev) => {
    if (sock !== socket) return;
    let parsed: any;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      log(`Non-JSON frame from server: ${ev.data}`);
      return;
    }

    const muted = replyState.muted; // read before frame(): a done clears the mute with the flag
    const turnEnded = replyState.frame(parsed); // done, aborted and a turn-failure error end the turn
    if (turnEnded) replyEnded();
    if (turnEnded && parsed.type === "error" && speechQueue) cancelSpeech(); // flag on: a failed turn is not read out

    switch (parsed.type) {
      case "session_start":
        receivedSessionStart = true;
        log(`Session started (resumed=${parsed.resumed}, session_id=${parsed.session_id})`);
        logEvent("session_start", { session_id: parsed.session_id ?? null, resumed: parsed.resumed ?? null });
        break;
      case "connected":
        log("Server acknowledged connect frame");
        break;
      case "chunk":
        if (!receivedFirstChunkThisTurn) {
          receivedFirstChunkThisTurn = true;
          logEvent("first_chunk_received");
        }
        replyBuffer += parsed.content ?? "";
        replyBoxEl.textContent = replyBuffer;
        // Flag on: each sentence is queued as it closes. Only chunk frames are spoken, never thinking, tool or plan frames.
        if (speechQueue && muted) {
          // The mic was tapped during this reply: its later chunks are shown but not spoken. Reported once per turn.
          if (replyState.firstMutedChunk()) logEvent("tts_muted", { reason: "mic_press", point: "chunk", chars: String(parsed.content ?? "").length });
        } else if (speechQueue) {
          streamedChunks += parsed.content ?? "";
          for (const sentence of splitter.push(parsed.content ?? "")) queueSpeech(sentence);
        }
        break;
      case "done": {
        logEvent("done_received");
        replyBuffer = parsed.full_response ?? replyBuffer;
        replyBoxEl.textContent = replyBuffer;
        log(`Reply complete (${parsed.tokens_used ?? "?"} tokens)`);
        if (muted) skipMutedSpeech();
        else if (speechQueue) finishStreamedSpeech(parsed.full_response);
        else speak(replyBuffer);
        break;
      }
      case "aborted":
        cancelSpeech();
        log("Turn aborted by server");
        logEvent("turn_aborted");
        break;
      case "error":
        log(`Server error: ${parsed.message ?? JSON.stringify(parsed)}`);
        logEvent("turn_error_frame", { message: parsed.message ?? null });
        break;
      case "approval_request": {
        const tool = parsed.tool ?? "(unknown tool)";
        const argsSummary = parsed.arguments_summary ?? "(no summary)";
        log(
          `Approval requested: tool="${tool}" args="${argsSummary}" ` +
            `(request_id=${parsed.request_id}, timeout_secs=${parsed.timeout_secs}). ` +
            `Auto-denying: Nutq never auto-approves tool calls.`,
        );
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(
            JSON.stringify({
              type: "approval_response",
              request_id: parsed.request_id,
              decision: "deny",
            }),
          );
        }
        break;
      }
      case "tool_call":
        log(`Tool call: ${parsed.name ?? "?"} (id=${parsed.id}) args=${JSON.stringify(parsed.args)}`);
        dropUnheardSpeech("tool_call");
        break;
      case "tool_result":
        log(`Tool result: ${parsed.name ?? "?"} (id=${parsed.id}) output=${JSON.stringify(parsed.output)}`);
        break;
      case "thinking":
        log(`Thinking: ${parsed.content ?? ""}`);
        break;
      case "plan":
        log(`Plan: ${JSON.stringify(parsed.entries ?? [])}`);
        break;
      default:
        log(`Unhandled frame type "${parsed.type}": ${ev.data}`);
    }
    // After the frame is handled, so its events and its reply belong to the turn it ended, not to the one sent now.
    if (turnEnded) sendHeld(parsed.type);
  };

  sock.onerror = () => {
    if (sock !== socket) return;
    log("WebSocket error");
    logEvent("ws_error");
    setStatus(connStatus, "error", "error");
  };

  sock.onclose = (ev) => {
    if (sock !== socket) return;
    log(`WebSocket closed (code=${ev.code} reason="${ev.reason}")`);
    logEvent("ws_closed", {
      code: ev.code,
      reason: ev.reason,
      received_session_start: receivedSessionStart,
    });
    if (ev.code === 1006 && !receivedSessionStart) {
      log(
        "Connection closed immediately, possibly an authentication rejection: if you have a " +
          "saved pairing token, it may be invalid, expired, or the instance may not require " +
          "pairing at all. Try re-pairing or check with your ZeroClaw operator.",
      );
    }
    setStatus(connStatus, "disconnected", "warn");
    dropHeld("closed");
    replyState.closed();
    replyEnded();
    cancelSpeech();
    socketOpen = false;
    updateMicState();
    socket = null;
  };
}

// The reply style (src/speech-text.ts): by default a thorough answer written as speech; ?reply=short is the original short prefix.
const reply = replyPrefix(urlParams.get("reply"));

// "held" is a message that waited for the turn in flight to end (sendHeld); the utterance's own trigger is not kept.
type SendTrigger = "manual" | "auto_silence" | "held";

// The mic re-arm window (MIC_REARM_MS in src/turn-state.ts). A press that would start listening is ignored from the moment
// listening ends (a manual release or the auto_silence trigger) until MIC_REARM_MS after the send. Between the two,
// finishListening() is in stop(), the final transcription, and a press there would start a second utterance and send with
// listening true again. `finishing` is that stretch: it is closed by whatever ends finishListening() (a send, a send_skipped,
// a blocked or refused send, a throw), so a turn that sends nothing leaves no window and the user can retry at once.
let finishing = false;
let releasedAt: number | null = null; // when listening last ended
let lastSendAt: number | null = null; // when the last message went out (any trigger); null before the first send

function sendTranscript(text: string, trigger: SendTrigger) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("Cannot send: not connected");
    return;
  }
  if (!replyState.trySend(Date.now())) {
    // A reply is in flight and a message sent now would be steering, merged into that turn. So it is held and goes out when
    // the turn ends (sendHeld). One held message at most: a later utterance is appended. The text is in transcript_final in
    // eval mode, so it is not repeated in the log.
    held = held ? { text: `${held.text} ${text}`, at: held.at } : { text, at: Date.now() };
    log("A reply is still in progress, so this utterance is held and will be sent when it ends");
    logEvent("send_held", { chars: held.text.length }); // the length of the whole held message so far
    updateMicState();
    return;
  }
  syncReplyTimer();
  cancelSpeech();
  replyBuffer = "";
  replyBoxEl.textContent = "";
  receivedFirstChunkThisTurn = false;
  const frame = { type: "message", content: reply.prefix + text };
  socket.send(JSON.stringify(frame));
  lastSendAt = Date.now();
  logEvent("ws_message_sent", { send_trigger: trigger, reply_style: reply.style });
  log(`Sent (${trigger}): ${text}`);
}

// The turn in flight ended (done, aborted or a turn-failure error): send the held message, if any, as an ordinary message.
// This is the only place a held message goes out, and only after the ending frame cleared the in-flight flag.
function sendHeld(end: string) {
  if (!held) return;
  const { text, at } = held;
  held = null;
  logEvent("held_sent", { chars: text.length, waited_ms: Date.now() - at, end });
  sendTranscript(text, "held");
  // The user has the mic open again: the new answer is not read out over it, as for a reply the mic was tapped during.
  if (listening) replyState.mute();
  updateMicState();
}

// The held message will not be sent: the socket closed, or the turn timed out and the connection was dropped. Said in the log, as an
// event and in the hint under the mic button. Nothing to do when none is held.
function dropHeld(reason: "closed" | "timeout") {
  if (!held) return;
  log(reason === "closed" ? "The connection closed with a message waiting to be sent; it was not sent" : "The answer timed out with a message waiting to be sent; it was not sent");
  logEvent("held_dropped", { reason, chars: held.text.length });
  held = null;
  notice = reason === "closed" ? "Message not sent, the connection closed" : "Message not sent, the answer timed out";
}

// Voices load asynchronously in Chrome (getVoices() is empty until "voiceschanged"), so they are read at page
// load and again whenever the list changes, not first at speak time. ?voice=<exact name> picks one (any mode);
// the list is written to the log panel so a name can be copied from it.
const wantedVoice = urlParams.get("voice");
let voices: SpeechSynthesisVoice[] = [];
let loggedVoiceCount = -1;

function loadVoices() {
  voices = window.speechSynthesis.getVoices();
  if (voices.length === 0 || voices.length === loggedVoiceCount) return;
  loggedVoiceCount = voices.length;
  for (const line of voiceLines(voices)) log(line);
  const choice = pickVoice(voices, wantedVoice);
  if (wantedVoice && !choice.voice) log(`Voice "${wantedVoice}" not found, using the browser default`);
  log(`Reply voice: ${choice.voice?.name ?? "browser default"} (${choice.source})`);
}

if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

// The engine that speaks (src/tts-engine.ts); none when the browser has no speechSynthesis, and speak() says so.
const ttsEngine = "speechSynthesis" in window ? browserEngine(window.speechSynthesis, wantedVoice) : null;
if (!ttsEngine) {
  envNote.textContent = NO_SPEECH;
  envNote.hidden = false;
}

// A cancelled or interrupted utterance is tts_cancelled; any other error code (for example "synthesis-failed")
// is tts_error. `cancelledBy` is the reason reported when the code is "canceled": that is what the browser reports
// for our own cancel(), so the reason we gave it (see cancelSpeech) goes with it.
function logTtsError(code: string | undefined, cancelledBy = "canceled") {
  if (import.meta.env.PROD) return;
  const e = ttsErrorEvent(code);
  logEvent(e.event, e.event === "tts_cancelled" && code === "canceled" ? { reason: cancelledBy } : e.fields);
}

// Why speech was last cancelled (see cancelSpeech), for the browser's late "canceled" error on the flag-off path.
let cancelReason = "canceled";

// By default the reply is spoken sentence by sentence as its chunks arrive (src/sentence-splitter.ts feeds src/speech-queue.ts).
// ?tts_stream=0 opts out to the original flow: the whole reply spoken once at done. Without a speech engine neither does anything
// and speak() reports it. The "flag on" and "flag off" of the comments below mean streaming on (the default) and ?tts_stream=0.
const splitter = new SentenceSplitter();
let streamedChunks = ""; // the chunks of this turn so far, to compare with full_response at done
const speechQueue = urlParams.get("tts_stream") !== "0" && ttsEngine ? new SpeechQueue(ttsEngine, logSpeechEvent) : null;

function logSpeechEvent(e: SpeechEvent) {
  switch (e.type) {
    case "requested":
      logEvent("tts_requested", { index: e.index });
      break;
    case "start":
      // tts_start keeps its meaning: the first audible audio of the turn, once per turn.
      if (e.first) logEvent("tts_start", { ...e.info, engine: ttsEngine?.name });
      logEvent("tts_sentence_start", { index: e.index, units: e.units, chars: e.chars, ...(e.waited === undefined ? {} : { waited_ms: e.waited }) });
      break;
    case "end":
      logEvent("tts_end");
      break;
    case "error":
      logTtsError(e.code);
      break;
    case "cancelled":
      logEvent("tts_cancelled", { reason: cancelReason });
      break;
  }
}

// Stops speech that is playing or queued. Called when a new message is sent, when a turn is aborted, when the
// connection closes and when the mic button starts listening, so an old reply is not read out over what comes next.
// `reason` is what tts_cancelled reports; "canceled" is the default.
function cancelSpeech(reason = "canceled") {
  cancelReason = reason;
  splitter.reset();
  speechInCode = false;
  streamedChunks = "";
  if (speechQueue) {
    speechQueue.cancel(); // reports tts_cancelled itself, now
    cancelReason = "canceled";
  } else ttsEngine?.cancel(); // the browser reports it, later, through the utterance's error
}

// What the voice gets from a streamed unit: speakable() of it, or nothing when nothing is left (a code block, a rule).
// A unit can start inside a code block that an earlier unit opened, so that state is carried until the turn ends or is cancelled.
let speechInCode = false;

// speech_text: the length of a text before and after cleaning, for the eval (the text itself is not logged).
function logSpeechText(raw: string, spoken: string) {
  logEvent("speech_text", { raw_chars: raw.length, spoken_chars: spoken.length });
}

function queueSpeech(raw: string) {
  const cleaned = speakable(raw, speechInCode);
  speechInCode = cleaned.inCode;
  logSpeechText(raw, cleaned.text);
  if (cleaned.text !== "") speechQueue?.enqueue(cleaned.text);
}

// Flag on, a tool call frame: the text the agent streamed before it is not part of the answer (full_response holds only the
// last iteration), so what has not been heard yet is dropped: the unfinished text in the splitter, the queued units, and the
// utterance with the engine if its audio has not started. What is audible plays to its end, and chunks after the call are
// spoken as usual. A muted turn has nothing queued or buffered (the tap emptied both and later chunks are not queued), so
// this does nothing there and cannot unmute. The event is only for a drop that dropped something.
function dropUnheardSpeech(reason: string) {
  if (!speechQueue) return;
  const partial = splitter.pendingChars;
  splitter.reset();
  speechInCode = false;
  const dropped = speechQueue.drop();
  if (dropped.units > 0 || partial > 0) logEvent("tts_dropped", { reason, units: dropped.units, chars: dropped.chars, partial_chars: partial });
}

function speak(text: string) {
  const cleaned = speakable(text).text;
  logSpeechText(text, cleaned);
  const spoken = cleaned || null;
  if (spoken === null) {
    // An empty or whitespace-only reply is not spoken; say so instead of returning silently.
    logEvent("tts_skipped", { reason: "empty" });
    return;
  }
  if (!ttsEngine) {
    log("SpeechSynthesis not supported in this browser");
    logEvent("tts_skipped", { reason: "unsupported" });
    return;
  }
  cancelReason = "canceled";
  ttsEngine.speak(
    spoken,
    (info) => logEvent("tts_start", { ...info, engine: ttsEngine.name }),
    () => logEvent("tts_end"),
    (code) => logTtsError(code, cancelReason),
  );
}

// At done of a reply the mic was tapped during (both modes): nothing is spoken, not a tail, not the full_response
// fallback, and no speak(). `chars` is the trimmed reply, the total that went unspoken; none is not an event.
function skipMutedSpeech() {
  const chars = speechText(replyBuffer)?.length ?? 0;
  if (chars > 0) logEvent("tts_muted", { reason: "mic_press", point: "done", chars });
}

// Flag on, at done: queue what is left of the reply and end the turn. The speech comes from the chunks; if the two
// differ that is reported (tts_text_mismatch) and nothing is spoken again. The one exception is a turn in which no
// sentence was queued at all (no chunk frames came): then full_response is spoken once, through the same queue,
// so the reply is not silent. "At all" means since the last tool call: the text before it is not in full_response, so
// when nothing was queued after it (or all of it was dropped) full_response is the answer and is spoken.
function finishStreamedSpeech(fullResponse: unknown) {
  if (!speechQueue) return;
  const chunked = streamedChunks;
  streamedChunks = "";
  for (const tail of splitter.flush()) queueSpeech(tail);
  speechInCode = false;
  if (speechQueue.fresh === 0 && typeof fullResponse === "string") {
    const spoken = speakable(fullResponse).text;
    logSpeechText(fullResponse, spoken);
    if (spoken !== "") speechQueue.enqueue(spoken);
  }
  if (speechQueue.finish() === 0) logEvent("tts_skipped", { reason: "empty" });
  if (typeof fullResponse === "string" && fullResponse !== chunked) {
    logEvent("tts_text_mismatch", { chunks_chars: chunked.length, full_response_chars: fullResponse.length });
  }
}

connectBtn.addEventListener("click", () => {
  if (socket) {
    socket.close();
    return;
  }
  connect();
});

let transcriber: Transcriber | null = null;
let listening = false;
// Accumulates every onTranscriptionCommitted piece for the current
// press-to-release session. Sent once, on release, instead of per-commit;
// a mid-sentence pause no longer triggers its own send.
let sessionTranscript = "";

// When a turn ends, and why, is decided by TurnPolicy (src/turn-policy.ts); this file feeds it the
// events and the time, and owns the one JS timer that fires the auto-silence it asks for.
// Any mode: by default the delay depends on the transcript (see endHint in turn-policy.ts); ?silence=<ms> opts out to a
// fixed auto-silence delay (clamped to 800..8000; 5000 was the fixed default before the semantic one became the default).
const endpointWait = waitFromParams(urlParams.get("silence"));
const isSemantic = typeof endpointWait === "function";
let turn = new TurnPolicy(endpointWait);
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
// Commits (model calls that will add text) queued or running, from the Transcriber.
let commitsInFlight = 0;

// Semantic mode, while a wait is running: the hint and wait for the transcript as it is now, as an eval event.
// Logged when the wait is armed and each time the text or the in-flight count changes it.
function logEndpoint() {
  if (!isSemantic || turn.endsAt() === null) return;
  logEvent("endpoint", {
    hint: endHint(sessionTranscript),
    wait_ms: turn.wait(),
    text_chars: sessionTranscript.length,
    commits_in_flight: commitsInFlight,
  });
}

function clearSilenceTimer() {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}

// Replaces the timer with one for the policy's pending auto-silence, if it has one.
function scheduleSilenceTimer() {
  clearSilenceTimer();
  const at = turn.endsAt();
  if (at === null) return;
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    const end = turn.tick(at); // the timer fires at the deadline, so ask the policy at that time
    if (end) {
      log(`No speech for ${turn.wait()}ms, auto-sending`);
      finishListening(end.reason);
    }
  }, Math.max(0, at - Date.now()));
}

// Stops the transcriber, flushes any pending buffered audio (Transcriber.stop()
// in src/vendor/transcriber.ts forces a final commit), sends the full
// accumulated sessionTranscript once, and resets the button back to "Start
// listening". Shared by the manual button-release path and the automatic
// silence-timeout path so the stop/flush/send sequence lives in one place.
// trigger records which path called it, so ws_message_sent (and downstream
// eval reporting) can tell manual releases apart from silence auto-sends.
async function finishListening(trigger: Exclude<SendTrigger, "held">) {
  if (!listening) return;
  listening = false;
  finishing = true;
  releasedAt = Date.now();
  clearSilenceTimer();
  micBtn.textContent = "Start listening";
  try {
    await transcriber!.stop();
    // Logged even when empty: a total miss counts as data.
    if (isEvalMode) logEvent("transcript_final", { text: sessionTranscript, trigger });
    if (transcriptToSend(sessionTranscript) === null) {
      // Nothing was heard (empty or only whitespace): nothing goes to the gateway, and the UI is idle again.
      log(`Empty transcript (${trigger}), nothing sent`);
      logEvent("send_skipped", { reason: "empty_transcript", trigger });
      liveTranscriptEl.textContent = "";
    } else if (!isNoSend) {
      sendTranscript(sessionTranscript, trigger);
    }
    sessionTranscript = "";
  } finally {
    finishing = false; // after a send the window continues from lastSendAt; after a skip there is none
  }
}

function initTranscriber() {
  transcriber = new Transcriber(
    sttModel,
    {
      onPermissionsRequested() {
        log("Requesting microphone permission");
      },
      onError(error) {
        log(`Moonshine error: ${error}`);
        setStatus(micStatus, "error", "error");
      },
      onModelLoadStarted() {
        log("Moonshine model loading started");
      },
      onModelLoaded() {
        log("Moonshine model loaded");
        setStatus(micStatus, "ready", "ok");
      },
      onTranscribeStarted() {
        log("Transcription started");
        setStatus(micStatus, "listening…", "ok");
      },
      onTranscribeStopped() {
        log("Transcription stopped");
        setStatus(micStatus, "ready", "ok");
      },
      onSpeechStart(preRollFrames: number) {
        logEvent("speech_start");
        if (isEvalMode) logEvent("pre_roll", { frames: preRollFrames });
        turn.speechStart(Date.now());
        scheduleSilenceTimer();
      },
      onSpeechEnd() {
        logEvent("speech_end");
        turn.speechEnd(Date.now());
        scheduleSilenceTimer();
        logEndpoint();
      },
      onMisfire() {
        logEvent("vad_misfire");
        turn.misfire(Date.now());
        scheduleSilenceTimer();
        logEndpoint();
      },
      onModelError(path: string, message: string) {
        // The error is caught in the Transcriber, so the global js_error handler never sees it.
        logEvent("stt_error", { path, message });
      },
      onModelCall(info) {
        if (isEvalMode) logEvent("stt_model_call", info);
      },
      onTranscriptionUpdated(text: string) {
        liveTranscriptEl.textContent = text;
      },
      onTranscriptionCommitted(text: string) {
        logEvent("stt_committed", isEvalMode ? { text } : undefined);
        liveTranscriptEl.textContent = "";
        sessionTranscript = sessionTranscript ? `${sessionTranscript} ${text}` : text;
        committedTranscriptEl.textContent = sessionTranscript;
        log(`Committed transcript piece: "${text}" (accumulated: "${sessionTranscript}")`);
        if (isSemantic) {
          turn.transcript(sessionTranscript, Date.now()); // a running wait is recomputed and its timer re-armed
          scheduleSilenceTimer();
          logEndpoint();
        }
      },
      onCommitsInFlight(n: number) {
        commitsInFlight = n;
        if (isSemantic) {
          turn.setCommitsInFlight(n, Date.now());
          scheduleSilenceTimer();
          logEndpoint();
        }
      },
    },
    false, // useVAD=false -> streaming mode
    "quantized",
    VAD_OPTIONS,
    PRE_ROLL_FRAMES,
  );
}

// Loads the model and VAD once; later calls reuse the same load. Never opens the mic.
function ensureModelLoaded() {
  if (loadPromise || !sttModelValid) return;
  if (typeof WebAssembly === "undefined") {
    modelState = "failed";
    loadProblem = NO_WASM;
    setStatus(micStatus, "model unavailable", "error");
    log(NO_WASM);
    updateMicState();
    return;
  }
  modelState = "loading";
  loadProblem = null;
  setStatus(micStatus, "loading model…", "warn");
  if (!transcriber) initTranscriber(); // reused on retry
  loadPromise = transcriber!.load().then(
    () => {
      modelState = "ready";
      updateMicState();
    },
    (e) => {
      modelState = "failed";
      loadPromise = null; // the next Connect, or the Try again button, retries; the failed state stays visible until then
      loadProblem = MODEL_LOAD_FAILED;
      setStatus(micStatus, "model load failed", "error");
      log(`Model load failed: ${e}`);
      updateMicState();
    },
  );
  updateMicState();
}

// MicrophoneTranscriber used to do this getUserMedia + attachStream dance
// internally inside its own start(); the vendored base Transcriber has no
// getUserMedia of its own (see src/vendor/transcriber.ts), so it's ported
// here verbatim, same constraints, same permission-denied handling via the
// transcriber's own onError callback.
async function startMicrophone(t: Transcriber): Promise<string | null> {
  if (!navigator.mediaDevices) return MIC_INSECURE;
  // Not every browser can query the microphone permission; then the getUserMedia below finds out.
  const status = await navigator.permissions.query({ name: "microphone" as PermissionName }).catch(() => null);
  if (status?.state === "denied") return MIC_BLOCKED;
  try {
    t.callbacks.onPermissionsRequested();
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints(isEvalMode, isRawMic));
    // What Chrome actually applied, since a constraint can be ignored.
    const { echoCancellation, noiseSuppression, autoGainControl, sampleRate } = stream.getAudioTracks()[0]?.getSettings() ?? {};
    const applied = { echoCancellation, noiseSuppression, autoGainControl, sampleRate };
    log(`Mic settings: ${JSON.stringify(applied)}`);
    if (isEvalMode) logEvent("mic_settings", applied);
    t.attachStream(stream);
    await t.start();
    return null;
  } catch (e) {
    t.stop();
    log(`Microphone could not be started: ${e}`);
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") return MIC_BLOCKED;
    if (name === "NotFoundError") return MIC_MISSING;
    return `The microphone could not be started (${name ?? e}). Check that no other app is using it, then tap the button again.`;
  }
}

retryModelBtn.addEventListener("click", ensureModelLoaded);

micBtn.addEventListener("click", async () => {
  if (modelState !== "ready") return;
  const now = Date.now();
  const afterSend = lastSendAt !== null && now - lastSendAt < MIC_REARM_MS;
  if (!listening && (finishing || afterSend)) {
    // Not the user taking the floor: a double tap, or a press while the last utterance is still being finished. No
    // listening, no mute, no cancel. since_send_ms is null while finishing: this utterance has not been sent yet.
    logEvent("mic_press_ignored", {
      reason: "rearm",
      phase: finishing ? "finishing" : "after_send",
      since_release_ms: releasedAt === null ? null : now - releasedAt,
      since_send_ms: finishing || lastSendAt === null ? null : now - lastSendAt,
    });
    return;
  }
  if (!listening) {
    micBtn.textContent = "Stop listening";
    notice = null;
    updateMicState();
    listening = true;
    turn = new TurnPolicy(endpointWait);
    logEvent("mic_button_press");
    replyState.mute(); // a reply still arriving is not spoken either; ends with the turn (no effect if none is in flight)
    cancelSpeech("mic_press"); // the reply being read out stops when the user starts to speak
    sessionTranscript = "";
    const problem = await startMicrophone(transcriber!);
    if (problem) {
      listening = false;
      micBtn.textContent = "Start listening";
      notice = problem;
      setStatus(micStatus, "microphone unavailable", "error");
      updateMicState();
    }
  } else {
    logEvent("mic_button_release");
    await finishListening(turn.manualStop(Date.now()).reason);
  }
});

if (isEvalMode) ensureModelLoaded(); // eval: load at page load so a runner can wait for ready
updateMicState();
loadSavedTokenForCurrentUrl();
log("Page loaded. Configure the gateway URL/agent/token above, then Connect.");
