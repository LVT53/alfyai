/**
 * Chart palette utilities for the reusable analytics components
 * (Phase B, wave B2).
 *
 * Colors are chosen to match the app's own design tokens: the primary accent
 * is TERRACOTTA (`var(--accent)` = #c15f3c light / #d4836b dark). The
 * categorical series stay easy to tell apart while remaining theme-agnostic
 * for grid/tick grays (like the existing Chart.js charts in the settings
 * analytics panes).
 */

/** Fallback accent (light-theme terracotta) when the DOM is unavailable (SSR). */
export const ACCENT_FALLBACK = "#c15f3c";

/**
 * Read the live `--accent` token off the document root. Follows the current
 * light/dark theme because the token is redefined under `.dark`. SSR-guarded:
 * returns {@link ACCENT_FALLBACK} when there is no `window`/`document`.
 */
export function getAccent(): string {
	if (typeof window === "undefined" || typeof document === "undefined") {
		return ACCENT_FALLBACK;
	}
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue("--accent")
		.trim();
	return value || ACCENT_FALLBACK;
}

/**
 * Named categorical colors for the fixed analytics series. `llm` follows the
 * live accent; `turbo`/`extract` are distinct static hues that read clearly
 * next to terracotta in both themes.
 */
export const SERIES = {
	/** Turbo pipeline — teal. */
	turbo: "#0d9488",
	/** Extract pipeline — amber. */
	extract: "#d97706",
	/** LLM pipeline — terracotta (live accent). */
	get llm(): string {
		return getAccent();
	},
} as const;

/**
 * Ordered categorical palette for open-ended breakdowns (byModel / byUser).
 * Terracotta first so the primary series matches the accent, then a spread of
 * distinct hues.
 */
export const CATEGORICAL: string[] = [
	"#c15f3c", // terracotta (accent)
	"#0d9488", // teal
	"#d97706", // amber
	"#648baf", // slate-blue
	"#15803d", // green
	"#7364a0", // purple
];

/** Theme-agnostic gridline color (matches existing analytics charts). */
export const GRID_COLOR = "rgba(128,128,128,0.1)";

/** Theme-agnostic axis-tick / label color (matches existing analytics charts). */
export const TICK_COLOR = "rgba(128,128,128,0.85)";

/**
 * Pick a categorical color by index, wrapping around the {@link CATEGORICAL}
 * palette. Convenience for mapping breakdown rows to dataset colors.
 */
export function categoricalColor(index: number): string {
	return CATEGORICAL[index % CATEGORICAL.length];
}
