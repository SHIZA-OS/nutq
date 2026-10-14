# Changelog

## Unreleased

### Added

- Two themes on one page, switched by a toggle in the header and remembered in local storage (`theme`): **ZeroClaw** (the
  default for a new visitor) and **SHIZA**. Each has its own layout, logo, colours and fonts; the tab icon follows the theme.
  The toggle is a real switch (`role="switch"`, `aria-checked`).
- The ZeroClaw theme shows a pipeline health panel and a model banner. Both are derived from the status text the page
  already shows, through one table in `src/ui/theme.ts`; text the table does not know is shown as neutral, never as an error.
- The SHIZA theme has a starry sky and a "pollen" cloud behind the mic button. The cloud is the mic button (the same click, the
  same code), turns while listening, is dimmed while the button is disabled, and follows the loudness of the microphone.
  No animation runs in the ZeroClaw theme, in a hidden tab, or under `prefers-reduced-motion` (one still frame).
- `src/main.ts` announces the microphone stream with two window events, `mic-stream` (detail `{ stream }`, right after
  `getUserMedia` succeeds) and `mic-stream-end` (listening stopped, or the start failed). The level meter is a read-only
  listener with its own audio analyser, closed on stop. Nothing else in `main.ts` changed.
- Brand assets in `public/brand/` (logos, tab icons) and the fonts Inter and Spectral (plus the Cormorant Garamond italic),
  all served from the repository. `docs/THIRD_PARTY.md` lists them; the rights for the ZeroClaw logo and the SHIZA marks are
  marked TBD there.

### Changed

- DM Sans is no longer bundled (Inter replaces it) and the Vite template favicon is gone.
- The ZeroClaw logo and SHIZA icon were reduced with svgo (path data at 3 decimals; at display size the largest colour
  difference from the original is 19 of 255), the SHIZA wordmark only lost its embedded metadata, and the PNG tab icons were
  recompressed losslessly.

### Known limitations

- The themes were checked in Chrome only.
- With the browser's local storage blocked, `src/main.ts` throws at load (`loadSavedTokenForCurrentUrl` reads it without a
  guard). This is older than the themes; the theme code itself copes with blocked storage.
- Nothing stops the microphone tracks: after listening stops the stream stays open and every start opens a new one. This
  is older than the themes and is not fixed here.
- The design's entrance animations are not built.

## 0.1.0 (2026-10-06)

First version meant for other people to clone and run. No git tag has been created for it.

The project was first named Sawt and was renamed Nutq (نطق, "utterance") because the first name collided with an existing project.

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
- The end-of-turn waits were chosen by an offline replay of 57 recordings, not tried live with a microphone in a demo; their pause
  cut rate is a result for 12 takes by one speaker (`docs/ARCHITECTURE.md`, "Why these waits").
- The speech changes (sentence batching, the first-sentence wait, dash handling, the mute after a mic tap) were checked by tests and
  measurements, not by listening. A voice that drops out mid-utterance cannot be detected from the browser's `onend`.
- A short segment the voice detector calls a misfire leaves the page recording (`isTalking` stays true); a later speech start
  then prepends no pre-roll.
- Measured results and how to read them: `docs/ARCHITECTURE.md`, "Eval tools, case sets and results".
