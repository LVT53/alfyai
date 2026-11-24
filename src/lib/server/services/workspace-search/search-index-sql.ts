/**
 * The SQL of the upkeep of Workspace Search's two full-text indexes
 * (`messages_fts`, `artifacts_fts`; migration 145), shared by the app
 * (`search-index.ts`, through Drizzle) and `scripts/prepare-db.ts` (through
 * better-sqlite3, before the app starts), so neither keeps its own copy. No
 * imports: prepare-db reads this file by a relative path.
 *
 * Which rows are indexed is written here once more than migration 145 writes
 * it, because a migration cannot import it: keep the two equal
 * (`search-index.test.ts` fails when a refill and the triggers disagree).
 */

export type IndexedTable = "messages" | "artifacts";

export const SEARCH_INDEX_TABLES: readonly IndexedTable[] = [
	"messages",
	"artifacts",
];

const INDEXES: Record<
	IndexedTable,
	{ index: string; column: string; indexed: string }
> = {
	messages: {
		index: "messages_fts",
		column: "content",
		indexed: "length(content) > 0",
	},
	artifacts: {
		index: "artifacts_fts",
		column: "content_text",
		indexed: `length(content_text) > 0 AND (
			type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
			OR (type = 'artifact' AND coalesce(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
		)`,
	},
};

/** What one index holds against what its table says it should hold, by row id. */
export interface SearchIndexCount {
	indexed: number;
	expected: number;
	/** Rows that should be in the index and are not. */
	missing: number;
	/** Index rows with no row that should be there. */
	extra: number;
}

/** One row of `SearchIndexCount`'s four counts for one table. */
export function searchIndexCountSql(table: IndexedTable): string {
	const { index, indexed } = INDEXES[table];
	return `SELECT
		(SELECT count(*) FROM ${index}) AS indexed,
		(SELECT count(*) FROM ${table} WHERE ${indexed}) AS expected,
		(SELECT count(*) FROM ${table} WHERE ${indexed} AND rowid NOT IN (SELECT rowid FROM ${index})) AS missing,
		(SELECT count(*) FROM ${index} WHERE rowid NOT IN (SELECT rowid FROM ${table} WHERE ${indexed})) AS extra`;
}

/** Empty one index, fill it again from its table, merge it: run them in one transaction. */
export function searchIndexRefillSql(table: IndexedTable): string[] {
	const { index, column, indexed } = INDEXES[table];
	return [
		`INSERT INTO ${index}(${index}) VALUES ('delete-all')`,
		`INSERT INTO ${index}(rowid, ${column}) SELECT rowid, ${column} FROM ${table} WHERE ${indexed}`,
		searchIndexOptimizeSql(table),
	];
}

/** Merge one index into one segment, which drops a deleted row's entries from its pages. */
export function searchIndexOptimizeSql(table: IndexedTable): string {
	const { index } = INDEXES[table];
	return `INSERT INTO ${index}(${index}) VALUES ('optimize')`;
}

/** Whether a count says the index is out of step with its table. */
export function isOutOfStep(count: SearchIndexCount): boolean {
	return count.missing > 0 || count.extra > 0;
}
