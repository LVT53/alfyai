/**
 * Move an element to `document.body` so its `position: fixed` means the
 * viewport.
 *
 * A fixed element is only fixed to the viewport while no ancestor has a
 * transform, filter, backdrop-filter, perspective or `contain: paint` — any
 * one of those makes the ancestor the containing block instead, and the
 * element silently lands wherever that ancestor happens to be.
 *
 * That is not hypothetical here. The landing page centres its composer with
 * `transform: translateY(-50%)`, so a bottom sheet opened from inside the
 * composer rendered 200px above the bottom of the screen with its grabber
 * scrolled up underneath the header — dismissible only by luck. A modal
 * backdrop rendered from the same place covered the middle of the page rather
 * than the page.
 *
 * So: anything that claims the whole viewport is moved to the body. The node
 * keeps its Svelte identity — Svelte removes it with `node.remove()`, which
 * works wherever it lives, and transitions animate the node itself — so
 * mounting, updating and the outro are unaffected.
 */
export function portalToBody(node: HTMLElement, enabled = true) {
	// Remembered so the node can be handed back if the condition flips (a
	// desktop window dragged narrow and back).
	const originalParent = node.parentNode;
	const originalNextSibling = node.nextSibling;
	let moved = false;

	function apply(on: boolean) {
		if (typeof document === "undefined") return;
		if (on && !moved) {
			document.body.appendChild(node);
			moved = true;
			return;
		}
		if (!on && moved) {
			originalParent?.insertBefore(node, originalNextSibling);
			moved = false;
		}
	}

	apply(enabled);

	return {
		update(next: boolean) {
			apply(next);
		},
		destroy() {
			// Svelte tears a block down by clearing the range between the
			// anchors it left in the ORIGINAL parent — so a node that has been
			// reparented is simply never reached, and a dismissed sheet stays on
			// screen forever. Having moved it, we own removing it. Harmless if
			// Svelte got there first: `remove()` on a detached node is a no-op.
			if (moved) node.remove();
		},
	};
}
