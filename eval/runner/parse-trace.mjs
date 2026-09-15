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

    if (entry.message !== "gateway_ws_turn") continue; // only turns become records

    if (!turnsBySession.has(sessionKey)) turnsBySession.set(sessionKey, []);
    turnsBySession.get(sessionKey).push(entry);
  }

  // Order by @timestamp, not trace_id (trace_id is assigned per logging
  // call-site, not per-turn — confirmed finding, docs/eval-harness-design.md §8).
  const result = {};
  for (const [sessionKey, entries] of turnsBySession) {
    entries.sort((a, b) => a["@timestamp"].localeCompare(b["@timestamp"]));
    result[sessionKey] = entries.map((entry, i) => ({
      turn: i + 1,
      session_key: sessionKey,
      timestamp: entry["@timestamp"],
      ...entry.attributes,
    }));
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
