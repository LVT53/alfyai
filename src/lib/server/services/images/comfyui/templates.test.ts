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
		expect(QWEN_STEPS).toBe(40);
		expect(QWEN_CFG).toBe(1);
		expect(t.slots.width && read(g, t.slots.width)).toBe(1248);
		expect(t.slots.height && read(g, t.slots.height)).toBe(832);
	});

	it("keeps 2 LoadImage nodes for 2 pictures and drops the third with its encoder key", () => {
		const t = edit();
		expect(imageSlotCount(t)).toBe(3);
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
				images: ["1", "2", "3", "4"],
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

describe("reference templates", () => {
	it.each([
		"generate",
		"edit",
	] as const)("%s: every slot names a node and input that exist", (name) => {
		const t = GRAPH_TEMPLATES[name] as GraphTemplate;
		const slots: GraphSlot[] = [
			t.slots.prompt,
			t.slots.seed,
			t.slots.steps,
			t.slots.cfg,
		];
		if (t.slots.width) slots.push(t.slots.width);
		if (t.slots.height) slots.push(t.slots.height);
		for (const img of t.slots.images) slots.push(img.encoderInput);
		for (const s of slots)
			expect(s.input in (t.graph[s.node]?.inputs ?? {})).toBe(true);
		for (const img of t.slots.images)
			expect(t.graph[img.load].class_type).toBe("LoadImage");
		expect(t.graph[t.slots.output].class_type).toBe("PreviewImage");
	});
});
