#!/usr/bin/env tsx
/**
 * Idempotent backfill: recomputes `image_files.has_alpha` with the rule
 * `storeImageFile` now uses (see `images/alpha.ts`): a picture is see-through
 * only when some alpha value is below SEE_THROUGH_ALPHA_BELOW. Before that
 * rule, pictures whose alpha was only 254 from resampling were flagged
 * see-through and drawn on the checkerboard.
 *
 * It reads each stored PNG and only updates `has_alpha`; files are untouched.
 * A second run changes nothing. A missing or unreadable file is reported and
 * skipped (its flag is left as is).
 *
 * Run from the app folder (storage paths are relative to it):
 *   npx tsx scripts/images/backfill-has-alpha.ts [--dry-run]
 */
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getDatabasePath } from "$lib/server/env";
import { pngIsSeeThrough } from "$lib/server/services/images/alpha";

export type HasAlphaBackfill = {
	checked: number;
	changed: { id: string; from: number; to: number }[];
	skipped: { id: string; reason: string }[];
};

export async function backfillHasAlpha(
	options: { databasePath?: string; baseDir?: string; dryRun?: boolean } = {},
): Promise<HasAlphaBackfill> {
	const sqlite = new Database(options.databasePath ?? getDatabasePath());
	const baseDir = options.baseDir ?? process.cwd();
	const result: HasAlphaBackfill = { checked: 0, changed: [], skipped: [] };
	try {
		const rows = sqlite
			.prepare("SELECT id, storage_path, has_alpha FROM image_files")
			.all() as { id: string; storage_path: string; has_alpha: number }[];
		const update = sqlite.prepare(
			"UPDATE image_files SET has_alpha = ? WHERE id = ?",
		);
		for (const row of rows) {
			result.checked += 1;
			let next: number;
			try {
				next = (await pngIsSeeThrough(
					await readFile(join(baseDir, row.storage_path)),
				))
					? 1
					: 0;
			} catch (error) {
				result.skipped.push({
					id: row.id,
					reason: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (next === row.has_alpha) continue;
			if (!options.dryRun) update.run(next, row.id);
			result.changed.push({ id: row.id, from: row.has_alpha, to: next });
		}
	} finally {
		sqlite.close();
	}
	return result;
}

function isDirectExecution(): boolean {
	return Boolean(
		process.argv[1] &&
			resolve(process.argv[1]) === fileURLToPath(import.meta.url),
	);
}

if (isDirectExecution()) {
	const dryRun = process.argv.includes("--dry-run");
	const { checked, changed, skipped } = await backfillHasAlpha({ dryRun });
	console.log(`Checked ${checked} picture file(s).`);
	for (const item of changed) {
		console.log(
			`  ${dryRun ? "would set" : "set"} ${item.id}: has_alpha ${item.from} -> ${item.to}`,
		);
	}
	for (const item of skipped)
		console.warn(`  skipped ${item.id}: ${item.reason}`);
	console.log(
		`${dryRun ? "Would change" : "Changed"} ${changed.length}, skipped ${skipped.length}.`,
	);
}
