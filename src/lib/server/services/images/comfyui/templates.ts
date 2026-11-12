/**
 * ComfyUI graph templates for the two picture models, API format.
 *
 * Qwen-Image 2.1, flattened from the installed server's own templates (ComfyUI
 * v0.43.0, workflow templates 0.11.97: image_qwen_image_2_1_t2i /
 * image_qwen_image_2_1_image_edit). Installed files: diffusion
 * `qwen_image_2.1_int8_convrot.safetensors`, text encoder
 * `qwen3vl_8b_int8_convrot.safetensors` (type qwen_image), VAE
 * `qwen_image_2.1_vae_bf16.safetensors`. The edit graph has 10 picture slots (the
 * template's own `images.image_1`..`image_10` encoder inputs).
 *
 * MiniMax-H3-Image, flattened from the 0.44 trial's API graph (ComfyUI
 * `ede4e5fe8d`): NVFP4 diffusion `minimax_h3_image_pruned_nvfp4.safetensors`,
 * NVFP4-AWQ text encoder `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (type
 * minimax), VAE `minimax_h3_image_vae_fp16.safetensors`. It is distilled to six
 * steps at CFG 1 and has no transparent path. Its edit graph also has 10
 * `images.image_1`..`image_10` slots, and `image_1` is the picture being changed;
 * H3 refers to pictures as `<Picture N>` in the prompt.
 *
 * Both families end in PreviewImage. The slot map names nodes and inputs and is
 * held by templates.contract.test.ts.
 */
import type { ImageModel } from "$lib/server/config-store";
import h3EditGraph from "./graphs/h3-image-edit.api.json";
import h3GenerateGraph from "./graphs/h3-image-generate.api.json";
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
	/** The model's own sampling schedule; buildPromptGraph writes these. */
	steps: number;
	cfg: number;
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
	/** Rewrites the prompt before it is written (the transparent or `<Picture N>` wrap). */
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
 * 30 steps on the installed Qwen-Image 2.1 weights (NoctQ V4, int8 convrot) at
 * 1248x832: quality plateaus by 20 and 40 doubles the wall time for no visible
 * gain, so 30 keeps margin above the 16-step floor while staying about a
 * quarter under 40. CFG stays 1 — raising it cost twice as much and produced
 * artifacts. The graph JSONs keep the installed template's own 40 and this
 * constant overwrites it in buildPromptGraph.
 */
export const QWEN_STEPS = 30;
export const QWEN_CFG = 1;

/**
 * MiniMax-H3-Image is distilled to six steps at CFG 1 and has no negative
 * prompt; the sampler's negative is a zeroed copy of the H3 conditioning.
 */
export const H3_STEPS = 6;
export const H3_CFG = 1;

/** H3 refers to its pictures as `<Picture 1>`, `<Picture 2>`…; image_1 is the base. */
export function wrapH3EditPrompt(prompt: string): string {
	return `<Picture 1> ${prompt}`;
}

export const GRAPH_TEMPLATES: Partial<Record<GraphName, GraphTemplate>> = {
	generate: {
		name: "generate",
		graph: generateGraph as ComfyGraph,
		steps: QWEN_STEPS,
		cfg: QWEN_CFG,
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
		steps: QWEN_STEPS,
		cfg: QWEN_CFG,
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
		steps: QWEN_STEPS,
		cfg: QWEN_CFG,
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

/** H3 registers generate and edit only: there is no transparent graph, and no fallback to one. */
export const H3_GRAPH_TEMPLATES: Partial<Record<GraphName, GraphTemplate>> = {
	generate: {
		name: "generate",
		graph: h3GenerateGraph as ComfyGraph,
		steps: H3_STEPS,
		cfg: H3_CFG,
		slots: {
			prompt: { node: "4", input: "prompt" },
			seed: { node: "6", input: "seed" },
			steps: { node: "6", input: "steps" },
			cfg: { node: "6", input: "cfg" },
			width: { node: "4", input: "width" },
			height: { node: "4", input: "height" },
			images: [],
			output: "8",
		},
	},
	edit: {
		name: "edit",
		graph: h3EditGraph as ComfyGraph,
		steps: H3_STEPS,
		cfg: H3_CFG,
		slots: {
			prompt: { node: "4", input: "prompt" },
			seed: { node: "6", input: "seed" },
			steps: { node: "6", input: "steps" },
			cfg: { node: "6", input: "cfg" },
			width: { node: "4", input: "width" },
			height: { node: "4", input: "height" },
			images: Array.from({ length: 10 }, (_, index) => ({
				load: String(9 + index),
				encoderInput: { node: "4", input: `images.image_${index + 1}` },
			})),
			output: "8",
		},
		wrapPrompt: wrapH3EditPrompt,
	},
};

/** The graph names each picture model owns; a model never borrows another's. */
export const GRAPH_TEMPLATES_BY_MODEL: Record<
	ImageModel,
	Partial<Record<GraphName, GraphTemplate>>
> = {
	qwen: GRAPH_TEMPLATES,
	h3: H3_GRAPH_TEMPLATES,
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

/**
 * The template a request uses, or null when the model cannot make that kind of
 * picture. A transparent request looks for the model's own transparent graph:
 * Qwen's generate has one and its edit falls back to the plain edit (as it always
 * has), while H3 has none and answers null — never Qwen's.
 */
export function graphFor(
	model: ImageModel,
	mode: "generate" | "edit",
	transparent: boolean,
): { template: GraphTemplate; transparentApplied: boolean } | null {
	const templates = GRAPH_TEMPLATES_BY_MODEL[model];
	if (transparent) {
		const special = templates[`${mode}-transparent`];
		if (special) return { template: special, transparentApplied: true };
		if (model !== "qwen") return null;
	}
	const plain = templates[mode];
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
	put(graph, slots.steps, template.steps);
	put(graph, slots.cfg, template.cfg);
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
