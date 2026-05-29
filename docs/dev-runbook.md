# Developer Runbook

Everything you need to run the Ping Pong Activity locally, configure the Discord Developer Portal, and test with two accounts.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20.10+ | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| pnpm | 9+ | `npm i -g pnpm` |
| cloudflared | latest | `brew install cloudflared` (macOS) / [downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |
| Discord account #1 | — | Your dev account (app owner) |
| Discord account #2 | — | A second account for multiplayer testing |

Verify versions:

```bash
node --version   # >= v20.10.0
pnpm --version   # >= 9.0.0
cloudflared --version
```

---

## 1. Clone and Install

```bash
git clone <your-repo-url> PingPongDiscord
cd PingPongDiscord
cp .env.example .env          # fill in values (see below)
pnpm install
```

### Environment Variables

Edit `.env` with your values:

| Key | Where | Example |
|-----|-------|---------|
| `DISCORD_CLIENT_ID` | Server + Portal | `123456789012345678` |
| `DISCORD_CLIENT_SECRET` | Server only | `your-oauth-secret` |
| `PORT` | Server | `3001` |
| `CLIENT_ORIGIN` | Server CORS | `http://localhost:5173` |
| `DATABASE_URL` | Server DB path | `file:./data/pingpong.sqlite` |
| `VITE_DISCORD_CLIENT_ID` | Client (browser) | Same as `DISCORD_CLIENT_ID` |
| `VITE_SERVER_HOST` | Client (browser) | `http://localhost:3001` locally, or your `https://*.trycloudflare.com` URL in Discord |
| `VITE_SOCKET_TRANSPORT` | Client Socket.IO transport | `polling` for current quick tunnel, `websocket` when `/socket.io` maps to a WebSocket-capable server tunnel |

The `VITE_` prefixed vars are embedded into the client bundle at build time by Vite.

---

## 2. Discord Developer Portal Setup

Go to [discord.com/developers/applications](https://discord.com/developers/applications) and select your application.

### 2a. Enable Embedded App

1. Navigate to **Activities** in the left sidebar
2. Toggle **Embedded App** to ON
3. Set **Supported Platforms**: check both **Desktop** and **Mobile** (iOS + Android)

### 2b. URL Mappings

Still under **Activities**, find the **URL Mappings** table. This tells Discord's proxy where to route requests from inside the Activity iframe.

Add these four rows (all pointing to your cloudflared URL, which you'll get in step 3):

| Root / Path | Target |
|-------------|--------|
| `/` | `https://YOUR-SUBDOMAIN.trycloudflare.com` |
| `/api` | `https://YOUR-SUBDOMAIN.trycloudflare.com` |
| `/socket.io` | `https://YOUR-SUBDOMAIN.trycloudflare.com` |
| `/spectate` | `https://YOUR-SUBDOMAIN.trycloudflare.com` |

Replace `YOUR-SUBDOMAIN.trycloudflare.com` with the actual URL from cloudflared. Update these every time you restart a quick tunnel (the URL changes each time). Named tunnels keep a stable URL.

### 2c. OAuth2 Configuration

1. Navigate to **OAuth2** in the left sidebar
2. Under **Redirects**, add: `https://YOUR-SUBDOMAIN.trycloudflare.com`
3. Under **Default Authorization Link**, select **In-app Authorization**
4. Set **Scopes**: `identify` (minimum required)
5. Save changes

The `identify` scope lets the Activity read the user's Discord profile (username, avatar, ID) after they authorize. That's all we need.

### 2d. Copy Credentials

From **OAuth2 → General**:

- Copy **Client ID** → paste into `.env` as `DISCORD_CLIENT_ID` and `VITE_DISCORD_CLIENT_ID`
- Copy **Client Secret** → paste into `.env` as `DISCORD_CLIENT_SECRET` (click Reset if you don't see it)

---

## 3. Local Development (3 Terminals)

You need three terminal windows/tabs. Run them in this order:

### Terminal 1: Server

```bash
pnpm --filter @pingpong/server dev
```

Waits for port 3001. You should see:

```
[info] server listening on 3001
```

The server runs SQLite migrations on boot and serves `/api/token` (OAuth exchange), `/api/_debug/tick` (health), and Socket.io (game + spectator).

### Terminal 2: Client

```bash
pnpm --filter @pingpong/client dev
```

Starts Vite dev server at `http://localhost:5173`. Leave this running.

### Terminal 3: Cloudflare Tunnel

```bash
bash infra/cloudflared.sh
```

Cloudflared prints a URL like:

```
https://abc-xyz-123.trycloudflare.com
```

Copy this URL. Go back to the Discord Developer Portal and paste it into all four URL Mappings and the OAuth2 Redirect (see step 2b/2c above).

### Quick Reference

| What | Where |
|------|-------|
| Server API | `http://localhost:3001/api/_debug/tick` |
| Client dev | `http://localhost:5173` |
| Discord Activity | Launch from your Discord server (see testing below) |

---

## 4. Two-Account Testing

You need two Discord accounts in the same voice channel to test a full match.

### Setup

1. **Account A** (app owner): Create a Discord server if you don't have one. Add your bot/application to the server.
2. **Account B**: Join the same server. Both accounts must be in the same voice channel.
3. Make sure cloudflared is running and URL Mappings are set.

### Launch the Activity

1. **Account A**: Join a voice channel. Click the **Activities** button (rocket icon) or use the app launcher. Select your Ping Pong app.
2. The Activity opens inside Discord. You should see the lobby screen.
3. **Account B**: Join the same voice channel. The Activity auto-appears for them, or they launch it the same way.

### Play a Match

1. Both players click **Ready** in the lobby
2. A 3-second countdown starts
3. The match plays to 11 points. Drag/release to move paddle and apply spin
4. Winner screen appears at the end
5. Any 3rd user joining mid-match becomes a spectator

### Reconnection Test

1. During a match, kill one player's Discord client (or disconnect internet)
2. Wait 30 seconds. The remaining player should win by forfeit (`forfeit_dc`)
3. Reconnecting within 30 seconds should resume the match

---

## 5. Mock Mode (No Discord Needed)

For fast iteration without the Portal setup, run the client in mock mode. This skips the Discord SDK entirely and uses a fake context.

Open in your browser:

```
http://localhost:5173?frame_id=mock&instance_id=test-1
```

The `frame_id=mock` query param tells the client to use `DiscordSDKMock` from the Embedded App SDK instead of connecting to Discord. The `instance_id` simulates what Discord would normally provide.

Mock mode is useful for:

- UI/layout work before Portal is configured
- Testing game logic with two browser tabs (different `instance_id` values simulate different rooms)
- Playwright automated tests (the test harness navigates to this URL)

### Two-Tab Mock Testing

Open two browser tabs:

- Tab 1: `http://localhost:5173?frame_id=mock&instance_id=test-1&user_id=player-a`
- Tab 2: `http://localhost:5173?frame_id=mock&instance_id=test-1&user_id=player-b`

Both tabs share the same `instance_id`, so they join the same game room. Use different `user_id` values to simulate two players.

### Server-Side Test Auth Bypass

When `TEST_AUTH_BYPASS=1` is set in the server environment, the socket auth middleware accepts `test_user_id` and `test_username` in the socket handshake auth payload instead of calling the Discord API. This is useful for:

- Automated integration tests (socket harness, race tests)
- Local development without a Discord access token
- CI pipelines

```bash
TEST_AUTH_BYPASS=1 pnpm --filter @pingpong/server dev
```

Client connection example (Node.js with socket.io-client):

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  auth: {
    test_user_id: 'test_user_123',
    test_username: 'TestPlayer',
  },
});
```

When `TEST_AUTH_BYPASS` is not set (or not `1`), the server validates the Discord access token via `https://discord.com/api/users/@me` using the `token` field from the handshake auth payload.

---

## 6. Troubleshooting

### CSP Errors in Console

**Symptom**: Console shows `Refused to connect` or `Content Security Policy` errors when the Activity tries to fetch your server or open a WebSocket.

**Cause**: `patchUrlMappings` was not called before the first network request, or URL Mappings in the Portal are wrong.

**Fix**:

1. Check the Portal URL Mappings table. All four entries (`/`, `/api`, `/socket.io`, `/spectate`) must point to your active cloudflared URL.
2. Restart cloudflared and update the Portal URL if the quick tunnel changed.
3. The SDK wrapper enforces the ordering (`ready()` → `patchUrlMappings()` → then fetch/WS). If you're seeing CSP errors in mock mode, check that you're passing `?frame_id=mock`.

### Cookie Issues (Auth Loops / Silent Failures)

**Symptom**: OAuth flow redirects back but the user isn't authenticated. Or repeated auth prompts.

**Cause**: Cookies set by the server need `SameSite=None; Partitioned; Secure` because the Activity runs in a cross-site iframe under `discordsays.com`.

**Fix**: The server sets these defaults automatically. If you're behind a reverse proxy that strips `Set-Cookie` headers, check that `Secure` isn't rejected (you must be on HTTPS, which cloudflared provides).

### HMR Not Working Through Tunnel

**Symptom**: You edit a file but the browser doesn't hot-reload. Manual refresh works.

**Cause**: Vite's HMR WebSocket tries to connect on the wrong port when proxied through cloudflared.

**Fix**: The client's `vite.config.ts` sets `server.hmr.clientPort = 443`, which tells Vite to advertise the HMR WebSocket on port 443 (HTTPS) instead of the dev server's port. If HMR still fails:

1. Check that cloudflared is running and the URL is correct
2. Try a full page refresh (Ctrl+Shift+R)
3. Check the browser console for WebSocket connection errors

### Server Won't Start (Port in Use)

**Symptom**: `EADDRINUSE: address already in use :::3001`

**Fix**:

```bash
lsof -i :3001          # find the process
kill <PID>             # kill it
pnpm --filter @pingpong/server dev   # restart
```

### Cloudflared URL Changed

Quick tunnels generate a random URL every restart. After restarting `infra/cloudflared.sh`:

1. Copy the new `https://*.trycloudflare.com` URL
2. Update all four URL Mappings in the Portal
3. Update the OAuth2 Redirect URL
5. Hard-refresh the Activity in Discord

For a stable URL across restarts, use the named tunnel template (`infra/cloudflared-named.sh.example`).

### "Application did not respond" in Discord

**Symptom**: Clicking the Activity button shows an error.

**Cause**: URL Mappings are empty or point to a dead URL.

**Fix**: Make sure cloudflared is running and the Portal URL Mappings match the current tunnel URL.

### Two Accounts Can't See Each Other

**Symptom**: Each player sees a different lobby/instance.

**Cause**: Different `instance_id` values. Discord assigns the same `instanceId` to users in the same voice channel Activity instance.

**Fix**: Both users must launch the Activity from the same voice channel. If testing in mock mode, use the same `instance_id` query param in both browser tabs.
