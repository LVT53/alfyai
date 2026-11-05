// Where the view of the thread goes when it goes to the end of it. Pure, so that the
// rule is one function with a test and not a few lines in each of the places that scroll
// (`MessageArea.svelte`: the jump to the latest message, the hold while the thread
// settles, the follow and its glide).
//
// The end is the bottom. The exception is a question that waits: when the last row draws
// its card and the card, with what is drawn under it, does not fit in the view, the end is
// the top of the card. At the bottom of such a thread the reader would meet the rows under
// the card (Sources, the mark) and find the question and the X above the top edge. When
// everything fits, nothing changes: the bottom stays the target.

/** How far under the top edge of the view the top of a waiting card is put. */
export const THREAD_END_CARD_INSET_PX = 8;

/**
 * The scroll position of the end of the thread.
 *
 * - `bottom`: where the caller aims when no question waits, in its own count (a jump writes
 *   the full height and the browser stops at the furthest position; a glide aims at the
 *   furthest position itself). It is handed back as it is whenever the bottom is the end.
 * - `maxScrollTop`: the furthest position the view can scroll to (the height of the thread
 *   less the height of the view).
 * - `waitingCardTop`: the top of the card the last row draws for a question that waits, as
 *   an offset from the top of the thread's content; null when the last row draws none.
 */
export function threadEndScrollTop(p: {
	bottom: number;
	maxScrollTop: number;
	waitingCardTop: number | null;
}): number {
	if (p.waitingCardTop === null) return p.bottom;
	const cardTop = Math.max(0, p.waitingCardTop - THREAD_END_CARD_INSET_PX);
	// At the bottom the card's top is at `waitingCardTop - maxScrollTop` in the view: it
	// fits while that is not above the inset line.
	return cardTop < p.maxScrollTop ? cardTop : p.bottom;
}

/**
 * How far down a transform draws an element from where it is laid out, in px: the vertical
 * translation of the matrix that `getComputedStyle(element).transform` gives (`matrix(a, b,
 * c, d, tx, ty)`, or `matrix3d(...)`), and 0 for `none` or anything it cannot read.
 *
 * A card that is moving in (its entrance is a transform) is drawn lower than it rests, and
 * `getBoundingClientRect` reports where it is drawn. Nothing aims the thread again when the
 * card has landed (its size never changes, and a resize is what aims it), so the aim has to
 * be taken at where the card rests: its drawn top less this.
 */
export function transformShiftYPx(
	transform: string | null | undefined,
): number {
	const parts = /^matrix(3d)?\(([^)]*)\)$/.exec(transform?.trim() ?? "");
	if (!parts) return 0;
	const values = parts[2].split(",").map((value) => Number.parseFloat(value));
	// ty is the 6th value of a 2D matrix and the 14th (m42) of a 3D one.
	const shift = values[parts[1] ? 13 : 5];
	return Number.isFinite(shift) ? shift : 0;
}
