/**
 * One current version number per artifact, for every surface that shows it
 * (Wave 2.5 polish G1-B).
 *
 * Four surfaces print an artifact's version: the panel list row, the in-chat
 * card, the panel header's version button and the Versions popover's current
 * row. Each used to read its own copy taken at its own moment — the list row
 * and the card from the conversation-detail refresh, the header from the
 * snapshot saved when the item was opened, the popover fresh from the server —
 * so a save, an Alfy edit, an Undo or a restore left them disagreeing. The
 * number the Versions list shows is the server's newest version row; this
 * module is how the browser keeps every other surface on that same number.
 *
 * `client/api/artifacts.ts` announces every version the server reports; the
 * chat page folds those announcements into an `ObservedArtifactVersions` and
 * reads each surface through the helpers below. A version only ever grows (a
 * restore, an Undo and an Alfy edit each append one), so "the highest number
 * heard so far" is exact, and a response that arrives late with an older
 * number can never pull a surface backwards.
 *
 * The time of the last change (polish G2-A: the header's "edited 2 min ago",
 * the list row's time) follows the very same rule, and so does a deletion: an
 * id that has been deleted is deleted for good, and what was heard about it
 * is forgotten so a copy made later under the same id starts from its own
 * numbers.
 */

/** Artifact id → the highest version number the server has reported for it. */
export type ObservedArtifactVersions = Readonly<Record<string, number>>;

export const NO_OBSERVED_ARTIFACT_VERSIONS: ObservedArtifactVersions =
	Object.freeze({});

/**
 * Records a version the server reported. Returns `observed` itself when the
 * number is not newer than what is already known, so a caller can assign the
 * result to state without triggering an update for nothing.
 */
export function observeArtifactVersion(
	observed: ObservedArtifactVersions,
	artifactId: string,
	version: number,
): ObservedArtifactVersions {
	if (!Number.isInteger(version) || version < 1) return observed;
	const known = observed[artifactId];
	if (known !== undefined && known >= version) return observed;
	return { ...observed, [artifactId]: version };
}

/** The newer of a snapshot's number (a list refresh, an opened item) and the observed one. */
export function currentArtifactVersion(
	observed: ObservedArtifactVersions,
	artifactId: string,
	snapshot: number | null | undefined,
): number | null {
	const seen = observed[artifactId];
	if (seen === undefined) return snapshot ?? null;
	return snapshot != null && snapshot > seen ? snapshot : seen;
}

/**
 * A produced File is not on this clock: its versions belong to file
 * production, and it has no `artifact_versions` rows for the observed number
 * to describe.
 */
function isFamilyVersioned(kind: string | null | undefined): boolean {
	return kind != null && kind !== "file";
}

/** A conversation-detail row (`ArtifactCardSummary`) carrying the current number. The same row when it already does. */
export function withCurrentSummaryVersion<
	T extends { id: string; kind: string; versionNumber: number },
>(row: T, observed: ObservedArtifactVersions): T {
	if (!isFamilyVersioned(row.kind)) return row;
	const current = currentArtifactVersion(observed, row.id, row.versionNumber);
	return current === null || current === row.versionNumber
		? row
		: { ...row, versionNumber: current };
}

/**
 * An open panel item (a `DocumentWorkspaceItem`, which keeps the number it
 * had when it was opened — and is saved across reloads with it) carrying the
 * current number. `currentById` is the page's live per-artifact numbers.
 */
export function withCurrentItemVersion<
	T extends {
		artifactId?: string | null;
		kind?: string | null;
		versionNumber?: number | null;
	},
>(item: T, currentById: ReadonlyMap<string, number>): T {
	if (!item.artifactId || !isFamilyVersioned(item.kind)) return item;
	const current = currentById.get(item.artifactId);
	if (current === undefined) return item;
	const snapshot = item.versionNumber ?? 0;
	return current > snapshot ? { ...item, versionNumber: current } : item;
}

/** Artifact id → the latest time (epoch ms) the browser has heard the artifact was changed. */
export type ObservedArtifactTimes = Readonly<Record<string, number>>;

export const NO_OBSERVED_ARTIFACT_TIMES: ObservedArtifactTimes = Object.freeze(
	{},
);

/**
 * Records when the server (or an acknowledged write) says an artifact changed.
 * Same contract as `observeArtifactVersion`: monotonic, and the very same
 * object comes back when nothing is newer. A response that does not say when
 * (`null`) is simply not an observation.
 */
export function observeArtifactUpdatedAt(
	observed: ObservedArtifactTimes,
	artifactId: string,
	updatedAt: number | null | undefined,
): ObservedArtifactTimes {
	if (
		updatedAt === null ||
		updatedAt === undefined ||
		!Number.isFinite(updatedAt) ||
		updatedAt <= 0
	) {
		return observed;
	}
	const known = observed[artifactId];
	if (known !== undefined && known >= updatedAt) return observed;
	return { ...observed, [artifactId]: updatedAt };
}

/** A conversation-detail row carrying the current change time. The same row when it already does. */
export function withCurrentSummaryUpdatedAt<
	T extends { id: string; updatedAt: number },
>(row: T, observed: ObservedArtifactTimes): T {
	const seen = observed[row.id];
	return seen !== undefined && seen > row.updatedAt
		? { ...row, updatedAt: seen }
		: row;
}

/**
 * An open panel item carrying the current change time (the header's meta
 * line reads it). `currentById` is the page's live per-artifact times.
 */
export function withCurrentItemUpdatedAt<
	T extends {
		artifactId?: string | null;
		kind?: string | null;
		updatedAt?: number | null;
	},
>(item: T, currentById: ReadonlyMap<string, number>): T {
	if (!item.artifactId || !item.kind) return item;
	const current = currentById.get(item.artifactId);
	if (current === undefined) return item;
	return current > (item.updatedAt ?? 0)
		? { ...item, updatedAt: current }
		: item;
}

/** The deleted ids with one more. The same list when it was already there. */
export function markArtifactDeleted(
	deleted: readonly string[],
	artifactId: string,
): readonly string[] {
	return deleted.includes(artifactId) ? deleted : [...deleted, artifactId];
}

/** What was heard about an artifact (versions or times), dropped — the same object when nothing was heard. */
export function forgetObservedArtifact<
	T extends Readonly<Record<string, number>>,
>(observed: T, artifactId: string): T {
	if (!(artifactId in observed)) return observed;
	const { [artifactId]: _gone, ...rest } = observed;
	return rest as unknown as T;
}

/** A list without its deleted rows. The same array when none of them is in it. */
export function dropDeletedArtifacts<T extends { id: string }>(
	rows: readonly T[],
	deleted: readonly string[],
): readonly T[] {
	if (deleted.length === 0) return rows;
	const kept = rows.filter((row) => !deleted.includes(row.id));
	return kept.length === rows.length ? rows : kept;
}
