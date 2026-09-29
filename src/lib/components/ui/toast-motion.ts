import { cubicIn } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";
import { MOTION_DURATION, prefersReducedMotion } from "$lib/utils/motion";

/** How far below its resting place a toast sinks as it leaves — the 12px it rises when it arrives. */
export const TOAST_EXIT_OFFSET_PX = 12;

/**
 * A toast's exit (Artifacts redesign §7.2 #33: "rises 12 px and fades in;
 * leaves after 5.2 s — in emphasis · ease-emphasis, out standard · ease-in;
 * reduced motion: instant"). It leaves the way it came: fading out while it
 * sinks the 12px it rose, over the standard duration with the ease-in curve
 * (`cubicIn` is the closest of Svelte's own curves to `--ease-in`).
 *
 * A plain function of nothing but the motion preference, so its numbers are
 * tested directly — jsdom never runs an outro to its end, so a component
 * test cannot wait for one. Svelte calls `css(t)` with `t` running 1 → 0 on
 * the way out. `Toast.svelte` uses it as `out:toastExit`.
 */
export function toastExit(_node: Element): TransitionConfig {
	if (prefersReducedMotion()) return { duration: 0 };
	return {
		duration: MOTION_DURATION.standard,
		easing: cubicIn,
		css: (t) =>
			`opacity: ${t}; transform: translateY(${(1 - t) * TOAST_EXIT_OFFSET_PX}px);`,
	};
}
