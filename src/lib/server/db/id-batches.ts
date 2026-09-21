/**
 * Splitting an id list into batches an `IN (...)` can actually bind.
 *
 * SQLite compiles every element of an `IN (?, ?, …)` to one bound parameter,
 * and `SQLITE_MAX_VARIABLE_NUMBER` caps those at 32766 in the build
 * better-sqlite3 ships. Past that the statement does not run slowly, it does
 * not run at all: `prepare()` throws `too many SQL variables` before any row is
 * touched.
 *
 * Every query in this repo that feeds a list of ids to `inArray()` is therefore
 * bounded by how many ids the caller happens to have, and the callers that grew
 * unbounded are the maintenance ones — a sweep over everything a box stranded,
 * a bulk "forget all" for a heavy user. Those are precisely the paths where the
 * list is largest and where a throw is most expensive, so they batch.
 *
 * `MAX_IDS_PER_BATCH` is deliberately well under the ceiling rather than at it:
 * a statement usually spends parameters on more than one list (`WHERE a IN (…)
 * OR b IN (…)` is two per id) and on its other predicates, and a batch size
 * chosen to exactly fill the budget would break the moment a caller added a
 * second list. 8000 leaves room for four such lists.
 */

/** Bound parameters SQLite will accept in one statement. */
export const SQLITE_MAX_BOUND_PARAMETERS = 32_766;

/** Ids per batch. See the note above on why this is not the full ceiling. */
export const MAX_IDS_PER_BATCH = 8_000;

/**
 * `values` split into runs of at most `size`. An empty input yields no batches
 * at all, so `for (const batch of batchIds(ids))` runs zero times rather than
 * once with an empty `IN ()`.
 */
export function batchIds<T>(
	values: readonly T[],
	size: number = MAX_IDS_PER_BATCH,
): T[][] {
	if (values.length === 0) return [];
	if (values.length <= size) return [values.slice()];
	const batches: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		batches.push(values.slice(index, index + size));
	}
	return batches;
}

/**
 * Runs `query` once per batch and concatenates the rows. The batches are run in
 * sequence, not in parallel: better-sqlite3 is synchronous and a maintenance
 * sweep has no reason to hold more of the database open at once than it must.
 */
export async function selectInBatches<Id, Row>(
	ids: readonly Id[],
	query: (batch: Id[]) => Promise<Row[]>,
): Promise<Row[]> {
	const rows: Row[] = [];
	for (const batch of batchIds(ids)) {
		rows.push(...(await query(batch)));
	}
	return rows;
}
