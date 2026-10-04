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

## Demo on Linux

The demo script opens Chrome with its own profile (`~/.nutq-demo-chrome`). That gives a clean window and keeps the
demo's pairing token and the downloaded speech model cache between runs, apart from your everyday Chrome.

1. Start ZeroClaw: in the ZeroClaw checkout run `docker compose up -d`, then check it answers with
   `docker exec zeroclaw zeroclaw agent -a default -m "reply with PONG only"`. Have a pairing code ready, see
   Pairing below.
2. Start the dev server: `npm run dev` (it serves http://localhost:5173).
3. Run `scripts/demo-chrome-linux.sh`. It takes an optional URL if the server is elsewhere, and the Chrome binary
   comes from `$CHROME_BIN` (default `/usr/bin/google-chrome`). It adds `silence=1200` to the URL, so a turn is sent
   1200 ms after you stop talking (the default is 5000 ms; `?silence=<ms>` takes 800 to 8000).
4. Pair (only the first time on that profile), then Connect.
5. Ask one warm-up question before the audience arrives. The first Connect on a cold profile downloads the
   speech model (about 63 MB, 27 to 38 s measured here), and a first question exercises the whole path.

Replies are spoken with the browser's default voice; add `voice=<exact name>` to the URL to pick another (the page
logs the voice list).

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

