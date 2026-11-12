import { describe, expect, it } from "vitest";
import {
	buildPromptGraph,
	GRAPH_TEMPLATES,
	GRAPH_TEMPLATES_BY_MODEL,
	type GraphName,
	type GraphSlot,
	type GraphTemplate,
	H3_CFG,
	H3_STEPS,
	QWEN_CFG,
	QWEN_STEPS,
} from "./templates";

const NAMES = Object.keys(GRAPH_TEMPLATES) as GraphName[];
const H3_NAMES = Object.keys(GRAPH_TEMPLATES_BY_MODEL.h3) as GraphName[];
const DEFAULT_IMAGE_REFERENCE_CAP = 4;

function template(name: GraphName): GraphTemplate {
	const found = GRAPH_TEMPLATES[name];
	if (!found) throw new Error(`no template ${name}`);
	return found;
}

describe("installed Qwen-Image 2.1 graphs", () => {
	it("registers generate, edit and the transparent generate", () => {
		expect(NAMES.sort()).toEqual(["edit", "generate", "generate-transparent"]);
	});

	it.each(NAMES)("%s: every slot names a node and input that exist", (name) => {
		const t = template(name);
		const slots: GraphSlot[] = [
			t.slots.prompt,
			t.slots.seed,
			t.slots.steps,
			t.slots.cfg,
		];
		if (t.slots.width) slots.push(t.slots.width);
		if (t.slots.height) slots.push(t.slots.height);
		for (const image of t.slots.images) slots.push(image.encoderInput);
		for (const slot of slots) {
			expect(t.graph[slot.node], `node ${slot.node}`).toBeDefined();
			expect(slot.input in t.graph[slot.node].inputs).toBe(true);
		}
	});

	it.each(NAMES)("%s: ends in PreviewImage fed by the decoder", (name) => {
		const t = template(name);
		const output = t.graph[t.slots.output];
		expect(output.class_type).toBe("PreviewImage");
		const source = (output.inputs.images as [string, number])[0];
		expect(t.graph[source].class_type).toBe("VAEDecode");
	});

	it.each(NAMES)("%s: uses the installed model files", (name) => {
		const t = template(name);
		const files = Object.values(t.graph).flatMap((node) =>
			Object.entries(node.inputs)
				.filter(([key]) => ["unet_name", "clip_name", "vae_name"].includes(key))
				.map(([, value]) => value),
		);
		expect(files.sort()).toEqual([
			"qwen3vl_8b_int8_convrot.safetensors",
			"qwen_image_2.1_int8_convrot.safetensors",
			"qwen_image_2.1_vae_bf16.safetensors",
		]);
	});

	it("edit: each image slot's encoder input is the link to its LoadImage", () => {
		const t = template("edit");
		expect(t.slots.images.length).toBeGreaterThanOrEqual(
			DEFAULT_IMAGE_REFERENCE_CAP,
		);
		for (const image of t.slots.images) {
			expect(t.graph[image.load].class_type).toBe("LoadImage");
			expect(
				t.graph[image.encoderInput.node].inputs[image.encoderInput.input],
			).toEqual([image.load, 0]);
			expect(t.graph[image.encoderInput.node].class_type).toBe(
				"TextEncodeQwenImage21",
			);
		}
	});

	it.each(NAMES)("%s: buildPromptGraph writes 30 steps and CFG 1", (name) => {
		const t = template(name);
		const graph = buildPromptGraph(t, {
			prompt: "p",
			seed: 3,
			width: 1248,
			height: 832,
			images: t.slots.images.length > 0 ? ["a.png"] : [],
		});
		const sampler = graph[t.slots.steps.node].inputs;
		expect(sampler.steps).toBe(QWEN_STEPS);
		expect(sampler.cfg).toBe(QWEN_CFG);
		expect(sampler.steps).toBe(30);
		expect(sampler.cfg).toBe(1);
	});

	it("edit: a partial fill leaves no dangling links", () => {
		const t = template("edit");
		const graph = buildPromptGraph(t, {
			prompt: "p",
			seed: 3,
			images: ["a.png", "b.png"],
		});
		for (const node of Object.values(graph)) {
			for (const value of Object.values(node.inputs)) {
				if (Array.isArray(value))
					expect(graph[value[0] as string]).toBeDefined();
			}
		}
	});
});

describe("installed MiniMax-H3-Image graphs", () => {
	it("registers generate and edit only; the transparent names are Qwen's", () => {
		expect(H3_NAMES.sort()).toEqual(["edit", "generate"]);
		expect(GRAPH_TEMPLATES_BY_MODEL.h3["generate-transparent"]).toBeUndefined();
		expect(GRAPH_TEMPLATES_BY_MODEL.h3["edit-transparent"]).toBeUndefined();
		expect(NAMES).toContain("generate-transparent");
	});

	it.each(
		H3_NAMES,
	)("%s: every slot names a node and input that exist", (name) => {
		const t = GRAPH_TEMPLATES_BY_MODEL.h3[name] as GraphTemplate;
		const slots: GraphSlot[] = [
			t.slots.prompt,
			t.slots.seed,
			t.slots.steps,
			t.slots.cfg,
		];
		if (t.slots.width) slots.push(t.slots.width);
		if (t.slots.height) slots.push(t.slots.height);
		for (const image of t.slots.images) slots.push(image.encoderInput);
		for (const slot of slots) {
			expect(t.graph[slot.node], `node ${slot.node}`).toBeDefined();
			expect(slot.input in t.graph[slot.node].inputs).toBe(true);
		}
		expect(t.graph[t.slots.output].class_type).toBe("PreviewImage");
		const source = (
			t.graph[t.slots.output].inputs.images as [string, number]
		)[0];
		expect(t.graph[source].class_type).toBe("VAEDecode");
	});

	it.each(
		H3_NAMES,
	)("%s: uses the installed H3 model files and node set", (name) => {
		const t = GRAPH_TEMPLATES_BY_MODEL.h3[name] as GraphTemplate;
		const files = Object.values(t.graph).flatMap((node) =>
			Object.entries(node.inputs)
				.filter(([key]) => ["unet_name", "clip_name", "vae_name"].includes(key))
				.map(([, value]) => value),
		);
		expect(files.sort()).toEqual([
			"minimax_h3_image_pruned_int8_convrot.safetensors",
			"minimax_h3_image_vae_fp16.safetensors",
			"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
		]);
		const classes = new Set(
			Object.values(t.graph).map((node) => node.class_type),
		);
		for (const expected of [
			"UNETLoader",
			"CLIPLoader",
			"VAELoader",
			"MiniMaxH3ImageConditioning",
			"ConditioningZeroOut",
			"KSampler",
			"VAEDecode",
			"PreviewImage",
		]) {
			expect(classes.has(expected), expected).toBe(true);
		}
		expect(classes.has("SaveImage")).toBe(false);
		expect(classes.has("TextEncodeQwenImage21")).toBe(false);
		const clip = Object.values(t.graph).find(
			(node) => node.class_type === "CLIPLoader",
		);
		expect(clip?.inputs.type).toBe("minimax");
	});

	it.each(H3_NAMES)("%s: buildPromptGraph writes 6 steps and CFG 1", (name) => {
		const t = GRAPH_TEMPLATES_BY_MODEL.h3[name] as GraphTemplate;
		const graph = buildPromptGraph(t, {
			prompt: "p",
			seed: 3,
			width: 2496,
			height: 1664,
			images: t.slots.images.length > 0 ? ["a.png"] : [],
		});
		const sampler = graph[t.slots.steps.node].inputs;
		expect(sampler.steps).toBe(H3_STEPS);
		expect(sampler.cfg).toBe(H3_CFG);
		expect(sampler.steps).toBe(6);
		expect(sampler.cfg).toBe(1);
	});

	it("edit: every slot links to its own LoadImage, and a partial fill leaves no dangling links", () => {
		const t = GRAPH_TEMPLATES_BY_MODEL.h3.edit as GraphTemplate;
		expect(t.slots.images).toHaveLength(10);
		for (const image of t.slots.images) {
			expect(t.graph[image.load].class_type).toBe("LoadImage");
			expect(
				t.graph[image.encoderInput.node].inputs[image.encoderInput.input],
			).toEqual([image.load, 0]);
			expect(t.graph[image.encoderInput.node].class_type).toBe(
				"MiniMaxH3ImageConditioning",
			);
		}
		const graph = buildPromptGraph(t, {
			prompt: "p",
			seed: 3,
			images: ["a.png", "b.png"],
		});
		for (const node of Object.values(graph)) {
			for (const value of Object.values(node.inputs)) {
				if (Array.isArray(value))
					expect(graph[value[0] as string]).toBeDefined();
			}
		}
		expect(t.graph[t.slots.images[0].load].inputs.image).toBe("");
	});
});
