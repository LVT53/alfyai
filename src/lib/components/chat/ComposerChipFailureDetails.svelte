<script lang="ts">
// The full explanation beside a failed attachment chip.
//
// The chip itself has one line: a short danger clause after the file name, and
// the ×. That is the right density for a row of pills, but it is not enough to
// tell someone WHY their PDF cannot be sent — and the red line that used to say
// it under the composer was both easy to miss and rendered in the server's
// English. So the detail lives here: hovering or focusing the chip reveals the
// full localized sentence, and the chip itself stays one line high.
//
// It is painted in <body> (`portalToBody`) and placed against the viewport
// (`followAnchor`), because on a phone the composer's chip row is a
// side-scrolling rail with `overflow-y: hidden`: a popover absolutely
// positioned inside it would be clipped away. A fixed box is only the
// viewport's while no ancestor has a transform, and the landing page centres
// its composer with one — which is the same reason AttachmentOutline's
// disclosure uses this pattern.
//
// This surface is informational only: no controls, no focus trap. The Retry
// button stays beside the chip, and the × stays the removal control. The fade
// and the 2px rise are the whole motion, and the reduced-motion rule below
// makes the box appear without them.
import type { Snippet } from "svelte";
import { portalToBody } from "$lib/utils/portal";
import { followAnchor } from "./anchored-popup";

let {
	detail,
	children,
}: {
	/** The full localized failure sentence; null when there is no failure. */
	detail: string | null;
	/**
	 * The chip this popover describes. The snippet's argument is the open
	 * popover's id (undefined while it is closed), which the chip puts on its
	 * focusable × via `detailsId` — the × is the only focus stop, so that is
	 * where a screen reader has to hear the explanation.
	 */
	children: Snippet<[string | undefined]>;
} = $props();

const uid = $props.id();
const popoverId = `composer-chip-failure-details-${uid}`;
/** The most the popover grows before its text scrolls; the CSS caps it at the same number. */
const POPOVER_MAX_HEIGHT = 200;
/** Until it has been measured and placed the popover is not seen anywhere. */
const UNPLACED_STYLE = "visibility:hidden;";

let anchorElement = $state<HTMLSpanElement | null>(null);
let popoverElement = $state<HTMLDivElement | null>(null);
let popoverStyle = $state(UNPLACED_STYLE);
let hovered = $state(false);
let focused = $state(false);
let open = $derived(Boolean(detail) && (hovered || focused));

function handleFocusOut(event: FocusEvent) {
	const next = event.relatedTarget;
	if (next instanceof Node && anchorElement?.contains(next)) return;
	focused = false;
}

// Placed once its own box exists, and followed while it is open: the chip row
// can scroll sideways or wrap open under the pointer, and the composer itself
// moves on the landing page. Left hidden again on the way out, so the next
// opening is never seen where the last one stood.
$effect(() => {
	const popover = popoverElement;
	if (!open || !popover) return;
	const stopFollowing = followAnchor({
		anchor: () => anchorElement,
		popup: popover,
		maxHeight: POPOVER_MAX_HEIGHT,
		onPlace: (style) => {
			popoverStyle = style;
		},
	});
	return () => {
		stopFollowing();
		popoverStyle = UNPLACED_STYLE;
	};
});
</script>

<!-- `presentation` is here for two reasons: the wrapper adds no semantics of
     its own (the chip and its × carry them), and Svelte's a11y rule demands an
     explicit role from a non-interactive element that listens for hover.
     `group` was worse — a screen reader announced an unnamed group around
     every attachment chip. -->
<span
	bind:this={anchorElement}
	class="composer-chip-failure-anchor"
	data-testid="composer-chip-failure-anchor"
	role="presentation"
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	onfocusin={() => (focused = true)}
	onfocusout={handleFocusOut}
>
	{@render children(open ? popoverId : undefined)}
</span>
{#if open}
	<div
		bind:this={popoverElement}
		id={popoverId}
		class="composer-chip-failure-details"
		data-testid="composer-chip-failure-details"
		role="tooltip"
		style={popoverStyle}
		use:portalToBody
	>
		{detail}
	</div>
{/if}

<style lang="postcss">
	/* The chip keeps its own width; the wrapper is only the anchor and the
	   hover/focus listener, so the composer's pill layout is untouched. */
	.composer-chip-failure-anchor {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		max-width: 100%;
	}

	/* `left`, `top` or `bottom`, and `max-height` arrive inline from
	   followAnchor(). The box lives in <body>, so it is styled by this class
	   rather than as a descendant of the wrapper; it stands above the app's
	   own chrome, as the outline disclosure's popover does. */
	.composer-chip-failure-details {
		position: fixed;
		z-index: 60;
		width: max-content;
		min-width: 200px;
		max-width: min(320px, calc(100vw - 2 * 16px));
		max-height: 200px;
		overflow-y: auto;
		overscroll-behavior: contain;
		/* Informational only: nothing here is clickable, and a box that
		   swallows the pointer would make the chip and Retry underneath
		   unreachable while the details are open. */
		pointer-events: none;
		padding: 8px 10px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		line-height: 1.45;
		white-space: normal;
		animation: composer-chip-details-in 140ms var(--ease-out) both;
	}

	/* Slight on purpose: the box fades in and settles two pixels up. */
	@keyframes composer-chip-details-in {
		from {
			opacity: 0;
			transform: translateY(2px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.composer-chip-failure-details {
			animation: none;
		}
	}
</style>
