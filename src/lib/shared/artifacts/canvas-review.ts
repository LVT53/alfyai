/**
 * What is still waiting for the reader on a board after Alfy changed it (Feature
 * 2 · Artifacts, Slice 3, ruling 63). Pure and browser-safe: the server reads a
 * board's versions and asks this (`services/artifacts/canvas-review.ts`), and
 * the browser only ever receives the answer.
 *
 * The rule is the Document's (ruling 61), applied to blocks: every version
 * newer than the reviewed marker is diffed against its parent
 * (`diffBoards`), each block belongs to the LAST version that touched it, and a
 * block whose last change was Alfy's, that is still on the board, is waiting.
 * The reader taking a block over (any later edit of it) is what clears it, just
 * as it is in a Document. A change that only took blocks away has nothing left
 * to point at, so it waits as a whole (`removedCount`) until it is kept or
 * undone.
 *
 * A change is reviewed as ONE change (ruling 63): Keep moves the marker past
 * it, Undo saves the version before it back as the reader's own. Undo is only
 * possible while Alfy's versions are the last thing that happened to the board;
 * a version of the reader's after them makes it a decision about their work too,
 * and History is the way back then.
 */
import { diffBoards } from "./board-diff";
import type { CanvasBody } from "./canvas";
import { emptyCanvasBody, normalizeCanvasBody } from "./canvas-body";

export interface CanvasReviewVersion {
	/** The version row's own id: what a client asks the versions route for. */
	id: string;
	versionNumber: number;
	author: "user" | "alfy" | "system";
	summary: string;
	body: string;
}

/** One Alfy version's part of what waits: the blocks it was the last to touch, and the ones it took away. */
export interface CanvasReviewChange {
	versionNumber: number;
	/** The version's own summary ("Planned Sunday"), as Alfy wrote it. */
	summary: string;
	touchedIds: string[];
	removedCount: number;
}

export type CanvasUndo =
	| {
			available: true;
			/** The version whose board Undo saves back: the last one before Alfy's run. */
			toVersion: number;
			/** Its row's id, so the client can read its body. */
			toVersionId: string;
	  }
	| {
			available: false;
			reason: "nothing_to_undo" | "user_edited" | "parent_missing";
	  };

export interface CanvasReviewState {
	/** Alfy's versions that still have something waiting, oldest first. */
	changes: CanvasReviewChange[];
	/** Every block waiting, in the board's own order: what the review bar steps through. */
	touchedIds: string[];
	/** Blocks Alfy took away that are still gone. */
	removedCount: number;
	/** The number the chat card, the list row and the count button show: the blocks waiting, or 1 for a change that only removed some. */
	count: number;
	/** The newest version of Alfy's: what Keep moves the marker to. 0 when there is none after the marker. */
	latestAlfyVersion: number;
	undo: CanvasUndo;
}

export const EMPTY_CANVAS_REVIEW: CanvasReviewState = {
	changes: [],
	touchedIds: [],
	removedCount: 0,
	count: 0,
	latestAlfyVersion: 0,
	undo: { available: false, reason: "nothing_to_undo" },
};

function readBoard(body: string | undefined): CanvasBody {
	if (body === undefined) return emptyCanvasBody();
	try {
		return normalizeCanvasBody(body.trim() ? JSON.parse(body) : {}).body;
	} catch {
		return emptyCanvasBody();
	}
}

/**
 * `versions` must hold the marker's own version (the parent of the first one
 * after it) and everything newer; older ones are never read. A version whose
 * body is not a board reads as an empty one, so a bad row cannot make the
 * review fail.
 */
export function computeCanvasReview(input: {
	throughVersion: number;
	versions: readonly CanvasReviewVersion[];
}): CanvasReviewState {
	const { throughVersion } = input;
	if (throughVersion <= 0 || input.versions.length === 0) {
		return EMPTY_CANVAS_REVIEW;
	}
	const byNumber = new Map(
		input.versions.map((version) => [version.versionNumber, version]),
	);
	const newer = input.versions
		.filter((version) => version.versionNumber > throughVersion)
		.sort((a, b) => a.versionNumber - b.versionNumber);
	if (newer.length === 0) return EMPTY_CANVAS_REVIEW;

	const boards = new Map<number, CanvasBody>();
	const boardOf = (versionNumber: number): CanvasBody => {
		let board = boards.get(versionNumber);
		if (!board) {
			board = readBoard(byNumber.get(versionNumber)?.body);
			boards.set(versionNumber, board);
		}
		return board;
	};

	const lastTouch = new Map<
		string,
		{ versionNumber: number; author: CanvasReviewVersion["author"] }
	>();
	const removed = new Map<
		string,
		{ versionNumber: number; author: CanvasReviewVersion["author"] }
	>();
	for (const version of newer) {
		const delta = diffBoards(
			boardOf(version.versionNumber - 1),
			boardOf(version.versionNumber),
		);
		for (const id of delta.touched) {
			lastTouch.set(id, {
				versionNumber: version.versionNumber,
				author: version.author,
			});
		}
		for (const id of delta.removedNodes) {
			removed.set(id, {
				versionNumber: version.versionNumber,
				author: version.author,
			});
		}
		// A block put back (by anyone) is not gone.
		for (const id of delta.addedNodes) removed.delete(id);
	}

	const latest = newer[newer.length - 1];
	const newestNodes = boardOf(latest.versionNumber).nodes;
	const present = new Set(newestNodes.map((node) => node.id));

	const touchedIds = newestNodes
		.map((node) => node.id)
		.filter((id) => lastTouch.get(id)?.author === "alfy");
	const gone = [...removed].filter(
		([id, by]) => by.author === "alfy" && !present.has(id),
	);

	const changesByVersion = new Map<number, CanvasReviewChange>();
	const changeFor = (versionNumber: number): CanvasReviewChange => {
		let change = changesByVersion.get(versionNumber);
		if (!change) {
			change = {
				versionNumber,
				summary: byNumber.get(versionNumber)?.summary ?? "",
				touchedIds: [],
				removedCount: 0,
			};
			changesByVersion.set(versionNumber, change);
		}
		return change;
	};
	for (const id of touchedIds) {
		const touch = lastTouch.get(id);
		if (touch) changeFor(touch.versionNumber).touchedIds.push(id);
	}
	for (const [, by] of gone) changeFor(by.versionNumber).removedCount += 1;
	const changes = [...changesByVersion.values()].sort(
		(a, b) => a.versionNumber - b.versionNumber,
	);

	const removedCount = gone.length;
	const count =
		touchedIds.length > 0 ? touchedIds.length : removedCount > 0 ? 1 : 0;
	const latestAlfyVersion = newer
		.filter((version) => version.author === "alfy")
		.reduce((most, version) => Math.max(most, version.versionNumber), 0);

	// Undo takes back what Alfy did since the reader last touched the board: the
	// unbroken run of Alfy's versions at the end of the history (never one the
	// reader already reviewed), to the version before it.
	let runStart = latest.versionNumber + 1;
	for (let index = newer.length - 1; index >= 0; index -= 1) {
		if (newer[index].author !== "alfy") break;
		runStart = newer[index].versionNumber;
	}
	let undo: CanvasUndo;
	if (count === 0) {
		undo = { available: false, reason: "nothing_to_undo" };
	} else if (runStart > latest.versionNumber) {
		undo = { available: false, reason: "user_edited" };
	} else {
		const before = byNumber.get(runStart - 1);
		undo = before
			? {
					available: true,
					toVersion: before.versionNumber,
					toVersionId: before.id,
				}
			: { available: false, reason: "parent_missing" };
	}

	return {
		changes,
		touchedIds,
		removedCount,
		count,
		latestAlfyVersion,
		undo,
	};
}
