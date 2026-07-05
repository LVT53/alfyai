import type { TransitionConfig } from "svelte/transition";

/** True when the user has requested reduced motion. SSR-safe (false on the server). */
export function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * Wraps a Svelte transition factory (e.g. `fly`, `fade`) so it collapses to
 * an instant, zero-duration transition under prefers-reduced-motion instead
 * of playing in full.
 *
 * The global CSS override in app.css collapses `animation`/`transition`
 * duration for reduced motion, but Svelte's `css`-based transitions
 * interpolate styles directly rather than going through those CSS
 * properties, so that override can't reach them — this covers the gap.
 */
export function reducedMotionAware<P>(
	transitionFn: (node: Element, params: P) => TransitionConfig,
): (node: Element, params: P) => TransitionConfig {
	return (node, params) => {
		if (prefersReducedMotion()) return { duration: 0 };
		return transitionFn(node, params);
	};
}
