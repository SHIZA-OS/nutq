# 2026-10-05: phase-swept replay WER, noise-fixed5000 (model/base)

Every recorded case is replayed offline through the real Transcriber (real Silero VAD, SpeechBuffer and Moonshine model; `replay-commits.mjs --wer`) at each of 8 frame phases, and scored with wer.mjs. Phase p prepends p x 64 zero samples to the WAV (64 samples = 4 ms), so the 512 sample frame boundaries fall at a different place relative to the speech. Pre-roll 4 frames.

- **End of turn mirrors `run-wer.mjs`.** The same turn policy `main.ts` uses (`src/turn-policy.ts`) is driven with time from frame positions: auto-silence SILENCE_COMMIT_MS (5000 ms) after a speech end or misfire, cancelled by a speech start. After the WAV ends, silence is fed until the policy ends the turn or until WAV duration + 10 s, then the turn is stopped manually. Live baseline runs ended 32 of 37 turns with auto-silence.
- Not modelled: Chrome's mic capture and processing, resampling from the capture rate, real-time scheduling (model runs do not delay frames here), and streaming updates (answered with an empty string).
- Deterministic by construction: no timestamps are written, and two runs of the same code are expected to be identical.
- This is a different measurement from the live runs (`run-wer.mjs`). Use it to compare logic changes; take absolute numbers from interleaved live runs.

Missing audio: none. v1 is the original case set (silence and empty-reference cases excluded); first words /26 counts first_word_ok over the 26 cases where untrimmed model-only produced text.

| phase | lead samples | v1 normalized WER | v1 raw WER | first words /26 | soft first words /5 | multi-commit cases | turns ended by auto_silence / stop |
|---|---|---|---|---|---|---|---|
| 0 | 0 | 0.0% | 0.0% | 0 | 0 | 0 | 2 / 4 |
| 1 | 64 | 0.0% | 0.0% | 0 | 0 | 0 | 3 / 3 |
| 2 | 128 | 0.0% | 0.0% | 0 | 0 | 0 | 3 / 3 |
| 3 | 192 | 0.0% | 0.0% | 0 | 0 | 0 | 3 / 3 |
| 4 | 256 | 0.0% | 0.0% | 0 | 0 | 0 | 3 / 3 |
| 5 | 320 | 0.0% | 0.0% | 0 | 0 | 0 | 3 / 3 |
| 6 | 384 | 0.0% | 0.0% | 0 | 0 | 0 | 3 / 3 |
| 7 | 448 | 0.0% | 0.0% | 0 | 0 | 0 | 3 / 3 |
| **mean across phases** | | **0.0%** | **0.0%** | **0.0** | | | |

Range of v1 normalized WER across phases: 0.0% to 0.0%.

## end of turn

Policy `fixed:5000`, commit latency scale 1. Pooled over the 8 phases. "premature" is a turn an auto-silence ended while the file still held speech; the wait after the true end is counted from the last frame of speech (VAD probability 0.5 or above, gaps under 512 ms bridged), for turns that cut nothing off, and excludes the live flush after the end. Text reaches the policy at the commit's fire time plus a modelled model run time. The speech runs come from the VAD, so speech it misses (soft speech in the noise cases, for example bn-03's late "Yes.") is not seen as speech to come: premature can read false there, and a cut-off shows up as a deleted word in the WER (hence the v1 gate).

| set | turn-phases | with a pause | premature | true ends | wait median ms | wait p90 ms | wait max ms |
|---|---|---|---|---|---|---|---|
| v1 | 8 | 0 | 0 | 0 | null | null | null |
| all | 48 | 10 | 0 | 23 | 5768 | 5768 | 5864 |

| id | pause ms | premature phases | hint at arm | wait at arm ms | wait after true end ms, per phase |
|---|---|---|---|---|---|
| nts-01 | 1376 | 0 | unknown | 5000 | 5768 5736 4264 5768 5768 5736 5768 5736 |

## per case

Mean normalized WER across phases, the number of distinct hypotheses over the phases, and the phase 0 hypothesis. Every phase's hypothesis is in `summary.json`.

| id | mean WER | distinct hypotheses | phase 0 hypothesis |
|---|---|---|---|
| nts-01 | 62.5% | 3 | "" |

Command: `node eval/runner/replay-commits.mjs --wer noise-fixed5000 --phases 8 --pre-roll 4 --cases no-01,no-02,no-03,no-04,nts-01,sil-01`
