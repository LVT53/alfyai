import { describe, expect, it } from "vitest";
import {
	actualScale,
	clampView,
	FIT_VIEW,
	panBy,
	scaleRange,
	stepZoom,
	toggleFitActual,
	wheelZoomFactor,
	type ZoomFrame,
	zoomAbout,
	zoomPercent,
} from "./image-lightbox-zoom";

/** A 2048 x 1024 picture fitted at 1024 x 512 in a 1200 x 800 stage. */
const LARGE: ZoomFrame = {
	fitted: { width: 1024, height: 512 },
	stage: { width: 1200, height: 800 },
	natural: { width: 2048, height: 1024 },
};

/** A picture smaller than the stage: fit is already its own size. */
const SMALL: ZoomFrame = {
	fitted: { width: 400, height: 300 },
	stage: { width: 1200, height: 800 },
	natural: { width: 400, height: 300 },
};

describe("the viewer's zoom model", () => {
	it("knows how far 100% is from fit", () => {
		expect(actualScale(LARGE)).toBe(2);
		expect(actualScale(SMALL)).toBe(1);
	});

	it("never zooms out past fit and lets a large picture go past 100%", () => {
		expect(scaleRange(LARGE)).toEqual({ min: 1, max: 4 });
		expect(scaleRange(SMALL).min).toBe(1);
		expect(scaleRange(SMALL).max).toBeGreaterThanOrEqual(4);
		expect(
			scaleRange({ ...LARGE, natural: { width: 8192, height: 4096 } }).max,
		).toBe(16);
	});

	it("keeps a zoomed picture over the stage: no empty band can be dragged in", () => {
		// At 2x the picture is 2048 wide in a 1200 stage: 424 px of slack each way.
		expect(clampView({ scale: 2, x: 9999, y: -9999 }, LARGE)).toEqual({
			scale: 2,
			x: 424,
			y: -112,
		});
		// The y slack: 1024 tall in 800 is 112 each way; a picture still inside the
		// stage on one axis stays centred on it.
		expect(clampView({ scale: 1.2, x: 50, y: 50 }, LARGE)).toEqual({
			scale: 1.2,
			x: 14.4,
			y: 0,
		});
		expect(clampView({ scale: 0.3, x: 5, y: 5 }, LARGE)).toEqual(FIT_VIEW);
	});

	it("zooms about the point under the pointer", () => {
		// The point 200 px right of centre is picture point 200 at 1x; at 2x it
		// would be at 400, so the picture moves left 200 to keep it under the pointer.
		const view = zoomAbout(FIT_VIEW, 2, { x: 200, y: 0 }, LARGE);
		expect(view).toEqual({ scale: 2, x: -200, y: 0 });
	});

	it("clamps the scale it is asked for", () => {
		expect(zoomAbout(FIT_VIEW, 99, { x: 0, y: 0 }, LARGE).scale).toBe(4);
		expect(
			zoomAbout({ scale: 2, x: 0, y: 0 }, 0.1, { x: 0, y: 0 }, LARGE),
		).toEqual(FIT_VIEW);
	});

	it("toggles fit and 100% on a double click, about the point", () => {
		const actual = toggleFitActual(FIT_VIEW, { x: 100, y: 50 }, LARGE);
		expect(actual).toEqual({ scale: 2, x: -100, y: -50 });
		expect(toggleFitActual(actual, { x: 0, y: 0 }, LARGE)).toEqual(FIT_VIEW);
	});

	it("goes to 2x where 100% is fit, so the double click always does something", () => {
		expect(toggleFitActual(FIT_VIEW, { x: 0, y: 0 }, SMALL).scale).toBe(2);
	});

	it("steps the keyboard zoom about the centre, back to fit at most", () => {
		const inOnce = stepZoom(FIT_VIEW, 1, LARGE);
		expect(inOnce.scale).toBeCloseTo(1.25);
		expect(inOnce.x).toBe(0);
		expect(stepZoom(inOnce, -1, LARGE).scale).toBeCloseTo(1);
		expect(stepZoom(FIT_VIEW, -1, LARGE)).toEqual(FIT_VIEW);
	});

	it("pans by a drag, within the picture", () => {
		const zoomed = { scale: 2, x: 0, y: 0 };
		expect(panBy(zoomed, 100, -30, LARGE)).toEqual({
			scale: 2,
			x: 100,
			y: -30,
		});
		expect(panBy(zoomed, 5000, 0, LARGE).x).toBe(424);
		// At fit there is nothing to pan.
		expect(panBy(FIT_VIEW, 100, 100, LARGE)).toEqual(FIT_VIEW);
	});

	it("reads the wheel: up zooms in, down zooms out, line mode counts like pixels", () => {
		expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
		expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
		expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0));
		// One wild wheel event never jumps more than one notch.
		expect(wheelZoomFactor(-100000, 0)).toBeLessThanOrEqual(1.5);
	});

	it("says the zoom as a share of the picture's own size", () => {
		expect(zoomPercent(FIT_VIEW, LARGE)).toBe(50);
		expect(zoomPercent({ scale: 2, x: 0, y: 0 }, LARGE)).toBe(100);
		expect(zoomPercent(FIT_VIEW, SMALL)).toBe(100);
	});
});
