# Task 7 — Hello-Square Integration Spike

## Verified

| Check | Result |
|---|---|
| Pixi v8 Application boots on `#game` canvas | ✅ 800×600, WebGL2 context |
| Pixi v8 chained API (`.rect().fill()`) works | ✅ Green square renders |
| Rotation via `app.ticker.add()` | ✅ Square rotates continuously |
| `Text` overlay renders tick metric | ✅ Shows "tickRateHz: 20" |
| `DiscordContext.init()` mock mode detection | ✅ `frame_id=mock` → `isMock=true` |
| `patchUrlMappings` ordering (init → ready → patch → fetch) | ✅ No race conditions |
| Fetch `/api/_debug/tick` in mock mode via full URL | ✅ HTTP 200, JSON parsed correctly |
| Fetch `/api/_debug/tick` in real mode via relative path | Deferred — needs real Discord environment |
| Zero CSP violations in mock mode | ✅ Playwright console captured 0 CSP errors |
| Vite dev server serves spike correctly | ✅ HMR works (WebSocket errors expected with `clientPort: 443`) |
| Canvas has WebGL2 context | ✅ `getContext('webgl2')` returns truthy |

## Issues found

### 1. Mock mode fetch requires absolute URL (design decision, not a bug)
- **Impact**: In mock mode `patchUrlMappings` does NOT intercept `fetch()`.
  A bare `/api/_debug/tick` hits `localhost:5173` and returns 404.
- **Resolution**: `HelloSquare.ts` detects `isMock` and uses `${SERVER_HOST}/api/_debug/tick` (full URL).
- **Action for T17**: This is intentional — document as a known pattern for all future fetch calls.

### 2. Vite HMR WebSocket errors in Playwright (cosmetic, expected)
- **Cause**: `vite.config.ts` sets `hmr.clientPort: 443` (for Discord tunnel).
  In local dev, port 443 has no WS listener → `ERR_CONNECTION_REFUSED`.
- **Resolution**: No fix needed for spike. For local-only dev, override in `.env.local` or
  conditionally set `clientPort` based on `NODE_ENV`.
- **Action for T17**: Consider making `clientPort` conditional in vite.config.ts.

### 3. `better-sqlite3` requires native build scripts
- **Impact**: `pnpm install` ignores build scripts by default in pnpm v11+.
  Server won't start until `better-sqlite3` is compiled via `node-gyp rebuild`.
- **Resolution**: Run `node-gyp rebuild` in the `better-sqlite3` package directory,
  or add `.npmrc` with `onlyBuiltDependencies=better-sqlite3,esbuild`.
- **Action for T17**: Add CI-aware install step or `.npmrc` to repo.

### 4. DB_PATH resolves relative to CWD, not file location
- **Impact**: Server must be started from `packages/server/` directory, or `DB_PATH`
  env var must be set to an absolute path.
- **Resolution**: `mkdir -p data` at monorepo root, start server with `DB_PATH` set.
- **Action for T17**: Fix `packages/server/src/db/index.ts` to use `path.resolve(__dirname, DB_PATH)`.

### 5. `pnpm --filter <pkg> run dev` fails with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
- **Impact**: Cannot use `pnpm --filter` shorthand in non-interactive shells.
- **Resolution**: Run `npx vite` (client) or `node --import tsx src/index.ts` (server) directly.
- **Action for T17**: Set `CI=true` env var, or run scripts directly.

## Cleanup checklist for T17

- [ ] **Delete spike directory**: `rm -rf packages/client/src/spike/`
- [ ] **Revert main.ts spike routing**: Remove the `?spike=1` branch and `import("./spike/HelloSquare")` dynamic import
- [ ] **Keep the `?spike` detection pattern** as a documented convention for future spikes
- [ ] **Remove docs/spike-findings.md** after findings are incorporated into project docs
- [ ] **Remove .omo/evidence/task-7-*.* ** after evidence is reviewed
- [ ] **Fix vite.config.ts**: Make `hmr.clientPort` conditional (443 for Discord, undefined for local)
- [ ] **Add .npmrc**: `onlyBuiltDependencies=better-sqlite3,esbuild,@biomejs/biome`
- [ ] **Fix DB_PATH resolution**: Use `path.resolve(__dirname, DB_PATH)` in `packages/server/src/db/index.ts`

## Real Discord testing

**Status**: Deferred — manual user verification needed before Wave 3.

To test in real Discord:
1. Set up cloudflared tunnel or ngrok pointing to `localhost:5173`
2. Configure Discord application URL mappings to proxy `/api` → server
3. Navigate to Activity URL with `?spike=1`
4. Verify: rotating green square, tick metric text, no CSP violations
5. Verify: fetch goes through Discord proxy (relative URL, not absolute)
