# 2026-10-02: WER replay, baseline-base-r3 (model/base)

Recorded WAVs replayed through the page in system Chrome with a fake mic, `?eval=1&nosend=1`.
Nothing was sent to ZeroClaw. Hypothesis text is included because the cases are scripted.

- Cases attempted: 37; missing audio: none; run errors: none
- Scored: 36; no_transcript: 0; commit_mismatch: none
- Overall WER (corpus-level, excluding silence): 29.9% over 234 reference words (S57 D7 I6)

| id | status | WER | trigger | hypothesis |
|---|---|---|---|---|
| fws-01 | scored | 25.0% | auto_silence | "A meeting starts at 9 in the morning." |
| fws-02 | scored | 0.0% | auto_silence | "A cup of coffee would be nice right now." |
| fws-03 | scored | 14.3% | auto_silence | "Going to rain later this afternoon." |
| fws-04 | scored | 50.0% | auto_silence | "What timed as the store closed today?" |
| fws-05 | scored | 50.0% | auto_silence | "A train leads from platform 4." |
| fst-01 | scored | 14.3% | auto_silence | "Heaven people are coming to dinner tonight." |
| fst-02 | scored | 25.0% | auto_silence | "One day is the busiest day of the week." |
| fst-03 | scored | 75.0% | auto_silence | "These remained middle called the bank tumor." |
| fst-04 | scored | 33.3% | auto_silence | "El Studernz passed the final exam." |
| fst-05 | scored | 0.0% | auto_silence | "Bring the blue folder to the office." |
| pw-01 | scored | 33.3% | auto_silence | "I put brown fox Jumps over the lazy door." |
| pw-02 | scored | 0.0% | auto_silence | "A fox ran quickly across the field." |
| pw-03 | scored | 42.9% | auto_silence | "He jumps rope every morning before the spoon." |
| pw-04 | scored | 0.0% | auto_silence | "Click the button and wait for a quick Reply." |
| aq-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| aq-02 | scored | 0.0% | auto_silence | "How many minutes are in a day?" |
| aq-03 | scored | 33.3% | auto_silence | "Add a timer for 10 minutes." |
| aq-04 | scored | 50.0% | auto_silence | "I'll be assured, fact about the moon." |
| aq-05 | scored | 0.0% | auto_silence | "What is the difference between a virus and bacteria?" |
| aq-06 | scored | 100.0% | auto_silence | "So let's get the gumball." |
| num-01 | scored | 80.0% | auto_silence | "At 25 and 17." |
| num-02 | scored | 42.9% | auto_silence | "I have light is at half past six." |
| num-03 | scored | 33.3% | auto_silence | "Let me back in 15 minutes" |
| cas-01 | scored | 12.5% | auto_silence | "Um, can you tell me? One day it is" |
| cas-02 | scored | 16.7% | auto_silence | "Hey, oh, what's the weather looking like?" |
| cas-03 | scored | 0.0% | auto_silence | "Wait no I meant the other one" |
| sh-01 | scored | 0.0% | manual | "Yes." |
| sh-02 | scored | 100.0% | manual | "" |
| sh-03 | scored | 0.0% | auto_silence | "Thank you." |
| sh-04 | scored | 0.0% | manual | "What?" |
| sil-01 | silence | words_produced=0 | manual | "" |
| bn-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| bn-02 | scored | 28.6% | auto_silence | "How many minutes are in the in?" |
| bn-03 | scored | 100.0% | manual | "The tattoo of both hand winners" |
| bn-04 | scored | 50.0% | auto_silence | "A meeting started 9 in the morning." |
| bn-05 | scored | 14.3% | auto_silence | "Heaven people are coming to dinner tonight." |
| bn-06 | scored | 77.8% | auto_silence | "I don't know. Brown folks jump. And we The lazy dog" |

Command: `node eval/runner/run-wer.mjs --label baseline-base-r3 --model model/base`

## burst_affected

fws-01, bn-01 and bn-03 begin with a loud recording burst (near full-scale, decaying over 0.7 s to 2.5 s) before speech. They are kept in the corpus deliberately and flagged `burst_affected` in summary.json.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER (excl. silence) | 29.9% (234 ref words) | 29.0% (214 ref words) |
| first_word_ok, first_word_soft | 1/5 | 1/4 |
| first_word_ok, first_word_strong | 1/5 | 1/5 |

## number_normalization

Scoring change, not a pipeline change. This run's raw events are untouched; only `wer.mjs` changed.
It now also reports `num_norm`: 1 and 2 digit integers are turned into words on both sides before alignment (12 -> twelve, 25 -> twenty five).
The raw figures above are the old scoring and are unchanged. `has_digits` still flags the raw hypothesis.

**Pipeline baseline, mean of the 3 repeats (r1 to r3), all 37 cases: 27.5% raw (the old baseline), 23.5% number-normalized.** Excluding burst_affected: 27.6% raw, 24.0% number-normalized.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER, raw | 29.9% | 29.0% |
| corpus WER, num_norm | 26.5% | 25.7% |
| first_word_soft first_word_ok | 1/5 raw, 1/5 num_norm | 1/4 raw, 1/4 num_norm |
| first_word_strong first_word_ok | 1/5 raw, 1/5 num_norm | 1/5 raw, 1/5 num_norm |

Cases whose hypothesis contains digits:

| id | WER raw | WER num_norm | hypothesis |
|---|---|---|---|
| fws-01 (burst_affected) | 25.0% | 12.5% | "A meeting starts at 9 in the morning." |
| fws-05 | 50.0% | 33.3% | "A train leads from platform 4." |
| aq-03 | 33.3% | 16.7% | "Add a timer for 10 minutes." |
| num-01 | 80.0% | 20.0% | "At 25 and 17." |
| num-03 | 33.3% | 16.7% | "Let me back in 15 minutes" |
| bn-04 | 50.0% | 37.5% | "A meeting started 9 in the morning." |

Not handled: integers of 3 or more digits, ordinals, decimals and times (none occur in these runs).
