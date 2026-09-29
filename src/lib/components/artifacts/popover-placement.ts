/**
 * Where an anchored popover goes (Wave 2.5 polish G1-B): under its button,
 * left edges aligned, and never outside the panel it belongs to — so the
 * Versions popover under the header's `v3 ▾` opens over the document, not over
 * the chat column beside it. Pure geometry (no DOM), so the rules are testable
 * without a layout engine; `AnchoredPopover.svelte` measures and applies it.
 *
 * Rules: the popover stays inside the boundary (the panel) and the window,
 * narrows to fit a panel narrower than itself, drops below its button when
 * all of it fits there, flips above when it does not and there is more room
 * above, and otherwise stays below and scrolls inside a capped height.
 */

export interface PlacementRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface PopoverPlacementInput {
	/** The button the popover belongs to. */
	anchor: PlacementRect;
	/** The panel the popover must stay inside. */
	boundary: PlacementRect;
	viewport: { width: number; height: number };
	/** Its natural height: header plus the whole, unscrolled content. */
	contentHeight: number;
	preferredWidth: number;
	/** Space between the button and the popover. Default 8. */
	gap?: number;
	/** Space kept between the popover and the panel/window edge. Default 12. */
	margin?: number;
	/** The tallest it may grow before its content scrolls. Default: unlimited. */
	maxHeight?: number;
}

export interface PopoverPlacement {
	left: number;
	width: number;
	/** The height its content may take before scrolling. */
	maxHeight: number;
	side: "below" | "above";
	/** `position: fixed` top, when it opens below the button. */
	top?: number;
	/** `position: fixed` bottom (distance from the window's bottom), when it opens above. */
	bottom?: number;
}

export function placePopover(input: PopoverPlacementInput): PopoverPlacement {
	const gap = input.gap ?? 8;
	const margin = input.margin ?? 12;
	const cap = input.maxHeight ?? Number.POSITIVE_INFINITY;
	const { anchor, viewport } = input;

	// The panel, and never further than the window.
	const bounds: PlacementRect = {
		left: Math.max(input.boundary.left, 0),
		top: Math.max(input.boundary.top, 0),
		right: Math.min(input.boundary.right, viewport.width),
		bottom: Math.min(input.boundary.bottom, viewport.height),
	};

	const width = Math.max(
		0,
		Math.min(input.preferredWidth, bounds.right - bounds.left - margin * 2),
	);
	const left = Math.min(
		Math.max(anchor.left, bounds.left + margin),
		Math.max(bounds.left + margin, bounds.right - margin - width),
	);

	const spaceBelow = Math.max(
		0,
		bounds.bottom - margin - (anchor.bottom + gap),
	);
	const spaceAbove = Math.max(0, anchor.top - gap - (bounds.top + margin));
	const wanted = Math.min(input.contentHeight, cap);
	const side: "below" | "above" =
		wanted <= spaceBelow || spaceAbove <= spaceBelow ? "below" : "above";
	const available = side === "below" ? spaceBelow : spaceAbove;
	const maxHeight = Math.round(Math.min(cap, available));

	return side === "below"
		? {
				side,
				left: Math.round(left),
				width: Math.round(width),
				maxHeight,
				top: Math.round(anchor.bottom + gap),
			}
		: {
				side,
				left: Math.round(left),
				width: Math.round(width),
				maxHeight,
				bottom: Math.round(viewport.height - (anchor.top - gap)),
			};
}
