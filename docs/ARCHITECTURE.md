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

## Eval mode: WER replay

`?eval=1` turns on eval instrumentation (a download button for the events as JSONL).
Two extra parameters exist for replaying recorded audio without touching ZeroClaw:

- `?eval=1&nosend=1`: enables the mic button without a gateway and skips the send, so a
  run never reaches ZeroClaw. It has no effect without `eval=1`.
- `?model=<path>` (eval only, default `model/base`): picks the Moonshine model. The value
  must contain `tiny` or `base`, otherwise an error is shown and the mic stays disabled.

Events added for WER measurement:

- `stt_model` `{ model }`: logged once at page load.
- `stt_committed` `{ text }`: each committed piece, with its text, in eval mode.
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

- `session_start` — a new session has begun.
- `connected` — the connection/handshake is established.
- `chunk` — a piece of the agent's streamed reply.
- `done` — the reply is complete.
- `aborted` — the turn was aborted.
- `error` — something went wrong server-side.

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
