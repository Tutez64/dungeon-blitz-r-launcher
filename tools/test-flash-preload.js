#!/usr/bin/env node
'use strict';

/**
 * The libraries loaded into the Linux Flash Player (native_flash/): how the launcher finds
 * them, how it puts them in Flash Player's environment, the tamper check on them, and -- on
 * a Linux machine with a C compiler -- that they build and do what they say.
 *
 * Usage: node tools/test-flash-preload.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projector = require('../lib/projector');
const integrity = require('../lib/integrity');

function testEnvironment() {
    const preload = { directory: '/opt/Dungeon Blitz R/resources/vendor/flashpreload/linux', libraries: ['flash_rlimit_cache.so'] };

    const env = projector.linuxFlashEnv({ HOME: '/home/p' }, preload);
    assert.strictEqual(env.LD_PRELOAD, 'flash_rlimit_cache.so', 'by bare name: LD_PRELOAD splits on the spaces in the .deb path');
    assert.strictEqual(env.LD_LIBRARY_PATH, preload.directory, 'its folder is where ld.so finds the bare name');
    assert.strictEqual(env.VDPAU_DRIVER, projector.NO_VDPAU_DRIVER, 'VDPAU stays off');
    assert.strictEqual(env.HOME, '/home/p', 'the rest of the environment is kept');

    const stacked = projector.linuxFlashEnv({ LD_PRELOAD: 'libMangoHud.so', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' }, preload);
    assert.strictEqual(stacked.LD_PRELOAD, 'libMangoHud.so flash_rlimit_cache.so', 'what the player preloads stays, first');
    assert.strictEqual(stacked.LD_LIBRARY_PATH, `${preload.directory}:/tmp/.mount_x/usr/lib`, 'ahead of the AppImage\'s own path');

    const vdpau = projector.linuxFlashEnv({ DUNGEON_BLITZ_FLASH_VDPAU: '1' }, preload);
    assert.strictEqual(vdpau.LD_PRELOAD, 'flash_rlimit_cache.so', 'keeping VDPAU does not drop the preload');

    const off = projector.linuxFlashEnv({ DUNGEON_BLITZ_FLASH_PRELOAD: '0', LD_PRELOAD: 'libMangoHud.so' }, preload);
    assert.strictEqual(off.LD_PRELOAD, 'libMangoHud.so', 'DUNGEON_BLITZ_FLASH_PRELOAD=0 leaves it out');
    assert.strictEqual(off.LD_LIBRARY_PATH, undefined);

    const colon = projector.linuxFlashEnv({}, { directory: '/home/a:b/vendor/flashpreload/linux', libraries: ['flash_rlimit_cache.so'] });
    assert.strictEqual(colon.LD_PRELOAD, undefined, 'a folder LD_LIBRARY_PATH cannot name is left out');

    assert.strictEqual(projector.linuxFlashEnv({}, null).LD_PRELOAD, undefined, 'a build without one changes nothing');

    const launch = projector.prepareLaunch({ path: '/x/flashplayer' }, 'http://a.example/g.swf', { platform: 'linux', env: {}, preload });
    assert.strictEqual(launch.env.LD_PRELOAD, 'flash_rlimit_cache.so', 'prepareLaunch passes it on');
    const windows = projector.prepareLaunch({ path: '/x/flashplayer' }, 'http://a.example/g.swf', { platform: 'win32', env: {}, preload });
    assert.strictEqual(windows.env, undefined, 'only Linux gets it');
    console.log('[test-flash-preload] Flash Player is started with the preload, by name, after the player\'s own: OK');
}

function testFindAndVerify() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-flashpreload-'));
    try {
        const empty = path.join(root, 'empty', 'linux');
        const full = path.join(root, 'full', 'linux');
        fs.mkdirSync(empty, { recursive: true });
        fs.mkdirSync(full, { recursive: true });
        fs.writeFileSync(path.join(full, 'b.so'), 'b');
        fs.writeFileSync(path.join(full, 'a.so'), 'a');
        fs.writeFileSync(path.join(full, 'notes.txt'), 'not a library');

        assert.strictEqual(projector.findFlashPreload([path.join(root, 'missing'), empty]), null, 'no libraries, no preload');
        assert.deepStrictEqual(projector.findFlashPreload([empty, full]), { directory: full, libraries: ['a.so', 'b.so'] });

        const record = path.join(root, 'flashpreload.integrity.json');
        integrity.writeExpected(full, { platform: 'linux', version: '0.0.0' }, record);
        assert.deepStrictEqual(projector.verifyFlashPreload(full, { integrityPath: record }), { ok: true, reason: '' });

        fs.writeFileSync(path.join(full, 'a.so'), 'patched');
        assert.strictEqual(projector.verifyFlashPreload(full, { integrityPath: record }).ok, false, 'a changed library is refused');
        fs.writeFileSync(path.join(full, 'a.so'), 'a');
        fs.writeFileSync(path.join(full, 'c.so'), 'c');
        assert.strictEqual(projector.verifyFlashPreload(full, { integrityPath: record }).ok, false, 'an added library is refused');
        fs.rmSync(path.join(full, 'c.so'));
        assert.strictEqual(projector.verifyFlashPreload(full, { integrityPath: record }).ok, true, 'and passes again once removed');
        assert.strictEqual(
            projector.verifyFlashPreload(full, { integrityPath: path.join(root, 'none.json') }).ok,
            false,
            'a build that recorded nothing is refused too'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('[test-flash-preload] the preload folder is found, and a changed or added library is refused: OK');
}

function haveTool(command) {
    return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function testBuild() {
    const cc = process.env.CC || 'cc';
    if (process.platform !== 'linux' || !haveTool(cc) || !haveTool('readelf')) {
        console.log('[test-flash-preload] no Linux C toolchain here; the libraries were not built');
        return;
    }
    const { buildLibraries, checkLibrary } = require('./build-flash-preload');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db flash preload '));
    try {
        // A folder with spaces, like the .deb's.
        const built = buildLibraries(path.join(root, 'linux'));
        assert.ok(built.some((library) => library.endsWith('flash_rlimit_cache.so')), 'flash_rlimit_cache.so is built');

        // The check catches a library that does not take getrlimit over.
        const sources = path.join(root, 'sources');
        fs.mkdirSync(sources);
        fs.writeFileSync(path.join(sources, 'inert.c'), 'int inert(void) { return 0; }\n');
        const inert = path.join(root, 'inert');
        assert.throws(() => buildLibraries(inert, { sources }), /getrlimit does not come from inert\.so/);
        assert.throws(() => checkLibrary(path.join(inert, 'inert.so')), /getrlimit/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('[test-flash-preload] the libraries build, need only an old glibc, and answer as the kernel does: OK');
}

testEnvironment();
testFindAndVerify();
testBuild();
console.log('[test-flash-preload] all assertions passed');
