// A kind keeps the SQL names its table already has (`error_retryable`,
// `next_attempt_at`, `remote_handle_json`, `stage`), and the engine has to write
// and read THOSE. Drizzle renders them from the column objects, so a query built
// from the columns is right by construction; a query with a column name written
// out in raw SQL is the one way to get it wrong, and the claim and the idle
// tick's snapshot are raw SQL.
//
// This kind renames more than any real one will (the priority, the owner and the
// creation time too), so a name written out anywhere in the engine fails here.

import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "$lib/server/db/schema";
import {
	jobAttemptColumns,
	jobAttemptIndexes,
	jobColumns,
	liveClaimIndex,
} from "./columns";
import { bootEngine, type EngineHarness } from "./testing/harness";
import type { JobKind, JobRunContext } from "./types";

const legacyJobs = sqliteTable(
	"legacy_jobs",
	{
		...jobColumns({
			userId: () => users.id,
			sqlNames: {
				userId: "owner_id",
				phase: "stage",
				priority: "prio",
				runAfter: "next_attempt_at",
				retryable: "error_retryable",
				checkpoint: "remote_handle_json",
				createdAt: "made_at",
			},
		}),
		title: text("title").notNull(),
	},
	(table) => ({
		liveClaimIdx: liveClaimIndex("legacy_jobs_live_claim_idx", table),
	}),
);

const legacyAttempts = sqliteTable(
	"legacy_job_attempts",
	{
		...jobAttemptColumns({
			jobId: () => legacyJobs.id,
			sqlNames: { phase: "stage" },
		}),
		note: text("note"),
	},
	(table) => ({ ...jobAttemptIndexes("legacy_job_attempts", table) }),
);

const DDL = [
	`create table legacy_jobs (
		id text primary key not null,
		owner_id text not null references users(id) on delete cascade,
		status text default 'queued' not null,
		stage text,
		prio integer default 0 not null,
		next_attempt_at integer,
		attempt_count integer default 0 not null,
		current_attempt_id text,
		error_retryable integer default 0 not null,
		error_code text,
		error_message text,
		remote_handle_json text,
		retry_state_json text,
		cancel_requested_at integer,
		started_at integer,
		completed_at integer,
		made_at integer default (unixepoch()) not null,
		updated_at integer default (unixepoch()) not null,
		title text not null
	)`,
	`create index legacy_jobs_live_claim_idx on legacy_jobs (status, prio, made_at) where status = 'queued' or status = 'running'`,
	`create table legacy_job_attempts (
		id text primary key not null,
		job_id text not null references legacy_jobs(id) on delete cascade,
		attempt_number integer not null,
		status text default 'running' not null,
		stage text,
		worker_id text,
		claimed_at integer,
		heartbeat_at integer,
		started_at integer,
		finished_at integer,
		error_code text,
		error_message text,
		retryable integer default 0 not null,
		diagnostics_json text,
		created_at integer default (unixepoch()) not null,
		updated_at integer default (unixepoch()) not null,
		note text
	)`,
	"create unique index legacy_job_attempts_job_number_unique_idx on legacy_job_attempts (job_id, attempt_number)",
	"create index legacy_job_attempts_job_idx on legacy_job_attempts (job_id, created_at)",
	"create index legacy_job_attempts_worker_idx on legacy_job_attempts (worker_id, status, heartbeat_at)",
];

type Ctx = JobRunContext<typeof legacyJobs>;

const START = new Date("2026-03-01T12:00:00.000Z");

let h: EngineHarness;
let kind: JobKind<typeof legacyJobs>;
let handler: (ctx: Ctx) => Promise<void>;
let ran: string[];
let userA: string;
let userB: string;

beforeEach(async () => {
	h = await bootEngine("legacy-names");
	for (const statement of DDL) h.fixture.sqlite.exec(statement);
	userA = h.userId;
	userB = h.fixture.seedUser("user-2");
	ran = [];
	handler = async (ctx) => {
		ran.push(ctx.row.id);
		await ctx.succeed();
	};
	kind = h.engine.defineJobKind({
		name: "legacy",
		logPrefix: "[LEGACY]",
		tables: { jobs: legacyJobs, attempts: legacyAttempts },
		enabled: () => true,
		limits: () => ({ global: 2, perUser: 1 }),
		lease: () => ({ heartbeatMs: 1_000, staleAfterMs: 4_000 }),
		phases: ["uploading", "parsing"],
		lostAttempt: () => ({ code: "stale_worker", message: "It stopped." }),
		onFailure: (failure, history) =>
			history.attempts < 3
				? { requeue: true, delayMs: 5_000 }
				: { requeue: false, retryable: failure.retryable },
		userRetry: { from: ["failed"] },
		handler: async () => (ctx) => handler(ctx),
	});
});

afterEach(() => {
	h.engine.stopJobs();
	vi.useRealTimers();
	vi.restoreAllMocks();
	h.cleanup();
});

/** The row exactly as SQLite holds it, under the names the table really has. */
function raw(
	table: "legacy_jobs" | "legacy_job_attempts",
	where: string,
	id: string,
) {
	return h.fixture.sqlite
		.prepare(`select * from ${table} where ${where} = ?`)
		.get(id) as Record<string, unknown>;
}

function enqueue(
	values: { userId?: string; title?: string } = {},
	extra: { priority?: number; runAfter?: Date } = {},
) {
	return h.engine.enqueue(kind, {
		values: { userId: userA, title: "t", ...values },
		...extra,
	});
}

describe("a kind with its own SQL names", () => {
	it("is written under those names", async () => {
		const runAfter = new Date(Date.now() + 60_000);
		const { row } = await enqueue({}, { priority: 7, runAfter });

		const stored = raw("legacy_jobs", "id", row.id);
		expect(stored).toMatchObject({
			owner_id: userA,
			prio: 7,
			next_attempt_at: Math.floor(runAfter.getTime() / 1000),
			error_retryable: 0,
			remote_handle_json: null,
			stage: null,
			title: "t",
		});
		expect(stored.made_at).toEqual(expect.any(Number));
		expect(stored).not.toHaveProperty("user_id");
		expect(stored).not.toHaveProperty("priority");
		expect(stored).not.toHaveProperty("run_after");
		expect(stored).not.toHaveProperty("created_at");
		// And read back under the engine's property names.
		expect(row).toMatchObject({ userId: userA, priority: 7, retryable: false });
		expect(row.runAfter).toBeInstanceOf(Date);
	});

	it("claims by the renamed priority, owner and age", async () => {
		const late = await enqueue({ userId: userA }, { priority: 5 });
		const urgent = await enqueue({ userId: userB }, { priority: 1 });
		const queuedBehind = await enqueue({ userId: userA }, { priority: 0 });

		await h.engine.drain(kind);

		// One head per owner: A's head is the priority-0 job, B's the only one; the
		// order across owners is priority first. A's other job waits for its turn.
		expect(ran).toEqual([queuedBehind.row.id, urgent.row.id, late.row.id]);
	});

	it("does not claim before the renamed run time", async () => {
		const { row } = await enqueue(
			{},
			{ runAfter: new Date(Date.now() + 3_600_000) },
		);

		await h.engine.drain(kind);
		expect(ran).toEqual([]);

		h.fixture.sqlite
			.prepare("update legacy_jobs set next_attempt_at = ? where id = ?")
			.run(Math.floor(Date.now() / 1000) - 5, row.id);
		await h.engine.drain(kind);
		expect(ran).toEqual([row.id]);
	});

	it("writes the phase, the checkpoint and the failure through the renamed columns", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		handler = async (ctx) => {
			await ctx.progress({ phase: "parsing", checkpoint: { handle: "h-1" } });
			expect(raw("legacy_jobs", "id", ctx.row.id)).toMatchObject({
				stage: "parsing",
				remote_handle_json: '{"handle":"h-1"}',
			});
			expect(raw("legacy_job_attempts", "id", ctx.attempt.id)).toMatchObject({
				stage: "parsing",
			});
			await ctx.fail({ code: "flaky", message: "Flaky.", retryable: true });
		};
		const { row } = await enqueue();
		const before = Date.now();

		await h.engine.drain(kind);

		const stored = raw("legacy_jobs", "id", row.id);
		expect(stored).toMatchObject({
			status: "queued",
			error_code: "flaky",
			error_retryable: 1,
			// A requeue keeps the checkpoint, under its legacy name.
			remote_handle_json: '{"handle":"h-1"}',
		});
		expect(Number(stored.next_attempt_at)).toBeGreaterThanOrEqual(
			Math.floor((before + 4_000) / 1000),
		);
	});

	it("clears the checkpoint and the run time on Cancel, and reopens on Retry", async () => {
		const { row } = await enqueue(
			{},
			{ runAfter: new Date(Date.now() + 60_000) },
		);
		h.fixture.sqlite
			.prepare("update legacy_jobs set remote_handle_json = ? where id = ?")
			.run('{"handle":"h-2"}', row.id);

		await h.engine.cancel(kind, row.id, { userId: userA });

		expect(raw("legacy_jobs", "id", row.id)).toMatchObject({
			status: "cancelled",
			remote_handle_json: null,
			next_attempt_at: null,
			error_retryable: 0,
		});
		expect(raw("legacy_jobs", "id", row.id).cancel_requested_at).not.toBeNull();

		h.fixture.sqlite
			.prepare(
				"update legacy_jobs set status = 'failed', error_retryable = 1 where id = ?",
			)
			.run(row.id);
		const retried = await h.engine.retry(kind, row.id, { userId: userA });
		expect(retried?.status).toBe("queued");
		expect(raw("legacy_jobs", "id", row.id)).toMatchObject({
			status: "queued",
			error_retryable: 0,
			cancel_requested_at: null,
		});
	});

	it("is taken back through the renamed columns", async () => {
		const attemptId = crypto.randomUUID();
		const { row } = await enqueue();
		h.fixture.sqlite
			.prepare(
				"update legacy_jobs set status = 'running', current_attempt_id = ?, attempt_count = 1, updated_at = ? where id = ?",
			)
			.run(attemptId, Math.floor(Date.now() / 1000) - 60, row.id);
		h.fixture.sqlite
			.prepare(
				"insert into legacy_job_attempts (id, job_id, attempt_number, status, worker_id, heartbeat_at) values (?, ?, 1, 'running', 'gone', ?)",
			)
			.run(attemptId, row.id, Math.floor(Date.now() / 1000) - 60);

		const result = h.recovery.takeBack(kind, {
			reason: "stale",
			staleBefore: new Date(Date.now() - 4_000),
		});

		expect(result).toMatchObject({ recovered: 1, requeued: 1 });
		expect(raw("legacy_jobs", "id", row.id)).toMatchObject({
			status: "queued",
			error_code: "stale_worker",
			error_retryable: 1,
		});
		expect(raw("legacy_job_attempts", "id", attemptId)).toMatchObject({
			status: "failed",
			error_code: "stale_worker",
		});
	});

	it("is found by the idle tick and the backoff timer under the renamed run time", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.useFakeTimers();
		vi.setSystemTime(START);
		await h.engine.startJobs([kind], {
			startInNonServingContextForTests: true,
			isProcessAlive: () => false,
		});
		const { row } = await enqueue(
			{},
			{ runAfter: new Date(START.getTime() + 30_000) },
		);
		await vi.advanceTimersByTimeAsync(0);

		// The snapshot reads `next_attempt_at`: it sees work that is not yet due, and
		// arms the one timer for it.
		const inspection = h.engine.inspectJobsForTests().legacy;
		expect(inspection?.backoffArmed).toBe(true);
		expect(inspection?.backoffFiresInMs).toBe(31_000);

		await vi.advanceTimersByTimeAsync(31_100);
		expect(ran).toEqual([row.id]);
		expect(raw("legacy_jobs", "id", row.id).status).toBe("succeeded");
	});

	it("does not hand the same job to a claimer on another connection", async () => {
		const other = await h.bootSecondProcess();
		const { row } = await enqueue();
		const first = h.ledger.claimNext(kind, { workerId: "w1" });
		const second = other.ledger.claimNext(kind, { workerId: "w2" });

		expect(first?.row.id).toBe(row.id);
		expect(second).toBeNull();
	});
});
