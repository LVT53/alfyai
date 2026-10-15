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
