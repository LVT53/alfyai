import { MOTION_DURATION, MOTION_EASE } from "$lib/utils/motion";

/**
 * How the question card moves in when it appears during a reply (owner, 2026-11-05: "less
 * sudden, you could see it move in from the bottom"): it rises into place and fades in,
 * the way a toast does (`Toast.svelte`: 12 px, the emphasis duration and curve). Svelte's
 * `fly` takes these as its parameters, and it moves transform and opacity and nothing else:
 * never the card's size or margins, which the thread's end and a reply's layout depend on.
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
