# 2026-10-05: end-of-turn sweep

Tier 1: the real Transcriber ran once per recording and phase (456 streams = 57 recordings x 8 phases) with no turn ending early, and recorded the VAD events, the commits (fire frame, real text) and the VAD probability of every frame. Tier 2: 640 policies, each replayed on those streams with the real `TurnPolicy` (`endpoint-sim.mjs`), at model latency scales 0.5, 1, 2 (the fitted line: 269 ms per second of audio minus 61 ms, floor 100 ms). Policies: 10 fixed waits and the semantic grid (done 0 to 1000, unknown 600 to 3000, open 1500 to 7000, done <= unknown <= open, floor 0/150/300, ceiling 8000), with the open list tier 1 and tier 1 plus tier 2 as separate arms.

## How to read the numbers

- **Cut** (premature): an auto-silence ended the turn while the recording still held speech (the VAD trace says so). Counted on the 12 pause recordings mp-01 to mp-12 over 8 phases = 96 turn-phases. The 8 phases only shift the frame grid, so they are **not** independent samples: one recording is one take by one speaker. A count of 8 can be one recording cut in every phase.
- **Wait after true end**: from the last frame of speech to the end of the turn, over the turns that cut nothing off, on every speech recording (v1 without the noise-only ones, plus mp, te, ls). It excludes the live flush after the end (about 0.2 s) and any text decode the live app waits for. Frame timing is accurate to about 32 ms.
- **Noise sends**: of the 40 turn-phases of the noise-only recordings (no-01 to no-04, sil-01), how many would have sent a non-empty transcript. Reported apart; lower is better. nts-01 (a cough, then "Stop") is counted as how many of its 8 turns sent "stop".
- **v1 text changed**: v1 turns whose simulated text differs from fixed:5000 at the same latency scale. A proxy for the v1 gate, which only the real replay decides.
- Text arrival is modelled, the text itself is the real model's, and the flush that `stop()` does at an early end is not modelled. The VAD trace is the truth for "still speaking", so it can miss soft speech in the noise cases.

## Check of the recordings

From the VAD trace of every take (probability 0.5 or above is speech; gaps under 512 ms are bridged), the WAV, and the tier 1 transcript. Nothing was dropped; flagged takes are listed and stay in the sweep. `unusable` = cannot answer what it was recorded for; `note` = worth knowing.

| id | category | intended pause s | longest gap ms (min / median / max over phases) | other gaps ms | first speech ms | silence after speech ms | burst | peak | WER | unusable | note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| no-01 | noise_only |  |  |  | 1152 | 6560 |  | 1.00 |  |  |  |
| no-02 | noise_only |  |  |  | - | 8000 |  | 0.57 |  |  |  |
| no-03 | noise_only |  | 1184 / 1248 / 3168 |  | 1792 | 6144 |  | 1.00 |  |  |  |
| no-04 | noise_only |  |  |  | - | 8000 |  | 1.00 |  |  |  |
| nts-01 | noise_then_short |  | 928 / 1376 / 1472 |  | 3104 | 3168 |  | 0.52 | 100% | transcript_far_from_script | extra_gap |
| mp-01 | pause_function_word | 2 | 2496 / 2592 / 2848 |  | 1152 | 3040 |  | 0.14 | 15% |  |  |
| mp-02 | pause_function_word | 2 | 2048 / 2080 / 2112 | 544 | 1824 | 2144 |  | 0.14 | 20% |  |  |
| mp-03 | pause_function_word | 1 | 2880 / 2912 / 2912 |  | 1184 | 2272 |  | 0.10 | 17% |  | pause_off_target |
| mp-04 | pause_function_word | 2 | 1920 / 2016 / 2208 |  | 1312 | 3488 |  | 0.09 | 25% |  |  |
| mp-05 | pause_function_word | 3.5 | 2400 / 2624 / 2656 |  | 1536 | 5056 |  | 0.16 | 25% |  |  |
| mp-06 | pause_function_word | 2 | 1632 / 1664 / 1856 |  | 1248 | 4736 |  | 0.14 | 25% |  |  |
| mp-07 | pause_function_word | 2 | 2176 / 2208 / 2208 |  | 1056 | 4192 |  | 0.08 | 0% |  |  |
| mp-08 | pause_function_word | 3.5 | 2976 / 3008 / 3008 | 928 | 1952 | 1344 |  | 0.10 | 29% |  | extra_gap |
| mp-09 | pause_content_word | 2 | 1856 / 1888 / 1952 |  | 2368 | 2496 |  | 0.13 | 0% |  |  |
| mp-10 | pause_content_word | 2 | 1920 / 1920 / 1952 |  | 1312 | 3520 |  | 0.13 | 0% |  |  |
| mp-11 | pause_after_complete | 2 | 1632 / 1664 / 1824 |  | 2048 | 2880 |  | 0.13 | 8% |  |  |
| mp-12 | pause_after_complete | 2 | 2592 / 2624 / 2656 |  | 800 | 4928 |  | 0.10 | 0% |  |  |
| te-01 | true_end_trailing |  |  |  | 1312 | 3936 |  | 0.12 | 20% |  |  |
| te-02 | true_end_trailing |  |  |  | 1312 | 4672 |  | 0.08 | 0% |  |  |
| ls-01 | long_utterance |  | 544 / 544 / 576 |  | 1216 | 672 |  | 0.09 | 13% |  |  |

**Measured pauses against the intended 1 / 2 / 3.5 s:** the 12 pause takes measure 1664 ms (mp-06) to 3008 ms (mp-08) at the median over phases. mp-03 (intended 1 s) measures 2912 ms; mp-05 (intended 3.5 s) measures 2624 ms; mp-08 (intended 3.5 s) measures 3008 ms. So there is no short pause under 1.7 s and no pause above 3 s: the dose-response by pause length is not testable, and the pause-length buckets below are by measured length. The measured gap runs from the last frame of the word before to the first frame of the word after, so it includes the speaker's own decay and onset.

Leading burst (a short VAD run before the speech, or a near full-scale peak in the first 256 ms): v1 fws-01, bn-01, bn-03, against the three already flagged `burst_affected` (fws-01, bn-01, bn-03); v2 none. Level (peak, 0 to 1, speech recordings only): v1 median 0.10 (the bursts reach 1.0), v2 0.08 to 0.16.

## Noise recordings under fixed:5000 (real replay, 8 phases)

| id | words produced per phase | phases that would send a non-empty transcript | distinct texts |
|---|---|---|---|
| sil-01 | 0 0 0 0 0 0 0 0 | 0 of 8 | "" |
| no-01 | 0 0 0 0 0 0 0 0 | 0 of 8 | "" |
| no-02 | 0 0 0 0 0 0 0 0 | 0 of 8 | "" |
| no-03 | 0 0 0 0 0 0 0 0 | 0 of 8 | "" |
| no-04 | 0 0 0 0 0 0 0 0 | 0 of 8 | "" |
| nts-01 | 0 0 1 0 0 1 1 0 | 3 of 8 | "" "Stop." "Stop" |

## Fixed waits (scale 1)

A fixed wait W gives a wait after the true end of about 768 ms of VAD redemption plus W. Waits under 800 ms are not reachable with `?silence` (clamped) and are here as a reference.

| fixed wait ms | pause cuts /96 | v1 cuts | wait after true end median / p90 / max ms | v1 wait median / p90 | noise sends /40 | nts-01 stop /8 | v1 text changed |
|---|---|---|---|---|---|---|---|
| 0 | 96 | 18 | 768 / 800 / 864 | 768 / 800 | 0 | 0 | 46 |
| 150 | 96 | 16 | 918 / 950 / 1014 | 918 / 950 | 0 | 0 | 44 |
| 300 | 96 | 10 | 1068 / 1100 / 1452 | 1068 / 1100 | 0 | 1 | 37 |
| 600 | 96 | 1 | 1368 / 1400 / 1752 | 1368 / 1400 | 0 | 1 | 27 |
| 1000 | 82 | 0 | 1768 / 1800 / 2152 | 1768 / 1800 | 0 | 3 | 13 |
| 1200 | 61 | 0 | 1968 / 2000 / 2352 | 1968 / 2000 | 0 | 3 | 2 |
| 1500 | 40 | 0 | 2268 / 2300 / 2652 | 2268 / 2300 | 0 | 3 | 2 |
| 2200 | 8 | 0 | 2968 / 3000 / 3352 | 2968 / 3000 | 0 | 3 | 2 |
| 3000 | 0 | 0 | 3768 / 3800 / 4152 | 3768 / 3800 | 0 | 3 | 1 |
| 5000 | 0 | 0 | 5768 / 5800 / 6152 | 5768 / 5800 | 0 | 3 | 0 |

## Does a semantic point beat the fixed-wait frontier?

The fewest pause cuts any semantic policy has (worst case over the latency scales) is **12** of 96; fixed:3000 has 0 and fixed:2200 has 8. Why: a pause after a complete clause ("Yes." then 2.6 s, mp-12) reads as done, and Moonshine sometimes puts a full stop mid-sentence ("my appointment.", mp-10) so that a pause after a content word reads as done too; the grid's `done` tops out at 1000 ms, which cannot cover a 1.7 to 2.6 s pause. The semantic rule does protect the pauses after function words (0 of 64 cut once `open` is 2500 or more).

The frontier over (cuts at the worst latency scale, median wait, p90 wait), equivalent policies collapsed (policies that tie differ only in an unused wait, floor or open value; the one with the lowest max wait is shown):

| cuts /96 | median ms | p90 ms | max ms | policy | equivalent policies |
|---|---|---|---|---|---|
| 0 | 3768 | 3800 | 4152 | `fixed:3000` | 1 |
| 8 | 2968 | 3000 | 3352 | `fixed:2200` | 1 |
| 12 | 1768 | 2968 | 3352 | `semantic:1000,2200,2500,0` | 24 |
| 14 | 1040 | 2968 | 3352 | `semantic:0,2200,2500,0` | 32 |
| 17 | 1768 | 2268 | 3300 | `semantic:1000,1500,2500,0` | 24 |
| 19 | 1018 | 2268 | 3300 | `semantic:0,1500,2500,0` | 32 |
| 34 | 1768 | 1800 | 3300 | `semantic:1000,1000,2500,0` | 12 |
| 36 | 1040 | 1768 | 3300 | `semantic:0,1000,2500,0` | 32 |
| 51 | 989 | 2268 | 2652 | `semantic:0,1500,1500,0` | 8 |
| 56 | 1077 | 1368 | 3300 | `semantic:0,600,2500,0` | 32 |
| 68 | 1008 | 1768 | 2300 | `semantic:0,1000,1500,0` | 8 |
| 88 | 1040 | 1368 | 2300 | `semantic:0,600,1500,0` | 4 |
| 96 | 768 | 800 | 864 | `fixed:0` | 1 |

Tier 2 arm: of 315 tier 2 policies, 219 are dominated by a tier 1 policy and 0 is better than every tier 1 policy. On these recordings no pause ends in an auxiliary verb or a pronoun, so tier 2 only lengthens waits.

For each budget of pause cuts (out of 96 turn-phases, and it must hold at every latency scale), the best policy by p90 wait after the true end (ties by median, then max wait), at scale 1. "Saved" is the best fixed policy within the same budget minus the semantic one:

| budget (cuts) | arm | policy | cuts at x0.5 / x1 / x2 | median ms | p90 ms | max ms | v1 cuts | noise sends /40 | v1 text changed | median saved ms | p90 saved ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | fixed | `fixed:3000` | 0 / 0 / 0 | 3768 | 3800 | 4152 | 0 | 0 | 1 |  |  |
| 0 | semantic | none within budget | | | | | | | | | |
| 0 | semantic2 | none within budget | | | | | | | | | |
| 8 | fixed | `fixed:2200` | 8 / 8 / 8 | 2968 | 3000 | 3352 | 0 | 0 | 2 |  |  |
| 8 | semantic | none within budget | | | | | | | | | |
| 8 | semantic2 | none within budget | | | | | | | | | |
| 12 | fixed | `fixed:2200` | 8 / 8 / 8 | 2968 | 3000 | 3352 | 0 | 0 | 2 |  |  |
| 12 | semantic | `semantic:1000,2200,2500,0` | 12 / 12 / 11 | 1768 | 2968 | 3352 | 0 | 0 | 2 | 1200 | 32 |
| 12 | semantic2 | `semantic2:1000,2200,2500,0` | 12 / 12 / 11 | 1768 | 2968 | 3352 | 0 | 0 | 2 | 1200 | 32 |
| 20 | fixed | `fixed:2200` | 8 / 8 / 8 | 2968 | 3000 | 3352 | 0 | 0 | 2 |  |  |
| 20 | semantic | `semantic:0,1500,2500,0` | 19 / 19 / 17 | 1018 | 2268 | 3300 | 0 | 0 | 2 | 1950 | 732 |
| 20 | semantic2 | `semantic2:0,1500,2500,0` | 19 / 19 / 17 | 1018 | 2268 | 3300 | 0 | 0 | 2 | 1950 | 732 |
| 40 | fixed | `fixed:1500` | 40 / 40 / 40 | 2268 | 2300 | 2652 | 0 | 0 | 2 |  |  |
| 40 | semantic | `semantic:0,1000,2500,0` | 36 / 36 / 34 | 1040 | 1768 | 3300 | 0 | 0 | 13 | 1228 | 532 |
| 40 | semantic2 | `semantic2:0,1000,2500,0` | 36 / 36 / 34 | 1040 | 1768 | 3300 | 0 | 0 | 13 | 1228 | 532 |

## Selected points by scale

| policy | scale | pause cuts /96 | by category | by measured pause | v1 cuts | wait median / p90 / max ms | v1 wait median / p90 | noise sends /40 | nts-01 stop /8 | v1 text changed |
|---|---|---|---|---|---|---|---|---|---|---|
| `fixed:3000` | 0.5 | 0 | function_word 0/64; content_word 0/16; after_complete 0/16 | 1.5 to 2.75 s 0/80; 2.75 s and up 0/16 | 0 | 3768 / 3800 / 4152 | 3768 / 3800 | 0 | 3 | 1 |
| `fixed:3000` | 1 | 0 | function_word 0/64; content_word 0/16; after_complete 0/16 | 1.5 to 2.75 s 0/80; 2.75 s and up 0/16 | 0 | 3768 / 3800 / 4152 | 3768 / 3800 | 0 | 3 | 1 |
| `fixed:3000` | 2 | 0 | function_word 0/64; content_word 0/16; after_complete 0/16 | 1.5 to 2.75 s 0/80; 2.75 s and up 0/16 | 0 | 3768 / 3800 / 4152 | 3768 / 3800 | 0 | 3 | 1 |
| `fixed:2200` | 0.5 | 8 | function_word 8/64; content_word 0/16; after_complete 0/16 | 1.5 to 2.75 s 0/80; 2.75 s and up 8/16 | 0 | 2968 / 3000 / 3352 | 2968 / 3000 | 0 | 3 | 2 |
| `fixed:2200` | 1 | 8 | function_word 8/64; content_word 0/16; after_complete 0/16 | 1.5 to 2.75 s 0/80; 2.75 s and up 8/16 | 0 | 2968 / 3000 / 3352 | 2968 / 3000 | 0 | 3 | 2 |
| `fixed:2200` | 2 | 8 | function_word 8/64; content_word 0/16; after_complete 0/16 | 1.5 to 2.75 s 0/80; 2.75 s and up 8/16 | 0 | 2968 / 3000 / 3352 | 2968 / 3000 | 0 | 3 | 2 |
| `semantic:1000,2200,2500,0` | 0.5 | 12 | function_word 0/64; content_word 9/16; after_complete 3/16 | 1.5 to 2.75 s 12/80; 2.75 s and up 0/16 | 0 | 1768 / 2968 / 3352 | 1768 / 2968 | 0 | 3 | 2 |
| `semantic:1000,2200,2500,0` | 1 | 12 | function_word 0/64; content_word 9/16; after_complete 3/16 | 1.5 to 2.75 s 12/80; 2.75 s and up 0/16 | 0 | 1768 / 2968 / 3352 | 1768 / 2968 | 0 | 3 | 2 |
| `semantic:1000,2200,2500,0` | 2 | 11 | function_word 0/64; content_word 9/16; after_complete 2/16 | 1.5 to 2.75 s 11/80; 2.75 s and up 0/16 | 0 | 1768 / 2968 / 3352 | 1800 / 2968 | 0 | 3 | 2 |
| `semantic2:1000,2200,2500,0` | 0.5 | 12 | function_word 0/64; content_word 9/16; after_complete 3/16 | 1.5 to 2.75 s 12/80; 2.75 s and up 0/16 | 0 | 1768 / 2968 / 3352 | 1768 / 2968 | 0 | 3 | 2 |
| `semantic2:1000,2200,2500,0` | 1 | 12 | function_word 0/64; content_word 9/16; after_complete 3/16 | 1.5 to 2.75 s 12/80; 2.75 s and up 0/16 | 0 | 1768 / 2968 / 3352 | 1768 / 2968 | 0 | 3 | 2 |
| `semantic2:1000,2200,2500,0` | 2 | 11 | function_word 0/64; content_word 9/16; after_complete 2/16 | 1.5 to 2.75 s 11/80; 2.75 s and up 0/16 | 0 | 1768 / 2968 / 3352 | 1800 / 2968 | 0 | 3 | 2 |
| `semantic:0,1500,2500,0` | 0.5 | 19 | function_word 0/64; content_word 9/16; after_complete 10/16 | 1.5 to 2.75 s 19/80; 2.75 s and up 0/16 | 0 | 869 / 2268 / 3300 | 856 / 2268 | 0 | 3 | 2 |
| `semantic:0,1500,2500,0` | 1 | 19 | function_word 0/64; content_word 9/16; after_complete 10/16 | 1.5 to 2.75 s 19/80; 2.75 s and up 0/16 | 0 | 1018 / 2268 / 3300 | 983 / 2268 | 0 | 3 | 2 |
| `semantic:0,1500,2500,0` | 2 | 17 | function_word 0/64; content_word 9/16; after_complete 8/16 | 1.5 to 2.75 s 17/80; 2.75 s and up 0/16 | 0 | 1664 / 2268 / 3300 | 1714 / 2268 | 0 | 3 | 2 |
| `semantic2:0,1500,2500,0` | 0.5 | 19 | function_word 0/64; content_word 9/16; after_complete 10/16 | 1.5 to 2.75 s 19/80; 2.75 s and up 0/16 | 0 | 869 / 2268 / 3300 | 856 / 2268 | 0 | 3 | 2 |
| `semantic2:0,1500,2500,0` | 1 | 19 | function_word 0/64; content_word 9/16; after_complete 10/16 | 1.5 to 2.75 s 19/80; 2.75 s and up 0/16 | 0 | 1018 / 2268 / 3300 | 983 / 2268 | 0 | 3 | 2 |
| `semantic2:0,1500,2500,0` | 2 | 17 | function_word 0/64; content_word 9/16; after_complete 8/16 | 1.5 to 2.75 s 17/80; 2.75 s and up 0/16 | 0 | 1696 / 2268 / 3300 | 1728 / 2268 | 0 | 3 | 2 |
| `fixed:1500` | 0.5 | 40 | function_word 32/64; content_word 0/16; after_complete 8/16 | 1.5 to 2.75 s 24/80; 2.75 s and up 16/16 | 0 | 2268 / 2300 / 2652 | 2268 / 2300 | 0 | 3 | 2 |
| `fixed:1500` | 1 | 40 | function_word 32/64; content_word 0/16; after_complete 8/16 | 1.5 to 2.75 s 24/80; 2.75 s and up 16/16 | 0 | 2268 / 2300 / 2652 | 2268 / 2300 | 0 | 3 | 2 |
| `fixed:1500` | 2 | 40 | function_word 32/64; content_word 0/16; after_complete 8/16 | 1.5 to 2.75 s 24/80; 2.75 s and up 16/16 | 0 | 2268 / 2300 / 2652 | 2268 / 2300 | 0 | 3 | 2 |
| `semantic:0,1000,2500,0` | 0.5 | 36 | function_word 9/64; content_word 16/16; after_complete 11/16 | 1.5 to 2.75 s 36/80; 2.75 s and up 0/16 | 0 | 869 / 1768 / 3300 | 856 / 1768 | 0 | 3 | 13 |
| `semantic:0,1000,2500,0` | 1 | 36 | function_word 9/64; content_word 16/16; after_complete 11/16 | 1.5 to 2.75 s 36/80; 2.75 s and up 0/16 | 0 | 1040 / 1768 / 3300 | 983 / 1768 | 0 | 3 | 13 |
| `semantic:0,1000,2500,0` | 2 | 34 | function_word 9/64; content_word 16/16; after_complete 9/16 | 1.5 to 2.75 s 34/80; 2.75 s and up 0/16 | 0 | 1664 / 1786 / 3300 | 1714 / 1786 | 0 | 3 | 13 |
| `semantic2:0,1000,2500,0` | 0.5 | 36 | function_word 9/64; content_word 16/16; after_complete 11/16 | 1.5 to 2.75 s 36/80; 2.75 s and up 0/16 | 0 | 869 / 1768 / 3300 | 856 / 1768 | 0 | 3 | 13 |
| `semantic2:0,1000,2500,0` | 1 | 36 | function_word 9/64; content_word 16/16; after_complete 11/16 | 1.5 to 2.75 s 36/80; 2.75 s and up 0/16 | 0 | 1040 / 1768 / 3300 | 983 / 1768 | 0 | 3 | 13 |
| `semantic2:0,1000,2500,0` | 2 | 34 | function_word 9/64; content_word 16/16; after_complete 9/16 | 1.5 to 2.75 s 34/80; 2.75 s and up 0/16 | 0 | 1700 / 1800 / 3300 | 1728 / 1800 | 0 | 3 | 13 |

## Which single cases drive the result (scale 1)

- `fixed:3000`: cut turn-phases by recording none; slowest to send (median wait over phases): fws-01 3800 ms, fst-03 3800 ms, pw-03 3800 ms, mp-10 3800 ms, fws-02 3768 ms, fws-04 3768 ms.
- `fixed:2200`: cut turn-phases by recording mp-08 8/8; without mp-08 the cuts are 0; slowest to send (median wait over phases): fws-01 3000 ms, fst-03 3000 ms, pw-03 3000 ms, mp-10 3000 ms, fws-02 2968 ms, fws-04 2968 ms.
- `semantic:1000,2200,2500,0`: cut turn-phases by recording mp-10 8/8, mp-12 3/8, mp-09 1/8; without mp-10 the cuts are 4; slowest to send (median wait over phases): bn-02 3236 ms, te-02 3236 ms, pw-01 2968 ms, num-03 2968 ms, bn-06 2968 ms, aq-04 2936 ms.
- `semantic2:1000,2200,2500,0`: cut turn-phases by recording mp-10 8/8, mp-12 3/8, mp-09 1/8; without mp-10 the cuts are 4; slowest to send (median wait over phases): cas-01 3236 ms, bn-02 3236 ms, te-02 3236 ms, pw-01 2968 ms, num-03 2968 ms, bn-06 2968 ms.
- `semantic:0,1500,2500,0`: cut turn-phases by recording mp-10 8/8, mp-11 2/8, mp-12 8/8, mp-09 1/8; without mp-10 the cuts are 11; slowest to send (median wait over phases): bn-02 3236 ms, te-02 3236 ms, pw-01 2268 ms, num-03 2268 ms, bn-06 2268 ms, aq-04 2236 ms.
- `semantic2:0,1500,2500,0`: cut turn-phases by recording mp-10 8/8, mp-11 2/8, mp-12 8/8, mp-09 1/8; without mp-10 the cuts are 11; slowest to send (median wait over phases): cas-01 3236 ms, bn-02 3236 ms, te-02 3236 ms, pw-01 2268 ms, num-03 2268 ms, bn-06 2268 ms.
- `fixed:1500`: cut turn-phases by recording mp-01 8/8, mp-03 8/8, mp-05 8/8, mp-08 8/8, mp-12 8/8; without mp-01 the cuts are 32; slowest to send (median wait over phases): fws-01 2300 ms, fst-03 2300 ms, pw-03 2300 ms, mp-10 2300 ms, fws-02 2268 ms, fws-04 2268 ms.
- `semantic:0,1000,2500,0`: cut turn-phases by recording mp-07 8/8, mp-09 8/8, mp-10 8/8, mp-11 3/8, mp-12 8/8, mp-06 1/8; without mp-07 the cuts are 28; slowest to send (median wait over phases): bn-02 3236 ms, te-02 3236 ms, pw-01 1768 ms, num-03 1768 ms, bn-06 1768 ms, aq-04 1736 ms.
- `semantic2:0,1000,2500,0`: cut turn-phases by recording mp-07 8/8, mp-09 8/8, mp-10 8/8, mp-11 3/8, mp-12 8/8, mp-06 1/8; without mp-07 the cuts are 28; slowest to send (median wait over phases): cas-01 3236 ms, bn-02 3236 ms, te-02 3236 ms, pw-01 1768 ms, num-03 1768 ms, bn-06 1768 ms.

## Real replay of the chosen policies

Each policy was run through the real Transcriber, with the turn policy driven the way `main.ts` drives it (committed text, commits in flight, modelled model run time at scale 1), over all 57 recordings and 8 phases, and gated against `2026-10-04-wer-replay-head-policy` (fail = a v1 case with a new error against the reference; review = a changed v1 hypothesis with no new error). WER is the mean over phases, number-normalized; v1 is the 37 original recordings, all is all 57 (the cut-off pause takes lose words, so it rises). "Sim" is the simulator's number for the same policy.

| policy | v1 gate | v1 WER | all WER | cuts /96 real (sim) | wait median / p90 / max ms real | same, sim | noise sends /40 real (sim) | nts-01 stop /8 real (sim) |
|---|---|---|---|---|---|---|---|---|
| `semantic:1000,2200,2500,0,8000` | PASS, 0 fail, 2 review | 10.6% | 14.4% | 12 (12) | 1768 / 2968 / 3352 | 1768 / 2968 / 3352 | 0 (0) | 3 (3) |
| `semantic:0,1500,2500,0,8000` | PASS, 0 fail, 2 review | 10.6% | 15.3% | 19 (19) | 1018 / 2268 / 3300 | 1018 / 2268 / 3300 | 1 (0) | 3 (3) |
| `semantic:0,1000,2500,0,8000` | FAIL, 3 fail, 1 review | 11.0% | 20.5% | 36 (36) | 1040 / 1768 / 3300 | 1040 / 1768 / 3300 | 0 (0) | 3 (3) |
| `fixed:2200` | PASS, 0 fail, 0 review | 10.6% | 13.4% | 8 (8) | 2968 / 3000 / 3352 | 2968 / 3000 / 3352 | 0 (0) | 3 (3) |
| `fixed:1500` | PASS, 0 fail, 1 review | 10.6% | 16.9% | 40 (40) | 2268 / 2300 / 2652 | 2268 / 2300 / 2652 | 1 (0) | 3 (3) |

- `semantic:1000,2200,2500,0,8000`: cuts by recording mp-10 8/8, mp-12 3/8, mp-09 1/8 (identical to the simulator's); v1 gate review: phase 0 bn-03, phase 1 bn-03.
- `semantic:0,1500,2500,0,8000`: cuts by recording mp-10 8/8, mp-11 2/8, mp-12 8/8, mp-09 1/8 (identical to the simulator's); v1 gate review: phase 0 bn-03, phase 1 bn-03.
- `semantic:0,1000,2500,0,8000`: cuts by recording mp-07 8/8, mp-09 8/8, mp-10 8/8, mp-11 3/8, mp-12 8/8, mp-06 1/8 (identical to the simulator's); v1 gate review: phase 1 bn-03.
- `fixed:2200`: cuts by recording mp-08 8/8 (identical to the simulator's); v1 gate review: none.
- `fixed:1500`: cuts by recording mp-01 8/8, mp-03 8/8, mp-05 8/8, mp-08 8/8, mp-12 8/8 (identical to the simulator's); v1 gate review: phase 0 bn-03.

Raw grid of every policy at every scale: `grid.json`. The streams (`raw/streams.jsonl`) are not committed.
