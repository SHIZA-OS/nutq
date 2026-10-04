# 2026-10-05: phase-swept replay WER, confirm-fixed2200 (model/base)

Every recorded case is replayed offline through the real Transcriber (real Silero VAD, SpeechBuffer and Moonshine model; `replay-commits.mjs --wer`) at each of 8 frame phases, and scored with wer.mjs. Phase p prepends p x 64 zero samples to the WAV (64 samples = 4 ms), so the 512 sample frame boundaries fall at a different place relative to the speech. Pre-roll 4 frames.

- **End of turn mirrors `run-wer.mjs`.** The same turn policy `main.ts` uses (`src/turn-policy.ts`) is driven with time from frame positions: auto-silence SILENCE_COMMIT_MS (5000 ms) after a speech end or misfire, cancelled by a speech start. After the WAV ends, silence is fed until the policy ends the turn or until WAV duration + 10 s, then the turn is stopped manually. Live baseline runs ended 32 of 37 turns with auto-silence.
- Not modelled: Chrome's mic capture and processing, resampling from the capture rate, real-time scheduling (model runs do not delay frames here), and streaming updates (answered with an empty string).
- Deterministic by construction: no timestamps are written, and two runs of the same code are expected to be identical.
- This is a different measurement from the live runs (`run-wer.mjs`). Use it to compare logic changes; take absolute numbers from interleaved live runs.

Missing audio: none. v1 is the original case set (silence and empty-reference cases excluded); first words /26 counts first_word_ok over the 26 cases where untrimmed model-only produced text.

| phase | lead samples | v1 normalized WER | v1 raw WER | first words /26 | soft first words /5 | multi-commit cases | turns ended by auto_silence / stop |
|---|---|---|---|---|---|---|---|
| 0 | 0 | 9.8% | 14.1% | 22 | 5 | 17 | 53 / 4 |
| 1 | 64 | 11.1% | 15.0% | 23 | 5 | 19 | 54 / 3 |
| 2 | 128 | 10.7% | 14.5% | 22 | 5 | 16 | 54 / 3 |
| 3 | 192 | 11.1% | 15.0% | 22 | 5 | 17 | 54 / 3 |
| 4 | 256 | 10.3% | 14.1% | 24 | 5 | 16 | 54 / 3 |
| 5 | 320 | 9.4% | 13.7% | 22 | 5 | 17 | 54 / 3 |
| 6 | 384 | 10.7% | 15.0% | 22 | 5 | 16 | 54 / 3 |
| 7 | 448 | 12.0% | 15.4% | 24 | 5 | 17 | 54 / 3 |
| **mean across phases** | | **10.6%** | **14.6%** | **22.6** | | | |

Range of v1 normalized WER across phases: 9.4% to 12.0%.

## end of turn

Policy `fixed:2200`, commit latency scale 1. Pooled over the 8 phases. "premature" is a turn an auto-silence ended while the file still held speech; the wait after the true end is counted from the last frame of speech (VAD probability 0.5 or above, gaps under 512 ms bridged), for turns that cut nothing off, and excludes the live flush after the end. Text reaches the policy at the commit's fire time plus a modelled model run time. The speech runs come from the VAD, so speech it misses (soft speech in the noise cases, for example bn-03's late "Yes.") is not seen as speech to come: premature can read false there, and a cut-off shows up as a deleted word in the WER (hence the v1 gate).

| set | turn-phases | with a pause | premature | true ends | wait median ms | wait p90 ms | wait max ms |
|---|---|---|---|---|---|---|---|
| v1 | 296 | 42 | 0 | 288 | 2968 | 3000 | 3352 |
| all | 456 | 156 | 9 | 422 | 2968 | 3000 | 3352 |

**v1 gate against `2026-10-04-wer-replay-head-policy`: PASS.** 296 v1 case-phases compared over 8 phases: 0 with a new error against the reference (fail), 0 with a changed hypothesis and no new error (for review); v1 normalized WER mean 10.6% vs 10.6%.


| id | pause ms | premature phases | hint at arm | wait at arm ms | wait after true end ms, per phase |
|---|---|---|---|---|---|
| fws-01 |  | 0 | done | 2200 | 3032 3000 3000 2968 3032 2968 2968 3000 |
| fws-02 |  | 0 | done | 2200 | 2968 2968 2936 2968 3000 3032 2968 2968 |
| fws-03 |  | 0 | done | 2200 | 2936 2936 2968 2840 2936 2968 2968 3064 |
| fws-04 |  | 0 | unknown | 2200 | 2968 3000 2968 3000 2968 3000 2872 3000 |
| fws-05 |  | 0 | done | 2200 | 3032 3000 2968 2968 2936 3000 3000 2872 |
| fst-01 |  | 0 | done | 2200 | 3000 2968 2968 2968 2968 3000 2968 2968 |
| fst-02 |  | 0 | done | 2200 | 2968 2968 2936 2968 3000 2968 2968 2968 |
| fst-03 |  | 0 | done | 2200 | 3032 3000 3000 3000 3032 3032 2968 3000 |
| fst-04 |  | 0 | unknown | 2200 | 2936 2968 2968 2968 2968 2968 2968 2936 |
| fst-05 |  | 0 | unknown | 2200 | 3032 2968 2968 2968 2936 2968 3000 2936 |
| pw-01 | 608 | 0 | unknown | 2200 | 2936 2968 2968 2936 2968 2968 2968 2968 |
| pw-02 |  | 0 | unknown | 2200 | 2968 2968 2968 2968 2968 2968 2968 2968 |
| pw-03 |  | 0 | unknown | 2200 | 2968 3000 2968 3000 3000 3000 3000 2968 |
| pw-04 |  | 0 | unknown | 2200 | 2968 2968 2968 2936 2936 2872 2776 3000 |
| aq-01 |  | 0 | unknown | 2200 | 2936 2968 2968 2968 2968 2968 2968 2968 |
| aq-02 |  | 0 | unknown | 2200 | 2936 2936 2936 2936 2968 2936 2968 2968 |
| aq-03 |  | 0 | unknown | 2200 | 2968 2936 2968 2968 2936 2936 2936 2936 |
| aq-04 |  | 0 | unknown | 2200 | 2968 2968 2936 2968 3000 3032 3064 2968 |
| aq-05 |  | 0 | done | 2200 | 2968 2936 2968 2968 2936 2968 2936 2936 |
| aq-06 |  | 0 | done | 2200 | 2936 2936 2936 2936 2936 2936 2936 2936 |
| num-01 |  | 0 | unknown | 2200 | 2936 3000 3064 2968 2968 2968 2968 2968 |
| num-02 |  | 0 | unknown | 2200 | 2968 2936 2936 2936 2936 2968 2968 2968 |
| num-03 |  | 0 | unknown | 2200 | 2968 2968 2968 2968 2968 3000 2968 2968 |
| cas-01 | 960 | 0 | unknown | 2200 | 2968 2936 2936 2936 2936 2936 2936 2968 |
| cas-02 | 576 | 0 | done | 2200 | 2968 2968 2968 2968 2968 2968 2968 2936 |
| cas-03 |  | 0 | unknown | 2200 | 2968 2936 2936 2936 2968 2968 2968 2936 |
| sh-01 |  | 0 | unknown | 2200 | 2936 2968 2936 2936 2968 2936 2936 2936 |
| sh-02 |  | 0 | unknown | 2200 | 2968 2936 2936 2936 2936 2968 2968 2968 |
| sh-03 |  | 0 | unknown | 2200 | 2936 2936 2968 3000 2936 2968 2968 2936 |
| sh-04 |  | 0 | unknown | 2200 | 3000 2968 2936 2968 2936 2936 2936 2936 |
| bn-01 |  | 0 | done | 2200 | 2936 2968 2968 2968 2968 2968 2968 2936 |
| bn-02 |  | 0 | open | 2200 | 2968 2968 2968 2936 3000 2968 2968 2936 |
| bn-03 | 1344 | 0 | unknown | 2200 | 1208 1176 2968 2712 3032 3352 2808 3000 |
| bn-04 |  | 0 | done | 2200 | 2968 2968 2968 2968 3000 3032 2968 2936 |
| bn-05 |  | 0 | done | 2200 | 3000 2968 2968 2968 2968 2968 2968 2968 |
| bn-06 | 1312 | 0 | unknown | 2200 | 2968 2968 2968 2968 2968 2968 2968 2968 |
| nts-01 | 1376 | 0 | unknown | 2200 | 2968 2936 1464 2968 2968 2936 2968 2936 |
| mp-01 | 2560 | 0 | open | 2200 | 2968 2968 2968 2968 2968 2936 2936 2936 |
| mp-02 | 2048 | 0 | done | 2200 | 2968 2936 2968 2936 2936 2968 2968 2936 |
| mp-03 | 2912 | 0 | open | 2200 | 2968 2968 2968 2968 2968 2968 2968 2968 |
| mp-04 | 2016 | 0 | open | 2200 | 2968 2968 2936 2968 2936 2968 2936 2936 |
| mp-05 | 2656 | 0 | open | 2200 | 2968 2936 2968 2936 2968 2968 2936 2968 |
| mp-06 | 1664 | 0 | done | 2200 | 2968 2968 2968 2968 2968 2968 2968 3000 |
| mp-07 | 2176 | 0 | done | 2200 | 2936 2968 2936 2968 2968 2936 2968 2936 |
| mp-08 | 2976 | 8 | open | 2200 | - - - - - - - - |
| mp-09 | 1888 | 0 | done | 2200 | 2968 2936 2968 2968 2936 2968 2936 2936 |
| mp-10 | 1920 | 0 | done | 2200 | 3000 2968 2968 2968 3032 3000 3096 3000 |
| mp-11 | 1696 | 0 | done | 2200 | 2936 2968 2968 2968 2968 2968 2968 2968 |
| mp-12 | 2624 | 0 | unknown | 2200 | 3000 2936 2936 2936 2936 2968 2968 2936 |
| te-01 |  | 0 | done | 2200 | 2968 2968 2936 2968 2968 2968 2968 2968 |
| te-02 |  | 0 | open | 2200 | 2936 2936 2936 2968 2936 2968 2936 2936 |
| ls-01 | 576 | 0 | unknown | 2200 | 2968 2936 2968 2936 2936 2936 2968 2968 |

## per case

Mean normalized WER across phases, the number of distinct hypotheses over the phases, and the phase 0 hypothesis. Every phase's hypothesis is in `summary.json`.

| id | mean WER | distinct hypotheses | phase 0 hypothesis |
|---|---|---|---|
| fws-01 | 7.8% | 4 | "The meeting starts at 9 in the morning." |
| fws-02 | 0.0% | 1 | "A cup of coffee would be nice right now." |
| fws-03 | 0.0% | 1 | "It's going to rain later this afternoon." |
| fws-04 | 25.0% | 4 | "So what time does the store closed? So what time does" |
| fws-05 | 16.7% | 2 | "The train leads from platform 4." |
| fst-01 | 0.0% | 1 | "Seven people are coming to dinner tonight." |
| fst-02 | 7.8% | 2 | "Bhante is the busiest day of the week." |
| fst-03 | 0.0% | 1 | "Please remind me to call the bank tomorrow." |
| fst-04 | 16.7% | 3 | "12 students passed the final exam." |
| fst-05 | 0.0% | 2 | "Bring the blue folder to the office" |
| pw-01 | 23.6% | 5 | "The good brown fox Jumps over the lazy dog" |
| pw-02 | 7.1% | 2 | "A fox ran quickly across the field." |
| pw-03 | 14.3% | 1 | "She jumps rope every morning before the school." |
| pw-04 | 25.0% | 8 | "Click the button and wait for a quick review Bly" |
| aq-01 | 0.0% | 1 | "What is the capital of Australia?" |
| aq-02 | 0.0% | 1 | "How many minutes are in a day?" |
| aq-03 | 0.0% | 1 | "Set a timer for 10 minutes." |
| aq-04 | 0.0% | 2 | "Tell me a short fact about the moon" |
| aq-05 | 0.0% | 1 | "What is the difference between a virus and bacteria?" |
| aq-06 | 0.0% | 1 | "Translate good morning into Spanish." |
| num-01 | 15.0% | 2 | "At 25 and 17." |
| num-02 | 0.0% | 2 | "My flight is at half past six" |
| num-03 | 0.0% | 2 | "Call me back in 15 minutes" |
| cas-01 | 0.0% | 2 | "Um can you tell me What day it is?" |
| cas-02 | 16.7% | 1 | "Hey, oh, what's the weather looking like?" |
| cas-03 | 0.0% | 2 | "Wait no I meant the other one" |
| sh-01 | 0.0% | 1 | "Yes." |
| sh-02 | 0.0% | 2 | "Stop" |
| sh-03 | 0.0% | 1 | "Thank you." |
| sh-04 | 0.0% | 1 | "What?" |
| bn-01 | 0.0% | 1 | "What is the capital of Australia?" |
| bn-02 | 28.6% | 5 | "How many minutes are in the in?" |
| bn-03 | 58.3% | 7 | "Set a timer for 10 minutes. Yes." |
| bn-04 | 25.0% | 1 | "The meeting started 9 in the morning." |
| bn-05 | 1.8% | 2 | "Seven people are coming to dinner tonight." |
| bn-06 | 48.6% | 6 | "Aku, that way Brown pox jam Over the lazy dog" |
| nts-01 | 62.5% | 3 | "" |
| mp-01 | 14.4% | 5 | "I was thinking we could go to the Place on the main street" |
| mp-02 | 26.3% | 6 | "Please send the report to Sarah and Michael after the line." |
| mp-03 | 16.7% | 4 | "I want to book a flight and The battle for the weekend." |
| mp-04 | 18.8% | 6 | "I want to book a flight and Button for a weekend." |
| mp-05 | 27.1% | 6 | "I want to book a flight and Total for a weekend." |
| mp-06 | 31.3% | 5 | "So what Time does the pharmacy open to marrow." |
| mp-07 | 0.0% | 1 | "Can you set a reminder for Friday morning?" |
| mp-08 | 71.4% | 3 | "Remind me to the. Remind me to call the dentist because..." |
| mp-09 | 0.0% | 2 | "Can you tell me What the weather is like in Lisbon tomorrow?" |
| mp-10 | 1.1% | 2 | "I need to move my appointment. From Tuesday to Thursday afternoon." |
| mp-11 | 3.8% | 4 | "Set a timer for 10 minutes. Remind me to check the oven" |
| mp-12 | 0.0% | 2 | "Yes Please go ahead and send it." |
| te-01 | 20.0% | 1 | "There should be everything. Thanks." |
| te-02 | 0.0% | 1 | "I think that is everything for now so" |
| ls-01 | 10.9% | 6 | "On Thursday, I need to pick up my daughter from school. Then drive to the airport and return the rental" |

Command: `node eval/runner/replay-commits.mjs --wer confirm-fixed2200 --phases 8 --pre-roll 4`
