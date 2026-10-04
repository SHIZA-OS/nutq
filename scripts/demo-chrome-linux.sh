#!/usr/bin/env bash
# Opens Chrome on Linux for a Nutq demo.
#
# Usage: scripts/demo-chrome-linux.sh [url]      (default http://localhost:5173)
# The Chrome binary is $CHROME_BIN, default /usr/bin/google-chrome.
#
# A separate profile gives a clean window and keeps the demo's pairing token and the downloaded speech
# model cache between runs, apart from your everyday Chrome. silence=1200 is added to the URL: the demo
# sends a turn 1200 ms after you stop talking, where the public default is 5000 ms. No eval or fake-media
# flags are used: this is the real microphone and the real page.
set -euo pipefail

chrome="${CHROME_BIN:-/usr/bin/google-chrome}"
url="${1:-http://localhost:5173}"
profile="$HOME/.nutq-demo-chrome"

# Append silence=1200 unless the URL already sets silence; & if there is already a query string.
if [[ "$url" != *silence=* ]]; then
  if [[ "$url" == *\?* ]]; then url="$url&silence=1200"; else url="$url?silence=1200"; fi
fi

echo "Nutq demo Chrome: $url (profile $profile)"
echo "The first run on this profile needs pairing: get a code from ZeroClaw and pair in the page (README, Demo)."
echo "The token is then saved in this profile, so later runs do not need it."

exec "$chrome" --user-data-dir="$profile" "$url"
