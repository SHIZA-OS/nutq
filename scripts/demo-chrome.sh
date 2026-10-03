#!/usr/bin/env bash
# Opens Chrome for a Nutq demo.
#
# Usage: scripts/demo-chrome.sh [url]      (default http://localhost:5173)
#
# --enable-speech-dispatcher makes Chrome on Linux list the local (speech-dispatcher) voices, which
# Nutq prefers for replies because they start speaking quickly. A separate profile keeps the demo's
# pairing token and settings apart from your everyday Chrome. No eval or fake-media flags are used:
# this is the real microphone and the real page.
set -euo pipefail

url="${1:-http://localhost:5173}"
profile="$HOME/.nutq-demo-chrome"

echo "Nutq demo Chrome: $url (profile $profile)"
echo "The first run on this profile needs pairing: get a code from ZeroClaw and pair in the page (README, Pairing)."
echo "The token is then saved in this profile, so later runs do not need it."

exec /usr/bin/google-chrome --enable-speech-dispatcher --user-data-dir="$profile" "$url"
