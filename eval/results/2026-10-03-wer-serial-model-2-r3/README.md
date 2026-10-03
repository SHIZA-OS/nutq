# 2026-10-03: WER replay, serial-model-2-r3 (model/base)

Recorded WAVs replayed through the page in system Chrome with a fake mic, `?eval=1&nosend=1`.
Nothing was sent to ZeroClaw. Hypothesis text is included because the cases are scripted.

- Cases attempted: 37; missing audio: no-01, no-02, no-03, no-04, nts-01; run errors: none
- Scored: 36; no_transcript: 0; commit_mismatch: none
- Overall WER (corpus-level, excluding silence): 10.7% over 234 reference words (S18 D5 I2)

| id | status | WER | trigger | hypothesis |
|---|---|---|---|---|
| fws-01 | scored | 12.5% | auto_silence | "The meeting starts at 9 in the morning." |
| fws-02 | scored | 0.0% | auto_silence | "A cup of coffee would be nice right now." |
| fws-03 | scored | 0.0% | auto_silence | "It's going to rain later this afternoon." |
| fws-04 | scored | 0.0% | auto_silence | "So what time does the store close today?" |
| fws-05 | scored | 16.7% | auto_silence | "The train leaves from platform 4." |
| fst-01 | scored | 0.0% | auto_silence | "Seven people are coming to dinner tonight." |
| fst-02 | scored | 12.5% | auto_silence | "Pante is the busiest day of the week." |
| fst-03 | scored | 0.0% | auto_silence | "Please remind me to call the bank tomorrow." |
| fst-04 | scored | 33.3% | auto_silence | "Well students, past the final exam." |
| fst-05 | scored | 0.0% | auto_silence | "Bring the blue folder to the office" |
| pw-01 | scored | 33.3% | auto_silence | "Tucked brown fox Jumps over the lazy door." |
| pw-02 | scored | 0.0% | auto_silence | "A fox ran quickly across the field." |
| pw-03 | scored | 28.6% | auto_silence | "She jumps rope every morning before the spoon." |
| pw-04 | scored | 0.0% | auto_silence | "Click the button and wait for a quick Reply." |
| aq-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| aq-02 | scored | 0.0% | auto_silence | "How many minutes are in a day?" |
| aq-03 | scored | 16.7% | auto_silence | "Set a timer for 10 minutes." |
| aq-04 | scored | 0.0% | auto_silence | "Tell me a short fact about the moon." |
| aq-05 | scored | 0.0% | auto_silence | "What is the difference between a virus and bacteria?" |
| aq-06 | scored | 0.0% | auto_silence | "Translate good morning into Spanish." |
| num-01 | scored | 60.0% | auto_silence | "Add 25 and 17." |
| num-02 | scored | 0.0% | auto_silence | "My flight is at half past six." |
| num-03 | scored | 16.7% | auto_silence | "Call me back in 15 minutes." |
| cas-01 | scored | 0.0% | auto_silence | "Um can you tell me What day it is" |
| cas-02 | scored | 16.7% | auto_silence | "Hey, oh, what's the weather looking like?" |
| cas-03 | scored | 0.0% | auto_silence | "Wait no i meant the other one" |
| sh-01 | scored | 0.0% | manual | "Yes." |
| sh-02 | scored | 0.0% | manual | "Stop" |
| sh-03 | scored | 0.0% | auto_silence | "Thank you." |
| sh-04 | scored | 0.0% | manual | "What?" |
| sil-01 | silence | words_produced=0 | manual | "" |
| bn-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| bn-02 | scored | 28.6% | auto_silence | "How many minutes are in the in?" |
| bn-03 | scored | 16.7% | manual | "Set a timer for 10 minutes." |
| bn-04 | scored | 25.0% | auto_silence | "The meeting started nine in the morning." |
| bn-05 | scored | 0.0% | auto_silence | "Seven people are coming to dinner tonight." |
| bn-06 | scored | 44.4% | auto_silence | "Brown folks jump Over the lazy dog" |

Command: `node eval/runner/run-wer.mjs --label serial-model-2-r3 --model model/base`

## burst_affected

fws-01, bn-01 and bn-03 begin with a loud recording burst (near full-scale, decaying over 0.7 s to 2.5 s) before speech. They are kept in the corpus deliberately and flagged `burst_affected` in summary.json.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER (excl. silence) | 10.7% (234 ref words) | 10.7% (214 ref words) |
| first_word_ok, first_word_soft | 5/5 | 4/4 |
| first_word_ok, first_word_strong | 3/5 | 3/5 |

## case_sets

`v1` is the original case set, the baseline every earlier run is comparable to. `all` also counts the cases added later (`set` in cases.jsonl). Empty-reference cases are excluded from both.

| | v1 | all scored cases |
|---|---|---|
| cases scored | 36 | 36 |
| reference words | 234 | 234 |
| corpus WER, raw | 10.7% | 10.7% |
| corpus WER, num_norm | 7.3% | 7.3% |

## number_normalization

Scoring change, not a pipeline change. This run's raw events are untouched; only `wer.mjs` changed.
It now also reports `num_norm`: 1 and 2 digit integers are turned into words on both sides before alignment (12 -> twelve, 25 -> twenty five).
The raw figures above are the old scoring and are unchanged. `has_digits` still flags the raw hypothesis.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER, raw | 10.7% | 10.7% |
| corpus WER, num_norm | 7.3% | 7.9% |
| first_word_soft first_word_ok | 5/5 raw, 5/5 num_norm | 4/4 raw, 4/4 num_norm |
| first_word_strong first_word_ok | 3/5 raw, 3/5 num_norm | 3/5 raw, 3/5 num_norm |

Cases whose hypothesis contains digits:

| id | WER raw | WER num_norm | hypothesis |
|---|---|---|---|
| fws-01 (burst_affected) | 12.5% | 0.0% | "The meeting starts at 9 in the morning." |
| fws-05 | 16.7% | 0.0% | "The train leaves from platform 4." |
| aq-03 | 16.7% | 0.0% | "Set a timer for 10 minutes." |
| num-01 | 60.0% | 0.0% | "Add 25 and 17." |
| num-03 | 16.7% | 0.0% | "Call me back in 15 minutes." |
| bn-03 (burst_affected) | 16.7% | 0.0% | "Set a timer for 10 minutes." |

Not handled: integers of 3 or more digits, ordinals, decimals and times (none occur in these runs).

## time_window_and_model_speed (added by hand)

This run (`serial-model-2-r3`, code at 3bbc439, serialized model calls with `stt_model_call` events) ran on 2026-10-03 from 21:17 to 21:29 local time. The `stop-guard-gate` runs it is compared against ran earlier the same day, from 13:05 to 13:36, so the two arms are not interleaved and were not measured in the same machine state.

Model speed varied about 2x between repeats of this arm: the mean model run time for 64 frame commits was 400 ms in `r1`, 386 ms in `r2` and 197 ms in `r3` (from the `stt_model_call` events). `stop-guard-gate` has no such events, so its model speed is unknown. Corpus WER (v1, normalized) was 11.5%, 12.4% and 7.3% in `r1` to `r3`; with three points this is a correlation, not a shown cause. See the interleaved A/B runs for the controlled comparison.
