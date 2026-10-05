# Changelog

## 0.1.0 (2026-10-06)

First version meant for other people to clone and run. No git tag has been created for it.

### What it does

- Voice chat with a ZeroClaw agent in the browser: microphone, local speech-to-text (Moonshine base, WebAssembly, with a
  Silero voice activity detector), the text sent over the gateway's `/ws/chat`, and the answer spoken with the browser's
  speech synthesis.
- Pairing with the gateway's `/pair` endpoint (automatic on the same origin, a `curl` fallback otherwise), with the token kept
  per gateway URL in local storage.
- End of turn: a wait that depends on what was said (default), or a fixed one with `?silence=<ms>`. A question finished while
  an answer is still coming is held and sent when the answer ends.
- The agent is asked for a spoken-style answer (`?reply=short` for one or two short sentences); the answer is spoken sentence by
  sentence as it arrives (`?tts_stream=0` to speak it all at the end). Tapping the microphone while it speaks stops it.
- Tool approval requests are always denied.
- Everything the page needs is served from the repository: the speech model, both ONNX Runtime wasm builds, the voice
  activity model and the fonts. Nothing is loaded from a CDN. Licenses: `docs/THIRD_PARTY.md`.
- A production build (`npm run build`) that carries none of the evaluation instrumentation, and none of the unused 26 MB
  ONNX Runtime wasm that the bundler would otherwise copy into `dist/` (about 96 MB instead of 122 MB, nearly all of it the
  bundled speech model and runtimes).
- Messages for a model that fails to load (with a retry), a blocked or missing microphone, a page without access to the
  microphone, and a browser without speech synthesis or WebAssembly.
- An evaluation harness (word error rate on recorded cases, end-of-turn replay, latency measurements); see
  `docs/eval-harness-design.md` and `docs/PROGRESS.md`.

### Build and tooling

- Dependencies are what the code imports: `@moonshine-ai/moonshine-js` (which nothing imports) is gone, and
  `@ricky0123/vad-web`, `onnxruntime-web` (1.27.0) and `llama-tokenizer-js` (1.2.2) are direct dependencies. The built
  JavaScript is unchanged.
- The tests and eval drivers launch the Chrome named by `CHROME_BIN`, falling back to `/usr/bin/google-chrome`.
- The recorded test audio has no default location: the eval drivers take `--audio-dir` or `EVAL_AUDIO_DIR` and stop with a
  message when neither is set; the tests that need it skip themselves. No committed file names a personal path.
- `docs/ROADMAP.md` is a short public roadmap of the open items.

### Known limitations

- Tested on Linux with Chrome and Firefox only. macOS, Windows and Safari are untested (`docs/TESTING_PLATFORMS.md`).
- Tested against one ZeroClaw version (see the README). The ZeroClaw `config.toml` needs `schema_version = 3`.
- The speech model load shows no progress bar: the loader exposes none.
- The browser's speech synthesis is a placeholder for a better voice engine (`docs/ROADMAP.md`).
- Moonshine's upstream source repository has been archived (`docs/ROADMAP.md`).
- Listening is tap to start and tap to stop; there is no continuous listening and no barge-in by voice.
- The recorded test audio the evaluation drivers need is not in the repository; record your own with `eval/wer/record.sh`.
