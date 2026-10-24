/**
 * Owner-reported bugs (2026-10-24): a chat renamed in the sidebar kept its old
 * name in the new-chat page's Recent row, and a chat deleted there stayed in
 * it. That row is read from `GET /api/home/summary`, which holds each user's
 * summary for 30 seconds (`getHomeSummary` in home-summary.ts), and neither
 * the rename nor the delete let go of it, so a new-chat page opened inside
 * that window drew the old row back.
 *
 * Real route, real summary, real (in-memory) database. The first read primes
 * the cache exactly as opening the new-chat page does; the change has to show
 * on the very next read, well inside the 30 seconds.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { RequestEvent } from "./$types";

let memory: InMemoryDatabase;

// The production lifetime, whatever the shell running the suite says: a run
// with the cache off would pass this test without proving anything.
vi.mock("$lib/server/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/env")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get(target, property, receiver) {
				return property === "homeSummaryCacheTtlMs"
					? 30_000
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
	title: string,
	at: Date,
): void {
	memory.db
		.insert(schema.conversations)
		.values({ id, userId, title, createdAt: at, updatedAt: at })
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

function renameEvent(userId: string, id: string, title: string): RequestEvent {
	const url = `http://localhost/api/conversations/${id}`;
	return {
		request: new Request(url, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		}),
		locals: { user: { id: userId } },
		params: { id },
		url: new URL(url),
		route: { id: "/api/conversations/[id]" },
	} as unknown as RequestEvent;
}

function deleteEvent(userId: string, id: string): RequestEvent {
	const url = `http://localhost/api/conversations/${id}`;
	return {
		request: new Request(url, { method: "DELETE" }),
		locals: { user: { id: userId } },
		params: { id },
		url: new URL(url),
		route: { id: "/api/conversations/[id]" },
	} as unknown as RequestEvent;
}

const openedAt = new Date("2026-10-24T09:00:00Z");
const fiveSecondsLater = new Date(openedAt.getTime() + 5_000);

beforeEach(() => {
	memory = createInMemoryDatabase();
});

afterEach(() => {
	memory.close();
	// A fresh summary module per test, so no cache outlives its test.
	vi.resetModules();
});

describe("PATCH /api/conversations/[id] with a new title", () => {
	it("shows the new name on the home summary's next read, inside the cache's 30 seconds", async () => {
		seedUser("user-1");
		seedConversationWithMessage("user-1", "conv-1", "Old name", openedAt);
		const { getHomeSummary } = await import(
			"$lib/server/services/home-summary"
		);
		const { PATCH } = await import("./+server");

		const before = await getHomeSummary({ userId: "user-1", now: openedAt });
		expect(before.recent.map((line) => line.title)).toEqual(["Old name"]);

		const response = await PATCH(renameEvent("user-1", "conv-1", "New name"));
		expect(response.status).toBe(200);

		const after = await getHomeSummary({
			userId: "user-1",
			now: fiveSecondsLater,
		});
		expect(after.recent.map((line) => line.title)).toEqual(["New name"]);
	});
});

describe("DELETE /api/conversations/[id]", () => {
	it("drops the chat from the home summary's next read, inside the cache's 30 seconds", async () => {
		seedUser("user-1");
		seedConversationWithMessage("user-1", "kept", "Kept", openedAt);
		seedConversationWithMessage(
			"user-1",
			"deleted",
			"Deleted",
			new Date(openedAt.getTime() + 1_000),
		);
		const { getHomeSummary } = await import(
			"$lib/server/services/home-summary"
		);
		const { DELETE } = await import("./+server");

		const before = await getHomeSummary({ userId: "user-1", now: openedAt });
		expect(before.recent.map((line) => line.id)).toEqual(["deleted", "kept"]);

		const response = await DELETE(deleteEvent("user-1", "deleted"));
		expect(response.status).toBe(200);

		const after = await getHomeSummary({
			userId: "user-1",
			now: fiveSecondsLater,
		});
		expect(after.recent.map((line) => line.id)).toEqual(["kept"]);
	});
});
