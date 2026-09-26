/**
 * The comment margin's placement math (Feature 2 · Artifacts, Slice 1, T10
 * follow-up): "the margin shows it against the right block," never two
 * threads overlapping. Pure and DOM-free on purpose — `MarginPanel.svelte`
 * is the one caller that measures the live document (each anchored block's
 * screen position, each thread's own rendered height) and hands the numbers
 * in; this module only decides where each thread ends up once it has them,
 * which is what makes the placement rule itself testable without a browser.
 *
 * The rule, in one pass: sort by DOCUMENT order (never by the raw measured
 * `anchorTop`, which is a noisy read of the live DOM and not the ground
 * truth for reading order), then walk the list once, giving each thread its
 * own desired top UNLESS that would land it before the previous thread's
 * bottom (plus a small gap) — in that case it is pushed down to right after
 * it. A thread with no anchor position (`anchorTop: null` — an orphan, or a
 * malformed/unresolvable anchor) never gets a `top` at all; it is reported
 * in `orphanedIds` instead, for the caller's separate, clearly-labelled
 * group, ordered the same way (document order) rather than left in whatever
 * order the caller's own array happened to list comments in.
 */

export interface MarginThreadInput {
	/** The comment (thread) id — must be unique within one call. */
	id: string;
	/**
	 * The anchored block's measured top, in pixels, within the margin's own
	 * coordinate space (whatever the caller measures against — see
	 * `MarginPanel.svelte`'s own comment). `null` when this thread has
	 * nothing to sync to: an orphaned anchor, or one that failed to resolve
	 * to a block at all. A `null` thread is never placed; it always ends up
	 * in `orphanedIds`.
	 */
	anchorTop: number | null;
	/** This thread's own rendered height in pixels, measured by the caller. */
	height: number;
	/**
	 * This thread's position in DOCUMENT order (typically the anchored
	 * block's index within the document) — the one signal this function
	 * trusts for STACKING sequence. Two threads may share an order value
	 * (more than one comment on the same block); ties keep the caller's own
	 * relative order (a stable sort).
	 */
	order: number;
}

export interface MarginThreadPlacement {
	id: string;
	/** The final top, in the same coordinate space as `anchorTop`. */
	top: number;
}

export interface MarginLayoutResult {
	/** Position-synced threads, already in ascending `top` order. */
	placed: MarginThreadPlacement[];
	/** Ids of threads with no anchor position, in document order. */
	orphanedIds: string[];
}

/** Minimum breathing room between two stacked threads' boxes, in pixels. */
export const MARGIN_THREAD_GAP_PX = 8;

/**
 * Computes each anchored thread's final `top`, and separates out the ones
 * with nowhere to point at. Never mutates `threads`; the same input always
 * produces the same output (no `Date.now()`, no randomness, no reliance on
 * anything outside the argument).
 */
export function layoutMarginThreads(
	threads: MarginThreadInput[],
): MarginLayoutResult {
	// A stable sort by `order` alone: `Array.prototype.sort` is spec-guaranteed
	// stable since ES2019 (the engines this app targets), so two threads
	// sharing an `order` keep the caller's own relative order rather than an
	// arbitrary one.
	const byDocumentOrder = [...threads].sort((a, b) => a.order - b.order);

	const orphanedIds: string[] = [];
	const placed: MarginThreadPlacement[] = [];
	let cursor = 0;

	for (const thread of byDocumentOrder) {
		if (thread.anchorTop === null) {
			orphanedIds.push(thread.id);
			continue;
		}
		const top = Math.max(thread.anchorTop, cursor);
		placed.push({ id: thread.id, top });
		cursor = top + thread.height + MARGIN_THREAD_GAP_PX;
	}

	return { placed, orphanedIds };
}
