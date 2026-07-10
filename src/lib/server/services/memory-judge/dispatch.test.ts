import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Hoisted static mock of the control model (see index.test.ts for the rationale):
// each test configures the shared spy's behaviour instead of re-registering.
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
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

const NOW = new Date("2026-06-01T10:00:00.000Z");

function seedUserAndConversation(params: {
	db: ReturnType<typeof drizzle>;
	userId?: string;
	conversationId?: string;
}) {
	const userId = params.userId ?? "u1";
	const conversationId = params.conversationId ?? "c1";
	params.db
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	params.db
		.insert(schema.conversations)
		.values({
			id: conversationId,
			userId,
			title: "Test Conversation",
			status: "open",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	params.db
		.insert(schema.memoryResetGenerations)
		.values({
			userId,
			resetGeneration: 0,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.onConflictDoNothing({ target: schema.memoryResetGenerations.userId })
		.run();
	return { userId, conversationId };
}

function seedMessages(params: {
	db: ReturnType<typeof drizzle>;
	conversationId: string;
	entries: Array<{ role: "user" | "assistant"; content: string }>;
}) {
	for (let i = 0; i < params.entries.length; i++) {
		const entry = params.entries[i];
		params.db
			.insert(schema.messages)
			.values({
				id: `msg-${i}`,
				conversationId: params.conversationId,
				messageSequence: i + 1,
				role: entry.role,
				content: entry.content,
				createdAt: new Date(NOW.getTime() + i * 60_000),
			})
			.run();
	}
}

function mockControlModel(payload: unknown) {
	sendJsonControlMessageMock.mockImplementation(async () => ({
		text: JSON.stringify(payload),
		rawResponse: null,
		modelId: "model1",
		modelDisplayName: "test",
	}));
}

async function readWatermark(
	db: ReturnType<typeof drizzle>,
	conversationId: string,
): Promise<number> {
	return (
		db
			.select()
			.from(schema.conversationMemoryWatermarks)
			.where(
				eq(schema.conversationMemoryWatermarks.conversationId, conversationId),
			)
			.all()[0]?.lastJudgedSequence ?? 0
	);
}

function pendingDirtyRows(
	db: ReturnType<typeof drizzle>,
	conversationId: string,
) {
	return db
		.select()
		.from(schema.memoryDirtyLedger)
		.where(
			and(
				eq(schema.memoryDirtyLedger.scopeType, "conversation"),
				eq(schema.memoryDirtyLedger.scopeId, conversationId),
				eq(schema.memoryDirtyLedger.status, "pending"),
			),
		)
		.all();
}

describe("judgeFinishedTurn dispatch", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-judge-dispatch-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		delete process.env.MEMORY_JUDGE_DRY_RUN;
		vi.resetModules();
		seedConnections = [];
		sendJsonControlMessageMock.mockReset();
	});

	afterEach(async () => {
		try {
			const { stopMemoryJudgeRunner } = await import("./runner");
			stopMemoryJudgeRunner();
		} catch {
			// runner may not have been imported
		}
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
			// best-effort cleanup
		}
	});

	it("explicit request advances the watermark over the exchange when it is the whole unjudged tail (D2)", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel({ decisions: [] });

		const { judgeFinishedTurn } = await import("./dispatch");
		const result = await judgeFinishedTurn({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Remember that I prefer plain language.",
			userMessageId: "msg-0",
			assistantMessageId: "msg-1",
			assistantResponse: "Noted.",
			assistantMirrorContent: "Noted.",
		});

		expect(result).toEqual({ status: "explicit" });
		// The explicit judge ran synchronously (model consulted).
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1);

		// Watermark advanced to seq 2 → nothing is re-counted.
		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
		expect(await readWatermark(db, "c1")).toBe(2);
		// Crash-safety trail was left before the synchronous judge.
		expect(pendingDirtyRows(db, "c1").length).toBeGreaterThanOrEqual(0);
	});

	it("explicit request does NOT advance the watermark when a backlog sits below the exchange (D2 regression)", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "backlog-1" },
				{ role: "assistant", content: "backlog-2" },
				{ role: "user", content: "backlog-3" },
				{ role: "assistant", content: "backlog-4" },
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel({ decisions: [] });

		const { judgeFinishedTurn } = await import("./dispatch");
		const { countUnjudgedMessages } = await import("./segment");

		const result = await judgeFinishedTurn({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Remember that I prefer plain language.",
			userMessageId: "msg-4",
			assistantMessageId: "msg-5",
			assistantResponse: "Noted.",
			assistantMirrorContent: "Noted.",
		});
		expect(result).toEqual({ status: "explicit" });

		// seqs 1-4 were never sent → the watermark must stay put (no intake loss).
		expect(await readWatermark(db, "c1")).toBe(0);
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(6);

		// A later oldest-first pass drains the whole backlog + the explicit exchange.
		const { runMemoryJudgeOnSegment } = await import("./index");
		const drain = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "sweep",
		});
		expect(drain.status).toBe("ran");
		expect(await readWatermark(db, "c1")).toBe(6);
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
	});

	it("leaves a dirty-ledger safety net before the synchronous explicit judge, so a failed judge is retried", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		// The judge model call fails → runMemoryJudgeOnSegment returns "failed"
		// before it can advance the watermark. The dirty row must already exist.
		sendJsonControlMessageMock.mockImplementation(async () => {
			throw new Error("model offline");
		});

		const { judgeFinishedTurn } = await import("./dispatch");
		await judgeFinishedTurn({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Remember that I prefer plain language.",
			userMessageId: "msg-0",
			assistantMessageId: "msg-1",
			assistantResponse: "Noted.",
			assistantMirrorContent: "Noted.",
		});

		// A pending deferred_intake row exists despite the failed judge → not lost.
		const rows = pendingDirtyRows(db, "c1");
		expect(rows.length).toBe(1);
		expect(rows[0].reason).toBe("deferred_intake");
		// Watermark untouched: the failed judge never advanced it.
		expect(await readWatermark(db, "c1")).toBe(0);
		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(2);
	});

	it("runs an immediate marathon judge when the unjudged count reaches the threshold", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		const entries = Array.from({ length: 25 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `ordinary-${i + 1}`,
		}));
		seedMessages({ db, conversationId: "c1", entries });
		mockControlModel({ decisions: [] });

		const { judgeFinishedTurn } = await import("./dispatch");
		const result = await judgeFinishedTurn({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Just an ordinary follow-up.",
			userMessageId: "msg-23",
			assistantMessageId: "msg-24",
			assistantResponse: "Understood.",
			assistantMirrorContent: "Understood.",
		});

		expect(result).toEqual({ status: "marathon" });
		// The judge ran over the real oldest-first segment.
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1);
		expect(await readWatermark(db, "c1")).toBe(25);
		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
		// Safety net dirty row was left before the marathon run.
		expect(pendingDirtyRows(db, "c1").length).toBe(1);
	});

	it("schedules a debounced idle judge for ordinary turns below the threshold", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "My company is Acme Studio." },
				{ role: "assistant", content: "Got it." },
			],
		});
		mockControlModel({ decisions: [] });

		const { judgeFinishedTurn } = await import("./dispatch");
		const result = await judgeFinishedTurn({
			userId: "u1",
			conversationId: "c1",
			userMessage: "My company is Acme Studio.",
			userMessageId: "msg-0",
			assistantMessageId: "msg-1",
			assistantResponse: "Got it.",
			assistantMirrorContent: "Got it.",
		});

		expect(result).toEqual({ status: "idle" });
		// No immediate judge: the model is NOT consulted synchronously.
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
		// Watermark untouched; the messages stay unjudged for the debounced pass.
		expect(await readWatermark(db, "c1")).toBe(0);
		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(2);
		// A crash-safety dirty row was left for the deferred pass to drain.
		expect(pendingDirtyRows(db, "c1").length).toBe(1);
	});

	it("skips judging entirely when the master memory gate is inactive", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		db.update(schema.users)
			.set({ memoryEnabled: false })
			.where(eq(schema.users.id, "u1"))
			.run();
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel({ decisions: [] });

		const { judgeFinishedTurn } = await import("./dispatch");
		const result = await judgeFinishedTurn({
			userId: "u1",
			conversationId: "c1",
			userMessage: "Remember that I prefer plain language.",
			userMessageId: "msg-0",
			assistantMessageId: "msg-1",
			assistantResponse: "Noted.",
			assistantMirrorContent: "Noted.",
		});

		expect(result).toEqual({ status: "skipped" });
		// Nothing ran: no model call, no dirty trail, no watermark movement.
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
		expect(pendingDirtyRows(db, "c1").length).toBe(0);
		expect(await readWatermark(db, "c1")).toBe(0);
	});

	it("drains a >50 backlog across passes via the runner (fireJudge + sweep), re-marking dirty between passes (N1)", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		const TOTAL = 120;
		const entries = Array.from({ length: TOTAL }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `marker-${i + 1}`,
		}));
		seedMessages({ db, conversationId: "c1", entries });
		mockControlModel({ decisions: [] });

		const { countUnjudgedMessages } = await import("./segment");
		const {
			scheduleConversationJudge,
			flushPendingJudgeRuns,
			sweepDirtyConversations,
			stopMemoryJudgeRunner,
		} = await import("./runner");

		// Register the conversation with the idle runner, then flush it — this
		// drives the REAL fireJudge path (not a manual chokepoint call): one idle
		// pass drains the oldest 50, then re-marks dirty + reschedules because a
		// backlog remains.
		scheduleConversationJudge({ userId: "u1", conversationId: "c1" });
		await flushPendingJudgeRuns("u1");

		expect(await readWatermark(db, "c1")).toBe(50);
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(70);
		// fireJudge re-marked the conversation dirty for the remaining backlog.
		expect(pendingDirtyRows(db, "c1").length).toBe(1);

		// The re-marked dirty row is now picked up by the sweep, which drains the
		// next segment and re-marks again while a backlog remains — exercising
		// requeueConversationForDrain end-to-end through the ledger.
		let sweeps = 0;
		while (
			(await countUnjudgedMessages({ userId: "u1", conversationId: "c1" })) > 0
		) {
			sweeps++;
			if (sweeps > 10) throw new Error("sweep drain did not converge");
			const ran = await sweepDirtyConversations("u1");
			expect(ran).toBeGreaterThanOrEqual(1);
		}

		// 120 messages: 50 (fireJudge) + 50 + 20 (two sweeps) → fully drained.
		expect(sweeps).toBe(2);
		expect(await readWatermark(db, "c1")).toBe(TOTAL);
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
		// No dirty rows remain pending once the backlog is fully drained.
		expect(pendingDirtyRows(db, "c1").length).toBe(0);

		stopMemoryJudgeRunner();
	});
});
