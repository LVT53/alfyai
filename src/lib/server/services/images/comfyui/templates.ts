/**
 * ComfyUI graph templates for Qwen-Image 2.1.
 *
 * The two reference graphs are a starting point in the node set ComfyUI used
 * for Qwen-Image-Edit in 2025. The encoder and VAE file names are
 * PLACEHOLDERS until plan 2c Task 3 replaces them with the installed server's
 * own exported graphs and records the real names and image-slot count. Keep
 * the slot map general: it names nodes and inputs, never relies on their ids.
 */
import referenceEdit from "./graphs/reference-edit.api.json";
import referenceGenerate from "./graphs/reference-generate.api.json";
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
};

export const QWEN_STEPS = 40;
export const QWEN_CFG = 1;

export const GRAPH_TEMPLATES: Partial<Record<GraphName, GraphTemplate>> = {
	generate: {
		name: "generate",
		graph: referenceGenerate as ComfyGraph,
		slots: {
			prompt: { node: "5", input: "text" },
			seed: { node: "8", input: "seed" },
			steps: { node: "8", input: "steps" },
			cfg: { node: "8", input: "cfg" },
			width: { node: "7", input: "width" },
			height: { node: "7", input: "height" },
			images: [],
			output: "10",
		},
	},
	edit: {
		name: "edit",
		graph: referenceEdit as ComfyGraph,
		slots: {
			prompt: { node: "5", input: "prompt" },
			seed: { node: "8", input: "seed" },
			steps: { node: "8", input: "steps" },
			cfg: { node: "8", input: "cfg" },
			width: { node: "14", input: "width" },
			height: { node: "14", input: "height" },
			images: [
				{ load: "11", encoderInput: { node: "5", input: "image1" } },
				{ load: "12", encoderInput: { node: "5", input: "image2" } },
				{ load: "13", encoderInput: { node: "5", input: "image3" } },
			],
			output: "10",
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
	put(graph, slots.prompt, values.prompt);
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
