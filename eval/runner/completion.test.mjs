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
