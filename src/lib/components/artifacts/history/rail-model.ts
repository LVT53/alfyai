/**
 * The rail's model, with no DOM and no Svelte (ruling 76, versioning.md §5.2,
 * §5.3): which options the History rail lists, in which day groups, which one
 * a key press selects next, and how a fresh first page folds into the pages the
 * reader has already loaded. Pure, so the keyboard model and the paging rules
 * are unit-tested without a browser.
 *
 * An OPTION is one thing a reader can select and preview: a moment, or a step
 * folded under one (an Undo under the Alfy change it undid). Each is a real
 * version; the rail is a single-select listbox over them, in time order,
 * newest first, grouped by the local day the moment's own row was saved on.
 */
import type {
	ArtifactMoment,
	ArtifactMomentStep,
	MomentAuthor,
	MomentKind,
	MomentRef,
} from "$lib/shared/artifacts/history";

/** One selectable thing in the rail: a moment or a step under it. */
export interface RailEntry {
	/** `m:<versionId>` for a moment, `s:<versionId>` for a step: unique even where a moment and its last step show the same version. */
	key: string;
	type: "moment" | "step";
	/** The moment this entry is (or sits under). */
	moment: ArtifactMoment;
	step: ArtifactMomentStep | null;
	/** The state the entry SHOWS, and what its changes are measured against. */
	versionId: string;
	versionNumber: number;
	parentVersionId: string | null;
	parentVersionNumber: number | null;
	kind: MomentKind;
	author: MomentAuthor;
	at: number;
	startedAt: number | null;
	label: string | null;
	/** Alfy's own words or an App's brief/prompt, as stored. */
	text: string | null;
	/** This entry's own row is the newest version: "This is how it looks now", nothing to restore. */
	isNewest: boolean;
	/** Its body equals the newest version's: "Same as now", nothing to restore. */
	sameAsNow: boolean;
	sameAs: MomentRef | null;
	/** A step drawn under its moment: its headline is the short one ("You undid it"). */
	folded: boolean;
}

/** The entries of one local day, newest first. */
export interface RailGroup {
	dayKey: string;
	/** The time of the group's first moment: what its heading is written from. */
	at: number;
	entries: RailEntry[];
}

export type RailFilter = "all" | "named";

/** The local calendar day a time falls on, `YYYY-MM-DD`: a group is a day a person remembers. */
export function dayKeyOf(at: number): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function momentEntry(moment: ArtifactMoment): RailEntry {
	return {
		key: `m:${moment.versionId}`,
		type: "moment",
		moment,
		step: null,
		versionId: moment.versionId,
		versionNumber: moment.versionNumber,
		parentVersionId: moment.parentVersionId,
		parentVersionNumber: moment.parentVersionNumber,
		kind: moment.kind,
		author: moment.author,
		at: moment.at,
		startedAt: moment.startedAt,
		label: moment.label,
		text: moment.text,
		isNewest: moment.isNewest,
		sameAsNow: moment.sameAsNow,
		sameAs: moment.sameAs,
		folded: false,
	};
}

export function stepEntry(
	moment: ArtifactMoment,
	step: ArtifactMomentStep,
): RailEntry {
	return {
		key: `s:${step.versionId}`,
		type: "step",
		moment,
		step,
		versionId: step.versionId,
		versionNumber: step.versionNumber,
		parentVersionId: step.parentVersionId,
		parentVersionNumber: step.parentVersionNumber,
		kind: step.kind,
		author: step.author,
		at: step.at,
		startedAt: null,
		label: step.label,
		text: step.text,
		isNewest: step.isNewest,
		sameAsNow: step.sameAsNow,
		sameAs: step.sameAs,
		folded: true,
	};
}

/**
 * The steps a moment draws under itself. A fold that starts with its own
 * first row (an Undo folded onto the Alfy change it undid) already shows that
 * row as the moment, so a step that restates the moment's own version is left
 * out, except in one turn of Alfy's edits, where the moment is the LAST edit's
 * state and every edit is a step of its own.
 */
export function visibleSteps(moment: ArtifactMoment): ArtifactMomentStep[] {
	if (moment.fold === "alfy_turn") return moment.steps;
	return moment.steps.filter((step) => step.versionId !== moment.versionId);
}

/** The moments as day groups of entries, newest first, optionally only what the reader named. */
export function buildRailGroups(
	moments: readonly ArtifactMoment[],
	filter: RailFilter = "all",
): RailGroup[] {
	const groups: RailGroup[] = [];
	for (const moment of moments) {
		const entries: RailEntry[] = [momentEntry(moment)];
		for (const step of visibleSteps(moment)) {
			entries.push(stepEntry(moment, step));
		}
		const kept =
			filter === "named" ? entries.filter((entry) => entry.label) : entries;
		if (kept.length === 0) continue;
		const dayKey = dayKeyOf(moment.at);
		const last = groups.at(-1);
		if (last && last.dayKey === dayKey) {
			last.entries.push(...kept);
		} else {
			groups.push({ dayKey, at: moment.at, entries: [...kept] });
		}
	}
	return groups;
}

/** Every entry in rail order: what the arrow keys walk. */
export function flattenRailGroups(groups: readonly RailGroup[]): RailEntry[] {
	return groups.flatMap((group) => group.entries);
}

export type RailKey =
	| "ArrowDown"
	| "ArrowUp"
	| "Home"
	| "End"
	| "PageDown"
	| "PageUp";

function groupIndexOf(groups: readonly RailGroup[], key: string): number {
	return groups.findIndex((group) =>
		group.entries.some((entry) => entry.key === key),
	);
}

/**
 * The key of the entry a navigation key moves the selection to (selection
 * follows focus). ↑/↓ step one entry, Home/End jump to the ends, and
 * PageUp/PageDown move a day: to the first entry of the previous or next group
 * (or, from the middle of a group, back to its own first entry). The ends stop:
 * the list does not wrap. `null` when there is nothing to select.
 */
export function nextRailKey(
	groups: readonly RailGroup[],
	currentKey: string | null,
	key: RailKey,
): string | null {
	const flat = flattenRailGroups(groups);
	if (flat.length === 0) return null;
	const index = currentKey
		? flat.findIndex((entry) => entry.key === currentKey)
		: -1;
	const here = index === -1 ? 0 : index;
	switch (key) {
		case "ArrowDown":
			return flat[Math.min(flat.length - 1, here + 1)].key;
		case "ArrowUp":
			return flat[Math.max(0, here - 1)].key;
		case "Home":
			return flat[0].key;
		case "End":
			return flat[flat.length - 1].key;
		case "PageDown": {
			const groupIndex = groupIndexOf(groups, flat[here].key);
			const next = groups[groupIndex + 1];
			return next ? next.entries[0].key : flat[flat.length - 1].key;
		}
		case "PageUp": {
			const groupIndex = groupIndexOf(groups, flat[here].key);
			const own = groups[groupIndex];
			if (own.entries[0].key !== flat[here].key) return own.entries[0].key;
			const previous = groups[groupIndex - 1];
			return (previous ?? own).entries[0].key;
		}
	}
}

/** The entry under a key, or `null`. */
export function findRailEntry(
	groups: readonly RailGroup[],
	key: string | null,
): RailEntry | null {
	if (!key) return null;
	for (const group of groups) {
		for (const entry of group.entries) {
			if (entry.key === key) return entry;
		}
	}
	return null;
}

/**
 * The selection after the list changed under it: the same key when it is still
 * there, else the newest entry. Opening History selects the newest moment, so
 * the reader's first look answers "what just happened?".
 */
export function reconcileSelection(
	groups: readonly RailGroup[],
	selectedKey: string | null,
): string | null {
	if (findRailEntry(groups, selectedKey)) return selectedKey;
	return groups[0]?.entries[0]?.key ?? null;
}

/** The oldest version number a moment holds in its rows. */
function oldestRow(moment: ArtifactMoment): number {
	let oldest = moment.versionNumber;
	for (const step of moment.steps) {
		if (step.versionNumber < oldest) oldest = step.versionNumber;
	}
	return oldest;
}

/** The newest version number a moment holds in its rows. */
export function newestRow(moment: ArtifactMoment): number {
	let newest = moment.versionNumber;
	for (const step of moment.steps) {
		if (step.versionNumber > newest) newest = step.versionNumber;
	}
	return newest;
}

/**
 * A fresh first page laid over the moments already loaded: the new page wins
 * wherever it reaches (a version written while History was open may have folded
 * onto the moment below it), and what the reader paged in beyond it stays. A
 * page never cuts a folded run in two, so keeping the older moments whose rows
 * are all older than the page's oldest row is exact.
 */
export function mergeFirstPage(
	fresh: readonly ArtifactMoment[],
	loaded: readonly ArtifactMoment[],
): ArtifactMoment[] {
	if (fresh.length === 0) return [...loaded];
	const floor = Math.min(...fresh.map(oldestRow));
	const kept = loaded.filter((moment) => newestRow(moment) < floor);
	return [...fresh, ...kept];
}
