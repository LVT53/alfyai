/**
 * The versions strip's own scrolling (final review B-I5): which way it hides
 * frames, and where to scroll so a frame is whole. Pure numbers, read from the
 * strip's layout by `VersionStrip.svelte`.
 */

/** Which edges of a scrolling row hide something (each one wears a fade). */
export function overflowEdges(view: {
	scrollLeft: number;
	clientWidth: number;
	scrollWidth: number;
}): { start: boolean; end: boolean } {
	return {
		start: view.scrollLeft > 1,
		end: view.scrollLeft + view.clientWidth < view.scrollWidth - 1,
	};
}

/**
 * The scroll position that shows a frame whole, moving as little as it can
 * (`inline: "nearest"`): unchanged when it is already in view. `frame.left` is
 * measured from the start of the row's content, not of what shows.
 */
export function scrollLeftToShow(
	frame: { left: number; width: number },
	view: { scrollLeft: number; clientWidth: number },
): number {
	if (frame.left < view.scrollLeft) return frame.left;
	const right = frame.left + frame.width;
	if (right > view.scrollLeft + view.clientWidth) {
		return right - view.clientWidth;
	}
	return view.scrollLeft;
}
