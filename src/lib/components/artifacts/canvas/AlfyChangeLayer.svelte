<script lang="ts">
/**
 * Alfy's change drawn on the board (Feature 2 · Artifacts, Slice 3, T6 and ruling
 * 63), in BOARD space so it stays where it was left when the board pans and
 * zooms. The editor renders this inside the flow's front viewport layer
 * (`<ViewportPortal target="front">`, which it already has; this file imports
 * nothing from the flow, so loading it on demand does not pull the library into a
 * second chunk). It is a zero-size box at the board's origin with `z-index: 2`
 * inline (the flow lifts the children of a frame to 1, and a selector from an
 * ancestor cannot reach portal content) and takes no pointer, except for the pill.
 *
 * Three things are drawn, all from the same rectangles of the blocks as they are
 * now (so they follow a block while it glides to its new place):
 *
 *   - the dashed arranging frame around the blocks Alfy's ops address, while the
 *     call runs (the redesign's Alfy-writing state for a board);
 *   - a ring on each touched block: strong for a moment as the change arrives
 *     (`--alfy-mark-arrive`), settling to a resting outline that stays until Keep
 *     or Undo ("the arrived change keeps its mark", redesign §7.3);
 *   - the change pill, the Document's own `ChangeBar`, at the top-right corner of
 *     the box that holds the touched blocks, counter-scaled by the zoom so it is
 *     the size of a button on screen at any zoom.
 *
 * It draws and reports; it owns no state and knows nothing of the network. A
 * request to show a block (`goto`, the stepper's) centres the camera on it.
 */
import { tick, untrack } from "svelte";
import ChangeBar from "../document/ChangeBar.svelte";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import { nodeRect } from "./_lib/board";
import { visibleBoardRect } from "./_lib/pane-rect";
import {
	type Box,
	boxOf,
	changePillAnchor,
	padded,
	rectsOf,
} from "./_lib/review-geometry";

/** How far the dashed frame stands off what it surrounds, in board units. */
const FRAME_PADDING = 14;
/**
 * A frame's name chip sits across the frame's top edge, 12 units above it, and a
 * ring drawn on that edge struck the name through (RV-3 Minor 10): a frame's ring
 * stands this far outside the frame, all round, clear of the chip.
 */
const FRAME_RING_PADDING = 14;

let {
	nodes,
	viewport,
	arrangingIds = null,
	touched,
	pulseIds,
	activeId = null,
	pill = null,
	goto = null,
	paneSize = { width: 0, height: 0 },
	landed = 0,
	oncenter,
	onkeep,
	onundo,
	onredo,
}: {
	/** The blocks as they are drawn now. */
	nodes: readonly CanvasNode[];
	viewport: { x: number; y: number; zoom: number };
	/** The blocks Alfy is arranging: framed while the call runs. */
	arrangingIds?: readonly string[] | null;
	/** The blocks the change touched that still wait for the reader: a resting ring, and what the pill sits at. */
	touched: readonly string[];
	/** Blocks that are ringed strongly for a moment: what just landed, or what a `highlight` pointed at. */
	pulseIds: readonly string[];
	/** The block the review bar's stepper is on. */
	activeId?: string | null;
	/** The change pill: its state and the change's own summary. Absent when there is nothing to decide. */
	pill?: { status: "pending" | "kept" | "undone"; label: string } | null;
	/** One-shot "show this block": the camera centres on it. */
	goto?: { id: string; token: number } | null;
	/** The pane's size, to tell whether a landing is in view. */
	paneSize?: { width: number; height: number };
	/** Counts the landings that have settled: a change that came in is looked for on screen, once. */
	landed?: number;
	oncenter: (point: Pt) => void;
	onkeep: () => void;
	onundo: () => void;
	onredo: () => void;
} = $props();

let inv = $derived(viewport.zoom > 0 ? 1 / viewport.zoom : 1);

let frame = $derived.by<Box | null>(() => {
	if (!arrangingIds) return null;
	const box = boxOf(arrangingIds, nodes);
	return box ? padded(box, FRAME_PADDING) : null;
});

let rings = $derived.by(() => {
	const wanted = new Set([...pulseIds, ...touched]);
	const frames = new Set(
		nodes.filter((node) => node.type === "frame").map((node) => node.id),
	);
	return rectsOf(
		nodes.filter((node) => wanted.has(node.id)).map((node) => node.id),
		nodes,
	).map((ring) => {
		const frame = frames.has(ring.id);
		return {
			...ring,
			box: frame ? padded(ring.box, FRAME_RING_PADDING) : ring.box,
			frame,
		};
	});
});
let pulseSet = $derived(new Set(pulseIds));

// The pill follows the blocks it points at, and keeps off the blocks Alfy left
// alone (a frame is a backdrop, not one of them). When the change is decided (the
// rings go, an Undo takes blocks away) it keeps the corner it had, so "Undone ·
// Redo" stays put.
let liveAt = $derived(
	touched.length === 0
		? null
		: changePillAnchor({
				touched: rectsOf(touched, nodes).map(({ box }) => box),
				obstacles: nodes
					.filter((node) => node.type !== "frame")
					.map((node) => nodeRect(node, nodes, node.measured)),
				zoom: viewport.zoom,
			}),
);
let lastAt = $state<Pt | null>(null);
$effect(() => {
	const live = liveAt;
	if (live) untrack(() => (lastAt = live));
});
let anchor = $derived(liveAt ?? lastAt);

// A landing puts blocks where the camera is not looking, and did not move it: a
// change that is wholly off the pane (or behind its toolbar) went unseen. When none
// of it is in view once a landing has settled, the camera goes to the first block.
// What was already there when this came up (a reload) is shown as it is.
let seenLanding = untrack(() => landed);
$effect(() => {
	const token = landed;
	if (token === seenLanding) return;
	seenLanding = token;
	untrack(() => {
		const rects = rectsOf(touched, nodes);
		const shown = visibleBoardRect(paneSize, viewport);
		if (rects.length === 0 || shown.width === 0) return;
		const inView = rects.some(
			({ box }) =>
				box.x < shown.left + shown.width &&
				box.x + box.width > shown.left &&
				box.y < shown.top + shown.height &&
				box.y + box.height > shown.top,
		);
		if (inView) return;
		const [first] = rects;
		oncenter({
			x: first.box.x + first.box.width / 2,
			y: first.box.y + first.box.height / 2,
		});
	});
});

// Focus follows the decision. The button that was pressed (in the bar, which
// leaves, or on the pill, which changes its buttons) is gone by the time the
// change is decided, and a keyboard reader must not be dropped on the page:
// Undo lands on "Redo", Redo on "Undo", Keep on the board's first tool. Only when
// focus was lost or was on the change's own controls: it never takes it from
// anything else the reader is doing.
let pillEl = $state<HTMLDivElement | undefined>();
let lastStatus: "pending" | "kept" | "undone" | null = null;

function focusIsAdrift(): boolean {
	const active = document.activeElement;
	if (!active || active === document.body) return true;
	return (
		active.closest(
			'[data-testid="canvas-review-bar"], [data-testid="canvas-change-pill"]',
		) !== null
	);
}

$effect(() => {
	const status = pill?.status ?? null;
	const before = lastStatus;
	lastStatus = status;
	if (before === null || status === null || before === status) return;
	void tick().then(() => {
		if (!focusIsAdrift()) return;
		if (status === "kept") {
			document
				.querySelector<HTMLElement>('[data-testid="canvas-tool-select"]')
				?.focus();
		} else {
			pillEl?.querySelector<HTMLElement>(".alfy-change-bar-undo")?.focus();
		}
	});
});

let appliedGoto = -1;
$effect(() => {
	const request = goto;
	if (!request || request.token === appliedGoto) return;
	appliedGoto = request.token;
	untrack(() => {
		const [rect] = rectsOf([request.id], nodes);
		if (!rect) return;
		oncenter({
			x: rect.box.x + rect.box.width / 2,
			y: rect.box.y + rect.box.height / 2,
		});
	});
});
</script>

<!-- z-index 2, inline: the flow lifts the children of a frame to 1, and a selector from an ancestor cannot reach portal content. -->
<div
	class="alfy-layer"
	style="z-index: 2"
	style:--inv={inv}
	data-testid="alfy-change-layer"
>
	{#if frame}
		<div
			class="arrange-frame"
			data-testid="canvas-arranging-frame"
			aria-hidden="true"
			style:left="{frame.x}px"
			style:top="{frame.y}px"
			style:width="{frame.width}px"
			style:height="{frame.height}px"
		></div>
	{/if}
	{#each rings as ring (ring.id)}
		<div
			class="ring"
			class:ring--pulse={pulseSet.has(ring.id)}
			class:ring--frame={ring.frame}
			class:ring--active={ring.id === activeId}
			data-testid="canvas-alfy-ring"
			data-node-id={ring.id}
			aria-hidden="true"
			style:left="{ring.box.x}px"
			style:top="{ring.box.y}px"
			style:width="{ring.box.width}px"
			style:height="{ring.box.height}px"
		></div>
	{/each}
	{#if pill && anchor}
		<div
			class="pill nopan"
			bind:this={pillEl}
			data-testid="canvas-change-pill"
			style:left="{anchor.x}px"
			style:top="{anchor.y}px"
		>
			<ChangeBar
				status={pill.status}
				blockLabel={pill.label}
				onKeep={onkeep}
				onUndo={onundo}
				onRedo={onredo}
			/>
		</div>
	{/if}
</div>

<style>
	.alfy-layer {
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	/* The stroke widths are in screen pixels whatever the zoom: `--inv` is 1 / zoom. */
	.arrange-frame {
		position: absolute;
		box-sizing: border-box;
		border: calc(1.5px * var(--inv)) dashed
			color-mix(in srgb, var(--accent-fill) 55%, transparent);
		border-radius: calc(12px * var(--inv));
		background-color: color-mix(in srgb, var(--accent-fill) 5%, transparent);
		animation: alfy-arrange 1.6s ease-in-out infinite;
	}

	@keyframes alfy-arrange {
		0%,
		100% {
			opacity: 0.65;
		}
		50% {
			opacity: 1;
		}
	}

	/* The resting ring: an outline in the accent, no fill, so the block stays legible. */
	.ring {
		position: absolute;
		box-sizing: border-box;
		border-radius: calc(10px * var(--inv));
		box-shadow: 0 0 0 calc(2px * var(--inv))
			color-mix(in srgb, var(--accent-fill) 55%, transparent);
	}

	/* Arriving: loud, then settling over 3.2 s (spec T6). Under reduced motion
	   app.css collapses the animation to its last frame, the resting ring, so the
	   mark is still there and nothing moves. */
	.ring--pulse {
		animation: alfy-ring-arrive 3.2s var(--ease-out, ease-out) both;
	}

	@keyframes alfy-ring-arrive {
		from {
			background-color: var(--alfy-mark-arrive);
			box-shadow: 0 0 0 calc(3px * var(--inv)) var(--accent-fill);
		}
		to {
			background-color: transparent;
			box-shadow: 0 0 0 calc(2px * var(--inv))
				color-mix(in srgb, var(--accent-fill) 55%, transparent);
		}
	}

	/* A frame is big: its arrival is the outline and a light tint, not a slab of colour over what is inside it. */
	.ring--frame.ring--pulse {
		animation-name: alfy-ring-arrive-frame;
	}

	@keyframes alfy-ring-arrive-frame {
		from {
			background-color: var(--alfy-mark);
			box-shadow: 0 0 0 calc(3px * var(--inv)) var(--accent-fill);
		}
		to {
			background-color: transparent;
			box-shadow: 0 0 0 calc(2px * var(--inv))
				color-mix(in srgb, var(--accent-fill) 55%, transparent);
		}
	}

	/* The block the stepper is on. */
	.ring--active {
		box-shadow: 0 0 0 calc(3px * var(--inv)) var(--accent-fill);
	}

	/* At the corner, the size of a button whatever the zoom: scaled by 1 / zoom from
	   the point it hangs from, then lifted clear of the box and of a comment's pin,
	   which sits on that same corner. */
	.pill {
		position: absolute;
		pointer-events: auto;
		transform-origin: 0 0;
		transform: scale(var(--inv)) translate(-100%, calc(-100% - 16px));
		white-space: nowrap;
	}

	.pill :global(.alfy-change-bar) {
		margin-left: 0;
	}
</style>
