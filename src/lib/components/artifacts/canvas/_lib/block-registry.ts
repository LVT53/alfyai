/**
 * The one place a block kind becomes a thing the board can draw: its node
 * component, its data schema, its size and its Insert-menu row. Adding a kind is
 * a row here plus its row in `block-meta.ts` and its node component; the board
 * never branches on a kind.
 *
 * The schema is the shared one (`canvas-blocks.ts`, ruling 64: the server
 * validates a stored board and a model's change with the same objects). The kinds
 * made from the chat (map, file, App, photos, live web) have no row yet; a stored
 * block of one draws as the missing-kind card until their slice adds it.
 */
import type { NodeTypes } from "@xyflow/svelte";
import type { z } from "zod";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import {
	BLOCK_DATA_SCHEMAS,
	BLOCK_KINDS,
	type BlockKind,
	type CanvasBlockData,
} from "$lib/shared/artifacts/canvas-blocks";
import ChartNode from "../nodes/ChartNode.svelte";
import ChecklistNode from "../nodes/ChecklistNode.svelte";
import FrameNode from "../nodes/FrameNode.svelte";
import MissingKindNode from "../nodes/MissingKindNode.svelte";
import StickyNode from "../nodes/StickyNode.svelte";
import TextNode from "../nodes/TextNode.svelte";
import { BLOCK_META, type BlockMeta, type RegisteredKind } from "./block-meta";

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
	chart: entry("chart", ChartNode),
	checklist: entry("checklist", ChecklistNode),
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
	"checklist",
	"map",
	"photo",
	"file",
	"app",
	"liveweb",
];

/** The rows the Insert menu lists: what this build can draw, in menu order. */
export function insertableEntries(): BlockRegistryEntry[] {
	return INSERT_ORDER.flatMap((kind) => {
		const row = BLOCK_REGISTRY[kind];
		return row ? [row] : [];
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

/** A small sample, so a chart inserted by hand has something to show until it is asked to say something else. */
const SAMPLE_CHART = JSON.stringify({
	type: "bar",
	data: {
		labels: ["A", "B", "C", "D"],
		datasets: [{ data: [4, 7, 3, 6] }],
	},
	options: { plugins: { legend: { display: false } } },
});

/** The data a freshly inserted block of this kind gets. */
export function defaultDataFor(kind: RegisteredKind): CanvasBlockData {
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
	}
}

/** A new node of a registered kind at a board position, at its default size (a block that grows with its content gets a width and no height). */
export function newBlockNode(
	kind: RegisteredKind,
	position: Pt,
	id: string = crypto.randomUUID(),
): CanvasNode {
	const meta = BLOCK_META[kind];
	return {
		id,
		type: kind,
		position,
		width: meta.size.width,
		...(meta.fixedHeight ? { height: meta.size.height } : {}),
		data: defaultDataFor(kind),
	};
}
