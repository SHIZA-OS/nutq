# Nutq

Nutq (نطق, "utterance") is a voice chat page for [ZeroClaw](https://github.com/SHIZA-OS/zeroclaw) agents. You talk, it
transcribes your speech locally in the browser (Moonshine, running as WebAssembly, no server round trip), sends the text
to your ZeroClaw agent over the gateway's `/ws/chat` WebSocket, and speaks the agent's answer back with the browser's
speech synthesis. It needs no change to ZeroClaw itself.

```
microphone -> Moonshine speech-to-text (in your browser) -> ZeroClaw /ws/chat -> browser speech synthesis -> speaker
```

## Requirements

- **A running ZeroClaw gateway** that you can reach from your browser, and its agent alias. See
  [ZeroClaw compatibility](#zeroclaw-compatibility).
- **Node.js `^20.19.0` or `>=22.12.0`** and npm (the range Vite 8 asks for; the tests here ran on Node 20.19.5).
- **A desktop browser with WebAssembly, a microphone and speech synthesis.** Tested on Linux with Chrome and Firefox.
  macOS, Windows and Safari are untested; [docs/TESTING_PLATFORMS.md](docs/TESTING_PLATFORMS.md) is a short checklist if
  you want to try one and report back.
- **A secure page for the microphone:** `http://localhost` or `https://`. The browser does not give the microphone to a
  plain `http://` page on another address.
- About 170 MB of disk for the clone (measured: 116 MB of files and a 55 MB repository history, without `node_modules`),
  because the speech model and its runtime are in the repository (see [Network access needed](#network-access-needed)).

## Quick start

```
git clone https://github.com/SHIZA-OS/nutq.git
cd nutq
npm install
npm run dev
```

Open http://localhost:5173 in Chrome or Firefox, then:

1. **Gateway URL:** the form starts with `ws://127.0.0.1:42617/ws/chat`. Change it if your gateway is elsewhere.
2. **Agent alias:** the agent to talk to, for example `default`.
3. **Pair** (below), or paste a bearer token into "Pairing token".
4. Click **Connect**. The speech model loads (about 63 MB, from this repository, only on first use; the browser keeps
   it afterwards when the web server allows caching). The status turns to "connected" and the microphone button enables.
5. Tap the microphone button and speak. Tap again to send, or just stop talking: the turn is sent after a short wait.
   The answer is spoken as it arrives. Tapping the microphone while it speaks stops it.

## Pairing

If your gateway requires pairing (`require_pairing` is on by default in ZeroClaw), get a one-time 6-digit code from it,
for example with `zeroclaw gateway get-paircode --new`. Enter the code under "Pairing" and click **Pair**. Nutq trades
the code for a long-lived bearer token through the gateway's `/pair` endpoint, stores it in your browser's local storage
for that gateway URL, and fills in the "Pairing token" field. Come back to the same gateway later and the token is
filled in again; point Nutq at a different gateway URL and the field clears, because a token only works for the gateway
it was issued by.

The 6-digit code is **not** the token that `/ws/chat` checks. If you put the code in the token field, the connection
fails with a bare `1006` close (see [Troubleshooting](#troubleshooting)).

### CORS: automatic pairing and the curl fallback

The ZeroClaw gateway sends no CORS headers, so a browser blocks the pairing request when the page and the gateway are on
different origins. Nutq cannot see the reason (browsers do not expose it), so any pairing request that fails outright is
treated the same way:

- **Same origin:** if the built page is served from the same origin as the gateway, pairing is automatic.
- **Different origins** (for example the dev server on port 5173 and a gateway on 42617): the Pairing section shows a
  ready-made command, `curl -X POST <http-base>/pair -H "X-Pairing-Code: <code>"`. Run it, paste the `zc_...` token it
  prints into the field that appears, and click **Save token**. The token is stored exactly as an automatic pairing
  would store it.

The WebSocket connection itself is not subject to CORS, so connecting works either way once you have the token.

## The defaults, and how to opt out

With no URL parameters:

- **You choose when you are done.** Tap again to send, or just stop talking: a turn is sent after a wait that depends on
  what you said (1000 ms after a finished sentence, 2200 ms when the text has no final punctuation, 2500 ms after an
  unfinished one such as "and"; see [ARCHITECTURE](docs/ARCHITECTURE.md), End of turn). The wait counts from the speech end
  the voice detector reports, which comes 768 ms after you stop, so on the 57 recordings the project is tested on the
  median wait after you stop was 1768 ms (replayed offline, not a live measurement).
- **The agent is asked for a spoken-style answer**: thorough, in short sentences, no markdown, signposted in words
  ("There are three things. First, ..."). Markup that still comes through is not read out.
- **The answer is spoken sentence by sentence as it arrives**, with the browser's default voice (add `voice=<exact name>`
  to the URL to pick another; the page logs the voice list). The first sentence waits up to 700 ms for the next one to
  join it, so the pause after it does not sound like an ending.
- **Tapping the microphone while it speaks stops it.** If you finish a question while the answer is still coming, it is
  held and sent when the answer ends (the hint under the button says so); it is not sent in the middle of a turn.

Each default has an opt-out, set in the URL:

| you want | add to the URL | what it does |
|---|---|---|
| a fixed wait instead of the text-dependent one | `?silence=<ms>` (800 to 8000) | the turn is sent that long after the speech end, whatever you said; `?silence=5000` is the old fixed default |
| short answers | `?reply=short` | the agent is asked for one or two short sentences |
| the whole answer spoken at the end | `?tts_stream=0` | nothing is spoken until the answer is complete, then all of it at once |

Combine them with `&`, for example `http://localhost:5173/?silence=3000&reply=short&tts_stream=0` gives the original
behaviour.

## Safety

Nutq always denies tool approval requests. When the agent asks to run a tool that needs approval, Nutq logs the request
and answers `deny`; there is no setting that approves one. Tools the agent is configured to run without approval are
under ZeroClaw's control, not Nutq's.

## Production build

```
npm run build      # type check, then the production build into dist/
npm run preview    # serve dist/ locally
```

`dist/` is static files; serve them from any web server, ideally the same origin as your gateway (see
[CORS](#cors-automatic-pairing-and-the-curl-fallback)) and over https if it is not on localhost. A production build
carries none of the evaluation instrumentation: `?eval=1` and the eval-only parameters do nothing there. Serve `dist/` with
normal cache headers so the browser keeps the speech model after the first visit.

## Network access needed

The only network connection Nutq needs is the one to your ZeroClaw gateway (HTTP for pairing, a WebSocket for
`/ws/chat`). Everything else is served from this repository: the speech model weights, both ONNX Runtime wasm builds, the
voice activity model and the fonts live in `public/vendor/` and `public/fonts/`, and the page requests nothing from a CDN
or a font host. Nothing is pinned to an external URL, because nothing is loaded from one. What each file is, where it came
from and its license: [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).

## ZeroClaw compatibility

Tested against the `SHIZA-OS/zeroclaw` fork at commit `46479bdca74bedb5c71e30afab657ccaac77dab4` (committed 2026-09-10; it
is on that fork's `master`). Two caveats, because the test backend was a local build:

- The checkout that commit was read from had uncommitted local changes (a diagnostic unit test in
  `crates/zeroclaw-config/src/schema.rs` and a `docker-compose.yml` that builds locally instead of pulling the image). The
  running container image was built on 2026-09-29 and which commit it was built from was not recorded: **TBD**.
- Nutq was built and checked against that one version. Other versions may work, since Nutq uses only `/pair` and the
  `/ws/chat` frames; this has not been tried.

The fork's `docker-compose.yml` pulls the image `ghcr.io/zeroclaw-labs/zeroclaw:latest`. For a container with a shell (to
`docker exec` into it for configuration and debugging), build `Dockerfile.debian` instead of the default distroless
image.

### `config.toml` needs `schema_version = 3` as its first line

If you write the gateway's `config.toml` yourself, start it with:

```toml
schema_version = 3
```

Why: in the source at the commit above, a config with no `schema_version` key is read as version 1
(`detect_version` in `crates/zeroclaw-config/src/migration.rs`), and the loader then runs the version 1 to 3 migration
chain over the file. The current version is 3 (`CURRENT_SCHEMA_VERSION`). A file already written in the current layout,
such as one with `[providers.models.anthropic.default]` sections, would be put through a chain that was written for
older layouts. It has to be a top-level key, which TOML requires to come before any `[section]` header, so the first
line is the safe place. What this does to a given file was **not tested here**, and neither was whether it is the cause
of the model field reading back as `<unset>` (next paragraph).

Known issue in that fork: a model set under `[providers.models.anthropic.<alias>]` in `config.toml` can read back as
`<unset>`. The workaround is the environment variable `ZEROCLAW_providers__models__anthropic__default__model`; details
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Troubleshooting

| you see | what to do |
|---|---|
| The connection closes at once with code `1006` | The token is wrong or missing. `/ws/chat` needs the long `zc_...` bearer token, not the 6-digit pairing code. The browser cannot show the HTTP 401 behind a failed WebSocket upgrade, so it reports a bare `1006`. |
| "Pair" fails, and a `curl` command appears | The gateway and the page are on different origins (CORS). Run the command and paste the token, see [CORS](#cors-automatic-pairing-and-the-curl-fallback). |
| "The speech model could not be loaded" and a **Try again** button | The model files did not download: a network problem, or a content blocker or proxy in the way. Fix that and click Try again. |
| "Microphone access is blocked" | Allow the microphone for this site in the browser (the icon in the address bar), then tap the button again. |
| "The microphone needs a secure page" | Open the page over `https://` or on `localhost`. |
| "No microphone was found" | Connect or enable one, then tap again. |
| Replies show as text but nothing is spoken, and a note says there is no speech synthesis | Your browser has no Web Speech synthesis. Use Chrome or Firefox. |
| You want a local voice on Linux Chrome | Chrome lists local voices (through speech-dispatcher) only when started with `--enable-speech-dispatcher`. `?voice=<exact name>` picks one; the page logs the voice list. |
| "This browser has no WebAssembly support" | Use a current desktop browser. |
| The agent never answers, or the log shows a provider error | Check the gateway, not Nutq. The ZeroClaw daemon writes almost nothing to `docker logs`; its runtime errors are in `/zeroclaw-data/.zeroclaw/data/state/runtime-trace.jsonl` inside the container. |

The log panel at the bottom of the page records pairing, connection, speech-model and error messages; look there first.

## Demo on Linux

`scripts/demo-chrome-linux.sh` opens Chrome with its own profile (`~/.nutq-demo-chrome`), which keeps the pairing token
and the browser's cached speech model between runs, apart from your everyday Chrome. Start the dev server first, then run
the script; it takes an optional URL and uses `$CHROME_BIN` (default `/usr/bin/google-chrome`). It adds nothing to the
URL: the defaults above are the settings it uses.

## Tests

`npm test` runs the suite (`node --test eval/runner/*.test.mjs`); it drives real headless Chrome pages and expects Google
Chrome at `/usr/bin/google-chrome`. Tests that need the project's recorded test audio skip themselves when it is absent.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): data flow, protocol details, end of turn, speech.
- [docs/PROGRESS.md](docs/PROGRESS.md): what was built, measured and why, in order.
- [docs/ROADMAP.md](docs/ROADMAP.md): what is next.
- [docs/eval-harness-design.md](docs/eval-harness-design.md): the evaluation harness.
- [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md): what is bundled and under which license.
- [docs/TESTING_PLATFORMS.md](docs/TESTING_PLATFORMS.md): a manual checklist for other systems.
- [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE). Bundled third-party files keep their own licenses, listed in
[docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).
