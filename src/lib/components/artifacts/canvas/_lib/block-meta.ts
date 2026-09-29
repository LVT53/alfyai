/**
 * What is true of a block kind that is NOT a component: its icon, its label,
 * how big it starts and how small it may get, which chrome the node shell draws
 * around it, and where the Insert menu lists it.
 *
 * A leaf module on purpose. The node components read their own icon and label
 * from here, and `block-registry.ts` (which imports every node component) adds
 * the component and the schema on top; if the nodes imported the registry the
 * two would be an import cycle. Adding a kind is one row here, one node
 * component, one registry row — never an edit to the board.
 */
import {
	ChartColumn,
	Frame,
	ListChecks,
	StickyNote,
	TriangleAlert,
	Type,
} from "@lucide/svelte";
import type { Component } from "svelte";
import type { BlockKind } from "$lib/shared/artifacts/canvas-blocks";

/**
 * How the node shell dresses a kind:
 * - `frame`: a dashed outline and a label chip, no fill; what sits inside is
 *   other nodes, so its body lets pointers through;
 * - `note`: a filled paper (the sticky's tone), no header;
 * - `bare`: nothing but the content (a text block), so only its selection shows;
 * - `card`: a raised card with an icon-and-title header (chart, checklist and,
 *   later, the blocks made from the chat).
 */
export type BlockChrome = "frame" | "note" | "bare" | "card";

export type BlockMeta = {
	kind: string;
	/** Lucide icon for the node header and the Insert menu. */
	icon: Component;
	/** Insert-menu label key; the node header reads it too when the block has no title of its own. */
	labelKey: string;
	chrome: BlockChrome;
	/** Default board size in board units: what a freshly inserted block gets, and what placement leaves room for. */
	size: { width: number; height: number };
	/** The smallest a reader may resize it to. */
	minSize: { width: number; height: number };
	/**
	 * True when the block stores a height (a frame). Every other block is as
	 * tall as its content until the reader resizes it, so a note that grows
	 * with its text never clips it and the stored board carries no stale height.
	 */
	fixedHeight: boolean;
	/** Insert-menu section: "text" for what a reader writes, "blocks" for what carries content of its own. */
	section: "text" | "blocks";
	/** Needs a poster in export and offline (an App, a map, photos, live web): none of the note-shaped kinds does. */
	needsPoster: boolean;
	/** True when the node must not be a frame child (a frame is a top-level container). */
	structural?: boolean;
	/** Svelte Flow fields the kind needs on its live node; the board copies them on, never branches on the kind. */
	flow?: { zIndex?: number; dragHandle?: string; style?: string };
};

/** The kinds this build has a component for. The chat-derived kinds (map, file, App, photos, live web) get their row with their own slice. */
export const BLOCK_META = {
	frame: {
		kind: "frame",
		icon: Frame,
		labelKey: "artifacts.canvas.insert.frame",
		chrome: "frame",
		size: { width: 360, height: 260 },
		minSize: { width: 160, height: 120 },
		fixedHeight: true,
		section: "text",
		needsPoster: false,
		structural: true,
		// Behind everything it groups, movable only by its name chip, and blind
		// to the pointer elsewhere so what is inside (and behind) stays reachable.
		flow: {
			zIndex: -1,
			dragHandle: ".canvas-node__chip",
			style: "pointer-events: none;",
		},
	},
	sticky: {
		kind: "sticky",
		icon: StickyNote,
		labelKey: "artifacts.canvas.insert.sticky",
		chrome: "note",
		size: { width: 200, height: 120 },
		minSize: { width: 96, height: 64 },
		fixedHeight: false,
		section: "text",
		needsPoster: false,
	},
	text: {
		kind: "text",
		icon: Type,
		labelKey: "artifacts.canvas.insert.text",
		chrome: "bare",
		size: { width: 240, height: 40 },
		minSize: { width: 80, height: 32 },
		fixedHeight: false,
		section: "text",
		needsPoster: false,
	},
	chart: {
		kind: "chart",
		icon: ChartColumn,
		labelKey: "artifacts.canvas.insert.chart",
		chrome: "card",
		size: { width: 360, height: 250 },
		minSize: { width: 240, height: 160 },
		fixedHeight: false,
		section: "blocks",
		needsPoster: false,
	},
	checklist: {
		kind: "checklist",
		icon: ListChecks,
		labelKey: "artifacts.canvas.insert.checklist",
		chrome: "card",
		size: { width: 260, height: 140 },
		minSize: { width: 180, height: 80 },
		fixedHeight: false,
		section: "blocks",
		needsPoster: false,
	},
} as const satisfies Partial<Record<BlockKind, BlockMeta>>;

/** A kind this build has a meta row (and so a node component) for. */
export type RegisteredKind = keyof typeof BLOCK_META;

/**
 * What a stored block whose kind has no row above renders as: a known kind
 * that has no component in this build yet, drawn as a card that says so. (A
 * kind the board does not know at all never reaches it: the body normaliser
 * drops it on load and reports it.)
 */
const MISSING_BLOCK_META: BlockMeta = {
	kind: "missing",
	icon: TriangleAlert,
	labelKey: "artifacts.canvas.blockMissingKind",
	chrome: "card",
	size: { width: 240, height: 80 },
	minSize: { width: 160, height: 60 },
	fixedHeight: false,
	section: "blocks",
	needsPoster: false,
};

/** The meta row of a block kind, or the missing-kind card's for a kind this build has no row for. */
export function metaFor(kind: string): BlockMeta {
	return (
		(Object.hasOwn(BLOCK_META, kind)
			? (BLOCK_META as Record<string, BlockMeta>)[kind]
			: undefined) ?? MISSING_BLOCK_META
	);
}
