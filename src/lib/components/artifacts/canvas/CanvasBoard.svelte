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
 * Seams for the slices after this one: strokes and pins render through a
 * `<ViewportPortal target="front">` inside the flow (explicit `z-index: 2`, and
 * sized from the visible pane, never from the board); frames' reparenting is an
 * `onnodedragstop` handler; connectors and their labels are the `edges` state
 * and `onbeforeconnect`; a diff from Alfy arrives as new `nodes` state through
 * `applyBody`-style replacement followed by `commit`'s bookkeeping.
 */
import "@xyflow/svelte/dist/base.css";
import {
	Background,
	BackgroundVariant,
	type Connection,
	ConnectionMode,
	type Edge,
	MiniMap,
	Panel,
	SvelteFlow,
	useSvelteFlow,
	type Viewport,
} from "@xyflow/svelte";
import { onDestroy, untrack } from "svelte";
import { historyShortcutFor } from "$lib/components/artifacts/document/keyboard-shortcuts";
import { t } from "$lib/i18n";
import type { Annotation, CanvasBody } from "$lib/shared/artifacts/canvas";
import { normalizeCanvasBody } from "$lib/shared/artifacts/canvas-body";
import { createBoardHistory } from "./_lib/board-history";
import { provideBoardContext } from "./_lib/board-context";
import {
	bodyOfState,
	type FlowNode,
	hasStoredCamera,
	structuralJson,
	toFlowNodes,
} from "./_lib/board-model";
import {
	type BlockRegistryEntry,
	boardNodeTypes,
	newBlockNode,
} from "./_lib/block-registry";
import { placeInsertedBlock } from "./_lib/placement";
import CanvasToolbar, { type BoardTool } from "./CanvasToolbar.svelte";
import ZoomChip from "./ZoomChip.svelte";

let {
	body,
	readonly = false,
	onchange,
	oncamera,
}: {
	/** The board to draw. Read once, when the board mounts: to show a different one (a reload, a restore) the editor mounts a new board. */
	body: CanvasBody;
	/** The board cannot change now (a conflict is waiting on the reader's choice, or the item is gone). It still draws and pans. */
	readonly?: boolean;
	/** One step of the reader's, complete: the whole board, camera included. Never a bare pan. */
	onchange: (body: CanvasBody) => void;
	/** The camera settled somewhere. In memory only: it is saved with the next real change. */
	oncamera?: (camera: Viewport) => void;
} = $props();

const initial = untrack(() => body);
const flow = useSvelteFlow();
const nodeTypes = boardNodeTypes();

let nodes = $state.raw<FlowNode[]>(toFlowNodes(initial.nodes));
let edges = $state.raw<Edge[]>(initial.edges.map((edge) => ({ ...edge })));
let viewport = $state.raw<Viewport>({ ...initial.viewport });
// Carried, written back and undone with the rest; drawn by the drawing layer.
let annotations = $state.raw<Annotation[]>([...initial.annotations]);

/** Wait this long after the last change before calling it a step: a drag or a burst of typing is one. */
const SETTLE_MS = 350;
/** A panel narrower than this gets the compact toolbar and no minimap. */
const COMPACT_BELOW = 480;
const MINIMAP_ABOVE = 720;

let boardEl = $state<HTMLElement | null>(null);
let boardWidth = $state(0);
let tool = $state<BoardTool>("select");
let coarsePointer = $state(false);
let announcement = $state("");

const history = createBoardHistory();
let canUndo = $state(false);
let canRedo = $state(false);
let committedJson = structuralJson(snapshot());
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let announceTimer: ReturnType<typeof setTimeout> | null = null;
const editRequests = new Set<string>();

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
	commit();
});

/** Ends any pending step at once and hands back the board exactly as it is. */
export function flush(): CanvasBody {
	commit();
	return snapshot();
}

// ---- The reader's own history (ruling 16) --------------------------------

function restore(json: string): void {
	const restored = normalizeCanvasBody(JSON.parse(json)).body;
	nodes = toFlowNodes(restored.nodes);
	edges = restored.edges.map((edge) => ({ ...edge }));
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

// ---- Insert --------------------------------------------------------------

function insertBlock(row: BlockRegistryEntry): void {
	if (readonly || !boardEl) return;
	// What was pending is a step of its own, so Undo takes the insert back alone.
	commit();
	const rect = boardEl.getBoundingClientRect();
	const center = flow.screenToFlowPosition({
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2,
	});
	const position = placeInsertedBlock({
		center,
		size: row.size,
		taken: nodes.filter((node) => !node.parentId).map((node) => node.position),
	});
	const [added] = toFlowNodes([newBlockNode(row.kind, position)]);
	// Text a reader writes opens for typing at once.
	if (row.section === "text") editRequests.add(added.id);
	nodes = [
		...nodes.map((node) =>
			node.selected ? { ...node, selected: false } : node,
		),
		{ ...added, selected: true },
	];
	commit();
}

// ---- The flow's own events ----------------------------------------------

function handleBeforeConnect(connection: Connection): Edge {
	// v1 adds the edge itself once this returns it, then fires `onconnect` as a
	// notification: the id has to be stamped here, and only here.
	return { ...connection, id: crypto.randomUUID() };
}

function handleDelete(): void {
	commit();
	announcement = $t("artifacts.canvas.nodeDeleted");
	if (announceTimer) clearTimeout(announceTimer);
	announceTimer = setTimeout(() => (announcement = ""), 3000);
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

let compact = $derived(boardWidth > 0 && boardWidth < COMPACT_BELOW);
let showMinimap = $derived(boardWidth >= MINIMAP_ABOVE && nodes.length > 0);
let empty = $derived(nodes.length === 0 && annotations.length === 0);
// A finger has no other way to pan, so on touch a drag on the pane always pans;
// with a pointer, a plain drag on the pane selects (middle and right buttons pan).
let panOnDrag = $derived(tool === "pan" || coarsePointer ? true : [1, 2]);
let selectionOnDrag = $derived(tool === "select" && !coarsePointer);
let nodesDraggable = $derived(!readonly && tool === "select");
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
	bind:this={boardEl}
	bind:clientWidth={boardWidth}
	data-testid="canvas-board"
	data-tool={tool}
>
	<SvelteFlow
		bind:nodes
		bind:edges
		bind:viewport
		{nodeTypes}
		class="canvas-flow"
		aria-label={$t("artifacts.type.canvas")}
		fitView={fitOnOpen}
		{fitViewOptions}
		minZoom={0.2}
		maxZoom={2}
		{panOnDrag}
		{selectionOnDrag}
		{nodesDraggable}
		nodesConnectable={!readonly}
		connectionMode={ConnectionMode.Loose}
		deleteKey={["Backspace", "Delete"]}
		elevateNodesOnSelect={false}
		attributionPosition="bottom-left"
		{ariaLabelConfig}
		isValidConnection={(connection) => connection.source !== connection.target}
		onbeforeconnect={handleBeforeConnect}
		ondelete={handleDelete}
		onmoveend={(_, camera) => oncamera?.(camera)}
	>
		<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
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
		<Panel position="bottom-right" class="canvas-corner">
			<ZoomChip
				zoom={viewport.zoom}
				onzoomin={() => flow.zoomIn()}
				onzoomout={() => flow.zoomOut()}
				onfit={() => flow.fitView({ ...fitViewOptions, duration: 200 })}
			/>
		</Panel>
	</SvelteFlow>

	{#if empty}
		<p class="canvas-empty" data-testid="canvas-empty">
			{$t("artifacts.canvas.emptyBoard")}
		</p>
	{/if}

	<CanvasToolbar
		{tool}
		{compact}
		{canUndo}
		{canRedo}
		disabled={readonly}
		emphasizeInsert={empty}
		ontoolchange={(next) => (tool = next)}
		onundo={undo}
		onredo={redo}
		oninsert={insertBlock}
	/>

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
