<script lang="ts">
/**
 * The box around several picked blocks (the owner's walk: "move them/resize them
 * together"). While two or more blocks are picked the board hands each block's own
 * corners and toolbar over to this: ONE box around all of them with eight handles
 * (corners scale both ways, edges one), and ONE small toolbar above it (how many are
 * picked, Delete for all of them). A handle scales the blocks' places and sizes with
 * the box (`_lib/group-scale.ts`, the arithmetic); this draws it and runs the pointer.
 *
 * It is drawn in SCREEN space, in a layer over the pane, from the camera: handles are
 * the size of a button at any zoom (a fingertip, 44 px, on a coarse pointer) and
 * need no counter-scaling. The blocks are never moved by a drag on the box (the
 * library moves a picked block, and with it every other picked one, from the block
 * itself); the box only has its handles and its toolbar to press.
 *
 * One gesture is one step: the board holds its settle timer while a handle is held
 * (`onresizestart` / `onresizeend`), so the whole drag becomes one entry in the
 * reader's history and one save. Escape during the drag puts everything back;
 * Escape otherwise puts the selection down. Loaded on demand with the first
 * selection of two (`group-parts.ts`), and imports no flow library.
 */
import { Trash2 } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import {
	type Group,
	type GroupHandle,
	groupOf,
	resizeGroup,
} from "./_lib/group-scale";

/** What a block is given: its place and size, and the size as measured (what the library would find on its next look, so the box never reads a stale one). */
type Geometry = {
	position: Pt;
	width?: number;
	height?: number;
	measured?: { width: number; height: number };
};

let {
	nodes,
	viewport,
	size,
	coarse,
	typing,
	onresizestart,
	onresize,
	onresizeend,
	ondelete,
	onclear,
	onannounce,
}: {
	/** The blocks as drawn now, with which are picked. */
	nodes: readonly CanvasNode[];
	viewport: { x: number; y: number; zoom: number };
	/** The pane's size, for the toolbar to stay inside it. */
	size: { width: number; height: number };
	/** A finger: handles are 44 px, and an edge too short for two of them has none. */
	coarse: boolean;
	/** Whether a key's target is a field the reader types words in (`isTextEntry`, handed over so this part never imports a module the editor shares: it would be split out of the editor's chunk). */
	typing: (target: EventTarget | null) => boolean;
	/** A handle is held: the board waits before calling what changed a step. */
	onresizestart: () => void;
	/** Puts these places and sizes on the blocks (each in the space it is stored in). */
	onresize: (patches: ReadonlyMap<string, Geometry>) => void;
	/** The handle is let go (or the drag was cancelled): the change is one step now. */
	onresizeend: () => void;
	ondelete: (ids: string[]) => void;
	/** Escape: nothing is picked any more. */
	onclear: () => void;
	onannounce: (message: string) => void;
} = $props();

const HANDLES: readonly GroupHandle[] = [
	"nw",
	"n",
	"ne",
	"e",
	"se",
	"s",
	"sw",
	"w",
];
/** How far outside the blocks the box is drawn, in screen pixels: clear of each block's own outline. */
const GAP = 9;
/** A side shorter than this has no edge handle for a finger: two 44 px targets would overlap. */
const EDGE_MIN_COARSE = 140;
const TOOLBAR_HALF = 56;

let layerEl = $state<HTMLDivElement | undefined>();
let group = $derived(groupOf(nodes));
let gesture = $state.raw<{
	pointerId: number;
	handle: GroupHandle;
	x: number;
	y: number;
	group: Group;
	box: Group["box"];
	/** What the blocks were, to put them back on Escape. */
	originals: Map<string, Geometry>;
} | null>(null);

let ids = $derived(nodes.filter((node) => node.selected).map((node) => node.id));
let box = $derived(gesture?.box ?? group?.box ?? null);
let screen = $derived(
	box
		? {
				left: box.x * viewport.zoom + viewport.x - GAP,
				top: box.y * viewport.zoom + viewport.y - GAP,
				width: box.width * viewport.zoom + GAP * 2,
				height: box.height * viewport.zoom + GAP * 2,
			}
		: null,
);
let label = $derived($t("artifacts.canvas.group.label", { count: ids.length }));
let deleteLabel = $derived(
	$t("artifacts.canvas.group.delete", { count: ids.length }),
);
// Above the box, in the middle of it, and inside the pane whatever is in view.
let toolbar = $derived(
	screen
		? {
				left: Math.min(
					Math.max(screen.left + screen.width / 2, 8 + TOOLBAR_HALF),
					Math.max(8 + TOOLBAR_HALF, size.width - 8 - TOOLBAR_HALF),
				),
				top: Math.max(8, screen.top - (coarse ? 48 : 36) - 10),
			}
		: null,
);

function shown(handle: GroupHandle): boolean {
	if (!coarse || !screen || handle.length === 2) return true;
	const along = handle === "n" || handle === "s" ? screen.width : screen.height;
	return along >= EDGE_MIN_COARSE;
}

// While a pointer drags something else (a block, the marquee) the box keeps out of its
// way, and comes back when it lets go; a press that does not travel changes nothing.
let quiet = $state(false);
$effect(() => {
	let from: { x: number; y: number } | null = null;
	const down = (event: PointerEvent) => {
		from = layerEl?.contains(event.target as Node)
			? null
			: { x: event.clientX, y: event.clientY };
	};
	const move = (event: PointerEvent) => {
		if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4) {
			quiet = true;
		}
	};
	const up = () => {
		from = null;
		quiet = false;
	};
	window.addEventListener("pointerdown", down, true);
	window.addEventListener("pointermove", move, true);
	window.addEventListener("pointerup", up, true);
	window.addEventListener("pointercancel", up, true);
	return () => {
		window.removeEventListener("pointerdown", down, true);
		window.removeEventListener("pointermove", move, true);
		window.removeEventListener("pointerup", up, true);
		window.removeEventListener("pointercancel", up, true);
	};
});

// What a screen reader hears when the number of picked blocks changes.
let announcedCount = 0;
$effect(() => {
	if (ids.length !== announcedCount) {
		announcedCount = ids.length;
		onannounce(label);
	}
});

function begin(event: PointerEvent, handle: GroupHandle): void {
	if (gesture || !group) return;
	if (event.pointerType === "mouse" && event.button !== 0) return;
	event.preventDefault();
	event.stopPropagation();
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	const originals = new Map<string, Geometry>();
	for (const item of group.items) {
		const node = nodes.find((candidate) => candidate.id === item.id);
		if (node) {
			originals.set(item.id, {
				position: node.position,
				width: node.width,
				height: node.height,
				measured: node.measured,
			});
		}
	}
	gesture = {
		pointerId: event.pointerId,
		handle,
		x: event.clientX,
		y: event.clientY,
		group,
		box: group.box,
		originals,
	};
	onresizestart();
}

function drag(event: PointerEvent): void {
	if (!gesture || event.pointerId !== gesture.pointerId) return;
	const zoom = viewport.zoom || 1;
	const next = resizeGroup(gesture.group, gesture.handle, {
		x: (event.clientX - gesture.x) / zoom,
		y: (event.clientY - gesture.y) / zoom,
	});
	gesture = { ...gesture, box: next.box };
	onresize(
		new Map(
			[...next.patches].map(([id, patch]) => [
				id,
				{ ...patch, measured: { width: patch.width, height: patch.height } },
			]),
		),
	);
}

function finish(event: PointerEvent): void {
	if (!gesture || event.pointerId !== gesture.pointerId) return;
	gesture = null;
	onresizeend();
}

// The box can go while a handle is held (a landing starts drawing, the panel closes):
// the board must not wait for a let-go that will not come.
$effect(() => () => {
	if (gesture) {
		gesture = null;
		onresizeend();
	}
});

/** Puts everything back as it was when the handle was taken, and ends the gesture. */
function cancel(): void {
	if (!gesture) return;
	const { originals } = gesture;
	gesture = null;
	onresize(originals);
	onresizeend();
}

/** Only while the reader is on this board: a key pressed somewhere else in the panel is not for it. */
function insideBoard(): boolean {
	const board = layerEl?.closest("[data-testid='canvas-board']");
	return !board || board.contains(document.activeElement);
}

// Capture phase, like the selection's pill: Escape is the board's before the
// panel's own handler (which closes an expanded panel) can see it.
$effect(() => {
	window.addEventListener("keydown", handleKeydown, true);
	return () => window.removeEventListener("keydown", handleKeydown, true);
});

function handleKeydown(event: KeyboardEvent): void {
	if (event.key !== "Escape") return;
	if (gesture) {
		event.preventDefault();
		event.stopPropagation();
		cancel();
		return;
	}
	if (typing(event.target) || !insideBoard()) return;
	event.preventDefault();
	event.stopPropagation();
	onclear();
}
</script>

<div class="group-layer" class:quiet bind:this={layerEl}>
	{#if screen && toolbar}
		<div
			class="group-box"
			data-testid="canvas-group-box"
			style:left="{screen.left}px"
			style:top="{screen.top}px"
			style:width="{screen.width}px"
			style:height="{screen.height}px"
		>
			{#each HANDLES as handle (handle)}
				{#if shown(handle)}
					<span
						class="handle handle--{handle}"
						data-testid="canvas-group-handle-{handle}"
						aria-hidden="true"
						onpointerdown={(event) => begin(event, handle)}
						onpointermove={drag}
						onpointerup={finish}
						onlostpointercapture={finish}
						onpointercancel={() => cancel()}
					></span>
				{/if}
			{/each}
		</div>
		<div
			class="group-toolbar"
			role="toolbar"
			aria-label={label}
			data-testid="canvas-group-toolbar"
			style:left="{toolbar.left}px"
			style:top="{toolbar.top}px"
		>
			<span class="count" aria-hidden="true">{ids.length}</span>
			<button
				type="button"
				class="delete"
				aria-label={deleteLabel}
				title={deleteLabel}
				data-testid="canvas-group-delete"
				onclick={() => ondelete(ids)}
			>
				<Trash2 size={15} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
	{/if}
</div>

<style>
	.group-layer {
		position: absolute;
		inset: 0;
		z-index: 4;
		overflow: hidden;
		pointer-events: none;
	}

	.group-layer.quiet {
		visibility: hidden;
	}

	.group-box {
		position: absolute;
		box-sizing: border-box;
		border: 1px solid var(--accent);
		border-radius: 3px;
	}

	/* A handle is as big as its hit area (a finger gets 44 px) and draws the small
	   square the block corners draw, in its middle. */
	.handle {
		--hit: 16px;
		position: absolute;
		width: var(--hit);
		height: var(--hit);
		transform: translate(-50%, -50%);
		pointer-events: auto;
		touch-action: none;
	}

	.handle::before {
		content: "";
		position: absolute;
		inset: 50% auto auto 50%;
		width: 8px;
		height: 8px;
		transform: translate(-50%, -50%);
		box-sizing: border-box;
		border: 1.5px solid var(--accent);
		border-radius: 2px;
		background: var(--surface-page);
	}

	.handle:hover::before,
	.handle:active::before {
		background: var(--accent-tint);
	}

	@media (pointer: coarse) {
		.handle {
			--hit: 44px;
		}

		.handle::before {
			width: 12px;
			height: 12px;
		}
	}

	.handle--nw {
		left: 0;
		top: 0;
		cursor: nwse-resize;
	}

	.handle--n {
		left: 50%;
		top: 0;
		cursor: ns-resize;
	}

	.handle--ne {
		left: 100%;
		top: 0;
		cursor: nesw-resize;
	}

	.handle--e {
		left: 100%;
		top: 50%;
		cursor: ew-resize;
	}

	.handle--se {
		left: 100%;
		top: 100%;
		cursor: nwse-resize;
	}

	.handle--s {
		left: 50%;
		top: 100%;
		cursor: ns-resize;
	}

	.handle--sw {
		left: 0;
		top: 100%;
		cursor: nesw-resize;
	}

	.handle--w {
		left: 0;
		top: 50%;
		cursor: ew-resize;
	}

	.group-toolbar {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 36px;
		padding: 0 4px 0 10px;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: 10px;
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-size: var(--text-sm);
		pointer-events: auto;
	}

	.count {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}

	.delete {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 30px;
		height: 30px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.delete:hover {
		background: var(--surface-sunken, var(--accent-tint));
		color: var(--text-primary);
	}

	.delete:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.group-toolbar {
			height: 48px;
		}

		.delete {
			min-width: 44px;
			height: 44px;
		}
	}
</style>
