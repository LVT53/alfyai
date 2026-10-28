/**
 * ComfyUI graph templates for Qwen-Image 2.1, API format, flattened from the
 * installed server's own templates (ComfyUI v0.43.0, workflow templates 0.11.97:
 * image_qwen_image_2_1_t2i / image_qwen_image_2_1_image_edit). Installed files:
 * diffusion `qwen_image_2.1_int8_convrot.safetensors`, text encoder
 * `qwen3vl_8b_int8_convrot.safetensors` (type qwen_image), VAE
 * `qwen_image_2.1_vae_bf16.safetensors`. The edit graph has 10 picture slots (the
 * template's own `images.image_1`..`image_10` encoder inputs). Both end in
 * PreviewImage. The slot map names nodes and inputs and is held by
 * templates.contract.test.ts.
 */
import editGraph from "./graphs/qwen-image-2.1-edit.api.json";
import generateGraph from "./graphs/qwen-image-2.1-generate.api.json";
import type { ComfyGraph } from "./types";

export type GraphName =
	| "generate"
	| "edit"
	| "generate-transparent"
	| "edit-transparent";
export type GraphSlot = { node: string; input: string };
export type GraphTemplate = {
	name: GraphName;
	graph: ComfyGraph;
	slots: {
		prompt: GraphSlot;
		seed: GraphSlot;
		steps: GraphSlot;
		cfg: GraphSlot;
		width?: GraphSlot;
		height?: GraphSlot;
		images: Array<{ load: string; encoderInput: GraphSlot }>;
		output: string;
	};
	/** Rewrites the prompt before it is written (the transparent route's RGBA wrap). */
	wrapPrompt?: (prompt: string) => string;
};

/**
 * The installed t2i template's own note: a transparent picture comes from the
 * same graph with this wrap, and PreviewImage keeps the real alpha channel
 * (measured in results-part-2-server.md).
 */
export function wrapTransparentPrompt(prompt: string): string {
	return `This is an RGBA format image with transparency. ${prompt} The image has an alpha channel and a transparent background.`;
}

/**
 * 20 steps, measured on the installed Qwen-Image 2.1 weights (NoctQ V4, int8
 * convrot) at 1248x832 on 2026-10-29. Halving from 40 halves the wall time —
 * 9.7 s -> 5.2 s generate, 11.7 s -> 7.8 s edit — with no visible loss on a
 * portrait or a text-render prompt. 16 is the comfortable floor; 8 is where
 * lettering collapses into smears. The graph JSONs keep the installed
 * template's own 40 and this constant overwrites it in buildPromptGraph.
 * CFG stays 1: the model card's 25 steps at CFG 3 plus a negative prompt cost
 * twice as much, gained nothing, and produced artifacts (an engraved mug, a
 * duplicated pen, a malformed collar), so the negative prompt stays unused.
 */
export const QWEN_STEPS = 20;
export const QWEN_CFG = 1;

export const GRAPH_TEMPLATES: Partial<Record<GraphName, GraphTemplate>> = {
	generate: {
		name: "generate",
		graph: generateGraph as ComfyGraph,
		slots: {
			prompt: { node: "5", input: "prompt" },
			seed: { node: "7", input: "seed" },
			steps: { node: "7", input: "steps" },
			cfg: { node: "7", input: "cfg" },
			width: { node: "6", input: "width" },
			height: { node: "6", input: "height" },
			images: [],
			output: "9",
		},
	},
	"generate-transparent": {
		name: "generate-transparent",
		graph: generateGraph as ComfyGraph,
		slots: {
			prompt: { node: "5", input: "prompt" },
			seed: { node: "7", input: "seed" },
			steps: { node: "7", input: "steps" },
			cfg: { node: "7", input: "cfg" },
			width: { node: "6", input: "width" },
			height: { node: "6", input: "height" },
			images: [],
			output: "9",
		},
		wrapPrompt: wrapTransparentPrompt,
	},
	edit: {
		name: "edit",
		graph: editGraph as ComfyGraph,
		slots: {
			prompt: { node: "5", input: "prompt" },
			seed: { node: "7", input: "seed" },
			steps: { node: "7", input: "steps" },
			cfg: { node: "7", input: "cfg" },
			width: { node: "6", input: "width" },
			height: { node: "6", input: "height" },
			images: Array.from({ length: 10 }, (_, index) => ({
				load: String(11 + index),
				encoderInput: { node: "5", input: `images.image_${index + 1}` },
			})),
			output: "9",
		},
	},
};

/** The runner maps this to the failure code `image_graph_rejected` (not retryable). */
export class GraphBuildError extends Error {
	readonly code = "image_graph_rejected" as const;
	constructor(message: string) {
		super(message);
		this.name = "GraphBuildError";
	}
}

/** How many pictures the template can carry (the hard per-call limit). */
export function imageSlotCount(template: GraphTemplate): number {
	return template.slots.images.length;
}

export function graphFor(
	mode: "generate" | "edit",
	transparent: boolean,
): { template: GraphTemplate; transparentApplied: boolean } | null {
	if (transparent) {
		const special = GRAPH_TEMPLATES[`${mode}-transparent`];
		if (special) return { template: special, transparentApplied: true };
	}
	const plain = GRAPH_TEMPLATES[mode];
	return plain ? { template: plain, transparentApplied: false } : null;
}

function isRefTo(value: unknown, nodeId: string): boolean {
	return Array.isArray(value) && value[0] === nodeId;
}

function put(graph: ComfyGraph, slot: GraphSlot, value: unknown): void {
	const node = graph[slot.node];
	if (!node) throw new GraphBuildError(`Graph has no node ${slot.node}`);
	node.inputs[slot.input] = value;
}

export function buildPromptGraph(
	template: GraphTemplate,
	values: {
		prompt: string;
		seed: number;
		width?: number;
		height?: number;
		images: string[];
	},
): ComfyGraph {
	const { slots } = template;
	const wanted = values.images.length;
	if (wanted > slots.images.length) {
		throw new GraphBuildError(
			`Graph ${template.name} takes ${slots.images.length} pictures, got ${wanted}`,
		);
	}
	if (slots.images.length > 0 && wanted === 0) {
		throw new GraphBuildError(
			`Graph ${template.name} needs at least one picture`,
		);
	}
	if (slots.images.length === 0 && wanted > 0) {
		throw new GraphBuildError(`Graph ${template.name} takes no pictures`);
	}
	const graph = structuredClone(template.graph);
	put(
		graph,
		slots.prompt,
		template.wrapPrompt ? template.wrapPrompt(values.prompt) : values.prompt,
	);
	put(graph, slots.seed, values.seed);
	put(graph, slots.steps, QWEN_STEPS);
	put(graph, slots.cfg, QWEN_CFG);
	if (slots.width && values.width !== undefined)
		put(graph, slots.width, values.width);
	if (slots.height && values.height !== undefined)
		put(graph, slots.height, values.height);

	slots.images.forEach((slot, index) => {
		if (index < wanted) {
			put(graph, { node: slot.load, input: "image" }, values.images[index]);
			return;
		}
		delete graph[slot.load];
		// Drop every input that pointed at the removed load node (the positive
		// and negative encoders both carry it).
		for (const node of Object.values(graph)) {
			for (const [key, value] of Object.entries(node.inputs)) {
				if (isRefTo(value, slot.load)) delete node.inputs[key];
			}
		}
		const encoder = graph[slot.encoderInput.node];
		if (encoder) delete encoder.inputs[slot.encoderInput.input];
	});
	return graph;
}
