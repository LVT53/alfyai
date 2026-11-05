import { fly, type TransitionConfig } from "svelte/transition";
import { MOTION_DURATION, MOTION_EASE } from "$lib/utils/motion";

/**
 * How the question card moves in when it appears during a reply (owner, 2026-11-05: "less
 * sudden, you could see it move in from the bottom"): it rises into place and fades in,
 * as a toast does (`Toast.svelte`: a 12 px rise over the emphasis duration). Svelte's `fly`
 * takes these as its parameters, and it moves transform and opacity and nothing else:
 * never the card's size or margins, which a reply's layout depends on.
 *
 * The numbers are the app's motion tokens, through their JS mirrors (`utils/motion.ts`:
 * `--duration-emphasis` and `--ease-emphasis` in `app.css`). The card plays it through
 * `reducedMotionAware`, so it does not move at all when the reader asked for no motion.
 */
export const CARD_RISE = {
	/** How far below its place the card starts, in px (a positive `y` starts below). */
	y: 10,
	duration: MOTION_DURATION.emphasis,
	easing: MOTION_EASE.emphasis,
} as const;

/**
 * The cards the server drew into this page. They are on screen from the first paint, before
 * any of the app has run, so they are read when this module loads (SvelteKit loads a route's
 * modules, this one included, before it hydrates the server's markup).
 */
const drawnByTheServer = new WeakSet<Element>(
	typeof document === "undefined"
		? []
		: document.querySelectorAll('[data-testid="ask-card"]'),
);

/**
 * `fly` by `CARD_RISE`, except on a card the server drew: it is already on screen, and the
 * entrance would hide it and bring it back, a blink on every reload with a question waiting
 * (measured: opaque at the first paint, transparent 150 ms later, then rising in). A card
 * that appears in a page that is already up, during a reply or when the chat is opened from
 * the sidebar, is the client's own and rises.
 */
export function riseUnlessDrawnByTheServer(
	node: Element,
	params: typeof CARD_RISE,
): TransitionConfig {
	return drawnByTheServer.has(node) ? { duration: 0 } : fly(node, params);
}
