import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MOTION_DURATION,
	MOTION_EASING,
	prefersReducedMotion,
	reducedMotionAnimate,
	reducedMotionAware,
} from "./motion";

function stubMatchMedia(matches: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})),
	);
}

describe("prefersReducedMotion", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns true when the media query matches", () => {
		stubMatchMedia(true);
		expect(prefersReducedMotion()).toBe(true);
	});

	it("returns false when the media query does not match", () => {
		stubMatchMedia(false);
		expect(prefersReducedMotion()).toBe(false);
	});
});

describe("reducedMotionAware", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("collapses to an instant, zero-duration transition under reduced motion", () => {
		stubMatchMedia(true);
		const inner = vi.fn(() => ({ duration: 300, css: () => "" }));
		const wrapped = reducedMotionAware(inner);

		const config = wrapped(document.createElement("div"), { y: -6 });

		expect(config).toEqual({ duration: 0 });
		expect(inner).not.toHaveBeenCalled();
	});

	it("delegates to the wrapped transition when motion is not reduced", () => {
		stubMatchMedia(false);
		const innerConfig = { duration: 300, css: () => "opacity: 1;" };
		const inner = vi.fn(() => innerConfig);
		const wrapped = reducedMotionAware(inner);

		const node = document.createElement("div");
		const params = { y: -6 };
		const config = wrapped(node, params);

		expect(inner).toHaveBeenCalledWith(node, params);
		expect(config).toBe(innerConfig);
	});
});

// jsdom does not implement the Web Animations API (`Element.prototype.animate`
// is `undefined`), so the "plays a real animation" cases below stub it on the
// test element themselves — the same way a real browser's implementation
// would be exercised for real by the Playwright specs (§7.2/§7.3, Wave 2.5).
describe("reducedMotionAnimate", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("jumps straight to the final keyframe under reduced motion, without calling element.animate", () => {
		stubMatchMedia(true);
		const el = document.createElement("div");
		const animateSpy = vi.fn();
		el.animate = animateSpy as unknown as typeof el.animate;

		const result = reducedMotionAnimate(
			el,
			[
				{ opacity: "0", transform: "translateY(6px)" },
				{ opacity: "1", transform: "none" },
			],
			{ duration: MOTION_DURATION.emphasis, easing: MOTION_EASING.emphasis },
		);

		expect(animateSpy).not.toHaveBeenCalled();
		expect(el.style.opacity).toBe("1");
		expect(el.style.transform).toBe("none");
		return expect(result.finished).resolves.toBeUndefined();
	});

	it("does nothing and still resolves `finished` when given no keyframes", () => {
		stubMatchMedia(false);
		const el = document.createElement("div");
		const animateSpy = vi.fn();
		el.animate = animateSpy as unknown as typeof el.animate;

		const result = reducedMotionAnimate(el, [], {
			duration: MOTION_DURATION.standard,
			easing: MOTION_EASING.out,
		});

		expect(animateSpy).not.toHaveBeenCalled();
		return expect(result.finished).resolves.toBeUndefined();
	});

	it("plays a WAAPI animation with the given tokens and resolves `finished` when it finishes", async () => {
		stubMatchMedia(false);
		const el = document.createElement("div");
		let resolveFinished!: () => void;
		const finished = new Promise<void>((resolve) => {
			resolveFinished = resolve;
		});
		const cancelSpy = vi.fn();
		const animateSpy = vi.fn(() => ({ finished, cancel: cancelSpy }));
		el.animate = animateSpy as unknown as typeof el.animate;

		const keyframes = [{ opacity: "0" }, { opacity: "1" }];
		const result = reducedMotionAnimate(el, keyframes, {
			duration: MOTION_DURATION.emphasis,
			easing: MOTION_EASING.emphasis,
			delay: 60,
		});

		expect(animateSpy).toHaveBeenCalledWith(keyframes, {
			duration: MOTION_DURATION.emphasis,
			easing: MOTION_EASING.emphasis,
			delay: 60,
			fill: "forwards",
		});
		// Nothing jumps the element's own style under real motion — the
		// browser's own animation (not this helper) owns the visual state
		// until it finishes.
		expect(el.style.opacity).toBe("");

		resolveFinished();
		await expect(result.finished).resolves.toBeUndefined();

		result.cancel();
		expect(cancelSpy).toHaveBeenCalledOnce();
	});

	it("defaults the WAAPI fill mode to forwards, but honours an explicit one", () => {
		stubMatchMedia(false);
		const el = document.createElement("div");
		const animateSpy = vi.fn(() => ({
			finished: Promise.resolve(),
			cancel: vi.fn(),
		}));
		el.animate = animateSpy as unknown as typeof el.animate;

		reducedMotionAnimate(el, [{ opacity: "1" }], {
			duration: MOTION_DURATION.micro,
			easing: MOTION_EASING.in,
			fill: "none",
		});

		expect(animateSpy).toHaveBeenCalledWith(
			[{ opacity: "1" }],
			expect.objectContaining({ fill: "none" }),
		);
	});

	it("never rejects `finished`, even when the underlying animation is cancelled mid-flight", async () => {
		stubMatchMedia(false);
		const el = document.createElement("div");
		const animateSpy = vi.fn(() => ({
			finished: Promise.reject(new Error("cancelled")),
			cancel: vi.fn(),
		}));
		el.animate = animateSpy as unknown as typeof el.animate;

		const result = reducedMotionAnimate(el, [{ opacity: "1" }], {
			duration: MOTION_DURATION.standard,
			easing: MOTION_EASING.out,
		});

		await expect(result.finished).resolves.toBeUndefined();
	});
});

describe("MOTION_DURATION / MOTION_EASING", () => {
	it("mirror src/app.css's --duration-*/--ease-* tokens (§9.1)", () => {
		// A plain value check, not a read of app.css — WAAPI options cannot
		// take a `var(...)` reference (see `motion.ts`'s own comment), so
		// these two objects are the JS-side source of truth for callers of
		// `reducedMotionAnimate`; keep them in sync with app.css by hand.
		expect(MOTION_DURATION).toEqual({
			micro: 100,
			standard: 150,
			emphasis: 250,
			settle: 700,
		});
		expect(MOTION_EASING).toEqual({
			out: "cubic-bezier(0.4, 0, 0.2, 1)",
			emphasis: "cubic-bezier(0.2, 0, 0, 1)",
			in: "cubic-bezier(0.4, 0, 1, 1)",
		});
	});
});
