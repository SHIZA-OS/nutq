#!/usr/bin/env bash
# Opens Chrome on Linux for a Nutq demo.
#
# Usage: scripts/demo-chrome-linux.sh [url]      (default http://localhost:5173)
# The Chrome binary is $CHROME_BIN, default /usr/bin/google-chrome.
#
# A separate profile gives a clean window and keeps the demo's pairing token and the downloaded speech
# model cache between runs, apart from your everyday Chrome. The page needs no settings in the URL: the code defaults
# are the demo's (a text-dependent wait after you stop talking, a thorough answer written as speech, spoken sentence by
# sentence as it arrives). No eval or fake-media flags are used: this is the real microphone and the real page.
set -euo pipefail

chrome="${CHROME_BIN:-/usr/bin/google-chrome}"
url="${1:-http://localhost:5173}"
profile="$HOME/.nutq-demo-chrome"

echo "Nutq demo Chrome: $url (profile $profile)"
echo "The first run on this profile needs pairing: get a code from ZeroClaw and pair in the page (README, Demo)."
echo "The token is then saved in this profile, so later runs do not need it."

exec "$chrome" --user-data-dir="$profile" "$url"
