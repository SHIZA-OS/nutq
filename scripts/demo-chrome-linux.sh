#!/usr/bin/env bash
# Opens Chrome on Linux for a Nutq demo.
#
# Usage: scripts/demo-chrome-linux.sh [url]      (default http://localhost:5173)
# The Chrome binary is $CHROME_BIN, default /usr/bin/google-chrome.
#
# A separate profile gives a clean window and keeps the demo's pairing token and the downloaded speech
# model cache between runs, apart from your everyday Chrome. endpoint=semantic is added to the URL: the demo
# waits a text-dependent time after you stop talking (SEMANTIC_WAITS in src/turn-policy.ts, the swept
# Conservative point), where the public default is a fixed 5000 ms. Do not add ?silence: it overrides
# semantic mode. No eval or fake-media flags are used: this is the real microphone and the real page.
set -euo pipefail

chrome="${CHROME_BIN:-/usr/bin/google-chrome}"
url="${1:-http://localhost:5173}"
profile="$HOME/.nutq-demo-chrome"

# Append endpoint=semantic unless the URL already sets endpoint; & if there is already a query string.
if [[ "$url" != *endpoint=* ]]; then
  if [[ "$url" == *\?* ]]; then url="$url&endpoint=semantic"; else url="$url?endpoint=semantic"; fi
fi

echo "Nutq demo Chrome: $url (profile $profile)"
echo "The first run on this profile needs pairing: get a code from ZeroClaw and pair in the page (README, Demo)."
echo "The token is then saved in this profile, so later runs do not need it."

exec "$chrome" --user-data-dir="$profile" "$url"
