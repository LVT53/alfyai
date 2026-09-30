/**
 * The Canvas body — what `artifacts.content_text` holds for a board, and
 * nothing else about it (ruling 1: comments, versions and per-App key-value
 * state are rows keyed by `artifact_id`, never part of a body). Client-safe: no
 * server imports (the two type-only ones are erased at build).
 *
 * The per-kind block data lives in `canvas-blocks.ts` (zod, ruling 64); its
 * types are re-exported here so the body's own types read from one place.
 */
import { z } from "zod";
import type { BlockKind, CanvasBlockData } from "./canvas-blocks";

export type { BlockKind, CanvasBlockData } from "./canvas-blocks";

export const ptSchema = z.object({ x: z.number(), y: z.number() });
export type Pt = z.infer<typeof ptSchema>;

export type StoredCanvasNode = {
	id: string;
	type: BlockKind;
	position: Pt;
	/** Set only when the node lives inside a frame. Always frame-relative. */
	parentId?: string;
	width?: number;
	height?: number;
	data: CanvasBlockData;
};

/**
 * A node as the board holds it: Svelte Flow writes `measured`, `selected` and
 * `dragging` back onto the object it was handed, and `zIndex`/`extent` are
 * library fields we set. The live object is therefore a superset of the stored
 * one, and `boardJson` is what narrows it back.
 */
export type CanvasNode = StoredCanvasNode & {
	measured?: { width: number; height: number };
	selected?: boolean;
	dragging?: boolean;
	zIndex?: number;
	extent?: "parent" | [[number, number], [number, number]] | undefined;
	highlight?: boolean;
};

export type CanvasEdge = {
	id: string;
	source: string;
	target: string;
	label?: string;
};

export const ANNOTATION_KINDS = [
	"pen",
	"highlighter",
	"line",
	"arrow",
	"rect",
	"ellipse",
	"text",
] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export type Annotation = {
	id: string;
	kind: AnnotationKind;
	color: string;
	size: number;
	points?: Pt[]; // pen | highlighter
	from?: Pt; // line | arrow | rect | ellipse
	to?: Pt;
	at?: Pt; // text
	text?: string;
};

export type CanvasBody = {
	/** Bumped only by a migration in the serialize module; readers tolerate older. */
	version: 1;
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	viewport: { x: number; y: number; zoom: number };
	annotations: Annotation[];
};
