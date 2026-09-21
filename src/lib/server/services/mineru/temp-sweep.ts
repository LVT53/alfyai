/**
 * The two temporary directories a killed process leaves behind, and nothing
 * else.
 *
 * Both are removed on every ordinary exit path — `extract()` has a `finally`
 * that drops its per-attempt download directory, and `writeMineruParseBundle`
 * has a `catch` that drops its half-written bundle. Neither survives a SIGKILL,
 * an OOM kill or a power loss, and each can hold a whole result zip or a whole
 * bundle:
 *
 *   <tmpdir>/alfyai-mineru4-<rand>/result.zip        the downloaded zip
 *   data/knowledge/<user>/<id>.parse.tmp-<pid>-<rand>/   a half-written bundle
 *
 * The second is the worse one: it sits inside the data directory, it is up to
 * `MINERU_BUNDLE_MAX_BYTES`, `findOrphanFiles` deliberately skips the name so
 * it is not even REPORTED, and nothing but account erasure has ever removed
 * one. `writeMineruParseBundle`'s comment that "the next write removes it" is
 * only true when a next write happens, which for a document nobody
 * re-extracts is never.
 *
 * Four rules, because a sweep that deletes live work is worse than the leak:
 *
 *  1. **Age.** Only entries whose mtime is older than `maxAgeMs`. The default
 *     is well past any plausible job, so an attempt running right now — in
 *     this process or in another one sharing the box — can never age out from
 *     under itself.
 *  2. **Name.** Only `alfyai-mineru4-*` directly inside the dedicated temp
 *     root, and only `<id>.parse.tmp-*` directly inside a user's knowledge
 *     directory. Never a recursive walk, never a glob that could match a live
 *     `.parse` bundle.
 *  3. **`lstat`, never `stat`.** A symlink is skipped, not followed: a sweep
 *     that resolved one would be a recursive delete pointed at whatever the
 *     link named.
 *  4. **Bounded.** At most `maxEntries` are examined per root, so a temp
 *     directory with a million entries costs one `readdir` and a fixed slice
 *     rather than a stalled boot.
 */

import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MINERU_BUNDLE_TMP_INFIX } from "./bundle";

const LOG_PREFIX = "[MINERU]";

/** The prefix `extractors/mineru4.ts` gives `mkdtemp`. */
export const MINERU_ATTEMPT_TMP_PREFIX = "alfyai-mineru4-";

/**
 * Six hours: twelve times the 300 s default `MINERU_JOB_TIMEOUT_MS`, and past
 * the ceiling an admin may raise it to (3 600 000 ms). Nothing legitimate is
 * this old and still wanted.
 */
export const MINERU_TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** One `readdir` worth of work, whatever is in there. */
const MAX_ENTRIES_PER_ROOT = 5_000;

export interface SweepMineruTempOptions {
	/** Where per-attempt download directories live. Defaults to `os.tmpdir()`. */
	tempRootAbsolute?: string;
	/** `data/knowledge`. Defaults to the one under `process.cwd()`. */
	knowledgeRootAbsolute?: string;
	maxAgeMs?: number;
	now?: () => number;
	maxEntries?: number;
}

export interface SweepMineruTempResult {
	scanned: number;
	removed: number;
}

async function listNames(pathAbsolute: string, limit: number) {
	try {
		return (await readdir(pathAbsolute, { withFileTypes: true })).slice(
			0,
			limit,
		);
	} catch {
		// A missing root is the ordinary case on a fresh box.
		return [];
	}
}

/**
 * Removes one directory when it matches, is old enough and is not a symlink.
 * Returns whether anything was deleted; never throws.
 */
async function dropIfStale(
	pathAbsolute: string,
	cutoff: number,
): Promise<boolean> {
	// `lstat`, so a symlink planted here is skipped rather than followed into a
	// recursive delete of whatever it names.
	const info = await lstat(pathAbsolute).catch(() => null);
	if (!info || !info.isDirectory()) return false;
	if (info.mtimeMs > cutoff) return false;
	return await rm(pathAbsolute, { recursive: true, force: true })
		.then(() => true)
		.catch(() => false);
}

/**
 * Sweeps both roots once. Never throws: a sweep that cannot read a directory
 * is a missed cleanup, not a failed extraction.
 */
export async function sweepMineruTempDirs(
	options: SweepMineruTempOptions = {},
): Promise<SweepMineruTempResult> {
	const now = options.now ?? Date.now;
	const cutoff = now() - (options.maxAgeMs ?? MINERU_TEMP_MAX_AGE_MS);
	const limit = options.maxEntries ?? MAX_ENTRIES_PER_ROOT;
	const tempRoot = options.tempRootAbsolute ?? tmpdir();
	const knowledgeRoot =
		options.knowledgeRootAbsolute ?? join(process.cwd(), "data", "knowledge");

	let scanned = 0;
	let removed = 0;

	// 1. Per-attempt download directories, directly inside the temp root.
	for (const entry of await listNames(tempRoot, limit)) {
		if (!entry.name.startsWith(MINERU_ATTEMPT_TMP_PREFIX)) continue;
		scanned += 1;
		if (await dropIfStale(join(tempRoot, entry.name), cutoff)) removed += 1;
	}

	// 2. Half-written bundles, one level down, inside each user's directory.
	//    `<id>.parse.tmp-…` only — never `<id>.parse`, which is a live bundle.
	for (const user of await listNames(knowledgeRoot, limit)) {
		if (!user.isDirectory()) continue;
		const userDir = join(knowledgeRoot, user.name);
		for (const entry of await listNames(userDir, limit)) {
			if (!entry.name.includes(MINERU_BUNDLE_TMP_INFIX)) continue;
			scanned += 1;
			if (await dropIfStale(join(userDir, entry.name), cutoff)) removed += 1;
		}
	}

	return { scanned, removed };
}

let sweptAt = 0;

/** Test seam: forget the throttle. */
export function resetMineruTempSweepForTests(): void {
	sweptAt = 0;
}

/**
 * The worker's call: once at boot, then at most once per `maxAgeMs`.
 *
 * Fire-and-forget on purpose — boot must not wait on a filesystem walk — and
 * it logs only when it actually deleted something, so an ordinary box says
 * nothing.
 */
export function scheduleMineruTempSweep(
	options: SweepMineruTempOptions = {},
): void {
	const now = options.now ?? Date.now;
	const interval = options.maxAgeMs ?? MINERU_TEMP_MAX_AGE_MS;
	const at = now();
	if (sweptAt !== 0 && at - sweptAt < interval) return;
	sweptAt = at;

	void sweepMineruTempDirs(options)
		.then((result) => {
			if (result.removed > 0) {
				console.info(
					`${LOG_PREFIX} Swept stale MinerU temp directories`,
					result,
				);
			}
		})
		.catch((error) => {
			console.warn(`${LOG_PREFIX} MinerU temp sweep failed`, { error });
		});
}
