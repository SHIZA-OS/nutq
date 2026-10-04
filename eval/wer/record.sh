#!/usr/bin/env bash
# Records the WER case set (eval/wer/cases.jsonl) one case at a time.
# Audio goes outside the repo, to ~/Shiza/nutq-eval-audio/cases/<id>.wav.
# Each recording is 8 seconds unless the case sets "seconds" (a whole number), for cases with a long pause in them.
# A case with "pause_s" has a pause in the middle of the sentence (marked [PAUSE] in its "prompt"); the screen then
# says how long, and to count it silently.
# Usage: eval/wer/record.sh [--only <id>] [--dry-run]
#   --only <id>  re-record a single case even if its WAV exists
#   --dry-run    print each case and the arecord command, record nothing
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cases="$here/cases.jsonl"
outdir="$HOME/Shiza/nutq-eval-audio/cases"
only=""
dry=0

while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="${2:?--only needs a case id}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

mapfile -t lines < <(jq -c . "$cases")
total=${#lines[@]}

if [ -n "$only" ] && ! jq -e --arg id "$only" 'select(.id == $id)' "$cases" >/dev/null; then
  echo "No case with id: $only" >&2
  exit 2
fi

[ "$dry" -eq 1 ] || mkdir -p "$outdir"

echo "Read exactly as shown. If you misread, choose [r]edo."
[ "$dry" -eq 1 ] || sleep 2

noise_prompted=0
for line in "${lines[@]}"; do
  id=$(jq -r .id <<<"$line")
  category=$(jq -r .category <<<"$line")
  condition=$(jq -r .condition <<<"$line")
  reference=$(jq -r .reference <<<"$line")
  prompt=$(jq -r '.prompt // empty' <<<"$line")
  secs=$(jq -r '.seconds // 8' <<<"$line")
  pause_s=$(jq -r '.pause_s // empty' <<<"$line")
  [[ "$secs" =~ ^[1-9][0-9]*$ ]] || { echo "$id: seconds must be a whole number above 0, got \"$secs\"" >&2; exit 2; }
  out="$outdir/$id.wav"

  if [ -n "$only" ]; then
    [ "$id" = "$only" ] || continue
  elif [ -e "$out" ]; then
    echo "skip $id (already recorded)"
    continue
  fi

  cmd=(arecord -D default -f S16_LE -r 16000 -c 1 -d "$secs" -t wav "$out.tmp")

  if [ "$dry" -eq 1 ]; then
    echo "---"
    echo "id: $id  category: $category  condition: $condition"
    echo "reference: \"$reference\""
    [ -n "$prompt" ] && echo "prompt: $prompt"
    [ -n "$pause_s" ] && echo "pause: about $pause_s s, counted silently ($secs second recording)"
    [ "$condition" = "background_noise" ] && [ "$noise_prompted" -eq 0 ] &&
      { echo "(would pause: Turn on a fan or TV at normal volume, then press Enter.)"; noise_prompted=1; }
    [ "$id" = "sil-01" ] && echo "(would print: Stay silent for the whole recording.)"
    echo "would run: ${cmd[*]}"
    continue
  fi

  if [ "$condition" = "background_noise" ] && [ "$noise_prompted" -eq 0 ]; then
    echo
    read -r -p "Turn on a fan or TV at normal volume, then press Enter."
    noise_prompted=1
  fi

  while true; do
    clear
    printf '\n  %s   [%s / %s]\n\n\n' "$id" "$category" "$condition"
    if [ -n "$prompt" ]; then
      printf '  %s\n\n\n' "$prompt"
    elif [ "$id" = "sil-01" ]; then
      printf '  Stay silent for the whole recording.\n\n\n'
    else
      printf '  %s\n\n\n' "$reference"
    fi
    if [ -n "$pause_s" ]; then
      printf '  At [PAUSE], stop for about %s s. Count the pause SILENTLY in your head;\n  do not say the numbers out loud. Then carry on with the sentence.\n\n\n' "$pause_s"
    fi
    echo "  Recording in 2..."; sleep 1
    echo "  1..."; sleep 1
    echo "  GO ($secs seconds)"
    "${cmd[@]}"
    aplay -q "$out.tmp"

    while true; do
      read -r -n1 -p "[k]eep, [r]edo, [q]uit: " choice
      echo
      case "$choice" in
        k|K) mv "$out.tmp" "$out"; break 2 ;;
        r|R) break ;;
        q|Q) rm -f "$out.tmp"; have=$(find "$outdir" -name '*.wav' | wc -l); echo "$have of $total cases have recordings."; exit 0 ;;
      esac
    done
  done
done

have=0
for line in "${lines[@]}"; do
  [ -e "$outdir/$(jq -r .id <<<"$line").wav" ] && have=$((have + 1))
done
echo "$have of $total cases have recordings."
