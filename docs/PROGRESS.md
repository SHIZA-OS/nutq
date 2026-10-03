# Progress

## Rename: Sawt → Nutq

The project was originally named Sawt and has been renamed to Nutq (نطق, "utterance"). The
rename was necessary, not cosmetic: "Sawt" collided with the name of an existing funded
startup. Nutq was chosen as a replacement that keeps the same conceptual thread (an Arabic
word for the act of speaking/uttering) without the collision.

## Phase 1: client-side pipeline

Phase 1 built the full client-side voice pipeline described in
[ARCHITECTURE.md](ARCHITECTURE.md):

- Microphone capture
- Local Moonshine STT (WASM, in-browser)
- Real wiring to ZeroClaw's `/ws/chat` WebSocket
- Web Speech API TTS for playback of the agent's reply

As of today (2026-09-02), the first full live end-to-end voice test succeeded: mic in,
transcription, agent round-trip over `/ws/chat`, and spoken reply out, all working together
against the local ZeroClaw test backend.

## How the working end-to-end test was reached

Getting to a working test surfaced several distinct issues, each worth remembering since
they're not obvious from the code alone:

- **Pairing-token confusion.** Early connection attempts used the 6-digit `get-paircode`
  value as the `/ws/chat` bearer token. This doesn't work; the endpoint checks a long-lived
  `zc_<64hex>` token instead. The failure mode was a plain WebSocket `code=1006` close with no
  further detail, which is actually an HTTP 401 that the browser's WebSocket API doesn't
  surface. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full explanation.
- **Stale container after config changes.** `docker compose restart` does not pick up changes
  to the compose file or to mounted config/volumes. Plain `docker compose up -d` picks up
  compose-file changes. Changes to `config.toml` or other mounted volume content require
  `docker compose up -d --force-recreate`. Debugging against a stale container that looked
  like it had been updated but hadn't cost real time here.
- **Silent daemon logging.** The zeroclaw daemon prints nothing beyond a startup banner to
  stdout, so `docker logs` looked clean while things were actually failing. The real errors
  were only visible in `/zeroclaw-data/.zeroclaw/data/state/runtime-trace.jsonl`, discovered
  by digging into the container's filesystem rather than trusting `docker logs`.
- **Model field parsing bug.** The `config.toml` field for the Anthropic model under
  `[providers.models.anthropic.<alias>]` writes correctly but reads back as `<unset>` from
  the daemon's own config reader. Worked around by setting the model via the
  `ZEROCLAW_providers__models__anthropic__default__model` environment variable instead, the
  same mechanism already known to work for `api_key`.
- **Accidental API key exposure.** An API key was briefly echoed in plaintext output when
  running `docker compose config` (which resolves and prints the fully-interpolated compose
  configuration, env vars included). The key was rotated immediately once this was noticed.

## Post-test cleanup

Once the end-to-end test succeeded, the following cleanup was done and each item was
verified directly against the running daemon via `docker exec zeroclaw zeroclaw config get`
rather than assumed from what was written to `config.toml`:

- `RUST_LOG=debug` removed (was set temporarily for the runtime-trace debugging above).
- `require_pairing` re-enabled to `true` (its default, per
  [ARCHITECTURE.md](ARCHITECTURE.md)).

## Eval: WER replay mode and model load order (2026-10-01)

- **WER replay mode** (041f146). `?eval=1&nosend=1` runs the mic without a gateway and
  skips the send; `?model=` picks the Moonshine model; `stt_committed` carries its text;
  new `transcript_final` and `stt_model` events. See the eval section of
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Bug found by a Chrome fake-audio run.** The mic opened before the model finished
  loading, and audio during the load was silently dropped (nothing reads the stream until
  the end of `load()`). A test clip played once on mic open produced no speech at all.
- **Fix.** The model and VAD now load first; the mic opens only afterward, and the button
  is disabled until the model is ready and the socket is open (or nosend mode). Normal
  mode loads on Connect, eval mode at page load. A failed load is retried on the next
  Connect, which needed a small local fix in the vendored `model.ts`.
- **Verified** (all with a throwaway local WebSocket stub, no contact with ZeroClaw): load
  starts on Connect, not before; button stays disabled until both connected and loaded;
  a server-initiated close disables it again; a forced first-request failure shows the
  error state and the next Connect loads successfully. In eval nosend mode, the original
  unpadded test clip was transcribed in full with model/base: "A quick brown pox jumps over
  the lazy dog." (reference: "The quick brown fox jumps over the lazy dog.").
- **Observation:** cold-profile model load took roughly 27 to 38 s across the runs; warm
  cache about 4 to 7 s. Not a benchmark.
- **Open:** on a failed load the vendored library reports "This platform ... is not
  supported", which is misleading for a network failure. Not changed.

## Eval: WER baseline, number normalization and pre-roll (2026-10-02 to 2026-10-03)

All runs: 37 recorded cases (`eval/wer/cases.jsonl`), model/base, results under
`eval/results/`. Corpus WER is errors over reference words, silence excluded. `num_norm`
turns 1 and 2 digit integers into words on both sides (12 -> twelve); the raw figures are kept
so older numbers stay comparable.

- **Baseline** (`baseline-base-r1` to `r3`, mean of 3 repeats): 27.5% raw, 23.5% number
  normalized. First word right on the soft cases: 1 of 5 in every repeat. Untrimmed
  model-only (`model-only-base`): 28.2% raw, 24.4% normalized, with empty output on 10 cases.
- **Why the first word was lost.** The frame that crosses the VAD threshold was never
  recorded (see [ARCHITECTURE.md](ARCHITECTURE.md), "Speech start and pre-roll"). Offline,
  `vad-onset.mjs` found the VAD fires about when the 600 RMS energy onset appears (median
  delay -4 ms at 0.65), so the loss is the trigger frame plus the frame before the energy,
  1 to 2 frames. Trimmed model-only arms agree: starting at trigger+1 (what the pipeline
  recorded) got 3 of 5 soft first words, starting 3 frames earlier got 5 of 5, and starting
  15 frames earlier gave the same first words as 3 frames (9 of 10 soft and strong each).
  The fixed rule then picked 4 frames.
- **Pre-roll** (2783344, `PRE_ROLL_FRAMES = 4`, 128 ms, first pass): results in
  `pre-roll-r1` to `r3` (`pre-roll-r3` ran after midnight, so its folder is dated
  2026-10-03). Corpus WER mean 15.7% raw and 12.4% normalized. First word right on the soft
  cases: 5 of 5 in every repeat. On the 26 cases where untrimmed model-only produced text,
  22.0 of 26 on average (baseline 8.3, untrimmed model-only 21, trimmed arm B 23). 21 of 36
  cases improved in the mean, 11 were unchanged, 4 were worse.
- **Regressions.** fst-04 ("12 students" became "Well, students") and pw-04 (an extra "update.
  Make" before "reply") were worse in all 3 repeats. In `pre-roll-r2`, sh-01 has no
  transcript: a model-call error at manual stop. Not investigated beyond the events.
- **Speech starts after a misfire** prepended 0 frames in all 6 cases (bn-06 and cas-01, 3
  repeats). No eval case exercised a restart after a `speech_end`; that path is covered only
  by the unit test.
- **Open, not changed:** the misfire behavior (`isTalking` stays true after
  `onVADMisfire`), the short-buffer model error in `stop()`, the VAD thresholds, and the
  pre-roll length (uncalibrated). Chrome's mic processing (echo cancellation, noise
  suppression, auto gain) was not tested as a cause of the remaining differences between the
  pipeline and the offline trimmed arms.
- **Tools.** `run-wer.mjs` (pipeline), `run-model-only.mjs` (whole files, or trimmed relative
  to the VAD trigger with `--trim-from-trigger`), `vad-onset.mjs` (VAD trigger delay per
  case), `wer.mjs` (scorer), `replay-commits.mjs` (offline commit-boundary replay, see the last
  section). The drivers write the `burst_affected` and `number_normalization` sections of each
  README; the `pre_roll` comparison sections in the `pre-roll-r*` READMEs
  and the mean line in the `baseline-base-r*` READMEs were added by hand and are labeled.

## Eval: stop guard, recorded-frames pause gate, replay tool (2026-10-03)

Three fixes on top of pre-roll, then 3 repeats on the same 37 cases (`stop-guard-gate-r1` to
`r3`, model/base, results under `eval/results/`; all three folders are dated 2026-10-03).

- **Stop guard** (da6e9c5, widened in d0e74c7). The STT encoder rejects audio under 895
  samples (894 throws, 895 runs, measured on model/base; tiny not measured). That was the
  `Invalid input shape` error in `pre-roll-r2` sh-01. `Transcriber.transcribe()` is now the one
  function every commit path calls the model through and skips audio under that minimum, so
  `stop()`, `onSpeechEnd` and the pause and cap paths are covered. See
  [ARCHITECTURE.md](ARCHITECTURE.md), "Speech start and pre-roll".
- **Pause gate counts recorded frames only** (40531cd). Prepended pre-roll frames no longer count
  toward the 64 frame pause-commit minimum; they still count toward the 128 frame cap.
- **New baseline.** Corpus WER mean 8.5% normalized (8.5, 9.0 and 8.1% per repeat, so 8.1 to
  9.0%) and 12.3% raw (12.0, 12.8, 12.0%), against 12.4% and 15.7% for `pre-roll`. First word
  right on the 26 cases where untrimmed model-only produced text: 22.7 of 26 on average (23, 23,
  22), against 22.0 for pre-roll. Soft first words 5 of 5 in every repeat. No `no_transcript`,
  no commit mismatches, silence case produced 0 words. Per case, in the mean normalized WER: 10
  improved, 24 unchanged, 2 worse.
- **The gate fix restored the commit boundaries and reduced multi-commit cases.** pw-04's
  first commit is back at "quick" in all 3 repeats (it had moved to "quick update." under
  pre-roll), and mean normalized WER on pw-04 went from 29.6% to 14.8%. The number of cases
  with more than one commit went from 7, 5, 5 (pre-roll, per repeat) to 5, 5, 4. These are single
  runs per repeat, so the drop in multi-commit cases is not isolated from run-to-run variation;
  pw-04 is the case where the boundary was checked against the audio.
- **pw-04's short tail is unstable.** The second commit is the short `onSpeechEnd` tail (36
  frames in the offline replay) and its text varied: "Reply.", "We fly.", "We fly." in the
  three repeats. Not investigated.
- **Worse in the mean versus pre-roll:** pw-01 (29.6% to 33.3%, 2 commits in both arms) and pw-03
  (19.0% to 28.6%, a single commit in both arms, "the school" became "the spoon"). Cause not
  investigated; pw-03 cannot have changed boundaries.
- **Tool: `replay-commits.mjs`.** Offline commit-boundary replay: the real Transcriber (real VAD
  and STT) is fed each WAV frame by frame and every commit is printed with its frame range, the
  path that fired it (pause-EMA, cap, onSpeechEnd, stop) and its text; commits skipped by the
  encoder minimum are listed too. `--frames a-b` dumps probability and EMA per frame. **Known
  limit:** it did not reproduce the in-word probability dip that the mic run showed on pw-04: the
  replay fires the pause commit at frame 114 with and without the gate fix, and the EMA stays at
  or above 0.73 between frames 96 and 108. Offline frames skip Chrome's mic processing, which is
  the suspected cause but was not tested. The gate fix is covered by a unit test and by the WER
  runs, not by the replay.

**Open items**

- Misfire handling: `isTalking` stays true after `onVADMisfire`. Waiting on noise-only
  recordings to test it.
- Commit seams (where one utterance is cut into several commits) as the next accuracy lever.
- bn-03 (flagged burst_affected): the speech peaks at a VAD probability of 0.558 (frame 45; the
  only other frames at or above 0.5 are 46 at 0.527 and 58 at 0.547). It crosses 0.5 but never
  reaches the 0.65 positive threshold. What triggers the VAD is the burst at the start of the
  recording: frames 0 to 2 score 0.752, 0.737 and 0.627, and `speech_start` fires on frame 0
  (`vad-onset.mjs` reports frame 0 for both 0.5 and 0.65; it does not print peaks, so the
  per-frame values come from `replay-commits.mjs --frames`). Without the burst the case would not
  have triggered at 0.65. A VAD threshold question.
- Streaming TTS, for latency.
- Not changed and still open from before: the VAD thresholds, the pre-roll length (uncalibrated),
  and Chrome's mic processing as a cause of the gap between the pipeline and the offline arms.
