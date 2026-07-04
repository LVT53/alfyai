// ADR-0043 Wave 9: reduced-motion guard for Chart.js analytics charts.
//
// Chart.js renders to <canvas>, so the global app.css
// `@media (prefers-reduced-motion: reduce)` override (which collapses CSS
// animation/transition durations) cannot reach chart animations. This helper
// bridges that gap: when the user prefers reduced motion it returns `false`
// (Chart.js's documented way to disable all animation); otherwise it returns
// the caller's normal animation config.
//
// SSR-safe: reads matchMedia only in the browser. These settings charts only
// mount client-side (behind an awaited dynamic import of chart.js), but the
// guard is defensive in case of any server render.

/**
 * Normal Chart.js animation config (e.g. `{ duration: 700 }`), or `false` to
 * keep animation fully disabled. Mirrors Chart.js's accepted `animation` value.
 */
export type ChartAnimation = false | Record<string, unknown>;

/**
 * Returns the animation config for a Chart.js chart, honoring the user's
 * reduced-motion preference. Pass the default animation object for the
 * non-reduced-motion case.
 */
export function chartAnimation(
	defaultAnimation: Record<string, unknown>,
): ChartAnimation {
	if (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		return false;
	}
	return defaultAnimation;
}
