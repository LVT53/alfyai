/**
 * What changed between a version and its parent, as facts (versioning.md §4.2).
 * Pure: the caller hands over the two bodies, nothing here reads the database.
 *
 * A Document is compared block by block (`parseDocument`: block ids and
 * hashes), a Canvas by `diffBoards` (the same comparison the review landing
 * draws from) and an App by lines. The result is data (`MomentDetail`): the
 * browser words it, so one set of strings serves both authors in both
 * languages. A body the caller calls too large is never parsed.
 */
import {
	type DocumentBlock,
	inlinePlainText,
	mapBlocksToTabs,
	parseDocument,
	stripEmptyTabAnchorPlaceholder,
} from "$lib/shared/artifact-document/blocks";
import { diffBoards, isEmptyDelta } from "$lib/shared/artifacts/board-diff";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import {
	emptyCanvasBody,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import type {
	MomentDetail,
	MomentDetailBucket,
} from "$lib/shared/artifacts/history";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { diffLineCounts } from "./line-diff";

/** A label in a detail line is a few words, not a paragraph. */
const LABEL_MAX_CHARS = 60;

type TabLike = { id: string; title: string; startBlockId: string };

/** A body read once, in the form its kind compares. */
export type ParsedBody =
	| { kind: "document"; blocks: DocumentBlock[] }
	| { kind: "canvas"; board: CanvasBody }
	| { kind: "app"; source: string }
	| { kind: "other" };

export interface RowDetail {
	detail: MomentDetail;
	/** A Document row whose only change is one task's checked state. */
	tick: { text: string; checked: boolean } | null;
	/** Document: the ids of blocks present in the row that are new or differ from its parent. */
	changedBlockIds: string[];
	/** Document: id → hash of every block of the row (the review statuses compare these). */
	blockIndex: Record<string, string> | null;
}

const NONE: RowDetail = {
	detail: { type: "none" },
	tick: null,
	changedBlockIds: [],
	blockIndex: null,
};

export function parseBodyForDetail(
	kind: ArtifactKind,
	body: string,
): ParsedBody {
	try {
		if (kind === "document") {
			return {
				kind,
				blocks: parseDocument(body, { mint: false }).blocks.filter(
					(block) => block.id !== "",
				),
			};
		}
		if (kind === "canvas") {
			return { kind, board: readBoard(body) };
		}
		if (kind === "app") return { kind, source: body };
	} catch {
		// A body that does not parse says nothing rather than failing the history.
	}
	return { kind: "other" };
}

function readBoard(body: string): CanvasBody {
	try {
		return normalizeCanvasBody(body.trim() ? JSON.parse(body) : {}).body;
	} catch {
		return emptyCanvasBody();
	}
}

function label(text: string | null | undefined): string | null {
	if (!text) return null;
	const clean = stripEmptyTabAnchorPlaceholder(text)
		.replace(/\s+/g, " ")
		.trim();
	if (clean === "") return null;
	const chars = Array.from(clean);
	return chars.length > LABEL_MAX_CHARS
		? `${chars.slice(0, LABEL_MAX_CHARS - 1).join("")}…`
		: clean;
}

function bucket(labels: Array<string | null>): MomentDetailBucket {
	return { count: labels.length, first: labels[0] ?? null };
}

/** The words a board block carries, whatever its kind: its text, else its label, else its title. */
function nodeLabel(node: CanvasNode | undefined): string | null {
	const data = node?.data as Record<string, unknown> | undefined;
	if (!data) return null;
	for (const key of ["text", "label", "title"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim() !== "") return label(value);
	}
	return null;
}

const TASK_BOX = /^(\s*[-*+]\s+)\[([ xX])\]/;

/** One task line's checked state flipped, nothing else about the block different. */
function detectTick(
	before: DocumentBlock,
	after: DocumentBlock,
): { text: string; checked: boolean } | null {
	if (before.kind !== "taskList" || after.kind !== "taskList") return null;
	const was = before.markdown.split("\n");
	const now = after.markdown.split("\n");
	if (was.length !== now.length) return null;
	let flipped: { text: string; checked: boolean } | null = null;
	for (let index = 0; index < was.length; index += 1) {
		if (was[index] === now[index]) continue;
		const wasBox = TASK_BOX.exec(was[index]);
		const nowBox = TASK_BOX.exec(now[index]);
		if (!wasBox || !nowBox) return null;
		const wasRest = was[index].slice(wasBox[0].length);
		const nowRest = now[index].slice(nowBox[0].length);
		if (wasBox[1] !== nowBox[1] || wasRest !== nowRest) return null;
		if (flipped) return null; // two items: not one tick
		flipped = {
			text: inlinePlainText(nowRest).replace(/\s+/g, " ").trim(),
			checked: nowBox[2].toLowerCase() === "x",
		};
	}
	return flipped;
}

function documentDetail(
	before: Extract<ParsedBody, { kind: "document" }> | null,
	after: Extract<ParsedBody, { kind: "document" }>,
	tabs: readonly TabLike[],
): RowDetail {
	const blockIndex: Record<string, string> = {};
	for (const block of after.blocks) blockIndex[block.id] = block.hash;
	if (!before) return { ...NONE, blockIndex };

	const parentById = new Map(before.blocks.map((block) => [block.id, block]));
	const afterIds = new Set(after.blocks.map((block) => block.id));

	const added = after.blocks.filter((block) => !parentById.has(block.id));
	const changed = after.blocks.filter((block) => {
		const was = parentById.get(block.id);
		return was !== undefined && was.hash !== block.hash;
	});
	const removed = before.blocks.filter((block) => !afterIds.has(block.id));
	const changedBlockIds = [...added, ...changed].map((block) => block.id);

	if (added.length + changed.length + removed.length === 0) {
		return { ...NONE, blockIndex };
	}

	let tick: RowDetail["tick"] = null;
	if (added.length === 0 && removed.length === 0 && changed.length === 1) {
		const was = parentById.get(changed[0].id);
		tick = was ? detectTick(was, changed[0]) : null;
	}

	// The tab of the first block the change touched in the new text (the
	// current tab strip: tabs live on the artifact row, latest only), named only
	// when it is not the first tab.
	let tab: string | null = null;
	const tabOfBlock = mapBlocksToTabs(after.blocks, [...tabs]);
	const touched = after.blocks.find((block) =>
		changedBlockIds.includes(block.id),
	);
	if (touched && tabs.length > 1) {
		const tabId = tabOfBlock.get(touched.id);
		if (tabId && tabId !== tabs[0].id) {
			tab = label(tabs.find((candidate) => candidate.id === tabId)?.title);
		}
	}

	return {
		detail: {
			type: "document",
			changed: bucket(changed.map((block) => label(block.label))),
			added: bucket(added.map((block) => label(block.label))),
			removed: bucket(removed.map((block) => label(block.label))),
			tab,
		},
		tick,
		changedBlockIds,
		blockIndex,
	};
}

function canvasDetail(
	before: Extract<ParsedBody, { kind: "canvas" }> | null,
	after: Extract<ParsedBody, { kind: "canvas" }>,
): RowDetail {
	if (!before) return NONE;
	const delta = diffBoards(before.board, after.board);
	if (isEmptyDelta(delta)) return NONE;
	const beforeNodes = new Map(
		before.board.nodes.map((node) => [node.id, node]),
	);
	const afterNodes = new Map(after.board.nodes.map((node) => [node.id, node]));
	return {
		...NONE,
		detail: {
			type: "canvas",
			blocksAdded: bucket(
				delta.addedNodes.map((id) => nodeLabel(afterNodes.get(id))),
			),
			blocksChanged: bucket(
				delta.changedNodes.map((id) => nodeLabel(afterNodes.get(id))),
			),
			blocksRemoved: bucket(
				delta.removedNodes.map((id) => nodeLabel(beforeNodes.get(id))),
			),
			blocksMoved: delta.movedNodes.length,
			blocksReparented: delta.reparentedNodes.length,
			arrowsAdded: delta.addedEdges.length,
			arrowsChanged: delta.changedEdges.length,
			arrowsRemoved: delta.removedEdges.length,
		},
	};
}

function appDetail(
	before: Extract<ParsedBody, { kind: "app" }> | null,
	after: Extract<ParsedBody, { kind: "app" }>,
): RowDetail {
	if (!before) return NONE;
	const { added, removed } = diffLineCounts(before.source, after.source);
	if (added === 0 && removed === 0) return NONE;
	return {
		...NONE,
		detail: { type: "app", linesAdded: added, linesRemoved: removed },
	};
}

/** The facts of `after` measured against `before` (`null` for a first version). */
export function detailBetween(
	before: ParsedBody | null,
	after: ParsedBody,
	tabs: readonly TabLike[],
): RowDetail {
	if (after.kind === "document") {
		return documentDetail(
			before?.kind === "document" ? before : null,
			after,
			tabs,
		);
	}
	if (after.kind === "canvas") {
		return canvasDetail(before?.kind === "canvas" ? before : null, after);
	}
	if (after.kind === "app") {
		return appDetail(before?.kind === "app" ? before : null, after);
	}
	return NONE;
}

/** A body too large to compare: the detail line says so and nothing is parsed. */
export const LARGE_DETAIL: RowDetail = {
	...NONE,
	detail: { type: "large" },
};

/** Convenience for one pair of bodies: parse both, compare. */
export function deriveRowDetail(input: {
	kind: ArtifactKind;
	before: string | null;
	after: string;
	large?: boolean;
	tabs: readonly TabLike[];
}): RowDetail {
	if (input.large) return LARGE_DETAIL;
	return detailBetween(
		input.before === null ? null : parseBodyForDetail(input.kind, input.before),
		parseBodyForDetail(input.kind, input.after),
		input.tabs,
	);
}
