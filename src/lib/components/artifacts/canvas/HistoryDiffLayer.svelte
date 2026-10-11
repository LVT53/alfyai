<script lang="ts">
/**
 * What a version changed, drawn on its board in BOARD space (ruling 76,
 * versioning.md §5.4): a ring on each block this comparison touched, a "New" tag
 * on the ones that are new and a "Moved" tag on the ones that stand somewhere
 * else (with a faint dashed trail from where each stood), and a dashed ghost
 * where something is gone. The preview renders this inside the flow's front
 * viewport layer (`<ViewportPortal target="front">`); this file imports nothing
 * from the flow. It takes no pointer and is `aria-hidden`: the same changes are a
 * list of buttons beside the board (`CanvasVersionPreview.svelte`).
 *
 * The rectangles are the blocks as they are drawn now (measured), so a ring
 * follows a block whose content grew after it was drawn. A ghost stays where the
 * block stood in the other board: there is nothing in this one to follow. Alfy's
 * changes wear its accent, the reader's the neutral ink, as on the Document.
 *
 * The stepper's stop (`flash`) is a 3 px ring and a deeper tint for 900 ms, a
 * class that is put on and taken off, so under reduced motion it is the same ring,
 * still, for the same time; `goto` centres the camera on it.
 */
import { onDestroy, untrack } from "svelte";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import { nodeRect, type Rect } from "./_lib/board";
import type { HistoryBoardView } from "./_lib/history-view";

/** How far a frame's ring stands off its edge, clear of the name chip across it (as the landing's). */
const FRAME_RING_PADDING = 14;
const FLASH_MS = 900;

let {
	nodes,
	viewport,
	view,
	tone,
	flash = null,
	oncenter,
	labels,
}: {
	/** The blocks as they are drawn now. */
	nodes: readonly CanvasNode[];
	viewport: { x: number; y: number; zoom: number };
	view: HistoryBoardView;
	/** Alfy's change wears its accent; the reader's, and any comparison with now, the neutral ink. */
	tone: "alfy" | "user";
	/** The change the stepper is on: ringed hard for 900 ms, and the camera goes to it. `nonce` makes the same stop flash again. */
	flash?: { id: string; nonce: number } | null;
	oncenter: (point: Pt) => void;
	labels: { new: string; moved: string; removed: string };
} = $props();

let inv = $derived(viewport.zoom > 0 ? 1 / viewport.zoom : 1);

const byId = $derived(new Map(nodes.map((node) => [node.id, node])));

function liveRect(id: string): Rect | null {
	const node = byId.get(id);
	return node ? nodeRect(node, nodes, node.measured) : null;
}

function grown(box: Rect, by: number): Rect {
	return {
		x: box.x - by,
		y: box.y - by,
		width: box.width + by * 2,
		height: box.height + by * 2,
	};
}

let rings = $derived(
	view.ringIds.flatMap((id) => {
		const box = liveRect(id);
		if (!box) return [];
		const frame = byId.get(id)?.data.kind === "frame";
		return [{ id, frame, box: frame ? grown(box, FRAME_RING_PADDING) : box }];
	}),
);

/** A block that is new wears "New" even when it also stands somewhere else than where nothing was. */
let tags = $derived.by(() => {
	const added = new Set(view.newIds);
	const tagged: { id: string; kind: "new" | "moved"; box: Rect }[] = [];
	for (const ring of rings) {
		if (added.has(ring.id)) {
			tagged.push({ id: ring.id, kind: "new", box: ring.box });
		} else if (view.moved.some((entry) => entry.id === ring.id)) {
			tagged.push({ id: ring.id, kind: "moved", box: ring.box });
		}
	}
	return tagged;
});

let trails = $derived(
	view.moved.flatMap((entry) => {
		const now = liveRect(entry.id);
		if (!now) return [];
		return [
			{
				id: entry.id,
				from: entry.from,
				x1: entry.from.x + entry.from.width / 2,
				y1: entry.from.y + entry.from.height / 2,
				x2: now.x + now.width / 2,
				y2: now.y + now.height / 2,
			},
		];
	}),
);

// The stepper's stop: ring it hard for 900 ms and bring the camera to it.
let flashingId = $state<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let seenNonce = untrack(() => flash?.nonce ?? -1);
$effect(() => {
	const request = flash;
	if (!request || request.nonce === seenNonce) return;
	seenNonce = request.nonce;
	untrack(() => {
		const rect =
			liveRect(request.id) ??
			view.ghosts.find((ghost) => ghost.id === request.id)?.rect ??
			null;
		if (rect) {
			oncenter({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
		}
		flashingId = request.id;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => {
			flashingId = null;
			flashTimer = null;
		}, FLASH_MS);
	});
});
onDestroy(() => {
	if (flashTimer) clearTimeout(flashTimer);
});
</script>

<!-- z-index 2, inline: the flow lifts the children of a frame to 1, and a selector from an ancestor cannot reach portal content. -->
<div
	class="history-layer"
	style="z-index: 2"
	style:--inv={inv}
	data-testid="canvas-history-layer"
	data-tone={tone}
	aria-hidden="true"
>
	<svg class="trails" width="1" height="1">
		{#each trails as trail (trail.id)}
			<line
				class="trail"
				data-testid="canvas-history-trail"
				x1={trail.x1}
				y1={trail.y1}
				x2={trail.x2}
				y2={trail.y2}
			/>
		{/each}
	</svg>
	{#each trails as trail (trail.id)}
		<div
			class="was"
			style:left="{trail.from.x}px"
			style:top="{trail.from.y}px"
			style:width="{trail.from.width}px"
			style:height="{trail.from.height}px"
		></div>
	{/each}
	{#each view.ghosts as ghost (ghost.id)}
		<div
			class="ghost"
			class:ghost--flash={flashingId === ghost.id}
			data-testid="canvas-history-ghost"
			data-node-id={ghost.id}
			style:left="{ghost.rect.x}px"
			style:top="{ghost.rect.y}px"
			style:width="{ghost.rect.width}px"
			style:height="{ghost.rect.height}px"
		>
			{#if ghost.label}<span class="ghost-label">{ghost.label}</span>{/if}
			<span class="tag tag--removed">{labels.removed}</span>
		</div>
	{/each}
	{#each rings as ring (ring.id)}
		<div
			class="ring"
			class:ring--frame={ring.frame}
			class:ring--flash={flashingId === ring.id}
			data-testid="canvas-history-ring"
			data-node-id={ring.id}
			style:left="{ring.box.x}px"
			style:top="{ring.box.y}px"
			style:width="{ring.box.width}px"
			style:height="{ring.box.height}px"
		></div>
	{/each}
	{#each tags as tag (tag.id)}
		<span
			class="tag tag--{tag.kind}"
			data-testid="canvas-history-tag"
			data-node-id={tag.id}
			style:left="{tag.box.x + tag.box.width}px"
			style:top="{tag.box.y}px"
		>{tag.kind === 'new' ? labels.new : labels.moved}</span>
	{/each}
</div>

<style>
	.history-layer {
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	.trails {
		position: absolute;
		left: 0;
		top: 0;
		overflow: visible;
	}

	/* Screen pixels whatever the zoom: the stroke does not scale, nor do the dashes. */
	.trail {
		stroke: color-mix(in srgb, var(--text-primary) 35%, transparent);
		stroke-width: 2;
		stroke-dasharray: 6 5;
		vector-effect: non-scaling-stroke;
	}

	/* Where a moved block stood: a faint dashed outline, with no tag of its own. */
	.was {
		position: absolute;
		box-sizing: border-box;
		border: calc(2px * var(--inv)) dashed
			color-mix(in srgb, var(--text-primary) 25%, transparent);
		border-radius: calc(8px * var(--inv));
	}

	.ghost {
		position: absolute;
		box-sizing: border-box;
		border: calc(2px * var(--inv)) dashed
			color-mix(in srgb, var(--danger) 55%, transparent);
		border-radius: calc(8px * var(--inv));
		overflow: visible;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.ghost--flash {
		background-color: color-mix(in srgb, var(--danger) 10%, transparent);
	}

	.ghost-label {
		position: absolute;
		inset: calc(8px * var(--inv));
		overflow: hidden;
		color: var(--text-muted);
		font-size: calc(12px * var(--inv));
		line-height: 1.3;
		text-overflow: ellipsis;
	}

	/* The ring: an outline in the author's colour, no fill, so the block stays legible. */
	.ring {
		position: absolute;
		box-sizing: border-box;
		border-radius: calc(10px * var(--inv));
		box-shadow: 0 0 0 calc(3px * var(--inv))
			color-mix(in srgb, var(--text-primary) 45%, transparent);
		transition:
			box-shadow var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out);
	}

	[data-tone='alfy'] .ring {
		box-shadow: 0 0 0 calc(3px * var(--inv))
			color-mix(in srgb, var(--accent-fill) 65%, transparent);
	}

	/* The stepper's stop: a deeper tint and a heavier ring for 900 ms. */
	.ring--flash {
		background-color: color-mix(in srgb, var(--text-primary) 8%, transparent);
		box-shadow: 0 0 0 calc(4px * var(--inv)) var(--text-primary);
	}

	[data-tone='alfy'] .ring--flash {
		background-color: var(--alfy-mark-arrive);
		box-shadow: 0 0 0 calc(4px * var(--inv)) var(--accent-fill);
	}

	/* At the block's top-right corner, the size of a button whatever the zoom: scaled by 1 / zoom from the corner it hangs from, then 10 above it and 8 out past it. */
	.tag {
		position: absolute;
		padding: 0 7px;
		border-radius: var(--radius-full);
		font-size: 10.5px;
		font-weight: 700;
		line-height: 18px;
		white-space: nowrap;
		transform-origin: 0 0;
		transform: scale(var(--inv)) translate(calc(-100% + 8px), -10px);
	}

	/* A ghost's own tag hangs from the ghost's corner. */
	.tag--removed {
		left: 100%;
		top: 0;
		background: var(--surface-page);
		color: var(--danger);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 45%, transparent);
	}

	.tag--new {
		background: var(--text-primary);
		color: var(--surface-page);
	}

	[data-tone='alfy'] .tag--new {
		background: var(--accent-fill);
		color: var(--on-accent);
	}

	.tag--moved {
		background: var(--surface-page);
		color: var(--text-muted);
		box-shadow: 0 0 0 1px var(--border-default);
	}
</style>
