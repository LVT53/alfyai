// The engine's own test kind: two tables built with the same column builders a
// real kind uses, so the engine is tested over the shape and not over any one
// domain. They are NOT in `schema.ts` and have no migration; the fixture
// creates them in the test database from hand-written DDL, and
// `columns.test.ts` fails if that DDL and these declarations drift apart.

import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "$lib/server/db/schema";
import {
	jobAttemptColumns,
	jobAttemptIndexes,
	jobColumns,
	liveClaimIndex,
} from "../columns";
import type {
	FailureDecision,
	FailureHistory,
	JobAttemptTable,
	JobFailure,
	JobHandler,
	JobKind,
	JobKindDefinition,
	JobStatus,
	JobTable,
	Row,
	Tx,
} from "../types";

export const testJobs = sqliteTable(
	"test_jobs",
	{
		...jobColumns({ userId: () => users.id }),
		/** A domain column, and the test kind's `claimable` condition. */
		label: text("label"),
		/** The idempotency key: unique per user. */
		idemKey: text("idem_key"),
	},
	(table) => ({
		liveClaimIdx: liveClaimIndex("test_jobs_live_claim_idx", table),
		idemUniqueIdx: uniqueIndex("test_jobs_user_idem_idx").on(
			table.userId,
			table.idemKey,
		),
	}),
);

export const testJobAttempts = sqliteTable(
	"test_job_attempts",
	{
		...jobAttemptColumns({ jobId: () => testJobs.id }),
		/** A column of the kind's own, as extraction's `extractor` is. */
		note: text("note"),
	},
	(table) => ({
		...jobAttemptIndexes("test_job_attempts", table),
	}),
);

// ---------------------------------------------------------------------------
// The test kind's definition
// ---------------------------------------------------------------------------

type TestJobs = typeof testJobs;
type TestAttempts = typeof testJobAttempts;
type TestDefinition = JobKindDefinition<TestJobs, TestAttempts>;

/** What the definition reads live, so a test can change it between calls. */
export interface TestKindConfig {
	enabled: boolean;
	global: number;
	/** undefined = no per-user cap. */
	perUser: number | undefined;
	heartbeatMs: number;
	staleAfterMs: number;
}

/** The handles a test holds on the test kind. */
export interface TestKindControl {
	kind: JobKind<TestJobs>;
	/** The object `defineJobKind` was given. The engine reads it live. */
	definition: TestDefinition;
	config: TestKindConfig;
	/** The job ids the default handler ran, in order. */
	ran: string[];
	/** Every transition the engine announced to `onTransition`, in order. */
	transitions: Array<{ jobId: string; to: JobStatus }>;
	/** What the handler does. null = the default: record the id and succeed. */
	run: JobHandler<TestJobs> | null;
	/** What a failure does to the job. null = settle, keeping the failure's retryable. */
	decide:
		| ((failure: JobFailure, history: FailureHistory) => FailureDecision)
		| null;
	/** Runs inside a transition's transaction; a throw there proves it is that one. */
	transitionHook: ((tx: Tx, row: Row<TestJobs>, to: JobStatus) => void) | null;
}

/**
 * Defines a test kind over `test_jobs` and `test_job_attempts`. `define` is
 * handed in (and not imported) so a test gets the `defineJobKind` of the module
 * instance it imported the engine from, after `vi.resetModules()`.
 */
export function createTestKind(
	define: <J extends JobTable, A extends JobAttemptTable>(
		definition: JobKindDefinition<J, A>,
	) => JobKind<J>,
	overrides: Partial<TestDefinition> = {},
): TestKindControl {
	const config: TestKindConfig = {
		enabled: true,
		global: 2,
		perUser: undefined,
		heartbeatMs: 1_000,
		staleAfterMs: 4_000,
	};

	const control = {
		config,
		ran: [] as string[],
		transitions: [] as Array<{ jobId: string; to: JobStatus }>,
		run: null,
		decide: null,
		transitionHook: null,
	} as unknown as TestKindControl;

	const definition: TestDefinition = {
		name: "test",
		logPrefix: "[TEST]",
		tables: { jobs: testJobs, attempts: testJobAttempts },
		enabled: () => config.enabled,
		limits: () =>
			config.perUser === undefined
				? { global: config.global }
				: { global: config.global, perUser: config.perUser },
		lease: () => ({
			heartbeatMs: config.heartbeatMs,
			staleAfterMs: config.staleAfterMs,
		}),
		lostAttempt: (reason) => ({
			code: `lost_${reason.replace("-", "_")}`,
			message: `The test attempt was lost (${reason}).`,
		}),
		onFailure: (failure, history) =>
			control.decide
				? control.decide(failure, history)
				: { requeue: false, retryable: failure.retryable },
		onTransition: (tx, row, to) => {
			control.transitions.push({ jobId: row.id, to });
			control.transitionHook?.(tx, row, to);
		},
		handler: async () => async (ctx) => {
			if (control.run) {
				await control.run(ctx);
				return;
			}
			control.ran.push(ctx.row.id);
			await ctx.succeed();
		},
		...overrides,
	};

	control.definition = definition;
	control.kind = define(definition);
	return control;
}
