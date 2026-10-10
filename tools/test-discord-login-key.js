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
 * only; the launcher's poll and its device-token request send the key itself, in a header. This
 * pins down both halves: what leaves the launcher in the URL, and what it sends when it asks.
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
 * the address-keyed routes stay empty for the launcher, as they did for the player.
 */
function startMockServer() {
    const state = { byHash: new Set(), requests: [] };

    const server = http.createServer((req, res) => {
        const key = String(req.headers['x-launcher-login-key'] || '');
        state.requests.push({ url: req.url, key });
        const hash = key ? crypto.createHash('sha256').update(key).digest('hex') : '';
        const signedIn = Boolean(hash && state.byHash.has(hash));
        res.setHeader('Content-Type', 'application/json');

        if (req.url.startsWith('/api/auth/launcher/login-state')) {
            res.end(JSON.stringify({ signedIn, email: signedIn ? ACCOUNT_EMAIL : null }));
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
                completeLogin: (hash) => state.byHash.add(hash),
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
        const watcher = discordAuth.watchForLogin(game.url, { loginKey: key, intervalMs: 20, timeoutMs: 3000 });

        // The browser finishes the sign-in a moment later, from an address the launcher is not.
        setTimeout(() => game.completeLogin(discordAuth.loginKeyHash(key)), 100);
        const signedIn = await watcher.promise;
        assert.deepStrictEqual(signedIn, { email: ACCOUNT_EMAIL }, 'the launcher sees the login by its key');

        const issued = await discordAuth.issueSession(game.url, key);
        assert.deepStrictEqual(issued, { token: 'device-token', email: ACCOUNT_EMAIL }, 'and is given its device token');

        const polls = game.state.requests.filter((request) => request.url.startsWith('/api/auth/launcher/'));
        assert.ok(polls.length >= 2);
        assert.ok(polls.every((request) => request.key === key), 'every launcher request carries the key in its header');
        assert.ok(game.state.requests.every((request) => !request.url.includes(key)), 'and never in a URL');
        assert.ok(
            game.state.requests.filter((r) => r.url.startsWith('/api/auth/discord/pending')).every((r) => !r.key),
            "the game page's own route is not sent the key"
        );

        // Without the key -- an older launcher, or someone who only saw the browser URL -- the
        // same server has nothing for this address.
        const hashOnly = await discordAuth.issueSession(game.url, discordAuth.loginKeyHash(key));
        assert.strictEqual(hashOnly, null, 'the hash from the URL is not enough for a token');
        assert.strictEqual(await discordAuth.issueSession(game.url), null);
        assert.strictEqual(await discordAuth.fetchLoginState(game.url), null);

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
    console.log('[test-discord-login-key] a sign-in finished in a browser at another address reaches the launcher: OK');
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
