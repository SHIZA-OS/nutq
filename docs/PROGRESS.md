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
