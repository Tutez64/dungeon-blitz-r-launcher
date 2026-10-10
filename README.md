# Dungeon Blitz: R Launcher

A desktop launcher that plays Dungeon Blitz in Adobe's standalone Flash Player, so players
do not need a browser that still has Flash. It ships for Windows, macOS and Linux.

The launcher is a sign-in screen, not a control panel. It asks for one thing — sign in
with Discord — and once that is done it opens the game in Flash Player and connects to the
server. A player who has signed in before is not asked again.

In the background it also connects the player's Discord lobby so lobby chat works,
publishes Discord rich presence, and mirrors the player's in-game chat into that lobby — in
both directions — for as long as the game is open.

## Game engine: the standalone Flash Player

The game runs in **Adobe Flash Player itself** -- `flashplayer_32_sa`, the standalone
player Adobe calls the projector. The launcher starts it on the game's SWF, straight from
the selected server:

```
flashplayer_32_sa.exe http://<server>/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=...
```

Flash Player runs as its own process, with its own window and renderer. Nothing sits
between it and the game. The standalone player also has no 2021-01-12 kill switch; the
browser plugins do.

The launcher used to run the game in the PPAPI plugin taken from FlashBrowser, inside a
Chromium 87 window. That plugin sat behind Chromium's plugin host, compositor and IPC,
which is where the input and frame delay came from. It has been removed entirely.

| Platform | What ships | Notes |
| --- | --- | --- |
| Windows | `flashplayer_32_sa.exe` | 32-bit; runs on 32-bit and 64-bit Windows |
| macOS | `Flash Player.app` (from `flashplayer_32_sa.dmg`) | Intel; runs under Rosetta on Apple Silicon |
| Linux | `flashplayer` (from `flash_player_sa_linux.x86_64.tar.gz`) | x86_64; needs GTK 2 |

### Where it comes from

```bash
npm run fetch-projector                                   # this machine's platform
node tools/fetch-projector.js --platform win32            # another platform
```

`tools/fetch-projector.js` downloads the player into `vendor/projector/<platform>/`:

- It tries Adobe's own update server (`fpdownload.macromedia.com`) first. That server
  still serves all three builds.
- It falls back to the Internet Archive's copy of the same URL.
- Whichever mirror answers, it checks the file against the SHA-256 pinned in
  `projector.lock.json`. A file that does not match is never used.

The macOS disk image is unpacked with `hdiutil` and `ditto`, so it has to be fetched on a
Mac -- which is where the macOS package is built anyway. The `Flash Player` workflow runs the
fetch on all three platforms whenever any of these change: the lock file, the fetch script,
or `lib/projector.js`. It also checks Adobe's signature on the downloaded player.

The package carries the player as an extra resource. A checkout can instead drop it in a
gitignored `projector/` folder at the repository root. The launcher also looks in the usual
install places and in Downloads, and the **Choose Flash Player...** button takes one by
hand. A new choice applies on the next game with no restart, because the player is started
fresh for every game.

### What the launcher does for the game page

The projector loads only the SWF, not the game page, so the page's script does not run.
While the game is open, the launcher does that script's jobs itself (`lib/gameHost.js`):

- It polls `/api/presence/self` every 4 s and publishes rich presence.
- It measures latency to each game region and reports it to `/api/region-rtt`.

Sign-in needs nothing from the page:

- On a fresh connection, the server signs the game in from the pending hand-off that the
  saved launcher token recreates.
- If the game is already open when the player signs in, the OAuth callback signs that open
  connection in.

### A build without Flash Player

A **packaged** launcher always ships its own Flash Player. One that finds none refuses to
start: it shows an error box naming the path it is running from and quits, rather than
leaving a player on a sign-in screen that leads nowhere. Set
`DUNGEON_BLITZ_ALLOW_NO_FLASH=1` for a deliberately Flash-less build.

Development checkouts are exempt from that refusal. There, a missing player is one
`npm run fetch-projector` away, and the launcher window says so.

The 1.0.3 macOS release shipped exactly that refusal dialog. The macOS build packaged an app
with no Flash in it, and the build check only printed a warning that nobody read. So
`tools/preflight.js` now **fails** the build when the target platform has no Flash Player in
`vendor/projector/`. A deliberately Flash-less package must set
`DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1`.

### The status strip

The sign-in screen carries a status strip. The `Flash` row shows the player's version and
where it came from (`vendor`, `auto` or `manual`), or `missing`. The other rows show
`Discord status`, `Lobby chat` and `In-game chat`. Hovering a value shows the Flash Player
path, the local presence endpoint, or the last error. `main.js` prints the same Flash line on
the console, and `node tools/test-launcher-status.js` checks every state of that strip.

Once an account is known, the sign-in button is replaced by `Signed in as <name>`. That holds
whether the sign-in happened in the launcher or inside the game, where the SWF's own Discord
flow lands the player (see [Remembered account](#remembered-account)).

## Tamper resistance

An **installed** launcher refuses to be repurposed. A development checkout is exempt from
all of this.

- **Only its own Flash Player.** It runs only the Flash Player it was installed with. It
  never uses a hand-picked file or a copy found elsewhere on the machine, so the
  **Choose Flash Player...** button is hidden.
- **Fingerprint check before every game.** At build time, `tools/fetch-projector.js`
  records a SHA-256 fingerprint of that Flash Player in `lib/projector.integrity.json`. That
  file is packed into the app's own code, not left next to the player.
  - The check covers every file in the macOS bundle, so an added library counts as a change.
  - A replaced or patched player is refused: the status strip reads
    `changed - reinstall`, and the game does not start.
- **No developer tools.** The launcher window has DevTools switched off, and any DevTools
  that open are closed again.
- **No debugging or injected code.** A launcher started with a debugger (`--inspect`,
  `--remote-debugging-port`, `--js-flags`) or with `NODE_OPTIONS` loading code exits at
  start.
- **The window stays on its own page.** No page can navigate the launcher window
  elsewhere, open a new window or embed a webview. Links go to the system browser.
- **CI checks the shipped copy.** The release workflow runs `tools/verify-projector.js` on
  the copy of Flash Player inside each finished package. A package whose own check would
  refuse to play therefore cannot be published.

**What this cannot stop.** Nothing running on the player's own machine can be made
impossible to manipulate; these checks raise the cost of doing it. In particular:

- **Patching the launcher's code.** Someone can edit the launcher's code and the
  fingerprint together. Electron 11 cannot verify its own `app.asar`. That check
  (`EnableEmbeddedAsarIntegrityValidation`) and the switches that disable
  `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` at the binary level are Electron *fuses*.
  Fuses arrived in Electron 12; asar integrity checking came later still (macOS 16,
  Windows 30). Getting them means leaving Electron 11, which drops Windows 7 and 8.
- **Unsigned installers.** Installers are unsigned unless the studio's certificates are
  configured (`CSC_LINK`, `CSC_KEY_PASSWORD`, and Apple notarization). Signing is what makes
  a modified installer show as untrusted to the player.
- **The game itself.** Flash Player runs the SWF, and memory editors work on any process.
  What the game accepts is decided by the server: `src/server/core/anticheat` in the game
  repository.

## Why Electron 11

The launcher window still runs on Electron 11 (Chromium 87), which runs on Windows 7 and 8;
Electron dropped those in version 23. The pin used to be about Flash too: Chromium 87 was the
last with the PPAPI Flash host. The game no longer depends on it, so moving to a newer
Electron is now a question of which Windows versions to keep.

The same pin is why Discord's consent screen is opened in the player's own browser rather
than inside the app: discord.com's web client no longer parses on Chromium 87. The server
keys a pending sign-in by requester address, so the launcher's poll still sees the result.

## Binaries: `payload/` and `vendor/`

| Folder | What | In git |
| --- | --- | --- |
| `payload/` | The prebuilt Discord Social SDK bridges | Yes, via Git LFS |
| `vendor/` | Build output — what packaging reads | No, gitignored |

```text
vendor/projector/<platform>/  flashplayer_32_sa.exe | Flash Player.app | flashplayer   (tools/fetch-projector.js)
vendor/social/<platform>/     discord_social_bridge[.exe] + the SDK runtime library   (tools/stage-vendor.js)
```

### macOS is x64 only

The package is an x64 Electron app, and Flash Player for macOS is an Intel binary. Apple
Silicon runs both under Rosetta, and CI builds on the Intel runner.

### 32-bit Windows

The Windows targets build `ia32` as well as `x64`, so the releases page carries
`-win-ia32-setup.exe` and `-win-ia32-portable.exe`. **They play.** `flashplayer_32_sa.exe` is
itself a 32-bit program in its own process, so it runs on 32-bit and 64-bit Windows alike.

Up to 1.0.16, the 32-bit installers opened and then refused to play. The game ran in an
x86_64 PPAPI plugin loaded *into* the launcher process, and a 32-bit process cannot load
that. That refusal is gone with the plugin. `lib/windowsSupport.js` now refuses only an
architecture there is no build of at all (arm64 Windows running an arm64 build). That
refusal names the exact x64 installer to download instead.

The ia32 run still never publishes an update manifest (see "Why Windows is built as two
runs"). Auto-update therefore always offers the x64 installer, and a 32-bit player updates
by downloading the new ia32 installer.

### Windows versions

Electron 11 is old enough to still run on Windows 7: Electron only dropped Windows 7, 8 and
8.1 in version 23. So the launcher starts on every Windows from 7 Service Pack 1 up, 32-bit
or 64-bit:

| Windows | Result |
| --- | --- |
| Windows 7 SP1 | supported; the launcher window renders in software |
| Windows 8, Windows 8.1 | supported; the launcher window renders in software |
| Windows 10 and later | supported, hardware rendering |
| Windows Vista and older | refused at start, naming what is needed |

The software rendering applies to the launcher window only. The game runs in Flash Player,
which does its own rendering.

**Windows 7 needs the Universal C Runtime update.** Electron's binaries link against
`ucrtbase.dll`, which Windows 7 and 8 carry only through **KB2999226** (or the earlier
**KB2533623**). Without it the launcher does not start at all -- no window, no message, no
error box -- so install it before the first run.

**The GPU is the other half.** Chromium 87 asks for D3D11, which reaches Windows 7 through
the platform update (**KB4474419**). Without it -- and on the netbooks and VMs where this
launcher is most wanted -- the window is black or the GPU process dies during start, which
never says which driver is at fault. `lib/windowsSupport.js` therefore switches Windows 7
and 8 to software rendering (`--use-gl=swiftshader --disable-gpu-compositing`) before the
first window is created, and **leaves Windows 10 alone**: the same switches there would cost
the launcher window real frames for a problem that machine does not have. A legacy machine that does
have the platform update can keep the GPU with `DUNGEON_BLITZ_GPU=hardware`.

The status strip carries a `Windows` row saying which of these is in force, so a slower
launcher window on Windows 7 is not read as a fault. `node tools/test-windows-support.js`
walks the whole matrix from any machine -- `os.release()` is a parameter, not a call.

## Discord rich presence

Rich presence is served **by the launcher itself** (`lib/presence.js`). The game page
pushes its state to a fixed local address (`http://127.0.0.1:47631/presence`), and the
launcher maps that onto a Discord activity — details, state, party size and join secret,
level artwork, the discipline icon and a `Play Game` button — and sends it over the same
RPC socket the sign-in uses (`SET_ACTIVITY`). Party joins from Discord are handed to the
game server's `/api/presence/discord-join`.

That endpoint is the same one the game server's own bridge exposes, so the page needs no
changes. The launcher does it itself because a packaged build cannot use the server's
bridge at all: the server checkout is not inside the app, and the only Node runtime a
packaged Electron carries is v12 (Electron 11), which cannot load that bridge's
dependencies (express 5 needs Node 18 and `node:`-prefixed builtins). It used to be spawned
with its output discarded, so it died silently and presence never appeared.

Area artwork comes from `LEVEL_AREA_IMAGE_KEYS` in `lib/presence.js`: the key the game page
pushes (`areaKey`, else `levelKey`) is matched against the Rich Presence assets uploaded to
the Discord application — every region (`blackrosemire`, `castlehocke`, `cemeteryhill`,
`emeraldglades`, `fellbridge`, `shazaridesert`, `stormshardmountain`, `valhaven`, …), the
level groups (`home`, `indungeon`, `newbieroad`, `dungeon_blitz`) and the disciplines
(`flameseer`, `frostbringer`, `justicar`, `mage`, `necromancer`, `paladin`, `rogue`,
`sentinel`, `shadowbringer`, `soulthieft`, `templar`, `viperblade`). A key that matches
nothing renders as *no* image on Discord, so an unknown key falls back to the configured
`indungeon` art — and `DUNGEON_BLITZ_LOG_PRESENCE=1` prints every key the page sends, to
spot names the asset list is missing.

`presence.config.json` holds the application id, port, artwork keys and the origins allowed
to push; a side-by-side game checkout's `discord-bridge.config.json` overrides it when
present, so an existing bridge setup keeps working. Discord does not have to be running to
play — the bridge retries in the background and the `Discord status` row says what is
happening.

```bash
node tools/test-presence.js   # publish, dedupe, origin refusal and clearing, against a mock Discord socket
```

## Game chat, mirrored

Flash chat cannot be read from the launcher and the server's relay needs either the native
Social SDK (no macOS build) or a bot token, so the game server publishes the player's own
public chat lines on a small feed and takes lines back for printing in game:

```text
GET  /api/chat/outbound?since=<cursor>   -> { cursor, messages: [{ senderName, message }] }
POST /api/chat/inbound                   -> prints "[Discord] name: message" in game
```

`lib/chatRelay.js` polls that feed while the game window is open and hands each line to the
social bridge, which posts it to the player's lobby; lobby chat comes back the other way
and is printed in game. Only **the local player's own** lines come down the feed, so a
message is mirrored exactly once — by its author's launcher — instead of once per player in
the room, and each line is sent once even if the lobby is briefly unavailable (the queue
retries). A server without the feed answers 404 and the `In-game chat` row says so, rather
than polling forever. Disable it with `DUNGEON_BLITZ_CHAT_RELAY=0`.

```bash
node tools/test-chat-relay.js   # relay, dedupe, queueing and unsupported servers, against a local mock
```

## Discord widgets

A player's Game Stats widget is rendered from an *Application Identity Profile*, and the
only writer for one is `PATCH /applications/{app}/users/{user}/identities/{player}/profile`
with the application's **bot token**. A bot token inside a desktop app is a token anyone can
read out of the bundle, so the write stays on the game server and the launcher only asks for
it:

```text
POST /api/discord/stats/sync   { token }   -> { ok, written, username, updatedAt, fields }
```

Discord creates the profile record on the **first** write, so a widget that has never been
written is empty for everyone who looks at it -- the player and their friends alike. The
launcher asks once per game session, identified by the launcher token it resumed at launch,
and the `Game stats` row reports what came back: `profile written`; `no Discord account
linked` (the server answered `discord-not-linked`, or an HTTP 409); `server cannot write it`
(a 404 -- no such route yet); or `failed` with the server's own words. `Sync game stats`
under the status rows retries by hand, which is what a player does right after linking
inside the game. Disable all of it with `DUNGEON_BLITZ_GAME_STATS=0`.

Writing also needs the player's link to grant `application_identities.write`. The consent
dialog normally asks for it as part of the Social SDK scopes; if a write comes back
unauthorized, add it to `scopes` in `social.config.json` (an empty list keeps the default
`openid identify sdk.social_layer`). **The application must allow the scope in the
Developer Portal first** -- otherwise Discord rejects the whole authorize with
`invalid_scope`, which would take lobby chat down with it.

```bash
node tools/test-game-stats.js   # written, unlinked, unauthorized and unsupported servers
```

The portal half is not code, and it is where an invisible widget usually stops:

1. The game must be **claimed**; Game Stats Widgets are not offered otherwise.
2. Widget Top, Widget Bottom and Add Widget Preview each need a layout, and **Publish**
   unlocks only once all three have their required fields -- an unpublished widget is
   visible to developer-team members alone.
3. Testing a draft needs **Developer Mode** on, then Add Widget > Game Widgets > Add to
   profile, and a client refresh (`Cmd+R`): widget configs are cached per client session.
4. Every asset a field references must be **Public** on the Assets page. A non-public asset
   renders as a skeleton placeholder, which is what an empty widget looks like.

Until the server route exists the row reads `server cannot write it`, so a portal-side
problem and a data-side problem can be told apart without guessing.

## Remembered account

The launcher's own sign-in writes the account to `launcher-state.json`. A player who signed
in *inside the game* never touches that button, so the launcher also reads the account back
from the server (`GET /api/discord/account`, resolved from the connection asking — which is
why it is polled while a game session is up) and against the social bridge's own Discord
identity. Either way the next launch shows `Signed in as <name>` instead of asking again;
`Use a different account` clears it.

## Running from a disk image or Downloads

A copy opened straight out of a mounted `.dmg`, or from the Downloads folder it was
unzipped into, is a copy the next build will not replace — the quiet way a player ends up
on a launcher that no longer works. The launcher warns once at startup, keeps a banner in
the window, and offers `Move to Applications`: it copies itself with `ditto`, restarts from
the new location and exits. A development checkout is never flagged.

```bash
node tools/test-install-location.js
```

## Discord Social SDK bridge

`native_bridge/` is a mirror of the game server's bridge sources. The launcher runs the
compiled bridge as a child process and speaks the same newline-delimited JSON protocol the
server uses:

```text
launcher -> bridge : initialize | outbound_chat | use_lobby | link_channel
bridge -> launcher : ready | auth | status | chat | lobby_ready |
                     channel_linked | channel_link_failed | send_result
```

Running it here rather than on the server is what makes lobby chat per-player: each player
authorizes their own Discord account and joins the lobby as themselves. The bridge runs
headless — lobby chat and the party roster are read in Discord's own client.

Building it needs the Discord Social SDK (headers plus the platform library) at
`native_bridge/discord_social_sdk/`, which is not redistributable and therefore not in this
repository:

```bash
npm run build:bridge
```

On Linux this also needs `libasound2-dev` and `libpulse-dev` — the SDK links against ALSA
and PulseAudio. Copy the result into `payload/social/<platform>/`.

**No macOS build of the Social SDK exists.** On darwin (and wherever the native binary is
absent) the launcher falls back to a built-in JavaScript driver — `lib/socialJs.js` over
`lib/socialRest.js`, modelled on `@minesa-org/mini-interaction`'s `DiscordRestClient` —
which speaks the same protocol events to Discord's HTTP lobby API: create-or-join by
lobby secret, linked-channel relay and message polling. It starts with the game, not with
the launcher, so nothing asks for Discord authorization until the player opens the game.

Authorization happens **inside the Discord client**: `lib/discordIpc.js` speaks Discord's
local RPC socket (`discord-ipc-0`), and its `AUTHORIZE` command raises Discord's own
consent dialog. The code it returns is swapped for a token with a PKCE verifier, so the
launcher never ships a client secret and never opens a browser. The token is cached in
`discord-social-token.json` (mode 0600) in the launcher's user-data folder — the launcher
never touches the macOS Keychain.

Requirements: the application must allow the `openid identify sdk.social_layer` scopes,
and the player must have the Discord desktop client running. `browserFallback: true` in
`social.config.json` additionally enables the browser flow, which then also needs the
loopback redirect `http://127.0.0.1/callback` registered for the application.

```bash
node tools/test-social-bridge.js   # Discord-client and browser auth against local mocks
node tools/test-discord-ipc.js     # the RPC client itself, against a mock Discord socket
```

**`deviceFlow` must stay off.** The device path requires the Discord application to allow
device authorization; without it the SDK does not return an error, it aborts the whole
process on a failed `CanAuthorizeDevice` check. The browser PKCE flow needs no such
capability.

### Linking a lobby to your own channel

Linking a lobby to a Discord text channel is **per-player and off by default**, so a fresh
checkout never points at somebody else's channel. `social.config.json` ships both values
empty:

```json
{ "channelId": "", "enableChannelLinking": false }
```

To link your own, set your channel's ID and turn the feature on, then restart the launcher:

```bash
# right-click the channel -> Copy Channel ID
"channelId": "your-channel-id",
"enableChannelLinking": true
```

The channel has to be one the Discord application (the `appId` above) can see, and the link
only takes effect once the launcher holds a signed-in player token -- `lib/socialJs.js` calls
`linkChannelToLobby` and then keeps the lobby's `linked_channel` in step. Discord caps these
calls hard while an application is unapproved (20 per 2 hours), which is why the launcher
only calls when the lobby's channel actually differs from yours.

`lobbySecret` may stay empty: it defaults to `launcher-<appId>`, and it is not a credential
-- Discord treats an activity carrying a `secrets` field as a joinable one and hides the
buttons behind Ask to Join, so this launcher deliberately never sends one.

If you have a checkout of the game repository next to this one, put the same keys in its
`src/server/discord-social-bridge.config.json` instead and they will override
`social.config.json` (see [the game repository](#optional-the-game-repository)) -- that file
is where a shared setup belongs, since it is not part of this repository.

## Running and packaging

```bash
npm install && npm run fetch-projector && npm start
```

```bash
npm run dist:win
```

Each `dist:` script first fetches Flash Player for its platform
(`tools/fetch-projector.js`). It then runs `tools/preflight.js`, which fails the build when
that platform has no Flash Player in `vendor/projector/`. For a deliberately Flash-less
package, set `DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1`.

The application icon comes from one source image, `build/icon.png` (1024×1024 with alpha).
`npm run make-icons` derives the rest from it on a Mac: `build/icon.icns` (macOS app, dock
and dmg), `build/icon.ico` (Windows and Linux, sizes 16–256), `renderer/assets/icon.png`
(what the windows and the Linux dock load at runtime) and `renderer/assets/favicon.ico`
(the sign-in page's tab icon). The ICO is assembled in `tools/make-icons.js` rather than
converted, because `sips` writes BMP rows top-down and an ICO wants them bottom-up -- the
generic conversion mistake that ships an upside-down taskbar icon. All of it is committed,
so packaging never needs to regenerate.

Output lands in `dist/`. What can be built where:

| Target | On Windows | On Linux (incl. WSL) | On macOS |
| --- | --- | --- | --- |
| `nsis` / `portable` | yes, needs Developer Mode | no | no |
| `AppImage` / `deb` | no (symlinks) | yes | yes |
| `zip` (mac, unsigned) | no (symlinks) | yes | yes |
| `dmg` | no | no | yes |

### Symlink privilege on Windows

electron-builder's `winCodeSign` package and the AppImage icon step both create symbolic
links, which an ordinary Windows account may not do. With Developer Mode off, `dist:win`
and `dist:linux` fail with a privilege error. Either turn on Settings → System → For
developers → Developer Mode, or build Windows unsigned:

```bash
npm run dist:win -- --dir --config.win.signAndEditExecutable=false
```

### GitHub Actions

Bumping `version` in `package.json` on `main` is what cuts a release.
`.github/workflows/release.yml` then builds on three native runners, stages the binaries,
downloads Flash Player (checked against `projector.lock.json`), runs the preflight (a
missing Flash Player fails the job), runs electron-builder, checks that Flash Player made it
into the package intact, and attaches the installers to a draft GitHub release tagged
`v<version>`:

| Platform | Files |
| --- | --- |
| Windows | `...-win-x64-setup.exe` (64-bit Windows; auto-updates), `...-win-x64-portable.exe`, `...-win-ia32-setup.exe` (32-bit Windows), `...-win-ia32-portable.exe` |
| macOS | `...-mac-x64.dmg`, `...-mac-x64.zip` |
| Linux | `...-linux-x86_64.AppImage`, `...-linux-amd64.deb` |

### Why Windows is built as two runs

electron-builder emits a **universal** installer whenever one invocation packages more
than one architecture. Splitting `build.win.target` into separate one-architecture entries
does not prevent it -- `NsisTarget.finishBuild()` always adds the combined build
(`builds = new Set([this.archs])`) and only *additionally* builds per-architecture
installers when the artifact name contains `${arch}`:

```js
const builds = new Set([this.archs]);                       // always, all arches together
if (pattern.includes("${arch}") && this.archs.size > 1) {   // and each one on its own
  [...this.archs].forEach(([arch, appOutDir]) => builds.add(new Map().set(arch, appOutDir)));
}
```

So 1.0.12 shipped three packages per target -- `win-x64-*`, `win-ia32-*` and a ~135 MB
`win-setup.exe` carrying both -- and `latest.yml` pointed at the universal one, making
every x64 player updating from 1.0.11 download roughly twice what they needed.

The fix is one electron-builder run per architecture, which is why `package.json` only
configures x64 and the workflow has a separate Windows ia32 matrix entry. Three details
that each cost a release to learn:

- **Splitting the config's target entries does nothing.** The arches accumulate in one
  *invocation* regardless of how `build.win.target` is written.
- **`--win --ia32` does not override `build.win`.** The flag says which arches are
  *requested*; the config still contributes x64, so the run packages both and rebuilds
  the universal (1.0.14 did this). The per-target suffix does override it:
  `--win nsis:ia32 portable:ia32`.
- **`latest.yml` is not per-architecture on Windows.** `getArchPrefixForUpdateFile()` adds
  an arch suffix only on Linux, so both Windows runs write the same filename and whichever
  finishes last owns it. The ia32 run uses `--publish never` and drops its manifest, so an
  x64 player can never be offered a 32-bit installer.

The two Windows jobs also upload distinct artifact names (`launcher-win32-x64`,
`launcher-win32-ia32`); sharing one name makes the second upload fail.

The `win-ia32` files play; see "32-bit Windows" above.

Editing `package.json` without changing the version builds nothing; the workflow compares
against the previous commit first. A manual run builds the current version, and only
publishes when `publish` is ticked.

Packages are **unsigned**. Signing needs `CSC_LINK` and `CSC_KEY_PASSWORD` for Windows and
macOS, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization.

## Auto-update

An installed launcher updates itself. `lib/update.js` wraps electron-updater with GitHub
releases as the feed (`build.publish` in package.json): it checks a few seconds after
start and then every six hours, downloads a new version in the background and shows an
`Update` row in the status strip -- `downloading 1.1.0 - 42%`, then `1.1.0 ready -
restart to install` with a **Restart to update** button. There is no manual check button:
the schedule above is the only way a check is triggered, so a player waiting on a release
waits for the next six-hour tick (or the update lands on quit). Nothing forces the restart
while the game might be open; if the player ignores the prompt, the update still installs on
the next quit (`autoInstallOnAppQuit`). Dev checkouts and dev AppImages never self-update.

Two feed rules are easy to trip over: the release job uploads the `latest*.yml` metadata
alongside the installers (`--publish always`), and the draft release must be **published**
before any installed launcher sees it -- GitHub's update provider cannot read a draft.
And on macOS an update can only replace a signed app: these unsigned builds show the
check as an error there, so macOS players update by downloading the new .dmg. `npm run
test-updater` pins the state machine against a fake updater, no Electron or network.

## Servers

Targets live in `servers.json`. There is no server picker in the UI; the launcher uses the
saved choice from `launcher-state.json` in the user data folder, or `defaultServerId`.

## Tests

```bash
npm test
```

Two environment switches help debug a live install without editing it:

```bash
DUNGEON_BLITZ_LOG_PRESENCE=1   # every presence push: payload, area key, dedupe decisions
DUNGEON_BLITZ_LOG_NETWORK=1    # every Discord API call the lobby bridge makes, with results
```

Every suite runs without Electron, Discord, a game server or a Flash Player binary: each
drives the module against a local mock.

| Suite | What it pins down |
| --- | --- |
| `tools/test-presence.js` | Activity mapping, dedupe, origin refusal, clearing, against a mock Discord socket |
| `tools/test-chat-relay.js` | Own-chat mirroring once, queueing while the lobby is down, inbound printing, unsupported servers |
| `tools/test-social-bridge.js` | Discord-client and browser authorization paths, lobby join, two-way chat |
| `tools/test-discord-ipc.js` | The RPC framing, `AUTHORIZE` payload and PING/PONG |
| `tools/test-launcher-status.js` | Every state of the status strip and the account row |
| `tools/test-install-location.js` | Disk-image and Downloads detection, and what is deliberately not flagged |
| `tools/test-windows-support.js` | Which Windows versions and architectures start, and the software-rendering fallback |
| `tools/test-projector.js` | Finding Flash Player, the SWF it opens, the pinned downloads, and the presence and region-latency work done for the game page |

`.github/workflows/tests.yml` runs them on every push and pull request, so a broken Flash
guard, presence mapping or chat relay fails before an installer is built.
`.github/workflows/flash-player.yml` downloads and unpacks Flash Player on all three
platforms whenever the lock file or the fetch script changes.

## Optional: the game repository

Only the server's own Social SDK settings (`discord-social-bridge.config.json`) and the
presence overrides (`discord-bridge.config.json`) come from a checkout of the game
repository. The launcher looks for it next to this one, and `DUNGEON_BLITZ_SERVER_ROOT`
overrides that. Without it the launcher uses its own `social.config.json` and
`presence.config.json`, which is what a packaged build does.

## Game window shortcuts

The game window is Flash Player's own, so its shortcuts are Flash Player's: `Ctrl+F`
(`Cmd+F` on macOS) toggles full screen, `Esc` leaves it, and `Ctrl+Q` (`Cmd+Q`) closes the
game.

## Security notes

- The launcher shell runs with `contextIsolation: true`, `nodeIntegration: false` and
  plugins disabled; its only contact with the main process is the fixed set of IPC calls in
  `preload.js` (state, sign-in, forget, play, choose Flash Player, move to Applications,
  relaunch, quit) and it loads no remote content at all.
- No window of the launcher hosts Flash. The game runs in Adobe's standalone Flash Player,
  started on the selected server's SWF only, and that binary is the one whose SHA-256 is
  pinned in `projector.lock.json`.
- URLs are limited to `http`/`https`, and any carrying credentials are rejected.
