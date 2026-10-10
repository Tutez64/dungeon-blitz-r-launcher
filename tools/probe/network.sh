#!/usr/bin/env bash
# network.sh <pid> <outDir> <label>: the projector's TCP connections (did the game connect?).
pid="$1"; label="$3"
lsof -nP -a -p "$pid" -iTCP 2>/dev/null | tail -n +2 | awk '{print $9, $10}' | sed "s/^/[$label] tcp /"
echo "[$label] tcp count: $(lsof -nP -a -p "$pid" -iTCP 2>/dev/null | tail -n +2 | wc -l)"
