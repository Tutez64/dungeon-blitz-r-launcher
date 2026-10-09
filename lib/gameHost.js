'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { EventEmitter } = require('events');

const { requestJson } = require('./gameStats');

/**
 * What the game page's own script did around the SWF, done by the launcher instead.
 *
 * In a browser the page (src/client/content/localhost/index.html on the server) polls the
 * player's presence and hands it to the local presence bridge, and measures the latency to
 * every game region for party placement. The standalone projector loads only the SWF, so
 * with nobody doing either, rich presence would never appear and every party would be placed
 * as if the player had no latency to report. This is the same work, on the same schedule,
 * from the launcher process -- whose requests come from the same address the projector's do,
 * which is the address the server identifies the player by.
 *
 * Sign-in is deliberately not here: the server signs a fresh game connection in from the
 * pending hand-off by itself, so nothing on the launcher side has to drive the SWF.
 */

const PRESENCE_POLL_MS = 4000;
const PRESENCE_FIRST_POLL_MS = 2500;
const REGION_FIRST_RUN_MS = 10000;
const REGION_REPEAT_MS = 10 * 60 * 1000;
const REGION_SAMPLES = 6;
const REQUEST_TIMEOUT_MS = 8000;

// The server leaves a presence line empty on purpose (a player roaming alone has neither);
// the page sends two U+2800 blanks for it, and so does this.
const BLANK_PRESENCE_LINE = '⠀⠀';

class GameHost extends EventEmitter {
    /**
     * @param {{ presence?: { publishPresence: Function, clearPresence: Function },
     *   request?: Function, ping?: Function }} options `request` and `ping` are injectable so
     *   the tests can drive this without a server.
     */
    constructor({ presence = null, request = requestJson, ping = pingOnce } = {}) {
        super();
        this.presence = presence;
        this.request = request;
        this.ping = ping;
        this.timers = [];
        this.serverUrl = '';
        this.running = false;
        this.lastPresenceHash = '';
        this.lastPresenceCharacter = '';
    }

    /**
     * @param {{ serverUrl: string, presence?: boolean }} options `presence: false` leaves
     *   rich presence alone, for a player who switched the bridge off.
     */
    start({ serverUrl, presence = true }) {
        this.stop();
        this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
        if (!this.serverUrl) {
            return;
        }
        this.running = true;

        if (presence && this.presence) {
            this.after(PRESENCE_FIRST_POLL_MS, () => this.syncPresence());
            this.every(PRESENCE_POLL_MS, () => this.syncPresence());
        }
        this.after(REGION_FIRST_RUN_MS, () => this.measureRegions());
    }

    stop() {
        for (const timer of this.timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
        this.timers = [];
        const hadPresence = Boolean(this.lastPresenceHash);
        this.running = false;
        this.lastPresenceHash = '';
        this.lastPresenceCharacter = '';
        if (hadPresence && this.presence) {
            void Promise.resolve(this.presence.clearPresence()).catch(() => {});
        }
    }

    after(ms, task) {
        this.timers.push(setTimeout(() => void task(), ms));
    }

    every(ms, task) {
        this.timers.push(setInterval(() => void task(), ms));
    }

    async clearPublished() {
        if (!this.lastPresenceHash) {
            return;
        }
        this.lastPresenceHash = '';
        this.lastPresenceCharacter = '';
        await this.presence.clearPresence();
    }

    /** One presence poll; a port of the page's syncDiscordPresence(). */
    async syncPresence() {
        if (!this.running) {
            return;
        }

        try {
            // Naming our character picks our session out of several behind one address (a
            // household, CGNAT, a VPN); the server still only chooses among this address's.
            const query = this.lastPresenceCharacter
                ? `?character=${encodeURIComponent(this.lastPresenceCharacter)}`
                : '';
            const response = await this.request('GET', `${this.serverUrl}/api/presence/self${query}`, null, REQUEST_TIMEOUT_MS);
            if (!this.running) {
                return;
            }

            if (response.status === 409) {
                // The server could not tell which session is ours -- not that we stopped
                // playing. Keep what is published; forget a name it no longer offers.
                const offered = (response.body && response.body.availableCharacters) || [];
                if (this.lastPresenceCharacter && !offered.includes(this.lastPresenceCharacter)) {
                    this.lastPresenceCharacter = '';
                }
                return;
            }

            const session = response.ok && response.body ? response.body.session : null;
            if (!session) {
                // A 404 (no session on this address) or an empty answer: not in a game. A
                // transport failure is not an answer and leaves things as they are.
                if (response.status) {
                    await this.clearPublished();
                }
                return;
            }

            this.lastPresenceCharacter = session.characterName || '';
            const payload = presencePayload(session, this.serverUrl);
            const hash = JSON.stringify(payload);
            if (hash === this.lastPresenceHash) {
                return;
            }
            this.lastPresenceHash = hash;
            await this.presence.publishPresence(payload);
        } catch {
            // Keep polling; the game must go on even when presence cannot.
        }
    }

    /** One latency round; a port of the page's measureRegionLatency(). */
    async measureRegions() {
        if (!this.running) {
            return;
        }

        try {
            const listing = await this.request('GET', `${this.serverUrl}/api/regions`, null, REQUEST_TIMEOUT_MS);
            const regions = listing.ok && listing.body && Array.isArray(listing.body.regions) ? listing.body.regions : [];
            // The server lists no regions while there is only one, and then nothing is measured.
            if (regions.length < 2) {
                return;
            }

            const results = {};
            for (const region of regions) {
                if (!this.running) {
                    return;
                }
                const pingUrl = resolveUrl(region && region.pingUrl, this.serverUrl);
                if (!region || !region.id || !pingUrl) {
                    continue;
                }
                const times = [];
                for (let sample = 0; sample < REGION_SAMPLES; sample += 1) {
                    times.push(await this.ping(pingUrl));
                }
                // The first request pays for DNS and the connection; the rest reuse it. An
                // unreachable region is simply not reported, so it is never chosen for us.
                const reused = times.slice(1).filter((time) => Number.isFinite(time));
                if (times.every((time) => Number.isFinite(time)) && reused.length) {
                    results[region.id] = Math.round(Math.min(...reused));
                }
            }

            if (Object.keys(results).length && this.running) {
                await this.request('POST', `${this.serverUrl}/api/region-rtt`, { results }, REQUEST_TIMEOUT_MS);
            }
        } catch {
            // Measuring is best effort and must never disturb the game.
        } finally {
            if (this.running) {
                this.after(REGION_REPEAT_MS, () => this.measureRegions());
            }
        }
    }
}

/** What the page posted to the local presence bridge, built from one /api/presence/self session. */
function presencePayload(session, serverUrl) {
    return {
        characterName: session.characterName,
        characterClass: session.disciplineName || session.characterClass,
        details: session.details || BLANK_PRESENCE_LINE,
        state: session.state || BLANK_PRESENCE_LINE,
        startedAtMs: session.startedAtMs,
        partySize: session.partySize,
        partyId: session.partyId,
        partyMax: session.partyMax,
        partyLocked: session.partyLocked,
        joinSecret: session.joinSecret,
        levelKey: session.levelKey,
        levelName: session.levelName,
        areaKey: session.areaKey,
        portraitUrl: session.portraitUrl,
        disciplineKey: session.disciplineKey,
        activityKind: session.activityKind,
        playerStatus: session.playerStatus,
        presenceUrl: `${serverUrl}/api/presence/self`,
        joinUrl: `${serverUrl}/api/presence/discord-join`
    };
}

function resolveUrl(value, base) {
    try {
        const resolved = new URL(String(value || ''), `${base}/`);
        return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : '';
    } catch {
        return '';
    }
}

/**
 * Times one GET, in milliseconds, over a kept-alive connection so that only the first
 * sample of a region pays for the handshake -- the same thing the page's fetch() did.
 *
 * @returns {Promise<number>} NaN when the region did not answer 2xx.
 */
const keepAliveAgents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
function pingOnce(url) {
    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            resolve(NaN);
            return;
        }
        const transport = parsed.protocol === 'https:' ? https : http;
        const started = process.hrtime.bigint();
        const request = transport.get(
            parsed,
            { agent: keepAliveAgents[parsed.protocol], headers: { 'Cache-Control': 'no-store' }, timeout: REQUEST_TIMEOUT_MS },
            (response) => {
                response.resume();
                response.on('end', () => {
                    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
                    const ok = response.statusCode >= 200 && response.statusCode < 300;
                    resolve(ok ? elapsed : NaN);
                });
            }
        );
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', () => resolve(NaN));
    });
}

module.exports = { GameHost, presencePayload, BLANK_PRESENCE_LINE, PRESENCE_POLL_MS };
