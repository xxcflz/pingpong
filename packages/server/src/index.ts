import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import { runMigrations } from './db/index.js';
import { loadEnv } from './env.js';
import debugRoutes from './http/debug.js';
import matchRoutes from './http/matches.js';
import oauthRoutes from './http/oauth.js';
import { attachSocket } from './socket/index.js';
import { log } from './util/logger.js';

// Load .env from monorepo root (two levels up from src/)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });
const env = loadEnv();

runMigrations();
log.info('[db] migrations applied');

const app = Fastify({ logger: false });

// CORS: client origin + any *.discordsays.com
await app.register(cors, {
  origin: [env.CLIENT_ORIGIN, /\.discordsays\.com$/],
  credentials: true,
});

// Cookie defaults for Discord iframe (partitioned, cross-site)
await app.register(cookie, {
  secret: undefined, // unsigned cookies for now
  parseOptions: {
    secure: true,
    sameSite: 'none',
    partitioned: true,
  },
});

// HTTP routes
await app.register(oauthRoutes);
// Debug routes expose unauthenticated state mutation (e.g. /api/_debug/reset
// kills the live match). Never register them in production.
if (process.env.NODE_ENV !== 'production') {
  await app.register(debugRoutes);
  log.warn('[http] debug routes enabled (NODE_ENV != production)');
}
await app.register(matchRoutes);

// Health check
app.get('/api/health', async () => ({ status: 'ok' }));

// Start
const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });

    attachSocket(app.server, env.CLIENT_ORIGIN);

    log.info(`🚀 Server listening on http://localhost:${env.PORT}`);
    log.info(`   CORS origins: ${env.CLIENT_ORIGIN}, *.discordsays.com`);
  } catch (err) {
    log.error('Failed to start server', err);
    process.exit(1);
  }
};

start();
