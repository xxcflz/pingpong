import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH ?? "../data/pingpong.sqlite";

const sqlite = new Database(DB_PATH);

// Performance pragmas
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

/** Run pending migrations from drizzle/migrations/ */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(__dirname, "../../drizzle/migrations");
  migrate(db, { migrationsFolder });
}

export type DrizzleDb = typeof db;
