'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Tamper checks for the Flash Player a packaged launcher runs, and for its FlashBrowser.
 *
 * At build time tools/fetch-projector.js records a digest of the Flash Player it unpacked
 * in lib/projector.integrity.json. That file is packed into the app's own code (the asar),
 * not next to the player, so replacing or patching the player in the install folder no
 * longer matches what the launcher expects -- and a packaged launcher refuses to start a
 * Flash Player whose digest does not match.
 *
 * The digest covers a single file (Windows, Linux) or a whole bundle (macOS): every file's
 * path and SHA-256, and every symlink's target, so adding, removing or editing anything in
 * Flash Player.app changes it.
 *
 * FlashBrowser (lib/flashBrowser.js) is checked the same way, as one tree -- the Electron 11
 * runtime, the game-window app and the Flash plugin together -- against its own record,
 * lib/flashbrowser.integrity.json.
 */

const INTEGRITY_PATH = path.join(__dirname, 'projector.integrity.json');

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        let read;
        while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

function collect(root, relative, lines) {
    const full = relative ? path.join(root, relative) : root;
    const stat = fs.lstatSync(full);
    // Paths are recorded with forward slashes so a digest means the same on every platform.
    const name = relative.split(path.sep).join('/');

    if (stat.isSymbolicLink()) {
        lines.push(`L ${name} -> ${fs.readlinkSync(full)}`);
        return;
    }
    if (stat.isDirectory()) {
        lines.push(`D ${name}`);
        for (const entry of fs.readdirSync(full).sort()) {
            collect(root, relative ? path.join(relative, entry) : entry, lines);
        }
        return;
    }
    lines.push(`F ${name} ${sha256File(full)}`);
}

/**
 * The digest of a file or a directory tree.
 *
 * @param {string} target
 * @returns {string} hex SHA-256; '' when the target cannot be read.
 */
function treeDigest(target) {
    try {
        const lines = [];
        collect(target, '', lines);
        return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
    } catch {
        return '';
    }
}

/** What the build recorded for this platform's Flash Player, or null when nothing was. */
function readExpected(integrityPath = INTEGRITY_PATH) {
    try {
        const record = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
        if (record && typeof record.digest === 'string' && /^[0-9a-f]{64}$/.test(record.digest)) {
            return record;
        }
    } catch {
        // Missing or unreadable: the caller decides what that means.
    }
    return null;
}

/**
 * Whether a file or folder is the one this build shipped, against the record in
 * `integrityPath`.
 *
 * @param {string} target
 * @param {{ integrityPath?: string, platform?: string, label?: string }} [options] `platform`
 *   is what the record must have been made for; `label` names the thing in the reasons.
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyTree(target, options = {}) {
    const expected = readExpected(options.integrityPath);
    const platform = options.platform || process.platform;
    const label = options.label || 'Flash Player';
    if (!expected) {
        return { ok: false, reason: `this build carries no ${label} fingerprint` };
    }
    if (expected.platform && expected.platform !== platform) {
        return { ok: false, reason: `this build's ${label} fingerprint is for ${expected.platform}` };
    }
    if (path.basename(target) !== expected.name) {
        return { ok: false, reason: `expected ${expected.name}, found ${path.basename(target)}` };
    }
    const actual = treeDigest(target);
    if (!actual) {
        return { ok: false, reason: `${label} could not be read` };
    }
    if (actual !== expected.digest) {
        return { ok: false, reason: `${label} files were changed after installation` };
    }
    return { ok: true, reason: '' };
}

/**
 * Whether a Flash Player is the one this build shipped.
 *
 * @param {string} projectorPath The executable (Windows, Linux) or the .app bundle (macOS).
 * @param {{ integrityPath?: string, platform?: string }} [options]
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyProjector(projectorPath, options = {}) {
    return verifyTree(projectorPath, { ...options, label: 'Flash Player' });
}

/**
 * Records the digest of a freshly unpacked Flash Player (tools/fetch-projector.js) or
 * FlashBrowser (tools/fetch-flash-browser.js, with its own `integrityPath`).
 */
function writeExpected(projectorPath, { platform, version }, integrityPath = INTEGRITY_PATH) {
    const record = {
        platform,
        version,
        name: path.basename(projectorPath),
        digest: treeDigest(projectorPath)
    };
    if (!record.digest) {
        throw new Error(`could not fingerprint ${projectorPath}`);
    }
    fs.writeFileSync(integrityPath, `${JSON.stringify(record, null, 4)}\n`);
    return record;
}

module.exports = { INTEGRITY_PATH, readExpected, treeDigest, verifyProjector, verifyTree, writeExpected };
