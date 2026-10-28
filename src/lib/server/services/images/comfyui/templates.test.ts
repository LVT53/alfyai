import { describe, expect, it } from "vitest";
import {
	buildPromptGraph,
	GRAPH_TEMPLATES,
	GraphBuildError,
	type GraphSlot,
	type GraphTemplate,
	graphFor,
	imageSlotCount,
	QWEN_CFG,
	QWEN_STEPS,
} from "./templates";

function edit(): GraphTemplate {
	const found = graphFor("edit", false);
	if (!found) throw new Error("no edit template");
	return found.template;
}
function generate(): GraphTemplate {
	const found = graphFor("generate", false);
	if (!found) throw new Error("no generate template");
	return found.template;
}
function read(graph: GraphTemplate["graph"], slot: GraphSlot): unknown {
	return graph[slot.node].inputs[slot.input];
}

describe("buildPromptGraph", () => {
	it("writes prompt, seed, steps, cfg and canvas into their slots", () => {
		const t = generate();
		const g = buildPromptGraph(t, {
			prompt: "a cat",
			seed: 77,
			width: 1248,
			height: 832,
			images: [],
		});
		expect(read(g, t.slots.prompt)).toBe("a cat");
		expect(read(g, t.slots.seed)).toBe(77);
		expect(read(g, t.slots.steps)).toBe(QWEN_STEPS);
		expect(read(g, t.slots.cfg)).toBe(QWEN_CFG);
		expect(QWEN_STEPS).toBe(20);
		expect(QWEN_CFG).toBe(1);
		expect(t.slots.width && read(g, t.slots.width)).toBe(1248);
		expect(t.slots.height && read(g, t.slots.height)).toBe(832);
	});

	it("keeps 2 LoadImage nodes for 2 pictures and drops the third with its encoder key", () => {
		const t = edit();
		expect(imageSlotCount(t)).toBe(10);
		const g = buildPromptGraph(t, {
			prompt: "x",
			seed: 5,
			images: ["a.png", "b.png"],
		});
		const loads = Object.entries(g).filter(
			([, n]) => n.class_type === "LoadImage",
		);
		expect(loads.map(([, n]) => n.inputs.image)).toEqual(["a.png", "b.png"]);
		const third = t.slots.images[2];
		expect(g[third.load]).toBeUndefined();
		expect(third.encoderInput.input in g[third.encoderInput.node].inputs).toBe(
			false,
		);
		expect(
			t.slots.images[1].encoderInput.input in
				g[t.slots.images[1].encoderInput.node].inputs,
		).toBe(true);
	});

	it("throws a coded GraphBuildError for too many or no pictures in an edit", () => {
		const t = edit();
		const many = () =>
			buildPromptGraph(t, {
				prompt: "x",
				seed: 1,
				images: Array.from({ length: 11 }, (_, i) => String(i)),
			});
		expect(many).toThrow(GraphBuildError);
		try {
			many();
		} catch (e) {
			expect((e as GraphBuildError).code).toBe("image_graph_rejected");
		}
		expect(() =>
			buildPromptGraph(t, { prompt: "x", seed: 1, images: [] }),
		).toThrow(GraphBuildError);
	});

	it("does not change the template", () => {
		const t = edit();
		const before = JSON.stringify(t.graph);
		buildPromptGraph(t, {
			prompt: "x",
			seed: 9,
			width: 640,
			height: 640,
			images: ["a.png"],
		});
		expect(JSON.stringify(t.graph)).toBe(before);
	});
});

describe("graphFor", () => {
	it("uses the transparent generate template, which wraps the prompt", () => {
		const r = graphFor("generate", true);
		expect(r?.template.name).toBe("generate-transparent");
		expect(r?.transparentApplied).toBe(true);
		const t = r?.template as GraphTemplate;
		const g = buildPromptGraph(t, { prompt: "a mug.", seed: 1, images: [] });
		expect(read(g, t.slots.prompt)).toBe(
			"This is an RGBA format image with transparency. a mug. The image has an alpha channel and a transparent background.",
		);
	});
	it("falls back to the plain edit template when no transparent one exists", () => {
		const r = graphFor("edit", true);
		expect(r?.template.name).toBe("edit");
		expect(r?.transparentApplied).toBe(false);
	});
	it("picks the plain generate template", () => {
		expect(graphFor("generate", false)).toEqual({
			template: GRAPH_TEMPLATES.generate,
			transparentApplied: false,
		});
	});
});
