import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

async function seedFixtures() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-03T19:30:00.000Z");
	db.insert(schema.users)
		.values({ id: "user-1", email: "user@example.com", passwordHash: "hash" })
		.run();
	db.insert(schema.users)
		.values({
			id: "user-2",
			email: "other@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Report conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Here is the report.",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

/**
 * Inserts a file-production job row in a given status for a given owner.
 * Returns the persisted job id.
 */
async function seedJob(
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled",
	ownerId: string,
	jobId: string,
): Promise<void> {
	const { db } = await import("$lib/server/db");
	const now = new Date("2026-05-03T19:31:00.000Z");
	await db.insert(schema.fileProductionJobs).values({
		id: jobId,
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		userId: ownerId,
		title: `Job ${jobId}`,
		status,
		stage: null,
		origin: "unified_produce",
		createdAt: now,
		updatedAt: now,
	});
}

describe("dismissFileProductionJob", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-file-production-dismiss-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedFixtures();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("dismisses a failed job and returns it with dismissed: true", async () => {
		await seedJob("failed", "user-1", "job-failed");
		const { dismissFileProductionJob } = await import("./index");

		const job = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-failed",
			now: new Date("2026-05-03T19:40:00.000Z"),
		});

		expect(job).toMatchObject({ id: "job-failed", dismissed: true });
		const { db } = await import("$lib/server/db");
		const [row] = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.id, "job-failed"));
		expect(row.dismissed).toBe(true);
	});

	it("dismisses a cancelled job and returns it with dismissed: true", async () => {
		await seedJob("cancelled", "user-1", "job-cancelled");
		const { dismissFileProductionJob } = await import("./index");

		const job = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-cancelled",
			now: new Date("2026-05-03T19:40:00.000Z"),
		});

		expect(job).toMatchObject({ id: "job-cancelled", dismissed: true });
	});

	it("does not dismiss a queued job and returns null (no-op)", async () => {
		await seedJob("queued", "user-1", "job-queued");
		const { dismissFileProductionJob } = await import("./index");

		const job = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-queued",
		});

		expect(job).toBeNull();
		const { db } = await import("$lib/server/db");
		const [row] = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.id, "job-queued"));
		expect(row.dismissed).toBe(false);
	});

	it("does not dismiss a running job and returns null (no-op)", async () => {
		await seedJob("running", "user-1", "job-running");
		const { dismissFileProductionJob } = await import("./index");

		const job = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-running",
		});

		expect(job).toBeNull();
	});

	it("does not dismiss a succeeded job and returns null (no-op)", async () => {
		await seedJob("succeeded", "user-1", "job-succeeded");
		const { dismissFileProductionJob } = await import("./index");

		const job = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-succeeded",
		});

		expect(job).toBeNull();
	});

	it("returns null when the job does not exist", async () => {
		const { dismissFileProductionJob } = await import("./index");

		const job = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-missing",
		});

		expect(job).toBeNull();
	});

	it("returns null when the job belongs to a different user (userId guard)", async () => {
		await seedJob("failed", "user-2", "job-owned-by-other");
		const { dismissFileProductionJob } = await import("./index");

		const job = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-owned-by-other",
		});

		expect(job).toBeNull();
		const { db } = await import("$lib/server/db");
		const [row] = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.id, "job-owned-by-other"));
		expect(row.dismissed).toBe(false);
	});

	it("is idempotent: dismissing an already-dismissed job returns it still dismissed", async () => {
		await seedJob("failed", "user-1", "job-dismissed-twice");
		const { dismissFileProductionJob } = await import("./index");

		const first = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-dismissed-twice",
		});
		const second = await dismissFileProductionJob({
			userId: "user-1",
			jobId: "job-dismissed-twice",
		});

		expect(first).toMatchObject({ dismissed: true });
		expect(second).toMatchObject({ dismissed: true });
	});
});

describe("listConversationFileProductionJobs dismissed filter", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-file-production-dismiss-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedFixtures();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("excludes a dismissed failed job by default", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-05-03T19:31:00.000Z");
		await db.insert(schema.fileProductionJobs).values({
			id: "job-dismissed-failed",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			userId: "user-1",
			title: "Dismissed failed report",
			status: "failed",
			stage: null,
			origin: "unified_produce",
			dismissed: true,
			createdAt: now,
			updatedAt: now,
		});
		const { listConversationFileProductionJobs } = await import("./index");

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");

		expect(
			jobs.find((job) => job.id === "job-dismissed-failed"),
		).toBeUndefined();
	});

	it("includes a dismissed failed job when includeDismissed is true", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-05-03T19:31:00.000Z");
		await db.insert(schema.fileProductionJobs).values({
			id: "job-dismissed-failed",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			userId: "user-1",
			title: "Dismissed failed report",
			status: "failed",
			stage: null,
			origin: "unified_produce",
			dismissed: true,
			createdAt: now,
			updatedAt: now,
		});
		const { listConversationFileProductionJobs } = await import("./index");

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1", {
			includeDismissed: true,
		});

		expect(jobs.find((job) => job.id === "job-dismissed-failed")).toMatchObject(
			{ dismissed: true },
		);
	});
});
