// A migrated, seeded SQLite file for file-production worker tests.
//
// It talks to better-sqlite3 directly rather than to `$lib/server/db`, because
// the modules under test capture that singleton at import time: a test has to
// create and seed the file BEFORE it imports the ledger or the worker, and a
// helper that went through the singleton would open the previous test's
// database.
//
// The design is the one the extraction worker's fixture uses, deliberately
// re-implemented rather than imported: ADR-0005 keeps file-production and
// extraction as separate boundaries, and `obsolete-surfaces.test.ts` exists to
// stop one reaching into the other — test helpers included.

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "$lib/server/db/schema";

export interface SeededFileProductionJobInput {
	id?: string;
	userId: string;
	conversationId: string;
	assistantMessageId?: string | null;
	title?: string;
	status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	requestJson?: unknown;
	sourceMode?: string;
	createdAt?: Date;
}

export interface SeededRunningAttemptInput {
	jobId: string;
	workerId?: string;
	/** How old the attempt's last heartbeat is, in ms, relative to `now`. */
	heartbeatAgeMs: number;
	now?: Date;
}

export interface FileProductionLedgerFixture {
	dbPath: string;
	sqlite: InstanceType<typeof Database>;
	db: ReturnType<typeof drizzle<typeof schema>>;
	seedUser(id: string): string;
	seedConversation(id: string, userId: string): string;
	seedAssistantMessage(id: string, conversationId: string): string;
	seedJob(input: SeededFileProductionJobInput): string;
	/** Leaves a job `running` behind an attempt whose worker is gone. */
	seedOrphanedRunningJob(input: SeededRunningAttemptInput): string;
	jobStatus(jobId: string): string | undefined;
	jobErrorCode(jobId: string): string | null | undefined;
	attemptHeartbeatAgeMs(jobId: string, now?: Date): number | null;
	cleanup(): void;
}

/**
 * Creates a fresh migrated database file. The caller is responsible for setting
 * `process.env.DATABASE_PATH` to `dbPath` and calling `vi.resetModules()`
 * before importing anything under `$lib/server`.
 */
export function createFileProductionLedgerFixture(
	prefix = "file-production",
): FileProductionLedgerFixture {
	const dbPath = `/tmp/alfyai-${prefix}-${randomUUID()}.db`;
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const epoch = new Date("2026-09-20T09:00:00.000Z");

	return {
		dbPath,
		sqlite,
		db,
		seedUser(id: string): string {
			db.insert(schema.users)
				.values({ id, email: `${id}@example.com`, passwordHash: "hash" })
				.run();
			return id;
		},
		seedConversation(id: string, userId: string): string {
			db.insert(schema.conversations)
				.values({
					id,
					userId,
					title: `Conversation ${id}`,
					createdAt: epoch,
					updatedAt: epoch,
				})
				.run();
			return id;
		},
		seedAssistantMessage(id: string, conversationId: string): string {
			db.insert(schema.messages)
				.values({
					id,
					conversationId,
					role: "assistant",
					content: "Here is the file.",
					createdAt: epoch,
				})
				.run();
			return id;
		},
		seedJob(input: SeededFileProductionJobInput): string {
			const id = input.id ?? randomUUID();
			const createdAt = input.createdAt ?? epoch;
			db.insert(schema.fileProductionJobs)
				.values({
					id,
					conversationId: input.conversationId,
					assistantMessageId: input.assistantMessageId ?? null,
					userId: input.userId,
					title: input.title ?? "Quarterly report",
					status: input.status ?? "queued",
					stage: null,
					origin: "unified_produce",
					currentAttemptId: null,
					retryable: false,
					errorCode: null,
					errorMessage: null,
					completedAt: null,
					cancelRequestedAt: null,
					idempotencyKey: null,
					requestJson:
						input.requestJson === undefined
							? JSON.stringify({
									sourceMode: "program",
									program: {
										language: "python",
										sourceCode: "print('hi')",
										filename: "out.txt",
									},
									outputs: [{ type: "txt" }],
								})
							: JSON.stringify(input.requestJson),
					sourceMode: input.sourceMode ?? "program",
					documentIntent: null,
					createdAt,
					updatedAt: createdAt,
				})
				.run();
			return id;
		},
		seedOrphanedRunningJob(input: SeededRunningAttemptInput): string {
			const now = input.now ?? new Date();
			const heartbeatAt = new Date(now.getTime() - input.heartbeatAgeMs);
			const attemptId = randomUUID();
			db.insert(schema.fileProductionJobAttempts)
				.values({
					id: attemptId,
					jobId: input.jobId,
					attemptNumber: 1,
					status: "running",
					stage: null,
					workerId: input.workerId ?? "worker-that-died",
					claimedAt: heartbeatAt,
					heartbeatAt,
					startedAt: heartbeatAt,
					finishedAt: null,
					errorCode: null,
					errorMessage: null,
					retryable: false,
					createdAt: heartbeatAt,
					updatedAt: heartbeatAt,
				})
				.run();
			sqlite
				.prepare(
					"UPDATE file_production_jobs SET status = 'running', current_attempt_id = ? WHERE id = ?",
				)
				.run(attemptId, input.jobId);
			return attemptId;
		},
		jobStatus(jobId: string): string | undefined {
			return (
				sqlite
					.prepare("SELECT status FROM file_production_jobs WHERE id = ?")
					.get(jobId) as { status: string } | undefined
			)?.status;
		},
		jobErrorCode(jobId: string): string | null | undefined {
			return (
				sqlite
					.prepare("SELECT error_code FROM file_production_jobs WHERE id = ?")
					.get(jobId) as { error_code: string | null } | undefined
			)?.error_code;
		},
		attemptHeartbeatAgeMs(jobId: string, now = new Date()): number | null {
			const row = sqlite
				.prepare(
					"SELECT heartbeat_at FROM file_production_job_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1",
				)
				.get(jobId) as { heartbeat_at: number | null } | undefined;
			if (!row?.heartbeat_at) return null;
			// `heartbeat_at` is a drizzle `timestamp` column: unix SECONDS.
			return now.getTime() - row.heartbeat_at * 1000;
		},
		cleanup(): void {
			try {
				sqlite.close();
			} catch {
				// Already closed by the test; nothing to do.
			}
			for (const suffix of ["", "-wal", "-shm"]) {
				const path = `${dbPath}${suffix}`;
				if (existsSync(path)) unlinkSync(path);
			}
		},
	};
}
