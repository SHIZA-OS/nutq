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
