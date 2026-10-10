#!/usr/bin/env node
'use strict';

/**
 * The standalone Flash Player engine: finding the projector, choosing the SWF it opens,
 * and the work the game page's script used to do that the launcher now does while the
 * projector runs (rich presence, region latency).
 *
 * None of it needs Electron or a real projector: the binaries are stand-in files with the
 * right headers, and the server is a stub.
 *
 * Usage: node tools/test-projector.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projector = require('../lib/projector');
const { GameHost, BLANK_PRESENCE_LINE } = require('../lib/gameHost');

// The game page as the server serves it, trimmed to the line that names the SWF.
const GAME_PAGE = [
    '<script>',
    '    const languageParam = urlLanguage ? `&lang=${urlLanguage}` : "";',
    '    const swfUrl = `/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=swf-2e525d1ba098${languageParam}`;',
    '</script>'
].join('\n');

function peHeader(machine) {
    const header = Buffer.alloc(0x100);
    header.write('MZ', 0, 'ascii');
    header.writeUInt32LE(0x80, 0x3c);
    header.write('PE\0\0', 0x80, 'ascii');
    header.writeUInt16LE(machine, 0x84);
    return header;
}

function elfHeader(machine) {
    const header = Buffer.alloc(64);
    header.write('\x7fELF', 0, 'ascii');
    header.writeUInt16LE(machine, 18);
    return header;
}

function testSwfUrl() {
    assert.strictEqual(
        projector.swfUrlFromPage(GAME_PAGE, 'http://dungeonblitzr.example/'),
        'http://dungeonblitzr.example/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=swf-2e525d1ba098',
        'the page names the exact client revision, minus the template language piece'
    );
    assert.strictEqual(projector.swfUrlFromPage('<html>no game here</html>', 'http://a.example/'), '');
    assert.strictEqual(
        projector.defaultSwfUrl('http://127.0.0.1/'),
        'http://127.0.0.1/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp',
        'an unreadable page still gets the canonical path, which the server redirects'
    );
    console.log('[test-projector] the SWF comes off the game page, with a canonical fallback: OK');
}

async function testResolveSwfUrl() {
    const fromPage = await projector.resolveSwfUrl('http://a.example/', { fetchPage: async () => GAME_PAGE });
    assert.ok(fromPage.startsWith('http://a.example/p/cbp/DungeonBlitz.swf?') && fromPage.includes('clientrev='));
    const fallback = await projector.resolveSwfUrl('http://a.example/', { fetchPage: async () => '' });
    assert.strictEqual(fallback, 'http://a.example/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp');
}

function testCanExecute() {
    // Windows runs the 32-bit projector everywhere -- it is a separate process, so it does
    // not have to match the launcher the way the in-process plugin did.
    assert.strictEqual(projector.canExecute(['ia32'], { platform: 'win32', arch: 'x64' }), true);
    assert.strictEqual(projector.canExecute(['ia32'], { platform: 'win32', arch: 'ia32' }), true);
    assert.strictEqual(projector.canExecute(['x64'], { platform: 'win32', arch: 'ia32' }), false);
    // Rosetta runs the Intel projector on Apple Silicon.
    assert.strictEqual(projector.canExecute(['x64'], { platform: 'darwin', arch: 'arm64' }), true);
    // Linux runs only its own architecture.
    assert.strictEqual(projector.canExecute(['x64'], { platform: 'linux', arch: 'arm64' }), false);
    assert.strictEqual(projector.canExecute(['x64'], { platform: 'linux', arch: 'x64' }), true);
    // An unreadable header is never a reason to refuse.
    assert.strictEqual(projector.canExecute([], { platform: 'linux', arch: 'arm64' }), true);
    console.log('[test-projector] the projector only has to run on the machine, not match the launcher: OK');
}

function testFindProjector() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-projector-'));
    try {
        const name =
            process.platform === 'win32'
                ? 'flashplayer_32_sa.exe'
                : process.platform === 'darwin'
                  ? 'Flash Player.app'
                  : 'flashplayer';

        assert.strictEqual(projector.projectorInDirectory(root), '', 'an empty folder holds no projector');

        // A debugger build sitting next to the release build must not win.
        const debugName =
            process.platform === 'win32'
                ? 'flashplayer_32_sa_debug.exe'
                : process.platform === 'darwin'
                  ? 'Flash Player Debugger.app'
                  : 'flashplayerdebugger';

        let expected;
        if (process.platform === 'darwin') {
            for (const bundle of [name, debugName]) {
                const macOs = path.join(root, bundle, 'Contents', 'MacOS');
                fs.mkdirSync(macOs, { recursive: true });
                fs.writeFileSync(path.join(macOs, 'Flash Player'), Buffer.alloc(64));
            }
            expected = path.join(root, name);
        } else {
            fs.writeFileSync(path.join(root, debugName), process.platform === 'win32' ? peHeader(0x014c) : elfHeader(0x3e));
            fs.writeFileSync(path.join(root, name), process.platform === 'win32' ? peHeader(0x014c) : elfHeader(0x3e));
            expected = path.join(root, name);
        }
        // Something that merely looks like Flash is not a projector.
        fs.writeFileSync(path.join(root, 'pepflashplayer64.dll'), peHeader(0x8664));

        assert.strictEqual(projector.projectorInDirectory(root), expected);

        const found = projector.findProjector({ preferredPath: root });
        assert.ok(found, 'a folder chosen by hand is searched');
        assert.strictEqual(found.path, expected);
        assert.strictEqual(found.source, 'manual');
        if (process.platform === 'win32') {
            assert.deepStrictEqual(found.architectures, ['ia32']);
            assert.strictEqual(found.archMismatch, false, 'the 32-bit projector runs on 64-bit Windows');
        } else if (process.platform === 'linux') {
            assert.deepStrictEqual(found.architectures, ['x64']);
        }

        assert.strictEqual(projector.findProjector({ preferredPath: expected }).path, expected, 'the projector itself, chosen by hand');

        // A renamed download chosen by hand is still the projector; a plugin never is.
        if (process.platform !== 'darwin') {
            const renamed = path.join(root, process.platform === 'win32' ? 'Flash Player 32.exe' : 'flash-32');
            fs.copyFileSync(expected, renamed);
            fs.chmodSync(renamed, 0o755);
            assert.strictEqual(projector.isChosenProjector(renamed), true, 'a renamed projector chosen by hand');
            assert.strictEqual(projector.findProjector({ preferredPath: renamed }).path, renamed);
        }
        assert.strictEqual(projector.isChosenProjector(path.join(root, 'pepflashplayer64.dll')), false, 'a plugin is not a projector');

        const command = projector.projectorCommand(found, 'http://a.example/p/cbp/DungeonBlitz.swf');
        assert.deepStrictEqual(command.args, ['http://a.example/p/cbp/DungeonBlitz.swf'], 'the movie is the one argument');
        assert.ok(command.command, 'there is something to execute');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('[test-projector] the projector is found, release build first, plugins ignored: OK');
}

/** A stand-in for the server's presence and region routes, answering from a script. */
function stubServer(routes) {
    const calls = [];
    const request = async (method, url, body) => {
        calls.push({ method, url, body });
        const pathname = new URL(url).pathname;
        const answer = routes[`${method} ${pathname}`];
        const result = typeof answer === 'function' ? answer(url, body) : answer;
        return result || { ok: false, status: 404, body: null };
    };
    return { calls, request };
}

function stubPresence() {
    const published = [];
    let cleared = 0;
    return {
        published,
        get cleared() {
            return cleared;
        },
        publishPresence: async (payload) => {
            published.push(payload);
            return { updated: true };
        },
        clearPresence: async () => {
            cleared += 1;
            return true;
        }
    };
}

async function testPresencePolling() {
    const session = {
        characterName: 'Aldric',
        characterClass: 'Paladin',
        disciplineName: 'Justicar',
        details: '',
        state: 'In a party',
        startedAtMs: 1700000000000,
        partySize: 2
    };
    let answer = { ok: true, status: 200, body: { session } };
    const server = stubServer({ 'GET /api/presence/self': () => answer });
    const presence = stubPresence();
    const host = new GameHost({ presence, request: server.request });
    host.serverUrl = 'http://a.example';
    host.running = true;

    await host.syncPresence();
    assert.strictEqual(presence.published.length, 1, 'a session is published');
    const payload = presence.published[0];
    assert.strictEqual(payload.characterName, 'Aldric');
    assert.strictEqual(payload.characterClass, 'Justicar', 'the discipline names the class icon, as on the page');
    assert.strictEqual(payload.details, BLANK_PRESENCE_LINE, 'an empty line goes out as the page sends it');
    assert.strictEqual(payload.presenceUrl, 'http://a.example/api/presence/self');
    assert.strictEqual(payload.joinUrl, 'http://a.example/api/presence/discord-join');

    await host.syncPresence();
    assert.strictEqual(presence.published.length, 1, 'an unchanged session is not published again');
    assert.ok(server.calls[1].url.endsWith('?character=Aldric'), 'the next poll names our character');

    // 409: the server cannot tell which of this address's sessions is ours. That is not
    // "stopped playing", so nothing is cleared.
    answer = { ok: false, status: 409, body: { availableCharacters: ['Aldric', 'Brienne'] } };
    await host.syncPresence();
    assert.strictEqual(presence.cleared, 0, 'an ambiguous answer keeps the published presence');
    assert.ok(server.calls[2].url.endsWith('?character=Aldric'));

    // A transport failure is not an answer either.
    answer = { ok: false, status: 0, body: null };
    await host.syncPresence();
    assert.strictEqual(presence.cleared, 0, 'an unreachable server keeps the published presence');

    // 404: no session on this address -- the player left the game.
    answer = { ok: false, status: 404, body: null };
    await host.syncPresence();
    assert.strictEqual(presence.cleared, 1, 'no session clears the presence');
    await host.syncPresence();
    assert.strictEqual(presence.cleared, 1, 'and clears it once');
    assert.ok(!server.calls[server.calls.length - 1].url.includes('?character='), 'the name is forgotten with it');

    // Stopping the host takes what it published down with it.
    answer = { ok: true, status: 200, body: { session } };
    await host.syncPresence();
    host.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(presence.cleared, 2, 'closing the game clears the presence');

    host.running = false;
    const callsBefore = server.calls.length;
    await host.syncPresence();
    assert.strictEqual(server.calls.length, callsBefore, 'a stopped host does not poll');
    console.log('[test-projector] presence is polled and published as the game page did: OK');
}

async function testRegionLatency() {
    const server = stubServer({
        'GET /api/regions': {
            ok: true,
            status: 200,
            body: {
                regions: [
                    { id: 'us-east1', pingUrl: '/api/ping' },
                    { id: 'europe-west1', pingUrl: 'http://eu.example/api/ping' },
                    { id: 'down', pingUrl: 'http://down.example/api/ping' }
                ]
            }
        },
        'POST /api/region-rtt': { ok: true, status: 200, body: { ok: true } }
    });
    const samples = {
        'http://a.example/api/ping': [120, 40, 42, 41, 45, 43],
        'http://eu.example/api/ping': [200, 90, 80, 85, 81, 95],
        'http://down.example/api/ping': [NaN, NaN, NaN, NaN, NaN, NaN]
    };
    const ping = async (url) => samples[url].shift();
    const host = new GameHost({ presence: null, request: server.request, ping });
    host.serverUrl = 'http://a.example';
    host.running = true;

    await host.measureRegions();
    host.stop();

    const post = server.calls.find((call) => call.method === 'POST');
    assert.ok(post, 'the measured latencies are reported');
    assert.deepStrictEqual(
        post.body,
        { results: { 'us-east1': 40, 'europe-west1': 80 } },
        'the best reused-connection sample per region; an unreachable region is left out'
    );

    // One region: the server has nothing to place, and nothing is measured.
    const single = stubServer({
        'GET /api/regions': { ok: true, status: 200, body: { regions: [{ id: 'only', pingUrl: '/api/ping' }] } }
    });
    const quiet = new GameHost({ request: single.request, ping: async () => 1 });
    quiet.serverUrl = 'http://a.example';
    quiet.running = true;
    await quiet.measureRegions();
    quiet.stop();
    assert.ok(!single.calls.some((call) => call.method === 'POST'), 'a single region is not measured');
    console.log('[test-projector] region latency is measured and reported as the game page did: OK');
}

/**
 * The lock file is what every build downloads Flash Player against: each platform needs
 * a pinned hash and Adobe's own server first, or a build would ship whatever a mirror sent.
 */
function testLockFile() {
    const lock = require('../projector.lock.json');
    for (const platform of ['win32', 'darwin', 'linux']) {
        const entry = lock[platform];
        assert.ok(entry, `projector.lock.json covers ${platform}`);
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${platform} has a pinned sha256`);
        assert.ok(entry.urls.length >= 2, `${platform} has a fallback mirror`);
        assert.ok(entry.urls[0].startsWith('https://fpdownload.macromedia.com/'), `${platform} tries Adobe first`);
        for (const url of entry.urls) {
            assert.ok(url.startsWith('https://'), url);
            assert.ok(url.endsWith(entry.file), `${url} is ${entry.file}`);
        }
    }
    assert.strictEqual(lock.win32.file, 'flashplayer_32_sa.exe');
    assert.strictEqual(lock.darwin.file, 'flashplayer_32_sa.dmg');
    console.log('[test-projector] every platform downloads flashplayer_32_sa against a pinned hash: OK');
}

async function main() {
    testLockFile();
    testSwfUrl();
    await testResolveSwfUrl();
    testCanExecute();
    testFindProjector();
    await testPresencePolling();
    await testRegionLatency();
    console.log('[test-projector] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
