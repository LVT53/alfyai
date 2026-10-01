/**
 * The one place a block kind becomes a thing the board can draw: its node
 * component, its data schema, its size and its Insert-menu row. Adding a kind is
 * a row here plus its row in `block-meta.ts` and its node component; the board
 * never branches on a kind.
 *
 * The schema is the shared one (`canvas-blocks.ts`, ruling 64: the server
 * validates a stored board and a model's change with the same objects). The
 * blocks made from the chat (map, file, App, photos, live web, diagram), and the chart and the checklist,
 * are drawn by `LazyNode`, which loads the real node when one is on the board, so
 * the editor's first paint pays for none of them.
 */
import type { NodeTypes } from "@xyflow/svelte";
import type { z } from "zod";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import {
	BLOCK_DATA_SCHEMAS,
	BLOCK_KINDS,
	type BlockKind,
	type CanvasBlockData,
	estimatedNodeSize,
} from "$lib/shared/artifacts/canvas-blocks";
import FrameNode from "../nodes/FrameNode.svelte";
import LazyNode from "../nodes/LazyNode.svelte";
import MissingKindNode from "../nodes/MissingKindNode.svelte";
import StickyNode from "../nodes/StickyNode.svelte";
import TextNode from "../nodes/TextNode.svelte";
import { BLOCK_META, type BlockMeta, type RegisteredKind } from "./block-meta";
import { newId } from "./ids";

export type BlockRegistryEntry = BlockMeta & {
	kind: RegisteredKind;
	/** The Svelte Flow node component: the shell around the block, and the block inside it. */
	component: NodeTypes[string];
	/** Validates the block's data, from a stored board or a change. */
	schema: z.ZodType<CanvasBlockData>;
};

function entry(
	kind: RegisteredKind,
	component: NodeTypes[string],
): BlockRegistryEntry {
	return {
		...BLOCK_META[kind],
		kind,
		component,
		schema: BLOCK_DATA_SCHEMAS[kind] as z.ZodType<CanvasBlockData>,
	};
}

export const BLOCK_REGISTRY: Partial<Record<BlockKind, BlockRegistryEntry>> = {
	frame: entry("frame", FrameNode),
	sticky: entry("sticky", StickyNode),
	text: entry("text", TextNode),
	chart: entry("chart", LazyNode),
	mermaid: entry("mermaid", LazyNode),
	checklist: entry("checklist", LazyNode),
	map: entry("map", LazyNode),
	file: entry("file", LazyNode),
	app: entry("app", LazyNode),
	photo: entry("photo", LazyNode),
	liveweb: entry("liveweb", LazyNode),
};

/** The row of a block kind, or `null` for a kind this build cannot draw (which the board draws as the missing-kind card). */
export function blockEntry(kind: string): BlockRegistryEntry | null {
	return Object.hasOwn(BLOCK_REGISTRY, kind)
		? (BLOCK_REGISTRY[kind as BlockKind] ?? null)
		: null;
}

/**
 * The order the Insert menu lists kinds in (within a section). Every kind is
 * named, so the slice that adds a kind adds its registry row and nothing here.
 */
const INSERT_ORDER: readonly BlockKind[] = [
	"sticky",
	"text",
	"frame",
	"chart",
	"mermaid",
	"checklist",
	"map",
	"photo",
	"file",
	"app",
	"liveweb",
];

/**
 * The rows the Insert menu lists: what this build can draw and a reader can
 * insert bare, in menu order. A block made from the chat (section "chat") is not
 * one of them: it is offered by "From this chat", with the data the chat made.
 */
export function insertableEntries(): BlockRegistryEntry[] {
	return INSERT_ORDER.flatMap((kind) => {
		const row = BLOCK_REGISTRY[kind];
		return row && row.section !== "chat" ? [row] : [];
	});
}

/**
 * Svelte Flow's `nodeTypes`: EVERY block kind maps to something, so a stored
 * block whose kind has no row still draws (as the missing-kind card) instead of
 * falling back to the library's default node and an error in the console.
 */
export function boardNodeTypes(): NodeTypes {
	const types: NodeTypes = {};
	for (const kind of BLOCK_KINDS) {
		types[kind] = BLOCK_REGISTRY[kind]?.component ?? MissingKindNode;
	}
	return types;
}

/**
 * The box placement leaves room for when a block is inserted with the data the
 * reader picked. A kind has one size in its meta, but a chart's height is its
 * plot's (a pie is square, a bar chart half as tall as it is wide), so a pie placed
 * in a bar chart's room would reach over whatever is below it: the estimate the
 * model reads and the eval measures by (`estimatedNodeSize`) is the room for a
 * chart. Every other kind keeps its meta's size.
 */
export function insertSize(
	row: BlockRegistryEntry,
	data?: CanvasBlockData,
): { width: number; height: number } {
	if (data?.kind !== "chart") return row.size;
	return estimatedNodeSize({ type: "chart", width: row.size.width, data });
}

/** A small sample, so a chart inserted by hand has something to show until it is asked to say something else. */
const SAMPLE_CHART = JSON.stringify({
	type: "bar",
	data: {
		labels: ["A", "B", "C", "D"],
		datasets: [{ data: [4, 7, 3, 6] }],
	},
	options: { plugins: { legend: { display: false } } },
});

/**
 * The data a freshly inserted block of this kind gets. `null` for a block made
 * from the chat: its data is what the chat made, picked by the reader, so there is
 * nothing to default.
 */
export function defaultDataFor(kind: RegisteredKind): CanvasBlockData | null {
	switch (kind) {
		case "frame":
			return {
				kind: "frame",
				label: "",
				width: BLOCK_META.frame.size.width,
				height: BLOCK_META.frame.size.height,
			};
		case "sticky":
			return { kind: "sticky", text: "", tone: "yellow" };
		case "text":
			return { kind: "text", text: "" };
		case "chart":
			return { kind: "chart", code: SAMPLE_CHART };
		case "checklist":
			return { kind: "checklist", items: [] };
		case "mermaid":
		case "map":
		case "file":
		case "app":
		case "photo":
		case "liveweb":
			return null;
	}
}

/**
 * A new node of a registered kind at a board position, at its default size (a
 * block that grows with its content gets a width and no height). `data` is what
 * the reader picked; a block with a default takes it from there, and one made from
 * the chat has to be given it.
 */
export function newBlockNode(
	kind: RegisteredKind,
	position: Pt,
	id: string = newId(kind),
	data?: CanvasBlockData,
): CanvasNode {
	const meta = BLOCK_META[kind];
	const blockData = data ?? defaultDataFor(kind);
	if (!blockData) {
		throw new Error(
			`A ${kind} block is made from what the chat made: no data was given.`,
		);
	}
	return {
		id,
		type: kind,
		position,
		width: meta.size.width,
		...(meta.fixedHeight ? { height: meta.size.height } : {}),
		data: blockData,
	};
}
