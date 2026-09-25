/**
 * How long a user's home summary is held comes from `env.ts`
 * (`config.homeSummaryCacheTtlMs`), which owns environment parsing — not from
 * a `process.env` read inside the service (AGENTS.md). `0` means "no cache":
 * the e2e suite runs with it because it seeds rows behind the server's back.
 *
 * Each test gives env.ts's value and the raw variable DIFFERENT answers, so a
 * service that still read `process.env` would fail here rather than pass by
 * coincidence.
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

const ttl = vi.hoisted(() => ({ ms: 0 }));

// The real config for every other field; only the TTL is the test's.
vi.mock("$lib/server/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/env")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get(target, property, receiver) {
				return property === "homeSummaryCacheTtlMs"
					? ttl.ms
					: Reflect.get(target, property, receiver);
			},
		}),
	};
});

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function orm() {
	return drizzle(sqlite, { schema });
}

function seedUser(userId: string): void {
	orm()
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

// A conversation only counts as Recent once it has a message.
function seedConversationWithMessage(
	userId: string,
	id: string,
	at: Date,
): void {
	orm()
		.insert(schema.conversations)
		.values({ id, userId, title: id, createdAt: at, updatedAt: at })
		.run();
	orm()
		.insert(schema.messages)
		.values({
			id: randomUUID(),
			conversationId: id,
			role: "user",
			content: "x",
			createdAt: at,
		})
		.run();
}

async function recentIds(userId: string, now: Date): Promise<string[]> {
	const { getHomeSummary } = await import("./home-summary");
	const summary = await getHomeSummary({ userId, now });
	return summary.recent.map((conversation) => conversation.id);
}

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-home-summary-ttl-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(orm(), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
		try {
			unlinkSync(path);
		} catch {
			// Only -wal/-shm are ever legitimately absent.
		}
	}
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("the home summary cache lifetime comes from env.ts", () => {
	const now = new Date("2026-09-24T09:00:00Z");

	it("reads fresh on every request when env.ts says 0", async () => {
		ttl.ms = 0;
		vi.stubEnv("HOME_SUMMARY_CACHE_TTL_MS", "600000");
		const userId = randomUUID();
		seedUser(userId);

		expect(await recentIds(userId, now)).toEqual([]);
		// Written behind the service's back, the way the e2e suite seeds rows.
		seedConversationWithMessage(userId, "seeded-after-first-read", now);

		expect(await recentIds(userId, now)).toEqual(["seeded-after-first-read"]);
	});

	it("serves the held summary for exactly env.ts's TTL, then reads again", async () => {
		ttl.ms = 60_000;
		vi.stubEnv("HOME_SUMMARY_CACHE_TTL_MS", "0");
		const userId = randomUUID();
		seedUser(userId);

		expect(await recentIds(userId, now)).toEqual([]);
		seedConversationWithMessage(userId, "seeded-after-first-read", now);

		const justBefore = new Date(now.getTime() + 59_999);
		expect(await recentIds(userId, justBefore)).toEqual([]);

		const expired = new Date(now.getTime() + 60_000);
		expect(await recentIds(userId, expired)).toEqual([
			"seeded-after-first-read",
		]);
	});
});
