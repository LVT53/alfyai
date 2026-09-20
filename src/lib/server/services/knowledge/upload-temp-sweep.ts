// Bug B2, the half a per-request `unlink` cannot fix.
//
// Every upload route that receives bytes writes them under
// `data/knowledge/<user>/.incoming/` before they become an artifact: the raw
// route writes one `<trace>.upload` file, the chunked route writes a
// `<trace>/` directory of parts. Both clean up on the paths they can see — but
// a client that starts a chunked upload and never sends the final part, or a
// process killed between the write and the rename, leaves the bytes behind and
// nothing has ever swept them. On a box that uploads scans daily that is a
// quiet, unbounded disk leak.
//
// So: one sweep, old entries only, never touching anything a live request could
// still be writing to. Six hours is far longer than any upload can legitimately
// take (the adapter body limit and the request timeouts both bite long before),
// and short enough that an abandoned 40 MB part directory does not survive a
// day.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const INCOMING_DIR_NAME = ".incoming";

/** Entries older than this are considered abandoned. */
export const UPLOAD_TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** At most one sweep per process per hour, however many uploads arrive. */
const SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;

export interface SweepKnowledgeUploadTempFilesOptions {
	/** Defaults to `<cwd>/data/knowledge`. */
	knowledgeRootAbsolute?: string;
	maxAgeMs?: number;
	now?: number;
	/** Restricts the sweep to one user's directory. */
	userId?: string;
}

export interface SweepKnowledgeUploadTempFilesResult {
	scanned: number;
	removed: number;
}

function knowledgeRoot(options: SweepKnowledgeUploadTempFilesOptions): string {
	return (
		options.knowledgeRootAbsolute ?? join(process.cwd(), "data", "knowledge")
	);
}

async function listDirectoryNames(pathAbsolute: string): Promise<string[]> {
	try {
		const entries = await readdir(pathAbsolute, { withFileTypes: true });
		return entries.flatMap((entry) =>
			entry.isDirectory() ? [entry.name] : [],
		);
	} catch {
		return [];
	}
}

async function sweepIncomingDir(params: {
	incomingDirAbsolute: string;
	cutoff: number;
}): Promise<SweepKnowledgeUploadTempFilesResult> {
	let names: string[];
	try {
		names = await readdir(params.incomingDirAbsolute);
	} catch {
		return { scanned: 0, removed: 0 };
	}

	let removed = 0;
	for (const name of names) {
		const entryPath = join(params.incomingDirAbsolute, name);
		const info = await stat(entryPath).catch(() => null);
		if (!info) continue;
		// `mtime` rather than `birthtime`: a chunked upload that is still
		// receiving parts keeps touching its directory, so an active transfer can
		// never age out from under itself.
		if (info.mtimeMs > params.cutoff) continue;
		const dropped = await rm(entryPath, { force: true, recursive: true })
			.then(() => true)
			.catch(() => false);
		if (dropped) removed += 1;
	}

	return { scanned: names.length, removed };
}

/**
 * Deletes abandoned upload temporaries. Never throws: a sweep that cannot read
 * a directory is a missed cleanup, not a failed upload.
 */
export async function sweepKnowledgeUploadTempFiles(
	options: SweepKnowledgeUploadTempFilesOptions = {},
): Promise<SweepKnowledgeUploadTempFilesResult> {
	const root = knowledgeRoot(options);
	const cutoff =
		(options.now ?? Date.now()) - (options.maxAgeMs ?? UPLOAD_TEMP_MAX_AGE_MS);
	const userIds = options.userId
		? [options.userId]
		: await listDirectoryNames(root);

	const total: SweepKnowledgeUploadTempFilesResult = { scanned: 0, removed: 0 };
	for (const userId of userIds) {
		const result = await sweepIncomingDir({
			incomingDirAbsolute: join(root, userId, INCOMING_DIR_NAME),
			cutoff,
		});
		total.scanned += result.scanned;
		total.removed += result.removed;
	}

	return total;
}

let lastSweepAt = 0;
let sweepInFlight: Promise<void> | null = null;

function isNonServingContext(): boolean {
	return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/**
 * Fire-and-forget, throttled. Called from the routes that create `.incoming`
 * entries rather than from process boot, because a box that is never restarted
 * would otherwise never sweep — and an upload is exactly the moment the
 * directory is known to exist and worth looking at.
 */
export function scheduleKnowledgeUploadTempSweep(): void {
	if (isNonServingContext() || sweepInFlight) return;
	const now = Date.now();
	if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
	lastSweepAt = now;

	sweepInFlight = sweepKnowledgeUploadTempFiles()
		.then((result) => {
			if (result.removed > 0) {
				console.info("[KNOWLEDGE] Swept abandoned upload temporaries", result);
			}
		})
		.catch((error) => {
			console.warn("[KNOWLEDGE] Upload temp sweep failed", { error });
		})
		.finally(() => {
			sweepInFlight = null;
		});
}

/** Test helper: forget the throttle. */
export function resetKnowledgeUploadTempSweepForTests(): void {
	lastSweepAt = 0;
	sweepInFlight = null;
}
