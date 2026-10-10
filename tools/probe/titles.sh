#!/usr/bin/env bash
# titles.sh <pid> <outDir> <label>: print the projector's window titles and take a screenshot.
pid="$1"; out="$2"; label="$3"
if [ "$(uname)" = "Darwin" ]; then
  swift "$(dirname "$0")/windows.swift" "$pid" 2>&1 | sed "s/^/[$label] /"
  screencapture -x "$out/$label.png" 2>&1 | sed "s/^/[$label] screencapture: /"
else
  for w in $(xdotool search --pid "$pid" 2>/dev/null); do echo "[$label] window $w: $(xdotool getwindowname "$w")"; done
  import -window root "$out/$label.png" 2>&1 | sed "s/^/[$label] import: /"
fi
echo "[$label] screenshot: $(ls -la "$out/$label.png" 2>/dev/null)"
