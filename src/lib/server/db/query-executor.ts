import type { DatabaseInstance } from "./index";
import { db as productionDb } from "./index";
import { recordQueryTiming } from "./query-instrumentation";

/**
 * Anything a composed Drizzle query already is: `db.select()...`,
 * `db.insert()...`, `db.update()...`, and `db.delete()...` all implement
 * this (Drizzle's `QueryPromise`). The executor never inspects *what* the
 * query does — only that it can be executed and timed.
 */
export interface ExecutableQuery<T> {
	execute(): Promise<T>;
}

/**
 * The query-execution seam (ADR-0059).
 *
 * Services keep composing their own queries against `schema.ts` with the
 * real Drizzle query builder — `compose` receives a live `DatabaseInstance`
 * and is expected to write exactly the `db.select()/.insert()/.update()/
 * .delete()` chain it would have written before this seam existed. The
 * executor's only job is *how* that already-composed query runs: which
 * database instance backs it, and recording its timing/outcome. It has no
 * knowledge of tables, columns, or query shape, so it is not a per-table
 * repository — see `src/lib/server/db/AGENTS.md`.
 */
export interface QueryExecutor {
	readonly db: DatabaseInstance;
	run<T>(
		label: string,
		compose: (db: DatabaseInstance) => ExecutableQuery<T>,
	): Promise<T>;
}

/**
 * Builds a `QueryExecutor` bound to a given `DatabaseInstance`. Used to
 * construct the production adapter below, and by tests to construct one
 * bound to the in-memory adapter (`./in-memory.ts`) instead — the same
 * `compose` callbacks services write run unchanged against either.
 */
export function createQueryExecutor(database: DatabaseInstance): QueryExecutor {
	return {
		db: database,
		async run<T>(
			label: string,
			compose: (db: DatabaseInstance) => ExecutableQuery<T>,
		): Promise<T> {
			const startedAt = performance.now();
			try {
				const result = await compose(database).execute();
				recordQueryTiming({
					label,
					durationMs: performance.now() - startedAt,
					status: "ok",
				});
				return result;
			} catch (error) {
				recordQueryTiming({
					label,
					durationMs: performance.now() - startedAt,
					status: "error",
				});
				throw error;
			}
		},
	};
}

/**
 * The production adapter: bound to the same `db` singleton every
 * un-migrated call site still imports directly from `./index`. Migrated
 * services default their `executor` parameter to this one, so existing
 * (unmigrated) callers see no behavior change.
 */
export const queryExecutor: QueryExecutor = createQueryExecutor(productionDb);
