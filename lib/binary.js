'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Reading what a Flash Player binary is -- its version and its CPU architectures -- from
// the file itself, without running it. Used to find a projector this machine can execute
// and to tell the player which build they are on.

function fileExists(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function directoryExists(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

// A macOS app bundle carries its build number in CFBundleVersion.
function versionFromMacBundle(bundlePath) {
    try {
        const infoPlist = path.join(bundlePath, 'Contents', 'Info.plist');
        const plist = fs.readFileSync(infoPlist, 'utf8');
        const match = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/);
        return match ? match[1].trim() : '';
    } catch {
        return '';
    }
}

function versionFromWindowsMetadata(bundlePath) {
    if (process.platform !== 'win32') {
        return '';
    }

    try {
        const output = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-Item -LiteralPath ${JSON.stringify(bundlePath)}).VersionInfo.FileVersion`
            ],
            { encoding: 'utf8', timeout: 15000, windowsHide: true }
        );
        return String(output || '').trim().replace(/,\s*/g, '.');
    } catch {
        return '';
    }
}

// A Flash Player projector is a separate process, so it only has to be something this
// machine can execute (lib/projector.js canExecute). Parsing the binary headers is how
// that is known before a game is started rather than after it fails to.

const MACH_CPU_TYPES = new Map([
    [0x00000007, 'ia32'],
    [0x01000007, 'x64'],
    [0x0100000c, 'arm64']
]);
const PE_MACHINE_TYPES = new Map([
    [0x014c, 'ia32'],
    [0x8664, 'x64'],
    [0xaa64, 'arm64']
]);
const ELF_MACHINE_TYPES = new Map([
    [0x0003, 'ia32'],
    [0x003e, 'x64'],
    [0x00b7, 'arm64']
]);

function readBinaryHeader(filePath, bytes) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(bytes);
        const read = fs.readSync(descriptor, header, 0, bytes, 0);
        return header.subarray(0, read);
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Nothing to recover; the header read already failed.
            }
        }
    }
}

function readMachOArchitectures(header) {
    if (header.length < 8) {
        return [];
    }

    const magic = header.readUInt32LE(0);
    if (magic === 0xfeedfacf) {
        const arch = MACH_CPU_TYPES.get(header.readUInt32LE(4));
        return arch ? [arch] : [];
    }

    // A universal binary carries one header entry per architecture, all big-endian.
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) {
        return [];
    }

    const entrySize = magic === 0xcafebabf ? 32 : 20;
    const count = header.readUInt32BE(4);
    const architectures = [];
    for (let index = 0; index < count; index += 1) {
        const offset = 8 + index * entrySize;
        if (header.length < offset + 4) {
            break;
        }
        const arch = MACH_CPU_TYPES.get(header.readUInt32BE(offset));
        if (arch && !architectures.includes(arch)) {
            architectures.push(arch);
        }
    }
    return architectures;
}

function readPEArchitectures(header) {
    if (header.length < 0x40 || header.toString('ascii', 0, 2) !== 'MZ') {
        return [];
    }

    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > header.length || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
        return [];
    }

    const arch = PE_MACHINE_TYPES.get(header.readUInt16LE(peOffset + 4));
    return arch ? [arch] : [];
}

function readELFArchitectures(header) {
    if (header.length < 20 || header.toString('ascii', 0, 4) !== '\x7fELF') {
        return [];
    }

    const arch = ELF_MACHINE_TYPES.get(header.readUInt16LE(18));
    return arch ? [arch] : [];
}

function parseBinaryArchitectures(filePath) {
    // 4 KiB covers every fixed header above, including a PE optional header that sits
    // behind a DOS stub.
    const header = readBinaryHeader(filePath, 4096);
    if (!header) {
        return [];
    }

    // A format that matches returns its architectures; an empty result means "not this
    // format", so the remaining readers still get a look at the header.
    for (const read of [readMachOArchitectures, readPEArchitectures, readELFArchitectures]) {
        const architectures = read(header);
        if (architectures.length) {
            return architectures;
        }
    }
    return [];
}

function macBundleExecutable(bundlePath) {
    if (!directoryExists(bundlePath)) {
        return bundlePath;
    }

    const macOsDirectory = path.join(bundlePath, 'Contents', 'MacOS');
    let entries = [];
    try {
        entries = fs.readdirSync(macOsDirectory);
    } catch {
        return '';
    }

    // Info.plist names the main executable; failing that, the first file in MacOS/ is it.
    try {
        const plist = fs.readFileSync(path.join(bundlePath, 'Contents', 'Info.plist'), 'utf8');
        const named = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/);
        if (named && fileExists(path.join(macOsDirectory, named[1].trim()))) {
            return path.join(macOsDirectory, named[1].trim());
        }
    } catch {
        // No readable Info.plist; fall through to the directory listing.
    }
    for (const entry of entries) {
        const candidate = path.join(macOsDirectory, entry);
        if (fileExists(candidate)) {
            return candidate;
        }
    }
    return '';
}

module.exports = {
    macBundleExecutable,
    parseBinaryArchitectures,
    versionFromMacBundle,
    versionFromWindowsMetadata
};
