import { describe, expect, it } from "vitest";
import {
	buildPromptGraph,
	GRAPH_TEMPLATES,
	GRAPH_TEMPLATES_BY_MODEL,
	GraphBuildError,
	type GraphSlot,
	type GraphTemplate,
	graphFor,
	H3_CFG,
	H3_STEPS,
	imageSlotCount,
	QWEN_CFG,
	QWEN_STEPS,
} from "./templates";

function edit(model: "qwen" | "h3" = "qwen"): GraphTemplate {
	const found = graphFor(model, "edit", false);
	if (!found) throw new Error("no edit template");
	return found.template;
}
function generate(model: "qwen" | "h3" = "qwen"): GraphTemplate {
	const found = graphFor(model, "generate", false);
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
		expect(QWEN_STEPS).toBe(30);
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
		const r = graphFor("qwen", "generate", true);
		expect(r?.template.name).toBe("generate-transparent");
		expect(r?.transparentApplied).toBe(true);
		const t = r?.template as GraphTemplate;
		const g = buildPromptGraph(t, { prompt: "a mug.", seed: 1, images: [] });
		expect(read(g, t.slots.prompt)).toBe(
			"This is an RGBA format image with transparency. a mug. The image has an alpha channel and a transparent background.",
		);
	});
	it("falls back to the plain edit template when no transparent one exists", () => {
		const r = graphFor("qwen", "edit", true);
		expect(r?.template.name).toBe("edit");
		expect(r?.transparentApplied).toBe(false);
	});
	it("picks the plain generate template", () => {
		expect(graphFor("qwen", "generate", false)).toEqual({
			template: GRAPH_TEMPLATES.generate,
			transparentApplied: false,
		});
	});
	it("has no transparent H3 path: H3 transparency answers null, never a Qwen fallback", () => {
		expect(graphFor("h3", "generate", true)).toBeNull();
		expect(graphFor("h3", "edit", true)).toBeNull();
	});
});

describe("MiniMax-H3-Image graphs", () => {
	it("registers generate and edit only, with no transparent graph names", () => {
		expect(Object.keys(GRAPH_TEMPLATES_BY_MODEL.h3).sort()).toEqual([
			"edit",
			"generate",
		]);
		expect(GRAPH_TEMPLATES_BY_MODEL.h3["generate-transparent"]).toBeUndefined();
		expect(GRAPH_TEMPLATES_BY_MODEL.h3["edit-transparent"]).toBeUndefined();
	});

	it("generates through MiniMaxH3ImageConditioning with a zeroed negative, 6 steps and CFG 1", () => {
		const t = generate("h3");
		const g = buildPromptGraph(t, {
			prompt: "a cat",
			seed: 77,
			width: 2496,
			height: 1664,
			images: [],
		});
		const classes = Object.values(g).map((node) => node.class_type);
		expect(classes).toContain("MiniMaxH3ImageConditioning");
		expect(classes).toContain("ConditioningZeroOut");
		expect(classes).toContain("PreviewImage");
		expect(classes).not.toContain("TextEncodeQwenImage21");
		expect(classes).not.toContain("SaveImage");
		expect(read(g, t.slots.prompt)).toBe("a cat");
		expect(read(g, t.slots.seed)).toBe(77);
		expect(t.steps).toBe(H3_STEPS);
		expect(t.cfg).toBe(H3_CFG);
		expect(read(g, t.slots.steps)).toBe(6);
		expect(read(g, t.slots.cfg)).toBe(1);
		expect(t.slots.width && read(g, t.slots.width)).toBe(2496);
		expect(t.slots.height && read(g, t.slots.height)).toBe(1664);
		// The sampler's positive is the H3 conditioning; its negative is the
		// zeroed-out copy of it.
		const zero = Object.entries(g).find(
			([, node]) => node.class_type === "ConditioningZeroOut",
		);
		if (!zero) throw new Error("no zero-out node");
		expect(g[t.slots.steps.node].inputs.positive).toEqual([
			t.slots.prompt.node,
			0,
		]);
		expect(g[t.slots.steps.node].inputs.negative).toEqual([zero[0], 0]);
		expect(g[t.slots.output].class_type).toBe("PreviewImage");
	});

	it("edits with ten picture slots; image_1 is the base and the prompt starts with <Picture 1>", () => {
		const t = edit("h3");
		expect(imageSlotCount(t)).toBe(10);
		const g = buildPromptGraph(t, {
			prompt: "replace the sofa",
			seed: 1,
			width: 2496,
			height: 1664,
			images: ["a.png", "b.png"],
		});
		const loads = Object.entries(g).filter(
			([, node]) => node.class_type === "LoadImage",
		);
		expect(loads.map(([, node]) => node.inputs.image)).toEqual([
			"a.png",
			"b.png",
		]);
		expect(t.slots.images[0]?.encoderInput).toEqual({
			node: t.slots.prompt.node,
			input: "images.image_1",
		});
		expect(t.slots.images[9]?.encoderInput).toEqual({
			node: t.slots.prompt.node,
			input: "images.image_10",
		});
		expect(read(g, t.slots.images[0].encoderInput)).toEqual([
			t.slots.images[0].load,
			0,
		]);
		expect(g[t.slots.images[2].load]).toBeUndefined();
		expect(read(g, t.slots.prompt)).toBe("<Picture 1> replace the sofa");
	});

	it("keeps six steps and CFG 1 from the H3 template, not the Qwen globals", () => {
		expect(QWEN_STEPS).toBe(30);
		expect(H3_STEPS).toBe(6);
		const t = generate("h3");
		const g = buildPromptGraph(t, { prompt: "x", seed: 3, images: [] });
		expect(read(g, t.slots.steps)).toBe(H3_STEPS);
		expect(read(g, t.slots.cfg)).toBe(H3_CFG);
		expect(read(g, t.slots.steps)).not.toBe(QWEN_STEPS);
	});
});
