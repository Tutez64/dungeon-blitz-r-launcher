#!/usr/bin/env bash
# mac-load-probe.sh <outDir>: does the game really load when Flash Player is started on the
# local loader file named "Dungeon Blitz: R"? Compares it with starting on the game URL by
# capturing only the Flash Player window and measuring how much of it is plain background.
set -u
out="$1"; mkdir -p "$out/loader"
here="$(cd "$(dirname "$0")" && pwd)"
exe="$PWD/vendor/projector/darwin/Flash Player.app/Contents/MacOS/Flash Player"
url=$(node -e "require('./lib/projector').resolveSwfUrl('http://dungeonblitzr.theminesa.studio/').then(u=>console.log(u))")
node -e "require('fs').writeFileSync(process.argv[1], require('./lib/loaderSwf').buildLoaderSwf(process.argv[2]))" "$out/loader/Dungeon Blitz: R" "$url"

probe() {
  label="$1"; shift
  echo "=== $label"
  ( cd "$1" && "$exe" "$2" ) &
  sleep 35
  pid=$(pgrep -n -f "MacOS/Flash Player")
  swift "$here/windows.swift" "$pid" | sed "s/^/[$label] /"
  wid=$(swift "$here/window-id.swift" "$pid")
  echo "[$label] window id: $wid"
  screencapture -x -o -l "$wid" "$out/$label.png" && sips -s format bmp "$out/$label.png" --out "$out/$label.bmp" >/dev/null
  python3 -I "$here/bmpstats.py" "$out/$label.bmp" | sed "s/^/[$label] /"
  sudo lsof -nP -a -p "$pid" -iTCP 2>/dev/null | tail -n +2 | awk '{print $9, $10}' | sed "s/^/[$label] tcp /"
  kill "$pid" 2>/dev/null; sleep 3
}

probe url "$PWD" "$url"
probe loader-bare-name "$out/loader" "Dungeon Blitz: R"
