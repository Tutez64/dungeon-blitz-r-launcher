#!/usr/bin/env node
'use strict';

/**
 * Checks that a Flash Player matches the fingerprint the build recorded in
 * lib/projector.integrity.json -- the same check a packaged launcher runs before every game.
 *
 * Run by the release workflow on the copy inside the finished package, so a package whose
 * own check would refuse to play can never be published.
 *
 * Usage: node tools/verify-projector.js <flashplayer_32_sa.exe | Flash Player.app | flashplayer> [--platform <p>]
 */

const { verifyProjector, readExpected } = require('../lib/integrity');

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'));
const platformIndex = args.indexOf('--platform');
const platform = platformIndex >= 0 ? args[platformIndex + 1] : process.platform;

if (!target) {
    console.error('Usage: node tools/verify-projector.js <path> [--platform win32|darwin|linux]');
    process.exit(1);
}

const result = verifyProjector(target, { platform });
const expected = readExpected();
if (!result.ok) {
    console.error(`[verify-projector] FAILED: ${target}: ${result.reason}`);
    process.exit(1);
}
console.log(`[verify-projector] ${target} matches fingerprint ${expected.digest}`);
