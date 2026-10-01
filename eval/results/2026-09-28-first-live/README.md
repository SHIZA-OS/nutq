# 2026-09-28: first live eval run

## What was tested

One real, manually recorded 3-turn session against a real ZeroClaw instance (session key
`gw_c5986c81-130d-419b-90d9-55ee0d1f3cf0`, model `claude-haiku-4-5-20251001`), all in one
connection, covering the three `send_trigger`/end-of-speech shapes the harness distinguishes:

1. **Turn 1**: manual tap-to-send after a natural pause (clean `speech_end` boundary).
2. **Turn 2**: manual tap-to-send while still mid-utterance (no `speech_end` fired; falls back to
   `mic_button_release`).
3. **Turn 3**: `auto_silence` (no second tap; the 5000ms `SILENCE_COMMIT_MS` timer fired).

Plus a separate no-message drop test: connected with `?eval=1`, sent nothing, restarted the
`zeroclaw` container, and confirmed the client captured a `ws_closed` event (`code: 1006`,
`received_session_start: true`) with no turn ever sent.

## Build commit hash

Harness code used to generate `summary.json`: `191a1d76770b47bdb0c4f9322786af0045a7466f`. The raw
3-turn session itself was recorded manually via `?eval=1` before `join-latency.mjs`,
`parse-trace.mjs`'s outcome/action fields, and `completion.mjs` existed; `summary.json` re-runs
today's harness code against that same raw data, not a re-recording.

## Model

`claude-haiku-4-5-20251001` (ZeroClaw's `anthropic.default` provider alias), confirmed from the
`gateway_ws_turn` trace rows for all three turns.

## Headline numbers

- **Turn completion**: 3/3 completed (`turn_completion_rate: 1`, `strict_session_completed: true`).
  No `failed_provider`, `cancelled`, or `dropped` turns in this session.
- **User-perceived latency** (`tts_start - mic_button_release` for manual turns, `post_trigger` for
  auto_silence): turn 1 (natural pause) 3800ms, turn 2 (mid-utterance) 2578ms, turn 3 (auto_silence)
  2324ms, with the deliberate 5000ms silence wait reported separately as `timer_wait_ms: 5020`, not
  folded into the latency number.
- **Token shape**: roughly 19.6k input tokens against roughly 30 output tokens per turn (19,618/32,
  19,718/24, 19,812/45 across the three turns) on the default agent.
- **Cost**: ZeroClaw reports `cost_usd: 0` for all three turns. Per
  `docs/eval-harness-design.md` section 5.6, this is a known ZeroClaw gap (no pricing source
  configured anywhere in that instance's chain), not a real zero cost, and cost per turn is out of
  scope for Nutq's own harness regardless.

## Known limitations of this run

- **Three samples.** One 3-turn session is not a statistically meaningful sample; these numbers are
  a first real data point, not a baseline.
- **No clock-offset measurement.** The browser's `Date.now()` and the ZeroClaw container's
  `@timestamp` clock were never compared against each other; client-only stages use client
  timestamps exclusively, server-internal timing uses server timestamps exclusively, and the two are
  never subtracted against each other (see `join-latency.mjs`'s own `meta.note`).
- **~32ms onset clip** in the audio capture path.

## Files

- `raw/` (gitignored): `events-3turn-session.jsonl` (the recorded session's client events),
  `events-drop-test-no-message.jsonl` (the no-message drop test's single `ws_closed` event), and
  `trace-gw_c5986c81.jsonl` (the live `runtime-trace.jsonl` rows for this session only).
- `summary.json` (committed): `join-latency.mjs` and `completion.mjs` output for the 3-turn session.
  Numbers and outcomes only; no transcript text, no reply content, no tokens/secrets.
