# Production Runbook

Operational guide for deploying and maintaining the Ping Pong Activity in production. Covers environment setup, persistent tunneling, VPS migration, backups, and known limits.

For local development, see [dev-runbook.md](./dev-runbook.md).

---

## Environment variables

Every variable from `.env.example` listed here with production-appropriate values.

| Key | Purpose | Production Value |
|-----|---------|-----------------|
| `NODE_ENV` | Runtime mode | `production` |
| `DISCORD_CLIENT_ID` | OAuth2 client ID (from Discord Portal) | `YOUR_CLIENT_ID` |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret (from Discord Portal) | `YOUR_CLIENT_SECRET` |
| `PORT` | Server listen port | `3001` |
| `CLIENT_ORIGIN` | CORS allowlist origin | `https://pingpong.yourdomain.com` |
| `DATABASE_URL` | SQLite file path (Drizzle Kit migrations) | `file:/var/lib/pingpong/pingpong.sqlite` |
| `DB_PATH` | SQLite file path (runtime server) | `/var/lib/pingpong/pingpong.sqlite` |
| `VITE_DISCORD_CLIENT_ID` | Client-side Discord app ID (embedded at build time) | Same as `DISCORD_CLIENT_ID` |
| `VITE_SERVER_HOST` | Client-side server hostname (embedded at build time) | `pingpong.yourdomain.com` |

Notes:

- `VITE_` prefixed vars are baked into the client JS bundle during `vite build`. Changing them requires a rebuild.
- `DATABASE_URL` is used by Drizzle Kit (`drizzle-kit migrate`) for migrations. `DB_PATH` is used by the running server. Both should point to the same file.
- `*.discordsays.com` is auto-allowed in the CORS config. You do not need to add it to `CLIENT_ORIGIN`.
- `CLIENT_ORIGIN` must be HTTPS in production. Without HTTPS, the `Secure` cookie flag causes auth to silently fail inside the Discord iframe.

---

## Persistent cloudflared (Phase 1)

Phase 1 runs the server on your personal PC with a named Cloudflare tunnel for a stable URL.

### 1. Authenticate

```bash
cloudflared tunnel login
```

Opens a browser. Pick the Cloudflare zone (domain) you own. A `cert.pem` is saved to `~/.cloudflared/`.

### 2. Create the tunnel

```bash
cloudflared tunnel create pingpong-prod
```

Outputs a tunnel UUID like `a1b2c3d4-...`. Save it.

### 3. Route DNS

```bash
cloudflared tunnel route dns pingpong-prod pingpong.yourdomain.com
```

Creates a CNAME record: `pingpong.yourdomain.com` → `<UUID>.cfargotunnel.com`.

### 4. Write the config

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /home/<user>/.cloudflared/<UUID>.json

ingress:
  - hostname: pingpong.yourdomain.com
    service: http://localhost:3001
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

The `noTLSVerify: true` line avoids issues if the local server isn't running HTTPS itself.

### 5. Update Discord Portal URL Mappings

Go to [Discord Developer Portal](https://discord.com/developers/applications) → your app → Activities → URL Mappings. Update all four entries:

| Root / Path | Target |
|-------------|--------|
| `/` | `https://pingpong.yourdomain.com` |
| `/api` | `https://pingpong.yourdomain.com` |
| `/socket.io` | `https://pingpong.yourdomain.com` |
| `/spectate` | `https://pingpong.yourdomain.com` |

Also update OAuth2 → Redirect URLs to `https://pingpong.yourdomain.com`.

### 6. Auto-restart

Pick one approach:

**systemd (recommended)**

Create `/etc/systemd/system/cloudflared-tunnel.service`:

```ini
[Unit]
Description=Cloudflared Tunnel (pingpong-prod)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel run pingpong-prod
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-tunnel
sudo journalctl -u cloudflared-tunnel -f   # watch logs
```

**pm2 (alternative)**

```bash
pm2 start cloudflared --name pingpong-tunnel -- tunnel run pingpong-prod
pm2 save
```

### Tunnel stability

Named tunnels keep the same URL across restarts. The UUID and DNS CNAME don't change unless you delete the tunnel. If the tunnel process crashes, systemd/pm2 restarts it automatically.

---

## VPS Migration (Phase 2)

Move off your personal PC to a VPS with a proper reverse proxy. No more cloudflared needed.

### Checklist

#### 1. Provision a VPS

Any small instance works (1 vCPU, 1 GB RAM). Ubuntu 22.04+ or Debian 12+ recommended.

#### 2. Install runtime dependencies

```bash
# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# pnpm 9+
corepack enable
corepack prepare pnpm@9 --activate

# git
sudo apt install -y git
```

Verify:

```bash
node --version   # v20.x
pnpm --version   # 9.x
```

#### 3. Clone and build

```bash
git clone <your-repo-url> /opt/pingpong
cd /opt/pingpong
pnpm install --prod
pnpm -r run build
```

#### 4. Provision the SQLite path

```bash
sudo mkdir -p /var/lib/pingpong
sudo chown <user>:<user> /var/lib/pingpong
```

#### 5. Run migrations

```bash
DATABASE_URL=file:/var/lib/pingpong/pingpong.sqlite \
  pnpm --filter @pingpong/server db:migrate
```

#### 6. Set up reverse proxy

**Caddy (recommended)**

Caddy auto-provisions TLS via Let's Encrypt. Install:

```bash
sudo apt install -y caddy
```

Edit `/etc/caddy/Caddyfile`:

```
pingpong.yourdomain.com {
    reverse_proxy localhost:3001 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}

        # WebSocket upgrade for Socket.IO
        transport http {
            dial_timeout 5s
            response_header_timeout 30s
        }
    }

    # Socket.IO needs WebSocket support (Caddy handles this automatically)
}
```

```bash
sudo systemctl reload caddy
```

Caddy handles HTTPS cert provisioning and renewal automatically.

**nginx (alternative)**

```nginx
server {
    listen 443 ssl http2;
    server_name pingpong.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/pingpong.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pingpong.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade (required for Socket.IO)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

#### 7. Update Discord Portal URL Mappings

Same as Phase 1 step 5. Point all four URL Mappings and OAuth2 Redirect to `https://pingpong.yourdomain.com`. If you were using cloudflared before, remove the old tunnel entries.

#### 8. Process manager

**systemd (recommended)**

Create `/etc/systemd/system/pingpong.service`:

```ini
[Unit]
Description=Ping Pong Discord Activity Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/opt/pingpong
Environment=NODE_ENV=production
Environment=DISCORD_CLIENT_ID=<your-id>
Environment=DISCORD_CLIENT_SECRET=<your-secret>
Environment=PORT=3001
Environment=CLIENT_ORIGIN=https://pingpong.yourdomain.com
Environment=DB_PATH=/var/lib/pingpong/pingpong.sqlite
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pingpong
```

**pm2 (alternative)**

```bash
pm2 start packages/server/dist/index.js --name pingpong-server \
  --env production \
  --node-args="--env-file=.env.production"
pm2 save
pm2 startup   # generates the auto-start command
```

#### 9. Optional: SQLite to PostgreSQL migration

If you outgrow SQLite (concurrent writes, multi-instance scaling):

1. Swap `better-sqlite3` for `pg` + `drizzle-orm/pg-core`
2. Update `drizzle.config.ts` dialect to `"postgresql"`
3. Generate new migrations: `pnpm --filter @pingpong/server db:generate`
4. Update `DB_PATH` to a `DATABASE_URL` connection string
5. Export SQLite data, import into PostgreSQL
6. Update the server's `db/index.ts` to use `pg` Pool

This is a larger refactor. Only do it if you need multiple server instances or hit SQLite write contention.

---

## Backup

### SQLite backup strategy

SQLite files can be copied safely while the server is running, thanks to WAL mode.

```bash
# One-shot backup
sqlite3 /var/lib/pingpong/pingpong.sqlite ".backup /var/lib/pingpong/backups/pingpong-$(date +%Y%m%d-%H%M%S).sqlite"
```

### Cron job

```bash
# /etc/cron.d/pingpong-backup
0 */6 * * * <user> sqlite3 /var/lib/pingpong/pingpong.sqlite ".backup /var/lib/pingpong/backups/pingpong-$(date +\%Y\%m\%d-\%H\%M\%S).sqlite" && find /var/lib/pingpong/backups -mtime +7 -delete
```

This runs every 6 hours and prunes backups older than 7 days.

### Future: Litestream

For continuous replication to S3/R2, consider [Litestream](https://litestream.io/). It runs alongside the server and streams WAL changes to object storage. No application changes needed.

---

## Cookie security

The Discord Activity runs inside a cross-site iframe under `discordsays.com`. Cookies must be set with these flags or authentication silently fails:

```
SameSite=None; Partitioned; Secure
```

The server configures this in `@fastify/cookie` parseOptions:

```ts
{
  secure: true,
  sameSite: 'none',
  partitioned: true,
}
```

**What breaks without this:**

- `SameSite=Strict` or `SameSite=Lax` → browser drops the cookie in the cross-site iframe → OAuth loop
- Missing `Partitioned` → Chrome may block the cookie under third-party cookie restrictions
- Missing `Secure` → browser rejects `SameSite=None` cookies over HTTP

**Production requirement:** You must serve over HTTPS. Caddy handles this automatically. If using cloudflared, the tunnel provides HTTPS end-to-end. Without HTTPS, the Activity will not authenticate.

---

## Monitoring (Lite)

No external observability tools. Logs and a health endpoint are all you need for this project.

### Logs

```bash
# systemd
journalctl -u pingpong -f

# pm2
pm2 logs pingpong-server
```

### Health check

```bash
curl -s https://pingpong.yourdomain.com/api/_debug/tick | jq .
```

Returns `{ tick: N, uptime: N }` if the server is alive. Poll this from a cron job or UptimeRobot-style service.

### Lobby debug

```bash
curl -s https://pingpong.yourdomain.com/api/_debug/lobby | jq .
```

Returns `{ phase, slots, countdownRemaining }` for the current lobby state.

---

## Update Workflow

Deploying a new version:

```bash
cd /opt/pingpong
git pull
pnpm install
pnpm -r run build
sudo systemctl restart pingpong   # or: pm2 restart pingpong-server
```

If migrations were added:

```bash
DATABASE_URL=file:/var/lib/pingpong/pingpong.sqlite \
  pnpm --filter @pingpong/server db:migrate
```

Run migrations before restarting the server.

---

## Limits

Known constraints for the MVP.

| Constraint | Detail |
|-----------|--------|
| 1 match per server | Design limitation. Each voice channel instance runs one match. No matchmaking queue. |
| Sync SQLite writes | `better-sqlite3` uses synchronous writes. Fine for one server process, but won't scale to multiple instances. See the PostgreSQL migration section above. |
| Cloudflared bandwidth | Free tier tunnels have no hard bandwidth cap, but Cloudflare may throttle during extreme usage. Named tunnels are more reliable than quick tunnels. |
| Single server process | The game loop and lobby state live in-process memory. Running multiple server instances requires a shared state layer (Redis, PostgreSQL). Not needed for MVP. |
| No CI/CD | Deployments are manual `git pull` + rebuild. Acceptable for a personal project. |
| No observability stack | Logs go to journalctl/pm2. No metrics, traces, or alerting. Keep the Activity simple. |
