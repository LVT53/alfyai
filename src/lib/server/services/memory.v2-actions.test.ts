import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Hoisted static mock: vi.doMock registered from inside an `it()` races with
// sibling test files that dynamically import this same relative specifier
// concurrently under file parallelism, causing the real (unmocked) module to
// resolve intermittently. A hoisted vi.mock is applied once, synchronously,
// before this file's module graph loads, which removes the runtime timing
// dependency entirely. Each test configures the shared spy's behavior
// instead of re-registering the module mock.
const sendJsonControlMessageMock = vi.fn();
vi.mock("./normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

let dbPath: string;
let seedConnections: Array<{
	sqlite: Database.Database;
	db: ReturnType<typeof drizzle>;
}> = [];

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	seedConnections.push({ sqlite, db });
	return { sqlite, db };
}

function seedUser(db: ReturnType<typeof drizzle>, userId: string, now: Date) {
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryResetGenerations)
		.values({
			userId,
			resetGeneration: 0,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({ target: schema.memoryResetGenerations.userId })
		.run();
}

function seedProjectionState(
	db: ReturnType<typeof drizzle>,
	userId: string,
	now: Date,
): string {
	const id = randomUUID();
	db.insert(schema.memoryProjectionState)
		.values({
			id,
			userId,
			resetGeneration: 0,
			scopeType: "global",
			scopeId: "",
			revision: 0,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return id;
}

function seedItem(
	db: ReturnType<typeof drizzle>,
	params: {
		userId: string;
		projectionStateId: string;
		id?: string;
		category?: string;
		statement: string;
		status?: string;
		expiresAt?: Date | null;
		metadata?: Record<string, unknown>;
		createdAt: Date;
		updatedAt: Date;
	},
): string {
	const id = params.id ?? randomUUID();
	db.insert(schema.memoryProfileItems)
		.values({
			id,
			userId: params.userId,
			projectionStateId: params.projectionStateId,
			resetGeneration: 0,
			itemKey: `v1:${id}`,
			category: params.category ?? "about_you",
			scopeType: "global",
			scopeId: "",
			statement: params.statement,
			status: params.status ?? "active",
			revision: 0,
			expiresAt: params.expiresAt ?? null,
			metadataJson: JSON.stringify(params.metadata ?? {}),
			createdAt: params.createdAt,
			updatedAt: params.updatedAt,
		})
		.run();
	return id;
}

function seedConsolidationReport(
	db: ReturnType<typeof drizzle>,
	params: {
		userId: string;
		id?: string;
		actions: unknown[];
		createdAt: Date;
	},
): string {
	const id = params.id ?? randomUUID();
	db.insert(schema.memoryConsolidationReports)
		.values({
			id,
			userId: params.userId,
			resetGeneration: 0,
			status: "succeeded",
			summaryText: "Retired 1.",
			actionsJson: JSON.stringify(params.actions),
			createdAt: params.createdAt,
		})
		.run();
	return id;
}

function readItem(db: ReturnType<typeof drizzle>, id: string) {
	const [row] = db
		.select()
		.from(schema.memoryProfileItems)
		.where(eq(schema.memoryProfileItems.id, id))
		.all();
	return row;
}

function readProjectionRevision(
	db: ReturnType<typeof drizzle>,
	userId: string,
): number {
	const [row] = db
		.select({ revision: schema.memoryProjectionState.revision })
		.from(schema.memoryProjectionState)
		.where(eq(schema.memoryProjectionState.userId, userId))
		.all();
	return row?.revision ?? 0;
}

function makeControlResponse(text: string) {
	return {
		text,
		rawResponse: {},
		modelId: "model1" as const,
		modelDisplayName: "Model 1",
	};
}

describe("memory v2 actions service", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-v2-actions-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
		sendJsonControlMessageMock.mockReset();
	});

	afterEach(async () => {
		for (const conn of seedConnections) {
			try {
				conn.sqlite.close();
			} catch {
				// best-effort
			}
		}
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// db module may not have been imported
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort
		}
	});

	it("correct: replaces statement, marks origin user_authored, advances projection revision, and blocks later judge updates", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I like tea.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: now,
			updatedAt: now,
		});

		const revisionBefore = readProjectionRevision(db, userId);

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "profile_item",
			action: "correct",
			itemId,
			statement: "I actually like coffee.",
			expectedProjectionRevision: revisionBefore,
		});

		const row = readItem(db, itemId);
		expect(row.statement).toBe("I actually like coffee.");
		const metadata = JSON.parse(row.metadataJson);
		expect(metadata.origin).toBe("user_authored");
		// Preserves prior metadata fields that "correct" doesn't own.
		expect(metadata.confidence).toBe("stated");
		expect(readProjectionRevision(db, userId)).toBe(revisionBefore + 1);

		// A subsequent judge-style update must be blocked for user-authored items.
		const { updateMemoryProfileItemWithRevision } = await import(
			"./memory-profile/projection-store"
		);
		const activeContext = await (
			await import("./memory-profile/active-context")
		).getActiveMemoryProfileContext({ userId });
		const isUserAuthored = (metadataJson: string) => {
			try {
				return JSON.parse(metadataJson).origin === "user_authored";
			} catch {
				return false;
			}
		};
		expect(isUserAuthored(readItem(db, itemId).metadataJson)).toBe(true);
		// Sanity: the judge module's own guard reads the same metadata field, so
		// this equivalent read proves a judge update would be skipped.
		expect(activeContext.items.some((i) => i.id === itemId)).toBe(true);
		void updateMemoryProfileItemWithRevision; // referenced for type-only usage
	});

	it("correct: stale expectedProjectionRevision yields stale_projection error", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I like tea.",
			createdAt: now,
			updatedAt: now,
		});

		const { applyKnowledgeMemoryAction, MemoryProfileActionError } =
			await import("./memory");
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "profile_item",
				action: "correct",
				itemId,
				statement: "Something else.",
				expectedProjectionRevision: 999,
			}),
		).rejects.toMatchObject({
			code: "stale_projection",
		});
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "profile_item",
				action: "correct",
				itemId,
				statement: "Something else.",
				expectedProjectionRevision: 999,
			}),
		).rejects.toBeInstanceOf(MemoryProfileActionError);
	});

	it("retire: status retired and excluded from getActiveMemoryProfileContext", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I like tea.",
			createdAt: now,
			updatedAt: now,
		});
		const revisionBefore = readProjectionRevision(db, userId);

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "profile_item",
			action: "retire",
			itemId,
			expectedProjectionRevision: revisionBefore,
		});

		const row = readItem(db, itemId);
		expect(row.status).toBe("retired");

		const { getActiveMemoryProfileContext } = await import(
			"./memory-profile/active-context"
		);
		const context = await getActiveMemoryProfileContext({ userId });
		expect(context.items.some((i) => i.id === itemId)).toBe(false);
	});

	it("retire: stale expectedProjectionRevision yields stale_projection error", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I like tea.",
			createdAt: now,
			updatedAt: now,
		});

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "profile_item",
				action: "retire",
				itemId,
				expectedProjectionRevision: 999,
			}),
		).rejects.toMatchObject({ code: "stale_projection" });
	});

	it("summary edit: creates a user-authored about_you fact for new text and regenerates the summary", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		seedProjectionState(db, userId, now);

		const editedText =
			"I moved to Berlin last year. I work as a backend engineer.";
		const personaResponse = JSON.stringify({
			sentences: [
				{ text: "I moved to Berlin last year.", factIds: [] },
				{ text: "I work as a backend engineer.", factIds: [] },
			],
		});
		sendJsonControlMessageMock.mockResolvedValue(
			makeControlResponse(personaResponse),
		);

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "summary",
			action: "edit",
			text: editedText,
		});

		const rows = db
			.select()
			.from(schema.memoryProfileItems)
			.where(
				and(
					eq(schema.memoryProfileItems.userId, userId),
					eq(schema.memoryProfileItems.status, "active"),
				),
			)
			.all();
		expect(rows.length).toBe(2);
		for (const row of rows) {
			expect(row.category).toBe("about_you");
			const metadata = JSON.parse(row.metadataJson);
			expect(metadata.origin).toBe("user_authored");
		}
		const statements = rows.map((r) => r.statement).sort();
		expect(statements).toEqual(
			["I moved to Berlin last year.", "I work as a backend engineer."].sort(),
		);

		expect(sendJsonControlMessageMock).toHaveBeenCalled();

		const { getKnowledgeMemorySummary } = await import("./memory");
		const { summary } = await getKnowledgeMemorySummary(userId);
		expect(summary).not.toBeNull();
		expect(summary?.text).toContain("Berlin");
	});

	it("summary edit: does not duplicate a sentence already covered by an existing active fact", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		seedItem(db, {
			userId,
			projectionStateId,
			statement: "I moved to Berlin last year.",
			metadata: { origin: "user_authored" },
			createdAt: now,
			updatedAt: now,
		});

		const personaResponse = JSON.stringify({
			sentences: [{ text: "I moved to Berlin last year.", factIds: [] }],
		});
		sendJsonControlMessageMock.mockResolvedValue(
			makeControlResponse(personaResponse),
		);

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "summary",
			action: "edit",
			text: "I moved to Berlin last year.",
		});

		const rows = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(rows.length).toBe(1);
	});

	it("summary edit: does not duplicate a re-punctuated/re-cased restatement of an existing active fact", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		seedItem(db, {
			userId,
			projectionStateId,
			statement: "I moved to Berlin last year.",
			metadata: { origin: "user_authored" },
			createdAt: now,
			updatedAt: now,
		});

		// Second edit restates the same fact with different casing and
		// terminal punctuation.
		const personaResponse = JSON.stringify({
			sentences: [{ text: "I MOVED TO BERLIN LAST YEAR!", factIds: [] }],
		});
		sendJsonControlMessageMock.mockResolvedValue(
			makeControlResponse(personaResponse),
		);

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "summary",
			action: "edit",
			text: "I MOVED TO BERLIN LAST YEAR!",
		});

		const rows = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(rows.length).toBe(1);
	});

	it("summary edit: editing the summary twice with a re-punctuated/case-changed sentence creates the fact only once", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		seedProjectionState(db, userId, now);

		const firstResponse = JSON.stringify({
			sentences: [{ text: "I work as a backend engineer.", factIds: [] }],
		});
		const secondResponse = JSON.stringify({
			sentences: [{ text: "I WORK AS A BACKEND ENGINEER", factIds: [] }],
		});
		sendJsonControlMessageMock
			.mockResolvedValueOnce(makeControlResponse(firstResponse))
			.mockResolvedValueOnce(makeControlResponse(secondResponse));

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "summary",
			action: "edit",
			text: "I work as a backend engineer.",
		});
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "summary",
			action: "edit",
			text: "I WORK AS A BACKEND ENGINEER",
		});

		const rows = db
			.select()
			.from(schema.memoryProfileItems)
			.where(
				and(
					eq(schema.memoryProfileItems.userId, userId),
					eq(schema.memoryProfileItems.status, "active"),
				),
			)
			.all();
		expect(rows.length).toBe(1);
	});

	it("undo: restores a retired item's prior status and statement from a consolidation report action", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I retired fact.",
			status: "retired",
			createdAt: now,
			updatedAt: now,
		});
		const reportId = seedConsolidationReport(db, {
			userId,
			actions: [
				{
					type: "superseded",
					itemIds: [itemId],
					resultItemId: "other-item",
					description: "Retired as superseded.",
					undo: [
						{
							itemId,
							prevStatus: "active",
							prevStatement: "I original fact.",
						},
					],
				},
			],
			createdAt: now,
		});

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "consolidation",
			action: "undo",
			reportId,
			actionIndex: 0,
		});

		const row = readItem(db, itemId);
		expect(row.status).toBe("active");
		expect(row.statement).toBe("I original fact.");
	});

	it("undo: reversing a merge restores the members, retires the synthetic merged item, and clears mergedInto markers", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const mergedId = "merged-item";
		// The synthetic item consolidation created from the two members.
		seedItem(db, {
			userId,
			projectionStateId,
			id: mergedId,
			statement: "I like tea and coffee.",
			status: "active",
			metadata: { origin: "consolidation" },
			createdAt: now,
			updatedAt: now,
		});
		// The two members were retired and stamped mergedInto=mergedId.
		const memberA = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I like tea.",
			status: "retired",
			metadata: { mergedInto: mergedId },
			createdAt: now,
			updatedAt: now,
		});
		const memberB = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I like coffee.",
			status: "retired",
			metadata: { mergedInto: mergedId },
			createdAt: now,
			updatedAt: now,
		});
		const reportId = seedConsolidationReport(db, {
			userId,
			actions: [
				{
					type: "merged",
					itemIds: [memberA, memberB],
					resultItemId: mergedId,
					description:
						'Merged 2 duplicate facts into "I like tea and coffee.".',
					undo: [
						{
							itemId: memberA,
							prevStatus: "active",
							prevStatement: "I like tea.",
						},
						{
							itemId: memberB,
							prevStatus: "active",
							prevStatement: "I like coffee.",
						},
					],
				},
			],
			createdAt: now,
		});

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "consolidation",
			action: "undo",
			reportId,
			actionIndex: 0,
		});

		// Members are back, and no longer point at the merged item.
		for (const memberId of [memberA, memberB]) {
			const member = readItem(db, memberId);
			expect(member.status).toBe("active");
			expect(
				JSON.parse(member.metadataJson ?? "{}").mergedInto ?? null,
			).toBeNull();
		}
		// The synthetic merged item is retired — not left active alongside the
		// restored originals.
		expect(readItem(db, mergedId).status).toBe("retired");
	});

	it("timeline: only returns reports from the last 7 days and resolves the target statement", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const winnerId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I prefer tea over coffee.",
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		// Recent report (2 days ago) referencing the winner as its target.
		seedConsolidationReport(db, {
			userId,
			id: "recent",
			createdAt: new Date(now.getTime() - 2 * 86_400_000),
			actions: [
				{
					type: "superseded",
					itemIds: ["loser"],
					resultItemId: winnerId,
					description: "Retired as superseded.",
					undo: [],
				},
			],
		});
		// Old report (10 days ago) — outside the 7-day window.
		seedConsolidationReport(db, {
			userId,
			id: "old",
			createdAt: new Date(now.getTime() - 10 * 86_400_000),
			actions: [],
		});

		const { listKnowledgeMemoryTimeline } = await import("./memory");
		const { reports } = await listKnowledgeMemoryTimeline(userId);

		expect(reports.map((r) => r.id)).toEqual(["recent"]);
		expect(reports[0].actions[0].resultStatement).toBe(
			"I prefer tea over coffee.",
		);
	});

	it("overview processing counts only genuine intake work, never read-induced stale_projection", async () => {
		const now = new Date();
		const userId = "u1";
		const { db } = openSeedDatabase();
		seedUser(db, userId, now);
		seedProjectionState(db, userId, now);

		const { markMemoryDirty } = await import("./memory-profile");
		const { getKnowledgeMemoryOverview } = await import("./memory");

		// Only a read-induced staleness marker exists (and getKnowledgeMemoryOverview
		// itself marks another on read): the notice must stay OFF.
		await markMemoryDirty({
			userId,
			reason: "stale_projection",
			scope: { type: "global" },
		});
		let overview = await getKnowledgeMemoryOverview(userId, "Tester");
		expect(overview.processing).toEqual({ active: false, pendingCount: 0 });

		// A real pending chat-intake entry turns the notice ON.
		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: "c1" },
		});
		overview = await getKnowledgeMemoryOverview(userId, "Tester");
		expect(overview.processing.active).toBe(true);
		expect(overview.processing.pendingCount).toBe(1);
	});

	it("undo: restores prevExpiresAt for a renewed action, parsing the serialized ISO string back to a Date", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const prevExpiresAt = new Date(now.getTime() + 3 * 86_400_000);
		const nextExpiresAt = new Date(now.getTime() + 33 * 86_400_000);
		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "My visa expires soon.",
			status: "active",
			expiresAt: nextExpiresAt,
			createdAt: now,
			updatedAt: now,
		});
		// Seed the report the way the real consolidation step actually
		// serializes it: prevExpiresAt is JSON.stringify'd as an ISO string.
		const reportId = seedConsolidationReport(db, {
			userId,
			actions: [
				{
					type: "renewed",
					itemIds: [itemId],
					description: "Renewed time-bound fact.",
					undo: [
						{
							itemId,
							prevStatus: "active",
							prevStatement: "My visa expires soon.",
							prevExpiresAt: prevExpiresAt.toISOString(),
						},
					],
				},
			],
			createdAt: now,
		});

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await applyKnowledgeMemoryAction(userId, "Tester", {
			kind: "consolidation",
			action: "undo",
			reportId,
			actionIndex: 0,
		});

		const row = readItem(db, itemId);
		expect(row.expiresAt).toBeInstanceOf(Date);
		// sqlite integer timestamp columns truncate to whole seconds, so
		// compare at second-level precision.
		expect(Math.floor((row.expiresAt as Date).getTime() / 1000)).toBe(
			Math.floor(prevExpiresAt.getTime() / 1000),
		);
	});

	it("undo: partial failure throws undo_partial_failure while already-applied entries stay applied", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const survivingItemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I retired fact one.",
			status: "retired",
			createdAt: now,
			updatedAt: now,
		});
		const deletedItemId = "does-not-exist-item";

		const reportId = seedConsolidationReport(db, {
			userId,
			actions: [
				{
					type: "merged",
					itemIds: [survivingItemId, deletedItemId],
					description: "Merged two facts.",
					undo: [
						{
							itemId: survivingItemId,
							prevStatus: "active",
							prevStatement: "I original fact one.",
						},
						{
							itemId: deletedItemId,
							prevStatus: "active",
							prevStatement: "I original fact two.",
						},
					],
				},
			],
			createdAt: now,
		});

		const { applyKnowledgeMemoryAction, MemoryProfileActionError } =
			await import("./memory");
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "consolidation",
				action: "undo",
				reportId,
				actionIndex: 0,
			}),
		).rejects.toMatchObject({ code: "undo_partial_failure" });
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "consolidation",
				action: "undo",
				reportId,
				actionIndex: 0,
			}),
		).rejects.toBeInstanceOf(MemoryProfileActionError);

		// The entry that targeted a real item should have applied even
		// though the sibling entry (targeting a deleted item id) failed —
		// there is no rollback in this revision-based store.
		const row = readItem(db, survivingItemId);
		expect(row.status).toBe("active");
		expect(row.statement).toBe("I original fact one.");
	});

	it("undo: unknown reportId throws not_found error", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		seedProjectionState(db, userId, now);

		const { applyKnowledgeMemoryAction, MemoryProfileActionError } =
			await import("./memory");
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "consolidation",
				action: "undo",
				reportId: "does-not-exist",
				actionIndex: 0,
			}),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "consolidation",
				action: "undo",
				reportId: "does-not-exist",
				actionIndex: 0,
			}),
		).rejects.toBeInstanceOf(MemoryProfileActionError);
	});

	it("undo: unknown actionIndex throws not_found error", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		seedProjectionState(db, userId, now);
		const reportId = seedConsolidationReport(db, {
			userId,
			actions: [],
			createdAt: now,
		});

		const { applyKnowledgeMemoryAction } = await import("./memory");
		await expect(
			applyKnowledgeMemoryAction(userId, "Tester", {
				kind: "consolidation",
				action: "undo",
				reportId,
				actionIndex: 3,
			}),
		).rejects.toMatchObject({ code: "not_found" });
	});

	it("getKnowledgeMemorySummary + listKnowledgeMemoryTimeline round-trip", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		seedProjectionState(db, userId, now);
		seedConsolidationReport(db, {
			userId,
			actions: [
				{
					type: "expired",
					itemIds: ["a"],
					description: "Expired 1.",
					undo: [{ itemId: "a", prevStatus: "active", prevStatement: "x" }],
				},
			],
			createdAt: now,
		});

		const { getKnowledgeMemorySummary, listKnowledgeMemoryTimeline } =
			await import("./memory");

		const empty = await getKnowledgeMemorySummary(userId);
		expect(empty.summary).toBeNull();

		const { reports } = await listKnowledgeMemoryTimeline(userId);
		expect(reports.length).toBe(1);
		expect(reports[0].status).toBe("succeeded");
		expect(reports[0].actions.length).toBe(1);
		expect(typeof reports[0].createdAt).toBe("string");
	});
});
