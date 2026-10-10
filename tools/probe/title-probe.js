#!/usr/bin/env node
'use strict';

// Experiment: what title does Flash Player's window get for each way of starting the game?
// Usage: node tools/probe/title-probe.js <platform> <outDir>
// For each variant it starts the projector, waits, runs the platform's title/screenshot
// helper, and stops it. Not part of the launcher.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { findProjector, projectorCommand, resolveSwfUrl } = require('../../lib/projector');
const { buildLoaderSwf } = require('../../lib/loaderSwf');

const [platform, outDir] = process.argv.slice(2);
const SERVER = 'http://dungeonblitzr.theminesa.studio/';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function helper(kind, pid, label) {
    const script = path.join(__dirname, platform === 'win32' ? `${kind}.ps1` : `${kind}.sh`);
    const command = platform === 'win32' ? 'pwsh' : 'bash';
    const args = platform === 'win32' ? ['-NoProfile', '-File', script, String(pid), outDir, label] : [script, String(pid), outDir, label];
    try {
        const output = execFileSync(command, args, { encoding: 'utf8', timeout: 60000 });
        console.log(output.trim());
    } catch (error) {
        console.log(`[${label}] ${kind} failed: ${error.message}\n${error.stdout || ''}${error.stderr || ''}`);
    }
}

async function run(label, target, { retitle = false, cwd } = {}) {
    const projector = findProjector({ vendorOnly: true });
    const { command } = projectorCommand(projector, target);
    console.log(`\n=== ${label}: ${command} ${target}${cwd ? ` (cwd ${cwd})` : ''}`);
    const child = spawn(command, [target], { stdio: 'ignore', cwd });
    await sleep(25000);
    helper('titles', child.pid, label);
    helper('network', child.pid, label);
    if (retitle) {
        helper('retitle', child.pid, label);
        await sleep(3000);
        helper('titles', child.pid, `${label}-after-retitle`);
    }
    try {
        child.kill();
    } catch {
        // gone
    }
    await sleep(3000);
}

(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const swfUrl = await resolveSwfUrl(SERVER);
    console.log(`game SWF: ${swfUrl}`);

    const loaderDir = path.join(outDir, 'loader');
    fs.mkdirSync(loaderDir, { recursive: true });
    const plain = path.join(loaderDir, 'Dungeon Blitz R.swf');
    fs.writeFileSync(plain, buildLoaderSwf(swfUrl));

    await run('url', swfUrl, { retitle: platform === 'win32' || platform === 'linux' });
    await run('loader-swf', plain);
    if (platform !== 'win32') {
        const colon = path.join(loaderDir, 'Dungeon Blitz: R');
        fs.writeFileSync(colon, buildLoaderSwf(swfUrl));
        // The bare name, run from its own folder: the title is the argument as given.
        await run('loader-bare-name', 'Dungeon Blitz: R', { cwd: loaderDir });
    } else {
        await run('loader-bare-name', 'Dungeon Blitz R.swf', { cwd: loaderDir, retitle: true });
    }
})();
