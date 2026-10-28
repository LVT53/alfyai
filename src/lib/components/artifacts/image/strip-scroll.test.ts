import { describe, expect, it } from "vitest";
import { overflowEdges, scrollLeftToShow } from "./strip-scroll";

describe("overflowEdges", () => {
	it("fades only the side that hides frames", () => {
		expect(
			overflowEdges({ scrollLeft: 0, clientWidth: 130, scrollWidth: 300 }),
		).toEqual({ start: false, end: true });
		expect(
			overflowEdges({ scrollLeft: 170, clientWidth: 130, scrollWidth: 300 }),
		).toEqual({ start: true, end: false });
		expect(
			overflowEdges({ scrollLeft: 60, clientWidth: 130, scrollWidth: 300 }),
		).toEqual({ start: true, end: true });
	});

	it("fades nothing when every frame fits", () => {
		expect(
			overflowEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }),
		).toEqual({ start: false, end: false });
	});
});

describe("scrollLeftToShow", () => {
	const view = { scrollLeft: 0, clientWidth: 130 };

	it("brings a frame cut at the end whole into view, no further", () => {
		// The third 56 px frame (gap 6) starts at 124: cut at 130.
		expect(scrollLeftToShow({ left: 124, width: 56 }, view)).toBe(50);
	});

	it("brings a frame hidden at the start back to the start", () => {
		expect(
			scrollLeftToShow({ left: 0, width: 56 }, { ...view, scrollLeft: 50 }),
		).toBe(0);
	});

	it("leaves the row where it is when the frame already shows whole", () => {
		expect(
			scrollLeftToShow({ left: 62, width: 56 }, { ...view, scrollLeft: 10 }),
		).toBe(10);
	});
});
