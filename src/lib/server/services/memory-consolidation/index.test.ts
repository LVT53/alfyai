import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let seedConnections: Array<{
	sqlite: Database.Database;
	db: ReturnType<typeof drizzle>;
}> = [];

const DAY_MS = 86_400_000;

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

const PERSONA_RESPONSE = JSON.stringify({
	sentences: [{ text: "You are a developer.", factIds: [] }],
});

describe("memory consolidation runner", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-consolidation-runner-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
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
		vi.doUnmock("../normal-chat-control-model");
	});

	it("runs sweep → steps → summary, writes a succeeded report and bumps projection revision", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// One overdue time_bound item (will be expired).
		seedItem(db, {
			userId,
			projectionStateId,
			statement: "I had a deadline yesterday.",
			metadata: { expiryClass: "time_bound", confidence: "stated" },
			expiresAt: new Date(now.getTime() - 1 * DAY_MS),
			createdAt: new Date(now.getTime() - 45 * DAY_MS),
			updatedAt: new Date(now.getTime() - 40 * DAY_MS),
		});
		// Two duplicate active items → merged by the model.
		const z1Id = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am building a swap website.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 5 * DAY_MS),
			updatedAt: new Date(now.getTime() - 5 * DAY_MS),
		});
		const z2Id = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I coded the backend for a swap site.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 4 * DAY_MS),
			updatedAt: new Date(now.getTime() - 4 * DAY_MS),
		});

		const reconcileResponse = JSON.stringify({
			actions: [
				{
					type: "merge",
					itemIds: [z1Id, z2Id],
					mergedStatement: "I built the swap-site project end to end.",
					category: "about_you",
					scope: "global",
				},
			],
		});
		// reconcile is called first, then persona summary.
		const sendJsonControlMessage = vi
			.fn()
			.mockResolvedValueOnce(makeControlResponse(reconcileResponse))
			.mockResolvedValue(makeControlResponse(PERSONA_RESPONSE));
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage,
		}));

		const revisionBefore = readProjectionRevision(db, userId);

		const { runUserMemoryConsolidation, listMemoryConsolidationReports } =
			await import("./index");
		const result = await runUserMemoryConsolidation(userId, "test");
		expect(result.status).toBe("succeeded");
		expect(result.reportId).toBeTruthy();

		const reports = await listMemoryConsolidationReports({ userId });
		expect(reports.length).toBe(1);
		const [report] = reports;
		expect(report.status).toBe("succeeded");
		expect(report.summaryText).toMatch(/retired|merged|refreshed|no changes/i);
		expect(Array.isArray(report.actions)).toBe(true);
		expect(report.actions.length).toBeGreaterThan(0);

		expect(readProjectionRevision(db, userId)).toBeGreaterThan(revisionBefore);

		// The run reason is forwarded onto the consolidation_run telemetry row.
		const { listMemoryReworkTelemetry } = await import(
			"../memory-profile/telemetry"
		);
		const telemetry = await listMemoryReworkTelemetry({ userId });
		const runRow = telemetry.find((r) => r.eventName === "consolidation_run");
		expect(runRow?.reason).toBe("test");
	});

	it("skips when nothing changed since the last succeeded report", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am a developer.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 5 * DAY_MS),
			updatedAt: new Date(now.getTime() - 5 * DAY_MS),
		});

		const sendJsonControlMessage = vi
			.fn()
			.mockResolvedValueOnce(
				makeControlResponse(JSON.stringify({ actions: [] })),
			)
			.mockResolvedValue(makeControlResponse(PERSONA_RESPONSE));
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage,
		}));

		const { runUserMemoryConsolidation, listMemoryConsolidationReports } =
			await import("./index");

		const first = await runUserMemoryConsolidation(userId, "test");
		expect(first.status).toBe("succeeded");
		const afterFirst = await listMemoryConsolidationReports({ userId });
		expect(afterFirst.length).toBe(1);

		const second = await runUserMemoryConsolidation(userId, "test");
		expect(second.status).toBe("skipped");
		const afterSecond = await listMemoryConsolidationReports({ userId });
		expect(afterSecond.length).toBe(1);
	});

	it("on step failure writes a failed report and leaves items untouched", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const aId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am an active fact.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 5 * DAY_MS),
			updatedAt: new Date(now.getTime() - 5 * DAY_MS),
		});

		// Force reconcile to throw; steps.ts swallows the model error internally,
		// so we make the step itself throw by mocking the step module.
		vi.doMock("./steps", async () => {
			const actual = await vi.importActual<typeof import("./steps")>("./steps");
			return {
				...actual,
				runReconcileAndMerge: vi.fn().mockRejectedValue(new TypeError("boom")),
			};
		});
		const sendJsonControlMessage = vi
			.fn()
			.mockResolvedValue(makeControlResponse(PERSONA_RESPONSE));
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage,
		}));

		const { runUserMemoryConsolidation, listMemoryConsolidationReports } =
			await import("./index");
		const result = await runUserMemoryConsolidation(userId, "test");
		expect(result.status).toBe("failed");

		const reports = await listMemoryConsolidationReports({ userId });
		expect(reports.length).toBe(1);
		expect(reports[0].status).toBe("failed");
		expect(reports[0].summaryText).toContain("TypeError");

		const a = readItem(db, aId);
		expect(a.status).toBe("active");
		expect(a.statement).toBe("I am an active fact.");
	});
});

describe("memory consolidation scheduler", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-consolidation-sched-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
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

	it("starts once, fires the runner on the interval, and stops cleanly", async () => {
		openSeedDatabase();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

		const mod = await import("./index");
		const runAllSpy = vi
			.spyOn(mod, "runAllUsersMemoryConsolidation")
			.mockResolvedValue(undefined);

		mod.ensureMemoryConsolidationScheduler();
		mod.ensureMemoryConsolidationScheduler(); // idempotent
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1440 * 60_000);
		expect(runAllSpy).toHaveBeenCalled();

		mod.stopMemoryConsolidationScheduler();
		runAllSpy.mockClear();
		await vi.advanceTimersByTimeAsync(1440 * 60_000);
		expect(runAllSpy).not.toHaveBeenCalled();
	});
});
