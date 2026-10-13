/**
 * A popup that is painted in <body> and has to stay beside the control that
 * opened it.
 *
 * The composer's popups that open from a small control (the outline list
 * beside an attachment, the context ring's numbers) are `position: fixed` and
 * moved to <body> (`portalToBody`), because a fixed box is only the window's
 * while no ancestor has a transform and the home page centres its composer with
 * one. In <body> a popup is no longer next to its control in any CSS sense, so
 * where it stands is decided here, from two measurements only a browser can
 * make (the control's rectangle, the popup's own size) and the composer's own
 * arithmetic (`computeMenuPlacement`): above the control when the popup fits
 * there, below it when it does not and there is more room, never outside the
 * window.
 *
 * The control can move with no event at all: the home page's composer glides to
 * its place for 420ms after a resize, a pill grows when another file finishes
 * its read, a banner arrives above the composer. So while the popup is open the
 * control is looked at once a frame (one rectangle read; a resize and a scroll
 * are covered by the same look), and the popup's own size is watched too.
 */
import {
	computeMenuPlacement,
	MENU_GAP,
	MENU_MARGIN,
} from "./composer-placement";

interface AnchoredPopupOptions {
	/** The control the popup hangs off. Read afresh every time: it may be bound late, and it moves. */
	anchor: () => Element | null | undefined;
	/** The popup. Its own width and height decide where it can go. */
	popup: HTMLElement;
	/** The most the popup grows before its content scrolls, in px; its CSS caps it at the same number. */
	maxHeight: number;
	/** How close the popup may come to the window's left and right edges; the composer's own margin when left out. */
	sideMargin?: number;
	/**
	 * Receives the inline style that places the popup (`left`, `top` or `bottom`,
	 * and `max-height`), and whether its content is taller than the room it was
	 * given, so that it has to scroll. A popup whose content fits need not clip
	 * anything that pokes out of it.
	 */
	onPlace: (style: string, scrolls: boolean) => void;
}

function place({
	anchor,
	popup,
	maxHeight,
	sideMargin,
	onPlace,
}: AnchoredPopupOptions) {
	const trigger = anchor();
	if (!trigger || typeof window === "undefined") return;
	// Its own size decides where it can go: the width is whatever its CSS makes
	// it, the height is its content up to the cap. Neither is a number the
	// caller could write down, and a width that is guessed leaves a short popup
	// standing a phone's width away from its control.
	const width = popup.getBoundingClientRect().width;
	const contentHeight =
		popup.scrollHeight + popup.offsetHeight - popup.clientHeight;
	const height = Math.min(contentHeight, maxHeight);
	const placement = computeMenuPlacement(
		trigger.getBoundingClientRect(),
		{ width: window.innerWidth, height: window.innerHeight },
		width,
		// The room it needs above the control to hang there whole.
		height + MENU_GAP + MENU_MARGIN,
		sideMargin,
	);
	const edge =
		placement.top !== null
			? `top:${placement.top}px;`
			: `bottom:${placement.bottom}px;`;
	const room = Math.min(maxHeight, placement.maxHeight);
	onPlace(
		`left:${placement.left}px;${edge}max-height:${room}px;`,
		contentHeight > room,
	);
}

/**
 * Places the popup now, again whenever the control is not where the placement
 * was made for (or the window has another size), and again whenever the popup
 * changes size. Returns the teardown; the caller decides what the popup looks
 * like once it is no longer followed.
 */
export function followAnchor(options: AnchoredPopupOptions): () => void {
	/** What the placement is made for: where the control is, and how big the window is. */
	const anchorKey = () => {
		const rect = options.anchor()?.getBoundingClientRect();
		return [rect?.left, rect?.top, window.innerWidth, window.innerHeight].join(
			"|",
		);
	};
	let placedFor = "";
	const run = () => {
		place(options);
		placedFor = anchorKey();
	};
	let frame = 0;
	const follow = () => {
		if (anchorKey() !== placedFor) run();
		frame = requestAnimationFrame(follow);
	};
	run();
	frame = requestAnimationFrame(follow);
	const observer =
		typeof ResizeObserver === "undefined" ? null : new ResizeObserver(run);
	observer?.observe(options.popup);
	return () => {
		cancelAnimationFrame(frame);
		observer?.disconnect();
	};
}
