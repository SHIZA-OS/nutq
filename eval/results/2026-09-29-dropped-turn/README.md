# 2026-09-29: dropped turn (docker kill mid-turn)

## What was tested

A single-turn session on a fresh page load with `?eval=1`, against a real ZeroClaw instance
(model `claude-haiku-4-5-20251001`). One manual send, then `docker kill zeroclaw` (SIGKILL) while
the turn was in flight. The client saw `ws_closed` (code 1006, `received_session_start: true`)
1.37s after `ws_message_sent`, with no `done_received`, `turn_error_frame` or `turn_aborted`.

## Method

1. Fresh page load with `?eval=1`, paired, one manual send.
2. `docker kill zeroclaw` right after the send.
3. Downloaded the events JSONL from the page.
4. `docker start zeroclaw`, then copied `runtime-trace.jsonl` out of the container immediately
   (the trace keeps only the last 200 rows).
5. Classified with `completion.mjs --no-server-session`.

## Result

`completion.mjs` classifies turn 1 as `dropped` (`failure_events: ["ws_closed"]`): 1 turn,
`turn_completion_rate: 0`, `strict_session_completed: false`, `session_key: null`.

## Evidence the server received the turn and died mid-turn

- Client `ws_message_sent` at 13:58:04.388 UTC; server `llm_request` row at 13:58:04.440Z, about
  52ms later. The client and container clocks were never compared, so the 52ms is approximate.
- After that `llm_request` (and two `task spawned` rows) the trace has no `gateway_ws_turn` row
  (complete, fail or cancel) for this turn. The next rows are the daemon restart at 13:59:26.
- The only `gateway_ws_turn` rows in the trace are from other sessions and predate this send.
- `gateway_ws_turn` is written at the end of a turn (`ws.rs`, success, fail and cancel paths), so
  SIGKILL before the turn finished means it was never written.

## Why `--no-server-session`

`gateway_ws_turn` is the only row that carries a `session_key`, and it is written at the end of a
turn. A dropped turn therefore has no server session by construction: `parse-trace.mjs` skips its
`llm_request` row for lack of a `session_key`, and there is nothing to pass to `--session`. The
flag declares that this events file belongs to a session with no server rows; every client turn
then goes to `client_turns_without_server_row`. Nothing is inferred from timestamps and no client
timestamp is subtracted from a container timestamp.

## Finding: "dropped" was unreachable on real data before 4c52aca

Before `4c52aca`, `join-latency.mjs` could only reach `client_turns_without_server_row` when the
picked session had fewer server rows than the client sent turns, and `pickSession` threw when the
trace had no matching session. The existing `dropped` tests passed a hand-built `{ [SK]: [] }`
session, a shape `parseTrace` never produces, so they passed while the real path failed. The first
attempt at this run stopped at "pass --session to pick one" for exactly that reason.

## Void attempts

Two earlier attempts were void and are not recorded as results: one where the kill came before
the send, and one where the kill came after the turn had already completed.

## Known limitations

- **One sample.** One dropped turn is an existence proof for the classification path, not a rate.
- **Mid-session drops.** A drop partway through a multi-turn session is still the
  positional-matching limitation in section 8 of `docs/eval-harness-design.md`: the server array
  is one entry short from that point on and later turns misalign. `--no-server-session` is only
  right for a session with no server rows at all.
- **No clock-offset measurement**, as in the earlier runs.

## Files

- `raw/` (gitignored): `events-dropped-turn.jsonl` (7 client events) and `runtime-trace.jsonl`
  (the 201-row live trace copy taken right after restart).
- `summary.json` (committed): `completion.mjs --no-server-session` output plus the timestamps
  cited above. Numbers and outcomes only; no transcript text, reply content, or secrets.
