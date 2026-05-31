import type { Socket } from 'socket.io';
import { log } from '../util/logger.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  avatar: string | null;
}

const DISCORD_API = 'https://discord.com/api/v10';

const userCache = new Map<string, { user: AuthenticatedUser; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Validate Discord access token via /users/@me, cache result on socket.data.user.
 *
 * When TEST_AUTH_BYPASS=1, accepts { test_user_id, test_username } from the
 * socket handshake auth payload instead of calling Discord.
 */
export async function authenticateSocket(socket: Socket): Promise<AuthenticatedUser | null> {
  if (process.env.TEST_AUTH_BYPASS === '1') {
    return authenticateTestMode(socket);
  }

  return authenticateDiscord(socket);
}

function authenticateTestMode(socket: Socket): AuthenticatedUser | null {
  const testUserId = socket.handshake.auth?.test_user_id as string | undefined;
  const testUsername = socket.handshake.auth?.test_username as string | undefined;

  if (!testUserId || !testUsername) {
    log.warn('[auth] TEST_AUTH_BYPASS=1 but missing test_user_id or test_username');
    return null;
  }

  const user: AuthenticatedUser = {
    id: testUserId,
    username: testUsername,
    avatar: null,
  };
  socket.data.user = user;
  return user;
}

async function authenticateDiscord(socket: Socket): Promise<AuthenticatedUser | null> {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    log.warn('[auth] no token in handshake auth');
    return null;
  }

  const cached = userCache.get(token);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    socket.data.user = cached.user;
    return cached.user;
  }

  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      log.warn(`[auth] Discord /users/@me returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      id: string;
      username: string;
      avatar: string | null;
    };

    const user: AuthenticatedUser = {
      id: data.id,
      username: data.username,
      avatar: data.avatar,
    };

    userCache.set(token, { user, cachedAt: Date.now() });
    socket.data.user = user;
    return user;
  } catch (err) {
    log.error('[auth] Discord API error', err);
    return null;
  }
}
