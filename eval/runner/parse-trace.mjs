#!/usr/bin/env node
// Parses ZeroClaw's runtime-trace.jsonl into { session_key: [turn records] },
// ready to join against Nutq's client-side event log (docs/eval-harness-design.md
// sections 3, 5.1, 8).
//
// Usage:
//   node parse-trace.mjs                  # docker exec into the "zeroclaw" container
//   node parse-trace.mjs path/to/file.jsonl  # parse a local copy instead (tests, offline)
//
// ponytail: the trace volume is a named docker volume, not bind-mounted to the
// host (confirmed via `docker inspect zeroclaw`), so `docker exec cat` is the
// only way in. If it's ever bind-mounted, swap to a plain fs.readFileSync.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TRACE_PATH_IN_CONTAINER = "/zeroclaw-data/.zeroclaw/data/state/runtime-trace.jsonl";
const CONTAINER_NAME = "zeroclaw";

function readTrace(localPath) {
  if (localPath) return readFileSync(localPath, "utf8");
  return execFileSync("docker", ["exec", CONTAINER_NAME, "cat", TRACE_PATH_IN_CONTAINER], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Rows are dropped for two reasons: unparseable JSON, or no session_key
// anywhere (e.g. "task spawned" rows log with zeroclaw:{} and no attribution).
// Per the design doc, these must be counted and reported, not silently dropped.
export function parseTrace(raw) {
  const lines = raw.split("\n").filter((l) => l.trim());
  const skipped = { malformed: 0, noSessionKey: 0 };
  const turnsBySession = new Map();
  // llm_response only (not llm_request): it's the row that actually carries
  // duration_ms, so it's what "provider_calls count and summed duration_ms"
  // is built from. A request with no matching response (provider error,
  // never completed) is deliberately not counted here.
  const providerRowsBySession = new Map();

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped.malformed++;
      continue;
    }

    const sessionKey = entry.attributes?.session_key ?? entry.zeroclaw?.session_key;
    if (!sessionKey) {
      skipped.noSessionKey++;
      continue;
    }

    if (entry.message === "gateway_ws_turn") {
      if (!turnsBySession.has(sessionKey)) turnsBySession.set(sessionKey, []);
      turnsBySession.get(sessionKey).push(entry);
    } else if (entry.message === "llm_response") {
      if (!providerRowsBySession.has(sessionKey)) providerRowsBySession.set(sessionKey, []);
      providerRowsBySession.get(sessionKey).push(entry);
    }
    // Everything else (task spawned/complete, turn_final_response, llm_request,
    // etc.) is attributable but not turned into a record; out of scope here.
  }

  // Order by @timestamp, not trace_id (trace_id is assigned per logging
  // call-site, not per-turn; confirmed finding, docs/eval-harness-design.md §8).
  const result = {};
  for (const [sessionKey, entries] of turnsBySession) {
    entries.sort((a, b) => a["@timestamp"].localeCompare(b["@timestamp"]));

    // Bucket each session's llm_response rows into the turn they belong to:
    // gateway_ws_turn is always logged after all of that turn's provider
    // calls complete (confirmed real ordering, see docs/eval-harness-design.md),
    // so "every llm_response between the previous turn's timestamp (or
    // session start) and this turn's timestamp" is that turn's provider calls.
    const providerRows = (providerRowsBySession.get(sessionKey) ?? [])
      .slice()
      .sort((a, b) => a["@timestamp"].localeCompare(b["@timestamp"]));
    let providerIdx = 0;

    result[sessionKey] = entries.map((entry, i) => {
      let providerCalls = 0;
      let providerDurationMs = 0;
      while (
        providerIdx < providerRows.length &&
        providerRows[providerIdx]["@timestamp"].localeCompare(entry["@timestamp"]) <= 0
      ) {
        providerCalls++;
        providerDurationMs += providerRows[providerIdx].zeroclaw?.duration_ms ?? 0;
        providerIdx++;
      }
      return {
        turn: i + 1,
        session_key: sessionKey,
        timestamp: entry["@timestamp"],
        ...entry.attributes,
        provider_calls: providerCalls,
        provider_duration_ms: providerDurationMs,
        // Additive: every gateway_ws_turn row already carries a real outcome
        // discriminator (outcome: "success"|"failure", action: "complete"|
        // "fail"|"cancel"), but it was being read and thrown away. A fail/
        // cancel row carries no token/cost attrs at all, so completion-rate
        // logic (eval/runner/completion.mjs) needs this to tell "no tokens
        // because it failed" apart from "no tokens because unpriced".
        outcome: entry.event?.outcome ?? null,
        action: entry.event?.action ?? null,
      };
    });
  }

  return {
    sessions: result,
    meta: {
      totalLines: lines.length,
      skippedMalformed: skipped.malformed,
      skippedNoSessionKey: skipped.noSessionKey,
      sessionsFound: Object.keys(result).length,
      turnsFound: Object.values(result).reduce((n, t) => n + t.length, 0),
    },
  };
}

// Run as a script (not when imported for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const localPath = process.argv[2];
  const raw = readTrace(localPath);
  const { sessions, meta } = parseTrace(raw);
  console.error(
    `Parsed ${meta.totalLines} lines: ${meta.sessionsFound} sessions, ${meta.turnsFound} turns, ` +
      `skipped ${meta.skippedNoSessionKey} (no session_key) + ${meta.skippedMalformed} (malformed json).`,
  );
  console.log(JSON.stringify({ sessions, meta }, null, 2));
}
