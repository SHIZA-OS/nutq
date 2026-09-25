import { test } from "node:test";
import assert from "node:assert/strict";
import { joinLatency } from "./join-latency.mjs";

const SK = "gw_test";

function serverTurn(turn, timestamp, extra = {}) {
  return { turn, session_key: SK, timestamp, trace_id: `trace-${turn}`, ...extra };
}

test("manual turn with a clean speech_end anchors on speech_end, not mic_button_release", () => {
  const events = [
    { event: "mic_button_press", timestamp_ms: 0 },
    { event: "speech_start", timestamp_ms: 100 },
    { event: "speech_end", timestamp_ms: 900 },
    { event: "stt_committed", timestamp_ms: 950 },
    { event: "mic_button_release", timestamp_ms: 1500 }, // user paused, then released later
    { event: "ws_message_sent", timestamp_ms: 1510, send_trigger: "manual" },
    { event: "first_chunk_received", timestamp_ms: 1800 },
    { event: "done_received", timestamp_ms: 2200 },
    { event: "tts_start", timestamp_ms: 2250 },
  ];
  const sessions = { [SK]: [serverTurn(1, "t1")] };

  const result = joinLatency({ events, sessions }, SK);

  assert.equal(result.turns.length, 1);
  const t = result.turns[0];
  assert.equal(t.send_trigger, "manual");
  assert.equal(t.client.end_of_speech_source, "speech_end");
  assert.equal(t.client.end_of_speech_ms, 900);
  assert.equal(t.stages_ms.stt_tail, 50); // 950 - 900
  assert.equal(t.stages_ms.dispatch_to_first_chunk, 290); // 1800 - 1510
  assert.equal(t.stages_ms.full_completion, 690); // 2200 - 1510
  assert.equal(t.stages_ms.tts_start_delay, 50); // 2250 - 2200
  assert.equal(t.stages_ms.post_trigger, 740); // 2250 - 1510
  assert.equal(t.stages_ms.user_perceived, 1300); // 2250 - 950
  assert.deepEqual(t.missing_client_events, []);
});

test("manual turn released mid-utterance (no speech_end) falls back to mic_button_release", () => {
  const events = [
    { event: "mic_button_press", timestamp_ms: 0 },
    { event: "speech_start", timestamp_ms: 100 },
    { event: "stt_committed", timestamp_ms: 400 }, // streaming commit, speech still ongoing
    { event: "mic_button_release", timestamp_ms: 600 }, // released before any speech_end fired
    { event: "ws_message_sent", timestamp_ms: 610, send_trigger: "manual" },
    { event: "first_chunk_received", timestamp_ms: 900 },
    { event: "done_received", timestamp_ms: 1200 },
    { event: "tts_start", timestamp_ms: 1250 },
  ];
  const sessions = { [SK]: [serverTurn(1, "t1")] };

  const result = joinLatency({ events, sessions }, SK);
  const t = result.turns[0];

  assert.equal(t.client.end_of_speech_source, "mic_button_release");
  assert.equal(t.client.end_of_speech_ms, 600);
  assert.equal(t.stages_ms.stt_tail, -200); // 400 - 600: commit landed before release, reported as-is
});

test("auto_silence turn anchors end-of-speech on speech_end (the event that armed the timer)", () => {
  const events = [
    { event: "mic_button_press", timestamp_ms: 0 },
    { event: "speech_start", timestamp_ms: 100 },
    { event: "speech_end", timestamp_ms: 800 },
    { event: "stt_committed", timestamp_ms: 850 },
    { event: "ws_message_sent", timestamp_ms: 5800, send_trigger: "auto_silence" }, // 5000ms after speech_end
    { event: "first_chunk_received", timestamp_ms: 6100 },
    { event: "done_received", timestamp_ms: 6400 },
    { event: "tts_start", timestamp_ms: 6450 },
  ];
  const sessions = { [SK]: [serverTurn(1, "t1")] };

  const result = joinLatency({ events, sessions }, SK);
  const t = result.turns[0];

  assert.equal(t.send_trigger, "auto_silence");
  assert.equal(t.client.end_of_speech_source, "speech_end");
  assert.equal(t.client.end_of_speech_ms, 800);
  assert.equal(t.stages_ms.stt_tail, 50); // 850 - 800
});

test("by_trigger buckets turns separately and unmatched turns are reported, not dropped", () => {
  const events = [
    { event: "speech_start", timestamp_ms: 0 },
    { event: "speech_end", timestamp_ms: 100 },
    { event: "stt_committed", timestamp_ms: 150 },
    { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
    { event: "done_received", timestamp_ms: 400 },

    { event: "speech_start", timestamp_ms: 500 },
    { event: "speech_end", timestamp_ms: 600 },
    { event: "stt_committed", timestamp_ms: 650 },
    { event: "ws_message_sent", timestamp_ms: 5700, send_trigger: "auto_silence" },
    { event: "done_received", timestamp_ms: 6000 },

    // third client send with no matching server row at all
    { event: "speech_start", timestamp_ms: 7000 },
    { event: "speech_end", timestamp_ms: 7100 },
    { event: "stt_committed", timestamp_ms: 7150 },
    { event: "ws_message_sent", timestamp_ms: 7200, send_trigger: "manual" },
  ];
  // Only 2 server turns for 3 client sends.
  const sessions = { [SK]: [serverTurn(1, "t1"), serverTurn(2, "t2")] };

  const result = joinLatency({ events, sessions }, SK);

  assert.equal(result.turns.length, 2);
  assert.equal(result.by_trigger.manual.length, 1);
  assert.equal(result.by_trigger.auto_silence.length, 1);
  assert.deepEqual(result.unmatched.client_turns_without_server_row, [3]);
  assert.deepEqual(result.unmatched.server_turns_without_client_send, []);
  assert.equal(result.meta.clock_offset_measured, false);
});
