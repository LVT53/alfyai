/**
 * Single source of truth for viewport / capability detection.
 *
 * Consolidates the previously scattered `matchMedia("(hover: none) and
 * (pointer: coarse)")` and `innerWidth` checks across chat components behind one
 * SSR-safe helper module. Slice 0 (ADR 0043) only centralizes detection — it
 * does NOT change any affordance behavior.
 *
 * SSR safety: module load performs no `window` access. The reactive
 * {@link viewportStore} ships with a desktop/non-touch default that is safe to
 * render on the server; call {@link initViewportTracking} from a client-side
 * `onMount` to begin tracking real resize/orientation events.
 */

/** Coarse viewport bucket. */
export type ViewportTier = "phone" | "tablet" | "desktop";

/** Combined reactive snapshot of capability + tier. */
export interface ViewportState {
	touch: boolean;
	tier: ViewportTier;
}

const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

/** Width thresholds (exclusive lower / inclusive upper boundaries). */
const PHONE_MAX_WIDTH = 640;
const DESKTOP_MIN_WIDTH = 1024;

/** SSR-safe default exposed before any client-side init has run. */
const DEFAULT_VIEWPORT_STATE: ViewportState = {
	touch: false,
	tier: "desktop",
};

/**
 * Reactive viewport state (Svelte 5 runes-in-module). Components read
 * `viewportStore.touch` / `viewportStore.tier` reactively. We mutate the
 * object's properties rather than reassigning the binding so the reactive
 * proxy stays shared across modules.
 */
export const viewportStore: ViewportState = $state({
	...DEFAULT_VIEWPORT_STATE,
});

let trackingInitialized = false;

/**
 * Report whether the current environment is a touch-first device.
 *
 * SSR-safe and environment-safe: returns `false` when `window` is unavailable
 * or `matchMedia` is missing (older/incomplete runtimes). Otherwise consults
 * `matchMedia("(hover: none) and (pointer: coarse)")`.
 */
export function isTouchDevice(): boolean {
	if (typeof window === "undefined") return false;
	if (typeof window.matchMedia !== "function") return false;
	return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/**
 * Bucket the current viewport width into a coarse tier.
 *
 * - `< 640`  → `"phone"`
 * - `640–1023` → `"tablet"`
 * - `>= 1024` → `"desktop"`
 *
 * SSR-safe: returns `"desktop"` when `window` is unavailable.
 */
export function viewportTier(): ViewportTier {
	if (typeof window === "undefined") return "desktop";
	return tierFromWidth(window.innerWidth);
}

/**
 * Pure helper that computes the full viewport snapshot by reading `window` on
 * demand. Has no side effects and touches `window` only when invoked, which
 * keeps it trivially testable and safe to call from anywhere client-side.
 *
 * Returns the SSR default when `window` is unavailable or `matchMedia` is
 * missing, matching the defensive guards the legacy call-sites used.
 */
export function computeViewportState(): ViewportState {
	if (typeof window === "undefined") return { ...DEFAULT_VIEWPORT_STATE };
	if (typeof window.matchMedia !== "function") {
		return { ...DEFAULT_VIEWPORT_STATE };
	}
	return {
		touch: window.matchMedia(COARSE_POINTER_QUERY).matches,
		tier: tierFromWidth(window.innerWidth),
	};
}

/**
 * Begin tracking real viewport changes. Register this from a client-side
 * `onMount` (NOT at module load) so SSR bundles stay side-effect free.
 *
 * Idempotent: safe to call multiple times — duplicate calls are no-ops and
 * will not stack additional event listeners.
 */
export function initViewportTracking(): void {
	if (typeof window === "undefined") return;

	// Always refresh the store on invocation so callers get an up-to-date
	// snapshot even if tracking was already started by another consumer.
	syncStore();

	if (trackingInitialized) return;
	trackingInitialized = true;
	window.addEventListener("resize", syncStore);
	window.addEventListener("orientationchange", syncStore);
}

function tierFromWidth(width: number): ViewportTier {
	if (width < PHONE_MAX_WIDTH) return "phone";
	if (width < DESKTOP_MIN_WIDTH) return "tablet";
	return "desktop";
}

function syncStore(): void {
	const next = computeViewportState();
	viewportStore.touch = next.touch;
	viewportStore.tier = next.tier;
}
