/**
 * Svelte action that relocates a node to a target element (default
 * `document.body`) for its lifetime.
 *
 * Why: a `position: fixed` overlay is positioned against the nearest
 * ancestor that establishes a containing block — any ancestor with a
 * `transform`, `filter`, or `contain` (all common on animated chat message
 * rows) traps the overlay into that box instead of the viewport. Mounting the
 * overlay under `document.body` — which has no such ancestor — guarantees it
 * fills the real viewport regardless of where in the tree it was declared.
 *
 * Usage:
 * ```svelte
 * {#if open}
 *   <div class="overlay" use:portal>…</div>
 * {/if}
 * ```
 *
 * The action runs client-side only (Svelte actions never run during SSR), so
 * the `document.body` default is safe.
 */
export function portal(node: HTMLElement, target: HTMLElement = document.body) {
	target.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}
