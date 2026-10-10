#!/usr/bin/env node
'use strict';

/**
 * Checks what the launcher window actually renders -- the status rows (Discord rich
 * presence, lobby chat, the widget profile, the version), the problem banner and the
 * account row --
 * for every combination of state, without needing Electron: renderer.js runs against a
 * minimal DOM stub and the results are read back.
 *
 * Usage: node tools/test-launcher-status.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class StubElement {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.hidden = false;
        this.disabled = false;
        this.className = '';
        this.textContent = '';
        this.title = '';
        this.listeners = {};
    }

    addEventListener(type, handler) {
        this.listeners[type] = handler;
    }

    append(...nodes) {
        this.children.push(...nodes);
    }

    replaceChildren(...nodes) {
        this.children = nodes;
    }

    querySelector() {
        if (!this.querySelectorStub) {
            this.querySelectorStub = new StubElement('span');
        }
        return this.querySelectorStub;
    }
}

/** Runs renderer/renderer.js in a stub DOM and hands back the elements it filled in. */
function loadRenderer() {
    const registry = new Map();
    const document = {
        getElementById: (id) => {
            if (!registry.has(id)) {
                registry.set(id, new StubElement());
            }
            return registry.get(id);
        },
        createElement: (tag) => new StubElement(tag)
    };

    let render = null;
    // Which engine each press of a play button asked for.
    const plays = [];
    const window = {
        launcher: {
            onState: (handler) => {
                render = handler;
            },
            // The test drives render() itself, so the initial fetch never settles.
            getState: () => new Promise(() => {}),
            play: async (engine) => {
                plays.push(engine);
                return { ok: true };
            },
            discordLogin: async () => ({ ok: true }),
            forgetDiscordLogin: async () => null,
            browseFlash: async () => null,
            moveToApplications: async () => ({ ok: true }),
            relaunch: () => {},
            gameStatsSync: async () => null,
            quit: () => {}
        }
    };

    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
    vm.runInNewContext(source, { document, window, console });

    assert.ok(render, 'renderer.js must register a state handler');
    return { render, registry, plays };
}

function rowsFrom(registry) {
    const status = registry.get('engine-status');
    return status.children.map((row) => {
        const [label, value] = row.children;
        return { label: label.textContent, value: value.textContent, tone: value.className, detail: value.title };
    });
}

function row(rows, label) {
    const found = rows.find((entry) => entry.label === label);
    assert.ok(found, `expected a "${label}" row`);
    return found;
}

function baseState(flash, social, extra = {}) {
    return {
        appVersion: '1.0.0',
        servers: [{ id: 'official', name: 'Dungeon Blitz: R', url: 'http://example.test/' }],
        selectedServerUrl: 'http://example.test/',
        serverReachable: true,
        gameRunning: false,
        gameEngine: extra.gameEngine || '',
        flash,
        flashBrowser: extra.flashBrowser,
        social,
        presence: extra.presence || {
            running: false,
            ready: false,
            port: 0,
            characterName: '',
            activity: '',
            lastError: ''
        },
        chat: extra.chat || { enabled: true, running: false, supported: null, relayed: 0, received: 0, lastError: '' },
        gameStats: extra.gameStats || {
            enabled: true,
            running: false,
            state: 'idle',
            written: false,
            username: '',
            updatedAt: 0,
            lastError: ''
        },
        update: extra.update || { state: 'not-available', percent: 0, version: '', error: '', currentVersion: '1.0.0' },
        windows: extra.windows || {
            supported: true,
            product: 'Windows 10 or later',
            reason: '',
            requirements: ''
        },
        install: extra.install || { relocate: false, reason: '', message: '', sourcePath: '', targetPath: '', canMove: false },
        discord: extra.discord || { linked: false, email: '', name: '', remembered: false, loginPending: false }
    };
}

const ARMED_FLASH = {
    found: true,
    armed: true,
    path: '/Applications/Dungeon Blitz R.app/Contents/Resources/vendor/projector/darwin/Flash Player.app',
    version: '32.0.0.465',
    source: 'vendor',
    architectures: ['x64'],
    archMismatch: false
};

const MISSING_FLASH = {
    found: false,
    armed: false,
    path: '',
    version: '',
    source: '',
    architectures: [],
    archMismatch: false
};

const READY_BROWSER = { offered: true, found: true, ready: true, locked: true, tampered: false, missing: [] };

const IDLE_SOCIAL = {
    enabled: true,
    running: false,
    lobbyReady: false,
    authPending: false,
    lobbyId: '',
    lastStatus: ''
};

/** The two play buttons: FlashBrowser first wherever there is one, Flash Player second. */
async function checkPlayButtons(render, registry, plays) {
    const press = async (id) => {
        await registry.get(id).listeners.click();
        // playWith() awaits the play() call; let it settle.
        await new Promise((resolve) => setImmediate(resolve));
    };

    // Windows x64 and macOS: FlashBrowser is the main button, Flash Player the second one.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }));
    assert.strictEqual(registry.get('play').disabled, false, 'FlashBrowser can be started');
    assert.strictEqual(registry.get('alt-engine').hidden, false, 'the Legacy button is offered next to it');
    assert.strictEqual(registry.get('play-projector').disabled, false);
    assert.strictEqual(registry.get('problem').hidden, true);
    plays.length = 0;
    await press('play');
    await press('play-projector');
    assert.deepStrictEqual(plays, ['flashbrowser', 'projector'], 'each button starts its own engine');

    // 32-bit Windows and Linux have no FlashBrowser: Legacy is still offered, and the main
    // button plays in Flash Player rather than sitting there unable to start.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: { offered: false, found: false, ready: false, missing: [] } }));
    assert.strictEqual(registry.get('alt-engine').hidden, false, 'the Legacy button is always offered');
    assert.strictEqual(registry.get('play').disabled, false);
    assert.strictEqual(registry.get('play-projector').disabled, false);
    plays.length = 0;
    await press('play');
    await press('play-projector');
    assert.deepStrictEqual(plays, ['projector', 'projector'], 'both buttons play in Flash Player');

    // A state from an older main process (no flashBrowser at all) still shows Legacy.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('alt-engine').hidden, false);

    // An install whose FlashBrowser is gone: said in the banner, and Flash Player still plays.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            flashBrowser: { offered: true, found: false, ready: false, locked: true, tampered: false, missing: [] }
        })
    );
    assert.strictEqual(registry.get('play').disabled, true, 'a missing FlashBrowser cannot be started');
    assert.strictEqual(registry.get('play-projector').disabled, false, 'Flash Player still can');
    assert.ok(registry.get('problem').textContent.includes('FlashBrowser is missing'), registry.get('problem').textContent);
    assert.ok(registry.get('problem').textContent.includes('Legacy'), 'the banner points at the Legacy button');

    // A FlashBrowser changed after installation is refused, the same as a changed Flash Player.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: { ...READY_BROWSER, ready: false, tampered: true } }));
    assert.strictEqual(registry.get('play').disabled, true);
    assert.ok(registry.get('problem').textContent.includes('changed after installation'));
    assert.strictEqual(registry.get('problem').className, 'problem bad');

    // A broken Flash Player leaves FlashBrowser playable.
    render(baseState({ ...ARMED_FLASH, armed: false, locked: true, tampered: true }, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }));
    assert.strictEqual(registry.get('play').disabled, false);
    assert.strictEqual(registry.get('play-projector').disabled, true);

    // Which engine the game is running in shows in the status line.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }));
    render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER, gameEngine: 'projector' }), gameRunning: true });
    assert.strictEqual(registry.get('status').textContent, 'The game is running (Legacy).');
    render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER, gameEngine: 'flashbrowser' }), gameRunning: true });
    assert.strictEqual(registry.get('status').textContent, 'The game is running.');

    console.log('[test-launcher-status] FlashBrowser is the main button and Legacy is always offered: OK');
}

async function main() {
    const { render, registry, plays } = loadRenderer();

    // Armed plugin, Discord reached, lobby chat connected, chat mirror running.
    render(
        baseState(
            ARMED_FLASH,
            { ...IDLE_SOCIAL, running: true, lobbyReady: true, lobbyId: 'lobby-1', lastStatus: 'Lobby chat connected.' },
            {
                presence: {
                    running: true,
                    ready: true,
                    port: 47631,
                    characterName: 'BridgeProbe',
                    activity: 'Home - Idling in town',
                    lastError: ''
                },
                chat: { enabled: true, running: true, supported: true, relayed: 3, received: 1, lastError: '' }
            }
        )
    );
    let rows = rowsFrom(registry);
    assert.deepStrictEqual(
        rows.map((entry) => [entry.label, entry.value, entry.tone]),
        [
            ['Discord status', 'Home - Idling in town', 'ok'],
            ['Lobby chat', 'connected', 'ok'],
            ['Game stats', 'starts with the game', 'muted'],
            ['Version', 'v1.0.0 - up to date', 'muted']
        ],
        'only the four rows a player cares about'
    );
    for (const hidden of ['Windows', 'Flash', 'In-game chat', 'Update']) {
        assert.ok(!rows.some((entry) => entry.label === hidden), `no ${hidden} row`);
    }
    assert.strictEqual(row(rows, 'Lobby chat').detail, 'Lobby chat connected.');
    assert.ok(row(rows, 'Discord status').detail.includes('47631'), 'the local presence endpoint is the tooltip');

    // A Flash Player that no longer matches the installed one: refused, and said so.
    // There is no Flash row any more: the banner is where it is said.
    render(baseState({ ...ARMED_FLASH, armed: false, locked: true, tampered: true }, IDLE_SOCIAL));
    assert.ok(registry.get('problem').textContent.includes('Reinstall'), registry.get('problem').textContent);
    assert.strictEqual(registry.get('play').disabled, true, 'a tampered Flash Player cannot be started');
    assert.strictEqual(registry.get('browse-flash').hidden, true, 'an installed launcher offers no Flash Player picker');

    // Everything idle is normal: presence and chat both start with the game.
    render(baseState(MISSING_FLASH, IDLE_SOCIAL));
    rows = rowsFrom(registry);
    assert.ok(registry.get('problem').textContent.includes('Flash Player is missing'), 'a missing Flash Player is in the banner');
    assert.strictEqual(row(rows, 'Discord status').value, 'starts with the game');
    assert.strictEqual(row(rows, 'Discord status').tone, 'muted');
    assert.strictEqual(row(rows, 'Lobby chat').value, 'starts with the game');

    // Discord closed while the game runs: presence cannot be published.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            presence: { running: true, ready: false, port: 47631, characterName: '', activity: '', lastError: 'Discord is not running.' }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Discord status').value, 'waiting for Discord');
    assert.strictEqual(row(rows, 'Discord status').tone, 'warn');
    assert.strictEqual(row(rows, 'Discord status').detail, 'Discord is not running.');

    // The widget row: a written profile is the one state that means the widget has data to
    // show -- which is exactly what a player sees, or does not see, on their own profile and
    // on a friend's.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'written',
                written: true,
                username: 'BridgeProbe',
                updatedAt: 1700000000000,
                lastError: ''
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'profile written');
    assert.strictEqual(row(rows, 'Game stats').tone, 'ok');
    assert.ok(row(rows, 'Game stats').detail.includes('BridgeProbe'), 'the account written for is the tooltip');
    assert.strictEqual(registry.get('game-stats-sync').hidden, false, 'the manual sync is offered during a session');

    // No linked Discord account: the widget has nobody to be written for, and that is a
    // different fix from a server fault.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'unlinked',
                written: false,
                username: '',
                updatedAt: 0,
                lastError: 'Sign in with Discord in the game so the widget has an account to write.'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'no Discord account linked');
    assert.strictEqual(row(rows, 'Game stats').tone, 'warn');
    assert.ok(row(rows, 'Game stats').detail.includes('Sign in with Discord'));

    // A server that has not been redeployed with the route: said plainly, so an empty widget
    // is not mistaken for a broken account.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'unsupported',
                written: false,
                username: '',
                updatedAt: 0,
                lastError: 'This server cannot write Discord widget stats yet.'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'server cannot write it');
    assert.strictEqual(row(rows, 'Game stats').tone, 'warn');

    // On the sign-in screen there is no session to ask, so there is no button to press.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('game-stats-sync').hidden, true, 'no sync button without a session');

    // Lobby chat turned off by configuration.
    render(baseState(ARMED_FLASH, { ...IDLE_SOCIAL, enabled: false }));
    assert.strictEqual(row(rowsFrom(registry), 'Lobby chat').value, 'off');

    // Waiting for the Discord consent dialog.
    render(
        baseState(ARMED_FLASH, { ...IDLE_SOCIAL, running: true, authPending: true, lastStatus: 'Asking Discord to authorize the launcher...' })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Lobby chat').value, 'waiting for Discord approval');
    assert.strictEqual(row(rows, 'Lobby chat').tone, 'warn');
    assert.strictEqual(row(rows, 'Lobby chat').detail, 'Asking Discord to authorize the launcher...');

    // Starting up, nothing settled yet.
    render(baseState(ARMED_FLASH, { ...IDLE_SOCIAL, running: true, lastStatus: 'JavaScript social bridge starting...' }));
    assert.strictEqual(row(rowsFrom(registry), 'Lobby chat').value, 'connecting...');

    // The Discord client being closed is the common "never connects" cause; the row must
    // name it instead of leaving an errno to decode.
    render(
        baseState(ARMED_FLASH, {
            ...IDLE_SOCIAL,
            running: true,
            lastStatus: 'The Discord desktop client is not running. Start Discord, then start the game again.'
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Lobby chat').value, 'Discord client not running');
    assert.strictEqual(row(rows, 'Lobby chat').tone, 'bad');

    // The Version row: this launcher's version, quiet when up to date, loud when an install
    // is waiting.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'downloading', percent: 42, version: '1.1.0', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0 - downloading 1.1.0 (42%)');
    assert.strictEqual(row(rows, 'Version').tone, 'warn');
    assert.strictEqual(registry.get('update-install').hidden, true, 'no restart button mid-download');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'downloaded', percent: 100, version: '1.1.0', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0 - 1.1.0 ready, restart to install');
    assert.strictEqual(row(rows, 'Version').tone, 'ok');
    assert.strictEqual(registry.get('update-install').hidden, false, 'the restart button appears when the update is complete');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'disabled', percent: 0, version: '', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0', 'a development checkout shows just its version');
    assert.strictEqual(registry.get('update-install').hidden, true);

    // A remembered account replaces the sign-in button entirely.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            discord: { linked: true, email: 'player@example.test', name: 'neodevils', remembered: true, loginPending: false }
        })
    );
    assert.strictEqual(registry.get('discord-login').hidden, true, 'no sign-in button once the account is known');
    assert.strictEqual(registry.get('account').hidden, false);
    assert.strictEqual(registry.get('account-name').textContent, 'Signed in as neodevils');
    assert.strictEqual(registry.get('status').textContent, 'Ready to play.');

    // Neither a name nor an email is still an account: fall back to the email, then to none.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            discord: { linked: true, email: 'player@example.test', name: '', remembered: true, loginPending: false }
        })
    );
    assert.strictEqual(registry.get('account-name').textContent, 'Signed in as player@example.test');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('discord-login').hidden, false, 'a fresh install still offers the button');
    assert.strictEqual(registry.get('account').hidden, true);

    // A copy running from a disk image or from Downloads says so, and offers the move.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            install: {
                relocate: true,
                reason: 'disk-image',
                message: 'The launcher is running from a mounted disk image.',
                sourcePath: '/Volumes/Dungeon Blitz R/Dungeon Blitz R.app',
                targetPath: '/Applications/Dungeon Blitz R.app',
                canMove: true
            }
        })
    );
    assert.strictEqual(registry.get('problem').hidden, false);
    assert.ok(registry.get('problem').textContent.includes('/Applications/Dungeon Blitz R.app'));
    assert.strictEqual(registry.get('move-app').hidden, false);

    // An installed copy shows neither.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { install: { relocate: false, reason: '', message: '', sourcePath: '', targetPath: '', canMove: false } }));
    assert.strictEqual(registry.get('problem').hidden, true);
    assert.strictEqual(registry.get('move-app').hidden, true);

    console.log('[test-launcher-status] status rows and the account row render correctly in every state');

    await checkPlayButtons(render, registry, plays);
    console.log('[test-launcher-status] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
