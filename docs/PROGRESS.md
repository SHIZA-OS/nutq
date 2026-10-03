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
  section; its `--wer <label>` mode is the phase-swept replay WER: every case at 8 frame phases, scored with
  `wer.mjs`, written to `eval/results/<date>-wer-<label>/`; limits: no Chrome mic processing, no
  resampling, no streaming updates, no real-time scheduling, and the turn ends the way `run-wer.mjs` ends it: the same turn policy as `main.ts`
  (`src/turn-policy.ts`) driven with time from frame positions, then a manual stop at WAV duration + 10 s if it
  has not ended; 32 of 37 turns end by auto-silence, as live). The drivers write the `burst_affected` and `number_normalization` sections of each
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
- **New baseline (since superseded as the baseline by 9.1% in the last section).** Corpus WER mean 8.5% normalized (8.5, 9.0 and 8.1% per repeat, so 8.1 to
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

**Open items** (as of the end of this section; see the next section for the current list)

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

## Eval: serialized model calls, case sets, interleaved A/B (2026-10-03)

- **Model calls are serialized** (83b695c). Four `Session already started` js_errors in the
  `stop-guard-gate` runs (bn-02 once, bn-05 in all three repeats) came from the `onSpeechEnd`
  model call, which had no catch and could collide with another call. Every model call now goes
  through one queue (see [ARCHITECTURE.md](ARCHITECTURE.md), "Model calls are serialized"). Across
  the nine serialized runs (`serial-model` r1 to r3, `serial-model-2` r1 to r3, `ab-B` r1 to r3)
  there were 0 js_error and 0 stt_error.
- **Instrumentation** (3bbc439, 72b5408). One `stt_model_call` event per model call, with
  `audio_hash`, `wait_ms` and `run_ms`; a caught model error is an `stt_error` event.
- **Case sets** (1386fba). `cases.jsonl` rows have an optional `set`; the original 37 cases are v1
  (the comparable baseline), the five added cases (no-01 to no-04 noise only, nts-01 noise then
  "Stop.") are v2 and have no recordings yet. The summary and README report v1 next to all scored
  cases. Re-scoring `stop-guard-gate` reproduces 8.5% for v1.
- **A false alarm, then a controlled answer.** Three serial runs each of `serial-model` and
  `serial-model-2` scored 10.5% and 10.4% normalized against 8.5% for `stop-guard-gate`, with the
  first commit about 0.6 s later, and no explanation in the code (a commit's audio is fixed and the
  buffer flushed when it fires, before anything is queued). An interleaved A B A B A B run (the
  pre-serialization code 40ed0ed against 72b5408, back to back, each arm from its own worktree and
  Vite server; `ab-A-r*`, `ab-B-r*`) settled it:

  | | A (pre-serialization) | B (serialized) |
  |---|---|---|
  | v1 normalized per run | 7.7 / 9.4 / 12.8% | 9.4 / 8.1 / 9.8% |
  | v1 normalized mean | 10.0% | 9.1% |
  | v1 raw mean | 13.5% | 12.7% |
  | first words on the 26 cases | 23, 23, 22 (22.7) | 21, 23, 22 (22.0) |
  | first commit after `speech_start` | 2876, 2906, 3384 ms | 2841, 2924, 3088 ms |
  | manual stop to `transcript_final`, mean | 86 to 106 ms | 100 to 102 ms |
  | js_error | 3 (`Session already started`) | 0 |

  The mean difference is 0.85 points and the ranges overlap, so serialization is WER-neutral (the
  rule fixed before the run: within 1 point, or overlapping). The first-commit gap of the earlier
  serial runs did not appear. The load average rose to 3.77 at the end of `ab-A-r3` (another
  process, not identified). B's model run time for 64 frame commits was 208, 200 and 205 ms; in
  `serial-model-2` it had been 400, 386 and 197 ms, so model speed had varied 2x between repeats in
  that window. Queueing was rare: 5 of 303 non-update calls in the `ab-B` runs waited more than 10 ms
  (longest 86 ms), and no update was skipped.
- **New baseline: B's interleaved mean, 9.1% v1 normalized** (9.4, 8.1 and 9.8% per run; 12.7% raw;
  22.0 of 26 first words; soft first words 5 of 5 in every run). The earlier 8.5% (`stop-guard-gate`)
  sits inside the spread of the same code measured in one session: arm A alone ranged from 7.7% to
  12.8%. Three repeats do not separate differences of about 2 points; do not read a smaller change
  from one 3 repeat run.
- **What is and is not established about the gains.** The pre-roll gain, about 11 points (23.5%
  normalized for the baseline to 12.4% for `pre-roll`), is well beyond the measured noise: the
  largest within-arm spread seen (arm A, 7.7% to 12.8%) is about 5 points, although that spread was
  measured on later code, not on the baseline code. The gate fix's WER gain (12.4% to 8.5% for
  `stop-guard-gate`, about 4 points) was measured across time windows (the `pre-roll` runs and the
  `stop-guard-gate` runs were hours apart and not interleaved) and is of the order of the
  within-arm spread, so its size is unconfirmed. Its mechanism is confirmed: pw-04's first commit is
  back at "quick" in all three `stop-guard-gate` repeats, and fewer cases are cut into several
  commits (7, 5, 5 per repeat before, 5, 5, 4 after; single runs). The stop guard went in with the
  gate fix in those runs, so the two are not separated either. `ab-A-r3`, the worst A run (12.8%),
  coincided with the load spike (load average 3.77, 2.83 and 2.19 at its end, against about 1.0
  before the session); this does not show the load was the cause.
- **The audio the model gets differs between repeats.** With the checksums from the three `ab-B`
  runs: of 101 commits matched by position across repeats, 74 had the same length in all three, and
  only 12 of those had the same audio hash; 62 differed. fst-04 had identical audio (a 98 frame
  commit and a 22 frame tail) and identical text in all three; bn-03's first commit (68 frames) had
  a different hash in every repeat, with the same text. 6 cases had identical commit audio in all
  three repeats (same final text in all 6); in the other 30, 20 had the same text in all three. So
  commits of the same length carry different samples from run to run through the mic path. The
  cause is not identified (Chrome's capture and mic processing, and resampling alignment, were not
  tested).

**Open items**

- Record the noise-only cases (no-01 to no-04) and nts-01, then look at misfire handling
  (`isTalking` stays true after `onVADMisfire`); it needs those recordings.
- Commit seams (where one utterance is cut into several commits) as the next accuracy lever.
- bn-03 (see above): a VAD threshold question.
- Streaming TTS, for latency.
- Why the audio differs between repeats of the same recording, and whether that run-to-run spread
  can be reduced; until then compare arms only by interleaving them.
- Not changed and still open from before: the VAD thresholds, the pre-roll length (uncalibrated).

**Mic processing as a variance source (variance diagnostic, 2026-10-03).** Two back-to-back runs with
`?rawmic=1` (echo cancellation, noise suppression and auto gain off; `rawmic-r1`, `rawmic-r2`, not
comparable to the baseline) raised same-length hash agreement between the two runs (45 of 72
commits, 62.5%) above the default-mic pairs in `ab-B` (23% to 52%), but did not stabilize
transcripts (28 of 37 identical against 29 to 32) or WER (15.0% and 10.7%). The remaining variation
is unexplained; the 44.1 kHz capture rate Chrome reports (resampled downstream) is untested.
Measurement policy: logic changes are compared with the phase-swept replay; absolute numbers come
from interleaved live runs.

**Phase-swept replay baseline (2026-10-04, `replay-head`, code at 46c3925).** 8 frame phases x 37 cases, manual
stop at the end of the WAV: v1 normalized WER 9.8, 11.1, 10.7, 11.1, 10.3, 9.4, 10.7 and 12.0% by phase, mean 10.6%
(raw 14.6%), first words 22.6 of 26; two runs were byte-identical. A different measurement from the live runs
(the live interleaved B arm was 9.1%); use it to compare logic changes.

**Turn-end policy module (2026-10-04).** When a turn ends and why moved out of `main.ts` into the pure module
`src/turn-policy.ts` (auto-silence 5000 ms armed on a speech end, cleared by a speech start, a misfire does nothing,
a manual stop ends the turn now); the replay uses the same module. With it, `replay-head-policy` (code at the
turn-policy commit) has the same per-phase WER as `replay-head` (9.8, 11.1, 10.7, 11.1, 10.3, 9.4, 10.7, 12.0%; mean 10.6%)
and all 296 case-phase hypotheses are identical; only the trigger differs: 32 turns end by auto-silence and 5 manually
(sh-01, sh-02, sh-04, sil-01, bn-03) in every phase, the same as the live runs. Two runs were byte-identical.

**Demo changes (2026-10-04).** A VAD misfire now arms auto-send like a speech end, so short words ("Yes.", "Stop",
"What?") end by auto-silence instead of needing a manual stop (live smoke: sh-01, sh-02 and sh-04 ended by auto-silence,
aq-01 unchanged; one smoke run detected no speech at all in sh-02 and sh-04, and one had a cold model-load timeout,
neither explained by the change). An empty or whitespace-only transcript is not sent to the gateway (`send_skipped`
event; sil-01 smoke). The auto-silence delay is adjustable with `?silence=<ms>` in any mode (default 5000, clamped to
800..8000). No full WER runs or replay sweeps were made for these, only unit tests and short live smoke runs. Silero
finding: the app creates one Silero session per page (never per Connect or per listening session), about 100 MB once,
with no growth per turn; each extra session costs about 10.5 MB and is never released, which only matters to tools
that create many (the replay opens a page per phase for that reason).

**TTS voices, resampler, external files (2026-10-04).** TTS: voices now load at page load, `?voice=<name>` picks one,
the voice list is in the log panel and `tts_start` carries the voice. With a local stub gateway (no ZeroClaw), done to
`tts_start` took 81, 74 and 73 ms on the browser default voice and 55, 64 and 59 ms on a chosen local voice; every
voice on this machine is local (13,363 espeak-ng voices, only listed with `--enable-speech-dispatcher`), so a
network-voice delay was not measured. 48 kHz: the worklet resampler is vad-web's box-average decimator, exact for
48000 Hz (1536 input samples per 512-sample frame, no drift) and 0.057% time-stretched for 44100 Hz; it has no real
low-pass (tones at 9 to 12 kHz alias at only -4.6 to -9.5 dB, and 7 kHz is down 2.6 dB), a quality limit rather than a
bug, so nothing was changed. sh-02 and sh-04 detected speech and ended by auto-silence in 3 of 3 runs each at 48000 Hz
(track and AudioContext both). External files the page fetches: Moonshine model/base encoder (20.5 MB) and decoder
(42.5 MB) from download.moonshine.ai; ONNX runtime 1.22.0 `ort-wasm-simd-threaded.jsep.mjs` and `.wasm` (4.2 MB
transferred) from jsDelivr; Silero `silero_vad_v5.onnx` (2.3 MB), `vad.worklet.bundle.min.js` (2.6 KB) and the
runtime 1.14.0 `ort-wasm-simd.wasm` (10.0 MB, 2.4 MB transferred) from jsDelivr; and Google Fonts (CSS and four
woff2 files, about 215 KB). Note the installed `onnxruntime-web` JS is 1.27.0 while the wasm comes from the 1.22.0
CDN path.
