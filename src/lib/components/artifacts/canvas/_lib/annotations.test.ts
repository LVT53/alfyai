import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "$lib/shared/artifacts/canvas";
import {
	annotationBounds,
	arrowHead,
	baseSize,
	dabPath,
	hitTest,
	normRect,
	pickAnnotation,
	strokePath,
	textWidth,
	translate,
} from "./annotations";
import { DEFAULT_INK, DRAWING_TOOLS, INKS, isDrawingTool } from "./tools";

const pen = (points: { x: number; y: number }[], id = "pen-1"): Annotation => ({
	id,
	kind: "pen",
	color: "var(--ink-blue)",
	size: 4,
	points,
});

const rect = (
	from: { x: number; y: number },
	to: { x: number; y: number },
	id = "rect-1",
): Annotation => ({
	id,
	kind: "rect",
	color: "var(--ink-red)",
	size: 3,
	from,
	to,
});

describe("the tools", () => {
	it("knows the seven marks that draw, and that select, pan and the eraser are not among them", () => {
		expect([...DRAWING_TOOLS]).toEqual([
			"pen",
			"highlighter",
			"line",
			"arrow",
			"rect",
			"ellipse",
			"text",
		]);
		for (const tool of DRAWING_TOOLS) expect(isDrawingTool(tool)).toBe(true);
		for (const tool of ["select", "pan", "eraser"] as const) {
			expect(isDrawingTool(tool)).toBe(false);
		}
	});

	it("gives each tool a size: a fat highlighter, a fine pen, readable text", () => {
		expect(baseSize("pen")).toBe(4);
		expect(baseSize("highlighter")).toBe(14);
		expect(baseSize("line")).toBe(3);
		expect(baseSize("text")).toBeGreaterThanOrEqual(16);
	});

	it("offers four inks, each a colour token of the app, the first being the default", () => {
		expect(INKS.map((ink) => ink.id)).toEqual([
			"blue",
			"red",
			"green",
			"graphite",
		]);
		expect(DEFAULT_INK).toBe(INKS[0].color);
		const css = readFileSync("src/app.css", "utf8");
		for (const ink of INKS) {
			const token = /^var\((--[a-z-]+)\)$/.exec(ink.color)?.[1];
			expect(token, `${ink.id} must be a var(--token)`).toBeTruthy();
			expect(css).toContain(`${token}:`);
		}
	});
});

describe("strokePath", () => {
	it("outlines a stroke as one closed shape", () => {
		const d = strokePath(
			[
				{ x: 0, y: 0 },
				{ x: 20, y: 5 },
				{ x: 40, y: 0 },
			],
			4,
		);
		expect(d.startsWith("M")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
	});

	it("reaches the point the pointer reached, so letting go does not make it jump", () => {
		const points = Array.from({ length: 21 }, (_, i) => ({
			x: i * 5,
			y: Math.sin(i / 4) * 5,
		}));
		const xs = (strokePath(points, 4).match(/-?\d+(\.\d+)?/g) ?? []).map(
			Number,
		);
		expect(Math.max(...xs)).toBeGreaterThanOrEqual(100);
	});

	it("leaves a mark for a single-point click with the pen", () => {
		const d = strokePath([{ x: 10, y: 10 }], 4);
		expect(d.startsWith("M")).toBe(true);
		expect(d.length).toBeGreaterThan(10);
	});

	it("draws nothing for no points at all", () => {
		expect(strokePath([], 4)).toBe("");
	});

	afterEach(() => {
		vi.doUnmock("perfect-freehand");
		vi.resetModules();
	});

	it("falls back to a capsule for a flick the library cannot outline", async () => {
		vi.resetModules();
		vi.doMock("perfect-freehand", () => ({ getStroke: () => [] }));
		const fresh = await import("./annotations");
		const d = fresh.strokePath(
			[
				{ x: 0, y: 0 },
				{ x: 3, y: 0 },
			],
			4,
		);
		expect(d.startsWith("M")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
		// A single point the library cannot outline is a dab.
		expect(fresh.strokePath([{ x: 5, y: 5 }], 4)).toBe(
			fresh.dabPath({ x: 5, y: 5 }, 4),
		);
	});
});

describe("shapes", () => {
	it("dabPath is a filled disc the width of the ink, round about the point", () => {
		const d = dabPath({ x: 10, y: 10 }, 6);
		expect(d.startsWith("M 7 10")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
	});

	it("arrowHead is a triangle whose tip is the arrow's end, pointing the way it travels", () => {
		const d = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 3);
		expect(d.startsWith("M 100 0")).toBe(true);
		// The two other corners sit behind the tip: smaller x.
		const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
		expect(
			numbers
				.slice(2)
				.filter((_, i) => i % 2 === 0)
				.every((x) => x < 100),
		).toBe(true);
	});

	it("arrowHead has nothing to point along when the arrow has no length", () => {
		expect(arrowHead({ x: 5, y: 5 }, { x: 5, y: 5 }, 3)).toBe("");
	});

	it("normRect reads a drag in any direction as the same rectangle", () => {
		const expected = { x: 10, y: 20, width: 30, height: 40 };
		expect(normRect({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected);
		expect(normRect({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected);
		expect(normRect({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected);
	});

	it("textWidth grows with the words and with the size", () => {
		expect(textWidth("", 20)).toBe(0);
		expect(textWidth("hello", 20)).toBeGreaterThan(textWidth("hi", 20));
		expect(textWidth("hello", 40)).toBeGreaterThan(textWidth("hello", 20));
	});
});

describe("annotationBounds", () => {
	it("wraps a stroke, and reaches half its width beyond the centre line", () => {
		const b = annotationBounds(
			pen([
				{ x: 10, y: 20 },
				{ x: 50, y: 60 },
			]),
		);
		expect(b).toEqual({ x: 8, y: 18, width: 44, height: 44 });
	});

	it("wraps a shape whatever the direction it was dragged", () => {
		const b = annotationBounds(rect({ x: 60, y: 90 }, { x: 10, y: 20 }));
		expect(b.x).toBeCloseTo(8.5);
		expect(b.y).toBeCloseTo(18.5);
		expect(b.width).toBeCloseTo(53);
		expect(b.height).toBeCloseTo(73);
	});

	it("wraps a text by its words", () => {
		const t: Annotation = {
			id: "t",
			kind: "text",
			color: "var(--ink-blue)",
			size: 20,
			at: { x: 100, y: 100 },
			text: "Hello",
		};
		const b = annotationBounds(t);
		expect(b.x).toBe(100);
		expect(b.y).toBe(100);
		expect(b.width).toBeCloseTo(textWidth("Hello", 20));
		expect(b.height).toBeGreaterThanOrEqual(20);
	});
});

describe("hitTest", () => {
	const box = rect({ x: 0, y: 0 }, { x: 100, y: 100 });

	it("hits a rectangle on its stroke and not on its fill", () => {
		expect(hitTest(box, { x: 0, y: 50 }, 4)).toBe(true);
		expect(hitTest(box, { x: 100, y: 52 }, 4)).toBe(true);
		expect(hitTest(box, { x: 50, y: 50 }, 4)).toBe(false);
		expect(hitTest(box, { x: 140, y: 50 }, 4)).toBe(false);
	});

	it("hits an ellipse on its outline and not on its middle", () => {
		const ellipse: Annotation = { ...box, id: "e", kind: "ellipse" };
		expect(hitTest(ellipse, { x: 0, y: 50 }, 4)).toBe(true);
		expect(hitTest(ellipse, { x: 50, y: 0 }, 4)).toBe(true);
		expect(hitTest(ellipse, { x: 50, y: 50 }, 4)).toBe(false);
		// A rectangle's corner is not on the ellipse inside it.
		expect(hitTest(ellipse, { x: 0, y: 0 }, 4)).toBe(false);
	});

	it("hits a line and an arrow along their length, within the tolerance", () => {
		const line: Annotation = { ...box, id: "l", kind: "line" };
		expect(hitTest(line, { x: 50, y: 50 }, 4)).toBe(true);
		expect(hitTest(line, { x: 50, y: 60 }, 4)).toBe(false);
		expect(hitTest(line, { x: 50, y: 60 }, 10)).toBe(true);
		const arrow: Annotation = { ...box, id: "a", kind: "arrow" };
		expect(hitTest(arrow, { x: 25, y: 25 }, 4)).toBe(true);
		// Beyond the end of a segment is not on it.
		expect(hitTest(line, { x: 130, y: 130 }, 4)).toBe(false);
	});

	it("hits a pen stroke near its path", () => {
		const stroke = pen([
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 50, y: 50 },
		]);
		expect(hitTest(stroke, { x: 25, y: 3 }, 4)).toBe(true);
		expect(hitTest(stroke, { x: 52, y: 25 }, 4)).toBe(true);
		expect(hitTest(stroke, { x: 20, y: 30 }, 4)).toBe(false);
	});

	it("hits a single-point mark on the dab", () => {
		const dot = pen([{ x: 10, y: 10 }]);
		expect(hitTest(dot, { x: 11, y: 11 }, 4)).toBe(true);
		expect(hitTest(dot, { x: 40, y: 40 }, 4)).toBe(false);
	});

	it("hits a text anywhere in its box", () => {
		const t: Annotation = {
			id: "t",
			kind: "text",
			color: "var(--ink-blue)",
			size: 20,
			at: { x: 100, y: 100 },
			text: "Hello",
		};
		expect(hitTest(t, { x: 110, y: 110 }, 4)).toBe(true);
		expect(hitTest(t, { x: 300, y: 300 }, 4)).toBe(false);
	});
});

describe("pickAnnotation", () => {
	it("picks the newest annotation when two overlap", () => {
		const older = pen(
			[
				{ x: 0, y: 0 },
				{ x: 50, y: 0 },
			],
			"older",
		);
		const newer = pen(
			[
				{ x: 0, y: 0 },
				{ x: 50, y: 0 },
			],
			"newer",
		);
		expect(pickAnnotation([older, newer], { x: 25, y: 0 }, 4)?.id).toBe(
			"newer",
		);
		expect(pickAnnotation([newer, older], { x: 25, y: 0 }, 4)?.id).toBe(
			"older",
		);
	});

	it("is null where nothing is", () => {
		expect(
			pickAnnotation([pen([{ x: 0, y: 0 }])], { x: 200, y: 200 }, 4),
		).toBeNull();
		expect(pickAnnotation([], { x: 0, y: 0 }, 4)).toBeNull();
	});
});

describe("translate", () => {
	it("moves a stroke, a shape and a text alike, and touches nothing else about them", () => {
		const stroke = pen([
			{ x: 1, y: 2 },
			{ x: 3, y: 4 },
		]);
		expect(translate(stroke, 10, 20)).toEqual({
			...stroke,
			points: [
				{ x: 11, y: 22 },
				{ x: 13, y: 24 },
			],
		});
		const box = rect({ x: 0, y: 0 }, { x: 10, y: 10 });
		expect(translate(box, 5, -5)).toEqual({
			...box,
			from: { x: 5, y: -5 },
			to: { x: 15, y: 5 },
		});
		const text: Annotation = {
			id: "t",
			kind: "text",
			color: "var(--ink-blue)",
			size: 20,
			at: { x: 100, y: 100 },
			text: "Hi",
		};
		expect(translate(text, -1, 1)).toEqual({ ...text, at: { x: 99, y: 101 } });
	});

	it("does not change the annotation it was given", () => {
		const stroke = pen([{ x: 1, y: 2 }]);
		const before = JSON.stringify(stroke);
		translate(stroke, 9, 9);
		expect(JSON.stringify(stroke)).toBe(before);
	});
});
