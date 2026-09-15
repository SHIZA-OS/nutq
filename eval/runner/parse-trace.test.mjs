import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrace } from "./parse-trace.mjs";

test("skips rows with no session_key, groups turns by session, orders by timestamp not trace_id", () => {
  const lines = [
    // no session_key anywhere -> skipped
    JSON.stringify({ "@timestamp": "t0", message: "task spawned", zeroclaw: {} }),
    // session_key under zeroclaw.session_key, not a turn -> not counted as a turn record
    JSON.stringify({ "@timestamp": "t1", message: "turn_final_response", zeroclaw: { session_key: "gw_a" } }),
    // two turns, same session, out of order + mismatched trace_id ordering on purpose
    JSON.stringify({
      "@timestamp": "t3",
      message: "gateway_ws_turn",
      attributes: { session_key: "gw_a", trace_id: "zzz-later-alphabetically", tokens_used: 20 },
    }),
    JSON.stringify({
      "@timestamp": "t2",
      message: "gateway_ws_turn",
      attributes: { session_key: "gw_a", trace_id: "aaa-earlier-alphabetically", tokens_used: 10 },
    }),
    "not json {{{",
  ];

  const { sessions, meta } = parseTrace(lines.join("\n"));

  assert.equal(meta.totalLines, 5);
  assert.equal(meta.skippedNoSessionKey, 1);
  assert.equal(meta.skippedMalformed, 1);
  assert.equal(meta.turnsFound, 2);
  assert.deepEqual(
    sessions["gw_a"].map((t) => [t.turn, t.timestamp, t.tokens_used]),
    [
      [1, "t2", 10], // earlier @timestamp -> turn 1, despite trace_id sorting the other way
      [2, "t3", 20],
    ],
  );
});
