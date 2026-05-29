import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    discordId: text("discord_id").notNull(),
    username: text("username").notNull(),
    avatar: text("avatar"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("users_discord_id_idx").on(t.discordId)],
);

export const matches = sqliteTable(
  "matches",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    instanceId: text("instance_id").notNull(),
    playerAId: integer("player_a_id")
      .notNull()
      .references(() => users.id),
    playerBId: integer("player_b_id")
      .notNull()
      .references(() => users.id),
    winnerId: integer("winner_id").references(() => users.id),
    scoreA: integer("score_a").notNull().default(0),
    scoreB: integer("score_b").notNull().default(0),
    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    endedAt: integer("ended_at", { mode: "timestamp" }),
    endReason: text("end_reason", {
      enum: ["score", "forfeit_dc", "forfeit_afk", "forfeit_leave"],
    }),
    rallyCountMax: integer("rally_count_max"),
  },
  (t) => [
    index("matches_players_idx").on(t.playerAId, t.playerBId),
    index("matches_started_at_idx").on(t.startedAt),
  ],
);
