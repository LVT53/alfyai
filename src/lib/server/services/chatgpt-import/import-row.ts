// The `import_jobs` row of a ChatGPT import, and the one place that writes it.
//
// The row is a progress and audit record that the import request writes as it
// goes; it is not a job. Nothing claims it, beats on it or retries it (ADR-0069
// left the import out of the job engine on purpose), so an import that stops
// without reaching its own last write would leave the row `processing` forever.
// This file keeps two promises the request alone cannot:
//
//  - no row stays `processing` after its import stopped. A restart's rows are
//    settled when the server starts; a row that has not moved for
//    `IMPORT_STALE_AFTER_MS` is settled when the person's next import starts;
//    an import that throws settles its own row.
//  - one import per person at a time (`startImportRow`).
//
// The row's `updated_at` moves after the export is read and before every
// conversation: that is what tells a running import from a stopped one. Every
// write after the start only touches a row that is still `processing`, so an
// import whose row was settled under it stops before its next conversation
// instead of running beside the next import.
//
// `error_log` has two shapes, kept readable: free text on a failed row, and a
// JSON array of the per-conversation errors on a completed one.

import { randomUUID } from "node:crypto";
import { and, eq, lt, type SQL } from "drizzle-orm";
import { db } from "$lib/server/db";
import { importJobs } from "$lib/server/db/schema";

/**
 * A row that has not moved for this long belongs to an import that stopped. A
 * running import writes after reading the export (an upload is at most 100 MB,
 * read in a minute or two) and before every conversation (milliseconds each).
 */
export const IMPORT_STALE_AFTER_MS = 30 * 60_000;

/** What a row says when the import behind it stopped before it finished. */
export const INTERRUPTED_IMPORT_LOG =
	"Interrupted: the import stopped before it finished. The conversations it imported before it stopped were kept.";

/** A second import while the person's first is still `processing`. */
export class ChatGptImportAlreadyRunningError extends Error {
	/** The words the browser shows for it, in the reader's language. */
	readonly errorKey = "chatgptImport.alreadyRunning" as const;

	constructor() {
		super(
			"A ChatGPT import is already running for this account. Wait for it to finish, then try again.",
		);
		this.name = "ChatGptImportAlreadyRunningError";
	}
}

/** The import's row was settled while it ran; the import stops. */
export class ChatGptImportInterruptedError extends Error {
	constructor(jobId: string) {
		super(`The row of ChatGPT import ${jobId} was settled while it ran`);
		this.name = "ChatGptImportInterruptedError";
	}
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function settleAsInterrupted(tx: Tx, where: SQL | undefined, now: Date) {
	return tx
		.update(importJobs)
		.set({
			status: "failed",
			errorLog: INTERRUPTED_IMPORT_LOG,
			updatedAt: now,
		})
		.where(and(eq(importJobs.status, "processing"), where))
		.run().changes;
}

/**
 * Start an import's row, or refuse: one transaction, so two imports started
 * together cannot both pass. A row of the person's that has not moved for
 * `IMPORT_STALE_AFTER_MS` is settled first; one that is still moving means an
 * import is running.
 */
export function startImportRow(userId: string, now = new Date()): string {
	const jobId = db.transaction((tx) => {
		settleAsInterrupted(
			tx,
			and(
				eq(importJobs.userId, userId),
				lt(
					importJobs.updatedAt,
					new Date(now.getTime() - IMPORT_STALE_AFTER_MS),
				),
			),
			now,
		);
		const running = tx
			.select({ id: importJobs.id })
			.from(importJobs)
			.where(
				and(eq(importJobs.userId, userId), eq(importJobs.status, "processing")),
			)
			.limit(1)
			.get();
		if (running) return null;

		const id = randomUUID();
		tx.insert(importJobs)
			.values({
				id,
				userId,
				status: "processing",
				totalConversations: 0,
				processedConversations: 0,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		return id;
	});
	if (!jobId) throw new ChatGptImportAlreadyRunningError();
	return jobId;
}

function writeWhileProcessing(
	jobId: string,
	values: Partial<typeof importJobs.$inferInsert>,
	now: Date,
): void {
	const written = db
		.update(importJobs)
		.set({ ...values, updatedAt: now })
		.where(and(eq(importJobs.id, jobId), eq(importJobs.status, "processing")))
		.run();
	if (written.changes === 0) throw new ChatGptImportInterruptedError(jobId);
}

/** Record how far the import got. Throws when the row was settled meanwhile. */
export function writeImportProgress(
	jobId: string,
	progress: { totalConversations?: number; processedConversations: number },
	now = new Date(),
): void {
	writeWhileProcessing(jobId, progress, now);
}

/**
 * The import finished: `completed`, with the per-conversation errors as a JSON
 * array (or no log when there were none). Throws when the row was settled
 * meanwhile.
 */
export function completeImportRow(
	jobId: string,
	result: {
		processedConversations: number;
		errors: { conversationTitle?: string; reason: string }[];
	},
	now = new Date(),
): void {
	writeWhileProcessing(
		jobId,
		{
			status: "completed",
			processedConversations: result.processedConversations,
			errorLog: result.errors.length > 0 ? JSON.stringify(result.errors) : null,
		},
		now,
	);
}

/**
 * Settle an import's row as failed, with a free-text log, unless something has
 * already settled it. Returns whether it did.
 */
export function failImportRow(
	jobId: string,
	errorLog: string,
	now = new Date(),
): boolean {
	const failed = db
		.update(importJobs)
		.set({ status: "failed", errorLog, updatedAt: now })
		.where(and(eq(importJobs.id, jobId), eq(importJobs.status, "processing")))
		.run();
	return failed.changes > 0;
}

/**
 * Settle every import still `processing` as failed and interrupted. Called once
 * when the server starts: an import runs inside its request, so after a restart
 * nothing is left to finish such a row. Deploys run one server process per
 * database (`scripts/deploy.sh` restarts the service), so at boot no row can
 * belong to an import that is still running. Returns how many rows it settled.
 */
export function settleInterruptedImports(now = new Date()): number {
	const settled = db.transaction((tx) =>
		settleAsInterrupted(tx, undefined, now),
	);
	if (settled > 0) {
		console.info("[CHATGPT_IMPORT] Settled imports a restart interrupted", {
			count: settled,
		});
	}
	return settled;
}
