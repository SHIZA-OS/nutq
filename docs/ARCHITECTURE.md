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

**Load failure.** The status shows "model load failed", the hint says the model could not be
loaded and that a network problem or a blocked download is the usual cause, a Try again
button appears, and the mic button stays disabled. The guard is cleared, so Try again (or the
next Connect) retries. The vendored `Transcriber.load()` used to report any failure here as
`PlatformUnsupported` ("this platform is not supported"), which was misleading; it now reports
`ModelLoadFailed` (a local edit in `src/vendor/error.ts` and `transcriber.ts`). A browser
without WebAssembly gets its own message and no retry, and no load is attempted. This needed a small local edit to the
vendored `src/vendor/model.ts`: `MoonshineModel` cached its rejected load promise and left
its loading flag set, so a retry could never succeed. `loadModel()` now clears both on
failure.

**Progress.** The loader exposes none: `ort.InferenceSession.create(url)` in
`src/vendor/model.ts` takes a URL and has no progress callback, and the `Transcriber` reports
only "load started" and "model loaded". So the page shows no progress bar; while loading, the
hint says the download is about 63 MB and happens only on first use.

**Observation, not a benchmark.** While the weights still came from a CDN, a fresh browser
profile (nothing cached) took roughly 27 to 38 s to load the model (four measurements, one
machine, network not controlled), and a warm cache was faster (about 4 to 7 s). Since the
weights are served from the app's own origin, one measurement on a static preview on the same
machine (localhost) gave 6.7 s on a fresh profile and 3.1 s on the second visit, with all five
model and wasm files served from the browser cache. Whether a deployment caches them depends
on its web server's cache headers. Treat these as a sense of scale only.

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
clock; the caller passes the time). Auto-silence: 5000 ms after a speech end the turn ends with reason
`auto_silence`; a speech start cancels it and a later speech end arms it again. A VAD misfire (a segment too short to count as speech, so no speech end follows) arms it the same way a
speech end does, so a short word like "Yes." or "Stop" is sent without a manual stop; a later speech start still
clears it, and recording is untouched. A transcript that is empty or only whitespace
is not sent to the gateway (`send_skipped` event). **The default wait depends on the transcript**; `?silence=<ms>` opts out to a fixed wait that ignores
the text (any mode, clamped to 800..8000; a value that is not a number is 5000, the fixed default before the semantic one became the default, so `?silence=5000`
reproduces the old behaviour exactly; an empty `?silence=` counts as absent). The old `?endpoint=semantic` is no longer read: it is the default, so a URL that
still carries it behaves the same. `endHint` reads the text so far as `done` (ends in `. ? !`), `open` (ends in
`...`, `,`, `;`, `:` or `-`, or its last word is a conjunction, article, preposition or filler, even after a full
stop: "a flight and." is open; digits are words) or `unknown`, and each hint has its own wait, clamped to a floor and
ceiling. With no text yet the wait is the `unknown` one, and it is held at least there while a commit is in flight. Text
that arrives while the wait runs recomputes it and re-arms the timer. `SEMANTIC_WAITS` (`src/turn-policy.ts`) is the Conservative point of the replay sweep
(`eval/results/2026-10-05-endpoint-sweep`): done 1000 ms, unknown 2200 ms, open 2500 ms, floor 0, ceiling 8000, with the tier 1 open list only. A
manual stop ends the turn at once with reason `manual`; once ended, a turn stays ended. `main.ts` drives it with
`Date.now()` and one `setTimeout`, and the reason becomes the `trigger` of `transcript_final` and
`ws_message_sent`. The offline replay (`replay-commits.mjs`) drives the same module with time taken from frame
positions.

## Mic press right after listening ends

A press that would start listening is ignored from the moment listening ends (a manual release or the `auto_silence` trigger) until
`MIC_REARM_MS` (`src/turn-state.ts`, 400 ms) after the send: no listening, no mute, no speech cancel, and
`mic_press_ignored { reason: "rearm", phase, since_release_ms, since_send_ms }` is logged. The window has two phases:

- `finishing`: from the end of listening until `finishListening()` is done. `stop()` runs the final transcription in this gap (up to about
  500 ms live); a press there used to start a second utterance and the message was sent with listening true again. `since_send_ms` is `null`
  here, because this utterance has not been sent.
- `after_send`: from the send until `MIC_REARM_MS` later. Without it a double tap after a send started a new utterance, muted the whole reply
  (`tts_muted`) and sent nothing (`send_skipped`), so the user lost the answer. Both fields are set.

If the turn ends without a send (`send_skipped`, a refused send, or a `stop()` that throws) the window closes at that point, so the user can retry
at once; it never runs to `MIC_REARM_MS` after a release that sent nothing. A press after the window behaves as before (listens, mutes the reply,
cancels speech). Only a press that would start listening is guarded: a press while listening is the release and is never ignored. The button does
not look disabled during the window, because a disabled button swallows the click and the event could not be logged. 400 ms is a judgement, not
measured.

## One turn at a time: hold and send

The gateway has no per-turn id, and a message sent while a turn is still running is not a new turn: ZeroClaw treats it as steering and merges it into the
running turn (see `src/turn-state.ts`). So nothing is sent while a reply is in flight. `ReplyState.trySend()` sets the flag when a message goes out; the
frames that end a turn clear it: `done`, `aborted`, and an `error` with a turn-failure code (`PROVIDER_ERROR`, `AUTH_ERROR`, `AGENT_ERROR`), and so does a closed
socket. The only place a message frame is sent is `sendTranscript()`, behind `trySend()`; the one other `socket.send` is the auto-deny `approval_response`,
which is not a message.

An utterance that finishes while a reply is in flight (the user tapped the mic during the answer) is **held**, not dropped:

- A non-empty utterance is held and `send_held { chars }` is logged, with the hint "Will send when the answer finishes" under the mic button. `chars` is the length
  of the whole held message so far. An empty utterance is still `send_skipped`.
- There is at most one held message. A later utterance is appended to it with a space, and `send_held` is logged again with the new total.
- When a turn ends with `done`, `aborted` or a turn-failure error, `sendHeld()` sends the held message through `sendTranscript()` (same reply style, same
  speech cancel, `send_trigger: "held"` on `ws_message_sent`) and logs `held_sent { chars, waited_ms, end }` just before it. `waited_ms` counts from when the
  first part was held; `end` is `done`, `aborted` or `error`. It runs at the end of the frame handler, so the ending frame's own events (`done_received`, the
  reply shown, `tts_muted`) belong to the turn that ended and not to the one just sent. A frame that does not end the turn (chunk, thinking, tool frames, a
  non-turn `error` code) sends nothing.
- If the user has the mic open again at that moment (`listening` is true), the new answer is muted (`ReplyState.mute()`, the same as a tap during a reply), so it is not read out over the
  open mic; what they say next is held for that answer in turn.
- If the socket closes with a message held, it is dropped: `held_dropped { reason: "closed", chars }`, a log line, and the hint "Message not sent, the connection
  closed" until the next connection opens. It is not sent on a later connection.

The utterance's own trigger (`manual` or `auto_silence`) is not kept on a held send; `send_trigger` is `held`.

**Reply timeout.** If no frame ends the turn within `REPLY_TIMEOUT_MS` (60 s), the page gives up on the connection, not only on the flag. A late `done` after a bare
flag reset could clear the next turn's flag (there is no turn id), and ZeroClaw may still be running the old turn, so any new message on the same connection
would be steering. On the timeout (`replyTimedOut()` in `src/main.ts`): `turn_timeout { ms }` is logged as before, speech is cancelled, a held message is dropped
(`held_dropped { reason: "timeout", chars }` and the hint "Message not sent, the answer timed out", which stays until the next mic press), the socket is closed
(ZeroClaw then takes its cancel path) and `connect()` is called once. `connect()` is a plain function: it reads the gateway URL, agent alias and token from the same
form fields (the token field already holds the stored pairing token) and the speech model load is reused, so the reconnect needs nothing else. The status reads
"Answer timed out, reconnected" once the new socket opens; if it does not open, the status is the ordinary "disconnected", with no second attempt. A later manual
Connect is a plain connect. Until the new socket opens the mic is disabled, as for any closed connection.

Every socket handler (`onopen`, `onmessage`, `onerror`, `onclose`) first checks that its socket is still the current one and returns if not. The old socket is
let go of before the new one is made, and its close (and anything it still delivers) arrives later; without the check that close would reset the new
connection's status, in-flight flag and speech. The new connection starts a new session, so an events file that spans a timeout has two `session_start`
session ids, and `join-latency.mjs` then needs `--session` to pick one.

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
  log panel (at most 40 lines, with local and network counts) so a name can be copied from it. With no name, or a
  name that matches nothing (which is logged), the browser's default voice is used, and the utterance asks for `en-US`
  (`lang`) so the browser does not pick by the system language; which voice it then picks is not observable from the page,
  so the `voice` field of `tts_start` stays a best guess (the voice flagged default). Choosing a local voice
  automatically was tried and removed: local espeak-ng voices started in about 60 ms but sounded too robotic for the
  demo. On Linux, Chrome lists local voices (speech-dispatcher) only when started with `--enable-speech-dispatcher`.
- Sentence streaming (any mode, **on by default**; `?tts_stream=0` opts out to the original flow, the whole reply spoken once at `done`; any other value, such as
  the old `?tts_stream=1`, is the default): speak the reply sentence by sentence as its chunks arrive instead of
  once at `done`. Chunk deltas go through `src/sentence-splitter.ts`, closed sentences are queued in
  `src/speech-queue.ts` and spoken, one utterance at a time (see "Coalescing" below), by the engine in `src/tts-engine.ts` (the browser's Web Speech, the
  only engine), and the tail is flushed at `done`. The speech comes from the chunks, not `full_response` (unless no sentence was queued by `done`, when `full_response`
  is spoken once, trimmed, through the same queue); the queue
  is cancelled on aborted, a turn-failure error, a closed socket, the reply timeout and a new send. Only `chunk`
  frames are spoken, never `thinking`, `tool_call` or `plan`. A `tool_call` frame drops speech that has not been heard (see "Tool calls" below).
- Reply style (any mode, **default `voice`**; `?reply=short` opts out): which prefix goes in front of every message sent to the agent
  (`src/speech-text.ts`). `voice` asks for a thorough, complete answer written as speech: no markdown or dashes, short sentences, no URLs,
  and the structure carried by spoken signposts ("There are three things. First, ..."). `short` is the original, "1-2 short, complete sentences", kept byte for byte
  (a test pins it) so earlier eval runs can be repeated. Anything but exactly `short` is `voice` (so `?reply=SHORT` is `voice`).
  `ws_message_sent` records `reply_style`.

**Coalescing (sentence streaming).** Each utterance pays the voice's start delay again, about 0.85 s between two utterances with the browser's
default voice (see the experiment in PROGRESS). So every utterance is all the units that have arrived by the time the previous one ends, in order,
joined with a space, broken at unit boundaries and capped at `MAX_UTTERANCE_CHARS` (1200, join spaces included). The first utterance of a turn used
to be the first unit alone, and the 0.85 s gap after one sentence then sounded like an ending before speech resumed. So it **waits** up to
`FIRST_UTTERANCE_WAIT_MS` (700) after its first unit is ready, collecting the units that arrive meanwhile (same cap, same unit boundaries), and
speaks at once when `done` arrives first (`finish()`) or when the batch is full (a unit would not fit, or it is exactly the cap). 700 is a judgement,
not measured: about the voice's start delay. The cost is up to 700 ms more before the first audio of every reply, which has not been listened to or
measured with the change in. Only the turn's first utterance waits: once audio has started nothing is held back. A tool call during the wait drops
the collected units (`tts_dropped`; nothing was with the browser, so nothing is cancelled) and the next unit starts a new wait; a cancel ends it. The
queue takes its timers as an option (and `firstWaitMs`, 0 turns the wait off), so a test drives it with a fake clock. A unit longer than the cap is spoken alone,
not split. `tts_requested` stays per unit and `speech_text` stays per unit (logged before merging); `tts_end`, `tts_cancelled` and
`tts_error` are per utterance; `tts_sentence_start { index, units, chars, waited_ms }` is per utterance, with `index` the first unit's; `waited_ms` is only on the
utterance that waited (index 0 of a turn), the time from its first unit being ready to its being handed to the browser. A cancel
(mic tap, abort, close, timeout, new send) stops the utterance in progress whole and drops what waits, as before. An engine error
loses every unit of that utterance. The `full_response` fallback is one unit, so it plays alone and is not split. Queueing the next
utterance ahead in the browser was measured and did not shorten the gap, so it is not done. The 1200 is a judgement, not a measured
threshold (see PROGRESS).

**Tool calls (sentence streaming).** The agent can stream text before a tool call, and that text is not in `full_response`, which holds only the
last iteration. Chunks arrive before the `tool_call` frame, so some of it may already be audible; what has not been heard is dropped. On a
`tool_call` frame `dropUnheardSpeech` (`main.ts`) discards the text the splitter holds (`pendingChars`, also resetting the open-code-fence
state), and `SpeechQueue.drop()` removes every queued unit and the utterance with the engine if its audio has not started (the engine is told to
cancel it, and its late callbacks are ignored). An utterance that is audible plays to its end and is not cancelled. Chunks after the call are
spoken as usual, numbering goes on, and each further tool call repeats the drop. `tts_dropped { reason: "tool_call", units, chars, partial_chars }`
is logged only when something was dropped (`units` and `chars` count the dropped units' own text, without join spaces; `partial_chars` the splitter
text). The done fallback asks `SpeechQueue.fresh`, the units queued since the last tool call, instead of the turn's total: if nothing was queued
after the last call (all of it dropped, or only audible text from before it), `full_response` is spoken once, because the final answer was not
streamed. A turn with no tool call behaves as before. A muted turn has nothing queued or buffered, so a tool call in it does nothing and cannot unmute.
With the flag off nothing changes. `tts_text_mismatch` is not changed: its chunk total still includes the text before a tool call, so it can be
reported for any turn that used a tool.

**Speech text.** Whatever the prefix, the agent may still send markdown, so every text handed to the voice goes through
`speakable()` (`src/speech-text.ts`, pure): fenced code blocks are not read, inline code, bold and italic lose their markers,
a link keeps its label, bare URLs and emoji are dropped, heading, bullet and number markers go, a table row becomes
comma-separated words, and `. , ? ! : ;` are kept because they shape the pauses. An em or en dash, spaced or not, becomes a comma
pause (", ") without doubling punctuation that is already next to it, and a dash at the start or end of a line is dropped;
a dash between two numbers is a range and is read as "to" ("10 to 20", "5 to 7"). A dash with a number on one side only (a price range with a dollar sign on both sides, say) gets the comma. A hyphen is never touched, so hyphenated words stay whole. Each line gets its own full stop unless it
already ends in punctuation, so list items are separate sentences. It is applied on all paths: `speak()` (flag off), each
streamed unit and the tail (`queueSpeech` in `main.ts`), and the `full_response` fallback. The transcript card keeps the original text
(`textContent`, no markdown rendering, so reply text is never parsed as HTML). With streaming, the splitter closes a unit at a
newline as well as at `. ? !`, so unpunctuated list items are separate; short lines are still merged but keep their line break.
Markers cut across chunks never reach the cleaner half-formed, because only closed units are cleaned; a code fence that spans
several units is carried by the caller (`speechInCode`). A unit that cleans to nothing is not queued. Not handled: symbols such as
`->`, nested emphasis across lines, and a reply hard-wrapped inside a sentence (it would be spoken as two utterances; the replies
probed so far were not wrapped).
- `?model=<path>` (eval only, default `model/base`): picks the Moonshine model. The value
  must contain `tiny` or `base`, otherwise an error is shown and the mic stays disabled.

Events added for WER measurement:

- `stt_model` `{ model }`: logged once at page load.
- `stt_committed` `{ text }`: each committed piece, with its text, in eval mode.
- `endpoint` `{ hint, wait_ms, text_chars, commits_in_flight }`: only with the semantic wait (the default; not with `?silence=<ms>`), while a wait is running: when it is armed (speech end or
  misfire) and each time the committed text or the in-flight commit count changes it. `hint` is `done`, `open` or `unknown`, `wait_ms` the wait now in force.
- `pre_roll` `{ frames }`: logged right after each `speech_start` in eval mode. `frames` is
  how many pre-roll frames were actually prepended (4 normally, 0 when speech restarts while
  the buffer already holds frames, for example after a misfire).
- `stt_error` `{ path, message }`: a model call failed and the error was caught (always logged, not
  only in eval mode). A failed commit loses that piece of text.
- `stt_model_call` `{ path, samples, audio_hash, wait_ms, run_ms, skipped }`: one per model call,
  eval mode only (see "Model calls are serialized").
- `tts_start` `{ voice, local_service, voice_source, engine }`: the reply started to be spoken (with sentence streaming, its first utterance). `voice_source` is `param`
  (chosen with `?voice=`) or `browser_default`, where `voice` is the voice the browser flags as default, a best
  guess because Chrome does not say which voice it picked; both are null if no voices were available.
- `speech_text` `{ raw_chars, spoken_chars }`: one per text handed to the voice (the whole reply with the flag off, each streamed
  unit, the `full_response` fallback), before and after `speakable()`; 0 spoken means the unit was dropped. No text is logged.
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
