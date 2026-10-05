# 2026-10-05: end-of-build recordings pass

Code under test: `b8f8d70daa46d439db1a0104e38bda82f9b18752` (after the re-arm window, hold-and-send, reply-timeout close, and the first-utterance wait; none of them touches the Transcriber, the VAD, the speech buffer or the turn policy). Audio: the 57 recordings in a local `nutq-eval-audio/cases/` directory (never committed), replayed offline through the real Transcriber (real Silero VAD, SpeechBuffer and Moonshine model/base) at 8 frame phases, pre-roll 4 frames, the same way as every earlier phase-swept replay (`replay-commits.mjs --wer`). 456 case-phases per replay. Per-phase summaries of both replays are in `raw/` (gitignored); `summary.json` here has the numbers.

## Step 1: fixed policy against f2de874 (v1 normalized)

Command: `node eval/runner/replay-commits.mjs --wer eob-fixed --phases 8 --pre-roll 4` (end of turn: fixed 5000 ms auto-silence, as every baseline).

- **Hypotheses: identical.** 296 v1 case-phases compared with `2026-10-04-wer-replay-head` (f2de874): 0 differ. v1 normalized WER by phase is the same in all 8 phases: 9.8, 11.1, 10.7, 11.1, 10.3, 9.4, 10.7, 12.0%; mean 10.6%.
- The `trigger` differs in 288 of the 296: f2de874 ended turns with a manual stop at the end of the WAV, and the replay now models the 5 s auto-silence (documented in PROGRESS). The hypotheses are not affected.
- Against `2026-10-05-wer-gate-fixed5000` (all 57 recordings, the fixed policy of the sweep session): 456 case-phases, 0 differ in hypothesis or in trigger.
- All 57 recordings: normalized WER mean 12.0%. Pause cuts 0 of 96. Noise recordings: 0 of 40 turn-phases would send text. nts-01 sends "stop" in 3 of 8 phases (as in the sweep). Wait after the true end: median 5768, p90 5800, max 6152 ms.

## Step 2: conservative semantic policy against the sweep

Command: `node eval/runner/replay-commits.mjs --wer eob-semantic --phases 8 --pre-roll 4 --policy semantic:1000,2200,2500,0,8000 --gate 2026-10-04-wer-replay-head-policy` (done 1000, unknown 2200, open 2500, floor 0, ceiling 8000 ms; commit latency scale 1).

The gate reference is the one the sweep used for its real replays (`2026-10-04-wer-replay-head-policy`, v1 cases): the endpoint-sweep directory has no per-phase summaries to gate against. The numbers are compared with the sweep's row for this policy (`2026-10-05-endpoint-sweep/README.md`, "Real replay of the chosen policies").

| | this run | sweep (9afdec5) |
|---|---|---|
| v1 gate | PASS, 0 new errors, 2 for review | PASS, 0 fail, 2 review |
| review items | phase 0 bn-03, phase 1 bn-03 (both "Yes." became "Yes", same errors S/D/I 0/0/1 and 1/0/1) | phase 0 bn-03, phase 1 bn-03 |
| v1 WER (mean over phases) | 10.6% | 10.6% |
| all-57 WER | 14.4% | 14.4% |
| cuts on the 12 pause recordings (of 96 turn-phases) | 12: mp-10 8/8, mp-12 3/8, mp-09 1/8 | 12: mp-10 8/8, mp-12 3/8, mp-09 1/8 |
| wait after the true end, median / p90 / max ms | 1768 / 2968 / 3352 | 1768 / 2968 / 3352 |
| noise sends (of 40) | 0 | 0 |
| nts-01 "stop" (of 8) | 3 | 3 |

- **Waits:** against the fixed policy of step 1 (median 5768 ms) the semantic policy sends a median 4000 ms earlier, and its worst wait is 3352 ms against 6152 ms.
- **Cuts:** 12 of 96 pause turn-phases, all in 3 recordings (see the sweep for why: a pause after a complete clause reads as done, and Moonshine sometimes puts a full stop mid-sentence). The 8 phases are not independent samples. This is why the all-57 WER is 14.4% against 12.0% for the fixed policy: the cut-off takes lose words. v1 recordings are not cut at all (0 of 296).
- **New errors: none** in either step. The 2 review items are a trailing full stop on a late "Yes" in bn-03 with the same error count.

Not measured here: Chrome's mic processing, real-time scheduling, and anything live. The replay says nothing about the speech output (the first-utterance wait, hold-and-send, the timeout).
