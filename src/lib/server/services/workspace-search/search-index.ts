import { sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	type IndexedTable,
	SEARCH_INDEX_TABLES,
	type SearchIndexCount,
	searchIndexCountSql,
	searchIndexOptimizeSql,
	searchIndexRefillSql,
} from "./search-index-sql";

/**
 * The upkeep of Workspace Search's two full-text indexes (`messages_fts`,
 * `artifacts_fts`; migration 145). The triggers keep them in step with every
 * write; these functions are for what triggers cannot do: say whether an index
 * still matches its table, refill it from the table, and merge away the
 * entries of deleted rows (a contentless-delete index only marks them deleted
 * until its pages are merged). The SQL is `search-index-sql.ts`'s, which
 * `scripts/prepare-db.ts` runs too, at every deploy and start.
 */

export type { SearchIndexCount } from "./search-index-sql";

export interface SearchIndexReport {
	messages: SearchIndexCount;
	artifacts: SearchIndexCount;
}

function countOf(table: IndexedTable): SearchIndexCount {
	const row = db.get<SearchIndexCount>(sql.raw(searchIndexCountSql(table)));
	return {
		indexed: Number(row.indexed),
		expected: Number(row.expected),
		missing: Number(row.missing),
		extra: Number(row.extra),
	};
}

/** Whether each index holds exactly the rows it should, counted by row id. */
export function checkSearchIndex(): SearchIndexReport {
	return { messages: countOf("messages"), artifacts: countOf("artifacts") };
}

/**
 * Empties both indexes and fills them again from their tables, in one
 * transaction, then merges each into one segment. The repair for an index that
 * fell out of step (a restored table, a hand edit); returns the check after.
 */
export function rebuildSearchIndex(): SearchIndexReport {
	db.transaction((tx) => {
		for (const table of SEARCH_INDEX_TABLES) {
			for (const statement of searchIndexRefillSql(table)) {
				tx.run(sql.raw(statement));
			}
		}
	});
	return checkSearchIndex();
}

/**
 * Merges each index into one segment, which drops the entries of deleted rows
 * from its pages. Run after an erasure or a clear, so the erased words leave
 * the index's pages and not only its answers. A failure is logged and never
 * fails the erasure: the rows are deleted either way and no search finds them.
 */
export function compactSearchIndex(): boolean {
	try {
		for (const table of SEARCH_INDEX_TABLES) {
			db.run(sql.raw(searchIndexOptimizeSql(table)));
		}
		return true;
	} catch (error) {
		console.error(
			`[WORKSPACE_SEARCH] index_compact_failed error=${error instanceof Error ? error.name : typeof error}`,
		);
		return false;
	}
}
