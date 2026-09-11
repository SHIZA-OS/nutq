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

