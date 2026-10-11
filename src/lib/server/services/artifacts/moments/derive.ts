/**
 * Version rows into moments: the pure half of History (ruling 76,
 * `docs/design/artifacts-versioning/versioning.md` §3 and §4). Nothing here
 * touches the database or the clock, so every fold rule, marker and status is
 * unit-testable on rows written out by hand; `../history.ts` is the thin
 * loader that reads a page of rows and hands them over.
 *
 * The rows arrive NEWEST FIRST and contiguous. Moments are formed by walking
 * them from the newest down, each deciding only from itself and its older
 * neighbour (plus a depth cap), which is what makes a page boundary harmless:
 * a page starts its moments from its newest `limit` rows and reads as deep as
 * a moment can reach, so a moment is never cut in two and the next page, which
 * starts at the row below the last moment, forms exactly the moments a single
 * long read would have.
 */
import type {
	ArtifactMoment,
	ArtifactMomentStep,
	MomentAuthor,
	MomentFold,
	MomentKind,
	MomentRef,
	MomentStatus,
} from "$lib/shared/artifacts/history";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import {
	type ClassifiedSummary,
	classifyVersionSummary,
} from "$lib/shared/artifacts/version-summaries";
import {
	ARTIFACT_ALFY_TURN_GAP_MS,
	ARTIFACT_ALFY_TURN_MAX_ROWS,
} from "../limits";
import {
	detailBetween,
	LARGE_DETAIL,
	type ParsedBody,
	parseBodyForDetail,
	type RowDetail,
} from "./detail";

/** A version row as History reads it. */
export interface HistoryRow {
	id: string;
	versionNumber: number;
	author: MomentAuthor;
	summary: string;
	/** Last save, ms since the epoch. */
	createdAt: number;
	/** A burst's first save, ms; null when unknown. */
	startedAt: number | null;
	label: string | null;
	bodyHash: string;
	/** The body, or null when it was skipped (too large) or not read. */
	body: string | null;
	/** The body is over the comparison cap: its moment says "Large change". */
	large: boolean;
}

/** A row seen without its body: enough to name it and to read what it says it is. */
export interface HistoryRowMeta {
	id: string;
	versionNumber: number;
	author: MomentAuthor;
	summary: string;
	createdAt: number;
}

export interface HistoryReview {
	/** The artifact has a review marker (Alfy has changed it since the marker existed). */
	hasMarker: boolean;
	/** The Alfy versions that still have something waiting for the reader. */
	waiting: ReadonlySet<number>;
}

/** What a row's comparison with its parent came to, kept so a page read twice parses once. */
export type DetailCache = Map<string, Pick<RowDetail, "detail" | "tick">>;

export interface DeriveMomentsInput {
	kind: ArtifactKind;
	/**
	 * Newest first, contiguous. Hold `limit` rows to start moments from plus the
	 * depth a moment can reach (`ARTIFACT_HISTORY_LOOKAHEAD_ROWS`) and the parent
	 * of the last: that is what makes every moment on the page whole.
	 */
	rows: readonly HistoryRow[];
	limit: number;
	/** The artifact's newest version, which may be above the page. */
	newest: { id: string; versionNumber: number; bodyHash: string };
	review: HistoryReview;
	/** Rows newer than the page, seen without bodies: the Undo, Redo and restore rows that say what became of a change. May repeat rows of the page. */
	newer: readonly HistoryRowMeta[];
	/** Rows the page names but does not hold (a restore's source, an undone change). */
	referenced: readonly HistoryRowMeta[];
	/** The Document's current tabs, for "in Budget". */
	tabs: readonly { id: string; title: string; startBlockId: string }[];
	/** Alfy's reply comment by the version it edited. */
	commentByVersion?: ReadonlyMap<number, string>;
	cache?: DetailCache;
}

export interface DerivedMoments {
	moments: ArtifactMoment[];
	older: boolean;
	nextBefore: number | null;
}

const RESTORED_HERE_MAX = 5;

interface RowInfo {
	row: HistoryRow;
	/** Position in `rows`: 0 is the newest. */
	index: number;
	cls: ClassifiedSummary;
}

interface Group {
	/** Indices into the rows, `from` the newest. */
	from: number;
	to: number;
	fold: MomentFold | null;
}

function refOf(meta: {
	id: string;
	versionNumber: number;
	createdAt: number;
}): MomentRef {
	return {
		versionId: meta.id,
		versionNumber: meta.versionNumber,
		at: meta.createdAt,
	};
}

/** An Alfy edit as it stands in a row: its own change to the artifact, not a first draft or a rebuild. */
function isAlfyEditKind(kind: MomentKind): boolean {
	return kind === "alfy_edit" || kind === "alfy_reply_edit";
}

/**
 * What an Undo can take back: an Alfy edit, or an App rebuilt by Alfy (whose
 * toast Undo is a restore that names the rebuild it reverses). An App has no
 * review, so the rebuild gets no status, only the Undo that took it back.
 */
function isUndoableKind(kind: MomentKind): boolean {
	return isAlfyEditKind(kind) || kind === "app_rebuilt";
}

export function deriveMoments(input: DeriveMomentsInput): DerivedMoments {
	const { rows } = input;
	if (rows.length === 0) return { moments: [], older: false, nextBefore: null };

	const infos: RowInfo[] = rows.map((row, index) => ({
		row,
		index,
		cls: classifyVersionSummary(row),
	}));

	const parsed = new Map<string, ParsedBody | null>();
	const parsedOf = (row: HistoryRow | undefined): ParsedBody | null => {
		if (!row || row.body === null || row.large) return null;
		const key = `${row.id}:${row.bodyHash}`;
		if (!parsed.has(key))
			parsed.set(key, parseBodyForDetail(input.kind, row.body));
		return parsed.get(key) ?? null;
	};

	/** Every row the page knows by number, with or without a body. */
	const metaByNumber = new Map<number, HistoryRowMeta>();
	for (const meta of [...input.referenced, ...input.newer]) {
		metaByNumber.set(meta.versionNumber, meta);
	}
	for (const { row } of infos) metaByNumber.set(row.versionNumber, row);

	/** Document: ids whose presence or hash differ between two rows; null when a body is missing. */
	const touchedBetween = (
		after: HistoryRow,
		before: HistoryRow | undefined,
	): Set<string> | null => {
		const a = parsedOf(after);
		const b = parsedOf(before);
		if (a?.kind !== "document" || b?.kind !== "document") return null;
		const was = new Map(b.blocks.map((block) => [block.id, block.hash]));
		const now = new Map(a.blocks.map((block) => [block.id, block.hash]));
		const touched = new Set<string>();
		for (const [id, hash] of now) if (was.get(id) !== hash) touched.add(id);
		for (const id of was.keys()) if (!now.has(id)) touched.add(id);
		return touched;
	};

	/**
	 * Does a numbered Undo or Redo act on that version? It names the Alfy version it
	 * acted on, or the run it took back (`fromVersion` to `version`, RV-V I-3: one
	 * press can take back several of Alfy's versions in a row).
	 */
	const covers = (cls: ClassifiedSummary, versionNumber: number): boolean =>
		cls.version !== null &&
		versionNumber <= cls.version &&
		versionNumber >= (cls.fromVersion ?? cls.version);

	/** Does this Undo take back that Alfy change? Exact for a numbered Undo, by the text for an older one. */
	const undoTargets = (undo: RowInfo, change: RowInfo): boolean => {
		if (!isUndoableKind(change.cls.kind) || change.row.author !== "alfy")
			return false;
		if (undo.cls.version !== null)
			return covers(undo.cls, change.row.versionNumber);
		const parent = infos[change.index + 1]?.row;
		if (input.kind === "canvas") {
			// A board's Undo writes the parent of Alfy's version back.
			return parent !== undefined && undo.row.bodyHash === parent.bodyHash;
		}
		if (input.kind === "document") {
			const undone = touchedBetween(undo.row, change.row);
			const changed = touchedBetween(change.row, parent);
			// Without both texts, adjacency has to do.
			if (undone === null || changed === null) return true;
			return undone.size > 0 && [...undone].every((id) => changed.has(id));
		}
		return true;
	};

	// An older Redo was an ordinary save: it is the Redo of the Undo before it
	// when its text is exactly the change that Undo took back.
	for (let i = 0; i + 2 < infos.length; i += 1) {
		const [redo, undo, change] = [infos[i], infos[i + 1], infos[i + 2]];
		if (
			redo.cls.kind === "user_edit" &&
			undo.cls.kind === "undo_alfy_change" &&
			undoTargets(undo, change) &&
			redo.row.bodyHash === change.row.bodyHash &&
			redo.row.bodyHash !== undo.row.bodyHash
		) {
			infos[i] = {
				...redo,
				cls: {
					kind: "redo_alfy_change",
					actor: "user",
					text: null,
					version: change.row.versionNumber,
				},
			};
		}
	}

	// An Undo that names ONE version but whose text is the text BELOW an unbroken run of
	// Alfy's versions took the whole run back: a board's Undo restores the version before
	// Alfy's whole run and an older client named only the newest (RV-V I-3). The text is
	// what was taken back, so such a row is read as naming the run, whoever wrote it. It
	// walks down from the named version through Alfy's rows only, and stops at the first
	// row whose text is the Undo's (the usual Undo of one change stops at once, unchanged).
	for (const undo of infos) {
		if (
			undo.cls.kind !== "undo_alfy_change" ||
			undo.cls.version === null ||
			undo.cls.fromVersion !== undefined
		) {
			continue;
		}
		const named = undo.cls.version;
		const top = infos.findIndex(
			(info) => info.index > undo.index && info.row.versionNumber === named,
		);
		if (top === -1) continue;
		for (let at = top; at + 1 < infos.length; at += 1) {
			const change = infos[at];
			if (change.row.author !== "alfy" || !isUndoableKind(change.cls.kind)) {
				break;
			}
			if (infos[at + 1].row.bodyHash !== undo.row.bodyHash) continue;
			if (change.row.versionNumber < named) {
				infos[undo.index] = {
					...undo,
					cls: { ...undo.cls, fromVersion: change.row.versionNumber },
				};
			}
			break;
		}
	}

	function growGroup(from: number): Group {
		const head = infos[from];
		const second = infos[from + 1];
		const third = infos[from + 2];
		if (
			head.cls.kind === "redo_alfy_change" &&
			second?.cls.kind === "undo_alfy_change" &&
			third &&
			head.cls.version === third.row.versionNumber &&
			undoTargets(second, third)
		) {
			return { from, to: from + 2, fold: "redone" };
		}
		if (
			head.cls.kind === "undo_alfy_change" &&
			second &&
			undoTargets(head, second)
		) {
			return { from, to: from + 1, fold: "undone" };
		}
		if (
			head.cls.kind === "undo_restore" &&
			second?.cls.kind === "restore" &&
			head.cls.version === second.row.versionNumber
		) {
			return { from, to: from + 1, fold: "restore_undone" };
		}
		if (head.cls.kind === "alfy_edit") {
			let to = from;
			while (to - from + 1 < ARTIFACT_ALFY_TURN_MAX_ROWS) {
				const older = infos[to + 1];
				if (!older || older.cls.kind !== "alfy_edit") break;
				const gap = infos[to].row.createdAt - older.row.createdAt;
				if (gap < 0 || gap >= ARTIFACT_ALFY_TURN_GAP_MS) break;
				to += 1;
			}
			if (to > from) return { from, to, fold: "alfy_turn" };
		}
		return { from, to: from, fold: null };
	}

	const groups: Group[] = [];
	for (let i = 0; i < infos.length && i < Math.max(1, input.limit); ) {
		const group = growGroup(i);
		groups.push(group);
		i = group.to + 1;
	}

	// ---- markers --------------------------------------------------------

	const { newest } = input;
	const isNewestRow = (row: { id: string }) => row.id === newest.id;
	const nearestOlderSame = (info: RowInfo): MomentRef | null => {
		for (let i = info.index + 1; i < infos.length; i += 1) {
			if (infos[i].row.bodyHash === info.row.bodyHash)
				return refOf(infos[i].row);
		}
		return null;
	};
	const sameAsNow = (row: HistoryRow) =>
		!isNewestRow(row) && row.bodyHash === newest.bodyHash;

	/** Every Undo, Redo and restore row the page knows of above `versionNumber`, classified. */
	const laterMarkers = (() => {
		const seen = new Map<
			number,
			{ meta: HistoryRowMeta; cls: ClassifiedSummary }
		>();
		// A row on the page is read as the page reads it (an Undo that named one version
		// and took a run back names the run); one off the page by its own words.
		const read = new Map(
			infos.map((info) => [info.row.versionNumber, info.cls]),
		);
		for (const meta of [...input.newer, ...infos.map((info) => info.row)]) {
			if (seen.has(meta.versionNumber)) continue;
			const cls = read.get(meta.versionNumber) ?? classifyVersionSummary(meta);
			if (
				cls.kind === "undo_alfy_change" ||
				cls.kind === "redo_alfy_change" ||
				cls.kind === "restore"
			) {
				seen.set(meta.versionNumber, { meta, cls });
			}
		}
		return [...seen.values()].sort(
			(a, b) => b.meta.versionNumber - a.meta.versionNumber,
		);
	})();

	const restoredHere = (versionNumber: number): MomentRef[] =>
		laterMarkers
			.filter(
				({ cls }) => cls.kind === "restore" && cls.version === versionNumber,
			)
			.slice(0, RESTORED_HERE_MAX)
			.map(({ meta }) => refOf(meta));

	// ---- review statuses ------------------------------------------------

	/** Document: how many of the blocks an Alfy version changed an Undo put back. */
	const coverage = (
		change: RowInfo,
		undo: HistoryRow,
	): "all" | "some" | "none" | "unknown" => {
		const parent = infos[change.index + 1]?.row;
		const a = parsedOf(change.row);
		const b = parsedOf(parent);
		const u = parsedOf(undo);
		if (
			a?.kind !== "document" ||
			b?.kind !== "document" ||
			u?.kind !== "document"
		) {
			return "unknown";
		}
		const was = new Map(b.blocks.map((block) => [block.id, block.hash]));
		const undone = new Map(u.blocks.map((block) => [block.id, block.hash]));
		const changed = a.blocks.filter(
			(block) => was.get(block.id) !== block.hash,
		);
		if (changed.length === 0) return "unknown";
		const putBack = changed.filter(
			(block) => undone.get(block.id) === was.get(block.id),
		);
		if (putBack.length === 0) return "none";
		return putBack.length === changed.length ? "all" : "some";
	};

	const statusOfChange = (
		change: RowInfo,
		folded: MomentFold | null,
		foldedUndo: HistoryRowMeta | null,
	): { status: MomentStatus | null; undoneBy: MomentRef | null } => {
		const v = change.row.versionNumber;
		if (input.review.waiting.has(v))
			return { status: "waiting", undoneBy: null };

		if (folded === "redone") return { status: "kept", undoneBy: null };

		let undo: HistoryRowMeta | null = foldedUndo;
		let redoneAfter = false;
		for (const { meta, cls } of laterMarkers) {
			if (meta.versionNumber <= v || !covers(cls, v)) continue;
			if (
				cls.kind === "undo_alfy_change" &&
				(undo === null || meta.versionNumber > undo.versionNumber)
			) {
				undo = meta;
			}
		}
		for (const { meta, cls } of laterMarkers) {
			if (
				cls.kind === "redo_alfy_change" &&
				covers(cls, v) &&
				undo !== null &&
				meta.versionNumber > undo.versionNumber
			) {
				redoneAfter = true;
			}
		}
		// A restore after the Undo to a version that has the change in it (the change
		// itself, or one between it and the Undo) brought the change back: it is not
		// "Undone" any more (RV-V M-4), and "Kept" would not be the reader's decision
		// either, so it says nothing.
		const undoNumber = undo?.versionNumber ?? 0;
		const restoredBack =
			undo !== null &&
			laterMarkers.some(
				({ meta, cls }) =>
					cls.kind === "restore" &&
					meta.versionNumber > undoNumber &&
					cls.version !== null &&
					cls.version >= v &&
					cls.version < undoNumber,
			);
		if (undo !== null && !redoneAfter && restoredBack) {
			return { status: null, undoneBy: null };
		}
		if (undo !== null && !redoneAfter) {
			const undoRow = infos.find((info) => info.row.id === undo.id)?.row;
			const covered =
				undoRow && input.kind === "document"
					? coverage(change, undoRow)
					: "all";
			if (covered === "some")
				return { status: "partly_kept", undoneBy: refOf(undo) };
			if (covered === "none") return { status: "kept", undoneBy: refOf(undo) };
			return { status: "undone", undoneBy: refOf(undo) };
		}

		// A version restored to a text from before this change took it with it.
		const restoredOver = laterMarkers.some(
			({ meta, cls }) =>
				cls.kind === "restore" &&
				meta.versionNumber > v &&
				cls.version !== null &&
				cls.version < v,
		);
		if (restoredOver) return { status: null, undoneBy: null };
		return { status: "kept", undoneBy: null };
	};

	const statusOfGroup = (
		group: Group,
		members: RowInfo[],
	): { status: MomentStatus | null; undoneBy: MomentRef | null } => {
		const head = members[members.length - 1]; // the oldest
		if (group.fold === "alfy_turn") {
			const each = members.map((member) => statusOfChange(member, null, null));
			const statuses = each.map((entry) => entry.status);
			const undoneBy = each.find((entry) => entry.undoneBy)?.undoneBy ?? null;
			if (statuses.includes("waiting"))
				return { status: "waiting", undoneBy: null };
			if (statuses.every((s) => s === null))
				return { status: null, undoneBy: null };
			if (statuses.every((s) => s === "undone"))
				return { status: "undone", undoneBy };
			if (statuses.some((s) => s === "undone" || s === "partly_kept")) {
				return { status: "partly_kept", undoneBy };
			}
			return { status: "kept", undoneBy: null };
		}
		if (head.cls.kind === "app_rebuilt" && head.row.author === "alfy") {
			// An App has no review: no status, but the Undo that took the rebuild back is a fact.
			const undo =
				group.fold === "undone" ? members[members.length - 2] : undefined;
			return { status: null, undoneBy: undo ? refOf(undo.row) : null };
		}
		if (!isAlfyEditKind(head.cls.kind) || head.row.author !== "alfy") {
			return { status: null, undoneBy: null };
		}
		const foldedUndo =
			group.fold === "undone"
				? (members[members.length - 2]?.row ?? null)
				: null;
		return statusOfChange(head, group.fold, foldedUndo);
	};

	// ---- moments --------------------------------------------------------

	const tabsKey = input.tabs
		.map((tab) => `${tab.id}|${tab.title}|${tab.startBlockId}`)
		.join(";");
	const cached = (
		key: string,
		compute: () => RowDetail,
	): Pick<RowDetail, "detail" | "tick"> => {
		const full = `${key}:${tabsKey}`;
		const hit = input.cache?.get(full);
		if (hit) return hit;
		const { detail, tick } = compute();
		const entry = { detail, tick };
		input.cache?.set(full, entry);
		return entry;
	};

	/** `row` measured against `parent` (null for a first version), without parsing anything it cannot. */
	const detailOf = (
		row: HistoryRow,
		parent: HistoryRow | undefined,
		key: string,
	): Pick<RowDetail, "detail" | "tick"> =>
		cached(key, () => {
			if (row.large || parent?.large) return LARGE_DETAIL;
			const after = parsedOf(row);
			if (!after)
				return { ...detailBetween(null, { kind: "other" }, input.tabs) };
			if (row.versionNumber > 1 && !parent)
				return detailBetween(null, { kind: "other" }, input.tabs);
			const before = parent ? parsedOf(parent) : null;
			if (parent && !before)
				return detailBetween(null, { kind: "other" }, input.tabs);
			return detailBetween(before, after, input.tabs);
		});

	const parentRow = (info: RowInfo) => infos[info.index + 1]?.row;
	const parentRefOf = (
		info: RowInfo,
	): { id: string | null; number: number | null } => {
		if (info.row.versionNumber <= 1) return { id: null, number: null };
		const known =
			parentRow(info) ?? metaByNumber.get(info.row.versionNumber - 1);
		return { id: known?.id ?? null, number: info.row.versionNumber - 1 };
	};

	const stepOf = (info: RowInfo, turn: boolean): ArtifactMomentStep => {
		const parent = parentRefOf(info);
		return {
			versionId: info.row.id,
			versionNumber: info.row.versionNumber,
			kind: info.cls.kind,
			author: info.cls.actor,
			at: info.row.createdAt,
			text: turn ? info.cls.text : null,
			label: info.row.label,
			isNewest: isNewestRow(info.row),
			sameAsNow: sameAsNow(info.row),
			sameAs: nearestOlderSame(info),
			parentVersionId: parent.id,
			parentVersionNumber: parent.number,
		};
	};

	const moments = groups.map((group): ArtifactMoment => {
		const members = infos.slice(group.from, group.to + 1); // newest first
		const turn = group.fold === "alfy_turn";
		const oldest = members[members.length - 1];
		const rep = turn ? members[0] : oldest;
		const folded = group.fold !== null;

		const detailKey = turn
			? `${rep.row.id}:${rep.row.bodyHash}:turn:${parentRow(oldest)?.bodyHash ?? "none"}`
			: `${rep.row.id}:${rep.row.bodyHash}`;
		const derived = detailOf(rep.row, parentRow(oldest), detailKey);

		const kind: MomentKind = turn
			? "alfy_turn"
			: rep.cls.kind === "user_edit" && derived.tick
				? "tick"
				: rep.cls.kind;
		const author: MomentAuthor = turn ? "alfy" : rep.cls.actor;
		const parent = parentRefOf(oldest);
		const { status, undoneBy } = statusOfGroup(group, members);

		// What an unfolded Undo or Redo acts on, with Alfy's own words.
		let target: ArtifactMoment["target"] = null;
		// (A press that acted on a run names no single change's words.)
		if (
			(rep.cls.kind === "undo_alfy_change" ||
				rep.cls.kind === "redo_alfy_change") &&
			rep.cls.version !== null &&
			rep.cls.fromVersion === undefined &&
			!folded
		) {
			const acted = metaByNumber.get(rep.cls.version);
			if (acted && acted.author === "alfy") {
				target = { ...refOf(acted), text: classifyVersionSummary(acted).text };
			}
		}

		let restoredFrom: MomentRef | null = null;
		if (rep.cls.kind === "restore" && rep.cls.version !== null) {
			const source = metaByNumber.get(rep.cls.version);
			restoredFrom = source ? refOf(source) : null;
		}

		return {
			versionId: rep.row.id,
			versionNumber: rep.row.versionNumber,
			parentVersionId: parent.id,
			parentVersionNumber: parent.number,
			kind,
			author,
			fold: group.fold,
			quiet: group.fold === "restore_undone",
			at: rep.row.createdAt,
			startedAt: rep.row.startedAt,
			label: rep.row.label,
			text: turn ? null : rep.cls.text,
			tick: derived.tick,
			target,
			restoredFrom,
			commentId:
				rep.cls.kind === "alfy_reply_edit"
					? (input.commentByVersion?.get(rep.row.versionNumber) ?? null)
					: null,
			detail: derived.detail,
			status,
			undoneBy,
			isNewest: isNewestRow(rep.row),
			containsNewest: members.some((member) => isNewestRow(member.row)),
			sameAsNow: sameAsNow(rep.row),
			sameAs: nearestOlderSame(rep),
			restoredHere: restoredHere(rep.row.versionNumber),
			bodyHash: rep.row.bodyHash,
			steps: folded
				? (turn ? [...members] : members.slice(0, -1))
						.reverse()
						.map((member) => stepOf(member, turn))
				: [],
		};
	});

	const last = groups[groups.length - 1];
	const lowest = infos[last.to].row.versionNumber;
	return {
		moments,
		older: lowest > 1,
		nextBefore: lowest > 1 ? lowest : null,
	};
}
