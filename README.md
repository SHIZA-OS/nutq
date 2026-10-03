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

## Demo

1. Start ZeroClaw (the instance Nutq will talk to) and have a pairing code ready, see Pairing below.
2. Start the dev server: `npm run dev` (it serves http://localhost:5173).
3. Run `scripts/demo-chrome.sh` (it takes an optional URL if the server is elsewhere). It opens
   Chrome with `--enable-speech-dispatcher`, so Linux Chrome lists local voices, and a separate profile in
   `~/.nutq-demo-chrome` that keeps the demo's pairing token apart from your everyday Chrome.
4. Pair (only the first time on that profile), then Connect.
5. Ask one warm-up question before the audience arrives. The first Connect on a cold profile downloads the
   speech model (about 63 MB, 27 to 38 s measured here), and a first question exercises the whole path.

Replies are spoken with a local voice by default (the browser's default voice if it is local, else the first
local voice for your browser language); add `?voice=<exact name>` to the URL to pick
another (the page logs the voice list). A turn is sent 5000 ms after you stop talking by default; `?silence=<ms>` changes
that (800 to 8000), and the demo script uses 1200.

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

