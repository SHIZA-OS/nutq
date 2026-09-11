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

