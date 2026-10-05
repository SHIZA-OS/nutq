# 2026-09-28: failed-provider turn

## What was tested

Intended as a dropped-turn test via `docker restart`. It instead produced a `failed_provider`
turn (session key `gw_fad8b607-d608-4d46-bbe1-5fde17e6113c`, model `claude-haiku-4-5-20251001`).

## What happened

- The provider failed 0.4s after the send, with an empty error detail: the error text is
  `All model providers/models failed after 0 failure event(s). Events:` (`PROVIDER_ERROR`).
- `ws_closed` (code 1006) followed 5.4s after the error frame.
- `completion.mjs` classifies the turn as `failed_provider`: 1 turn, `turn_completion_rate: 0`,
  `strict_session_completed: false`.

## Cause (confirmed)

The container was running with a stale provider API credential. After refreshing the credential in the
container's environment and recreating the container, a CLI sanity check succeeded.

## How the client events file was matched

Client events never carry a session key, so `raw/events-failed-provider.jsonl` was matched by
timestamp and error text against the trace rows for this session, all three checks passing:

- `ws_message_sent` at 15:01:57.150 UTC (server `llm_request` at 15:01:57.193).
- `turn_error_frame` at 15:01:57.622 UTC, whose message equals the trace's `gateway_ws_turn`
  `error` text exactly.
- `ws_closed` code 1006 at 15:02:03.057 UTC.

The clock-offset caveat from the first-live run still applies: client and container clocks were
never compared, so the agreement above is approximate, not a measured offset.

## Files

- `raw/` (gitignored): `trace-gw_fad8b607.jsonl` (10 live `runtime-trace.jsonl` rows for this
  session) and `events-failed-provider.jsonl` (12 client events).
- `summary.json` (committed): `completion.mjs` output. Outcomes only, no transcript text or
  secrets. `join-latency.mjs` was not run; latency of a failed turn is not meaningful.
