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

/**
 * Durations for the Web Animations API calls this module drives (Artifacts
 * redesign §7.2/§9.1). These are JS-side mirrors of `src/app.css`'s
 * `--duration-*` tokens — WAAPI's `duration`/`easing` options take numbers
 * and plain strings, not `var(...)` references, so a caller cannot simply
 * point `element.animate()` at the CSS custom properties the way a
 * stylesheet rule does. Keep these in sync with app.css by hand; there are
 * only four of them and the redesign spec pins all four values.
 */
export const MOTION_DURATION = {
	micro: 100,
	standard: 150,
	emphasis: 250,
	settle: 700,
} as const;

/** JS-side mirrors of `src/app.css`'s `--ease-*` tokens. See `MOTION_DURATION`. */
export const MOTION_EASING = {
	out: "cubic-bezier(0.4, 0, 0.2, 1)",
	emphasis: "cubic-bezier(0.2, 0, 0, 1)",
	in: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

export interface MotionAnimateOptions {
	/** Typically one of `MOTION_DURATION`'s values. */
	duration: number;
	/** Typically one of `MOTION_EASING`'s values. */
	easing: string;
	/** Delay in ms before the animation starts — e.g. a stagger offset for one row among several arriving together. */
	delay?: number;
	/** WAAPI fill mode. Defaults to `"forwards"` so the end state holds once the animation finishes — the same state the reduced-motion path below jumps to directly. */
	fill?: FillMode;
}

/** What `reducedMotionAnimate` hands back, whichever path it took. */
export interface MotionAnimation {
	/** Resolves once the element is in its final state. Never rejects, even if the underlying WAAPI animation is cancelled. */
	readonly finished: Promise<void>;
	/** Stops a running animation early. A no-op under reduced motion — the element is already in its final state by the time this could be called. */
	cancel(): void;
}

/**
 * Runs a one-shot `element.animate(...)` for a motion-spec animation (§7.2:
 * list ↔ item push, panel open/close, a card arriving, the Alfy change
 * mark's settle) and, under `prefers-reduced-motion: reduce`, skips the
 * animation entirely and jumps straight to its last keyframe instead (§7.3:
 * "no movement... jump to the final state") — so nothing the animation was
 * conveying (a row's final position, a mark's resting tint) depends on an
 * animation that never played.
 *
 * Not for loops (the writing/shimmer states in §7.2 #10/#25/#30): those are
 * plain CSS `animation: … infinite`, already collapsed to a single static
 * frame by the global `prefers-reduced-motion` override in app.css. This
 * helper is for the transient, JS-triggered animations that override covers.
 *
 * Returns a `MotionAnimation` uniformly on both paths so a caller can
 * `await result.finished` the same way regardless of the user's motion
 * preference, rather than branching on whether an animation actually played.
 */
export function reducedMotionAnimate(
	element: HTMLElement | SVGElement,
	keyframes: Keyframe[],
	options: MotionAnimateOptions,
): MotionAnimation {
	if (prefersReducedMotion() || keyframes.length === 0) {
		applyFinalKeyframe(element, keyframes);
		return { finished: Promise.resolve(), cancel: () => {} };
	}

	const animation = element.animate(keyframes, {
		duration: options.duration,
		easing: options.easing,
		delay: options.delay,
		fill: options.fill ?? "forwards",
	});

	return {
		// `Animation.finished` rejects when the animation is cancelled — this
		// helper's own `cancel()` is a normal, expected way to stop early
		// (e.g. a new arrival interrupting one still settling), not a failure
		// a caller awaiting `finished` should have to catch.
		finished: animation.finished.then(
			() => undefined,
			() => undefined,
		),
		cancel: () => animation.cancel(),
	};
}

/**
 * Applies a keyframe animation's last frame directly, with no animation —
 * `reducedMotionAnimate`'s reduced-motion path. Keyframe property names
 * (e.g. `backgroundColor`) already match `CSSStyleDeclaration`'s own
 * camelCase JS accessors, so this assigns them directly rather than
 * converting to kebab-case for `setProperty`.
 */
function applyFinalKeyframe(
	element: HTMLElement | SVGElement,
	keyframes: Keyframe[],
): void {
	const final = keyframes.at(-1);
	if (!final) return;
	const style = element.style as unknown as Record<string, string>;
	for (const [property, value] of Object.entries(final)) {
		if (
			property === "offset" ||
			property === "easing" ||
			property === "composite"
		)
			continue;
		const resolved = Array.isArray(value) ? value.at(-1) : value;
		if (resolved === undefined || resolved === null) continue;
		style[property] = String(resolved);
	}
}
