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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";

let memory: InMemoryDatabase;

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
		return memory.db;
	},
}));

function seedUser(userId: string): void {
	memory.db
		.insert(schema.users)
		.values({ id: userId, email: `${userId}@example.com`, passwordHash: "x" })
		.run();
}

// A conversation only counts as Recent once it has a message.
function seedConversationWithMessage(
	userId: string,
	id: string,
	at: Date,
): void {
	memory.db
		.insert(schema.conversations)
		.values({ id, userId, title: id, createdAt: at, updatedAt: at })
		.run();
	memory.db
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
	memory = createInMemoryDatabase();
});

afterEach(() => {
	memory.close();
	vi.unstubAllEnvs();
	// A fresh module per test, so no summary cached by one test is served in
	// the next.
	vi.resetModules();
});

describe("the home summary cache lifetime comes from env.ts", () => {
	const now = new Date("2026-09-24T09:00:00Z");

	it("reads fresh on every request when env.ts says 0", async () => {
		ttl.ms = 0;
		vi.stubEnv("HOME_SUMMARY_CACHE_TTL_MS", "600000");
		seedUser("user-1");

		expect(await recentIds("user-1", now)).toEqual([]);
		// Written behind the service's back, the way the e2e suite seeds rows.
		seedConversationWithMessage("user-1", "seeded-after-first-read", now);

		expect(await recentIds("user-1", now)).toEqual(["seeded-after-first-read"]);
	});

	it("serves the held summary for exactly env.ts's TTL, then reads again", async () => {
		ttl.ms = 60_000;
		vi.stubEnv("HOME_SUMMARY_CACHE_TTL_MS", "0");
		seedUser("user-1");

		expect(await recentIds("user-1", now)).toEqual([]);
		seedConversationWithMessage("user-1", "seeded-after-first-read", now);

		const justBefore = new Date(now.getTime() + 59_999);
		expect(await recentIds("user-1", justBefore)).toEqual([]);

		const expired = new Date(now.getTime() + 60_000);
		expect(await recentIds("user-1", expired)).toEqual([
			"seeded-after-first-read",
		]);
	});
});
