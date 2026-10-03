# 2026-10-04: WER replay, rate48-r2 (model/base)

Recorded WAVs replayed through the page in system Chrome with a fake mic, `?eval=1&nosend=1`.
Nothing was sent to ZeroClaw. Hypothesis text is included because the cases are scripted.

- Cases attempted: 2; missing audio: none; run errors: none
- Scored: 2; no_transcript: 0; commit_mismatch: none
- Overall WER (corpus-level, excluding silence): 0.0% over 2 reference words (S0 D0 I0)

| id | status | WER | trigger | hypothesis |
|---|---|---|---|---|
| sh-02 | scored | 0.0% | auto_silence | "Stop" |
| sh-04 | scored | 0.0% | auto_silence | "What?" |

Command: `node eval/runner/run-wer.mjs --label rate48-r2 --model model/base --cases sh-02,sh-04`

## case_sets

`v1` is the original case set, the baseline every earlier run is comparable to. `all` also counts the cases added later (`set` in cases.jsonl). Empty-reference cases are excluded from both.

| | v1 | all scored cases |
|---|---|---|
| cases scored | 2 | 2 |
| reference words | 2 | 2 |
| corpus WER, raw | 0.0% | 0.0% |
| corpus WER, num_norm | 0.0% | 0.0% |

## number_normalization

Scoring change, not a pipeline change. This run's raw events are untouched; only `wer.mjs` changed.
It now also reports `num_norm`: 1 and 2 digit integers are turned into words on both sides before alignment (12 -> twelve, 25 -> twenty five).
The raw figures above are the old scoring and are unchanged. `has_digits` still flags the raw hypothesis.

| | all cases |
|---|---|
| corpus WER, raw | 0.0% |
| corpus WER, num_norm | 0.0% |
| first_word_soft first_word_ok | 0/0 raw, 0/0 num_norm |
| first_word_strong first_word_ok | 0/0 raw, 0/0 num_norm |

Cases whose hypothesis contains digits:

| id | WER raw | WER num_norm | hypothesis |
|---|---|---|---|

Not handled: integers of 3 or more digits, ordinals, decimals and times (none occur in these runs).

## 48khz_diagnostic (added by hand)

`rate48-r2` is a 48 kHz diagnostic, not a baseline run, and its numbers are not comparable to the baseline. It was a short smoke run of two cases (sh-02 and sh-04, short words) made to check speech detection when Chrome reports a 48000 Hz capture rate (the `mic_settings` events show 48000 Hz; the AudioContext rate was also 48000 Hz), on 2026-10-04 with code at 776dec9. Both cases detected speech and ended by auto-silence.
