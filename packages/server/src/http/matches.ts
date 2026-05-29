import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, matches } from "../db/schema.js";
import { listRecentMatchesForUser } from "../db/repos.js";
import type { MatchSummary, UserSummary } from "@pingpong/shared";
import { log } from "../util/logger.js";

// ── Bearer auth (HTTP context) ────────────────────────────────────────────────
// Reuses the same Discord /users/@me pattern as lobby/auth.ts but for HTTP.

interface AuthenticatedUser {
  id: string;
  username: string;
  avatar: string | null;
}

const DISCORD_API = "https://discord.com/api/v10";
const userCache = new Map<string, { user: AuthenticatedUser; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Validate a Bearer token via Discord /users/@me.
 * Supports TEST_AUTH_BYPASS=1 with mock tokens of the form "test:<id>:<username>".
 */
async function validateBearerToken(
  authHeader: string | undefined,
): Promise<AuthenticatedUser | null> {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  if (!token) return null;

  // Test bypass
  if (process.env.TEST_AUTH_BYPASS === "1") {
    // Accept "test:<userId>:<username>" tokens
    const parts = token.split(":");
    if (parts[0] === "test" && parts.length >= 3) {
      return { id: parts[1]!, username: parts.slice(2).join(":"), avatar: null };
    }
    // Also accept any raw test token as a generic test user
    return { id: token, username: `test_${token}`, avatar: null };
  }

  // Cache check
  const cached = userCache.get(token);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.user;
  }

  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      log.warn(`[http:auth] Discord /users/@me returned ${res.status}`);
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
    return user;
  } catch (err) {
    log.error("[http:auth] Discord API error", err);
    return null;
  }
}

// ── Hydration helpers ─────────────────────────────────────────────────────────

/** Look up a user row by internal numeric id. Returns null if missing. */
function getUserById(userId: number) {
  return db.select().from(users).where(eq(users.id, userId)).get() ?? null;
}

/** Build a UserSummary from a DB user row. */
function toUserSummary(row: { id: number; username: string; avatar: string | null }): UserSummary {
  return {
    id: String(row.id),
    username: row.username,
    avatarUrl: row.avatar ?? null,
  };
}

/** Extended MatchSummary with startedAt for time-ago display. */
export interface MatchHistoryEntry extends MatchSummary {
  startedAt: number;
}

function hydrateMatch(matchRow: {
  id: number;
  instanceId: string;
  playerAId: number;
  playerBId: number;
  winnerId: number | null;
  scoreA: number;
  scoreB: number;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}): MatchHistoryEntry | null {
  const playerA = getUserById(matchRow.playerAId);
  const playerB = getUserById(matchRow.playerBId);
  if (!playerA || !playerB) return null;

  const durationMs = matchRow.endedAt
    ? matchRow.endedAt.getTime() - matchRow.startedAt.getTime()
    : 0;

  // Map winnerId to slot
  let winner: "top" | "bottom" = "bottom";
  if (matchRow.winnerId === matchRow.playerAId) {
    winner = "bottom";
  } else if (matchRow.winnerId === matchRow.playerBId) {
    winner = "top";
  }

  return {
    matchId: String(matchRow.id),
    winner,
    reason: (matchRow.endReason as MatchSummary["reason"]) ?? "score",
    score: { top: matchRow.scoreB, bottom: matchRow.scoreA },
    durationMs,
    startedAt: matchRow.startedAt.getTime(),
    players: {
      top: toUserSummary(playerB),
      bottom: toUserSummary(playerA),
    },
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

const matchRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/matches", async (req, reply) => {
    const authed = await validateBearerToken(req.headers.authorization);
    if (!authed) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const query = req.query as Record<string, string | undefined>;
    const userIdParam = query.userId;
    if (!userIdParam) {
      return reply.code(400).send({ error: "missing userId query parameter" });
    }

    let userRow = getUserById(Number(userIdParam));
    if (!userRow) {
      userRow =
        db
          .select()
          .from(users)
          .where(eq(users.discordId, userIdParam))
          .get() ?? null;
    }
    if (!userRow) {
      return reply.code(404).send({ error: "user not found" });
    }

    const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 50);
    const rawMatches = listRecentMatchesForUser(db, userRow.id, limit);

    const hydrated: MatchHistoryEntry[] = [];
    for (const m of rawMatches) {
      const summary = hydrateMatch(m);
      if (summary) hydrated.push(summary);
    }

    return reply.code(200).send({ matches: hydrated });
  });

  app.get("/api/matches/:id", async (req, reply) => {
    const authed = await validateBearerToken(req.headers.authorization);
    if (!authed) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const params = req.params as Record<string, string>;
    const matchId = Number(params.id);
    if (isNaN(matchId)) {
      return reply.code(400).send({ error: "invalid match id" });
    }

    const matchRow =
      db
        .select()
        .from(matches)
        .where(eq(matches.id, matchId))
        .get() ?? null;

    if (!matchRow) {
      return reply.code(404).send({ error: "match not found" });
    }

    const summary = hydrateMatch(matchRow);
    if (!summary) {
      return reply.code(500).send({ error: "failed to hydrate match" });
    }

    return reply.code(200).send(summary);
  });
};

export default matchRoutes;
