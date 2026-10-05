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

48 kHz: the resampler is exact at 48000 Hz and short-word detection worked 6 of 6 (`rate48-r1` to `r3`, a 48 kHz diagnostic, not comparable to the baseline); its anti-aliasing is weak above 8 kHz (a quality limit, not a bug); self-hosting the page's external assets is deferred until after the demo.

Demo defaults (2026-10-04): replies use the first local English voice (`voice_source` `auto_local`; `English (America) espeak-ng` on this machine), and `scripts/demo-chrome-linux.sh` starts Chrome with `--enable-speech-dispatcher` and its own profile; see the README Demo section. The auto-send delay was briefly changed to 1200 ms in the code and then reverted: the code default is 5000 ms again, the demo uses 1200 ms through `?silence=1200` in the launch script's URL, and the public default stays 5000 until endpointing work picks a better one (a pause longer than 1.2 s mid-sentence ends the turn early at 1200).

Voice (supersedes the local-voice and launch-flag notes above): local espeak-ng voices started in about 60 ms but sounded too robotic for the demo, so the browser default voice is back (`?voice=<name>` and the voice list stay); better TTS (Piper or a cloud voice, plus streaming by sentence) is the post-demo fix for both quality and start delay.

Turn state and TTS hygiene (2026-10-04): a message is no longer sent while a reply is in flight (`src/turn-state.ts`; a mid-turn message is steering in ZeroClaw, so the utterance is dropped, not held), `speak()` trims the reply and reports skipped, ended and failed speech, and speech is cancelled when a message is sent, a turn is aborted or the socket closes; new eval events `send_blocked`, `tts_skipped`, `tts_end` and `tts_error` (see eval-harness-design.md).

In-flight guard follow-up (2026-10-04): the guard clears itself after `REPLY_TIMEOUT_MS` (60000) with a log warning and the eval event `turn_timeout { ms }`, a blocked utterance shows "Still answering, try again" under the mic button until the reply ends, and speech cancelled or interrupted by the browser is the eval event `tts_cancelled { reason }` instead of `tts_error`.

Sentence streaming for TTS (2026-10-04): behind `?tts_stream=1` (default off; with the flag off nothing changes except
the new `engine` field on `tts_start`) the reply is spoken sentence by sentence as its chunks arrive, instead of once at
`done`. `src/sentence-splitter.ts` splits the chunk deltas (`. ? !` then whitespace; not inside numbers or after Dr.
Mr. Mrs. Ms. e.g. i.e. vs. U.S.; fragments under 20 characters merge into the next sentence; `flush()` at done),
`src/speech-queue.ts` plays them one at a time with a generation counter so a cancelled run's late callbacks are
ignored, and `src/tts-engine.ts` puts the browser (Web Speech) engine behind a small interface; it is the only engine.
The speech comes from the chunks, never from `full_response` (a difference is `tts_text_mismatch` and nothing is
spoken again), and the queue is cancelled on aborted, a failure error, a closed socket, the reply timeout and a new
send. New eval events `tts_requested`, `tts_sentence_start` and `tts_text_mismatch` (see eval-harness-design.md, which
also says how `join-latency.mjs` reads a streamed turn: `tts_start_delay` can be negative). The suite went from 116 to
152 tests, all passing. Not measured and not claimed: any latency change. Not verified: speech by a real voice with the
flag on; the cancels on a failure error, on the reply timeout and on a new send are in the code but no test reaches them
(a send needs the microphone and the speech model). Known limits: a reply with no chunk frames is silent with the flag on;
text without `. ? !` and whitespace (an unpunctuated list, or Arabic, Urdu or CJK terminators) is spoken whole when
`done` arrives. Separate from this work: `serial-model.test.mjs` asserts a wall-clock wait under 30 ms; it failed in 3 of 3
default parallel `npm test` runs made during this work (after passing in two earlier ones) on this 8-core machine, and
passed alone and with `--test-concurrency=3`, so it is load sensitive; it was not changed.

Sentence streaming follow-ups (2026-10-04), superseding two notes in the entry above. (1) With `?tts_stream=1`, a turn that
reaches `done` with no sentence queued now speaks `full_response` once, trimmed, through the same queue (nothing if it is
empty, then `tts_skipped`), and `tts_text_mismatch` is still reported, so a reply with no chunk frames is no longer silent.
(2) `serial-model.test.mjs` no longer asserts a wall-clock wait: the failing wait was the first call's, which includes the
test's own synchronous work between two calls being queued (30 ms in the run that failed, with the second call queued 27
ms after the first), so it grew with machine load. The test now reads `performance.now` from a clock that only moves when the
fake model finishes its 60 ms, and `wait_ms` and `run_ms` are exactly [0, 60], [60, 60], [120, 60]. Three consecutive plain
`npm test` runs passed (152 of 152); with the fallback's two new tests the suite is 154.

Replay check and TTS follow-ups (2026-10-04). STT is unchanged: `git diff 29852d5..0f5f295 --stat` lists nothing under
`src/vendor` and no change to `turn-policy.ts` or `mic-constraints.ts`; `main.ts` changed only in reply and TTS handling.
The phase-swept replay at 0f5f295 (written to `eval/results/2026-10-04-wer-replay-0f5f295`, not committed) matches
`replay-head` (f2de874) phase by phase: v1 normalized WER 9.8, 11.1, 10.7, 11.1, 10.3, 9.4, 10.7 and 12.0%, mean 10.6%,
first words 22.6 of 26, and every case hypothesis is the same in all 8 phases. Only the trigger differs: f2de874 ended turns by
a manual stop, HEAD ends them with the turn policy (36 by auto-silence and 1 manual, sil-01, per phase). Against
`replay-head-policy` the hypotheses are also identical; sh-01, sh-02, sh-04 and bn-03 now end by auto-silence instead of
manually, which fits a5339f8 (a VAD misfire arms auto-send; bn-03 was not checked on its own). With no voice chosen the
utterance now asks for `en-US`: the voice Chrome flagged as default in a saved real-run log was Google Deutsch. Which voice
Chrome then uses cannot be observed from the page (`utterance.voice` stays null, no event names a voice, and headless Chrome on
this machine lists none), so `tts_start.voice` stays the default-flag guess and may now name a voice that is not the one
spoken. Tapping the mic button to start listening cancels speech (`tts_cancelled` `{reason: "mic_press"}`); not handled: a
reply still arriving after the tap is still spoken (its later chunks with `?tts_stream=1`, its `done` without). The
`tts_text_mismatch` with `chunks_chars` 175 and `full_response_chars` 126 (`nutq-events-1791110340369.jsonl`, the turn
sent at 10:38:42 UTC): ZeroClaw's runtime trace shows iteration 1 ended in a `web_search_tool` call and iteration 2's
`turn_final_response` is exactly 126 characters, and the client's first chunk (10:38:43.031) arrived before iteration 1's
response completed (10:38:43.440). The gateway forwards every live-streamed text delta as a chunk, including text before a tool
call, while `done.full_response` is only the final iteration's text (`accumulated_display_text` in
`crates/zeroclaw-runtime/src/agent/turn/mod.rs` is appended only on the iteration with no tool calls). So the 49 extra characters
are text streamed in iteration 1; the trace does not record that text, so its content is not verified. With `?tts_stream=1` it is spoken.

Mute after a mic tap (2026-10-04): tapping the mic button to start listening while a reply is in flight now mutes the rest of
that reply, with and without `?tts_stream=1`. `ReplyState` (`src/turn-state.ts`) holds the mute, set by `mute()` only while a reply
is in flight and cleared at every point that clears the flag (done, aborted, the three turn-failure errors, a closed socket, the
60 s timeout), so the next turn speaks normally; a tap with no reply in flight mutes nothing. While muted, later chunks are shown
but not queued, and at `done` nothing is spoken (no tail, no `full_response` fallback, no `tts_text_mismatch`, no `tts_skipped`).
`main.ts` reads the mute before `frame()` because a `done` clears it. The in-flight guard is unchanged, so the user's own
utterance during the muted reply is still blocked with "Still answering, try again". New eval event `tts_muted` `{reason, point,
chars}` (see eval-harness-design.md for the two meanings of `chars`); `join-latency.mjs` now reports a muted turn as muted with a
null reason for the missing `tts_start` instead of listing it as a missing client event, and `completion.mjs` is untouched and
pinned. The suite went from 160 to 180 tests, all passing. The stub-gateway test can now put a real reply in flight (its fake
Transcriber commits a transcript on stop), which also covers the failure-error cancel; the cancels on the reply timeout and on a new
send are still not exercised by a test. Interaction with the known limit (no turn id): a late `done` after the 60 s timeout can
clear the next turn's flag, and the mute with it, so in that narrow window a muted turn could speak again. Not verified by ear in a
real browser: a mic tap mid-reply in both modes.

Semantic endpointing, build (2026-10-04): the auto-send wait can now depend on the transcript, opt-in with `?endpoint=semantic`; the code
default is still the fixed 5000 ms and `?silence=<ms>` is still a fixed wait that ignores the text and wins when both are given. `turn-policy.ts`:
`TurnPolicy(number | (text, commitsInFlight) => ms)` keeps `armedAt` and recomputes the deadline when `transcript(text, at)` or
`setCommitsInFlight(n, at)` changes the wait (a speech start clears it for good; text that moves the deadline into the past ends the turn
when it arrived); `endHint` reads done / open / unknown (an open-list word beats terminal punctuation, so "a flight and." is open; digits are
words; a trailing `...` `,` `;` `:` `-` is open); `waitFor` gives one wait per hint, clamped, and holds a short wait at the `unknown` one while a
commit is in flight. The Transcriber has `onCommitsInFlight(n)`. `main.ts` feeds both and re-arms the timer, and logs an `endpoint` event
`{ hint, wait_ms, text_chars, commits_in_flight }` when a wait is armed and on each recompute. The open list is tier 1 only (conjunctions,
articles and determiners, prepositions, fillers); auxiliary verbs and pronouns are left to the sweep. `SEMANTIC_WAITS` (done 300, unknown 1500,
open 3500, floor 150, ceiling 8000) are placeholders, the middle of the planned sweep grid, not results. The suite went from 180 to 219 tests. The
wiring is tested against a fake Transcriber; it has not been run with the real model and microphone, and no endpoint event from a real run has
been looked at.

Replay (`replay-commits.mjs`): `--policy fixed:<ms>|semantic|semantic:d,u,o,floor,ceil`, `--latency-scale`, `--gate <results dir>`. The replay has no
real clock, so a commit's text reaches the policy at its fire time plus 269 ms per second of audio minus 61 ms (floor 100), a line fitted to 297 live
commit calls (residual sd 191 ms), one commit at a time. Events inside a frame are timed at the start of that frame, as before (up to 32 ms). Each
case now reports its pauses, whether the turn was cut off, the wait after the true end of speech and the hint and wait at the last arm; the speech
runs come from a second VAD pass over the whole file (probability 0.5 or above, gaps under 512 ms bridged). That pass misses soft speech in the
noise cases, so for those a cut-off shows up as a deleted word, not as `premature`. Correction to the Phase 1 note that v1 cannot show a premature
send: cas-01 has a 960 ms pause that the VAD reports as a misfire followed by speech 192 ms later, so a wait that short after a misfire would cut
it. (This note first said bn-03 has a 1.3 s gap too. That was wrong: the gap the replay measured there runs from the leading recording burst at
frames 0 to 2 to the speech, not a pause inside a sentence.)

v1 gate against `2026-10-04-wer-replay-head-policy` (8 phases x 37 cases): `fixed:5000` reproduces the baseline exactly (0 of 296 hypotheses differ;
`2026-10-04-wer-gate-fixed5000`; median wait after the true end 5768 ms, which is 768 ms of VAD redemption plus 5000). The placeholder semantic
policy fails it (`2026-10-04-wer-gate-semantic`): 2 of 296 differ, both bn-03. Its reference is only "Set a timer for ten minutes."; the recording also
holds a stray soft "Yes." later, which the baseline kept (WER 33%) and the semantic run lost (WER 17% in phase 0) because the VAD misfire at 896 ms
armed a 1500 ms wait that ended the turn at 2396 ms. (Under the gate rule changed afterwards, to fail only on a new error against the reference, this is a review item, not a failure: see the
endpoint sweep entry below.) v1 wait after the true end under the placeholders: median 1100 ms, p90 2268 ms, max 4300 ms (fixed 5000: 5768, 5800, 6152).
These come from the replay with a modelled model latency, not from live runs.

v2 set: 15 recordings in `cases.jsonl` (`set: v2`: mp-01 to mp-12, te-01, te-02, ls-01), recorded with `eval/wer/record.sh` (new per-case `seconds`, and
a `pause_s` prompt that says to count the pause silently). Not recorded yet, so no premature-send number exists.

Endpoint sweep (2026-10-05, `eval/results/2026-10-05-endpoint-sweep/`): all 57 recordings (37 v1, 20 v2: no-01 to no-04, nts-01, mp-01 to mp-12, te-01, te-02,
ls-01) x 8 phases. The v1 gate now fails only on a new error against the reference (more substitutions, deletions or insertions after number
normalization) and lists other changed hypotheses for review; it first crashed on silence-scored cases (empty reference), now fixed. Re-run: `fixed:5000`
passes with nothing listed; the placeholder semantic policy passes with bn-03 listed (phase 0: the stray "Yes." is gone, fewer errors; phase 1: only
the final full stop changed). The sweep ran the real Transcriber once per recording and phase (`--streams`) and replayed 640 policies on those streams
with the real TurnPolicy (`endpoint-sim.mjs`) at model-latency scales 0.5, 1 and 2. The simulator matches the real replay exactly (cuts by recording,
median, p90, max wait, number of turns) for all five policies that were also run for real. It does not model the flush `stop()` does at an early end:
in the real replay `semantic:0,1500,2500,0` and `fixed:1500` each sent a non-empty message on one noise-only turn-phase (no-01 phase 4: "It") where
the simulator said none. Findings (the report has the numbers): no semantic policy gets under 12 pause cuts of 96 (fixed:3000 has 0 and fixed:2200
has 8), because Moonshine's mid-sentence full stops (mp-10) and pauses after a complete clause (mp-12) read as done and the grid's `done` tops out
at 1000 ms; the pauses after function words are protected (0 of 64 cut with `open` at 2500 or more). At equal-or-fewer cuts semantic policies save
about 1.2 to 1.95 s of median wait and 30 to 730 ms of p90 against the best fixed wait. Tier 2 (auxiliary verbs, subject pronouns) never beat tier
1: 219 of its 315 policies are dominated and none is better. `semantic:0,1000,2500,0` fails the real v1 gate (sh-02 "Stop" is lost in two phases,
bn-03 in one). The measured pauses of the 12 pause takes are 1.6 to 3.0 s, not the intended 1, 2 and 3.5 s (mp-03, intended 1 s, measures 2.9 s), so
the dose-response by pause length cannot be tested. Limits: 12 pause recordings by one speaker; the 8 phases only shift the frame grid, so they are not
independent; cuts are dominated by single recordings (mp-10 for the semantic points, mp-08 for fixed:2200). Not changed: `SEMANTIC_WAITS`, the
code default (5000) and the demo script. The sweep script, the take check and the burst detector are in `eval/runner/endpoint-*.mjs`.

## Endpoint settings chosen (2026-10-05)

The sweep (`eval/results/2026-10-05-endpoint-sweep/`) picked the Conservative point, `semantic:1000,2200,2500,0` with the tier 1 open list, and
`SEMANTIC_WAITS` in `src/turn-policy.ts` now has those values (done 1000, unknown 2200, open 2500, floor 0, ceiling 8000 unchanged). The code default
stays the fixed 5000: semantic is still opt-in with `?endpoint=semantic`. `scripts/demo-chrome-linux.sh` now adds `endpoint=semantic` and no longer sets
`silence`, because `?silence` overrides semantic mode.

Why this point, from the sweep report (simulator at latency scale 1, and a real replay of the same policy over all 57 recordings and 8 phases, which
matched the simulator's cuts exactly): median wait after the true end of speech 1768 ms against 2968 ms for the best fixed wait, `fixed:2200`; p90 2968
against 3000 ms. It costs 12 pause cuts of 96 turn-phases against 8 for `fixed:2200`. Real v1 gate: PASS, 0 fail, 2 review (bn-03 in phases 0 and 1);
v1 WER 10.6%, all-57 WER 14.4% (`fixed:2200`: 10.6% and 13.4%).

Limitation: the 12 cuts are dominated by one recording. mp-10 is cut in 8 of 8 phases (Moonshine puts a full stop in the middle of the sentence, so the
text reads as done and the 1000 ms wait ends the turn), mp-12 in 3 of 8 and mp-09 in 1 of 8; without mp-10 the cuts are 4. The sweep had 12 pause
recordings by one speaker, and its measured pauses were 1.6 to 3.0 s, so this is a result for those takes, not a general cut rate. These waits have
not been tried live with the microphone in a demo.

## Thorough replies, spoken as text only (2026-10-05)

The prefix on every message used to ask for 1 to 2 short sentences. `?reply=voice` now asks for a thorough answer written as speech; `?reply=short`
is the default and the original prefix, byte for byte (pinned by a test). The demo script sets `reply=voice` and `tts_stream=1`; the code defaults are
unchanged. Whatever the agent sends, `speakable()` (`src/speech-text.ts`) cleans it before every TTS path (flag off, streamed units and tail, the
`full_response` fallback), and the splitter now also closes a unit at a newline. The transcript card keeps the original text. New eval data:
`reply_style` on `ws_message_sent`, and a `speech_text { raw_chars, spoken_chars }` event. Details are in ARCHITECTURE (`?reply=`, Speech text).

Probe before the build (`docker exec zeroclaw zeroclaw agent -a default -m ...`, 3 questions that invite structure, each with no prefix and with the
voice prefix; replies were not committed). Without a prefix every reply was markdown: bold (2 to 26 per reply), headings (3 to 6), bullets, numbered
lists, fenced code blocks and inline code (q1 only), and em dashes (seen in q3). With the voice prefix none of 3 replies had bold, headings, bullets, numbers, code, tables,
URLs or emoji; the replies were prose paragraphs, each one a single line of 190 to 410 characters with blank lines between, so they were not
hard-wrapped. One of the 3 still contained em dashes. Length and wall-clock time of the CLI call (this includes `docker exec` start-up and is not
the `/ws/chat` path, and a CLI call gives no chunks):

| question | no prefix | voice prefix |
|---|---|---|
| set up a Python project | 195 words, 5.8 s | 272 words, 5.1 s |
| PostgreSQL vs MongoDB | 350 words, 8.3 s | 300 words, 6.2 s |
| pre-deployment checks | 322 words, 5.7 s | 242 words, 4.6 s |

Six samples, the longest 8.3 s, so the 60 s reply timeout (unchanged) was not close here; longer answers than about 350 words were not tried. In one
no-prefix reply the agent asked to run a shell command (`pwd`) and waited for approval; Nutq auto-denies approvals. Not tested: the mic-tap mute with
markdown (the mute check comes before any text handling), the `sendTranscript` line that picks the prefix (the page cannot send without a microphone;
the prefix function is tested), and how the voice sounds. The late-`done` behavior after a reply timeout (a late `done` still speaks) is unchanged.

Follow-up on dashes (2026-10-05). One of the three voice-prefix replies in the probe still had em dashes, so `speakable()` now turns an em or en dash into
a comma pause (no doubled punctuation, a dash at either end of a line dropped), except between two numbers, where it is a range and is read as "to"
("10 to 20"); a dash with a number on one side only gets the comma. Hyphenated words are untouched. The voice prefix now also lists "dashes" among the
things to avoid; `?reply=short` is unchanged, byte for byte. How a dash and a range sound has not been checked by ear.

## Streamed speech: gap between sentences, and coalescing (2026-10-05)

With `?tts_stream=1` there was an audible pause between sentences (you measured about 740 to 890 ms live). Each sentence was its own
`speechSynthesis` utterance, handed to the browser only after the previous one's `onend`. Before building, an experiment on a throwaway page
(outside the repo; headed Chrome 154, a dedicated profile, the browser default voice with `lang` en-US as the app does, a network voice
that the page cannot name: the voice flagged default was "Google Deutsch", de-DE, which is not what en-US gets) measured `onend` to the next
`onstart` for 7 short sentences, two rounds each, 12 gaps per mode:

| mode | mean | median | min to max | sd |
|---|---|---|---|---|
| one after another (as the app did) | 892 ms | 850 ms | 723 to 1105 | 127 |
| all queued ahead in the browser | 841 ms | 841 ms | 730 to 963 | 62 |

Queueing ahead did not help (the 50 ms difference of the means is inside the noise), so Chrome does not prepare the next utterance early. The delay
from `speak()` to the first `onstart` was 1964, 1005, 820 and 975 ms in the four rounds (the first one cold).

One long utterance each, listened to by one person, one run per length:

| chars | sentences | audio duration | `onend` | heard |
|---|---|---|---|---|
| 301 | 5 | 18.3 s | fired | all of it |
| 553 | 9 | 33.6 s | fired | stopped early |
| 1193 | 19 | 73.6 s | fired | all of it |
| 2409 | 38 | 151.0 s | fired | all of it |

So there is no sign of a hard length limit up to 2409 characters, and the one failure (553) does not follow from length; with one run per length
the cause is unknown (a random drop-out of the voice is a guess, not shown). `onend` fired after the full expected duration even when the audio
stopped early, so a cut-off cannot be detected from `tts_end`, and `onboundary` never fired, so progress inside an utterance cannot be seen.
The repeat runs were skipped.

What was built: the speech queue speaks the first unit of a turn alone and merges the units that have arrived into each later utterance, up to
`MAX_UTTERANCE_CHARS = 1200` (about 73 s of speech), at unit boundaries; a longer unit is spoken alone. 1200 is a judgement from the table above:
inside the range that played fully, half the exposure of 2400 if a voice drops out inside a batch, and about one 0.85 s gap per 73 s of speech.
The expected effect is that a reply of N sentences has about 1 plus the number of later batches gaps instead of N-1. That is arithmetic on the
measured gap, not a measurement of the new behavior: it has not been listened to with the change in. A drop-out inside a merged utterance now loses
more speech than one inside a single sentence, and `tts_end` will not show it; `tts_sentence_start { units, chars }` is there so a complaint can be
matched to a batch size. Mutation checks on the queue: 10 mutants (never merge, ignore the limit, off by one on the limit, join spaces not counted,
no join space, wrong index, wrong units, wrong chars, waiting kept on cancel, finish counting utterances), all caught. Two mutants of an early
version survived because the "first alone" guard was redundant (the first unit is alone because the queue pumps as soon as it is queued), so the
guard was deleted.

## Drop unheard speech on a tool call (2026-10-05)

With `?tts_stream=1` text the agent streamed before a tool call was spoken, although it never reaches `full_response` (ZeroClaw keeps only the final
iteration in `accumulated_display_text`, as reported by you; not checked in the ZeroClaw source here). Before this change a `tool_call` frame was only logged.
Now it drops what has not been heard: the splitter's unfinished text, every queued unit, and the utterance with the engine if its audio has not started;
an audible utterance plays to its end. New event `tts_dropped { reason, units, chars, partial_chars }`, only when something was dropped. Details in
ARCHITECTURE ("Tool calls") and eval-harness-design.md.

Decisions worth knowing. (1) "Not started speaking" is read as "not audible": an utterance handed to the browser whose `onstart` has not fired is dropped
too, and the browser is told to cancel it. The first sentence of a reply sits in exactly that state for the voice's start delay (0.8 to 2 s in the
gap experiment), which is when a tool call is likely to arrive, so leaving it would let the first pre-tool sentence through almost every time. If you
want the literal reading (only units still in the queue), `SpeechQueue.drop()` is the one place to change. (2) The done fallback used `sentences === 0`,
the turn's total; after a full drop that would stay above zero and the final answer would be silent. It now uses `fresh`, the units queued since the
last tool call, so `full_response` is spoken when nothing was queued after it, including when an audible pre-tool utterance was left to play. (3) Not
changed: `tts_text_mismatch` compares all chunks with `full_response`, so it will now and then be reported for a tool turn (it already was).

Limits: chunks arrive before the `tool_call` frame, so text already audible when the frame arrives is heard; this was not measured against a real
ZeroClaw tool turn, only with a stub gateway sending frames, so how often the first sentence is already audible is unknown. Mutation checks: 14 on
the queue and splitter (one survivor, `fresh` not reset when a turn ends, covered by a new test) and 12 on the wiring (one survivor, no event for a
drop of only unfinished text, covered by a new test); all caught after that. Not run: anything over the 57 recordings.

## Ignore a mic press right after a send (2026-10-05)

Evidence from one live run: a manual send at t=0 and a mic press at t=118 ms. The press started listening, muted the whole reply (`tts_muted`, 255 characters
never heard) and the new utterance was empty (`send_skipped`); a user who double tapped lost the answer. Before this change nothing guarded a press after a send:
the click handler took the start path, called `replyState.mute()` (which mutes when a reply is in flight) and `cancelSpeech("mic_press")`.

Now a press that would start listening less than `MIC_REARM_MS` after the last send is ignored and reported as `mic_press_ignored { reason: "rearm", since_send_ms }`;
at 400 ms or more nothing changes. See ARCHITECTURE ("Mic press right after a send"). The 400 ms is a judgement from one observed press at 118 ms, not a measured
threshold; no data says how soon a deliberate press can come. Not done: a visual disabled state (it would swallow the click, so the event could not be logged).

Tests use a fake `Date.now` in `mic-cancel.test.mjs` (the page's clock moves only when the test says): a press 118 ms after a manual send, at 399 ms and at 400 ms,
after an `auto_silence` send, with no send at all and after an empty utterance, and a release inside the window. The existing mic tests tap about 300 ms after a send, which
is inside the window, so the `turn()` helper now advances the fake clock 5000 ms by default. Mutation checks: 12 mutants, all caught except two. The survivors were
"guard also applies while listening", which needed a send while listening is true (see below), now covered; and "null check dropped" (`lastSendAt ?? 0`), which is equivalent
in practice because `Date.now()` is an epoch time and never under 400, so it was left as is.

Finding, not fixed: the window starts at the send, but the final transcription (`stop()`) runs between the release and the send. A press in that gap starts a second utterance
(shown with a slow fake `stop()`: a message is then sent while listening is true again). The live evidence was a press after the send, so this is a different window. Fixed in the entry below.

## Re-arm window from the release (2026-10-05)

The finding above is fixed. A press that would start listening is now ignored from the moment listening ends (a manual release or the `auto_silence` trigger)
until `MIC_REARM_MS` after the send. In code: `finishListening()` sets `finishing` and `releasedAt` before `stop()` and clears `finishing` in a `finally`, so a send,
a `send_skipped`, a refused send and a throwing `stop()` all close that phase; the `after_send` phase is the old check on `lastSendAt`. If the turn ends with
`send_skipped` the window closes at the skip, so the user can retry at once (a window that ran to 400 ms after the release would have made a retry after an
empty utterance fail). `mic_press_ignored` keeps `reason: "rearm"` and gains `phase` (`finishing` or `after_send`) and `since_release_ms`; `since_send_ms` is `null`
while finishing, including when an earlier utterance was sent (that send is not this utterance's). See ARCHITECTURE ("Mic press right after listening ends").

Tests (`mic-cancel.test.mjs`, fake `Date.now`, a slow `stop()` held at a gate the test opens; a first version used a 600 ms real delay and failed once in a full parallel run, a race, so it was replaced): a press during `stop()`, one at the send (0 ms), 399 and 400 ms after the send (with
the release 300 ms earlier, so `since_release_ms` and `since_send_ms` differ), an empty utterance then an immediate press, the `auto_silence` path, a prior send on
record, and a `stop()` that throws. The old `stopWindow` test pinned the bug (a second utterance starting during `stop()`) and was replaced. Mutation checks: 15
mutants. 13 were caught on the first run; one survived because no test had an earlier send on record while finishing (`since_send_ms` non-null), now covered and
caught. One survivor is equivalent at this commit: dropping `!listening` from the guard, because a send can no longer happen while listening is true, so neither
`finishing` nor `afterSend` can be true then. It is kept as a guard and pinned when a send can land mid-utterance (a held message, next entry).

## Hold and send (2026-10-05)

An utterance that finished while a reply was in flight used to be dropped (`send_blocked`, "Still answering, try again"). It is now held and sent when the turn ends.
Read from the code first: the only place a `message` frame is sent is `sendTranscript()`, behind `ReplyState.trySend()`; the one other `socket.send` is the auto-deny
`approval_response`, which is not a message. So no path sends while the in-flight flag is set, and the new `sendHeld()` runs only from the end of the frame handler, after the
ending frame (`done`, `aborted` or a turn-failure `error`) cleared the flag and after that frame's own handling. Running it before the handling was a mutant, and the test that
it is after is `done_received` coming before `held_sent`.

What was built (see ARCHITECTURE, "One turn at a time: hold and send"): one held message at most, a later utterance appended with a space; `send_held { chars }` (the length
of the whole held message so far), `held_sent { chars, waited_ms, end }` just before `ws_message_sent` with `send_trigger: "held"`, `held_dropped { reason: "closed", chars }` with the
hint "Message not sent, the connection closed" until the next connect. `send_blocked` is gone from the code (old event files can still contain it).

Decisions the spec did not make, so they are listed here: (1) `chars` on `send_held` is the whole held message so far, so the last `send_held` equals `held_sent.chars`; `waited_ms`
counts from the first hold. (2) If the turn ends while the user has the mic open again, the held message is still sent at turn end (asked, answer: send, and mute the new answer
with `ReplyState.mute()`), so nothing is read out over the open mic and what they say next is held for that answer. (3) A hold, like a skip, closes the Phase 1 re-arm window:
the user can press at once and the utterance is appended. (4) The utterance's own trigger is not kept on a held send. (5) `join-latency.mjs` gets a `held` bucket in `by_trigger`
(a held turn used to fall into `unknown`) and measures a held turn from its send, like `auto_silence`, with a note; the release to send time is the previous answer's remaining
time and is not this turn's latency. `completion.mjs` needed no code change: it reads no `send_trigger`, and each turn keeps its own window and server row; pinned by tests
(an aborted turn followed by its held turn, a failed turn without a server row, the held events inert).

Tests: `held-send.test.mjs` (new, on a shared `page-harness.mjs` whose stub gateway records every message frame the page sends, so the tests assert the wire and not only the log):
hold and send with the reply style and the speech cancel, append, frames that do not end the turn, aborted and failed ends, a closed socket (and no resurfacing on the next
connection), an empty utterance, and the turn ending while listening. Join-latency and completion got the held cases. Mutation checks: 21 mutants on `main.ts` and 6 on
`join-latency.mjs`, all caught. The Phase 1 equivalent survivor (`!listening` dropped from the guard) is now caught by the release 0 ms after a held send. Not done: the old
`mic-cancel.test.mjs` still has its own copy of the stub gateway instead of using `page-harness.mjs`.

## Reply timeout closes the socket (2026-10-05)

A bare reset of the in-flight flag after `REPLY_TIMEOUT_MS` was unsafe twice over: with no turn id a late `done` from the old turn could clear the next turn's flag, and ZeroClaw may
still be running the old turn, so a new message on the same connection would be steering. Now the timeout closes the socket (ZeroClaw then takes its cancel path), cancels speech, drops
a held message (`held_dropped { reason: "timeout" }`, hint "Message not sent, the answer timed out") and keeps `turn_timeout { ms }`, then connects once more.

Checked before building, as asked: Connect is a plain function. `connect()` reads the gateway URL, agent alias and token from the form fields (the token field holds the stored pairing
token), reuses the speech model load and makes a `WebSocket`, so an automatic reconnect is one call and needed no more than that. The one thing it did need: the four socket handlers used the
global `socket` and `replyState` without checking which socket they belonged to, so the late close of a socket that had been let go of would have reset the new connection. Each handler now
returns if its socket is no longer the current one. The status reads "Answer timed out, reconnected" once the new socket opens; if it does not open, the ordinary "disconnected" with no second
attempt, and a later manual Connect is a plain connect (the wording is taken per `connect()` call, even one that fails early).

Tests (`reply-timeout.test.mjs`, on `page-harness.mjs`, which gained a fake 60 s timer the test fires, upgrade recording, refused and delayed upgrades, close-frame detection and a record of
every `WebSocket` made): the timer exists exactly while a reply is in flight; the full timeout with a held message (event, close frame on the old socket, drop, hint); speech cancelled;
reconnect with the same agent and token; the connecting window (mic disabled); a new message on the new connection; late traffic: a `done`, a chunk and the close from the old socket via the server, and
`onmessage`, `onerror`, `onopen` and `onclose` of the old socket called by hand because Chrome drops what an old socket would deliver after `close()`; the new turn still ending by its own `done`;
a reconnect that cannot start (invalid URL); a failed reconnect (one attempt, disconnected); a later manual Connect. Mutation checks: 21 mutants. 16 were caught on the first run. Five survived: the three
stale-handler guards for `onopen`, `onmessage` and `onerror` (Chrome never delivers them, so only a hand call reaches them), `socket = null` before the reconnect (only matters when `connect()` cannot
start), and the approval reply using the global `socket`. The first four are now caught by the hand-called handlers and the invalid-URL test. The last is equivalent: a stale socket returns at the guard first, so
`sock` and `socket` are the same object whenever it runs.

Not done or open: the old socket's close is not reported as `ws_closed`, deliberately, because `completion.mjs` reads `ws_closed` as a failure signal and a late one would land in the next turn's window.
A turn that timed out is therefore seen in the eval only through `turn_timeout` and the server row. An events file spanning a timeout has two `session_start` session ids, so `join-latency.mjs` needs `--session`.
If the user is mid-utterance when the timeout fires, the button is disabled until the new socket opens (as for any closed connection), and an utterance finished before that is "Cannot send: not connected".

