import { desc, eq, or } from 'drizzle-orm';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type { DrizzleDb } from './index.js';
import { matches, users } from './schema.js';

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type Match = InferSelectModel<typeof matches>;
export type NewMatch = InferInsertModel<typeof matches>;

/** Insert or update a user by their Discord ID. Returns the user row. */
export function upsertUserByDiscordId(
  db: DrizzleDb,
  data: { discordId: string; username: string; avatar?: string | null },
): User {
  const now = new Date();
  const existing = db.select().from(users).where(eq(users.discordId, data.discordId)).get();

  if (existing) {
    const updated = db
      .update(users)
      .set({ username: data.username, avatar: data.avatar ?? null, updatedAt: now })
      .where(eq(users.discordId, data.discordId))
      .returning()
      .get();
    return updated;
  }

  const inserted = db
    .insert(users)
    .values({
      discordId: data.discordId,
      username: data.username,
      avatar: data.avatar ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return inserted;
}

/** Create a new match. Returns the inserted row. */
export function createMatch(
  db: DrizzleDb,
  data: {
    instanceId: string;
    playerAId: number;
    playerBId: number;
  },
): Match {
  const now = new Date();
  const inserted = db
    .insert(matches)
    .values({
      instanceId: data.instanceId,
      playerAId: data.playerAId,
      playerBId: data.playerBId,
      startedAt: now,
    })
    .returning()
    .get();
  return inserted;
}

/** End a match by setting scores, winner, end reason, and ended_at. Returns updated row. */
export function endMatch(
  db: DrizzleDb,
  matchId: number,
  data: {
    scoreA: number;
    scoreB: number;
    winnerId: number | null;
    endReason: 'score' | 'forfeit_dc' | 'forfeit_afk' | 'forfeit_leave';
    rallyCountMax?: number | null;
  },
): Match {
  const now = new Date();
  const updated = db
    .update(matches)
    .set({
      scoreA: data.scoreA,
      scoreB: data.scoreB,
      winnerId: data.winnerId,
      endReason: data.endReason,
      rallyCountMax: data.rallyCountMax ?? null,
      endedAt: now,
    })
    .where(eq(matches.id, matchId))
    .returning()
    .get();
  return updated;
}

/** List recent matches where the user was either player A or B. */
export function listRecentMatchesForUser(db: DrizzleDb, userId: number, limit = 20): Match[] {
  return db
    .select()
    .from(matches)
    .where(or(eq(matches.playerAId, userId), eq(matches.playerBId, userId)))
    .orderBy(desc(matches.startedAt))
    .limit(limit)
    .all();
}
