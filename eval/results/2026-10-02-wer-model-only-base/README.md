# 2026-10-02: WER, model-only (model/base)

Each whole recorded WAV (8 s, int16 / 32768 as 16 kHz Float32) was passed straight to the vendored `MoonshineModel.generate()` (`quantized`, as the Transcriber uses) in a headless page served by the Vite dev server.
No VAD, no SpeechBuffer, no Transcriber, no mic path. This isolates the model from the pipeline. Nothing was sent to ZeroClaw.
Events files were synthesized in the run-wer events shape: `stt_model`, `stt_committed {text}` (omitted when the text is empty), `transcript_final {text, trigger: "model_only"}`.

Caveat: the files are 8 s long with several seconds of silence around short utterances. The model returned an empty string for many of them (scored as all deletions), so this is not the same as the model on a tightly segmented utterance.

- Scored: 36; no_transcript: 0; empty model outputs: 10
- Overall WER (corpus-level, excluding silence): 28.2% over 234 reference words (S16 D48 I2)

| id | status | WER | hypothesis |
|---|---|---|---|
| fws-01 (burst_affected) | scored | 12.5% | "The meeting starts at 9 in the morning" |
| fws-02 | scored | 0.0% | "A cup of coffee would be nice right now." |
| fws-03 | scored | 0.0% | "It's going to rain later this afternoon." |
| fws-04 | scored | 0.0% | "So what time does the store close today?" |
| fws-05 | scored | 33.3% | "The train leads from platform 4." |
| fst-01 | scored | 14.3% | "7 people are coming to dinner tonight." |
| fst-02 | scored | 12.5% | "Monte is the busiest day of the week." |
| fst-03 | scored | 0.0% | "Please remind me to call the bank tomorrow." |
| fst-04 | scored | 16.7% | "Well students passed the final exam" |
| fst-05 | scored | 0.0% | "Bring the blue folder to the office" |
| pw-01 | scored | 0.0% | "The quick brown fox jumps over the lazy dog." |
| pw-02 | scored | 100.0% | "" |
| pw-03 | scored | 14.3% | "She jumps rope every morning before the school." |
| pw-04 | scored | 0.0% | "Click the button and wait for a quick reply." |
| aq-01 | scored | 0.0% | "What is the capital of Australia?" |
| aq-02 | scored | 0.0% | "How many minutes are in a day?" |
| aq-03 | scored | 16.7% | "Set a timer for 10 minutes." |
| aq-04 | scored | 0.0% | "Tell me a short fact about the moon." |
| aq-05 | scored | 0.0% | "What is the difference between a virus and bacteria?" |
| aq-06 | scored | 0.0% | "Translate good morning into Spanish." |
| num-01 | scored | 80.0% | "At 25 and 17." |
| num-02 | scored | 100.0% | "" |
| num-03 | scored | 16.7% | "Call me back in 15 minutes" |
| cas-01 | scored | 100.0% | "" |
| cas-02 | scored | 16.7% | "Hey, oh what's the weather looking like?" |
| cas-03 | scored | 0.0% | "Wait no i meant the other one" |
| sh-01 | scored | 100.0% | "" |
| sh-02 | scored | 100.0% | "" |
| sh-03 | scored | 100.0% | "" |
| sh-04 | scored | 100.0% | "" |
| sil-01 | silence | words_produced=0 | "" |
| bn-01 (burst_affected) | scored | 100.0% | "" |
| bn-02 | scored | 100.0% | "" |
| bn-03 (burst_affected) | scored | 100.0% | "" |
| bn-04 | scored | 37.5% | "The meeting started 9 in the morning." |
| bn-05 | scored | 0.0% | "Seven people are coming to dinner tonight" |
| bn-06 | scored | 33.3% | "Akut, Dakwik, Brown folks, jumps, over the lazy dog." |

## burst_affected

fws-01, bn-01 and bn-03 begin with a loud recording burst (near full-scale, decaying over 0.7 s to 2.5 s) before speech. They are kept in the corpus deliberately and flagged `burst_affected` in summary.json.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER (excl. silence) | 28.2% (234 ref words) | 24.8% (214 ref words) |
| first_word_ok, first_word_soft | 5/5 | 4/4 |
| first_word_ok, first_word_strong | 2/5 | 2/5 |

Command: `node eval/runner/run-model-only.mjs --label model-only-base --model model/base`

## number_normalization

Scoring change, not a pipeline change. This run's raw events are untouched; only `wer.mjs` changed.
It now also reports `num_norm`: 1 and 2 digit integers are turned into words on both sides before alignment (12 -> twelve, 25 -> twenty five).
The raw figures above are the old scoring and are unchanged. `has_digits` still flags the raw hypothesis.

| | all cases | excluding burst_affected |
|---|---|---|
| corpus WER, raw | 28.2% | 24.8% |
| corpus WER, num_norm | 24.4% | 21.0% |
| first_word_soft first_word_ok | 5/5 raw, 5/5 num_norm | 4/4 raw, 4/4 num_norm |
| first_word_strong first_word_ok | 2/5 raw, 3/5 num_norm | 2/5 raw, 3/5 num_norm |

Cases whose hypothesis contains digits:

| id | WER raw | WER num_norm | hypothesis |
|---|---|---|---|
| fws-01 (burst_affected) | 12.5% | 0.0% | "The meeting starts at 9 in the morning" |
| fws-05 | 33.3% | 16.7% | "The train leads from platform 4." |
| fst-01 | 14.3% | 0.0% | "7 people are coming to dinner tonight." |
| aq-03 | 16.7% | 0.0% | "Set a timer for 10 minutes." |
| num-01 | 80.0% | 20.0% | "At 25 and 17." |
| num-03 | 16.7% | 0.0% | "Call me back in 15 minutes" |
| bn-04 | 37.5% | 25.0% | "The meeting started 9 in the morning." |

Not handled: integers of 3 or more digits, ordinals, decimals and times (none occur in these runs).
