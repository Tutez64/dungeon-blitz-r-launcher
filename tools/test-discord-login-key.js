#!/usr/bin/env node
'use strict';

/**
 * Drives the launcher's Discord sign-in (lib/discordAuth.js) against a mock of the game
 * server's routes, for the case that left a Linux player on "waiting for your browser" after the
 * browser had said "Discord login successful": the browser and the launcher reach the server
 * from different addresses (a browser VPN or proxy), and the server used to match the two by
 * address alone.
 *
 * Each sign-in now has a one-time key of the launcher's own. The browser URL names it by hash
 * only; the launcher's poll and its device-token request send the key itself, in a header. From
 * another address than the browser's, the server also wants the code its "login successful" page
 * showed -- the key alone would hand a player's login to whoever sent them the sign-in link. This
 * pins down what leaves the launcher in the URL, what it sends when it asks, and that a code the
 * player enters is sent once, not on every poll (each wrong one counts on the server).
 *
 * Usage: node tools/test-discord-login-key.js
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const discordAuth = require('../lib/discordAuth');

const ACCOUNT_EMAIL = 'player@example.com';

/**
 * The server, as far as the launcher sees it. `completeLogin(hash)` is the OAuth callback
 * finishing in a browser at another address: it files the login under the key hash only, so
 * the address-keyed routes stay empty for the launcher, as they did for the player, and the
 * login is handed over only with the code the browser page showed (CODE).
 */
const CODE = 'K7QM-4XPA';

function startMockServer() {
    const state = { logins: new Map(), requests: [] };

    const server = http.createServer((req, res) => {
        const key = String(req.headers['x-launcher-login-key'] || '');
        const code = String(req.headers['x-launcher-login-code'] || '');
        state.requests.push({ url: req.url, key, code });
        const hash = key ? crypto.createHash('sha256').update(key).digest('hex') : '';
        const login = hash ? state.logins.get(hash) : null;
        let codeRejected = false;
        if (login && !login.confirmed && code) {
            if (code.toUpperCase().replace(/[^A-Z0-9]/g, '') === CODE.replace('-', '')) {
                login.confirmed = true;
            } else {
                codeRejected = true;
            }
        }
        const signedIn = Boolean(login && login.confirmed);
        res.setHeader('Content-Type', 'application/json');

        if (req.url.startsWith('/api/auth/launcher/login-state')) {
            res.end(
                JSON.stringify({
                    signedIn,
                    email: signedIn ? ACCOUNT_EMAIL : null,
                    codeRequired: Boolean(login && !signedIn),
                    codeRejected
                })
            );
            return;
        }
        if (req.url.startsWith('/api/auth/discord/pending')) {
            res.end(JSON.stringify({ pending: false }));
            return;
        }
        if (req.url.startsWith('/api/auth/launcher/session')) {
            res.statusCode = signedIn ? 200 : 401;
            res.end(JSON.stringify(signedIn ? { ok: true, token: 'device-token', email: ACCOUNT_EMAIL } : { ok: false }));
            return;
        }
        res.statusCode = 404;
        res.end('{}');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}/`,
                state,
                completeLogin: (hash) => state.logins.set(hash, { confirmed: false }),
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

function checkKeyAndUrl() {
    const key = discordAuth.createLoginKey();
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, 'a key is 256 random bits, URL-safe');
    assert.notStrictEqual(discordAuth.createLoginKey(), key, 'every sign-in gets its own key');

    const url = new URL(discordAuth.loginUrl('http://game.test/', key));
    assert.strictEqual(url.pathname, '/auth/discord');
    assert.strictEqual(url.searchParams.get('launcher'), discordAuth.loginKeyHash(key), 'the URL names the key by hash');
    assert.match(url.searchParams.get('launcher'), /^[0-9a-f]{64}$/);
    assert.ok(!url.toString().includes(key), 'the key itself never goes to the browser');

    assert.strictEqual(
        discordAuth.loginUrl('http://game.test/', ''),
        'http://game.test/auth/discord',
        'without a key, the address the launcher always opened'
    );
    console.log('[test-discord-login-key] the browser URL carries only the key hash: OK');
}

async function checkSignInFromAnotherAddress() {
    const game = await startMockServer();
    try {
        const key = discordAuth.createLoginKey();
        const statuses = [];
        // The player, as the launcher window drives them: when the code box appears they make a
        // typo; when the window says it is wrong, they type the code off the browser page.
        const entered = [];
        let typed = 0;
        const watcher = discordAuth.watchForLogin(game.url, {
            loginKey: key,
            intervalMs: 20,
            timeoutMs: 5000,
            takeLoginCode: () => entered.shift() || '',
            onCodeStatus: (status) => {
                statuses.push(status);
                if (status.codeRequired && typed === 0) {
                    entered.push('AAAA-AAAA');
                    typed = 1;
                } else if (status.codeRejected && typed === 1) {
                    entered.push('k7qm4xpa');
                    typed = 2;
                }
            }
        });

        // The browser finishes the sign-in a moment later, from an address the launcher is not.
        setTimeout(() => game.completeLogin(discordAuth.loginKeyHash(key)), 100);
        const signedIn = await watcher.promise;
        assert.deepStrictEqual(signedIn, { email: ACCOUNT_EMAIL }, 'the launcher sees the login once the code is entered');
        assert.ok(statuses.some((status) => status.codeRequired && !status.codeRejected), 'the server asked for the code');
        assert.ok(statuses.some((status) => status.codeRejected), 'the typo was rejected');

        const withCode = game.state.requests.filter((request) => request.code);
        assert.deepStrictEqual(
            withCode.map((request) => request.code),
            ['AAAA-AAAA', 'k7qm4xpa'],
            'each code the player entered is sent exactly once'
        );

        const issued = await discordAuth.issueSession(game.url, key);
        assert.deepStrictEqual(issued, { token: 'device-token', email: ACCOUNT_EMAIL }, 'and is given its device token');

        const polls = game.state.requests.filter((request) => request.url.startsWith('/api/auth/launcher/'));
        assert.ok(polls.length >= 2);
        assert.ok(polls.every((request) => request.key === key), 'every launcher request carries the key in its header');
        assert.ok(game.state.requests.every((request) => !request.url.includes(key)), 'and never in a URL');
        assert.ok(
            game.state.requests.filter((r) => r.url.startsWith('/api/auth/discord/pending')).every((r) => !r.key && !r.code),
            "the game page's own route is not sent the key or the code"
        );

        // Without the key -- an older launcher, or someone who only saw the browser URL -- the
        // same server has nothing for this address.
        const hashOnly = await discordAuth.issueSession(game.url, discordAuth.loginKeyHash(key));
        assert.strictEqual(hashOnly, null, 'the hash from the URL is not enough for a token');
        assert.strictEqual(await discordAuth.issueSession(game.url), null);
        assert.strictEqual(await discordAuth.fetchLoginState(game.url), null);

        // Someone holding only a key -- they sent the player the link -- is asked for a code and
        // gets nothing without it.
        const attackerKey = discordAuth.createLoginKey();
        game.completeLogin(discordAuth.loginKeyHash(attackerKey));
        const attacker = await discordAuth.fetchLoginStatus(game.url, attackerKey);
        assert.deepStrictEqual(attacker, { signedIn: false, email: '', codeRequired: true, codeRejected: false });
        assert.strictEqual(await discordAuth.issueSession(game.url, attackerKey), null, 'no device token without the code');

        // A sign-in that never completes still ends: the watcher gives up instead of waiting forever.
        const abandoned = discordAuth.watchForLogin(game.url, {
            loginKey: discordAuth.createLoginKey(),
            intervalMs: 20,
            timeoutMs: 150
        });
        assert.strictEqual(await abandoned.promise, null, 'an abandoned sign-in times out');
    } finally {
        await game.close();
    }
    console.log('[test-discord-login-key] a sign-in finished at another address reaches the launcher with the browser code: OK');
}

async function main() {
    checkKeyAndUrl();
    await checkSignInFromAnotherAddress();
    console.log('[test-discord-login-key] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
