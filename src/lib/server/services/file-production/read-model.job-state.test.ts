// Covers the two read-model entrypoints added so that a turn can find out what
// the file-production ledger CURRENTLY says: the single-job lookup produce_file
// polls in-turn, and the status-only projection the next turn's prompt context
// uses to stop repeating a promise the ledger has already contradicted.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

const NOW = new Date("2026-05-03T19:30:00.000Z");

async function seedFixtures() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values({ id: "user-1", email: "user@example.com", passwordHash: "hash" })
		.run();
	db.insert(schema.users)
		.values({ id: "user-2", email: "other@example.com", passwordHash: "hash" })
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Report conversation",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Here is the report.",
			createdAt: NOW,
		})
		.run();

	sqlite.close();
}

async function seedJob(input: {
	id: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	userId?: string;
	title?: string;
	errorCode?: string;
	errorMessage?: string;
	retryable?: boolean;
	dismissed?: boolean;
	createdAt?: Date;
}) {
	const { db } = await import("$lib/server/db");
	await db.insert(schema.fileProductionJobs).values({
		id: input.id,
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		userId: input.userId ?? "user-1",
		title: input.title ?? `Job ${input.id}`,
		status: input.status,
		stage: null,
		origin: "unified_produce",
		errorCode: input.errorCode ?? null,
		errorMessage: input.errorMessage ?? null,
		retryable: input.retryable ?? false,
		dismissed: input.dismissed ?? false,
		createdAt: input.createdAt ?? NOW,
		updatedAt: input.createdAt ?? NOW,
	});
}

async function seedGeneratedFile(input: {
	id: string;
	jobId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}) {
	const { db } = await import("$lib/server/db");
	await db.insert(schema.chatGeneratedFiles).values({
		id: input.id,
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		userId: "user-1",
		filename: input.filename,
		mimeType: input.mimeType,
		sizeBytes: input.sizeBytes,
		storagePath: `/tmp/${input.id}`,
		createdAt: NOW,
	});
	await db.insert(schema.fileProductionJobFiles).values({
		id: `${input.jobId}:${input.id}`,
		jobId: input.jobId,
		chatGeneratedFileId: input.id,
		sortOrder: 0,
		createdAt: NOW,
	});
}

describe("file-production read model job state", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-file-production-job-state-${randomUUID()}.db`;
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

	describe("getConversationFileProductionJob", () => {
		it("returns a succeeded job with its linked files", async () => {
			await seedJob({ id: "job-ok", status: "succeeded", title: "Budget" });
			await seedGeneratedFile({
				id: "file-ok",
				jobId: "job-ok",
				filename: "budget.xlsx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				sizeBytes: 4_096,
			});
			const { getConversationFileProductionJob } = await import("./read-model");

			const job = await getConversationFileProductionJob({
				userId: "user-1",
				conversationId: "conv-1",
				jobId: "job-ok",
			});

			expect(job).toMatchObject({ id: "job-ok", status: "succeeded" });
			expect(job?.files).toEqual([
				expect.objectContaining({
					filename: "budget.xlsx",
					sizeBytes: 4_096,
				}),
			]);
		});

		it("returns a failed job with its error and no files", async () => {
			await seedJob({
				id: "job-bad",
				status: "failed",
				errorCode: "program_execution_failed",
				errorMessage: "NameError: name 'wb' is not defined",
				retryable: true,
			});
			const { getConversationFileProductionJob } = await import("./read-model");

			const job = await getConversationFileProductionJob({
				userId: "user-1",
				conversationId: "conv-1",
				jobId: "job-bad",
			});

			expect(job).toMatchObject({
				status: "failed",
				files: [],
				error: {
					code: "program_execution_failed",
					message: "NameError: name 'wb' is not defined",
					retryable: true,
				},
			});
		});

		it("does not return another user's job", async () => {
			await seedJob({ id: "job-theirs", status: "failed", userId: "user-2" });
			const { getConversationFileProductionJob } = await import("./read-model");

			await expect(
				getConversationFileProductionJob({
					userId: "user-1",
					conversationId: "conv-1",
					jobId: "job-theirs",
				}),
			).resolves.toBeNull();
		});
	});

	describe("listConversationFileProductionJobStates", () => {
		it("lists only the jobs with nothing to deliver, newest first", async () => {
			await seedJob({
				id: "job-done",
				status: "succeeded",
				createdAt: new Date("2026-05-03T19:31:00.000Z"),
			});
			await seedJob({
				id: "job-running",
				status: "running",
				title: "Slow deck",
				createdAt: new Date("2026-05-03T19:32:00.000Z"),
			});
			await seedJob({
				id: "job-failed",
				status: "failed",
				title: "Broken sheet",
				errorCode: "program_execution_failed",
				errorMessage: "SyntaxError: invalid syntax",
				createdAt: new Date("2026-05-03T19:33:00.000Z"),
			});
			await seedJob({
				id: "job-dismissed",
				status: "failed",
				dismissed: true,
				createdAt: new Date("2026-05-03T19:34:00.000Z"),
			});
			await seedJob({
				id: "job-cancelled",
				status: "cancelled",
				createdAt: new Date("2026-05-03T19:35:00.000Z"),
			});
			await seedJob({
				id: "job-other-user",
				status: "failed",
				userId: "user-2",
				createdAt: new Date("2026-05-03T19:36:00.000Z"),
			});
			const { listConversationFileProductionJobStates } = await import(
				"./read-model"
			);

			const states = await listConversationFileProductionJobStates({
				userId: "user-1",
				conversationId: "conv-1",
			});

			expect(states.map((state) => state.id)).toEqual([
				"job-failed",
				"job-running",
			]);
			expect(states[0]).toMatchObject({
				title: "Broken sheet",
				status: "failed",
				errorCode: "program_execution_failed",
				errorMessage: "SyntaxError: invalid syntax",
			});
		});

		it("honours the limit", async () => {
			for (let index = 0; index < 4; index++) {
				await seedJob({
					id: `job-${index}`,
					status: "failed",
					createdAt: new Date(NOW.getTime() + index * 1_000),
				});
			}
			const { listConversationFileProductionJobStates } = await import(
				"./read-model"
			);

			const states = await listConversationFileProductionJobStates({
				userId: "user-1",
				conversationId: "conv-1",
				limit: 2,
			});

			expect(states.map((state) => state.id)).toEqual(["job-3", "job-2"]);
		});
	});
});
