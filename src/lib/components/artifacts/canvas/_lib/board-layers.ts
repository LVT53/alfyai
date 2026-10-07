/**
 * What the board hands to a layer that is drawn inside it but written apart
 * from it (today the comment layer): the blocks as they are drawn now, the
 * camera, the tool, and the few things a layer may ask the board to do. The
 * board renders the layer's snippet inside its flow, so the layer sits in the
 * flow's own coordinate space and needs nothing else from the board.
 */
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import type { ScreenRect } from "./floating";
import type { Tool } from "./tools";

export type BoardLayerApi = {
	/** The blocks as drawn now: a block that is being dragged is where it is dragged to. */
	nodes: readonly CanvasNode[];
	viewport: { x: number; y: number; zoom: number };
	tool: Tool;
	setTool: (tool: Tool) => void;
	/** A point on the screen as a point on the board. */
	toBoard: (point: { x: number; y: number }) => Pt;
	/** Moves the camera so a board point is in the middle of the pane. */
	centerOn: (point: Pt) => void;
	/** Says something to a screen reader, politely. */
	announce: (message: string) => void;
	/** The pane's size, for a layer that places itself where there is room. */
	size: { width: number; height: number };
	/** The board cannot change now (a conflict is waiting on the reader, the item is gone): a layer has nothing to offer. */
	readonly: boolean;
	/** Where the change pill is on the screen (the pane's pixels), once its layer has put it there: the selection's pill keeps off it (RC-3 N3). */
	changePillBox: ScreenRect | null;
	/** The change layer says where its pill is, or that it has none. */
	setChangePillBox: (box: ScreenRect | null) => void;
	/** Where the toolbar of the one picked block is on the screen (the pane's pixels): the selection's pill hangs clear of it when it is below the block. Null when no block has one. */
	toolbarBox: ScreenRect | null;
};
