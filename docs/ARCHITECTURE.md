# Architecture

## Data flow

Nutq's pipeline runs almost entirely on the client. Audio never leaves the browser for
transcription, and only text crosses the network:

1. **Mic capture.** The browser captures microphone audio directly.
2. **Moonshine STT (local, WASM).** The captured audio is transcribed in-browser by
   Moonshine, running as WebAssembly. There is no server round-trip for speech-to-text; the
   transcript is produced entirely client-side.
3. **`/ws/chat` WebSocket.** The transcript is sent as a message to ZeroClaw's `/ws/chat`
   endpoint (protocol details below), and the agent's reply streams back over the same
   socket.
4. **Web Speech API TTS.** The agent's reply is spoken back to the user using the browser's
   built-in Web Speech API. This is a placeholder, not the intended long-term TTS; see
   [ROADMAP.md](ROADMAP.md) for the plan to replace it with Piper.

## Model load order and mic gating

The Moonshine model and the VAD must both be loaded before the mic opens. Audio that
arrives earlier is dropped, not buffered: the vendored `Transcriber` only connects the mic
stream to the VAD at the end of `load()`, so anything spoken during a load is lost. Nutq
therefore loads first and opens the mic second:

1. **Load starts** (trigger depends on mode, below). `ensureModelLoaded()` in
   `src/main.ts` calls `transcriber.load()` once. A `loadPromise` guard reuses an in-flight
   or finished load, so a second trigger never loads twice.
2. **Mic button stays disabled** until the model is ready AND the socket is open (or
   nosend eval mode is on). The status reads "loading model…" and the hint says so.
3. **On click**, `getUserMedia` and `attachStream` run, then `start()`. Because the load
   already finished, `start()` does not load again.

**When loading starts.**

- Normal mode: when Connect is clicked, in parallel with the connection. Before that the
  hint reads "Connect to load the speech model".
- Eval mode (`?eval=1`): at page load, honoring `?model=`.

**Load failure.** The status shows "model load failed" and the button stays disabled. The
guard is cleared, so the next Connect retries. This needed a small local edit to the
vendored `src/vendor/model.ts`: `MoonshineModel` cached its rejected load promise and left
its loading flag set, so a retry could never succeed. `loadModel()` now clears both on
failure.

**Observation, not a benchmark.** On a fresh browser profile (nothing cached), the model
load took roughly 27 to 38 s in the runs made while building this (four measurements, one
machine, network not controlled). A warm cache was faster (about 4 to 7 s in earlier
runs). Treat these as a sense of scale only.

## Speech start and pre-roll

Nutq runs the vendored `Transcriber` in streaming mode (`useVAD=false`). Audio reaches it as
frames of 512 samples at 16 kHz, i.e. 32 ms each, and the Silero VAD (vad-web 0.0.24, v5)
scores every frame. Settings in `src/main.ts`: `positiveSpeechThreshold` 0.65,
`minSpeechFrames` 12, and vad-web's defaults for the rest (`negativeSpeechThreshold` 0.35,
`redemptionFrames` 24).

- **Speech start** fires on the first frame whose probability is at or above
  `positiveSpeechThreshold`. `minSpeechFrames` does not delay it. It only decides, when the
  segment ends, whether vad-web reports `onSpeechEnd` or a misfire.
- **The trigger frame was never recorded.** `onFrameProcessed` runs before `onSpeechStart`
  for the same frame, so the frame that crosses the threshold arrives while `isTalking` is
  still false. Recording used to begin with the frame after it, which lost the first 32 to
  64 ms of every utterance.
- **Pre-roll** (`src/vendor/pre-roll.ts`) fixes that inside the one buffer the Transcriber
  already commits from. While `isTalking` is false, every frame goes into a small ring,
  including the trigger frame. On each speech start the ring is prepended to `speechBuffer`
  and emptied. It is also cleared in `start()`, because the VAD is paused between sessions
  and the ring would hold stale audio. Because frames recorded while talking never enter the
  ring, it cannot repeat audio that is already in `speechBuffer` or already committed, and it
  returns nothing if `speechBuffer` already has frames.
- **Length.** `PRE_ROLL_FRAMES` in `src/main.ts` is 4 frames (128 ms): the trigger frame plus
  three earlier ones. It is a first pass and not calibrated. `eval/runner/vad-onset.mjs` on
  the 37 recorded cases needed 2 frames to reach the 600 RMS energy onset (3 in the worst
  clean case), so 4 leaves one frame of margin for soft onsets.
- **The pause gate counts recorded frames only.** A pause-EMA commit needs 64 frames
  (`STREAM_COMMIT_MIN_INTERVAL`) and an EMA at or under 0.5. Prepended pre-roll frames do not
  count toward those 64: `SpeechBuffer.prepend()` remembers how many frames are pre-roll, and
  the gate uses `frameCount` minus that. They do count toward the 128 frame cap
  (`STREAM_COMMIT_MAX_INTERVAL`), since they occupy the buffer. Counting them used to open the
  gate 4 frames early, which in pw-04 moved a commit onto an in-word probability dip.
- It does not use vad-web's own `preSpeechPadFrames` (default 3 for v5) or the `floatArray`
  that `onSpeechEnd` returns. That audio only comes back through `onSpeechEnd`, which the
  Transcriber does not use for the recording, and an attempt to use it was reverted because
  vad-web's segment tracking and `speechBuffer` are separate, unsynchronized buffers (see the
  KNOWN ISSUE comment in `src/vendor/transcriber.ts`).

**One guard for every commit path.** The STT encoder is three convolutions without padding
(kernel 127 stride 64, kernel 7 stride 3, kernel 3 stride 2) and rejects audio under 895
samples; measured on model/base, 894 throws and 895 runs. The tiny model was not measured.
`Transcriber.commit()` in `src/vendor/transcriber.ts` is the single function the pause, cap,
`onSpeechEnd` and `stop()` commit paths go through. Under `MIN_ENCODER_SAMPLES` (895) it skips
the model call, so a short or empty buffer never throws and anything already committed stands.
Streaming updates always carry at least 16 frames. This fixed the `Invalid input shape` error
that `stop()` threw once on a 1 frame tail after a flush (`pre-roll-r2`, sh-01), which had
skipped `transcript_final`.

**Model calls are serialized.** The wasm runtime throws `Session already started` to a model call
made while another is running, and the Transcriber used to make calls with no coordination
(`onSpeechEnd` had no catch, so the error surfaced as `js_error`; a collided commit would have
lost its text with only a console line). Now every call goes through `Transcriber.enqueue()`, one
at a time on a promise chain:

- A commit is queued behind everything before it and never dropped. Its audio is a copy taken, and
  the speech buffer flushed, at the moment the commit fires (synchronously, before anything is
  queued), so a commit carries exactly the frames it had then, and frames that arrive while it
  waits go into the next commit. Committed text arrives in buffer order.
- A streaming update (a view of the live buffer, for the live caption only) is skipped, not queued,
  when anything is in flight, so previews never delay commits.
- `stop()` waits for every queued call before it returns, so `transcript_final` follows the last
  commit. A call that fails is caught, logged, reported through `onModelError` and does not stop
  the later ones.
- `onModelCall` reports every call: `path` (`update`, `commit`, `speech_end`, `stop`), `samples`,
  `audio_hash`, `wait_ms` (enqueue to start), `run_ms` and `skipped` (a commit under the encoder
  minimum, or an update dropped because the model was busy). `audio_hash` is FNV-1a over the audio
  quantized to int16 (`audioHash()`), computed just before the run.

In the runs made so far queueing was rare: in the three `ab-B` runs 5 of 303 non-update calls
waited more than 10 ms (longest 86 ms), and no update was skipped; in `serial-model-2` an
`onSpeechEnd` call once waited 123 ms. That is consistent with the model run blocking the main
thread, so that frames are only processed between runs and a call rarely finds the model busy. That
is an inference, not tested.

**Known and open.** A segment with fewer than `minSpeechFrames` speech frames is a misfire.
`onVADMisfire` only logs: `isTalking` stays true and `speechBuffer` keeps recording, so a
later speech start finds frames already in the buffer and pre-roll correctly prepends 0.

## End of turn

`src/turn-policy.ts` decides when a listening turn ends and why, as a pure module (no timers, no DOM, no
clock; the caller passes the time). Auto-silence: 1200 ms after a speech end the turn ends with reason
`auto_silence`; a speech start cancels it and a later speech end arms it again. A VAD misfire (a segment too short to count as speech, so no speech end follows) arms it the same way a
speech end does, so a short word like "Yes." or "Stop" is sent without a manual stop; a later speech start still
clears it, and recording is untouched. The delay is 1200 ms by default (it was 5000 ms until the demo defaults; a pause longer than 1.2 s now ends the turn) and can be set with `?silence=<ms>` in any
mode (clamped to 800..8000; absent or not a number is the default). A transcript that is empty or only whitespace
is not sent to the gateway (`send_skipped` event). A
manual stop ends the turn at once with reason `manual`; once ended, a turn stays ended. `main.ts` drives it with
`Date.now()` and one `setTimeout`, and the reason becomes the `trigger` of `transcript_final` and
`ws_message_sent`. The offline replay (`replay-commits.mjs`) drives the same module with time taken from frame
positions.

## Eval mode: WER replay

`?eval=1` turns on eval instrumentation (a download button for the events as JSONL).
Two extra parameters exist for replaying recorded audio without touching ZeroClaw:

- `?eval=1&nosend=1`: enables the mic button without a gateway and skips the send, so a
  run never reaches ZeroClaw. It has no effect without `eval=1`.
- `?rawmic=1` (eval only): opens the mic with echo cancellation, noise suppression and auto gain
  all off (`src/mic-constraints.ts`), to test whether Chrome's processing is a source of run-to-run
  differences in the audio. It has no effect without `eval=1`. A `mic_settings` event records what
  Chrome actually applied.
- `?voice=<exact name>` (any mode): the speech synthesis voice for replies, matched ignoring case. Voices are read
  at page load and on every `voiceschanged` (Chrome fills the list asynchronously), and the list is written to the
  log panel (at most 40 lines, with local and network counts) so a name can be copied from it. An unknown name is
  logged and the browser default is used. On Linux Chrome only lists local voices (speech-dispatcher) when started
  with `--enable-speech-dispatcher`.
- `?model=<path>` (eval only, default `model/base`): picks the Moonshine model. The value
  must contain `tiny` or `base`, otherwise an error is shown and the mic stays disabled.

Events added for WER measurement:

- `stt_model` `{ model }`: logged once at page load.
- `stt_committed` `{ text }`: each committed piece, with its text, in eval mode.
- `pre_roll` `{ frames }`: logged right after each `speech_start` in eval mode. `frames` is
  how many pre-roll frames were actually prepended (4 normally, 0 when speech restarts while
  the buffer already holds frames, for example after a misfire).
- `stt_error` `{ path, message }`: a model call failed and the error was caught (always logged, not
  only in eval mode). A failed commit loses that piece of text.
- `stt_model_call` `{ path, samples, audio_hash, wait_ms, run_ms, skipped }`: one per model call,
  eval mode only (see "Model calls are serialized").
- `tts_start` `{ voice, local_service, voice_source }`: the reply started to be spoken. `voice_source` is `param`
  (chosen with `?voice=`) or `browser_default`, where `voice` is the voice the browser flags as default, a best
  guess because Chrome does not say which voice it picked; both are null if no voices were available.
- `transcript_final` `{ text, trigger }`: the accumulated transcript at the end of a turn,
  logged before any send. `trigger` is `manual` or `auto_silence`. It is logged even when
  the text is empty, so a total miss counts as data.

Runner note: wait for the mic button to enable (status "ready") before starting audio. With
Chrome's `--use-file-for-fake-audio-capture=<wav>%noloop`, the file plays once from the
moment the mic opens, and the mic now opens only after the load.

## The `/ws/chat` protocol

This is ZeroClaw's real, observed WebSocket protocol for chat, not a synthesized spec.

**Connecting.** The client opens a WebSocket to `/ws/chat` with two query parameters:

```
/ws/chat?agent=<alias>&token=<bearer>
```

- `agent` is the ZeroClaw agent alias to talk to.
- `token` is a bearer token. See the pairing gotcha below for what value actually belongs
  here.

**Client → server.** Once connected, the client sends a JSON message to talk to the agent:

```json
{"type": "message", "content": "..."}
```

**Server → client.** The server sends a sequence of typed JSON messages over the life of a
turn:

- `session_start`: a new session has begun.
- `connected`: the connection/handshake is established.
- `chunk`: a piece of the agent's streamed reply.
- `done`: the reply is complete.
- `aborted`: the turn was aborted.
- `error`: something went wrong server-side.

## Gotcha: pairing code vs. bearer token

ZeroClaw's pairing flow produces a 6-digit one-time code from `get-paircode`. This code is
**not** the same thing as the bearer token that `/ws/chat` actually checks, which is a
long-lived `zc_<64 hex chars>` value.

If you pass the 6-digit pairing code as the `token` query parameter instead of the real
`zc_...` bearer token, the WebSocket handshake fails, but not with a helpful error. The
browser reports it as an opaque WebSocket close with `code=1006`. Under the hood this is
actually an HTTP 401 from the server, but the browser's WebSocket API does not surface HTTP
status codes on a failed upgrade, so it degrades to a generic abnormal-closure code. If you
hit a `1006` close on `/ws/chat`, check the token first before assuming a network or server
problem.

Separately: `require_pairing` defaults to `true` when unset in `config.toml`. If pairing
looks like it's being enforced and you didn't explicitly set the option, that's why.

## Known zeroclaw fork bug: model field reads as `<unset>`

In the SHIZA-OS/zeroclaw fork used as the local test backend, setting the model under
`[providers.models.anthropic.<alias>]` in `config.toml` does not work as expected: the value
is written to the file correctly, but the daemon's own config reader reports it back as
`<unset>` when queried (e.g. via `zeroclaw config get`). This looks like a config-parsing bug
in how that specific field is read, not a problem with how it's written.

**Workaround:** set the model via the `ZEROCLAW_providers__models__anthropic__default__model`
environment variable instead of (or in addition to) the `config.toml` field. This is the same
env-var override mechanism that already works correctly for `api_key`, so it's a known-good
path. See [ROADMAP.md](ROADMAP.md) for the plan to fix the underlying parser bug rather than
rely on the env var indefinitely.

## Debugging: the daemon is silent on stdout

The zeroclaw daemon logs essentially nothing useful to stdout or `docker logs` beyond its
startup banner. Real runtime errors, including the ones that matter for debugging `/ws/chat`
and pairing issues, only show up in:

```
/zeroclaw-data/.zeroclaw/data/state/runtime-trace.jsonl
```

This is a JSONL (newline-delimited JSON) file. When something is failing and `docker logs`
looks clean, check this file next rather than assuming the failure is client-side.

## Local test backend

The local test backend is the `SHIZA-OS/zeroclaw` fork. It must be built using
`Dockerfile.debian`, not the default distroless Dockerfile: the distroless image has no shell
binary in it, which breaks the workflows used for debugging and config inspection (e.g.
`docker exec` into a shell).

Current provider configuration: `anthropic.default`, model `claude-haiku-4-5-20251001`.
