#!/usr/bin/env node
'use strict';

/**
 * Starts the game in Flash Player exactly as the launcher does (lib/projector.js
 * prepareLaunch + lib/windowTitle.js keepGameTitle) and checks the window's title is
 * "Dungeon Blitz: R" -- never the game's address or Flash Player's own name.
 *
 * Run by the Flash Player workflow on Windows and macOS runners, which have a desktop.
 *
 * Usage: node tools/check-window-title.js [server URL]
 */

const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { findProjector, prepareLaunch, resolveSwfUrl } = require('../lib/projector');
const { keepGameTitle, GAME_TITLE } = require('../lib/windowTitle');

const SERVER = process.argv[2] || 'http://dungeonblitzr.theminesa.studio/';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function titles(pid) {
    if (process.platform === 'win32') {
        const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class T {
  delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string[] Of(int pid) {
    List<string> found = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) { uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)pid && IsWindowVisible(h)) { StringBuilder s = new StringBuilder(512); GetWindowText(h, s, 512); found.Add(s.ToString()); }
      return true; }, IntPtr.Zero);
    return found.ToArray();
  }
}
"@
[T]::Of(${pid}) | ForEach-Object { $_ }`;
        const file = path.join(os.tmpdir(), 'db-titles.ps1');
        require('fs').writeFileSync(file, script);
        return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
            encoding: 'utf8'
        })
            .split(/\r?\n/)
            .filter(Boolean);
    }
    if (process.platform === 'darwin') {
        const swift = path.join(os.tmpdir(), 'db-titles.swift');
        require('fs').writeFileSync(
            swift,
            `import CoreGraphics
let pid = Int32(CommandLine.arguments[1]) ?? 0
for w in (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []) {
  if (w[kCGWindowOwnerPID as String] as? Int32) == pid, let name = w[kCGWindowName as String] as? String, !name.isEmpty { print(name) }
}`
        );
        return execFileSync('swift', [swift, String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean);
    }
    throw new Error('run this on Windows or macOS');
}

(async () => {
    const projector = findProjector({ vendorOnly: true });
    if (!projector) {
        throw new Error('no Flash Player in vendor/ -- run tools/fetch-projector.js first');
    }
    const swfUrl = await resolveSwfUrl(SERVER);
    const launch = prepareLaunch(projector, swfUrl, { workDir: path.join(os.tmpdir(), 'db-game') });
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'ignore' });
    const keeper = keepGameTitle(child.pid);
    console.log(`[check-window-title] started ${launch.command} ${launch.args.join(' ')} (title keeper: ${keeper.method})`);

    let seen = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(2000);
        seen = titles(child.pid);
        if (seen.length && seen.every((title) => title === GAME_TITLE)) {
            break;
        }
    }
    keeper.stop();
    child.kill();

    console.log(`[check-window-title] titles: ${JSON.stringify(seen)}`);
    if (!seen.length || !seen.every((title) => title === GAME_TITLE)) {
        console.error(`[check-window-title] FAILED: expected every window to read "${GAME_TITLE}"`);
        process.exit(1);
    }
    console.log(`[check-window-title] the game window reads "${GAME_TITLE}"`);
})().catch((error) => {
    console.error(`[check-window-title] ERROR: ${error.message}`);
    process.exit(1);
});
