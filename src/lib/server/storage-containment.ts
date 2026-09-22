/**
 * Whether a stored path may be unlinked.
 *
 * Every `storage_path` in this database is server-generated, so today none of
 * them escapes `data/`. That is an argument about the CURRENT writers, not
 * about the readers — and the readers changed. The orphan sweep is the first
 * thing that runs box-wide, over every user's rows at once, from a maintenance
 * script with whatever privileges the operator gave it; bundle eviction removes
 * directories it found by listing the disk. Both take a path out of a row and
 * hand it to `unlink`/`rm`. A single bad row — a restore from an older schema,
 * a hand-edited database, a future importer that trusts a filename — turns
 * that into "delete anything this process can reach".
 *
 * So the check lives at the unlink, not at the write. `resolve()` collapses
 * `..`, and the PARENT is `realpath`ed so a symlinked directory cannot point
 * the final path outside the roots after resolution. The leaf itself is
 * deliberately NOT resolved: a symlink we are asked to delete is a link we
 * should remove, and `unlink` removes the link rather than following it.
 */

import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * The directories the app owns. Everything it may ever delete is under one of
 * them, and both are derived from the working directory the same way every
 * writer derives them.
 */
export function storageRoots(): string[] {
	return [
		resolve(process.cwd(), "data", "knowledge"),
		resolve(process.cwd(), "data", "chat-files"),
	];
}

function isUnder(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * The absolute path to delete, or `null` when it is not inside a storage root.
 *
 * `null` is a refusal, not an error: callers record it beside the paths whose
 * unlink failed, so a bad row shows up in the disk report instead of stopping
 * a sweep that has thousands of good rows left to do.
 */
export async function resolveDeletablePath(
	storagePath: string,
	roots: string[] = storageRoots(),
): Promise<string | null> {
	if (typeof storagePath !== "string" || storagePath.trim().length === 0) {
		return null;
	}
	// Relative to the working directory, exactly as every writer stores it. An
	// ABSOLUTE `storagePath` wins over the base in `resolve`, which is the
	// point of resolving before checking rather than trusting the join.
	const absolute = resolve(process.cwd(), storagePath);
	if (!roots.some((root) => isUnder(absolute, root))) return null;

	// The parent, not the leaf: the leaf may legitimately not exist yet (or at
	// all), and a symlink we were asked to delete is a link to remove rather
	// than follow.
	let realParent: string;
	try {
		realParent = await realpath(dirname(absolute));
	} catch {
		// No parent on disk means nothing to delete through it.
		return null;
	}
	const realRoots = await Promise.all(
		roots.map((root) => realpath(root).catch(() => root)),
	);
	if (!realRoots.some((root) => isUnder(realParent, root))) return null;

	return absolute;
}
