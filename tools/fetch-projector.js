#!/usr/bin/env node
'use strict';

/**
 * Downloads Adobe's standalone Flash Player -- flashplayer_32_sa, the "projector" -- for
 * one platform and unpacks it into vendor/projector/<platform>/, which is where packaging
 * picks it up (build.extraResources) and where the launcher looks first.
 *
 * Adobe stopped distributing Flash in 2021, so the binary is not something a build can
 * assume is on the machine. It is fetched from Adobe's own update server, with the
 * Internet Archive's capture of the same URL as the fallback, and checked against the
 * SHA-256 pinned in projector.lock.json: whichever mirror answers, the bytes that ship are
 * the bytes that were checked once.
 *
 * Usage:
 *   node tools/fetch-projector.js [--platform win32|darwin|linux] [--force]
 *   node tools/fetch-projector.js --platform darwin --print-hash   # learn a hash to pin
 *
 * Whatever ends up in vendor/ is then fingerprinted into lib/projector.integrity.json,
 * which is packed into the app's own code: a packaged launcher refuses to start a Flash
 * Player that does not match it (lib/integrity.js).
 *
 * Needs Node 18+ (global fetch). The macOS image is unpacked with hdiutil, so the darwin
 * projector has to be fetched on a Mac -- which is where the macOS package is built anyway.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(LAUNCHER_ROOT, 'projector.lock.json');
const VENDOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor', 'projector');

function parseArgs(argv) {
    const args = { platform: process.platform, force: false, printHash: false };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--platform' && argv[index + 1]) {
            args.platform = String(argv[index + 1]);
            index += 1;
        } else if (argv[index] === '--force') {
            args.force = true;
        } else if (argv[index] === '--print-hash') {
            args.printHash = true;
        }
    }
    return args;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function download(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/** Tries each mirror in turn and returns the first download whose hash matches. */
async function fetchVerified(entry, { printHash }) {
    const failures = [];
    for (const url of entry.urls) {
        let body;
        try {
            body = await download(url);
        } catch (error) {
            failures.push(`${url}: ${error.message}`);
            continue;
        }

        const hash = sha256(body);
        console.log(`[fetch-projector] ${url} -> ${body.length} bytes, sha256 ${hash}`);
        if (printHash) {
            return body;
        }
        if (!entry.sha256) {
            throw new Error(
                `no sha256 is pinned for ${entry.file} in projector.lock.json. Check the download, then pin ${hash}.`
            );
        }
        if (hash === entry.sha256) {
            return body;
        }
        failures.push(`${url}: sha256 ${hash} does not match the pinned ${entry.sha256}`);
    }
    throw new Error(`could not fetch ${entry.file}:\n  ${failures.join('\n  ')}`);
}

function unpackWindows(body, target) {
    fs.writeFileSync(path.join(target, 'flashplayer_32_sa.exe'), body);
}

function unpackLinux(body, target, scratch) {
    const archive = path.join(scratch, 'projector.tar.gz');
    fs.writeFileSync(archive, body);
    const extracted = path.join(scratch, 'extracted');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'inherit' });
    const binary = path.join(extracted, 'flashplayer');
    if (!fs.existsSync(binary)) {
        throw new Error(`the Linux archive has no flashplayer binary (found: ${fs.readdirSync(extracted).join(', ')})`);
    }
    fs.copyFileSync(binary, path.join(target, 'flashplayer'));
    fs.chmodSync(path.join(target, 'flashplayer'), 0o755);
}

function unpackMac(body, target, scratch) {
    if (process.platform !== 'darwin') {
        throw new Error('the macOS projector is a disk image; fetch it on a Mac (hdiutil unpacks it).');
    }
    const image = path.join(scratch, 'projector.dmg');
    fs.writeFileSync(image, body);
    const mountPoint = path.join(scratch, 'mount');
    fs.mkdirSync(mountPoint);
    execFileSync('hdiutil', ['attach', image, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint], {
        stdio: 'inherit'
    });
    try {
        const app = fs.readdirSync(mountPoint).find((entry) => /^Flash Player.*\.app$/i.test(entry));
        if (!app) {
            throw new Error(`the disk image has no Flash Player app (found: ${fs.readdirSync(mountPoint).join(', ')})`);
        }
        // ditto keeps the bundle's symlinks, permissions and Adobe's signature intact; a
        // plain recursive copy does not.
        execFileSync('ditto', [path.join(mountPoint, app), path.join(target, 'Flash Player.app')], { stdio: 'inherit' });
    } finally {
        execFileSync('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'inherit' });
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    const entry = lock[args.platform];
    if (!entry) {
        console.error(`[fetch-projector] Unknown platform: ${args.platform} (expected win32, darwin or linux)`);
        process.exit(1);
    }

    const target = path.join(VENDOR_ROOT, args.platform);
    const { projectorInDirectory } = require('../lib/projector');
    const existing = projectorInDirectory(target, args.platform);
    if (existing && !args.force && !args.printHash) {
        console.log(`[fetch-projector] ${args.platform}: already present -> ${existing} (--force to fetch again)`);
        fingerprint(existing, args.platform, lock.version);
        return;
    }

    const body = await fetchVerified(entry, args);
    if (args.printHash) {
        return;
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-projector-'));
    try {
        if (args.platform === 'win32') {
            unpackWindows(body, target);
        } else if (args.platform === 'linux') {
            unpackLinux(body, target, scratch);
        } else {
            unpackMac(body, target, scratch);
        }
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }

    const installed = projectorInDirectory(target, args.platform);
    if (!installed) {
        throw new Error(`nothing usable was unpacked into ${target}`);
    }
    console.log(`[fetch-projector] ${args.platform}: Flash Player ${lock.version} -> ${installed}`);
    fingerprint(installed, args.platform, lock.version);
}

function fingerprint(projectorPath, platform, version) {
    const { writeExpected } = require('../lib/integrity');
    const record = writeExpected(projectorPath, { platform, version });
    console.log(`[fetch-projector] fingerprint ${record.digest} -> lib/projector.integrity.json`);
}

main().catch((error) => {
    console.error(`[fetch-projector] ERROR: ${error.message}`);
    process.exit(1);
});
