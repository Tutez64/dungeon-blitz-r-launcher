'use strict';

const elements = {
    discordLogin: document.getElementById('discord-login'),
    play: document.getElementById('play'),
    altEngine: document.getElementById('alt-engine'),
    playProjector: document.getElementById('play-projector'),
    status: document.getElementById('status'),
    problem: document.getElementById('problem'),
    repair: document.getElementById('repair'),
    browseFlash: document.getElementById('browse-flash'),
    relaunch: document.getElementById('relaunch'),
    moveApp: document.getElementById('move-app'),
    account: document.getElementById('account'),
    accountName: document.getElementById('account-name'),
    forget: document.getElementById('forget'),
    versions: document.getElementById('versions'),
    updateInstall: document.getElementById('update-install'),
    gameStatsSync: document.getElementById('game-stats-sync'),
    quit: document.getElementById('quit'),
    engineStatus: document.getElementById('engine-status')
};

/**
 * The rows under the problem banner, kept to what a player cares about: whether Discord
 * shows them as playing, whether their lobby chat is connected, whether their widget
 * profile was written, and which version they run. The values stay short and the detail
 * (last status, last error) moves into the tooltip.
 *
 * Machine and engine details -- the Windows build, the Flash Player path, the chat mirror's
 * counters -- are not rows: a fault there is said in the problem banner above instead, which
 * is where it can be acted on.
 */
function engineRows(state) {
    const social = state.social || {};
    const presence = state.presence || {};
    const widget = state.gameStats || {};

    // "Starts with the game" is the normal state on the sign-in screen: the bridge is
    // deliberately idle until a game session asks for it.
    let socialValue = 'starts with the game';
    let socialTone = 'muted';
    let socialDetail = social.lastStatus || '';
    if (!social.enabled) {
        socialValue = 'off';
    } else if (social.lobbyReady) {
        socialValue = 'connected';
        socialTone = 'ok';
    } else if (social.authPending) {
        socialValue = 'waiting for Discord approval';
        socialTone = 'warn';
    } else if (/Discord desktop client is not running/i.test(social.lastStatus || '')) {
        // The one "lobby never connects" cause a player can fix themselves; say it instead
        // of leaving a generic "connecting..." to decode.
        socialValue = 'Discord client not running';
        socialTone = 'bad';
    } else if (social.running) {
        socialValue = 'connecting...';
        socialTone = 'warn';
    }

    // Discord's own window is the only place rich presence can be seen, so this row is
    // what tells the difference between "Discord has it" and "nothing was ever sent".
    let presenceValue = 'starts with the game';
    let presenceTone = 'muted';
    let presenceDetail = 'Rich presence is served by the launcher while the game runs.';
    if (presence.ready) {
        presenceValue = presence.activity || (presence.characterName ? `playing ${presence.characterName}` : 'connected');
        presenceTone = 'ok';
        presenceDetail = ['Discord client reached', presence.port ? `local endpoint 127.0.0.1:${presence.port}` : '']
            .filter(Boolean)
            .join(' - ');
    } else if (presence.running) {
        presenceValue = 'waiting for Discord';
        presenceTone = 'warn';
        presenceDetail = presence.lastError || 'The Discord desktop client is not reachable.';
    } else if (presence.lastError) {
        presenceValue = 'unavailable';
        presenceTone = 'bad';
        presenceDetail = presence.lastError;
    }

    // The version row: the version this launcher is, and what the updater is doing about the
    // next one. Quiet unless there is something a player can act on: a downloaded update is
    // 'ok' (the restart button appears below), a check failure stays 'muted' -- offline
    // moments and unsigned-macOS limits are not launcher faults.
    const update = state.update || {};
    const current = `v${state.appVersion || update.currentVersion || ''}`;
    let updateValue = `${current} - up to date`;
    let updateTone = 'muted';
    let updateDetail = 'The launcher checks GitHub for a newer version after start and every six hours.';
    if (update.state === 'disabled') {
        updateValue = current;
        updateDetail = 'Updates are checked only in an installed launcher.';
    } else if (update.state === 'downloading') {
        updateValue = update.percent
            ? `${current} - downloading ${update.version} (${update.percent}%)`
            : `${current} - downloading ${update.version}`;
        updateTone = 'warn';
    } else if (update.state === 'downloaded') {
        updateValue = `${current} - ${update.version} ready, restart to install`;
        updateTone = 'ok';
    } else if (update.state === 'checking') {
        updateValue = `${current} - checking...`;
    }

    // The Discord widget is filled by the game server, which holds the bot token; the
    // launcher only asks. So this row is where "the widget is empty" stops being a guess:
    // it says whether a profile was written, and when it was not, which half is missing.
    let widgetValue = 'starts with the game';
    let widgetTone = 'muted';
    let widgetDetail = 'The server writes your Discord widget profile when you play.';
    if (widget.enabled === false) {
        widgetValue = 'off';
        widgetDetail = 'Disabled with DUNGEON_BLITZ_GAME_STATS=0.';
    } else if (widget.state === 'syncing') {
        widgetValue = 'writing...';
    } else if (widget.state === 'written') {
        const writtenAt = widget.updatedAt ? new Date(widget.updatedAt).toLocaleTimeString() : '';
        widgetValue = 'profile written';
        widgetTone = 'ok';
        widgetDetail = [
            `Discord has a widget profile${widget.username ? ` for ${widget.username}` : ''}.`,
            writtenAt ? `Last written at ${writtenAt}.` : ''
        ]
            .filter(Boolean)
            .join(' ');
    } else if (widget.state === 'unlinked') {
        widgetValue = 'no Discord account linked';
        widgetTone = 'warn';
        widgetDetail = widget.lastError;
    } else if (widget.state === 'unsupported') {
        widgetValue = 'server cannot write it';
        widgetTone = 'warn';
        widgetDetail = widget.lastError;
    } else if (widget.state === 'error') {
        widgetValue = 'failed';
        widgetTone = 'warn';
        widgetDetail = widget.lastError;
    }

    return [
        { label: 'Discord status', value: presenceValue, tone: presenceTone, detail: presenceDetail },
        { label: 'Lobby chat', value: socialValue, tone: socialTone, detail: socialDetail },
        { label: 'Game stats', value: widgetValue, tone: widgetTone, detail: widgetDetail },
        { label: 'Version', value: updateValue, tone: updateTone, detail: updateDetail }
    ];
}

function renderEngineStatus(state) {
    const rows = engineRows(state).map((row) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'engine-row';

        const label = document.createElement('dt');
        label.textContent = row.label;

        const value = document.createElement('dd');
        value.className = row.tone;
        value.textContent = row.value;
        if (row.detail) {
            value.title = row.detail;
        }

        wrapper.append(label, value);
        return wrapper;
    });

    elements.engineStatus.replaceChildren(...rows);
}

let currentState = null;

function showProblem(message, severity) {
    elements.problem.hidden = !message;
    elements.problem.textContent = message || '';
    elements.problem.className = severity === 'bad' ? 'problem bad' : 'problem';
    elements.repair.hidden = !message;
    // An installed launcher runs only its own, verified Flash Player: nothing to choose.
    elements.browseFlash.hidden = Boolean(currentState && currentState.flash && currentState.flash.locked);
}

/**
 * A copy running from a mounted disk image or from Downloads is a copy the next build will
 * not replace -- the quiet way players end up on a launcher that no longer works. The
 * banner stays until the app has been moved.
 */
function installWarning(state) {
    const install = state.install || {};
    if (!install.relocate) {
        return null;
    }

    return {
        message: install.canMove
            ? `${install.message} Move it to ${install.targetPath}.`
            : install.message,
        severity: 'warn'
    };
}

/**
 * The two play buttons, always both on screen. The main one is FlashBrowser -- the game page
 * with the Flash plugin, the default. The second is Legacy: Adobe Flash Player 32, the
 * standalone player, for players who see a delay collecting loot. Where there is no
 * FlashBrowser (32-bit Windows, Linux) the main button plays in Flash Player too, so it never
 * sits there unable to start.
 */
function playButtons(state) {
    const flash = state.flash || {};
    const browser = state.flashBrowser || {};
    const hasServers = Array.isArray(state.servers) && state.servers.length > 0;
    const projectorPlayable = Boolean(flash.armed && !flash.archMismatch && hasServers);

    if (!browser.offered) {
        return { mainEngine: 'projector', mainPlayable: projectorPlayable, projectorPlayable };
    }
    return { mainEngine: 'flashbrowser', mainPlayable: Boolean(browser.ready && hasServers), projectorPlayable };
}

function applyPlayButtons(state) {
    const buttons = playButtons(state);
    elements.play.disabled = !buttons.mainPlayable;
    elements.altEngine.hidden = false;
    elements.playProjector.disabled = !buttons.projectorPlayable;
    return buttons;
}

/** What is wrong with FlashBrowser, when this system has one and it cannot run. */
function flashBrowserProblem(state) {
    const browser = state.flashBrowser || {};
    if (!browser.offered) {
        return null;
    }
    if (browser.tampered) {
        return {
            message:
                'The FlashBrowser files were changed after installation, so it will not start. ' +
                'Reinstall the launcher, or play Legacy below.',
            severity: 'bad'
        };
    }
    if (!browser.found) {
        return {
            message: browser.locked
                ? 'FlashBrowser is missing from this install. Reinstall the launcher, or play Legacy below.'
                : 'FlashBrowser is missing. Run `npm run fetch-flash-browser`, or play Legacy below.',
            severity: 'warn'
        };
    }
    return null;
}

// One line, because the launcher is a sign-in screen: whatever is currently keeping the
// player out of the game, or how far the sign-in has got.
function statusLine(state) {
    if (state.gameRunning) {
        return state.gameEngine === 'projector' ? 'The game is running (Legacy).' : 'The game is running.';
    }
    if (state.discord.loginPending) {
        return 'Finish signing in in your browser...';
    }
    if (state.discord.linked) {
        return state.discord.remembered ? 'Ready to play.' : `${accountLabel(state.discord)}.`;
    }
    if (state.serverReachable === false) {
        return 'The server is not responding.';
    }
    if (state.serverReachable === null) {
        return 'Checking the server...';
    }
    return 'Sign in with Discord to play.';
}

function accountLabel(discord) {
    const name = String((discord && discord.name) || '').trim();
    if (name) {
        return `Signed in as ${name}`;
    }
    const email = String((discord && discord.email) || '').trim();
    return email ? `Signed in as ${email}` : 'Signed in';
}

function render(state) {
    currentState = state;

    const flash = state.flash;

    elements.status.textContent = statusLine(state);
    // A known account replaces the button outright: asking a player who is already signed
    // in to sign in again is the thing this row exists to stop.
    elements.discordLogin.hidden = state.discord.remembered;
    elements.discordLogin.disabled = state.discord.loginPending || !state.serverReachable;
    elements.discordLogin.querySelector('.label').textContent = state.discord.loginPending
        ? 'Waiting for your browser...'
        : 'Sign in with Discord';
    elements.account.hidden = !state.discord.remembered;
    elements.accountName.textContent = accountLabel(state.discord);
    applyPlayButtons(state);
    // Flash Player is started fresh for every game, so a new choice never needs a restart.
    elements.relaunch.hidden = true;
    elements.forget.hidden = !state.discord.remembered;

    const browserProblem = flashBrowserProblem(state);
    if (browserProblem) {
        showProblem(browserProblem.message, browserProblem.severity);
    } else if (!flash.found) {
        showProblem(
            flash.locked
                ? 'Flash Player is missing from this install. Reinstall the launcher to play.'
                : 'Flash Player is missing. Point the launcher at it to continue.',
            'bad'
        );
    } else if (flash.tampered) {
        showProblem(
            'The Flash Player files were changed after installation, so the game will not start. ' +
                'Reinstall the launcher to play.',
            'bad'
        );
    } else if (flash.archMismatch) {
        showProblem(
            `This Flash Player is a ${flash.architectures.join('/')} program and cannot run on this machine. ` +
                'Choose the flashplayer_32_sa build for this system.',
            'bad'
        );
    } else if (state.notice) {
        showProblem(state.notice, 'warn');
    } else if (state.serverReachable === false) {
        showProblem(`Could not reach ${state.selectedServerUrl}`, 'bad');
    } else {
        const install = installWarning(state);
        if (install) {
            showProblem(install.message, install.severity);
        } else {
            showProblem('');
        }
    }

    elements.moveApp.hidden = !(state.install && state.install.relocate && state.install.canMove);

    // The restart-to-update button appears only when a full update is sitting downloaded;
    // every other state leaves the strip to say what is happening instead.
    elements.updateInstall.hidden = !state.update || state.update.state !== 'downloaded';
    // Syncing only means something once a session has given the launcher a server to ask, so
    // the button stays off the sign-in screen where there is nothing to write yet.
    elements.gameStatsSync.hidden = !state.gameStats || !state.gameStats.running || state.gameStats.enabled === false;

    renderEngineStatus(state);
    elements.versions.textContent = `v${state.appVersion}`;
}

elements.discordLogin.addEventListener('click', async () => {
    const result = await window.launcher.discordLogin();
    if (result && !result.ok) {
        showProblem(result.message || 'Could not start the Discord sign-in.', 'bad');
    }
});

async function playWith(engine) {
    elements.play.disabled = true;
    elements.playProjector.disabled = true;
    const result = await window.launcher.play(engine);
    if (!result || !result.ok) {
        showProblem((result && result.message) || 'Could not start the game.', 'bad');
    }
    if (currentState) {
        applyPlayButtons(currentState);
    }
}

elements.play.addEventListener('click', () => {
    void playWith(currentState ? playButtons(currentState).mainEngine : '');
});

elements.playProjector.addEventListener('click', () => {
    void playWith('projector');
});

elements.forget.addEventListener('click', async () => {
    render(await window.launcher.forgetDiscordLogin());
});

elements.browseFlash.addEventListener('click', async () => {
    render(await window.launcher.browseFlash());
});

elements.relaunch.addEventListener('click', () => {
    void window.launcher.relaunch();
});

elements.updateInstall.addEventListener('click', () => {
    void window.launcher.updateInstall();
});

elements.gameStatsSync.addEventListener('click', async () => {
    const button = elements.gameStatsSync;
    button.disabled = true;
    try {
        const summary = await window.launcher.gameStatsSync();
        if (summary) {
            render({ ...currentState, gameStats: summary });
        }
    } finally {
        button.disabled = false;
    }
});

elements.moveApp.addEventListener('click', async () => {
    const result = await window.launcher.moveToApplications();
    if (result && !result.ok) {
        showProblem(result.message || 'Could not move the launcher.', 'bad');
    }
});

elements.quit.addEventListener('click', () => {
    void window.launcher.quit();
});

window.launcher.onState(render);
window.launcher.getState().then(render);
