# 2026-10-06: WER, model-only (model/base), t

Each whole recorded WAV (16 kHz mono int16 as Float32) was passed straight to the vendored `MoonshineModel.generate()` (`quantized`, as the Transcriber uses) in a headless page served by the Vite dev server.
No VAD, no SpeechBuffer, no Transcriber, no mic path. This isolates the model from the pipeline. Nothing was sent to ZeroClaw.

Caveat: the files are 8 s long with several seconds of silence around short utterances. The model returned an empty string for many of them (scored as all deletions), so this is not the same as the model on a tightly segmented utterance.

- Cases attempted: 0; missing audio: fws-01, fws-02, fws-03, fws-04, fws-05, fst-01, fst-02, fst-03, fst-04, fst-05, pw-01, pw-02, pw-03, pw-04, aq-01, aq-02, aq-03, aq-04, aq-05, aq-06, num-01, num-02, num-03, cas-01, cas-02, cas-03, sh-01, sh-02, sh-03, sh-04, sil-01, bn-01, bn-02, bn-03, bn-04, bn-05, bn-06, no-01, no-02, no-03, no-04, nts-01, mp-01, mp-02, mp-03, mp-04, mp-05, mp-06, mp-07, mp-08, mp-09, mp-10, mp-11, mp-12, te-01, te-02, ls-01; run errors: none
- Scored: 0; no_transcript: 0; empty model outputs: 0
- Overall WER (corpus-level, excluding silence): n/a over 0 reference words (S0 D0 I0)

| id | status | WER | hypothesis |
|---|---|---|---|

Command: `node eval/runner/run-model-only.mjs --label t --model model/base`

## case_sets

`v1` is the original case set, the baseline every earlier run is comparable to. `all` also counts the cases added later (`set` in cases.jsonl). Empty-reference cases are excluded from both.

| | v1 | all scored cases |
|---|---|---|
| cases scored | 0 | 0 |
| reference words | 0 | 0 |
| corpus WER, raw | n/a | n/a |
| corpus WER, num_norm | n/a | n/a |

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
