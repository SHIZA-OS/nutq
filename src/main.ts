import "./style.css";
import { Transcriber, type VADThresholdOptions } from "./vendor/transcriber";
import { micConstraints } from "./mic-constraints";
import { TurnPolicy, parseSilenceMs, transcriptToSend } from "./turn-policy";
import { pickVoice, voiceLines } from "./voice";

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
const evalDownloadBtn = $<HTMLButtonElement>("eval-download-btn");

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
  | "session_start"
  | "speech_start"
  | "pre_roll"
  | "speech_end"
  | "vad_misfire"
  | "stt_committed"
  | "stt_error"
  | "stt_model_call"
  | "mic_settings"
  | "transcript_final"
  | "send_skipped"
  | "stt_model"
  | "ws_message_sent"
  | "first_chunk_received"
  | "done_received"
  | "tts_start"
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
const isEvalMode = urlParams.get("eval") === "1";
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
if (isEvalMode) {
  evalDownloadBtn.hidden = false;
}

// The mic is only usable once the model and VAD are loaded (the mic never opens
// before that, so no speech is lost to a load) and there is somewhere to send:
// an open socket, or nosend eval mode.
let modelState: "idle" | "loading" | "ready" | "failed" = sttModelValid ? "idle" : "failed";
let socketOpen = false;
let loadPromise: Promise<void> | null = null;
const micHint = $<HTMLParagraphElement>("mic-hint");

function updateMicState() {
  micBtn.disabled = !(modelState === "ready" && (socketOpen || isNoSend));
  micHint.textContent =
    modelState === "failed"
      ? "Speech model unavailable"
      : modelState === "idle"
        ? "Connect to load the speech model"
        : modelState === "loading"
          ? "Loading the speech model, one moment"
          : micBtn.disabled
            ? "Connect to start listening"
            : "Tap to start listening";
}

if (!sttModelValid) {
  const msg = `Invalid model "${sttModel}": must contain "tiny" or "base"`;
  setStatus(micStatus, msg, "error");
  log(msg);
} else if (isEvalMode) {
  logEvent("stt_model", { model: sttModel });
}

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

let socket: WebSocket | null = null;
let replyBuffer = "";
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
  socket = new WebSocket(url);

  socket.onopen = () => {
    log("WebSocket open");
    setStatus(connStatus, "connected", "ok");
    socketOpen = true;
    updateMicState();
  };

  socket.onmessage = (ev) => {
    let parsed: any;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      log(`Non-JSON frame from server: ${ev.data}`);
      return;
    }

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
        break;
      case "done":
        logEvent("done_received");
        replyBuffer = parsed.full_response ?? replyBuffer;
        replyBoxEl.textContent = replyBuffer;
        log(`Reply complete (${parsed.tokens_used ?? "?"} tokens)`);
        speak(replyBuffer);
        break;
      case "aborted":
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
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(
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
  };

  socket.onerror = () => {
    log("WebSocket error");
    logEvent("ws_error");
    setStatus(connStatus, "error", "error");
  };

  socket.onclose = (ev) => {
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
    socketOpen = false;
    updateMicState();
    socket = null;
  };
}

const RESPONSE_STYLE_PREFIX =
  "Respond in 1-2 short, complete sentences, suitable for being spoken aloud. " +
  "Be concise but don't cut off mid-thought.\n\n";

type SendTrigger = "manual" | "auto_silence";

function sendTranscript(text: string, trigger: SendTrigger) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("Cannot send: not connected");
    return;
  }
  replyBuffer = "";
  replyBoxEl.textContent = "";
  receivedFirstChunkThisTurn = false;
  const frame = { type: "message", content: RESPONSE_STYLE_PREFIX + text };
  socket.send(JSON.stringify(frame));
  logEvent("ws_message_sent", { send_trigger: trigger });
  log(`Sent (${trigger}): ${text}`);
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
  if (wantedVoice && !pickVoice(voices, wantedVoice)) log(`Voice "${wantedVoice}" not found, using the browser default`);
}

if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

function speak(text: string) {
  if (!text) return;
  if (!("speechSynthesis" in window)) {
    log("SpeechSynthesis not supported in this browser");
    return;
  }
  if (voices.length === 0) voices = window.speechSynthesis.getVoices();
  const chosen = pickVoice(voices, wantedVoice);
  // With no voice chosen the browser picks (Chrome by language) and does not say which; the voice it flags as
  // default is the best guess, so the event records where the name came from.
  const used = chosen ?? voices.find((v) => v.default) ?? null;
  const utterance = new SpeechSynthesisUtterance(text);
  if (chosen) utterance.voice = chosen;
  utterance.onstart = () =>
    logEvent("tts_start", { voice: used?.name ?? null, local_service: used?.localService ?? null, voice_source: chosen ? "param" : "browser_default" });
  window.speechSynthesis.speak(utterance);
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
// Any mode: ?silence=<ms> sets the auto-silence delay (default 5000, clamped to 800..8000).
const silenceMs = parseSilenceMs(urlParams.get("silence"));
let turn = new TurnPolicy(silenceMs);
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

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
      log(`No speech for ${silenceMs}ms, auto-sending`);
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
async function finishListening(trigger: SendTrigger) {
  if (!listening) return;
  listening = false;
  clearSilenceTimer();
  micBtn.textContent = "Start listening";
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
        log("Moonshine model loading started (first run fetches WASM + weights from CDN)");
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
      },
      onMisfire() {
        logEvent("vad_misfire");
        turn.misfire(Date.now());
        scheduleSilenceTimer();
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
  modelState = "loading";
  setStatus(micStatus, "loading model…", "warn");
  if (!transcriber) initTranscriber(); // reused on retry
  loadPromise = transcriber!.load().then(
    () => {
      modelState = "ready";
      updateMicState();
    },
    (e) => {
      modelState = "failed";
      loadPromise = null; // the next Connect retries; the failed state stays visible until then
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
async function startMicrophone(t: Transcriber) {
  const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
  if (status.state === "denied") {
    t.callbacks.onError("Microphone permission denied");
    return;
  }
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
  } catch (e) {
    t.callbacks.onError(`Microphone permission denied: ${e}`);
    t.stop();
  }
}

micBtn.addEventListener("click", async () => {
  if (modelState !== "ready") return;
  if (!listening) {
    micBtn.textContent = "Stop listening";
    listening = true;
    turn = new TurnPolicy(silenceMs);
    logEvent("mic_button_press");
    sessionTranscript = "";
    await startMicrophone(transcriber!);
  } else {
    logEvent("mic_button_release");
    await finishListening(turn.manualStop(Date.now()).reason);
  }
});

if (isEvalMode) ensureModelLoaded(); // eval: load at page load so a runner can wait for ready
updateMicState();
loadSavedTokenForCurrentUrl();
log("Page loaded. Configure the gateway URL/agent/token above, then Connect.");
