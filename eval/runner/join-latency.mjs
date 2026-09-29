#!/usr/bin/env node
// Joins Nutq's client-side eval events (exported via the ?eval=1 "Download
// events JSONL" button, src/main.ts) with ZeroClaw's runtime-trace.jsonl
// (via parse-trace.mjs) to compute staged latency per turn.
// docs/eval-harness-design.md sections 4, 5.1, 8.
//
// Usage:
//   node join-latency.mjs <events.jsonl> [--trace path/to/trace.jsonl] [--session gw_... | --no-server-session]
//
// If --trace is omitted, reads live from the "zeroclaw" container (same as
// parse-trace.mjs's default). If --session is omitted, the trace must
// contain exactly one session, or the script fails loud and lists the
// session_keys found rather than guessing which one the events belong to.
//
// If the events file carries a session_start event (Nutq logs session_id and
// resumed), the session is derived from it ("gw_" + session_id) and picked
// automatically; if the trace has no rows for it, that is treated as
// --no-server-session. --session may not contradict it. Files without a
// session_start event behave exactly as before.
//
// --no-server-session: this events file belongs to a session with no server
// rows at all (a genuinely dropped turn writes no gateway_ws_turn row, so it
// has no session_key in the trace to pick). Every client turn goes into
// client_turns_without_server_row; nothing is inferred from timestamps.
// Mutually exclusive with --session.
//
// IMPORTANT: client event timestamps (Date.now(), main.ts) and server trace
// timestamps (@timestamp, runtime-trace.jsonl) are NEVER subtracted from
// each other here. No clock-offset measurement has been performed between
// this machine's browser clock and the ZeroClaw container's clock, so doing
// that math would silently report a number that means nothing. Client-only
// stages use client timestamps exclusively; server-internal timing uses
// server timestamps exclusively; they're reported side by side, not merged.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseTrace } from "./parse-trace.mjs";

const TRACE_PATH_IN_CONTAINER = "/zeroclaw-data/.zeroclaw/data/state/runtime-trace.jsonl";
const CONTAINER_NAME = "zeroclaw";

function readTrace(localPath) {
  if (localPath) return readFileSync(localPath, "utf8");
  return execFileSync("docker", ["exec", CONTAINER_NAME, "cat", TRACE_PATH_IN_CONTAINER], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const args = { eventsPath: null, tracePath: null, sessionKey: null, noServerSession: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--trace") args.tracePath = argv[++i];
    else if (argv[i] === "--session") args.sessionKey = argv[++i];
    else if (argv[i] === "--no-server-session") args.noServerSession = true;
    else rest.push(argv[i]);
  }
  args.eventsPath = rest[0];
  return args;
}

function loadEvents(eventsPath) {
  const raw = readFileSync(eventsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const events = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  events.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return { events, malformed };
}

// Splits the flat client event stream into turns, one per ws_message_sent.
// Everything strictly between the previous turn's ws_message_sent (or
// recording start) and this one's ws_message_sent belongs to this turn,
// EXCEPT first_chunk_received / done_received / tts_start, which are this
// turn's *response* and so are searched for strictly after this
// ws_message_sent (and before the next turn's window starts).
function segmentTurns(events) {
  const sendIdxs = events.map((e, i) => (e.event === "ws_message_sent" ? i : -1)).filter((i) => i >= 0);
  const turns = [];

  for (let t = 0; t < sendIdxs.length; t++) {
    const sendIdx = sendIdxs[t];
    const sendEvent = events[sendIdx];
    const windowStart = t === 0 ? 0 : sendIdxs[t - 1] + 1;
    const preWindow = events.slice(windowStart, sendIdx); // this turn's speech/commit events
    const nextSendIdx = t + 1 < sendIdxs.length ? sendIdxs[t + 1] : events.length;
    const postWindow = events.slice(sendIdx + 1, nextSendIdx); // this turn's response events

    const sttCommitted = preWindow.filter((e) => e.event === "stt_committed");
    const speechStarts = preWindow.filter((e) => e.event === "speech_start");
    const speechEnds = preWindow.filter((e) => e.event === "speech_end");
    const micReleases = preWindow.filter((e) => e.event === "mic_button_release");

    const lastSttCommitted = sttCommitted.at(-1) ?? null;
    const lastSpeechStart = speechStarts.at(-1) ?? null;
    const lastMicRelease = micReleases.at(-1) ?? null;

    // The speech_end that actually pairs with the last speech_start: any
    // speech_end after it (there should be at most one in practice; take
    // the last if more, consistent with "anchor on last" throughout).
    const speechEndAfterLastStart = lastSpeechStart
      ? speechEnds.filter((e) => e.timestamp_ms > lastSpeechStart.timestamp_ms).at(-1) ?? null
      : null;

    const sendTrigger = sendEvent.send_trigger ?? "unknown";

    let endOfSpeech = null;
    let endOfSpeechSource = null;
    if (sendTrigger === "auto_silence") {
      // The silence timer is armed by speech_end itself, so the relevant
      // boundary is simply the last speech_end before this send.
      endOfSpeech = speechEnds.at(-1) ?? null;
      endOfSpeechSource = endOfSpeech ? "speech_end" : null;
    } else {
      // manual (or unknown, treated the same): prefer the speech_end that
      // closes the last utterance; if the user released mid-utterance
      // (no speech_end ever fired for it), fall back to the release itself.
      if (speechEndAfterLastStart) {
        endOfSpeech = speechEndAfterLastStart;
        endOfSpeechSource = "speech_end";
      } else if (lastMicRelease) {
        endOfSpeech = lastMicRelease;
        endOfSpeechSource = "mic_button_release";
      }
    }

    const firstChunk = postWindow.find((e) => e.event === "first_chunk_received") ?? null;
    const done = postWindow.find((e) => e.event === "done_received") ?? null;
    const ttsStart = postWindow.find((e) => e.event === "tts_start") ?? null;

    const missing = [];
    if (!lastSttCommitted) missing.push("stt_committed");
    if (!endOfSpeech) missing.push("end_of_speech");
    if (!firstChunk) missing.push("first_chunk_received");
    if (!done) missing.push("done_received");
    if (!ttsStart) missing.push("tts_start");

    const ms = (a, b) => (a != null && b != null ? b - a : null);

    // user_perceived: what the user actually experiences as latency, which
    // differs by how the turn ended. Anchoring on last_stt_committed (the old
    // behavior, kept below as commit_to_audio) is wrong in both directions:
    // it eats the user's own pre-tap pause on manual turns, and it hides the
    // forced-flush time after a mid-utterance tap.
    let userPerceivedMs = null;
    let userPerceivedNote = null;
    let timerWaitMs = null;
    if (sendTrigger === "auto_silence") {
      // The wait is deliberate (SILENCE_COMMIT_MS), not perceived latency,
      // so it's surfaced separately rather than folded into user_perceived.
      userPerceivedMs = ms(sendEvent.timestamp_ms, ttsStart?.timestamp_ms);
      timerWaitMs = ms(endOfSpeech?.timestamp_ms, sendEvent.timestamp_ms);
    } else if (lastMicRelease) {
      userPerceivedMs = ms(lastMicRelease.timestamp_ms, ttsStart?.timestamp_ms);
    } else {
      userPerceivedNote = "manual turn has no mic_button_release event; user_perceived not computed";
    }

    turns.push({
      turn: t + 1,
      send_trigger: sendTrigger,
      client: {
        end_of_speech_ms: endOfSpeech?.timestamp_ms ?? null,
        end_of_speech_source: endOfSpeechSource,
        last_stt_committed_ms: lastSttCommitted?.timestamp_ms ?? null,
        ws_message_sent_ms: sendEvent.timestamp_ms,
        first_chunk_received_ms: firstChunk?.timestamp_ms ?? null,
        done_received_ms: done?.timestamp_ms ?? null,
        tts_start_ms: ttsStart?.timestamp_ms ?? null,
      },
      stages_ms: {
        stt_tail: ms(endOfSpeech?.timestamp_ms, lastSttCommitted?.timestamp_ms),
        dispatch_to_first_chunk: ms(sendEvent.timestamp_ms, firstChunk?.timestamp_ms),
        full_completion: ms(sendEvent.timestamp_ms, done?.timestamp_ms),
        tts_start_delay: ms(done?.timestamp_ms, ttsStart?.timestamp_ms),
        post_trigger: ms(sendEvent.timestamp_ms, ttsStart?.timestamp_ms),
        commit_to_audio: ms(lastSttCommitted?.timestamp_ms, ttsStart?.timestamp_ms),
        user_perceived: userPerceivedMs,
        timer_wait_ms: timerWaitMs,
      },
      user_perceived_note: userPerceivedNote,
      missing_client_events: missing,
    });
  }

  return turns;
}

function pickSession(sessions, requestedKey) {
  const keys = Object.keys(sessions);
  if (requestedKey) {
    if (!sessions[requestedKey]) {
      throw new Error(
        `--session ${requestedKey} not found in trace. Sessions present: ${keys.join(", ") || "(none)"}`,
      );
    }
    return requestedKey;
  }
  if (keys.length === 1) return keys[0];
  throw new Error(
    keys.length === 0
      ? "No attributable sessions found in trace."
      : `Trace has ${keys.length} sessions, pass --session to pick one: ${keys.join(", ")}`,
  );
}

// ZeroClaw derives session_key as "gw_" + session_id (ws.rs, top of
// handle_socket), so a session_start event's session_id names the session.
const GW_SESSION_PREFIX = "gw_";

function eventsSessionKeys(events) {
  const keys = new Set();
  for (const e of events) {
    if (e.event === "session_start" && typeof e.session_id === "string") keys.add(GW_SESSION_PREFIX + e.session_id);
  }
  return [...keys];
}

// Decides which server session (if any) the client events are joined to.
// Explicit arguments win, but may not contradict a session_id the events file
// itself carries. Old events files (no session_start) fall through to the
// pre-existing pickSession behavior.
function resolveSession(events, sessions, sessionKey, noServerSession) {
  if (noServerSession && sessionKey) {
    throw new Error("--no-server-session and --session are mutually exclusive");
  }
  const fromEvents = eventsSessionKeys(events);
  if (sessionKey && fromEvents.length > 0 && !fromEvents.includes(sessionKey)) {
    throw new Error(
      `--session ${sessionKey} contradicts the events file's session_start session_id (${fromEvents.join(", ")})`,
    );
  }
  if (noServerSession) return { key: null, hasServerRows: false, source: "no_server_session_flag" };
  if (sessionKey) return { key: pickSession(sessions, sessionKey), hasServerRows: true, source: "session_argument" };
  if (fromEvents.length === 1) {
    const key = fromEvents[0];
    // A dropped turn writes no gateway_ws_turn row, so its session may be absent
    // from the trace entirely: that is the no-server-session case, not an error.
    return sessions[key]
      ? { key, hasServerRows: true, source: "events_session_id" }
      : { key, hasServerRows: false, source: "events_session_id_no_server_rows" };
  }
  if (fromEvents.length > 1) {
    throw new Error(
      `events file has ${fromEvents.length} different session_start session_ids (${fromEvents.join(", ")}); pass --session to pick one`,
    );
  }
  return { key: pickSession(sessions, null), hasServerRows: true, source: "trace_single_session" };
}

export function joinLatency({ events, sessions }, sessionKey, { noServerSession = false } = {}) {
  const { key, hasServerRows, source } = resolveSession(events, sessions, sessionKey, noServerSession);
  const serverTurns = hasServerRows ? sessions[key] : []; // already ordered by @timestamp, per parse-trace.mjs
  const clientTurns = segmentTurns(events);

  const joined = [];
  const n = Math.max(clientTurns.length, serverTurns.length);
  const unmatchedClient = [];
  const unmatchedServer = [];

  for (let i = 0; i < n; i++) {
    const c = clientTurns[i];
    const s = serverTurns[i];
    if (c && !s) {
      unmatchedClient.push(c.turn);
      continue;
    }
    if (s && !c) {
      unmatchedServer.push(s.turn);
      continue;
    }
    joined.push({
      turn: c.turn,
      send_trigger: c.send_trigger,
      client: c.client,
      stages_ms: c.stages_ms,
      user_perceived_note: c.user_perceived_note,
      missing_client_events: c.missing_client_events,
      server: {
        session_key: key,
        timestamp: s.timestamp,
        trace_id: s.trace_id,
        model: s.model,
        input_tokens: s.input_tokens,
        output_tokens: s.output_tokens,
        tokens_used: s.tokens_used,
        cost_usd: s.cost_usd,
        provider_calls: s.provider_calls,
        provider_duration_ms: s.provider_duration_ms,
      },
    });
  }

  return {
    session_key: key,
    session_source: source,
    turns: joined,
    by_trigger: {
      manual: joined.filter((t) => t.send_trigger === "manual"),
      auto_silence: joined.filter((t) => t.send_trigger === "auto_silence"),
      unknown: joined.filter((t) => t.send_trigger !== "manual" && t.send_trigger !== "auto_silence"),
    },
    unmatched: {
      client_turns_without_server_row: unmatchedClient,
      server_turns_without_client_send: unmatchedServer,
    },
    meta: {
      clock_offset_measured: false,
      note:
        "No clock-offset measurement was performed between the browser's Date.now() and the " +
        "ZeroClaw container's @timestamp clock. stages_ms above are computed exclusively from " +
        "client timestamps; server.* fields are raw server data, never subtracted against a " +
        "client timestamp.",
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.eventsPath) {
    console.error("Usage: node join-latency.mjs <events.jsonl> [--trace path] [--session gw_... | --no-server-session]");
    process.exit(1);
  }

  const { events, malformed } = loadEvents(args.eventsPath);
  const traceRaw = args.noServerSession ? "" : readTrace(args.tracePath);
  const { sessions, meta: traceMeta } = parseTrace(traceRaw);

  let result;
  try {
    result = joinLatency({ events, sessions }, args.sessionKey, { noServerSession: args.noServerSession });
  } catch (e) {
    console.error(`join-latency: ${e.message}`);
    process.exit(1);
  }

  console.error(
    `Loaded ${events.length} client events (${malformed} malformed lines skipped). ` +
      `Trace: ${traceMeta.sessionsFound} sessions, ${traceMeta.turnsFound} turns ` +
      `(skipped ${traceMeta.skippedNoSessionKey} no-session-key + ${traceMeta.skippedMalformed} malformed).`,
  );
  console.error(
    `Joined session ${result.session_key}: ${result.turns.length} turns ` +
      `(${result.by_trigger.manual.length} manual, ${result.by_trigger.auto_silence.length} auto_silence, ` +
      `${result.by_trigger.unknown.length} unknown), ` +
      `${result.unmatched.client_turns_without_server_row.length} client turn(s) unmatched, ` +
      `${result.unmatched.server_turns_without_client_send.length} server turn(s) unmatched.`,
  );

  console.log(JSON.stringify(result, null, 2));
}
