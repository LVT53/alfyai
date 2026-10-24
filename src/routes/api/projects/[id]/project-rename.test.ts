/**
 * Owner-reported bug (2026-10-24): a project folder renamed in the sidebar
 * kept its old name on the new-chat page's projects row. The row is read from
 * `GET /api/home/summary`, which holds each user's summary for 30 seconds
 * (`getHomeSummary` in home-summary.ts), and the project's PATCH never let go
 * of it. The card also shows whether the project has instructions, which the
 * same PATCH writes.
 *
 * Real route, real summary, real (in-memory) database: the first read primes
 * the cache exactly as opening the new-chat page does, and the edit has to
 * show on the very next read, well inside the 30 seconds.
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

const openedAt = new Date("2026-10-24T09:00:00Z");

// A project reaches the row once one of its chats has carried a message.
function seedActiveProject(userId: string, projectId: string, name: string) {
	memory.db
		.insert(schema.users)
		.values({ id: userId, email: `${userId}@example.com`, passwordHash: "x" })
		.run();
	memory.db
		.insert(schema.projects)
		.values({
			id: projectId,
			userId,
			name,
			createdAt: openedAt,
			updatedAt: openedAt,
		})
		.run();
	const conversationId = randomUUID();
	memory.db
		.insert(schema.conversations)
		.values({
			id: conversationId,
			userId,
			projectId,
			title: "A chat in the project",
			createdAt: openedAt,
			updatedAt: openedAt,
		})
		.run();
	memory.db
		.insert(schema.messages)
		.values({
			id: randomUUID(),
			conversationId,
			role: "user",
			content: "x",
			createdAt: openedAt,
		})
		.run();
}

function patchEvent(
	userId: string,
	projectId: string,
	body: Record<string, unknown>,
): RequestEvent {
	const url = `http://localhost/api/projects/${projectId}`;
	return {
		request: new Request(url, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: userId } },
		params: { id: projectId },
		url: new URL(url),
		route: { id: "/api/projects/[id]" },
	} as unknown as RequestEvent;
}

async function cardAfter(edit: Record<string, unknown>) {
	const { getHomeSummary } = await import("$lib/server/services/home-summary");
	const { PATCH } = await import("./+server");

	const before = await getHomeSummary({ userId: "user-1", now: openedAt });
	expect(before.projects.map((card) => card.name)).toEqual(["Old folder"]);

	const response = await PATCH(patchEvent("user-1", "project-1", edit));
	expect(response.status).toBe(200);

	const after = await getHomeSummary({
		userId: "user-1",
		now: new Date(openedAt.getTime() + 5_000),
	});
	return after.projects[0];
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedActiveProject("user-1", "project-1", "Old folder");
});

afterEach(() => {
	memory.close();
	// A fresh summary module per test, so no cache outlives its test.
	vi.resetModules();
});

describe("PATCH /api/projects/[id]", () => {
	it("shows a new name on the home summary's next read, inside the cache's 30 seconds", async () => {
		const card = await cardAfter({ name: "New folder" });
		expect(card?.name).toBe("New folder");
	});

	it("shows new instructions on the home summary's next read", async () => {
		const card = await cardAfter({ instructions: "Prefer trains." });
		expect(card?.hasInstructions).toBe(true);
	});
});
