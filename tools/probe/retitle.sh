#!/usr/bin/env bash
# retitle.sh <pid> <outDir> <label>: rename the projector's windows (Linux, xdotool).
pid="$1"; label="$3"
for w in $(xdotool search --pid "$pid" 2>/dev/null); do xdotool set_window --name "Dungeon Blitz: R" "$w" && echo "[$label] renamed $w"; done
