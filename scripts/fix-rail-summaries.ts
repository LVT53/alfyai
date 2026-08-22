#!/usr/bin/env tsx
// One-time repair: existing railSummary values were stored as the control model's
// raw JSON (`{"headline":"…"}`) because the short-text seam treated the forced
// JSON output as plain text. Unwrap each stored value in place to the underlying
// string. Deterministic and cheap — no model calls. Idempotent: an already-clean
// summary is left untouched (unwrapJsonControlText only rewrites JSON objects).
//
//   cd /home/alfydesign/apps/langflow-chat/current && npx tsx scripts/fix-rail-summaries.ts
// Flags: --dry-run (report only, no writes).
import { config as dotenvConfig } from "dotenv";

dotenvConfig();
if (!process.env.SESSION_SECRET)
	process.env.SESSION_SECRET =
		"test-session-secret-12345678901234567890123456789012";
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/index";
import { messages } from "$lib/server/db/schema";
import { unwrapJsonControlText } from "$lib/server/services/chat-turn/short-local-text";
import { updateMessageRailSummary } from "$lib/server/services/messages";

function railSummaryOf(metadataJson: string | null): string | null {
	if (!metadataJson) return null;
	try {
		const m = JSON.parse(metadataJson) as { railSummary?: unknown };
		return typeof m.railSummary === "string" ? m.railSummary : null;
	} catch {
		return null;
	}
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");

	const rows = await db
		.select({ id: messages.id, metadataJson: messages.metadataJson })
		.from(messages)
		.where(eq(messages.role, "assistant"));

	let hadSummary = 0;
	let fixed = 0;
	let alreadyClean = 0;
	let failed = 0;

	for (const row of rows) {
		const current = railSummaryOf(row.metadataJson);
		if (current === null) continue;
		hadSummary++;

		const cleaned = unwrapJsonControlText(current).trim();
		if (!cleaned || cleaned === current) {
			alreadyClean++;
			continue;
		}

		if (dryRun) {
			fixed++;
			if (fixed <= 20)
				console.log(
					`  ${JSON.stringify(current)}  ->  ${JSON.stringify(cleaned)}`,
				);
			continue;
		}

		try {
			await updateMessageRailSummary(row.id, cleaned);
			fixed++;
		} catch (err) {
			failed++;
			console.warn(
				`  fail ${row.id}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	console.log(
		`\n${dryRun ? "(dry-run) " : ""}rail-summary repair complete: withSummary=${hadSummary}, fixed=${fixed}, alreadyClean=${alreadyClean}, failed=${failed}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
