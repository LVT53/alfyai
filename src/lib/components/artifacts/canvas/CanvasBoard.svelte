<script lang="ts">
/**
 * The board: the Svelte Flow host. It owns the live state of what is drawn
 * (nodes, edges, camera, and the strokes it carries but does not draw yet) and
 * the reader's own history; it does NOT own persistence — that is the editor's
 * — and it does not know any block kind (the registry does).
 *
 * How a change reaches the editor: every gesture (a drag, a resize, typing, a
 * tick, a delete, an insert) ends up as a change to `nodes` or `edges`, and the
 * board watches those. A moment after they stop changing it compares the
 * board's canonical JSON, camera left out, with the last state it reported; if
 * they differ that is ONE step — one entry in the reader's history and one
 * `onchange`. A pan only moves the camera, so it is never a change, and the
 * camera rides along with the next real one.
 *
 * Svelte Flow v1, not React Flow: every flow prop and event is lowercase
 * (`onnodedragstop`, not `onNodeDragStop`, which is accepted as an unknown prop
 * and silently never runs), the library adds an edge itself on a connection
 * (so the edge id is stamped in `onbeforeconnect`, never in `onconnect`, or one
 * drag makes two edges), and there is `snapGrid`, not `snapToGrid`.
 *
 * Frames: Svelte Flow moves a child with its frame but never adopts, so a drop
 * is judged here (`onnodedragstop` -> `reparentOnDrop`) and the block's
 * `parentId` and position rewritten; while the drag is on, `onnodedrag` lights
 * the frame that would take it. A frame that is deleted does not take the blocks
 * inside it (`onbeforedelete` re-homes them: the ops protocol does the same).
 *
 * Seams: a layer written apart from the board (the comment pins and the
 * catcher for the Comment tool) is a snippet the board renders INSIDE its flow,
 * handed `BoardLayerApi` (the blocks as drawn, the camera, the tool and a few
 * things it may ask the board to do); a board the server changed under the
 * reader (Alfy answered a comment, or a chat turn edited it) is drawn with
 * `land` and the few methods below it (`current`, `place`, `hold`), which are
 * not steps of the reader's: the landing itself (the structure, the glide, the
 * rings) is written apart, in `_lib/alfy-landing.ts`, and only draws on these.
 */
import "@xyflow/svelte/dist/base.css";
import {
	Background,
	BackgroundVariant,
	type Connection,
	ConnectionMode,
	MarkerType,
	type Edge,
	MiniMap,
	Panel,
	SvelteFlow,
	useSvelteFlow,
	type Viewport,
	ViewportPortal,
} from "@xyflow/svelte";
import { onDestroy, type Snippet, untrack } from "svelte";
import { historyShortcutFor } from "$lib/components/artifacts/document/keyboard-shortcuts";
import { t } from "$lib/i18n";
import { prefersReducedMotion } from "$lib/utils/motion";
import type { Annotation, CanvasBody, Pt } from "$lib/shared/artifacts/canvas";
import type {
	CanvasBlockData,
	PosterRef,
} from "$lib/shared/artifacts/canvas-blocks";
import {
	MAX_ANNOTATIONS_PER_BOARD,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import {
	nodeRect,
	parentsFirst,
	type Rect,
	rehomeOnRemoval,
	type ReparentPatch,
	reparentOnDrop,
	withoutDanglingEdges,
} from "./_lib/board";
import { DEFAULT_INK, isDrawingTool, type Tool } from "./_lib/tools";
import type { BoardLayerApi } from "./_lib/board-layers";
import type { ScreenRect } from "./_lib/floating";
import { type BoardHistory, createBoardHistory } from "./_lib/board-history";
import { type BlockPicture, provideBoardContext } from "./_lib/board-context";
import {
	bodyOfState,
	type FlowNode,
	hasStoredCamera,
	structuralJson,
	toFlowEdges,
	toFlowNodes,
	withBlockData,
	withBlockPoster,
} from "./_lib/board-model";
import {
	type BlockRegistryEntry,
	blockEntry,
	boardNodeTypes,
	newBlockNode,
} from "./_lib/block-registry";
import { newId } from "./_lib/ids";
import { visibleBoardRect } from "./_lib/pane-rect";
import type AnnotationLayer from "./AnnotationLayer.svelte";
import CanvasToolbar from "./CanvasToolbar.svelte";
import type DrawTray from "./DrawTray.svelte";
import ZoomChip from "./ZoomChip.svelte";

let {
	body,
	readonly = false,
	onchange,
	oncamera,
	layers,
	ontool,
	onselect,
	onask,
	askBusy = false,
}: {
	/** The board to draw. Read once, when the board mounts: to show a different one (a reload, a restore) the editor mounts a new board. */
	body: CanvasBody;
	/** The board cannot change now (a conflict is waiting on the reader's choice, or the item is gone). It still draws and pans. */
	readonly?: boolean;
	/** One step of the reader's, complete: the whole board, camera included. Never a bare pan. */
	onchange: (body: CanvasBody) => void;
	/** The camera settled somewhere. In memory only: it is saved with the next real change. */
	oncamera?: (camera: Viewport) => void;
	/** A layer drawn inside the flow, written apart from the board (see the seams above). */
	layers?: Snippet<[BoardLayerApi]>;
	/** The tool changed: a layer that is loaded on demand hears of the tool that needs it here. */
	ontool?: (tool: Tool) => void;
	/** A block became selected (or the last one stopped being): the pill that a selection raises is loaded on demand, and hears of it here. */
	onselect?: (selected: boolean) => void;
	/** Ask Alfy from the toolbar: about the selected blocks, or (none selected) the whole board, named by where the reader is looking. */
	onask?: (request: { ids: string[]; centre: Pt }) => void;
	/** Alfy is arranging: Ask waits. */
	askBusy?: boolean;
} = $props();

const initial = untrack(() => body);
const flow = useSvelteFlow();
const nodeTypes = boardNodeTypes();
/** An arrow points at the block it was drawn to (its head takes the edge's own colour), so the stored direction is seen (RV-3 Minor 4). */
const edgeDefaults = { markerEnd: { type: MarkerType.ArrowClosed } };

let nodes = $state.raw<FlowNode[]>(toFlowNodes(initial.nodes));
let edges = $state.raw<Edge[]>(toFlowEdges(initial.edges, initial.nodes));
let viewport = $state.raw<Viewport>({ ...initial.viewport });
// Carried, written back and undone with the rest; drawn by the drawing layer.
let annotations = $state.raw<Annotation[]>([...initial.annotations]);

/** Wait this long after the last change before calling it a step: a drag or a burst of typing is one. */
const SETTLE_MS = 350;
/** A panel narrower than this gets the compact toolbar and no minimap. */
const COMPACT_BELOW = 480;
const MINIMAP_ABOVE = 720;
/** The toolbar and the zoom no longer fit side by side below this (a column of comments beside the board narrows it): the zoom goes above the toolbar. */
const STACK_ZOOM_BELOW = 680;

let boardEl = $state<HTMLElement | null>(null);
let boardWidth = $state(0);
let boardHeight = $state(0);
// What the zoom was when the camera last came to rest. A finger's hit area on a
// block's handles is about 24 px on the screen, so it grows as the board zooms
// out; it is sized to the resting zoom, not re-measured on every frame of a pinch.
let restingZoom = $state(untrack(() => initial.viewport.zoom) || 1);
let tool = $state<Tool>("select");
/** The ink a new mark is drawn in (a colour token). */
let ink = $state(DEFAULT_INK);
let coarsePointer = $state(false);
let announcement = $state("");
/** The board is holding as many marks as it may, and a stroke was just refused: say so where a reader can see it. */
let limitNotice = $state(false);
let limitTimer: ReturnType<typeof setTimeout> | null = null;
/** The frame a block being dragged would join if it were dropped now. */
let dropTargetId = $state<string | null>(null);
// The drawing layer and its tray load on demand (`drawing-parts.ts`): when a tool
// that draws is chosen, or the board has marks to show. Until then none of it is in
// the editor's first paint.
let drawingViews = $state.raw<{
	AnnotationLayer: typeof AnnotationLayer;
	DrawTray: typeof DrawTray;
} | null>(null);
let drawingLoading: Promise<boolean> | null = null;

function ensureDrawing(): Promise<boolean> {
	drawingLoading ??= import("./drawing-parts")
		.then(({ AnnotationLayer, DrawTray }) => {
			drawingViews = { AnnotationLayer, DrawTray };
			return true;
		})
		// Offline, or a deploy in between: the next choice of a tool tries again.
		.catch(() => {
			drawingLoading = null;
			return false;
		});
	return drawingLoading;
}

// Where an inserted block goes is worked out by code that loads on demand: when a
// reader reaches for Insert (the toolbar asks), or with the first insert. Once it
// is here an insert lands in the same beat the row is picked.
type Placement = typeof import("./_lib/placement");
let placement: Placement | null = null;
let placementLoading: Promise<Placement | null> | null = null;

function loadPlacement(): Promise<Placement | null> {
	placementLoading ??= import("./_lib/placement").then(
		(module) => (placement = module),
		// Offline, or a deploy in between: the next insert tries again.
		() => {
			placementLoading = null;
			return null;
		},
	);
	return placementLoading;
}

// While a picture of the board is taken (the export): what stands in for the live
// content of each block a picture cannot carry. Null on the live board.
let pictures = $state.raw<ReadonlyMap<string, BlockPicture> | null>(null);
// The blocks whose still image could not be made: their meta line says so.
let posterFailedIds = $state.raw<ReadonlySet<string>>(new Set());

/** A landing is drawing (Alfy's change): the reader's gestures and steps wait until it lets go. */
let held = $state(false);

let history: BoardHistory = createBoardHistory();
let canUndo = $state(false);
let canRedo = $state(false);
let committedJson = structuralJson(snapshot());
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let announceTimer: ReturnType<typeof setTimeout> | null = null;
const editRequests = new Set<string>();
/** The block an Insert selected, until the reader touches it or reaches for the Comment tool. */
let insertSelectedId: string | null = null;

provideBoardContext({
	get readonly() {
		return readonly;
	},
	requestEdit(id) {
		editRequests.add(id);
	},
	takeEditRequest(id) {
		return editRequests.delete(id);
	},
	get dropTargetId() {
		return dropTargetId;
	},
	picture: (id) => pictures?.get(id) ?? null,
	posterFailed: (id) => posterFailedIds.has(id),
	updateData: (id, patch) => flow.updateNodeData(id, patch),
});

function snapshot(): CanvasBody {
	return bodyOfState({ nodes, edges, viewport, annotations });
}

function syncHistoryFlags(): void {
	canUndo = history.undoDepth > 0;
	canRedo = history.redoDepth > 0;
}

function scheduleCommit(): void {
	if (settleTimer) clearTimeout(settleTimer);
	settleTimer = setTimeout(commit, SETTLE_MS);
}

/**
 * Settles what has changed since the last report into one step, now. Called by
 * the settle timer, and directly wherever a step must be separate from the one
 * before it (an insert, an undo). A no-op when the canonical JSON is unchanged.
 */
function commit(): void {
	if (settleTimer) {
		clearTimeout(settleTimer);
		settleTimer = null;
	}
	// A landing is moving blocks about: what is on screen is not the reader's.
	if (held) {
		scheduleCommit();
		return;
	}
	// Still being dragged: the drop is what ends the step.
	if (nodes.some((node) => node.dragging)) {
		scheduleCommit();
		return;
	}
	const next = snapshot();
	const nextJson = structuralJson(next);
	if (nextJson === committedJson) return;
	history.push(committedJson);
	committedJson = nextJson;
	syncHistoryFlags();
	onchange(next);
}

$effect(() => {
	void nodes;
	void edges;
	void annotations;
	untrack(scheduleCommit);
});

onDestroy(() => {
	if (announceTimer) clearTimeout(announceTimer);
	if (limitTimer) clearTimeout(limitTimer);
	// Half way through a landing the blocks are between places: not a step to save.
	if (!held) commit();
});

/** Ends any pending step at once and hands back the board exactly as it is. */
export function flush(): CanvasBody {
	commit();
	return snapshot();
}

/**
 * Draws a board the server changed under the reader (Alfy answered a comment
 * with a change): the blocks, connections and marks are replaced, the camera is
 * left where it is. It is not a step of the reader's (Alfy's change is a
 * version, ruling 16), so the reader's own undo is emptied: it could only take
 * them back to before Alfy's change and save that over it.
 */
export function land(next: CanvasBody): void {
	nodes = toFlowNodes(next.nodes);
	edges = toFlowEdges(next.edges, next.nodes);
	annotations = [...next.annotations];
	history = createBoardHistory();
	committedJson = structuralJson(snapshot());
	syncHistoryFlags();
}

/** The board as it is drawn now, without ending the step in progress: what a landing compares the server's board against. */
export function current(): CanvasBody {
	return snapshot();
}

/**
 * Puts a block's new data on the board (a live-web block's refreshed snapshot) as
 * one step of the reader's own, exactly as a tick in a checklist is: it is
 * undoable, and the board's own save keeps it. What was pending is a step of its
 * own first, so Undo takes back the new data alone. False, and nothing changes,
 * when the board cannot change now, or the block is gone or is another kind of
 * block (the reader deleted it while the search ran).
 */
export function setBlockData(id: string, data: CanvasBlockData): boolean {
	if (readonly || held) return false;
	const next = withBlockData(nodes, id, data);
	if (!next) return false;
	commit();
	nodes = next;
	commit();
	return true;
}

/**
 * Puts a block's still image on it (or takes it off). Not a step of the reader's:
 * a picture of a block is something the board made about itself, so it is not in
 * their history and not saved on its own; it rides with the next step they take.
 * What they were doing is settled first, so nothing they did is swallowed by it.
 * False, and nothing changes, when the board cannot change now, a block is being
 * dragged, or the block is gone or has no poster.
 */
export function setBlockPoster(id: string, poster: PosterRef | null): boolean {
	if (readonly || held || nodes.some((node) => node.dragging)) return false;
	commit();
	const next = withBlockPoster(nodes, id, poster);
	if (!next) return false;
	nodes = next;
	committedJson = structuralJson(snapshot());
	return true;
}

/** Draws these blocks as their still images (or cards) for a picture of the board, and with null goes back to the live board. */
export function showPictures(
	next: ReadonlyMap<string, BlockPicture> | null,
): void {
	pictures = next;
}

/** The blocks whose still image could not be made. */
export function markPosterFailed(ids: ReadonlySet<string>): void {
	posterFailedIds = ids;
}

/**
 * What a picture of the board is taken from: the board as drawn now, every
 * block's rectangle as the panel measured it (a note stores no height), and the
 * library's viewport element. Nothing here ends a step or changes the board.
 */
export function pictureSource(): {
	body: CanvasBody;
	rects: Rect[];
	viewportEl: HTMLElement | null;
} {
	const body = snapshot();
	const measuredById = new Map(nodes.map((node) => [node.id, node.measured]));
	return {
		body,
		rects: body.nodes.map((node) =>
			nodeRect(node, body.nodes, measuredById.get(node.id)),
		),
		viewportEl:
			boardEl?.querySelector<HTMLElement>(".svelte-flow__viewport") ?? null,
	};
}

/** The element a block's poster is a picture of: its content region, below the header. Null when the block is not drawn. */
export function nodeContentElement(id: string): HTMLElement | null {
	const nodeEl = [
		...(boardEl?.querySelectorAll<HTMLElement>('[data-testid="canvas-node"]') ??
			[]),
	].find((el) => el.dataset.nodeId === id);
	return nodeEl?.querySelector<HTMLElement>(".canvas-node__content") ?? null;
}

/** The camera as it is now, and a way to put it somewhere at once (a picture of the board moves it and puts it back). */
export function getCamera(): Viewport {
	return flow.getViewport();
}
export function setCamera(camera: Viewport): Promise<boolean> {
	return flow.setViewport(camera, { duration: 0 });
}

/** Puts blocks at these positions, each in its own space: one frame of a glide. Nothing else about the board changes, and it is not a step. */
export function place(positions: ReadonlyMap<string, Pt>): void {
	nodes = nodes.map((node) => {
		const at = positions.get(node.id);
		return at ? { ...node, position: { x: at.x, y: at.y } } : node;
	});
}

/** A landing starts drawing (`true`) or is done (`false`): while it draws, the reader can neither move nor edit and nothing it does is saved as theirs. */
export function hold(on: boolean): void {
	held = on;
	if (!on) scheduleCommit();
}

// ---- The reader's own history (ruling 16) --------------------------------

function restore(json: string): void {
	const restored = normalizeCanvasBody(JSON.parse(json)).body;
	nodes = toFlowNodes(restored.nodes);
	edges = toFlowEdges(restored.edges, restored.nodes);
	annotations = restored.annotations;
	committedJson = json;
	onchange(snapshot());
}

function undo(): void {
	if (readonly) return;
	commit();
	const previous = history.undo(committedJson);
	if (previous !== null) restore(previous);
	syncHistoryFlags();
}

function redo(): void {
	if (readonly) return;
	commit();
	const next = history.redo(committedJson);
	if (next !== null) restore(next);
	syncHistoryFlags();
}

/** Ctrl/Cmd+Z and its redo, whenever focus is inside the board and not in a text field (which has its own). */
function handleWindowKeydown(event: KeyboardEvent): void {
	if (event.defaultPrevented || !boardEl?.contains(document.activeElement)) {
		return;
	}
	const target = event.target as HTMLElement | null;
	if (target?.closest("input, textarea, select, [contenteditable='true']")) {
		return;
	}
	const action = historyShortcutFor(event);
	if (!action) return;
	event.preventDefault();
	if (action === "undo") undo();
	else redo();
}

// ---- Zoom ----------------------------------------------------------------

const ZOOM_STEP = 1.2;

// Not `flow.zoomIn()`: `useSvelteFlow()` reads those two off the store that
// exists when it is CALLED, and the board calls it above the `<SvelteFlow>` it
// renders, where that is the provider's placeholder (no pan/zoom instance, so
// they answer `false` and do nothing). Every other member reads the live store.
function zoomBy(factor: number): void {
	void flow.setZoom(flow.getZoom() * factor);
}

/** Moves the camera so a board point is in the middle of the pane, at a zoom a block is legible at. */
function centerOn(point: Pt): void {
	void flow.setCenter(point.x, point.y, {
		zoom: Math.max(flow.getZoom(), 0.6),
		duration: prefersReducedMotion() ? 0 : 300,
	});
}

// ---- Insert --------------------------------------------------------------

/** What the pane shows, in board units; undefined before the pane has been measured. */
function visiblePaneRect() {
	const shown = visibleBoardRect(
		{ width: boardWidth, height: boardHeight },
		viewport,
	);
	return shown.width > 0
		? { x: shown.left, y: shown.top, width: shown.width, height: shown.height }
		: undefined;
}

async function insertBlock(
	row: BlockRegistryEntry,
	data?: CanvasBlockData,
): Promise<void> {
	if (readonly || !boardEl) return;
	// What was pending is a step of its own, so Undo takes the insert back alone.
	commit();
	// Where a block goes is worked out when one is inserted, not when the editor
	// opens: only an insert that beat the load waits for it.
	const where = placement ?? (await loadPlacement());
	if (!where || readonly || !boardEl) return;
	const { placeBesideBlocks } = where;
	// Whatever the reader did while it loaded is a step before the insert.
	commit();
	const rect = boardEl.getBoundingClientRect();
	const center = flow.screenToFlowPosition({
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2,
	});
	// A block goes on free ground: laid over another it would hide it and take the
	// clicks meant for it (a made-from-the-chat block is big, an App is 400 x 340,
	// and a note's own toolbar sits over what is beneath it). A frame is a backdrop,
	// so a block may be dropped inside one and keeps off only what is not a frame;
	// a new frame keeps off everything, frames too, which it would otherwise lie
	// across and leave the reader to pull apart (RC-3 N7).
	const position = placeBesideBlocks({
		center,
		size: row.size,
		occupied: nodes
			.filter(
				(node) => row.kind === "frame" || !blockEntry(node.type)?.structural,
			)
			.map((node) => nodeRect(node, nodes, node.measured)),
		visible: visiblePaneRect(),
	});
	const [added] = toFlowNodes([
		newBlockNode(row.kind, position, undefined, data),
	]);
	// Text a reader writes opens for typing at once.
	if (row.section === "text") editRequests.add(added.id);
	insertSelectedId = added.id;
	const cleared = nodes.map((node) =>
		node.selected ? { ...node, selected: false } : node,
	);
	const inserted = { ...added, selected: true };
	// A frame is listed in front of the blocks that are not frames. The library lists a
	// frame before what it holds, so a block dropped into a frame that came AFTER it
	// would have to be re-listed, and that moves the block's wrapper in the page, which
	// makes a browser reload an App's frame that is inside it (RV-3 I1).
	const firstBlock = cleared.findIndex((node) => node.data.kind !== "frame");
	nodes =
		added.data.kind === "frame" && firstBlock !== -1
			? [
					...cleared.slice(0, firstBlock),
					inserted,
					...cleared.slice(firstBlock),
				]
			: [...cleared, inserted];
	commit();
}

// ---- The flow's own events ----------------------------------------------

function handleLimit(): void {
	limitNotice = true;
	announce(
		$t("artifacts.canvas.drawingLimit", { count: MAX_ANNOTATIONS_PER_BOARD }),
	);
	if (limitTimer) clearTimeout(limitTimer);
	limitTimer = setTimeout(() => (limitNotice = false), 5000);
}

function announce(message: string): void {
	announcement = message;
	if (announceTimer) clearTimeout(announceTimer);
	announceTimer = setTimeout(() => (announcement = ""), 3000);
}

function handleBeforeConnect(connection: Connection): Edge {
	// v1 adds the edge itself once this returns it, then fires `onconnect` as a
	// notification: the id has to be stamped here, and only here.
	return { ...connection, id: newId("e") };
}

// ---- Tools and marks ------------------------------------------------------

function setTool(next: Tool): void {
	// A tool that draws is set only once the layer that draws is there, so the
	// pointer is never handed to a layer that has not arrived.
	if ((isDrawingTool(next) || next === "eraser") && !drawingViews) {
		void ensureDrawing().then((loaded) => loaded && applyTool(next));
		return;
	}
	applyTool(next);
}

function applyTool(next: Tool): void {
	tool = next;
	// A block and a mark are never selected together: a tool that draws starts
	// from a board with nothing picked, its toolbar and handles out of the way.
	if (
		(isDrawingTool(next) || next === "eraser") &&
		nodes.some((node) => node.selected)
	) {
		nodes = nodes.map((node) =>
			node.selected ? { ...node, selected: false } : node,
		);
	}
	// An Insert selects the block it adds, so it can be typed into. A reader who
	// then reaches for Comment means another block, so the tool waits for the
	// click instead of taking that one; a block the reader picked themselves is
	// still taken at once (RV-3 I4).
	if (next === "comment" && insertSelectedId) {
		const inserted = insertSelectedId;
		insertSelectedId = null;
		nodes = nodes.map((node) =>
			node.id === inserted && node.selected
				? { ...node, selected: false }
				: node,
		);
	}
}

// A board with marks needs the layer that draws them, whatever tool is on.
$effect(() => {
	if (annotations.length > 0) void ensureDrawing();
});

/** A gesture of the drawing layer is complete: it is one step of its own. */
function handleAnnotations(next: Annotation[]): void {
	if (readonly) return;
	commit();
	annotations = next;
	commit();
}

// ---- Frames: adoption, release, removal ----------------------------------

/** The library measures every block it draws; the geometry reads that, not a guess. */
function measured(node: FlowNode): FlowNode {
	const size = flow.getInternalNode(node.id)?.measured;
	return size?.width && size?.height
		? { ...node, measured: { width: size.width, height: size.height } }
		: node;
}

/** What dropping the dragged blocks where they are now would change about them, by block id. */
function adoptions(dragged: readonly FlowNode[]): Map<string, ReparentPatch> {
	const dropped = new Map(dragged.map((node) => [node.id, node]));
	// What the drag reported is where they are; the board's own copy may lag it by a frame.
	const all = nodes.map((node) => measured(dropped.get(node.id) ?? node));
	const patches = new Map<string, ReparentPatch>();
	for (const node of dragged) {
		const now = all.find((candidate) => candidate.id === node.id) ?? node;
		const patch = reparentOnDrop(now, all);
		if (patch) patches.set(node.id, patch);
	}
	return patches;
}

function frameName(id: string | undefined): string {
	const frame =
		id === undefined ? undefined : nodes.find((node) => node.id === id);
	const label = frame?.data.kind === "frame" ? frame.data.label.trim() : "";
	return label || $t("artifacts.canvas.insert.frame");
}

function handleNodeDrag({
	targetNode,
	nodes: dragged,
}: {
	targetNode: FlowNode | null;
	nodes: FlowNode[];
}): void {
	if (readonly || !targetNode) return;
	dropTargetId = adoptions(dragged).get(targetNode.id)?.parentId ?? null;
}

// `onnodedragstop`, lowercase: the camelCase spelling is accepted as an unknown
// prop and silently never fires, and then nothing is ever adopted.
function handleNodeDragStop({ nodes: dragged }: { nodes: FlowNode[] }): void {
	dropTargetId = null;
	if (readonly) return;
	const patches = adoptions(dragged);
	if (patches.size === 0) return;
	const [[firstId, first]] = [...patches];
	const before = nodes.find((node) => node.id === firstId)?.parentId;
	nodes = parentsFirst(
		nodes.map((node) => {
			const patch = patches.get(node.id);
			return patch ? { ...node, ...patch, dragging: false } : node;
		}),
	);
	announce(
		first.parentId === undefined
			? $t("artifacts.canvas.movedOutOfFrame", { frame: frameName(before) })
			: $t("artifacts.canvas.movedIntoFrame", {
					frame: frameName(first.parentId),
				}),
	);
}

// The library cascades a delete to a frame's children. A frame removed to tidy
// up must not cost a reader their notes, so the ones nobody selected are taken
// out of the deletion and moved up to where the frame was (the ops protocol's
// `remove_node` does the same), along with their connections.
async function handleBeforeDelete({
	nodes: doomed,
	edges: doomedEdges,
}: {
	nodes: FlowNode[];
	edges: Edge[];
}): Promise<{ nodes: FlowNode[]; edges: Edge[] }> {
	const doomedIds = new Set(doomed.map((node) => node.id));
	const spared = new Set(
		doomed
			.filter(
				(node) =>
					node.parentId !== undefined &&
					doomedIds.has(node.parentId) &&
					!node.selected,
			)
			.map((node) => node.id),
	);
	if (spared.size === 0) return { nodes: doomed, edges: doomedEdges };
	const removed = new Set([...doomedIds].filter((id) => !spared.has(id)));
	for (const [id, patch] of rehomeOnRemoval(removed, nodes)) {
		flow.updateNode(id, patch);
	}
	return {
		nodes: doomed.filter((node) => removed.has(node.id)),
		// A connection goes only if one of its ends does, or if it was asked for by itself.
		edges: doomedEdges.filter(
			(edge) =>
				removed.has(edge.source) ||
				removed.has(edge.target) ||
				!(doomedIds.has(edge.source) || doomedIds.has(edge.target)),
		),
	};
}

// A notification, not a veto: the library has filtered its own store already.
// No connection may point at a block that is no longer there.
function handleDelete(): void {
	edges = withoutDanglingEdges(edges, nodes);
	commit();
	announce($t("artifacts.canvas.nodeDeleted"));
}

$effect(() => {
	const query = window.matchMedia("(pointer: coarse)");
	coarsePointer = query.matches;
	const listener = (event: MediaQueryListEvent) => {
		coarsePointer = event.matches;
	};
	query.addEventListener("change", listener);
	return () => query.removeEventListener("change", listener);
});

$effect(() => {
	ontool?.(tool);
});

let anySelected = $derived(nodes.some((node) => node.selected));
$effect(() => {
	onselect?.(anySelected);
});

/** The toolbar's Ask Alfy: the selected blocks, or the board as the reader is looking at it. */
function handleAsk(): void {
	if (readonly || !boardEl) return;
	const rect = boardEl.getBoundingClientRect();
	onask?.({
		ids: nodes.filter((node) => node.selected).map((node) => node.id),
		centre: flow.screenToFlowPosition({
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		}),
	});
}

// Where the change layer's pill is: the selection's pill keeps off it (RC-3 N3).
let changePillBox = $state.raw<ScreenRect | null>(null);

let layerApi = $derived<BoardLayerApi>({
	nodes,
	viewport,
	tool,
	setTool,
	toBoard: (point) => flow.screenToFlowPosition(point),
	centerOn,
	announce,
	size: { width: boardWidth, height: boardHeight },
	readonly,
	changePillBox,
	setChangePillBox: (box) => (changePillBox = box),
});

let compact = $derived(boardWidth > 0 && boardWidth < COMPACT_BELOW);
let stackedZoom = $derived(boardWidth > 0 && boardWidth < STACK_ZOOM_BELOW);

// The zoom control steps aside from a selected block it would cover (RC-3 N3): it
// stands over the pane's lower right corner, where a selected block's corner
// handles are, and sat on a corner of it on a phone. Measured on the screen, after
// the blocks and the camera have been drawn; it comes back when nothing selected
// is under it.
let zoomAside = $state(false);
$effect(() => {
	void [nodes, viewport, boardWidth, boardHeight, stackedZoom];
	// Nothing selected, nothing to measure: a pan or a zoom never forces a layout.
	if (!nodes.some((node) => node.selected)) {
		zoomAside = false;
		return;
	}
	const chip = boardEl
		?.querySelector('[data-testid="canvas-zoom"]')
		?.getBoundingClientRect();
	zoomAside =
		chip !== undefined &&
		[...(boardEl?.querySelectorAll(".svelte-flow__node.selected") ?? [])].some(
			(element) => {
				const rect = element.getBoundingClientRect();
				return (
					rect.left < chip.right &&
					rect.right > chip.left &&
					rect.top < chip.bottom &&
					rect.bottom > chip.top
				);
			},
		);
});
let showMinimap = $derived(boardWidth >= MINIMAP_ABOVE && nodes.length > 0);
let empty = $derived(nodes.length === 0 && annotations.length === 0);
// A tool that draws (or the eraser) owns the pointer: the drawing pad takes the
// press, so a drag must not also move the camera or the blocks under it.
let drawing = $derived(isDrawingTool(tool) || tool === "eraser");
// A finger has no other way to pan, so on touch a drag on the pane always pans
// (except while drawing: then it draws, and a second finger cancels the stroke);
// with a pointer, a plain drag on the pane selects (middle and right buttons pan).
let panOnDrag = $derived(
	tool === "pan" ? true : coarsePointer ? !drawing : [1, 2],
);
let selectionOnDrag = $derived(tool === "select" && !coarsePointer);
let nodesDraggable = $derived(!readonly && !held && tool === "select");
// A board with blocks and no camera of its own is fitted on open, clear of the
// toolbar along the bottom and the overview in the corner.
const fitOnOpen = initial.nodes.length > 0 && !hasStoredCamera(initial);
let fitViewOptions = $derived({
	padding: {
		top: "40px",
		right: "32px",
		bottom: compact ? "88px" : "112px",
		left: "32px",
	},
	minZoom: 0.2,
	maxZoom: 1,
} as const);

let ariaLabelConfig = $derived({
	"node.a11yDescription.default": $t("artifacts.canvas.a11y.node"),
	"node.a11yDescription.keyboardDisabled": $t(
		"artifacts.canvas.a11y.nodeKeyboard",
	),
	"node.a11yDescription.ariaLiveMessage": ({
		x,
		y,
	}: {
		x: number;
		y: number;
	}) => $t("artifacts.canvas.a11y.moved", { x, y }),
	"edge.a11yDescription.default": $t("artifacts.canvas.a11y.edge"),
	"minimap.ariaLabel": $t("artifacts.canvas.minimap"),
	"handle.ariaLabel": $t("artifacts.canvas.a11y.handle"),
});

function minimapColor(node: {
	type?: string;
	data: Record<string, unknown>;
}): string {
	if (node.type === "sticky") {
		return `var(--sticky-${String(node.data.tone ?? "yellow")})`;
	}
	if (node.type === "frame") return "transparent";
	return "color-mix(in srgb, var(--text-muted) 45%, transparent)";
}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
	class="canvas-board"
	class:canvas-board--picture={pictures !== null}
	bind:this={boardEl}
	bind:clientWidth={boardWidth}
	bind:clientHeight={boardHeight}
	style:--canvas-board-width="{boardWidth}px"
	style:--canvas-inv-zoom={1 / restingZoom}
	data-testid="canvas-board"
	data-tool={tool}
>
	<!-- First in the DOM, so the keyboard reaches the tools before the blocks
	     (header, toolbar, then the board); it is painted above by its z-index. -->
	<CanvasToolbar
		{tool}
		{compact}
		{canUndo}
		{canRedo}
		disabled={readonly}
		emphasizeInsert={empty}
		{askBusy}
		{ink}
		Tray={drawingViews?.DrawTray ?? null}
		onwarm={(what) =>
			void (what === "draw" ? ensureDrawing() : loadPlacement())}
		oninkchange={(next) => (ink = next)}
		ontoolchange={setTool}
		onundo={undo}
		onredo={redo}
		oninsert={insertBlock}
		onask={handleAsk}
	/>

	<SvelteFlow
		bind:nodes
		bind:edges
		bind:viewport
		{nodeTypes}
		defaultEdgeOptions={edgeDefaults}
		class="canvas-flow"
		aria-label={$t("artifacts.type.canvas")}
		fitView={fitOnOpen}
		{fitViewOptions}
		minZoom={0.2}
		maxZoom={2}
		{panOnDrag}
		{selectionOnDrag}
		{nodesDraggable}
		nodesConnectable={!readonly && !held}
		connectionMode={ConnectionMode.Loose}
		deleteKey={readonly || held ? null : ["Backspace", "Delete"]}
		elevateNodesOnSelect={false}
		attributionPosition="bottom-left"
		{ariaLabelConfig}
		isValidConnection={(connection) => connection.source !== connection.target}
		onbeforeconnect={handleBeforeConnect}
		onnodeclick={() => (insertSelectedId = null)}
		onnodedrag={handleNodeDrag}
		onnodedragstop={handleNodeDragStop}
		onbeforedelete={handleBeforeDelete}
		ondelete={handleDelete}
		onmoveend={(_, camera) => {
			restingZoom = camera.zoom;
			oncamera?.(camera);
		}}
	>
		<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
		<!-- The drawing layer, in the viewport's front layer so every point is a board point. -->
		{#if drawingViews}
			<ViewportPortal target="front">
				<drawingViews.AnnotationLayer
					{annotations}
					{viewport}
					paneSize={{ width: boardWidth, height: boardHeight }}
					{tool}
					{ink}
					{readonly}
					toBoard={(point) => flow.screenToFlowPosition(point)}
					onchange={handleAnnotations}
					ontoolchange={setTool}
					onannounce={announce}
					onlimit={handleLimit}
				/>
			</ViewportPortal>
		{/if}
		{@render layers?.(layerApi)}
		{#if showMinimap}
			<MiniMap
				width={132}
				height={88}
				pannable
				zoomable
				nodeColor={minimapColor}
				class="canvas-minimap"
				style="margin-bottom: 52px;"
			/>
		{/if}
		<Panel
			position="bottom-right"
			class={[
				"canvas-corner",
				stackedZoom && "canvas-corner--compact",
				stackedZoom && drawing && "canvas-corner--under-tray",
				zoomAside && "canvas-corner--aside",
			]}
		>
			<ZoomChip
				zoom={viewport.zoom}
				onzoomin={() => zoomBy(ZOOM_STEP)}
				onzoomout={() => zoomBy(1 / ZOOM_STEP)}
				onfit={() => flow.fitView({ ...fitViewOptions, duration: prefersReducedMotion() ? 0 : 200 })}
			/>
		</Panel>
	</SvelteFlow>

	{#if empty}
		<p class="canvas-empty" data-testid="canvas-empty">
			{$t("artifacts.canvas.emptyBoard")}
		</p>
	{/if}

	{#if limitNotice}
		<p class="canvas-limit" role="status" data-testid="canvas-limit-notice">
			{$t("artifacts.canvas.drawingLimit", { count: MAX_ANNOTATIONS_PER_BOARD })}
		</p>
	{/if}



	<span class="sr-only" role="status" aria-live="polite">{announcement}</span>
</div>

<style>
	/* The board is its own stacking context: everything inside — the toolbar at
	   --artifact-overlay-z, the library's own layers up to 2000 — stays inside it,
	   so it can neither sit over the app's sheets nor be covered by them. */
	.canvas-board {
		position: relative;
		isolation: isolate;
		flex: 1 1 auto;
		width: 100%;
		min-height: 320px;
		overflow: hidden;
		background: var(--surface-page);
	}

	/* A picture of the board shows the board, not the reader's selection: no
	   outline on a selected block, no anchors, no resize corners. */
	.canvas-board--picture :global(.canvas-node__box) {
		outline: none;
	}

	.canvas-board--picture :global(.svelte-flow__handle),
	.canvas-board--picture :global(.svelte-flow__resize-control) {
		display: none;
	}

	.canvas-board :global(.svelte-flow.svelte-flow) {
		--xy-background-color: var(--surface-page);
		--xy-background-pattern-color: color-mix(in srgb, var(--text-primary) 15%, transparent);
		--xy-edge-stroke: var(--text-muted);
		--xy-edge-stroke-selected: var(--accent);
		--xy-connectionline-stroke: var(--accent);
		--xy-selection-background-color: var(--accent-tint);
		--xy-selection-border: 1px solid var(--accent);
		--xy-minimap-background-color: var(--surface-page);
		--xy-minimap-mask-background-color: color-mix(in srgb, var(--surface-elevated) 70%, transparent);
		--xy-minimap-node-stroke-color: var(--border-default);
		--xy-attribution-background-color: transparent;
		font-family: var(--font-sans);
	}

	.canvas-board :global(.svelte-flow__attribution) {
		font-size: var(--text-2xs);
		opacity: 0.7;
	}

	.canvas-board :global(.svelte-flow__attribution a) {
		color: var(--text-muted);
	}

	/* A multi-selection's wrapper is hit-testable at z-index 2000 and would
	   swallow a tick in a checklist and a double-click on a selected note;
	   dragging still moves the whole selection, from any selected block. */
	.canvas-board :global(.svelte-flow__selection-wrapper) {
		pointer-events: none;
	}

	.canvas-board :global(.svelte-flow__node:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 3px;
	}

	.canvas-board :global(.canvas-minimap) {
		border: 1px solid var(--border-default);
		border-radius: 8px;
		overflow: hidden;
		box-shadow: var(--shadow-sm);
	}

	.canvas-board :global(.canvas-corner) {
		margin: 12px;
	}

	/* On a narrow board the toolbar spans most of the bottom edge, so the zoom
	   sits just above it instead of under it. */
	.canvas-board :global(.canvas-corner--compact) {
		margin-bottom: 68px;
	}

	/* On a phone the drawing tools take the space above the toolbar, where the
	   zoom sits; nothing zooms by button while a finger is drawing anyway. */
	.canvas-board :global(.canvas-corner--under-tray),
	.canvas-board :global(.canvas-corner--aside) {
		visibility: hidden;
	}

	.canvas-limit {
		position: absolute;
		top: 12px;
		left: 50%;
		z-index: var(--artifact-overlay-z);
		max-width: calc(100% - 24px);
		margin: 0;
		padding: 8px 12px;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: 10px;
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-size: var(--text-sm);
		text-align: center;
	}

	.canvas-empty {
		position: absolute;
		inset: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0;
		padding: var(--space-lg);
		color: var(--text-muted);
		font-size: var(--text-base);
		text-align: center;
		pointer-events: none;
	}
</style>
