# 2026-10-03: WER replay, rawmic-r1 (model/base)

Recorded WAVs replayed through the page in system Chrome with a fake mic, `?eval=1&nosend=1`, and `rawmic=1` (echo cancellation, noise suppression and auto gain off).
Nothing was sent to ZeroClaw. Hypothesis text is included because the cases are scripted.

- Cases attempted: 37; missing audio: no-01, no-02, no-03, no-04, nts-01; run errors: none
- Scored: 36; no_transcript: 0; commit_mismatch: none
- Overall WER (corpus-level, excluding silence): 18.4% over 234 reference words (S24 D9 I10)

| id | status | WER | trigger | hypothesis |
|---|---|---|---|---|
| fws-01 | scored | 12.5% | auto_silence | "The meeting starts at 9 in the morning." |
| fws-02 | scored | 0.0% | auto_silence | "A cup of coffee would be nice right now." |
| fws-03 | scored | 0.0% | auto_silence | "It's going to rain later this afternoon." |
| fws-04 | scored | 75.0% | auto_silence | "So what time does the store closed so what time does the" |
| fws-05 | scored | 50.0% | auto_silence | "The train lives from platform 4. Or?" |
| fst-01 | scored | 0.0% | auto_silence | "Seven people are coming to dinner tonight." |
| fst-02 | scored | 12.5% | auto_silence | "Bhante is the busiest day of the week." |
| fst-03 | scored | 0.0% | auto_silence | "Please remind me to call the bank tomorrow." |
| fst-04 | scored | 33.3% | auto_silence | "Well students, past the final exam." |
| fst-05 | scored | 0.0% | auto_silence | "Bring the blue folder to the office." |
| pw-01 | scored | 33.3% | auto_silence | "The good brown box Jump over the lazy dog" |
| pw-02 | scored | 0.0% | auto_silence | "A fox ran quickly across the field." |
| pw-03 | scored | 14.3% | auto_silence | "She jumps rope every morning before the school." |
| pw-04 | scored | 22.2% | auto_silence | "Click the button and wait for a quick clip Like." |
| aq-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| aq-02 | scored | 0.0% | auto_silence | "How many minutes are in a day?" |
| aq-03 | scored | 16.7% | auto_silence | "Set a timer for 10 minutes." |
| aq-04 | scored | 0.0% | auto_silence | "Tell me a short fact about the moon" |
| aq-05 | scored | 0.0% | auto_silence | "What is the difference between a virus and bacteria?" |
| aq-06 | scored | 0.0% | auto_silence | "Translate good morning into Spanish." |
| num-01 | scored | 80.0% | auto_silence | "At 25 and 17." |
| num-02 | scored | 0.0% | auto_silence | "My flight is at half past six." |
| num-03 | scored | 16.7% | auto_silence | "Call me back in 15 minutes" |
| cas-01 | scored | 0.0% | auto_silence | "Um can you tell me What day it is?" |
| cas-02 | scored | 16.7% | auto_silence | "Hey, oh, what's the weather looking like?" |
| cas-03 | scored | 0.0% | auto_silence | "Wait no I meant the other one" |
| sh-01 | scored | 0.0% | manual | "Yes." |
| sh-02 | scored | 100.0% | manual | "" |
| sh-03 | scored | 0.0% | auto_silence | "Thank you." |
| sh-04 | scored | 0.0% | manual | "What?" |
| sil-01 | silence | words_produced=0 | manual | "" |
| bn-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| bn-02 | scored | 14.3% | auto_silence | "How many minutes are in the day" |
| bn-03 | scored | 100.0% | manual | "" |
| bn-04 | scored | 37.5% | auto_silence | "The meeting started 9 in the morning." |
| bn-05 | scored | 0.0% | auto_silence | "Seven people are coming to dinner tonight." |
| bn-06 | scored | 66.7% | auto_silence | "A good that quick Brown folks jump Over the lazy door" |

Command: `node eval/runner/run-wer.mjs --label rawmic-r1 --model model/base --rawmic`

## burst_affected

fws-01, bn-01 and bn-03 begin with a loud recording burst (near full-scale, decaying over 0.7 s to 2.5 s) before speech. They are kept in the corpus deliberately and flagged `burst_affected` in summary.json.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER (excl. silence) | 18.4% (234 ref words) | 16.8% (214 ref words) |
| first_word_ok, first_word_soft | 5/5 | 4/4 |
| first_word_ok, first_word_strong | 3/5 | 3/5 |

## case_sets

`v1` is the original case set, the baseline every earlier run is comparable to. `all` also counts the cases added later (`set` in cases.jsonl). Empty-reference cases are excluded from both.

| | v1 | all scored cases |
|---|---|---|
| cases scored | 36 | 36 |
| reference words | 234 | 234 |
| corpus WER, raw | 18.4% | 18.4% |
| corpus WER, num_norm | 15.0% | 15.0% |

## number_normalization

Scoring change, not a pipeline change. This run's raw events are untouched; only `wer.mjs` changed.
It now also reports `num_norm`: 1 and 2 digit integers are turned into words on both sides before alignment (12 -> twelve, 25 -> twenty five).
The raw figures above are the old scoring and are unchanged. `has_digits` still flags the raw hypothesis.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER, raw | 18.4% | 16.8% |
| corpus WER, num_norm | 15.0% | 13.6% |
| first_word_soft first_word_ok | 5/5 raw, 5/5 num_norm | 4/4 raw, 4/4 num_norm |
| first_word_strong first_word_ok | 3/5 raw, 3/5 num_norm | 3/5 raw, 3/5 num_norm |

Cases whose hypothesis contains digits:

| id | WER raw | WER num_norm | hypothesis |
|---|---|---|---|
| fws-01 (burst_affected) | 12.5% | 0.0% | "The meeting starts at 9 in the morning." |
| fws-05 | 50.0% | 33.3% | "The train lives from platform 4. Or?" |
| aq-03 | 16.7% | 0.0% | "Set a timer for 10 minutes." |
| num-01 | 80.0% | 20.0% | "At 25 and 17." |
| num-03 | 16.7% | 0.0% | "Call me back in 15 minutes" |
| bn-04 | 37.5% | 25.0% | "The meeting started 9 in the morning." |

Not handled: integers of 3 or more digits, ordinals, decimals and times (none occur in these runs).

## variance_diagnostic (added by hand)

`rawmic-r1` is a variance diagnostic, not a baseline run, and its WER is not comparable to the baseline or to any run made without `--rawmic`. It was run with `?rawmic=1`: echo cancellation, noise suppression and auto gain were all off (every `mic_settings` event shows this), to test whether Chrome's mic processing is a source of run-to-run differences in the audio. Two runs back to back on 2026-10-03 (`rawmic-r1` 23:19 to 23:29, `rawmic-r2` 23:29 to 23:40), code at b7ee99c. In `rawmic-r1` bn-03 had no `speech_start` and produced nothing.
