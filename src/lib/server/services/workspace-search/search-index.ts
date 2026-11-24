import { sql } from "drizzle-orm";
import { db } from "$lib/server/db";

/**
 * The upkeep of Workspace Search's two full-text indexes (`messages_fts`,
 * `artifacts_fts`; migration 145). The triggers keep them in step with every
 * write; these functions are for what triggers cannot do: say whether an index
 * still matches its table, refill it from the table, and merge away the
 * entries of deleted rows (a contentless-delete index only marks them deleted
 * until its pages are merged).
 *
 * Which rows are indexed is written here once more, because a migration cannot
 * import it: keep it equal to migration 145's condition (`search-index.test.ts`
 * fails when a refill and the triggers disagree).
 */

type IndexedTable = "messages" | "artifacts";

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

const TABLES: readonly IndexedTable[] = ["messages", "artifacts"];

/** What one index holds against what its table says it should hold, by row id. */
export interface SearchIndexCount {
	indexed: number;
	expected: number;
	/** Rows that should be in the index and are not. */
	missing: number;
	/** Index rows with no row that should be there. */
	extra: number;
}

export interface SearchIndexReport {
	messages: SearchIndexCount;
	artifacts: SearchIndexCount;
}

function countOf(table: IndexedTable): SearchIndexCount {
	const { index, indexed } = INDEXES[table];
	const row = db.get<SearchIndexCount>(
		sql.raw(`SELECT
			(SELECT count(*) FROM ${index}) AS indexed,
			(SELECT count(*) FROM ${table} WHERE ${indexed}) AS expected,
			(SELECT count(*) FROM ${table} WHERE ${indexed} AND rowid NOT IN (SELECT rowid FROM ${index})) AS missing,
			(SELECT count(*) FROM ${index} WHERE rowid NOT IN (SELECT rowid FROM ${table} WHERE ${indexed})) AS extra`),
	);
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
		for (const table of TABLES) {
			const { index, column, indexed } = INDEXES[table];
			tx.run(sql.raw(`INSERT INTO ${index}(${index}) VALUES ('delete-all')`));
			tx.run(
				sql.raw(
					`INSERT INTO ${index}(rowid, ${column}) SELECT rowid, ${column} FROM ${table} WHERE ${indexed}`,
				),
			);
			tx.run(sql.raw(`INSERT INTO ${index}(${index}) VALUES ('optimize')`));
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
		for (const table of TABLES) {
			const { index } = INDEXES[table];
			db.run(sql.raw(`INSERT INTO ${index}(${index}) VALUES ('optimize')`));
		}
		return true;
	} catch (error) {
		console.error(
			`[WORKSPACE_SEARCH] index_compact_failed error=${error instanceof Error ? error.name : typeof error}`,
		);
		return false;
	}
}
