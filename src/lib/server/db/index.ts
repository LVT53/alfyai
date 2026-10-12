import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDatabasePath } from "../env";
import * as schema from "./schema";
import { takeWriteLockAtBegin } from "./write-lock";

const sqlite = new Database(getDatabasePath());
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 10000");
sqlite.pragma("foreign_keys = ON");
// A transaction that reads before it writes must not fail for a second writer
// of the file: it takes the write lock when it begins (see ./write-lock.ts).
takeWriteLockAtBegin(sqlite);

export const db = drizzle(sqlite, { schema });
export { sqlite };
export type DatabaseInstance = typeof db;
