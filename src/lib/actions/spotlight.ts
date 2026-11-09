import { get } from "svelte/store";
import type { SpotlightId } from "$lib/app-places";
import {
	pendingSpotlight,
	type SpotlightRequest,
	spotlightRequest,
	takeSpotlight,
} from "$lib/stores/spotlight";
import { prefersReducedMotion } from "$lib/utils/motion";

/** How long a control wears the ring once the guide's Show me has brought the person to it. */
export const SPOTLIGHT_RING_MS = 2000;

/** The class that `app.css` gives the ring's look. */
const RING_CLASS = "spotlight-ring";

/**
 * Marks a real control as a place the feature guide's Show me can ring.
 *
 * Usage:
 * ```svelte
 * <button use:spotlightTarget={"composer.atlas"}>…</button>
 * ```
 *
 * Show me calls `requestSpotlight(id)` (`$lib/stores/spotlight`) and navigates.
 * The control that carries the id takes that request, once, scrolls itself to
 * the middle of whatever scrolls it and wears `.spotlight-ring` (`app.css`) for
 * `SPOTLIGHT_RING_MS`.
 *
 * - A request made before the control mounts is taken when it does (a store
 *   hands a new subscriber its current value). That is how a menu row, a tab or
 *   a drawer that opens late still rings.
 * - A control with no layout (`display: none`, the other form factor's copy of
 *   a control) leaves the request alone: it is not what the person was sent to,
 *   and the copy on screen, or a row that opens a moment later, can still take it.
 * - The scroll and the ring wait for the next frame, so the scroll measures the
 *   layout as it settles after the page that brought the person here.
 * - Asked again while it rings, the ring starts over: one timer, never two.
 *
 * Under reduced motion the scroll is `"auto"`; the ring's own ease is a
 * `--duration-standard` transition, which that setting zeroes (`app.css`).
 */
export function spotlightTarget(
	node: HTMLElement,
	spotlight: SpotlightId,
): { update(next: SpotlightId): void; destroy(): void } {
	let id = spotlight;
	let destroyed = false;
	let frame: number | null = null;
	let ringTimer: ReturnType<typeof setTimeout> | null = null;

	/** Cancels a ring that has not begun, and the end of one that has. */
	function cancelPending() {
		if (frame !== null) cancelAnimationFrame(frame);
		if (ringTimer !== null) clearTimeout(ringTimer);
		frame = null;
		ringTimer = null;
	}

	function ring() {
		frame = null;
		node.scrollIntoView({
			block: "center",
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
		node.classList.add(RING_CLASS);
		ringTimer = setTimeout(() => {
			ringTimer = null;
			node.classList.remove(RING_CLASS);
		}, SPOTLIGHT_RING_MS);
	}

	function answer(request: SpotlightRequest | null) {
		// A store tells its subscribers through a queue, so one that has just
		// unsubscribed can still be called once.
		if (destroyed) return;
		if (pendingSpotlight(request) !== id) return;
		if (node.getClientRects().length === 0) return;
		if (!takeSpotlight(id)) return;
		cancelPending();
		frame = requestAnimationFrame(ring);
	}

	const unsubscribe = spotlightRequest.subscribe(answer);

	return {
		update(next) {
			id = next;
			answer(get(spotlightRequest));
		},
		destroy() {
			destroyed = true;
			unsubscribe();
			cancelPending();
			node.classList.remove(RING_CLASS);
		},
	};
}
