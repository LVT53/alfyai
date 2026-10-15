// The `import_jobs` row of a ChatGPT import, and the one place that writes it.
//
// The row is a progress and audit record that the import request writes as it
// goes; it is not a job. Nothing claims it, beats on it or retries it (ADR-0069
// left the import out of the job engine on purpose), so an import that stops
// without reaching its own last write would leave the row `processing` forever.
// This file keeps that from happening.
//
// `error_log` has two shapes, kept readable: free text on a failed row, and a
// JSON array of the per-conversation errors on a completed one.

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { importJobs } from "$lib/server/db/schema";

/** What a row says when the import behind it stopped before it finished. */
export const INTERRUPTED_IMPORT_LOG =
	"Interrupted: the import stopped before it finished. The conversations it imported before it stopped were kept.";

/**
 * Settle every import still `processing` as failed and interrupted. Called once
 * when the server starts: an import runs inside its request, so after a restart
 * nothing is left to finish such a row. Deploys run one server process per
 * database (`scripts/deploy.sh` restarts the service), so at boot no row can
 * belong to an import that is still running. Returns how many rows it settled.
 */
export function settleInterruptedImports(now = new Date()): number {
	const settled = db
		.update(importJobs)
		.set({
			status: "failed",
			errorLog: INTERRUPTED_IMPORT_LOG,
			updatedAt: now,
		})
		.where(eq(importJobs.status, "processing"))
		.run();
	if (settled.changes > 0) {
		console.info("[CHATGPT_IMPORT] Settled imports a restart interrupted", {
			count: settled.changes,
		});
	}
	return settled.changes;
}
