import { describe, expect, it } from "vitest";
import {
	buildPromptGraph,
	GRAPH_TEMPLATES,
	type GraphName,
	type GraphSlot,
	type GraphTemplate,
	QWEN_CFG,
	QWEN_STEPS,
} from "./templates";

const NAMES = Object.keys(GRAPH_TEMPLATES) as GraphName[];
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
