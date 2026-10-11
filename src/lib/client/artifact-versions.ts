/**
 * One latest moment per artifact, for every surface that says when it last
 * changed (Wave 2.5 polish G1-B, rebuilt for ruling 76's amendment A1).
 *
 * Four surfaces speak of an artifact's last change: the panel list row, the
 * in-chat card, the panel header's history button and History's top moment.
 * Each used to read its own copy taken at its own moment — the list row and the
 * card from the conversation-detail refresh, the header from the snapshot saved
 * when the item was opened, the Versions popover fresh from the server — so a
 * save, an Alfy edit, an Undo or a restore left them disagreeing. This module is
 * how the browser keeps every surface on the same answer.
 *
 * `client/api/artifacts.ts` announces every version the server reports, with
 * its time and, where the response knows them, who made it and what it was
 * (`author`, `kind`: the shared `MomentKind` vocabulary). The chat page folds
 * those announcements into an `ObservedArtifactMoments` and reads each surface
 * through the helpers below. A version only ever grows (a restore, an Undo and
 * an Alfy edit each append one), so "the highest number heard so far" is exact,
 * and a response that arrives late with an older number can never pull a
 * surface backwards. The NUMBER orders and guards (`expectVersion`); what the
 * surfaces print is the moment, and the number only in History's fine print.
 *
 * A deletion follows the very same rule: an id that has been deleted is deleted
 * for good, and what was heard about it is forgotten so a copy made later under
 * the same id starts from its own moment.
 */
import type {
	ArtifactMoment,
	MomentAuthor,
	MomentKind,
} from "$lib/shared/artifacts/history";

/** The newest version of one artifact as the browser knows it. Any part but the number may be unknown (`null`). */
export interface LatestMoment {
	version: number;
	/** Epoch ms of the newest version's last save, or `null` when no response said when. */
	at: number | null;
	author: MomentAuthor | null;
	kind: MomentKind | null;
}

/** What a response said about the newest version. Only `version` is required. */
export interface HeardMoment {
	version: number;
	at?: number | null;
	author?: MomentAuthor | null;
	kind?: MomentKind | null;
}

/** Artifact id → the latest moment the server has reported for it. */
export type ObservedArtifactMoments = Readonly<Record<string, LatestMoment>>;

export const NO_OBSERVED_ARTIFACT_MOMENTS: ObservedArtifactMoments =
	Object.freeze({});

function validTime(at: number | null | undefined): number | null {
	return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

function sameMoment(a: LatestMoment, b: LatestMoment): boolean {
	return (
		a.version === b.version &&
		a.at === b.at &&
		a.author === b.author &&
		a.kind === b.kind
	);
}

/**
 * Records what the server reported about an artifact's newest version. Returns
 * `observed` itself when nothing is newer or more specific than what is known,
 * so a caller can assign the result to state without triggering an update for
 * nothing.
 *
 * - A lower version is not an observation (a slow response never wins).
 * - A higher one replaces the whole moment: its author and kind are its own,
 *   never the previous version's. A time it does not carry stays at the
 *   previous one, a lower bound that is better than nothing.
 * - The same version fills in what was unknown, lets the time move forward (a
 *   typing burst saves into one version again and again) and lets a more
 *   specific kind replace a general one (a tick is an edit).
 */
export function observeArtifactMoment(
	observed: ObservedArtifactMoments,
	artifactId: string,
	heard: HeardMoment,
): ObservedArtifactMoments {
	if (!Number.isInteger(heard.version) || heard.version < 1) return observed;
	const known = observed[artifactId];
	const at = validTime(heard.at);
	let next: LatestMoment;
	if (known === undefined || heard.version > known.version) {
		next = {
			version: heard.version,
			at: at ?? known?.at ?? null,
			author: heard.author ?? null,
			kind: heard.kind ?? null,
		};
	} else if (heard.version === known.version) {
		next = {
			version: known.version,
			at: at !== null && (known.at === null || at > known.at) ? at : known.at,
			author: heard.author ?? known.author,
			kind: heard.kind ?? known.kind,
		};
	} else {
		return observed;
	}
	if (known !== undefined && sameMoment(known, next)) return observed;
	return { ...observed, [artifactId]: next };
}

/**
 * The newer of a snapshot's moment (a list refresh, an opened item) and the
 * observed one. On the same version it takes what either side knows and the
 * later time. `null` when neither knows anything.
 */
export function currentArtifactMoment(
	observed: ObservedArtifactMoments,
	artifactId: string,
	snapshot: LatestMoment | null | undefined,
): LatestMoment | null {
	const seen = observed[artifactId];
	if (seen === undefined) return snapshot ?? null;
	if (!snapshot || seen.version > snapshot.version) return seen;
	if (snapshot.version > seen.version) return snapshot;
	const at =
		seen.at !== null && snapshot.at !== null
			? Math.max(seen.at, snapshot.at)
			: (seen.at ?? snapshot.at);
	return {
		version: seen.version,
		at,
		author: seen.author ?? snapshot.author,
		kind: seen.kind ?? snapshot.kind,
	};
}

/**
 * The newest row a moment holds, as a latest moment: a folded moment draws
 * several rows (an Alfy change and the Undo that took it back), and what the
 * header says is the NEWEST of them, never the first. The row's own time, author
 * and kind: an Undo's, not the Alfy change it was folded onto.
 */
export function latestRowOfMoment(moment: ArtifactMoment): LatestMoment {
	let newest: LatestMoment = {
		version: moment.versionNumber,
		at: validTime(moment.at),
		author: moment.author,
		kind: moment.kind,
	};
	for (const step of moment.steps) {
		if (step.versionNumber > newest.version) {
			newest = {
				version: step.versionNumber,
				at: validTime(step.at),
				author: step.author,
				kind: step.kind,
			};
		}
	}
	return newest;
}

/** The fields a conversation-detail row or an open panel item carries for its latest moment (the number and time it always had; author and kind since ruling 76). */
interface LatestMomentFields {
	lastAuthor?: MomentAuthor | null;
	lastKind?: MomentKind | null;
}

/**
 * The latest moment a row or an item carries, or `null` when it has none (a
 * snapshot with no version yet). Structural on purpose: a card summary, a panel
 * item and a test's plain object are read the same way.
 */
export function readLatestMoment(source: {
	versionNumber?: number | null;
	updatedAt?: number | null;
	lastAuthor?: MomentAuthor | null;
	lastKind?: MomentKind | null;
}): LatestMoment | null {
	const version = source.versionNumber;
	if (
		typeof version !== "number" ||
		!Number.isInteger(version) ||
		version < 1
	) {
		return null;
	}
	return {
		version,
		at: validTime(source.updatedAt),
		author: source.lastAuthor ?? null,
		kind: source.lastKind ?? null,
	};
}

/**
 * A produced File is not on this clock: its versions belong to file
 * production, and it has no `artifact_versions` rows for the observed moment to
 * describe.
 */
function isFamilyVersioned(kind: string | null | undefined): boolean {
	return kind != null && kind !== "file";
}

function sameFields(
	source: {
		versionNumber?: number | null;
		updatedAt?: number | null;
		lastAuthor?: MomentAuthor | null;
		lastKind?: MomentKind | null;
	},
	moment: LatestMoment,
): boolean {
	return (
		source.versionNumber === moment.version &&
		(source.updatedAt ?? null) === moment.at &&
		(source.lastAuthor ?? null) === moment.author &&
		(source.lastKind ?? null) === moment.kind
	);
}

/**
 * A conversation-detail row (`ArtifactCardSummary`) carrying the current
 * moment: number, change time, author and kind. The same row when it already
 * does.
 */
export function withCurrentSummaryMoment<
	T extends {
		id: string;
		kind: string;
		versionNumber: number;
		updatedAt: number;
	},
>(row: T, observed: ObservedArtifactMoments): T {
	if (!isFamilyVersioned(row.kind)) return row;
	const current = currentArtifactMoment(
		observed,
		row.id,
		readLatestMoment(row as T & LatestMomentFields),
	);
	if (current === null || sameFields(row as T & LatestMomentFields, current)) {
		return row;
	}
	return {
		...row,
		versionNumber: current.version,
		updatedAt: current.at ?? row.updatedAt,
		lastAuthor: current.author,
		lastKind: current.kind,
	};
}

/**
 * An open panel item (a `DocumentWorkspaceItem`, which keeps the moment it had
 * when it was opened — and is saved across reloads with it) carrying the
 * current one. `currentById` is the page's live per-artifact moments.
 */
export function withCurrentItemMoment<
	T extends {
		artifactId?: string | null;
		kind?: string | null;
		versionNumber?: number | null;
		updatedAt?: number | null;
	},
>(item: T, currentById: ReadonlyMap<string, LatestMoment>): T {
	if (!item.artifactId || !isFamilyVersioned(item.kind)) return item;
	const current = currentById.get(item.artifactId);
	if (current === undefined) return item;
	const snapshot = readLatestMoment(item as T & LatestMomentFields);
	const next = currentArtifactMoment(
		{ [item.artifactId]: current },
		item.artifactId,
		snapshot,
	);
	if (next === null || sameFields(item as T & LatestMomentFields, next)) {
		return item;
	}
	return {
		...item,
		versionNumber: next.version,
		updatedAt: next.at ?? item.updatedAt,
		lastAuthor: next.author,
		lastKind: next.kind,
	};
}

/** The deleted ids with one more. The same list when it was already there. */
export function markArtifactDeleted(
	deleted: readonly string[],
	artifactId: string,
): readonly string[] {
	return deleted.includes(artifactId) ? deleted : [...deleted, artifactId];
}

/** What was heard about an artifact, dropped — the same object when nothing was heard. */
export function forgetObservedArtifact<
	T extends Readonly<Record<string, unknown>>,
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
