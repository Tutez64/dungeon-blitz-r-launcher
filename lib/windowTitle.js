'use strict';

const { spawn, execFileSync } = require('child_process');

/**
 * Keeps Flash Player's window titled "Dungeon Blitz: R".
 *
 * Flash Player names its own window, and the name is never the game's:
 *
 *   Windows  "Adobe Flash Player 32"            renamed here, through the Win32 API
 *   Linux    "Adobe Flash Player 32,0,0,465"    renamed here when xdotool is installed
 *   macOS    the movie it was started on        the launcher starts it on a local file
 *                                               named "Dungeon Blitz: R" instead
 *                                               (lib/projector.js prepareLaunch), so
 *                                               nothing is renamed here
 *
 * The rename is repeated every second for as long as Flash Player runs, because Flash
 * Player sets its title again on its own (entering and leaving full screen, for one).
 */

const GAME_TITLE = 'Dungeon Blitz: R';

// The whole loop lives in C#: one PowerShell process, compiled once, that exits on its own
// when Flash Player does. Fed through stdin rather than -EncodedCommand, which security
// software rightly treats as suspicious.
const WINDOWS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class DungeonBlitzTitle {
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowText(IntPtr hwnd, string text);
    public static void Run(int pid, string title) {
        Process process;
        try { process = Process.GetProcessById(pid); } catch { return; }
        while (!process.HasExited) {
            EnumWindows(delegate (IntPtr hwnd, IntPtr data) {
                uint owner;
                GetWindowThreadProcessId(hwnd, out owner);
                if (owner == (uint)pid && IsWindowVisible(hwnd)) {
                    StringBuilder current = new StringBuilder(256);
                    GetWindowText(hwnd, current, 256);
                    if (current.ToString() != title) { SetWindowText(hwnd, title); }
                }
                return true;
            }, IntPtr.Zero);
            Thread.Sleep(1000);
        }
    }
}
"@
[DungeonBlitzTitle]::Run(__PID__, '__TITLE__')
`;

function hasXdotool() {
    try {
        execFileSync('xdotool', ['version'], { stdio: 'ignore', timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Starts keeping the window of the Flash Player process `pid` titled for the game.
 *
 * @returns {{ stop: () => void, method: string }} `method` says what was done, for the log.
 */
function keepGameTitle(pid, { platform = process.platform, title = GAME_TITLE } = {}) {
    const noop = { stop() {}, method: 'none' };
    if (!Number.isInteger(pid) || pid <= 0) {
        return noop;
    }

    if (platform === 'win32') {
        const script = WINDOWS_SCRIPT.replace('__PID__', String(pid)).replace('__TITLE__', title.replace(/'/g, "''"));
        let child;
        try {
            child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
                stdio: ['pipe', 'ignore', 'ignore'],
                windowsHide: true
            });
        } catch {
            return noop;
        }
        child.on('error', () => {});
        child.stdin.on('error', () => {});
        child.stdin.end(script);
        return {
            method: 'win32-setwindowtext',
            stop() {
                try {
                    child.kill();
                } catch {
                    // Already gone; it exits with Flash Player anyway.
                }
            }
        };
    }

    if (platform === 'linux' && hasXdotool()) {
        const timer = setInterval(() => {
            const rename = spawn(
                'sh',
                ['-c', 'for w in $(xdotool search --pid "$0" 2>/dev/null); do xdotool set_window --name "$1" "$w"; done', String(pid), title],
                { stdio: 'ignore' }
            );
            rename.on('error', () => {});
        }, 1000);
        return {
            method: 'linux-xdotool',
            stop() {
                clearInterval(timer);
            }
        };
    }

    return noop;
}

module.exports = { GAME_TITLE, WINDOWS_SCRIPT, keepGameTitle };
