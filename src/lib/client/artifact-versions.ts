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
