# 2026-10-02: WER replay, pre-roll-r2 (model/base)

Recorded WAVs replayed through the page in system Chrome with a fake mic, `?eval=1&nosend=1`.
Nothing was sent to ZeroClaw. Hypothesis text is included because the cases are scripted.

- Cases attempted: 37; missing audio: none; run errors: none
- Scored: 35; no_transcript: 1; commit_mismatch: none
- Overall WER (corpus-level, excluding silence): 14.2% over 233 reference words (S24 D3 I6)

| id | status | WER | trigger | hypothesis |
|---|---|---|---|---|
| fws-01 | scored | 12.5% | auto_silence | "The meeting starts at 9 in the morning." |
| fws-02 | scored | 0.0% | auto_silence | "A cup of coffee would be nice right now." |
| fws-03 | scored | 0.0% | auto_silence | "It's going to rain later this afternoon." |
| fws-04 | scored | 0.0% | auto_silence | "So what time does the store close today?" |
| fws-05 | scored | 33.3% | auto_silence | "The train leads from platform platform." |
| fst-01 | scored | 0.0% | auto_silence | "Seven people are coming to dinner tonight." |
| fst-02 | scored | 12.5% | auto_silence | "Pante is the busiest day of the week." |
| fst-03 | scored | 0.0% | auto_silence | "Please remind me to call the bank tomorrow." |
| fst-04 | scored | 16.7% | auto_silence | "Well, students passed the final exam." |
| fst-05 | scored | 0.0% | auto_silence | "Bring the blue folder to the office" |
| pw-01 | scored | 22.2% | auto_silence | "The good brown fox Jumps over the lazy door." |
| pw-02 | scored | 28.6% | auto_silence | "Fox ran quickly across the fair." |
| pw-03 | scored | 28.6% | auto_silence | "She jumps rope every morning before the spoon." |
| pw-04 | scored | 33.3% | auto_silence | "Click the button and wait for a quick update. Great to reply." |
| aq-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| aq-02 | scored | 0.0% | auto_silence | "How many minutes are in a day?" |
| aq-03 | scored | 16.7% | auto_silence | "Set a timer for 10 minutes." |
| aq-04 | scored | 0.0% | auto_silence | "Tell me a short fact about the moon." |
| aq-05 | scored | 0.0% | auto_silence | "What is the difference between a virus and bacteria?" |
| aq-06 | scored | 0.0% | auto_silence | "Translate good morning into Spanish." |
| num-01 | scored | 60.0% | auto_silence | "Add 25 and 17." |
| num-02 | scored | 0.0% | auto_silence | "My flight is at half past six." |
| num-03 | scored | 16.7% | auto_silence | "Call me back in 15 minutes." |
| cas-01 | scored | 12.5% | auto_silence | "Um can you tell me One day it is" |
| cas-02 | scored | 16.7% | auto_silence | "Hey, oh, what's the weather looking like?" |
| cas-03 | scored | 0.0% | auto_silence | "Wait no i meant the other one" |
| sh-01 | no_transcript | no_transcript_final |  | "" |
| sh-02 | scored | 0.0% | manual | "Stop" |
| sh-03 | scored | 0.0% | auto_silence | "Thank you." |
| sh-04 | scored | 0.0% | manual | "What?" |
| sil-01 | silence | words_produced=0 | manual | "" |
| bn-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| bn-02 | scored | 28.6% | auto_silence | "How many minutes are in the in?" |
| bn-03 | scored | 33.3% | manual | "Set a timer for 10 minutes. Yes." |
| bn-04 | scored | 25.0% | auto_silence | "The meeting started nine in the morning." |
| bn-05 | scored | 0.0% | auto_silence | "Seven people are coming to dinner tonight." |
| bn-06 | scored | 66.7% | auto_silence | "Akku. If round folks jump. Over the lazy door" |

Command: `node eval/runner/run-wer.mjs --label pre-roll-r2 --model model/base`

## burst_affected

fws-01, bn-01 and bn-03 begin with a loud recording burst (near full-scale, decaying over 0.7 s to 2.5 s) before speech. They are kept in the corpus deliberately and flagged `burst_affected` in summary.json.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER (excl. silence) | 14.2% (233 ref words) | 14.1% (213 ref words) |
| first_word_ok, first_word_soft | 5/5 | 4/4 |
| first_word_ok, first_word_strong | 3/5 | 3/5 |

## number_normalization

Scoring change, not a pipeline change. This run's raw events are untouched; only `wer.mjs` changed.
It now also reports `num_norm`: 1 and 2 digit integers are turned into words on both sides before alignment (12 -> twelve, 25 -> twenty five).
The raw figures above are the old scoring and are unchanged. `has_digits` still flags the raw hypothesis.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER, raw | 14.2% | 14.1% |
| corpus WER, num_norm | 11.2% | 11.7% |
| first_word_soft first_word_ok | 5/5 raw, 5/5 num_norm | 4/4 raw, 4/4 num_norm |
| first_word_strong first_word_ok | 3/5 raw, 3/5 num_norm | 3/5 raw, 3/5 num_norm |

Cases whose hypothesis contains digits:

| id | WER raw | WER num_norm | hypothesis |
|---|---|---|---|
| fws-01 (burst_affected) | 12.5% | 0.0% | "The meeting starts at 9 in the morning." |
| aq-03 | 16.7% | 0.0% | "Set a timer for 10 minutes." |
| num-01 | 60.0% | 0.0% | "Add 25 and 17." |
| num-03 | 16.7% | 0.0% | "Call me back in 15 minutes." |
| bn-03 (burst_affected) | 33.3% | 16.7% | "Set a timer for 10 minutes. Yes." |

Not handled: integers of 3 or more digits, ordinals, decimals and times (none occur in these runs).

## pre_roll (added by hand)

Added by hand after the runs with a one-off script that is not in the repo. `run-wer.mjs` does not generate this section, because it compares several runs. The sections above it are generated.

Pipeline run with the 4 frame pre-roll (128 ms; `PRE_ROLL_FRAMES` in src/main.ts, commit 2783344, first pass, not calibrated). Same 37 cases, same recordings and the same settings as `baseline-base-r1` to `r3` (VAD thresholds unchanged). Eval mode logs a `pre_roll { frames }` event on every speech start.

- no_transcript: sh-01 (no_transcript_final; js_error: Error: failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: Non-zero status code returned while running Conv node. Name:'/conv3/Conv' Status Message: Invalid input shape: {1}); commit_mismatch: none; sil-01 words produced: 0

Mean of the 3 repeats (pre-roll r1 to r3) against the mean of the 3 baseline repeats:

| corpus WER (excl. silence) | baseline mean | pre-roll mean |
|---|---|---|
| all 37, raw | 27.5% | 15.7% |
| all 37, num_norm | 23.5% | 12.4% |
| excluding burst_affected, raw | 27.6% | 14.8% |
| excluding burst_affected, num_norm | 24.0% | 12.0% |

| first_word_ok (raw) | baseline mean | pre-roll mean | pre-roll r1 / r2 / r3 |
|---|---|---|---|
| first_word_soft (5) | 1.0 | 5.0 | 5 / 5 / 5 |
| first_word_strong (5) | 1.3 | 3.0 | 3 / 3 / 3 |
| 26 cases where model-only produced text | 8.3 | 22.0 | 22 / 23 / 21 |

Note: a repeat with no_transcript is left out of the corpus WER by the scorer (a single reference word in sh-01).
