import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCompletion } from "./completion.mjs";

const SK = "gw_test";

function serverTurn(turn, extra = {}) {
  return { turn, session_key: SK, timestamp: `t${turn}`, ...extra };
}

test("a turn with a success server row classifies as completed", () => {
  const events = [
    { event: "speech_start", timestamp_ms: 0 },
    { event: "speech_end", timestamp_ms: 100 },
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "first_chunk_received", timestamp_ms: 300 },
    { event: "done_received", timestamp_ms: 400 },
    { event: "tts_start", timestamp_ms: 450 },
  ];
  const sessions = { [SK]: [serverTurn(1, { outcome: "success", action: "complete" })] };

  const result = classifyCompletion({ events, sessions }, SK);

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].outcome, "completed");
  assert.equal(result.counts.completed, 1);
  assert.equal(result.summary.total_turns, 1);
  assert.equal(result.summary.turn_completion_rate, 1);
  assert.equal(result.summary.strict_session_completed, true);
  assert.deepEqual(result.session_level_events, []);
});

test("a turn with a failure/fail server row classifies as failed_provider", () => {
  const events = [
    { event: "speech_start", timestamp_ms: 0 },
    { event: "speech_end", timestamp_ms: 100 },
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    // server sends an "error" frame instead of "done" -> client logs it
    { event: "turn_error_frame", timestamp_ms: 300, message: "provider timeout" },
  ];
  const sessions = { [SK]: [serverTurn(1, { outcome: "failure", action: "fail" })] };

  const result = classifyCompletion({ events, sessions }, SK);

  assert.equal(result.turns[0].outcome, "failed_provider");
  assert.equal(result.turns[0].server_action, "fail");
  assert.equal(result.counts.failed_provider, 1);
  assert.equal(result.summary.turn_completion_rate, 0);
  assert.equal(result.summary.strict_session_completed, false);
});

test("a turn with a failure/cancel server row classifies as cancelled", () => {
  const events = [
    { event: "speech_start", timestamp_ms: 0 },
    { event: "speech_end", timestamp_ms: 100 },
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "turn_aborted", timestamp_ms: 250 },
  ];
  const sessions = { [SK]: [serverTurn(1, { outcome: "failure", action: "cancel" })] };

  const result = classifyCompletion({ events, sessions }, SK);

  assert.equal(result.turns[0].outcome, "cancelled");
  assert.equal(result.turns[0].server_action, "cancel");
  assert.equal(result.counts.cancelled, 1);
});

test("a turn with no server row and a ws_closed before done_received classifies as dropped", () => {
  const events = [
    { event: "speech_start", timestamp_ms: 0 },
    { event: "speech_end", timestamp_ms: 100 },
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    // container restarted right after send: no gateway_ws_turn row is ever
    // written server-side for this attempt, connection just drops.
    { event: "ws_closed", timestamp_ms: 400, code: 1006, reason: "", received_session_start: true },
  ];
  const sessions = { [SK]: [] }; // no server turns at all

  const result = classifyCompletion({ events, sessions }, SK);

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].outcome, "dropped");
  assert.deepEqual(result.turns[0].failure_events, ["ws_closed"]);
  assert.equal(result.counts.dropped, 1);
  assert.equal(result.summary.turn_completion_rate, 0);
});

test("a client turn with no server row and no failure signal is never silently dropped", () => {
  const events = [
    { event: "speech_start", timestamp_ms: 0 },
    { event: "speech_end", timestamp_ms: 100 },
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    // no server row, no ws_closed/ws_error either -- a genuine gap, not a
    // classifiable failure, must still be counted somewhere.
  ];
  const sessions = { [SK]: [] };

  const result = classifyCompletion({ events, sessions }, SK);

  assert.equal(result.turns[0].outcome, "unmatched_no_signal");
  assert.equal(result.counts.unmatched_no_signal, 1);
});

test("a ws_closed before any turn was ever sent is a session-level event, not a phantom turn", () => {
  const events = [{ event: "ws_closed", timestamp_ms: 100, code: 1006, reason: "", received_session_start: false }];
  const sessions = { [SK]: [] };

  const result = classifyCompletion({ events, sessions }, SK);

  assert.deepEqual(result.turns, []);
  assert.deepEqual(result.session_level_events, ["ws_closed"]);
  assert.equal(result.summary.total_turns, 0);
  assert.equal(result.summary.turn_completion_rate, null);
  assert.equal(result.summary.strict_session_completed, false);
});

// A dropped turn writes no gateway_ws_turn row, so parseTrace never yields a
// session for it. --no-server-session (opts.noServerSession) is the only way
// to classify it; `sessions` here is what parseTrace really returns for it.
const NO_SERVER = { noServerSession: true };

test("noServerSession: failure event and no done_received classifies as dropped", () => {
  const events = [
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "mic_button_release", timestamp_ms: 155 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "ws_closed", timestamp_ms: 400, code: 1006, reason: "", received_session_start: true },
  ];

  const result = classifyCompletion({ events, sessions: {} }, null, NO_SERVER);

  assert.equal(result.session_key, null);
  assert.equal(result.turns[0].outcome, "dropped");
  assert.deepEqual(result.turns[0].failure_events, ["ws_closed"]);
  assert.equal(result.counts.dropped, 1);
  assert.equal(result.summary.turn_completion_rate, 0);
});

test("noServerSession: no failure event classifies as unmatched_no_signal, not dropped", () => {
  const events = [
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
  ];

  const result = classifyCompletion({ events, sessions: {} }, null, NO_SERVER);

  assert.equal(result.turns[0].outcome, "unmatched_no_signal");
  assert.equal(result.counts.unmatched_no_signal, 1);
});

test("noServerSession ignores sessions present in the trace (no inference)", () => {
  const events = [
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "ws_closed", timestamp_ms: 400, code: 1006 },
  ];
  const sessions = { [SK]: [serverTurn(1, { outcome: "success", action: "complete" })] };

  const result = classifyCompletion({ events, sessions }, null, NO_SERVER);

  assert.equal(result.turns[0].outcome, "dropped");
});

test("noServerSession together with a session key is an error", () => {
  assert.throws(
    () => classifyCompletion({ events: [], sessions: {} }, SK, NO_SERVER),
    /mutually exclusive/,
  );
});

test("session_id in the events file with no server rows classifies as dropped without any flag", () => {
  const events = [
    { event: "session_start", timestamp_ms: 10, session_id: "abc", resumed: false },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "ws_closed", timestamp_ms: 400, code: 1006, reason: "", received_session_start: true },
  ];
  // The trace only knows an unrelated session; it must not be adopted.
  const sessions = { [SK]: [serverTurn(1, { outcome: "success", action: "complete" })] };

  const result = classifyCompletion({ events, sessions }, null);

  assert.equal(result.session_key, "gw_abc");
  assert.equal(result.turns[0].outcome, "dropped");
  assert.equal(result.counts.dropped, 1);
});

// send_blocked, tts_skipped, tts_end, tts_error, tts_cancelled and turn_timeout are not in
// FAILURE_CLIENT_EVENTS and are not read by name, so they must not change a classification. In particular a
// turn that timed out client-side (turn_timeout) is not by itself a failure signal.
const NEW_EVENTS = (t) => [
  { event: "send_blocked", timestamp_ms: t, reason: "reply_in_flight" },
  { event: "tts_skipped", timestamp_ms: t + 1, reason: "empty" },
  { event: "tts_end", timestamp_ms: t + 2 },
  { event: "tts_error", timestamp_ms: t + 3, message: "synthesis-failed" },
  { event: "tts_cancelled", timestamp_ms: t + 4, reason: "canceled" },
  { event: "turn_timeout", timestamp_ms: t + 5, ms: 60000 },
];

test("the new events do not change a completed classification", () => {
  const base = [
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "first_chunk_received", timestamp_ms: 300 },
    { event: "done_received", timestamp_ms: 400 },
    { event: "tts_start", timestamp_ms: 450 },
  ];
  const sessions = { [SK]: [serverTurn(1, { outcome: "success", action: "complete" })] };
  const withNew = [...NEW_EVENTS(0), ...base.slice(0, 2), ...NEW_EVENTS(200), ...base.slice(2), ...NEW_EVENTS(500)];
  assert.deepEqual(classifyCompletion({ events: withNew, sessions }, SK), classifyCompletion({ events: base, sessions }, SK));
});

test("a turn with no server row that timed out client-side (turn_timeout) is unmatched_no_signal, not dropped", () => {
  const events = [
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    ...NEW_EVENTS(60200),
  ];
  const result = classifyCompletion({ events, sessions: {} }, null, { noServerSession: true });
  assert.equal(result.turns[0].outcome, "unmatched_no_signal");
  assert.deepEqual(result.turns[0].failure_events, []);
});

// Sentence streaming (?tts_stream=1) events: not failure events and not read by name, and tts_start before
// done_received (the streaming order) is not read at all, so a completed turn stays completed.
test("the sentence-streaming events, with tts_start before done_received, do not change a completed classification", () => {
  const base = [
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "first_chunk_received", timestamp_ms: 300 },
    { event: "done_received", timestamp_ms: 400 },
    { event: "tts_start", timestamp_ms: 450 },
  ];
  const streamed = [
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "first_chunk_received", timestamp_ms: 300 },
    { event: "tts_requested", timestamp_ms: 305, index: 0 },
    { event: "tts_start", timestamp_ms: 350 },
    { event: "tts_sentence_start", timestamp_ms: 350, index: 0 },
    { event: "tts_text_mismatch", timestamp_ms: 400, chunks_chars: 10, full_response_chars: 12 },
    { event: "done_received", timestamp_ms: 400 },
  ];
  const sessions = { [SK]: [serverTurn(1, { outcome: "success", action: "complete" })] };
  const a = classifyCompletion({ events: streamed, sessions }, SK);
  const b = classifyCompletion({ events: base, sessions }, SK);
  assert.deepEqual(a.turns, b.turns);
  assert.deepEqual(a.summary, b.summary);
});
