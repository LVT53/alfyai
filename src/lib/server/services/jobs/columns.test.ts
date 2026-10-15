// The lifecycle shape every kind's tables share, and the hand-written DDL the
// engine's own tests build their test kind on. If a builder gains a column and
// the test kind's DDL does not, this file is where it shows.

import { getTableName } from "drizzle-orm";
import { getTableConfig, sqliteTable } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	JOB_ATTEMPT_PROPERTIES,
	JOB_LIFECYCLE_PROPERTIES,
	jobAttemptColumns,
	jobColumns,
} from "./columns";
import { createJobsFixture, type JobsFixture } from "./testing/fixture";
import { testJobAttempts, testJobs } from "./testing/test-kind";
import type { JobAttemptTable, JobTable } from "./types";

let fixture: JobsFixture | null = null;

afterEach(() => {
	fixture?.cleanup();
	fixture = null;
});

describe("jobColumns", () => {
	it("gives every lifecycle property", () => {
		expect(Object.keys(jobColumns()).sort()).toEqual(
			[...JOB_LIFECYCLE_PROPERTIES].sort(),
		);
		expect(JOB_LIFECYCLE_PROPERTIES).toHaveLength(18);
	});

	it("names its columns the way the design's table says", () => {
		const table = sqliteTable("shape_probe", jobColumns());
		expect(
			getTableConfig(table)
				.columns.map((column) => column.name)
				.sort(),
		).toEqual(
			[
				"id",
				"user_id",
				"status",
				"phase",
				"priority",
				"run_after",
				"attempt_count",
				"current_attempt_id",
				"retryable",
				"error_code",
				"error_message",
				"checkpoint_json",
				"retry_state_json",
				"cancel_requested_at",
				"started_at",
				"completed_at",
				"created_at",
				"updated_at",
			].sort(),
		);
	});

	it("keeps a legacy SQL name", () => {
		const table = sqliteTable(
			"legacy_probe",
			jobColumns({
				sqlNames: {
					retryable: "error_retryable",
					runAfter: "next_attempt_at",
					checkpoint: "remote_handle_json",
					phase: "stage",
				},
			}),
		);
		const names = getTableConfig(table).columns.map((column) => column.name);
		expect(names).toContain("error_retryable");
		expect(names).toContain("next_attempt_at");
		expect(names).toContain("remote_handle_json");
		expect(names).toContain("stage");
		expect(names).not.toContain("retryable");
		expect(names).not.toContain("run_after");
		expect(names).not.toContain("checkpoint_json");
		expect(names).not.toContain("phase");
		// The property names do not move: the engine reads `table.retryable`.
		expect(Object.keys(table)).toContain("retryable");
	});

	it("defaults the status to queued, or to what a legacy table says", () => {
		const statusDefault = (options?: Parameters<typeof jobColumns>[0]) =>
			getTableConfig(
				sqliteTable("status_probe", jobColumns(options)),
			).columns.find((column) => column.name === "status")?.default;

		expect(statusDefault()).toBe("queued");
		expect(statusDefault({ statusDefault: "succeeded" })).toBe("succeeded");
	});

	it("declares the user foreign key only when it is handed the column", () => {
		const foreignKeys = (options?: Parameters<typeof jobColumns>[0]) =>
			getTableConfig(sqliteTable("fk_probe", jobColumns(options))).foreignKeys;

		expect(foreignKeys()).toHaveLength(0);
		const [foreignKey] = getTableConfig(testJobs).foreignKeys;
		expect(getTableConfig(testJobs).foreignKeys).toHaveLength(1);
		expect(foreignKey.onDelete).toBe("cascade");
		expect(getTableName(foreignKey.reference().foreignTable)).toBe("users");
	});
});

describe("jobAttemptColumns", () => {
	it("gives every attempt property", () => {
		const table = sqliteTable(
			"attempt_probe",
			jobAttemptColumns({ jobId: () => testJobs.id }),
		);
		expect(
			Object.keys(jobAttemptColumns({ jobId: () => testJobs.id })).sort(),
		).toEqual([...JOB_ATTEMPT_PROPERTIES].sort());
		expect(
			getTableConfig(table)
				.columns.map((column) => column.name)
				.sort(),
		).toEqual(
			[
				"id",
				"job_id",
				"attempt_number",
				"status",
				"phase",
				"worker_id",
				"claimed_at",
				"heartbeat_at",
				"started_at",
				"finished_at",
				"error_code",
				"error_message",
				"retryable",
				"diagnostics_json",
				"created_at",
				"updated_at",
			].sort(),
		);
	});

	it("keeps file production's legacy name for the phase", () => {
		const table = sqliteTable(
			"attempt_legacy_probe",
			jobAttemptColumns({
				jobId: () => testJobs.id,
				sqlNames: { phase: "stage" },
			}),
		);
		const names = getTableConfig(table).columns.map((column) => column.name);
		expect(names).toContain("stage");
		expect(names).not.toContain("phase");
	});

	it("goes with its job: the foreign key cascades", () => {
		const [foreignKey] = getTableConfig(testJobAttempts).foreignKeys;
		expect(getTableConfig(testJobAttempts).foreignKeys).toHaveLength(1);
		expect(foreignKey.onDelete).toBe("cascade");
	});
});

describe("the test kind", () => {
	it("is a table the engine accepts, at the type level", () => {
		// `satisfies` is the assertion: a kind whose table lost a lifecycle column
		// stops compiling here, before any test runs.
		const jobs = testJobs satisfies JobTable;
		const attempts = testJobAttempts satisfies JobAttemptTable;
		expect(jobs).toBeDefined();
		expect(attempts).toBeDefined();
	});

	it("has DDL that matches its Drizzle tables", () => {
		fixture = createJobsFixture("columns");

		for (const table of [testJobs, testJobAttempts]) {
			const config = getTableConfig(table);
			const actual = fixture.sqlite
				.prepare(`PRAGMA table_info(${config.name})`)
				.all() as Array<{ name: string }>;
			expect(actual.map((column) => column.name).sort()).toEqual(
				config.columns.map((column) => column.name).sort(),
			);
		}
	});

	it("has DDL whose indexes match, the live one partial", () => {
		fixture = createJobsFixture("columns-indexes");

		for (const table of [testJobs, testJobAttempts]) {
			const config = getTableConfig(table);
			const actual = fixture.sqlite
				.prepare(`PRAGMA index_list(${config.name})`)
				.all() as Array<{ name: string; unique: number; partial: number }>;
			const byName = new Map(actual.map((index) => [index.name, index]));
			for (const index of config.indexes) {
				const found = byName.get(index.config.name);
				expect(
					found,
					`${config.name} lacks ${index.config.name}`,
				).toBeDefined();
				expect(Boolean(found?.unique)).toBe(Boolean(index.config.unique));
				expect(Boolean(found?.partial)).toBe(index.config.where !== undefined);
			}
		}

		const live = getTableConfig(testJobs).indexes.find(
			(index) => index.config.name === "test_jobs_live_claim_idx",
		);
		expect(live?.config.columns).toHaveLength(3);
		expect(live?.config.where).toBeDefined();
	});

	it("enforces what the engine leans on: one attempt number per job, one key per user", () => {
		fixture = createJobsFixture("columns-constraints");
		const userId = fixture.seedUser("user-1");
		const jobId = fixture.seedJob({ userId, idemKey: "k" });
		fixture.seedAttempt({ jobId, attemptNumber: 1 });

		expect(() => fixture?.seedAttempt({ jobId, attemptNumber: 1 })).toThrow(
			/UNIQUE/,
		);
		expect(() => fixture?.seedJob({ userId, idemKey: "k" })).toThrow(/UNIQUE/);
		// A job with no key never collides with another that has none.
		fixture.seedJob({ userId });
		fixture.seedJob({ userId });
	});
});
