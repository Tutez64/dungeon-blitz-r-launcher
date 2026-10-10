#!/usr/bin/env node
'use strict';

/**
 * Checks which Windows the launcher supports.
 *
 * Every Windows version is described from its `os.release()` string, so the whole matrix
 * runs on any machine: no Windows, no Electron runtime, no network. That matters more than
 * usual here, because the versions being pinned down (7, 8, Vista) are exactly the ones a
 * CI runner cannot be. The architecture is passed in too, so the result does not depend on
 * the machine the suite runs on.
 *
 * Usage: node tools/test-windows-support.js
 */

const assert = require('assert');

const {
    MINIMUM_WINDOWS,
    SUPPORTED_ARCHITECTURES,
    describeWindows,
    unsupportedArchitectureMessage,
    unsupportedWindowsMessage
} = require('../lib/windowsSupport');

const WIN32 = 'win32';

function describe(release, arch = 'x64') {
    return describeWindows({ platform: WIN32, release, arch });
}

function main() {
    // Anything that is not Windows is left alone: there is nothing to classify, and a build
    // for macOS must not start reading Windows versions.
    for (const platform of ['darwin', 'linux']) {
        const status = describeWindows({ platform, release: '10.0.22631', arch: 'arm64' });
        assert.strictEqual(status.supported, true);
        assert.strictEqual(status.product, '');
        assert.strictEqual(status.reason, '');
    }

    // Windows 10 and 11 both report a 10.0 kernel; that is the floor Electron sets.
    for (const release of ['10.0.19045', '10.0.22631']) {
        const windows10 = describe(release);
        assert.strictEqual(windows10.supported, true);
        assert.strictEqual(windows10.product, 'Windows 10 or later');
        assert.strictEqual(windows10.reason, '', 'a supported Windows has nothing to complain about');
        assert.strictEqual(windows10.requirements, '');
    }

    // A kernel newer than 10.0 is newer than Windows 10, not older.
    const future = describe('11.0.30000');
    assert.strictEqual(future.supported, true);
    assert.strictEqual(future.reason, '');

    // Windows 7, 8 and 8.1 are refused by name: Electron dropped them in version 23.
    for (const [release, product] of [
        ['6.3.9600', 'Windows 8.1'],
        ['6.2.9200', 'Windows 8'],
        ['6.1.7601', 'Windows 7'],
        ['6.1.7600', 'Windows 7'],
        ['6.0.6002', 'Windows Vista']
    ]) {
        const status = describe(release);
        assert.strictEqual(status.supported, false, `${product} (${release}) must be refused`);
        assert.strictEqual(status.product, product);
        assert.ok(status.reason.includes(MINIMUM_WINDOWS), status.reason);
        assert.ok(status.requirements.includes(MINIMUM_WINDOWS), status.requirements);
    }

    // Older than the table is refused as well, named by its kernel.
    const xp = describe('5.1.2600');
    assert.strictEqual(xp.supported, false);
    assert.strictEqual(xp.product, 'Windows 5.1');
    assert.ok(xp.reason.includes(MINIMUM_WINDOWS), xp.reason);

    // A version that cannot be read is refused rather than assumed modern: guessing here
    // is how a player ends up on a launcher that cannot start with no way to tell why.
    for (const release of ['', 'not-a-version', '10']) {
        const unknown = describe(release);
        assert.strictEqual(unknown.supported, false, `"${release}" must not read as supported`);
        assert.ok(unknown.reason.includes('could not be read'), unknown.reason);
    }

    // The refusal text names the floor and the machine it refused.
    const windows7 = describe('6.1.7601');
    const message = unsupportedWindowsMessage(windows7);
    assert.ok(message.includes(MINIMUM_WINDOWS), message);
    assert.ok(message.includes('Windows 7'), message);
    assert.ok(message.includes('6.1.7601'), message);
    // 32-bit is no requirement anyone has to be told about: Flash Player is a 32-bit
    // program in its own process and runs on both.
    assert.ok(!message.includes('64-bit'), message);
    assert.ok(!MINIMUM_WINDOWS.includes('64-bit'), MINIMUM_WINDOWS);

    // The same text works for a version that could not be read at all.
    const unknownMessage = unsupportedWindowsMessage(describe(''));
    assert.ok(unknownMessage.includes(MINIMUM_WINDOWS), unknownMessage);

    // The 32-bit Windows build plays: the game runs in flashplayer_32_sa.exe, a 32-bit
    // program in its own process, so nothing has to match the launcher's architecture.
    assert.deepStrictEqual(SUPPORTED_ARCHITECTURES, ['x64', 'ia32']);
    for (const release of ['10.0.19045', '10.0.22631']) {
        for (const arch of ['x64', 'ia32']) {
            const status = describe(release, arch);
            assert.strictEqual(status.supported, true, `${arch} on ${release} plays`);
            assert.strictEqual(status.architectureSupported, true);
        }
    }

    // A Windows too old for the launcher is still refused on either architecture.
    const ia32Windows7 = describe('6.1.7601', 'ia32');
    assert.strictEqual(ia32Windows7.supported, false);
    assert.strictEqual(ia32Windows7.architectureSupported, true);
    assert.ok(ia32Windows7.reason.includes(MINIMUM_WINDOWS), ia32Windows7.reason);

    // arm64 has no build, and is refused by architecture rather than reaching a version
    // check it has no business passing.
    const arm64 = describe('10.0.22631', 'arm64');
    assert.strictEqual(arm64.supported, false);
    assert.strictEqual(arm64.architectureSupported, false);
    assert.ok(arm64.reason.includes('arm64'), arm64.reason);
    assert.ok(arm64.requirements.includes('win-x64'), arm64.requirements);
    assert.ok(!arm64.requirements.includes(MINIMUM_WINDOWS), 'an architecture refusal is not a Windows version refusal');

    // The refusal names the exact file to download, spelled the way the release page does.
    const archMessage = unsupportedArchitectureMessage(arm64, { version: '1.0.17' });
    assert.ok(/an arm64 process/.test(archMessage), archMessage);
    assert.ok(archMessage.includes('DungeonBlitzR-Launcher-1.0.17-win-x64-setup.exe'), archMessage);
    assert.ok(!archMessage.includes(MINIMUM_WINDOWS), archMessage);

    // That name is built from build.nsis.artifactName, so a change there silently breaks
    // the instruction. Derive it from package.json rather than restating it.
    const artifactName = require('../package.json').build.nsis.artifactName;
    assert.strictEqual(
        artifactName.replace('${version}', '1.0.17').replace('${arch}', 'x64').replace('${ext}', 'exe'),
        'DungeonBlitzR-Launcher-1.0.17-win-x64-setup.exe',
        'the dialog quotes build.nsis.artifactName; if that changes, update unsupportedArchitectureMessage()'
    );

    // Without a version (a development run) it must not invent a filename.
    const devMessage = unsupportedArchitectureMessage(arm64);
    assert.ok(devMessage.includes('DungeonBlitzR-Launcher-<version>-win-x64-setup.exe'), devMessage);
    assert.ok(!/DungeonBlitzR-Launcher-\d/.test(devMessage), 'no made-up version in the dev message');

    console.log('[test-windows-support] Windows 10 and later are supported');
    console.log('[test-windows-support] Windows 8.1, 8, 7, Vista, XP and unreadable versions are refused by name');
    console.log('[test-windows-support] 32-bit and 64-bit builds both play; arm64 is refused by name');
    console.log('[test-windows-support] all assertions passed');
}

main();