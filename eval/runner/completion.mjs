#!/usr/bin/env node
// Classifies each turn's completion outcome by combining join-latency.mjs's
// client/server join with the raw client events (for ws_error/ws_closed/
// turn_error_frame/turn_aborted/js_error, none of which join-latency.mjs
// looks at, since they're failure signals, not latency stages).
// docs/eval-harness-design.md section 5.5.
//
// Usage:
//   node completion.mjs <events.jsonl> [--trace path/to/trace.jsonl] [--session gw_...]
//
// Same trace/session resolution as join-latency.mjs (see its header comment).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseTrace } from "./parse-trace.mjs";
import { joinLatency } from "./join-latency.mjs";

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
  const args = { eventsPath: null, tracePath: null, sessionKey: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--trace") args.tracePath = argv[++i];
    else if (argv[i] === "--session") args.sessionKey = argv[++i];
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

// Client-side signals that a turn (or, before any turn started, the
// connection itself) did not proceed cleanly. done_received/tts_start etc.
// are join-latency.mjs's territory; these are ours.
const FAILURE_CLIENT_EVENTS = new Set([
  "ws_error",
  "ws_closed",
  "turn_error_frame",
  "turn_aborted",
  "js_error",
]);

// Slices the raw client event stream into one window per ws_message_sent
// (same turn numbering as join-latency.mjs's segmentTurns, which isn't
// exported, so this is a smaller purpose-built re-derivation: we only need
// "did done_received land in this window" and "which failure events landed
// in this window", not the full latency staging).
function turnWindows(events) {
  const sendIdxs = events.map((e, i) => (e.event === "ws_message_sent" ? i : -1)).filter((i) => i >= 0);
  const windows = [];
  for (let t = 0; t < sendIdxs.length; t++) {
    const start = sendIdxs[t];
    const end = t + 1 < sendIdxs.length ? sendIdxs[t + 1] : events.length;
    windows.push({ turn: t + 1, slice: events.slice(start + 1, end) });
  }
  // Events before the first send (or all events, if no turn was ever sent):
  // a connect-then-never-send-then-drop session has failure signals here,
  // attributable to no turn.
  const preambleEnd = sendIdxs.length ? sendIdxs[0] : events.length;
  return { windows, preamble: events.slice(0, preambleEnd) };
}

export function classifyCompletion({ events, sessions }, sessionKey) {
  const joined = joinLatency({ events, sessions }, sessionKey);
  const serverTurns = sessions[joined.session_key] ?? [];
  const { windows, preamble } = turnWindows(events);

  const matchedByTurn = new Map(joined.turns.map((t) => [t.turn, t]));
  const droppedCandidates = new Set(joined.unmatched.client_turns_without_server_row);

  const turns = windows.map((w) => {
    const failureEvents = w.slice.filter((e) => FAILURE_CLIENT_EVENTS.has(e.event)).map((e) => e.event);
    const doneReceived = w.slice.some((e) => e.event === "done_received");

    if (matchedByTurn.has(w.turn)) {
      // A server row exists for this turn: trust its own outcome/action
      // (parse-trace.mjs now carries these), not the client-side signals.
      const server = serverTurns[w.turn - 1];
      const serverOutcome = server?.outcome ?? null;
      const serverAction = server?.action ?? null;
      let outcome;
      if (serverOutcome === "success") outcome = "completed";
      else if (serverAction === "cancel") outcome = "cancelled";
      else if (serverAction === "fail") outcome = "failed_provider";
      // Matched row exists but carries neither a recognized outcome nor
      // action (e.g. an older trace predating this instrumentation, or a
      // message type we don't expect under "gateway_ws_turn"). Never drop
      // it silently: surface it as its own bucket instead of guessing.
      else outcome = "unmatched_unknown_outcome";
      return { turn: w.turn, outcome, server_outcome: serverOutcome, server_action: serverAction };
    }

    if (droppedCandidates.has(w.turn)) {
      // No server row at all for this turn. A client-observed WS failure
      // before done_received is the "dropped" signature: the connection
      // died mid-turn, before ws.rs's own success/fail/cancel trace write
      // ever ran. Absent that signal (or if done_received somehow *did*
      // land with no server row, itself an anomaly), don't guess: bucket
      // it as unmatched-no-signal rather than silently calling it dropped.
      if (failureEvents.length > 0 && !doneReceived) {
        return { turn: w.turn, outcome: "dropped", failure_events: failureEvents };
      }
      return {
        turn: w.turn,
        outcome: "unmatched_no_signal",
        failure_events: failureEvents,
        done_received: doneReceived,
      };
    }

    // join-latency.mjs accounts for every client turn as either matched or
    // in client_turns_without_server_row; reaching neither branch would be
    // a join-latency invariant violation. Guard rather than skip.
    return { turn: w.turn, outcome: "unclassified" };
  });

  const sessionLevelEvents = preamble.filter((e) => FAILURE_CLIENT_EVENTS.has(e.event)).map((e) => e.event);

  const counts = {};
  for (const t of turns) counts[t.outcome] = (counts[t.outcome] ?? 0) + 1;

  const totalTurns = turns.length;
  const completedTurns = counts.completed ?? 0;

  return {
    session_key: joined.session_key,
    turns,
    counts,
    session_level_events: sessionLevelEvents,
    summary: {
      total_turns: totalTurns,
      turn_completion_rate: totalTurns > 0 ? completedTurns / totalTurns : null,
      strict_session_completed: totalTurns > 0 && completedTurns === totalTurns,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.eventsPath) {
    console.error("Usage: node completion.mjs <events.jsonl> [--trace path] [--session gw_...]");
    process.exit(1);
  }

  const { events, malformed } = loadEvents(args.eventsPath);
  const traceRaw = readTrace(args.tracePath);
  const { sessions, meta: traceMeta } = parseTrace(traceRaw);

  let result;
  try {
    result = classifyCompletion({ events, sessions }, args.sessionKey);
  } catch (e) {
    console.error(`completion: ${e.message}`);
    process.exit(1);
  }

  console.error(
    `Loaded ${events.length} client events (${malformed} malformed lines skipped). ` +
      `Trace: ${traceMeta.sessionsFound} sessions, ${traceMeta.turnsFound} turns.`,
  );
  console.error(
    `Session ${result.session_key}: ${result.summary.total_turns} turns, ` +
      `turn completion rate ${result.summary.turn_completion_rate}, ` +
      `strict session completed: ${result.summary.strict_session_completed}. ` +
      `Counts: ${JSON.stringify(result.counts)}.` +
      (result.session_level_events.length
        ? ` Session-level events (no turn): ${result.session_level_events.join(", ")}.`
        : ""),
  );

  console.log(JSON.stringify(result, null, 2));
}
