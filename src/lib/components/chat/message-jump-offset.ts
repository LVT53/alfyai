// Where a jump to a message puts the reading area. Pure, so the rule is one
// function with a test rather than a few lines in each place that scrolls
// (`MessageArea.svelte`'s `scrollToMessage`, and the page's `focusMessage` for
// a search result or a link to one message).
//
// A jump used to centre the target: `targetTop - containerTop - (clientHeight -
// targetHeight) / 2`. In a reply taller than the reading area that is a negative
// number, so the browser stopped at the top of the list and the reader met the
// upper part of the answer; in a short reply it put the line in the middle of the
// view, which is not where a reader starts reading it. This puts the message's
// first line at the top of the reading area instead, a small fixed gap under its
// top edge, whatever the message's height.
//
// At the ends of the list the delta is allowed to be one the browser clamps: a
// negative one at the first message (the browser stops at the top) and one past
// the furthest position at the last (the browser stops at the end). The helper
// returns the aiming delta, not a scroll position, so the two callers keep the
// scrolling behaviour they had (smooth, or instant under reduced motion).

/** How far under the reading area's top edge a jumped-to message's first line sits. */
export const MESSAGE_JUMP_GAP_PX = 12;

/**
 * How far from the gap a landed jump may sit and still count as landed, in px.
 *
 * The first smooth scroll is aimed at a measured rect; on a loaded machine the
 * thread can grow above the message after it fired (markdown, late layout), so
 * the message comes to rest lower than aimed. The page measures once more at
 * rest and applies the remaining delta when it is larger than this. Two pixels
 * is what the end-to-end assertion asks, so nothing larger is left standing.
 */
export const MESSAGE_JUMP_TOLERANCE_PX = 2;

export interface MessageJumpOffsetInput {
	/** The target's top, from `getBoundingClientRect()`. */
	targetTop: number;
	/**
	 * The target's height, measured but deliberately not used: the first line
	 * leads whether the reply is taller or shorter than the reading area. It is
	 * part of the input because the rect the caller already has carries it, and
	 * because the test states both cases against the same signature.
	 */
	targetHeight: number;
	/** The reading area's top, from its own rect. */
	containerTop: number;
	/** The reading area's visible height (`clientHeight`), measured but not used; see `targetHeight`. */
	containerHeight: number;
	/** The small gap under the reading area's top edge; defaults to {@link MESSAGE_JUMP_GAP_PX}. */
	gap?: number;
}

/**
 * The scroll delta that puts `targetTop` at `containerTop + gap`.
 *
 * Negative when the message is above the reading area's top, larger than the
 * remaining scroll when it is near the end: the browser clamps both.
 */
export function jumpOffset(input: MessageJumpOffsetInput): number {
	const gap = input.gap ?? MESSAGE_JUMP_GAP_PX;
	return input.targetTop - input.containerTop - gap;
}

/**
 * What is left to scroll after a jump has come to rest, or null when the
 * message is already on the gap (within {@link MESSAGE_JUMP_TOLERANCE_PX}).
 *
 * A linked-message jump measures, scrolls smoothly and then waits for the
 * message to hold still. That wait is not a promise that nothing above it will
 * grow afterwards: a loaded main thread can render markdown or late layout after
 * the aim was taken (measured: a gate run landed 142 px short). So the page
 * measures once more at rest and hands the result to one more `scrollBy`; this
 * function is that second measurement's rule, and it is idempotent — applied
 * when it returns a number, the next call returns null. `null` means "stop"
 * (there is no third jump).
 */
export function remainingJumpOffset(
	input: MessageJumpOffsetInput & { tolerance?: number },
): number | null {
	const delta = jumpOffset(input);
	const tolerance = input.tolerance ?? MESSAGE_JUMP_TOLERANCE_PX;
	return Math.abs(delta) <= tolerance ? null : delta;
}
