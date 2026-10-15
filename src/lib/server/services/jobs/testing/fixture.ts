// A migrated, seeded SQLite file for the engine's tests, with the test kind's
// two tables added by hand-written DDL.
//
// Like `extraction/testing/ledger-fixtures.ts`, it talks to better-sqlite3
// directly and not to `$lib/server/db`: the engine captures that singleton at
// import time, so a test creates and seeds the file FIRST, sets
// `process.env.DATABASE_PATH` to `dbPath`, calls `vi.resetModules()` and only
// then imports the engine. The fixture's connection stays open beside the
// engine's own; two connections to one SQLite file are what production's busy
// timeout is there for, and a second connection is exactly what a test needs
// to play "another process".

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "$lib/server/db/schema";
import { testJobAttempts, testJobs } from "./test-kind";

export type TestJobRow = typeof testJobs.$inferSelect;
export type TestAttemptRow = typeof testJobAttempts.$inferSelect;

export type SeedJobInput = Omit<typeof testJobs.$inferInsert, "id"> & {
	id?: string;
};

export type SeedAttemptInput = Omit<
	typeof testJobAttempts.$inferInsert,
	"id"
> & {
	id?: string;
};

export interface SeedRunningJobInput {
	userId: string;
	/** Any string. The engine's own ids are `test:<host>:<pid>:<nonce>`. */
	workerId: string;
	/** How old the attempt's last beat is. Default 0: it just beat. */
	heartbeatAgeMs?: number;
	/** How old the job row was last touched. Default 0. */
	updatedAgeMs?: number;
	attemptNumber?: number;
	label?: string | null;
	priority?: number;
}

export interface JobsFixture {
	dbPath: string;
	sqlite: InstanceType<typeof Database>;
	seedUser(id: string): string;
	/** Inserts a job; returns its id. Defaults: queued, created now. */
	seedJob(input: SeedJobInput): string;
	/** Inserts an attempt; returns its id. Defaults: running, claimed and beating now. */
	seedAttempt(input: SeedAttemptInput): string;
	/** A `running` job and its `running` attempt, as a claim leaves them. */
	seedRunningJob(input: SeedRunningJobInput): {
		jobId: string;
		attemptId: string;
	};
	readJob(id: string): TestJobRow | null;
	/** Oldest attempt first. */
	readAttempts(jobId: string): TestAttemptRow[];
	close(): void;
	cleanup(): void;
}

/**
 * The test kind's DDL. Written by hand, in the shape `drizzle-kit` renders, so
 * it reads like the migrations a real kind gets. `columns.test.ts` compares
 * every column and index against the Drizzle declarations in `test-kind.ts`.
 */
export const TEST_KIND_DDL = [
	`CREATE TABLE \`test_jobs\` (
		\`id\` text PRIMARY KEY NOT NULL,
		\`user_id\` text NOT NULL,
		\`status\` text DEFAULT 'queued' NOT NULL,
		\`phase\` text,
		\`priority\` integer DEFAULT 0 NOT NULL,
		\`run_after\` integer,
		\`attempt_count\` integer DEFAULT 0 NOT NULL,
		\`current_attempt_id\` text,
		\`retryable\` integer DEFAULT 0 NOT NULL,
		\`error_code\` text,
		\`error_message\` text,
		\`checkpoint_json\` text,
		\`retry_state_json\` text,
		\`cancel_requested_at\` integer,
		\`started_at\` integer,
		\`completed_at\` integer,
		\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
		\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL,
		\`label\` text,
		\`idem_key\` text,
		FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
	)`,
	`CREATE INDEX \`test_jobs_live_claim_idx\` ON \`test_jobs\` (\`status\`,\`priority\`,\`created_at\`) WHERE "test_jobs"."status" = 'queued' or "test_jobs"."status" = 'running'`,
	"CREATE UNIQUE INDEX `test_jobs_user_idem_idx` ON `test_jobs` (`user_id`,`idem_key`)",
	`CREATE TABLE \`test_job_attempts\` (
		\`id\` text PRIMARY KEY NOT NULL,
		\`job_id\` text NOT NULL,
		\`attempt_number\` integer NOT NULL,
		\`status\` text DEFAULT 'running' NOT NULL,
		\`phase\` text,
		\`worker_id\` text,
		\`claimed_at\` integer,
		\`heartbeat_at\` integer,
		\`started_at\` integer,
		\`finished_at\` integer,
		\`error_code\` text,
		\`error_message\` text,
		\`retryable\` integer DEFAULT 0 NOT NULL,
		\`diagnostics_json\` text,
		\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
		\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL,
		\`note\` text,
		FOREIGN KEY (\`job_id\`) REFERENCES \`test_jobs\`(\`id\`) ON UPDATE no action ON DELETE cascade
	)`,
	"CREATE UNIQUE INDEX `test_job_attempts_job_number_unique_idx` ON `test_job_attempts` (`job_id`,`attempt_number`)",
	"CREATE INDEX `test_job_attempts_job_idx` ON `test_job_attempts` (`job_id`,`created_at`)",
	"CREATE INDEX `test_job_attempts_worker_idx` ON `test_job_attempts` (`worker_id`,`status`,`heartbeat_at`)",
];

export function createJobsFixture(prefix = "jobs"): JobsFixture {
	const dbPath = join(tmpdir(), `alfyai-${prefix}-${randomUUID()}.db`);
	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	for (const statement of TEST_KIND_DDL) sqlite.exec(statement);

	function seedJob(input: SeedJobInput): string {
		const id = input.id ?? randomUUID();
		const now = new Date();
		db.insert(testJobs)
			.values({ createdAt: now, updatedAt: now, ...input, id })
			.run();
		return id;
	}

	function seedAttempt(input: SeedAttemptInput): string {
		const id = input.id ?? randomUUID();
		const now = new Date();
		db.insert(testJobAttempts)
			.values({
				status: "running",
				workerId: "seed-worker",
				claimedAt: now,
				heartbeatAt: now,
				startedAt: now,
				createdAt: now,
				updatedAt: now,
				...input,
				id,
			})
			.run();
		return id;
	}

	return {
		dbPath,
		sqlite,
		seedUser(id: string): string {
			db.insert(schema.users)
				.values({ id, email: `${id}@example.com`, passwordHash: "hash" })
				.run();
			return id;
		},
		seedJob,
		seedAttempt,
		seedRunningJob(input: SeedRunningJobInput) {
			const now = Date.now();
			const attemptNumber = input.attemptNumber ?? 1;
			const attemptId = randomUUID();
			const touchedAt = new Date(now - (input.updatedAgeMs ?? 0));
			const jobId = seedJob({
				userId: input.userId,
				status: "running",
				attemptCount: attemptNumber,
				currentAttemptId: attemptId,
				startedAt: touchedAt,
				updatedAt: touchedAt,
				label: input.label ?? null,
				priority: input.priority ?? 0,
			});
			seedAttempt({
				id: attemptId,
				jobId,
				attemptNumber,
				workerId: input.workerId,
				heartbeatAt: new Date(now - (input.heartbeatAgeMs ?? 0)),
			});
			return { jobId, attemptId };
		},
		readJob(id: string): TestJobRow | null {
			return (
				db.select().from(testJobs).where(eq(testJobs.id, id)).limit(1).get() ??
				null
			);
		},
		readAttempts(jobId: string): TestAttemptRow[] {
			return db
				.select()
				.from(testJobAttempts)
				.where(eq(testJobAttempts.jobId, jobId))
				.orderBy(asc(testJobAttempts.attemptNumber))
				.all();
		},
		close(): void {
			sqlite.close();
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
