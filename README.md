# PingPong Discord

Multiplayer Pong game embedded in Discord with AI opponent support.

## Structure

```
packages/
├── client/          # PixiJS + Vite frontend (Discord embedded app)
│   ├── src/
│   │   ├── input/   # drag controls
│   │   ├── match/   # orchestrator, game state
│   │   ├── net/     # prediction, interpolation
│   │   ├── render/  # Pixi app setup
│   │   ├── scene/   # UI components, HUD, landing page
│   │   └── sdk/     # Discord SDK wrapper
├── server/          # Fastify + Socket.IO backend
│   ├── src/
│   │   ├── db/      # SQLite + Drizzle ORM
│   │   ├── game/    # game loop, physics, match logic
│   │   ├── http/    # REST routes
│   │   ├── lobby/   # matchmaking, AI bot
│   │   ├── socket/  # WebSocket handlers
│   │   └── util/
│   └── drizzle/     # migrations
└── shared/          # TypeScript types used by both
```

## Run

```bash
pnpm install
cp .env.example .env
# edit .env with your Discord app credentials

# Start server (port 3001)
pnpm dev

# In another terminal, start client (port 5173)
pnpm --filter @pingpong/client dev
```

Open `http://localhost:5173` in browser or embed in Discord Activity.
