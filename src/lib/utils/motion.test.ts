import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, reducedMotionAware } from "./motion";

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
