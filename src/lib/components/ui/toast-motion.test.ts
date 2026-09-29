import { cubicIn } from "svelte/easing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION_DURATION } from "$lib/utils/motion";
import { TOAST_EXIT_OFFSET_PX, toastExit } from "./toast-motion";

function stubReducedMotion(reduce: boolean) {
	window.matchMedia = vi.fn((query: string) => ({
		matches: reduce && query.includes("prefers-reduced-motion"),
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
		onchange: null,
	})) as unknown as typeof window.matchMedia;
}

describe("toastExit (redesign §7.2 #33: out, standard · ease-in)", () => {
	const original = window.matchMedia;

	beforeEach(() => {
		stubReducedMotion(false);
	});

	afterEach(() => {
		window.matchMedia = original;
	});

	it("takes the standard duration with the ease-in curve", () => {
		const config = toastExit(document.createElement("div"));
		expect(config.duration).toBe(MOTION_DURATION.standard);
		expect(MOTION_DURATION.standard).toBe(150);
		expect(config.easing).toBe(cubicIn);
	});

	it("leaves the way it came: from where it rests to 12px lower, fading out", () => {
		const config = toastExit(document.createElement("div"));
		const css = config.css as (t: number, u: number) => string;

		// t runs 1 → 0 through an outro.
		expect(css(1, 0)).toBe("opacity: 1; transform: translateY(0px);");
		expect(css(0, 1)).toBe(
			`opacity: 0; transform: translateY(${TOAST_EXIT_OFFSET_PX}px);`,
		);
		expect(TOAST_EXIT_OFFSET_PX).toBe(12);
		expect(css(0.5, 0.5)).toBe("opacity: 0.5; transform: translateY(6px);");
	});

	it("never drifts sideways or scales: only opacity and vertical travel change", () => {
		const config = toastExit(document.createElement("div"));
		const css = config.css as (t: number, u: number) => string;
		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			expect(css(t, 1 - t)).toMatch(
				/^opacity: [\d.]+; transform: translateY\([\d.]+px\);$/,
			);
		}
	});

	it("is instant under reduced motion: no duration, so the toast leaves at once", () => {
		stubReducedMotion(true);
		const config = toastExit(document.createElement("div"));
		expect(config.duration).toBe(0);
		expect(config.css).toBeUndefined();
	});
});
