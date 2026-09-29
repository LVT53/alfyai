/**
 * What the comment margin knows about a document's threads, as plain
 * functions (Feature 2 · Artifacts, the Document's comment margin after the
 * owner's walk-through): where each thread's words are now, which order the
 * list reads in, which tab a thread belongs to, and which thread the reader's
 * scroll position points at. Pure and DOM-free on purpose — `DocumentBody.svelte`
 * measures the live text and hands the numbers in; `MarginPanel.svelte`
 * renders whatever this decides. It replaces `margin-layout.ts`, which
 * placed each card at its anchor's height: the rail is a plain, evenly spaced
 * list now, kept in view beside the text instead of scrolling away with it.
 *
 * "Which tab" has ONE rule here, the one the tab strip's own badges use (the
 * block a thread was made on, `mapBlocksToTabs`), so a count in the rail and
 * the badge on the tab can never disagree — including for a thread whose
 * words were edited away (orphaned) but whose block still sits in the tab.
 */
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import { resolveTextAnchor } from "$lib/shared/artifact-document/anchor";
import {
	type DocumentBlock,
	mapBlocksToTabs,
} from "$lib/shared/artifact-document/blocks";
import {
	type AnchorResolution,
	ORPHANED_ANCHOR_RESOLUTION,
} from "$lib/shared/artifacts/anchor";

/**
 * One resolved thread anchor, in the shape the live decoration
 * (`extensions.ts`'s `CommentAnchorTarget`) takes. Declared here rather than
 * imported because that module pulls Tiptap in, and this file must stay
 * loadable without the lazy editor chunk.
 */
export interface CommentAnchorTarget {
	commentId: string;
	blockId: string;
	from: number;
	to: number;
	resolved: boolean;
}

export interface TabCommentCounts {
	open: number;
	resolved: number;
}

export interface OtherTabRow extends TabCommentCounts {
	tab: DocumentTab;
}

export interface TabThreadGroup {
	/** `null` for a document with a single section: one group, no heading. */
	tab: DocumentTab | null;
	comments: ArtifactComment[];
}

/** Where a thread's words sit in the viewport right now — measured by the caller. */
export interface AnchorBox {
	commentId: string;
	top: number;
	bottom: number;
}

/** A highlight whose last line is within this many pixels of the top edge has effectively scrolled past. */
export const FOLLOW_TOP_SLOP_PX = 4;

const AFTER_EVERY_BLOCK = Number.MAX_SAFE_INTEGER;

function resolutionFor(
	comment: ArtifactComment,
	blocks: DocumentBlock[],
): AnchorResolution {
	if (!comment.anchor || comment.anchor.kind !== "text") {
		return ORPHANED_ANCHOR_RESOLUTION;
	}
	return resolveTextAnchor(comment.anchor, blocks);
}

/** Every thread's own anchor resolution, computed once per edit — never a null or malformed anchor left out (it is an orphan, T10.9). */
export function resolveCommentAnchors(
	comments: ArtifactComment[],
	blocks: DocumentBlock[],
): Map<string, AnchorResolution> {
	const resolutions = new Map<string, AnchorResolution>();
	for (const comment of comments) {
		resolutions.set(comment.id, resolutionFor(comment, blocks));
	}
	return resolutions;
}

/** The threads whose words can still be found, as the editor's highlight decoration wants them. */
export function commentAnchorTargets(
	comments: ArtifactComment[],
	resolutions: Map<string, AnchorResolution>,
): CommentAnchorTarget[] {
	const targets: CommentAnchorTarget[] = [];
	for (const comment of comments) {
		const resolution = resolutions.get(comment.id);
		if (!resolution || resolution.blockId === null) continue;
		targets.push({
			commentId: comment.id,
			blockId: resolution.blockId,
			from: resolution.from,
			to: resolution.to,
			resolved: comment.status === "resolved",
		});
	}
	return targets;
}

/**
 * The tab a thread belongs to: the block it was made on (what the tab
 * badges count), falling back to the block its words are in now when that
 * one is gone. `null` for a document without tabs, or a thread with neither.
 */
export function tabIdForComment(
	comment: ArtifactComment,
	resolution: AnchorResolution | undefined,
	blockIdToTabId: Map<string, string>,
): string | null {
	if (comment.anchor?.kind === "text") {
		const own = blockIdToTabId.get(comment.anchor.blockId);
		if (own !== undefined) return own;
	}
	if (resolution && resolution.blockId !== null) {
		return blockIdToTabId.get(resolution.blockId) ?? null;
	}
	return null;
}

function compareNumbers(a: number, b: number): number {
	return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Document order — where the words are, not when the comment was written:
 * placed threads by block then by offset inside it, then (only on a tie)
 * oldest first. Threads with no place come last, ordered by the block they
 * once sat in, so a group of them still reads top to bottom.
 */
export function orderCommentsByPosition(
	comments: ArtifactComment[],
	resolutions: Map<string, AnchorResolution>,
	blocks: DocumentBlock[],
): ArtifactComment[] {
	const indexByBlockId = new Map(
		blocks.map((block, index) => [block.id, index] as const),
	);
	function sortKey(comment: ArtifactComment) {
		const resolution = resolutions.get(comment.id);
		if (resolution && resolution.blockId !== null) {
			return {
				placed: 0,
				block: indexByBlockId.get(resolution.blockId) ?? AFTER_EVERY_BLOCK,
				from: resolution.from,
			};
		}
		const ownBlock =
			comment.anchor?.kind === "text"
				? indexByBlockId.get(comment.anchor.blockId)
				: undefined;
		return { placed: 1, block: ownBlock ?? AFTER_EVERY_BLOCK, from: 0 };
	}
	return comments
		.map((comment) => ({ comment, key: sortKey(comment) }))
		.sort(
			(a, b) =>
				compareNumbers(a.key.placed, b.key.placed) ||
				compareNumbers(a.key.block, b.key.block) ||
				compareNumbers(a.key.from, b.key.from) ||
				compareNumbers(a.comment.createdAt, b.comment.createdAt) ||
				(a.comment.id < b.comment.id
					? -1
					: a.comment.id > b.comment.id
						? 1
						: 0),
		)
		.map((entry) => entry.comment);
}

/**
 * How many open and resolved threads each tab holds, counted by the block a
 * thread was made on — the number on the tab's badge is this `open`. Empty
 * for a document with one section: there is nothing to tell apart.
 */
export function countCommentsByTab(
	comments: ArtifactComment[],
	blocks: DocumentBlock[],
	tabs: DocumentTab[],
): Map<string, TabCommentCounts> {
	const counts = new Map<string, TabCommentCounts>();
	const blockIdToTabId = mapBlocksToTabs(blocks, tabs);
	if (blockIdToTabId.size === 0) return counts;
	for (const comment of comments) {
		if (!comment.anchor || comment.anchor.kind !== "text") continue;
		const tabId = blockIdToTabId.get(comment.anchor.blockId);
		if (!tabId) continue;
		const entry = counts.get(tabId) ?? { open: 0, resolved: 0 };
		if (comment.status === "resolved") entry.resolved += 1;
		else entry.open += 1;
		counts.set(tabId, entry);
	}
	return counts;
}

/** "In other tabs": one row per other tab that has any comment, in tab order. Never a row of zeros. */
export function otherTabRows(
	comments: ArtifactComment[],
	blocks: DocumentBlock[],
	tabs: DocumentTab[],
	activeTabId: string,
): OtherTabRow[] {
	const counts = countCommentsByTab(comments, blocks, tabs);
	const rows: OtherTabRow[] = [];
	for (const tab of tabs) {
		if (tab.id === activeTabId) continue;
		const own = counts.get(tab.id);
		if (!own || own.open + own.resolved === 0) continue;
		rows.push({ tab, open: own.open, resolved: own.resolved });
	}
	return rows;
}

/**
 * The threads that still have a place, grouped by tab (in tab order, empty
 * tabs left out) and in document order inside each group — the phone
 * sheet's and the narrow drawer's list. A document with one section gives
 * one group with no tab.
 */
export function groupResolvableByTab(
	comments: ArtifactComment[],
	resolutions: Map<string, AnchorResolution>,
	blocks: DocumentBlock[],
	tabs: DocumentTab[],
): TabThreadGroup[] {
	const placed = comments.filter(
		(comment) => resolutions.get(comment.id)?.blockId != null,
	);
	const ordered = orderCommentsByPosition(placed, resolutions, blocks);
	const blockIdToTabId = mapBlocksToTabs(blocks, tabs);
	if (blockIdToTabId.size === 0) {
		return ordered.length > 0 ? [{ tab: null, comments: ordered }] : [];
	}
	const groups: TabThreadGroup[] = [];
	for (const tab of tabs) {
		const own = ordered.filter(
			(comment) =>
				tabIdForComment(
					comment,
					resolutions.get(comment.id),
					blockIdToTabId,
				) === tab.id,
		);
		if (own.length > 0) groups.push({ tab, comments: own });
	}
	return groups;
}

/**
 * The thread whose words are nearest the top of the reading area: of the
 * highlights still readable in `viewport`, the one that starts highest (one
 * that began above the edge counts from the edge). `boxes` is in document
 * order, which breaks a tie. `null` when no highlight is in view.
 */
export function pickFollowedComment(
	boxes: AnchorBox[],
	viewport: { top: number; bottom: number },
): string | null {
	let best: { commentId: string; key: number } | null = null;
	for (const box of boxes) {
		if (box.bottom - box.top <= 0) continue;
		if (box.bottom <= viewport.top + FOLLOW_TOP_SLOP_PX) continue;
		if (box.top >= viewport.bottom) continue;
		const key = Math.max(box.top, viewport.top);
		if (best === null || key < best.key) {
			best = { commentId: box.commentId, key };
		}
	}
	return best?.commentId ?? null;
}
