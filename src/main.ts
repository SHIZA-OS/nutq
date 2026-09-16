import "./style.css";
import { Transcriber, type VADThresholdOptions } from "./vendor/transcriber";

// Mic constraints MicrophoneTranscriber used to set internally, ported over
// now that we call getUserMedia ourselves (vendored Transcriber has no
// getUserMedia of its own, see src/vendor/transcriber.ts).
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
    sampleRate: 16000,
  },
};

// Starting point only, not calibrated: stricter than vad-web's v5 defaults
// (positiveSpeechThreshold 0.5, negativeSpeechThreshold 0.35, minSpeechFrames 9,
// redemptionFrames 24) to cut down on background noise misfiring as speech.
// Real tuning needs the eval harness's WER metric once it exists (see
// docs/eval-harness-design.md) to check this isn't also dropping real speech.
const VAD_OPTIONS: VADThresholdOptions = {
  positiveSpeechThreshold: 0.65,
  minSpeechFrames: 12,
};

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

function setStatus(el: HTMLSpanElement, text: string, kind: "idle" | "ok" | "error") {
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
  | "speech_start"
  | "speech_end"
  | "stt_committed"
  | "ws_message_sent"
  | "first_chunk_received"
  | "done_received"
  | "tts_start";

function logEvent(event: EvalEvent) {
  const record = { event, timestamp_ms: Date.now() };
  log(`EVENT ${JSON.stringify(record)}`);
}

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
    setStatus(pairStatus, "not paired", "idle");
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

function connect() {
  let url: string;
  try {
    url = buildWsUrl();
  } catch (e) {
    log(`Invalid WebSocket URL: ${e}`);
    setStatus(connStatus, "invalid url", "error");
    return;
  }

  log(`Connecting to ${url}`);
  setStatus(connStatus, "connecting…", "idle");
  receivedSessionStart = false;
  socket = new WebSocket(url);

  socket.onopen = () => {
    log("WebSocket open");
    setStatus(connStatus, "connected", "ok");
    micBtn.disabled = false;
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
        break;
      case "error":
        log(`Server error: ${parsed.message ?? JSON.stringify(parsed)}`);
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
    setStatus(connStatus, "error", "error");
  };

  socket.onclose = (ev) => {
    log(`WebSocket closed (code=${ev.code} reason="${ev.reason}")`);
    if (ev.code === 1006 && !receivedSessionStart) {
      log(
        "Connection closed immediately, possibly an authentication rejection — if you have a " +
          "saved pairing token, it may be invalid, expired, or the instance may not require " +
          "pairing at all. Try re-pairing or check with your ZeroClaw operator.",
      );
    }
    setStatus(connStatus, "disconnected", "idle");
    micBtn.disabled = true;
    socket = null;
  };
}

const RESPONSE_STYLE_PREFIX =
  "Respond in 1-2 short, complete sentences, suitable for being spoken aloud. " +
  "Be concise but don't cut off mid-thought.\n\n";

function sendTranscript(text: string) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("Cannot send: not connected");
    return;
  }
  replyBuffer = "";
  replyBoxEl.textContent = "";
  receivedFirstChunkThisTurn = false;
  const frame = { type: "message", content: RESPONSE_STYLE_PREFIX + text };
  socket.send(JSON.stringify(frame));
  logEvent("ws_message_sent");
  log(`Sent: ${text}`);
}

function speak(text: string) {
  if (!text) return;
  if (!("speechSynthesis" in window)) {
    log("SpeechSynthesis not supported in this browser");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onstart = () => logEvent("tts_start");
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

function initTranscriber() {
  setStatus(micStatus, "loading model…", "idle");
  transcriber = new Transcriber(
    "model/tiny",
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
      onSpeechStart() {
        logEvent("speech_start");
      },
      onSpeechEnd() {
        logEvent("speech_end");
      },
      onTranscriptionUpdated(text: string) {
        liveTranscriptEl.textContent = text;
      },
      onTranscriptionCommitted(text: string) {
        logEvent("stt_committed");
        liveTranscriptEl.textContent = "";
        committedTranscriptEl.textContent = text;
        log(`Committed transcript: "${text}"`);
        sendTranscript(text);
      },
    },
    false, // useVAD=false -> streaming mode
    "quantized",
    VAD_OPTIONS,
  );
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
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    t.attachStream(stream);
    await t.start();
  } catch (e) {
    t.callbacks.onError(`Microphone permission denied: ${e}`);
    t.stop();
  }
}

micBtn.addEventListener("click", async () => {
  if (!transcriber) {
    initTranscriber();
  }
  if (!listening) {
    micBtn.textContent = "Stop listening";
    listening = true;
    logEvent("mic_button_press");
    await startMicrophone(transcriber!);
  } else {
    micBtn.textContent = "Start listening";
    listening = false;
    logEvent("mic_button_release");
    transcriber!.stop();
  }
});

loadSavedTokenForCurrentUrl();
log("Page loaded. Configure the gateway URL/agent/token above, then Connect.");
