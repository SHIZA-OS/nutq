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
  assert.equal(t.stages_ms.commit_to_audio, 1300); // 2250 - 950
  assert.equal(t.stages_ms.user_perceived, 750); // 2250 - 1500 (mic_button_release)
  assert.equal(t.stages_ms.timer_wait_ms, null); // manual turn, not applicable
  assert.equal(t.user_perceived_note, null);
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
  assert.equal(t.stages_ms.user_perceived, 650); // 1250 - 600 (mic_button_release)
  assert.equal(t.user_perceived_note, null);
});

test("manual turn with no mic_button_release at all leaves user_perceived null with a reason, never a silent fallback", () => {
  const events = [
    { event: "mic_button_press", timestamp_ms: 0 },
    { event: "speech_start", timestamp_ms: 100 },
    { event: "speech_end", timestamp_ms: 900 },
    { event: "stt_committed", timestamp_ms: 950 },
    // no mic_button_release event at all
    { event: "ws_message_sent", timestamp_ms: 1510, send_trigger: "manual" },
    { event: "first_chunk_received", timestamp_ms: 1800 },
    { event: "done_received", timestamp_ms: 2200 },
    { event: "tts_start", timestamp_ms: 2250 },
  ];
  const sessions = { [SK]: [serverTurn(1, "t1")] };

  const result = joinLatency({ events, sessions }, SK);
  const t = result.turns[0];

  assert.equal(t.stages_ms.user_perceived, null);
  assert.equal(t.stages_ms.commit_to_audio, 1300); // 2250 - 950, unaffected
  assert.equal(
    t.user_perceived_note,
    "manual turn has no mic_button_release event; user_perceived not computed",
  );
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
  assert.equal(t.stages_ms.user_perceived, 650); // 6450 - 5800 (post_trigger)
  assert.equal(t.stages_ms.post_trigger, 650);
  assert.equal(t.stages_ms.timer_wait_ms, 5000); // 5800 - 800
  assert.equal(t.user_perceived_note, null);
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

// --- session_id carried by the events file (session_start event) -------------

const SID = "11111111-2222-3333-4444-555555555555";
const SESSION_KEY = `gw_${SID}`;
const sendEvents = (extra = []) => [
  ...extra,
  { event: "stt_committed", timestamp_ms: 150 },
  { event: "mic_button_release", timestamp_ms: 155 },
  { event: "ws_message_sent", timestamp_ms: 160, send_trigger: "manual" },
];
const startEvent = (id = SID) => ({ event: "session_start", timestamp_ms: 10, session_id: id, resumed: false });

test("session_id in the events file picks its session automatically", () => {
  const sessions = {
    gw_other: [{ turn: 1, session_key: "gw_other", timestamp: "t1" }],
    [SESSION_KEY]: [{ turn: 1, session_key: SESSION_KEY, timestamp: "t2", trace_id: "want" }],
  };

  const result = joinLatency({ events: sendEvents([startEvent()]), sessions });

  assert.equal(result.session_key, SESSION_KEY);
  assert.equal(result.session_source, "events_session_id");
  assert.equal(result.turns[0].server.trace_id, "want");
});

test("session_id whose session has no server rows behaves like --no-server-session", () => {
  // The trace holds only an unrelated session: must NOT be guessed as ours.
  const sessions = { gw_other: [{ turn: 1, session_key: "gw_other", timestamp: "t1" }] };

  const result = joinLatency({ events: sendEvents([startEvent()]), sessions });

  assert.equal(result.session_key, SESSION_KEY);
  assert.equal(result.session_source, "events_session_id_no_server_rows");
  assert.deepEqual(result.turns, []);
  assert.deepEqual(result.unmatched.client_turns_without_server_row, [1]);
});

test("events files without session_id keep the old behavior", () => {
  const one = { [SK]: [serverTurn(1, "t1")] };
  assert.equal(joinLatency({ events: sendEvents(), sessions: one }).session_key, SK);
  assert.equal(joinLatency({ events: sendEvents(), sessions: one }).session_source, "trace_single_session");

  const two = { [SK]: [serverTurn(1, "t1")], gw_b: [] };
  assert.throws(() => joinLatency({ events: sendEvents(), sessions: two }), /pass --session/);
  assert.equal(joinLatency({ events: sendEvents(), sessions: two }, SK).session_key, SK);
  assert.equal(joinLatency({ events: sendEvents(), sessions: two }, null, { noServerSession: true }).session_key, null);
});

test("--session contradicting the events file's session_id is an error", () => {
  const sessions = { gw_other: [{ turn: 1, session_key: "gw_other", timestamp: "t1" }] };
  assert.throws(
    () => joinLatency({ events: sendEvents([startEvent()]), sessions }, "gw_other"),
    /contradicts the events file/,
  );
});

test("--session matching the events file's session_id is accepted; the mutual exclusion still holds", () => {
  const sessions = { [SESSION_KEY]: [{ turn: 1, session_key: SESSION_KEY, timestamp: "t1" }] };
  const events = sendEvents([startEvent()]);

  assert.equal(joinLatency({ events, sessions }, SESSION_KEY).session_source, "session_argument");
  assert.throws(() => joinLatency({ events, sessions }, SESSION_KEY, { noServerSession: true }), /mutually exclusive/);
});

test("an events file spanning several session_ids needs an explicit --session", () => {
  const other = "99999999-2222-3333-4444-555555555555";
  const events = sendEvents([startEvent(), startEvent(other)]);
  const sessions = { [SESSION_KEY]: [{ turn: 1, session_key: SESSION_KEY, timestamp: "t1" }] };

  assert.throws(() => joinLatency({ events, sessions }), /2 different session_start session_ids/);
  assert.equal(joinLatency({ events, sessions }, SESSION_KEY).session_key, SESSION_KEY);
});
