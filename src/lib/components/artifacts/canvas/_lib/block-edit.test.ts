import { describe, expect, it } from "vitest";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import {
	editPatch,
	shownTitle,
	sourceProblem,
	sourceToEdit,
	sourceToKeep,
	titleFieldOf,
} from "./block-edit";

// What changing a block after it was inserted checks and writes: the block's own
// schema judges a source, and an Edit that changed nothing writes nothing.

const BAR = JSON.stringify({
	type: "bar",
	data: { labels: ["A", "B"], datasets: [{ data: [1, 2] }] },
});

const chart = (extra: Record<string, unknown> = {}): CanvasBlockData =>
	({ kind: "chart", code: BAR, ...extra }) as CanvasBlockData;
const FLOW = "flowchart TD\n  A --> B";
const diagram = (code = FLOW): CanvasBlockData => ({ kind: "mermaid", code });

describe("the title of each block that has one", () => {
	it("is an App's `title` and every other block's `label`", () => {
		expect(titleFieldOf("app")).toBe("title");
		for (const kind of [
			"chart",
			"mermaid",
			"checklist",
			"map",
			"photo",
		] as const) {
			expect(titleFieldOf(kind)).toBe("label");
		}
	});

	it("is what the header says: a map without a title of its own says its route", () => {
		expect(shownTitle("chart", chart({ label: "Sales" }))).toBe("Sales");
		expect(shownTitle("chart", chart())).toBe("");
		const map = {
			kind: "map",
			route: "Cork → Kinsale",
			map: {},
		} as unknown as CanvasBlockData;
		expect(shownTitle("map", map)).toBe("Cork → Kinsale");
		expect(
			shownTitle("map", { ...map, label: "Day trip" } as CanvasBlockData),
		).toBe("Day trip");
		expect(
			shownTitle("app", { kind: "app", artifactId: "a", title: "Tips" }),
		).toBe("Tips");
	});
});

describe("a source", () => {
	it("is refused when the block's own schema would refuse it: empty, or past its limit", () => {
		expect(sourceProblem("chart", "")).toBe("empty");
		expect(sourceProblem("chart", "   \n ")).toBe("empty");
		expect(sourceProblem("mermaid", "")).toBe("empty");
		expect(sourceProblem("chart", "x".repeat(100_001))).toBe("tooLong");
		expect(sourceProblem("mermaid", "x".repeat(50_001))).toBe("tooLong");
	});

	it("is, for a chart, a config the chat's chart can draw: JSON with a type and data", () => {
		expect(sourceProblem("chart", BAR)).toBeNull();
		expect(sourceProblem("chart", "{ not a chart")).toBe("notChart");
		expect(sourceProblem("chart", "[1, 2, 3]")).toBe("notChart");
		expect(sourceProblem("chart", '{"type":"bar"}')).toBe("notChart");
		expect(sourceProblem("chart", '{"data":{}}')).toBe("notChart");
		// The chat's own tolerance for a config one closing brace short.
		expect(sourceProblem("chart", BAR.slice(0, -1))).toBeNull();
	});

	it("is, for a diagram, any text: Mermaid is the judge of its syntax, as it is in the chat", () => {
		expect(sourceProblem("mermaid", "this is not mermaid at all")).toBeNull();
		expect(sourceProblem("mermaid", "flowchart TD\n A --> B")).toBeNull();
	});

	it("is shown over lines when it is a chart's plain JSON, and kept on one line again", () => {
		const shown = sourceToEdit("chart", BAR);
		expect(shown.split("\n").length).toBeGreaterThan(5);
		expect(sourceToKeep("chart", shown)).toBe(BAR);
		// Anything else is as it is, in both directions.
		expect(sourceToEdit("chart", "{ nope")).toBe("{ nope");
		expect(sourceToKeep("chart", "{ nope")).toBe("{ nope");
		expect(sourceToEdit("mermaid", "[1]")).toBe("[1]");
		expect(sourceToKeep("mermaid", "  a\n b ")).toBe("  a\n b ");
	});
});

describe("what an Edit writes", () => {
	it("is nothing when nothing changed, however the source was laid out for the form", () => {
		expect(
			editPatch("chart", chart({ label: "Sales" }), {
				title: "Sales",
				source: sourceToEdit("chart", BAR),
			}),
		).toBeNull();
		expect(
			editPatch("mermaid", diagram(), { title: "", source: FLOW }),
		).toBeNull();
		expect(
			editPatch("checklist", { kind: "checklist", items: [] }, { title: " " }),
		).toBeNull();
	});

	it("is only the fields that changed: a title, a source, or both", () => {
		expect(
			editPatch("chart", chart(), {
				title: "  Visits ",
				source: sourceToEdit("chart", BAR),
			}),
		).toEqual({ label: "Visits" });
		const line = JSON.stringify({ type: "line", data: { datasets: [] } });
		expect(
			editPatch("chart", chart({ label: "Sales" }), {
				title: "Sales",
				source: JSON.stringify(JSON.parse(line), null, 4),
			}),
		).toEqual({ code: line });
		expect(
			editPatch("mermaid", diagram(), {
				title: "Flow",
				source: "flowchart TD\n  A --> C",
			}),
		).toEqual({ label: "Flow", code: "flowchart TD\n  A --> C" });
	});

	it("takes a cleared title back to none (an App's is always a string), and a map's untouched route is not written as a title", () => {
		expect(
			editPatch("chart", chart({ label: "Sales" }), { title: "" }),
		).toEqual({
			label: undefined,
		});
		expect(
			editPatch(
				"app",
				{ kind: "app", artifactId: "a", title: "Tips" },
				{ title: "" },
			),
		).toEqual({ title: "" });
		const map = {
			kind: "map",
			route: "Cork → Kinsale",
			map: {
				mode: "drive",
				distanceM: 1,
				durationS: 1,
				bounds: { minLat: 1, minLng: 1, maxLat: 2, maxLng: 2 },
				markers: [],
				polyline: [],
				attribution: "",
			},
		} as unknown as CanvasBlockData;
		expect(editPatch("map", map, { title: "Cork → Kinsale" })).toBeNull();
	});

	it("is nothing a schema would refuse: an empty source, a title past the limit", () => {
		expect(editPatch("chart", chart(), { title: "", source: "" })).toBeNull();
		expect(
			editPatch("chart", chart(), {
				title: "t".repeat(501),
				source: sourceToEdit("chart", BAR),
			}),
		).toBeNull();
	});
});
