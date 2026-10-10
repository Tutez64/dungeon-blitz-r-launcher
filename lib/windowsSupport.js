'use strict';

const os = require('os');

/**
 * Which Windows versions this launcher runs on.
 *
 * Electron sets the floor: since version 23 it runs on Windows 10 and later only, so a
 * Windows 7, 8 or 8.1 machine cannot start the launcher. Most of those never reach this
 * check -- the runtime fails before any of the launcher's code runs -- but the rule is still
 * written down here, so whatever does get this far is refused by name rather than left on
 * a window that cannot work.
 *
 * The rule is one function that can be tested from any machine: `os.release()` is a
 * parameter rather than a call. tools/test-windows-support.js walks every Windows version
 * through it without an Electron runtime, a Windows box, or a network.
 */

/** What the launcher needs at the very least. Named in the refusal dialog and the README. */
const MINIMUM_WINDOWS = 'Windows 10';

/**
 * The process architectures there is a Windows build of.
 *
 * The game runs in Adobe's standalone Flash Player, flashplayer_32_sa.exe, which is a
 * 32-bit program in its own process: it runs on 32-bit and 64-bit Windows alike, so both
 * launcher builds can play. (The PPAPI plugin the launcher used before was x86_64 and loaded
 * in-process, which is what used to make the 32-bit build unplayable.)
 */
const SUPPORTED_ARCHITECTURES = ['x64', 'ia32'];

/**
 * The refusal text for a launcher running as an architecture there is no build of.
 *
 * `version` names the exact file to download, so the player does not have to work out
 * which of the release's files replaces the one they took.
 *
 * @param {{arch: string, platform: string}} status
 * @param {{version?: string}} [options] The running version, to name the file exactly.
 * @returns {string}
 */
function unsupportedArchitectureMessage(status, options = {}) {
    // "an arm64 process" -- the article has to agree with the architecture.
    const arch = String(status.arch || 'unknown');
    const article = /^[aeiou]/i.test(arch) ? 'an' : 'a';
    const detected = `${article} ${arch} process`;

    // The artifact name comes from build.nsis.artifactName in package.json. A launcher
    // with no version to hand (a development run) gets the unversioned name rather than
    // a filename that does not exist on the releases page.
    const version = String(options.version || '').trim();
    const installer = version
        ? `DungeonBlitzR-Launcher-${version}-win-x64-setup.exe`
        : 'DungeonBlitzR-Launcher-<version>-win-x64-setup.exe';

    return [
        `There is no build of this launcher for ${detected}.`,
        '',
        `Running on: ${detected} (${status.platform})`,
        '',
        'Uninstall it and download this file instead:',
        '',
        `    ${installer}`,
        '',
        'It is on this release\'s page, named exactly like that.'
    ].join('\n');
}

/**
 * The Windows kernels, as `os.release()` reports them: "10.0.19045", "6.1.7601", and so
 * on. Only the 10.0 kernel is one Electron runs on; the older entries are listed so the
 * refusal can name the Windows it refused.
 *
 * A major of 10 covers Windows 10 and Windows 11 alike -- both report a 10.0 kernel -- so
 * the product name says "or later" rather than guessing from the build.
 */
const WINDOWS_RELEASES = [
    { major: 10, product: 'Windows 10 or later' },
    { major: 6, minor: 3, product: 'Windows 8.1', unsupported: true },
    { major: 6, minor: 2, product: 'Windows 8', unsupported: true },
    { major: 6, minor: 1, product: 'Windows 7', unsupported: true },
    { major: 6, minor: 0, product: 'Windows Vista', unsupported: true }
];

/**
 * Splits an `os.release()` string into its kernel numbers.
 *
 * @returns {{major: number, minor: number, build: number, version: string}|null} `null`
 *   when the string is not a Windows kernel version at all.
 */
function parseRelease(release) {
    const parts = String(release || '')
        .split('.')
        .map((part) => Number.parseInt(part, 10));

    if (parts.length < 2 || parts.some((part) => !Number.isInteger(part))) {
        return null;
    }

    return {
        major: parts[0],
        minor: parts[1],
        build: parts.length > 2 && Number.isInteger(parts[2]) ? parts[2] : 0,
        version: `${parts[0]}.${parts[1]}`
    };
}

function findRelease(major, minor) {
    return WINDOWS_RELEASES.find((entry) => entry.major === major && (entry.minor === undefined || entry.minor === minor));
}

/**
 * Reads the Windows this is and decides whether the launcher can run on it.
 *
 * @param {{platform?: string, release?: string, arch?: string}} [options] All default to this
 *   process, so the common call is argument-free; the parameters are what make every
 *   Windows version and both architectures testable from any machine.
 * @returns {{
 *   platform: string, release: string, product: string, build: number, arch: string,
 *   supported: boolean, architectureSupported: boolean, reason: string, requirements: string
 * }}
 */
function describeWindows(options = {}) {
    const platform = options.platform === undefined ? process.platform : String(options.platform);
    const release = options.release === undefined ? String(os.release() || '') : String(options.release);
    const arch = options.arch === undefined ? String(process.arch || '') : String(options.arch);

    const status = {
        platform,
        release,
        product: '',
        build: 0,
        arch,
        // Checked before the refusal text is chosen, so a build for an architecture that has
        // none is told about the architecture rather than the version.
        architectureSupported: SUPPORTED_ARCHITECTURES.includes(arch),
        supported: true,
        reason: '',
        requirements: ''
    };

    // macOS and Linux have none of this: nothing to classify.
    if (platform !== 'win32') {
        return status;
    }

    // Checked before the version, because "this Windows is too old" would be the wrong
    // answer there. The product name is resolved first only so the refusal can say which
    // Windows it is on.
    if (!status.architectureSupported) {
        const parsedForName = parseRelease(release);
        const knownForName = parsedForName && findRelease(parsedForName.major, parsedForName.minor);

        status.supported = false;
        status.build = parsedForName ? parsedForName.build : 0;
        status.product = knownForName ? `${knownForName.product} (${arch})` : `Windows (${arch})`;
        status.reason = `There is no build of this launcher for ${arch} Windows.`;
        status.requirements = 'Install the x64 launcher (win-x64) instead.';
        return status;
    }

    const parsed = parseRelease(release);
    if (!parsed) {
        status.supported = false;
        status.reason = `The Windows version could not be read from "${release}".`;
        status.requirements = `This launcher needs ${MINIMUM_WINDOWS}.`;
        return status;
    }

    status.build = parsed.build;

    const known = findRelease(parsed.major, parsed.minor);
    // A kernel newer than the table is a Windows after 10; anything else missing from it is
    // older (Windows XP and Server 2003 report a 5.x kernel).
    status.product = known ? known.product : `Windows ${parsed.version}`;
    status.supported = known ? !known.unsupported : parsed.major > 10;

    if (!status.supported) {
        status.reason = `${status.product} is older than ${MINIMUM_WINDOWS}.`;
        status.requirements = `This launcher needs ${MINIMUM_WINDOWS}.`;
    }

    return status;
}

/**
 * The refusal text for a Windows the runtime cannot run on.
 *
 * @param {ReturnType<typeof describeWindows>} status
 * @returns {string}
 */
function unsupportedWindowsMessage(status) {
    const detected = status.product || `Windows ${status.release || 'unknown'}`;

    return [
        `This launcher needs ${MINIMUM_WINDOWS} or later.`,
        '',
        `Running on: ${detected} (${status.release})`,
        status.reason,
        '',
        'See "Windows versions" in the launcher README.'
    ].join('\n');
}

module.exports = {
    MINIMUM_WINDOWS,
    SUPPORTED_ARCHITECTURES,
    describeWindows,
    unsupportedArchitectureMessage,
    unsupportedWindowsMessage
};
