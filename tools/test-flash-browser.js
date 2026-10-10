#!/usr/bin/env node
'use strict';

/**
 * Checks FlashBrowser, the default game engine (lib/flashBrowser.js), without an Electron
 * runtime: which machines get one, how a vendor/flashbrowser/ folder is found and refused, how
 * it is started, the fingerprint an installed launcher checks, and that the lock file,
 * packaging and the game-window app agree with each other.
 *
 * Usage: node tools/test-flash-browser.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    FLASH_VERSION,
    TARGETS,
    findFlashBrowser,
    flashBrowserTarget,
    prepareFlashBrowserLaunch,
    verifyFlashBrowser
} = require('../lib/flashBrowser');
const { writeExpected } = require('../lib/integrity');
const { createStateStore } = require('../lib/config');

const ROOT = path.join(__dirname, '..');

function write(file, body = 'x') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

/** A complete vendor/flashbrowser/<target>/ folder, with stand-in files. */
function makeFlashBrowser(root, target) {
    if (target === 'win32-x64') {
        write(path.join(root, 'runtime', 'electron.exe'));
        write(path.join(root, 'runtime', 'resources', 'default_app.asar'));
        write(path.join(root, 'plugin', 'pepflashplayer64.dll'));
    } else {
        write(path.join(root, 'runtime', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
        write(path.join(root, 'runtime', 'Electron.app', 'Contents', 'Resources', 'default_app.asar'));
        write(path.join(root, 'plugin', 'PepperFlashPlayer.plugin', 'Contents', 'MacOS', 'PepperFlashPlayer'));
    }
    write(path.join(root, 'app', 'main.js'));
    write(path.join(root, 'app', 'package.json'), '{}');
}

function checkTargets() {
    assert.strictEqual(flashBrowserTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64');
    assert.strictEqual(flashBrowserTarget({ platform: 'win32', arch: 'arm64' }), 'win32-x64', 'Windows on Arm runs the x64 build');
    assert.strictEqual(flashBrowserTarget({ platform: 'win32', arch: 'ia32' }), '', '32-bit Windows has no plugin');
    assert.strictEqual(flashBrowserTarget({ platform: 'darwin', arch: 'x64' }), 'darwin-x64');
    assert.strictEqual(flashBrowserTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-x64', 'Apple Silicon runs it under Rosetta');
    assert.strictEqual(flashBrowserTarget({ platform: 'linux', arch: 'x64' }), '', 'Linux has no plugin');

    const none = findFlashBrowser({ platform: 'linux', arch: 'x64' });
    assert.deepStrictEqual(none, { offered: false, target: '', found: null, partial: null });
    console.log('[test-flash-browser] Windows x64 and macOS get FlashBrowser, 32-bit Windows and Linux do not: OK');
}

function checkLookup(scratch) {
    for (const target of Object.keys(TARGETS)) {
        const [platform, arch] = target.split('-');
        const missingDir = path.join(scratch, 'missing', target);
        const partialDir = path.join(scratch, 'partial', target);
        const completeDir = path.join(scratch, 'complete', target);

        makeFlashBrowser(partialDir, target);
        fs.rmSync(path.join(partialDir, 'plugin'), { recursive: true, force: true });
        makeFlashBrowser(completeDir, target);

        const located = findFlashBrowser({ platform, arch, directories: [missingDir, partialDir, completeDir] });
        assert.strictEqual(located.offered, true);
        assert.strictEqual(located.target, target);
        assert.ok(located.found, `${target}: the complete folder is found past an incomplete one`);
        assert.strictEqual(located.found.root, completeDir);
        assert.ok(located.found.pluginPath.endsWith(TARGETS[target].plugin));
        if (platform === 'darwin') {
            assert.ok(
                located.found.executable.endsWith(path.join('Electron.app', 'Contents', 'MacOS', 'Electron')),
                'the macOS runtime is started through the binary inside Electron.app'
            );
        }

        const partial = findFlashBrowser({ platform, arch, directories: [missingDir, partialDir] });
        assert.strictEqual(partial.found, null);
        assert.deepStrictEqual(partial.partial.missing, [path.join('plugin', TARGETS[target].plugin)], 'the missing part is named');
    }
    console.log('[test-flash-browser] a complete FlashBrowser is found, an incomplete one says what it lacks: OK');
}

function checkLaunch() {
    const found = {
        executable: 'C:\\Launcher\\resources\\vendor\\flashbrowser\\win32-x64\\runtime\\electron.exe',
        appDir: 'C:\\Launcher\\resources\\vendor\\flashbrowser\\win32-x64\\app',
        pluginPath: 'C:\\Launcher\\resources\\vendor\\flashbrowser\\win32-x64\\plugin\\pepflashplayer64.dll'
    };
    const launch = prepareFlashBrowserLaunch(found, {
        gameUrl: 'http://dungeonblitzr.theminesa.studio/',
        userDataDir: 'C:\\Users\\p\\AppData\\Roaming\\dungeon-blitz-r-launcher\\flashbrowser',
        env: { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require evil.js', ELECTRON_NO_ASAR: '1' }
    });
    assert.strictEqual(launch.command, found.executable);
    assert.deepStrictEqual(launch.args, [
        found.appDir,
        '--db-game-url=http://dungeonblitzr.theminesa.studio/',
        `--db-plugin=${found.pluginPath}`,
        `--db-flash-version=${FLASH_VERSION}`,
        '--db-user-data=C:\\Users\\p\\AppData\\Roaming\\dungeon-blitz-r-launcher\\flashbrowser'
    ]);
    assert.deepStrictEqual(launch.env, { PATH: 'C:\\Windows' }, 'no Electron or Node switches reach the game window');

    const dev = prepareFlashBrowserLaunch(found, { gameUrl: 'http://x/', userDataDir: 'd', devTools: true, env: {} });
    assert.ok(dev.args.includes('--db-devtools'), 'a checkout may open developer tools');
    assert.ok(!launch.args.includes('--db-devtools'), 'an installed launcher may not');

    // The switches the launcher passes are exactly the ones the game-window app reads.
    const host = fs.readFileSync(path.join(ROOT, 'flashbrowser', 'main.js'), 'utf8');
    for (const name of ['game-url', 'plugin', 'flash-version', 'user-data']) {
        assert.ok(host.includes(`option('${name}')`), `flashbrowser/main.js reads --db-${name}`);
    }
    assert.ok(host.includes("'--db-devtools'"), 'flashbrowser/main.js reads --db-devtools');
    console.log('[test-flash-browser] FlashBrowser is started on the game page with the plugin, in its own profile: OK');
}

function checkIntegrity(scratch) {
    const root = path.join(scratch, 'integrity', 'win32-x64');
    makeFlashBrowser(root, 'win32-x64');
    const integrityPath = path.join(scratch, 'integrity', 'flashbrowser.integrity.json');

    assert.strictEqual(verifyFlashBrowser(root, { target: 'win32-x64', integrityPath }).ok, false, 'no record, no start');

    writeExpected(root, { platform: 'win32-x64', version: FLASH_VERSION }, integrityPath);
    assert.deepStrictEqual(verifyFlashBrowser(root, { target: 'win32-x64', integrityPath }), { ok: true, reason: '' });

    const wrongTarget = verifyFlashBrowser(root, { target: 'darwin-x64', integrityPath });
    assert.strictEqual(wrongTarget.ok, false);
    assert.ok(wrongTarget.reason.includes('FlashBrowser fingerprint is for win32-x64'), wrongTarget.reason);

    for (const changed of [path.join('plugin', 'pepflashplayer64.dll'), path.join('app', 'main.js'), path.join('runtime', 'electron.exe')]) {
        const file = path.join(root, changed);
        const original = fs.readFileSync(file);
        fs.writeFileSync(file, 'patched');
        const result = verifyFlashBrowser(root, { target: 'win32-x64', integrityPath });
        assert.strictEqual(result.ok, false, `a changed ${changed} is refused`);
        assert.strictEqual(result.reason, 'FlashBrowser files were changed after installation');
        fs.writeFileSync(file, original);
    }

    write(path.join(root, 'app', 'extra.js'), 'require("evil")');
    assert.strictEqual(verifyFlashBrowser(root, { target: 'win32-x64', integrityPath }).ok, false, 'an added file is refused');
    console.log('[test-flash-browser] a changed, added-to or foreign FlashBrowser is refused: OK');
}

function checkLockAndPackaging() {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'flashbrowser.lock.json'), 'utf8'));
    assert.strictEqual(lock.flash, FLASH_VERSION, 'the lock and the launcher name the same plugin build');
    assert.deepStrictEqual(Object.keys(lock.targets).sort(), Object.keys(TARGETS).sort(), 'one lock entry per target');

    for (const [target, entry] of Object.entries(lock.targets)) {
        assert.match(entry.runtime.sha256, /^[0-9a-f]{64}$/, `${target}: the Electron runtime is pinned`);
        assert.ok(entry.runtime.file.includes(`v${lock.electron}-${target}`), `${target}: the runtime is Electron ${lock.electron} for ${target}`);
        assert.ok(entry.runtime.urls.length >= 1 && entry.runtime.urls.every((url) => url.startsWith('https://')));
        assert.strictEqual(entry.plugin.name, TARGETS[target].plugin);

        // Every pinned plugin file is in the repository (a Git LFS pointer in a checkout made
        // without LFS), so a release can never quietly lose one.
        for (const [relative, hash] of Object.entries(entry.plugin.files)) {
            assert.match(hash, /^[0-9a-f]{64}$/);
            const file = path.join(ROOT, entry.plugin.payload, ...relative.split('/').filter(Boolean));
            assert.ok(fs.existsSync(file), `${file} is in the repository`);
            const head = fs.readFileSync(file).subarray(0, 200).toString('utf8');
            if (head.startsWith('version https://git-lfs.github.com/spec/')) {
                assert.ok(head.includes(`oid sha256:${hash}`), `${file}: the LFS pointer names the pinned hash`);
            }
        }
    }

    const pkg = require(path.join(ROOT, 'package.json'));
    const filters = pkg.build.extraResources.flatMap((entry) => entry.filter || []);
    assert.ok(filters.includes('flashbrowser/${platform}-${arch}/**/*'), 'each package ships only its own FlashBrowser');
    assert.ok(/fetch-flash-browser\.js --platform win32 --arch x64/.test(pkg.scripts['predist:win']));
    assert.ok(/fetch-flash-browser\.js --platform win32 --arch ia32/.test(pkg.scripts['predist:win:ia32']), 'the ia32 run clears it');
    assert.ok(/fetch-flash-browser\.js --platform darwin --arch x64/.test(pkg.scripts['predist:mac']));

    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.ok(workflow.includes('node tools/fetch-flash-browser.js'), 'the release assembles FlashBrowser');
    assert.ok(workflow.includes('node tools/verify-flash-browser.js'), 'the release checks it in the package');

    const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(ignored.includes('lib/flashbrowser.integrity.json'), 'the per-build fingerprint is never committed');
    console.log('[test-flash-browser] the lock, the plugin payload and packaging agree: OK');
}

function checkSavedEngine(scratch) {
    const store = createStateStore(path.join(scratch, 'state'));
    assert.strictEqual(store.read().engine, '', 'nothing picked yet');
    store.write({ engine: 'projector' });
    assert.strictEqual(store.read().engine, 'projector', 'the Flash Player button is remembered');
    store.write({ engine: 'flashbrowser' });
    assert.strictEqual(store.read().engine, 'flashbrowser');
    store.write({ engine: 'something-else' });
    assert.strictEqual(store.read().engine, '', 'an unknown engine is ignored');
    console.log('[test-flash-browser] the engine a player picked is remembered: OK');
}

function main() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-flashbrowser-test-'));
    try {
        checkTargets();
        checkLookup(scratch);
        checkLaunch();
        checkIntegrity(scratch);
        checkLockAndPackaging();
        checkSavedEngine(scratch);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log('[test-flash-browser] all assertions passed');
}

main();
