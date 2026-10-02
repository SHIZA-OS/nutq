# 2026-10-02: WER replay, baseline-base-r1 (model/base)

Recorded WAVs replayed through the page in system Chrome with a fake mic, `?eval=1&nosend=1`.
Nothing was sent to ZeroClaw. Hypothesis text is included because the cases are scripted.

- Cases attempted: 37; missing audio: none; run errors: none
- Scored: 36; no_transcript: 0; commit_mismatch: none
- Overall WER (corpus-level, excluding silence): 26.9% over 234 reference words (S48 D7 I8)

| id | status | WER | trigger | hypothesis |
|---|---|---|---|---|
| fws-01 | scored | 25.0% | auto_silence | "A meeting starts at 9 in the morning." |
| fws-02 | scored | 0.0% | auto_silence | "A cup of coffee would be nice right now." |
| fws-03 | scored | 14.3% | auto_silence | "Is going to rain later this afternoon." |
| fws-04 | scored | 12.5% | auto_silence | "What time does the store close today?" |
| fws-05 | scored | 83.3% | auto_silence | "A train leads from platform 4. P. P" |
| fst-01 | scored | 14.3% | auto_silence | "Heaven people are coming to dinner tonight." |
| fst-02 | scored | 25.0% | auto_silence | "One day is the busiest day of the week." |
| fst-03 | scored | 0.0% | auto_silence | "Please remind me to call the bank tomorrow." |
| fst-04 | scored | 16.7% | auto_silence | "12 students passed the final exam." |
| fst-05 | scored | 0.0% | auto_silence | "Bring the blue folder to the office." |
| pw-01 | scored | 33.3% | auto_silence | "I put brown fox Jumps over the lazy door." |
| pw-02 | scored | 0.0% | auto_silence | "A fox ran quickly across the field." |
| pw-03 | scored | 42.9% | auto_silence | "He jumps rope every morning before the spoon." |
| pw-04 | scored | 0.0% | auto_silence | "Click the button and wait for a quick Reply." |
| aq-01 | scored | 0.0% | auto_silence | "What is the capital of Australia?" |
| aq-02 | scored | 14.3% | auto_silence | "Many minutes are in a day" |
| aq-03 | scored | 83.3% | auto_silence | "At a time of 10 mins." |
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
| bn-02 | scored | 42.9% | auto_silence | "So many minutes are in the" |
| bn-03 | scored | 33.3% | manual | "Set the timer for 10 minutes" |
| bn-04 | scored | 50.0% | auto_silence | "A meeting started 9 in the morning." |
| bn-05 | scored | 14.3% | auto_silence | "Heaven people are coming to dinner tonight." |
| bn-06 | scored | 77.8% | auto_silence | "I don't know. Brown folks jump. And we The lazy dog" |

Command: `node eval/runner/run-wer.mjs --label baseline-base-r1 --model model/base`

## burst_affected

fws-01, bn-01 and bn-03 begin with a loud recording burst (near full-scale, decaying over 0.7 s to 2.5 s) before speech. They are kept in the corpus deliberately and flagged `burst_affected` in summary.json.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER (excl. silence) | 26.9% (234 ref words) | 27.6% (214 ref words) |
| first_word_ok, first_word_soft | 1/5 | 1/4 |
| first_word_ok, first_word_strong | 2/5 | 2/5 |
