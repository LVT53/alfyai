#!/usr/bin/env tsx
/**
 * Workspace Search's full-text index, for an operator.
 *
 *   npm run search:index                # check: counts by row id; exit 1 when a row is missing or extra
 *   npm run search:index -- --rebuild   # empty both indexes, refill them from their tables, then check
 *
 * The database is the app's (`DATABASE_PATH`, read as the app reads it). A
 * rebuild holds the write lock for its one transaction (about a second for
 * 15 MB of text), so writers wait for it rather than fail. Reads only counts
 * and row ids: no message or document text is printed.
 */

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

async function main(): Promise<void> {
	const rebuild = process.argv.includes("--rebuild");
	const { getDatabasePath } = await import("../src/lib/server/env");
	const { checkSearchIndex, rebuildSearchIndex } = await import(
		"../src/lib/server/services/workspace-search/search-index"
	);
	console.log(
		`[search:index] ${rebuild ? "rebuilding" : "checking"} ${getDatabasePath()}`,
	);
	const started = performance.now();
	const report = rebuild ? rebuildSearchIndex() : checkSearchIndex();
	console.log(JSON.stringify(report, null, 2));
	console.log(
		`[search:index] done in ${Math.round(performance.now() - started)} ms`,
	);
	const outOfStep = Object.values(report).some(
		(count) => count.missing > 0 || count.extra > 0,
	);
	if (outOfStep) {
		console.error(
			"[search:index] the index is out of step; `npm run search:index -- --rebuild` refills it",
		);
	}
	process.exitCode = outOfStep ? 1 : 0;
}

void main();
