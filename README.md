# nutq
Nutq (نطق, 'utterance'): a client-side voice agent widget for ZeroClaw. Works with any ZeroClaw instance, no core changes required.

## Install

Nutq is distributed as source only, clone it directly:

```
git clone https://github.com/SHIZA-OS/nutq.git
cd nutq
npm install
npm run dev
```

Requires Node.js and npm. Point nutq at your own ZeroClaw instance by filling in the gateway
URL, agent alias, and pairing token in the app.

## How it behaves by default

Open the page, connect, and tap the microphone button. With no URL parameters:

- **You choose when you are done.** Tap again to send, or just stop talking: a turn is sent after a wait that depends on
  what you said (1000 ms after a finished sentence, 2200 ms when the text has no final punctuation, 2500 ms after an
  unfinished one such as "and"; see ARCHITECTURE, End of turn). The wait counts from the speech end the voice detector
  reports, which comes 768 ms after you stop, so on the recordings the median wait after you stop was 1768 ms
  (the 57 recordings the project is tested on, replayed offline; not a live measurement).
- **The agent is asked for a spoken-style answer**: thorough, in short sentences, no markdown, signposted in words
  ("There are three things. First, ..."). Markup that still comes through is not read out.
- **The answer is spoken sentence by sentence as it arrives**, with the browser's default voice (add `voice=<exact name>`
  to the URL to pick another; the page logs the voice list). The first sentence waits up to 700 ms for the next one to
  join it, so the pause after it does not sound like an ending.
- **Tapping the microphone while it speaks stops it.** If you finish a question while the answer is still coming, it
  is held and sent when the answer ends (the hint under the button says so); it is not sent in the middle of a turn.

Each default has an opt-out, set in the URL:

| you want | add to the URL | what it does |
|---|---|---|
| a fixed wait instead of the text-dependent one | `?silence=<ms>` (800 to 8000) | the turn is sent that long after the speech end, whatever you said; `?silence=5000` is the old fixed default |
| short answers | `?reply=short` | the agent is asked for one or two short sentences |
| the whole answer spoken at the end | `?tts_stream=0` | nothing is spoken until the answer is complete, then all of it at once |

Combine them with `&`, for example `http://localhost:5173/?silence=3000&reply=short&tts_stream=0` gives the original behaviour.

## Network access needed

The only network connection Nutq needs is the one to your ZeroClaw gateway (HTTP for pairing, a WebSocket for `/ws/chat`).
Everything else is served from this repository: the speech model weights, both ONNX Runtime wasm builds, the voice
activity model and the fonts live in `public/vendor/` and `public/fonts/`, and the page requests nothing from a CDN or
from a font host. Nothing is pinned to an external URL, because nothing is loaded from one. What each file is, where
it came from and its license: [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).

## Demo on Linux

The demo script opens Chrome with its own profile (`~/.nutq-demo-chrome`). That gives a clean window and keeps the
demo's pairing token and the downloaded speech model cache between runs, apart from your everyday Chrome.

1. Start ZeroClaw: in the ZeroClaw checkout run `docker compose up -d`, then check it answers with
   `docker exec zeroclaw zeroclaw agent -a default -m "reply with PONG only"`. Have a pairing code ready, see
   Pairing below.
2. Start the dev server: `npm run dev` (it serves http://localhost:5173).
3. Run `scripts/demo-chrome-linux.sh`. It takes an optional URL if the server is elsewhere, and the Chrome binary
   comes from `$CHROME_BIN` (default `/usr/bin/google-chrome`). It adds nothing to the URL: the defaults above are
   the demo's settings.
4. Pair (only the first time on that profile), then Connect.
5. Ask one warm-up question first. The first Connect on a cold profile loads the
   speech model (about 63 MB of weights, 27 to 38 s measured here, when they came from a CDN; not re-measured since they are served locally), and a first question exercises the whole path.

## Pairing

If your ZeroClaw instance requires pairing (`require_pairing` is on by default), get a
one-time 6-digit pairing code from that instance, for example by running
`zeroclaw gateway get-paircode --new` against it. In the app's "Pairing" section, enter the
code and click "Pair". On success, Nutq exchanges the code for a long-lived bearer token via
the instance's `/pair` endpoint, saves it in your browser's local storage keyed to the
gateway URL, and auto-fills the "Pairing token" field for you.

The saved token is remembered per gateway URL, so returning to the same instance later
auto-fills the token without re-pairing. If you point Nutq at a different gateway URL, the
token field clears since a token is only valid for the instance it was paired with, and
you'll need to pair again for that instance.

### If automatic pairing doesn't go through

If the "Pair" button fails outright rather than returning an invalid-code or rate-limit
error, this is most often a cross-origin (CORS) restriction: browsers don't expose the
specific reason a cross-origin fetch failed to JavaScript, so Nutq treats any such failure
the same way and falls back to a manual flow. When this happens, the Pairing section shows
an equivalent `curl` command built from your gateway URL and the code you entered:

```
curl -X POST <http-base>/pair -H "X-Pairing-Code: <code>"
```

Run that command yourself, or send it to whoever operates your ZeroClaw instance, then paste
the token it returns into the field that appears below the command. Saving it there stores
the token the same way a successful automatic pairing would, keyed to the gateway URL, and
auto-fills the main token field.

If you want the fully automatic one-click flow instead, host Nutq's built static files from
the same origin as your gateway: same-origin requests avoid the CORS restriction entirely.

