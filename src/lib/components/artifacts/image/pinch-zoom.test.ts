import { describe, expect, it } from "vitest";
import { zoomFrom } from "./pinch-zoom";

describe("zoomFrom", () => {
	it("scales with the distance between the two fingers", () => {
		expect(zoomFrom({ distance: 100, scale: 1 }, { distance: 200 })).toBe(2);
	});

	it("never zooms in past 4x or out past 1x", () => {
		expect(zoomFrom({ distance: 100, scale: 1 }, { distance: 500 })).toBe(4);
		expect(zoomFrom({ distance: 100, scale: 1 }, { distance: 50 })).toBe(1);
	});

	it("starts from the scale the pinch began at", () => {
		expect(zoomFrom({ distance: 100, scale: 2 }, { distance: 150 })).toBe(3);
	});

	it("keeps the scale when the start distance is nothing", () => {
		expect(zoomFrom({ distance: 0, scale: 2 }, { distance: 150 })).toBe(2);
	});
});
