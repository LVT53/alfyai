<script lang="ts">
/**
 * The pill a selection of blocks raises (Feature 2 · Artifacts, Slice 3, the
 * approved mockup's "Ask Alfy · Comment"; redesign §4.2 items 1-2 and §8's
 * "Selection pill + composer"): two buttons under the selected block or blocks.
 * Both open the comments list's composer on them (`CanvasCommentsController.
 * placeOnBlocks`): Comment with an empty box, Ask Alfy with Alfy's name already
 * in it, so the request is a thread whose answer lands as a change to review,
 * exactly as an `@Alfy` comment's does. The Document's own pill does the same
 * for a text selection.
 *
 * It sits in the flow's front layer in BOARD space, so it stays under its blocks
 * when the board pans and zooms, counter-scaled by the zoom so it is the size of
 * a button on screen at any zoom. Under the blocks, not over them, because a
 * selected block's own small toolbar (Delete, the block's controls) is above it;
 * above that toolbar when there is no room below (`selection-pill-placement.ts`).
 *
 * Escape hides it and keeps the selection (the Document's rule); a different
 * selection brings it back. The two chords work without the pointer: Ctrl/Cmd+Alt+M
 * comments (the Document's own composer chord), Ctrl/Cmd+Alt+A asks Alfy. Ask waits
 * while Alfy is arranging. Loaded with the comment parts, which it needs anyway.
 */
import { MessageSquarePlus, Sparkles } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import {
	selectionChordAriaKeyShortcuts,
	selectionChordFor,
	selectionChordLabel,
} from "../document/keyboard-shortcuts";
import { measuredBy, type ScreenRect } from "./_lib/floating";
import type { Tool } from "./_lib/tools";
import { boxOf } from "./_lib/review-geometry";
import { selectionPillPlacement } from "./_lib/selection-pill-placement";

let {
	nodes,
	viewport,
	size,
	avoid = null,
	tool,
	readonly,
	hidden,
	askBusy,
	onask,
	oncomment,
}: {
	/** The blocks as they are drawn now, with which ones are selected. */
	nodes: readonly CanvasNode[];
	viewport: { x: number; y: number; zoom: number };
	/** The pane's size: where there is room below the blocks. */
	size: { width: number; height: number };
	/** Where the change pill is on the screen: this pill keeps off it. */
	avoid?: ScreenRect | null;
	tool: Tool;
	/** The board cannot change now: there is nothing to comment on or ask. */
	readonly: boolean;
	/** The composer the pill opened is open: the pill has done its part. */
	hidden: boolean;
	/** Alfy is arranging: Ask waits. */
	askBusy: boolean;
	onask: (ids: string[]) => void;
	oncomment: (ids: string[]) => void;
} = $props();

let layerEl = $state<HTMLDivElement | undefined>();
let dismissedKey = $state<string | null>(null);

let selected = $derived(
	nodes.filter((node) => node.selected).map((node) => node.id),
);
let dragging = $derived(nodes.some((node) => node.selected && node.dragging));
let key = $derived(selected.join("|"));
let shown = $derived(
	!hidden &&
		!readonly &&
		tool === "select" &&
		selected.length > 0 &&
		!dragging &&
		dismissedKey !== key,
);
// Several picked blocks wear the group box, 9 px out, and its handles, which reach
// further (a fingertip's worth on a touch screen): the pill hangs clear of them.
const COARSE_REACH = 9 + 24;
const FINE_REACH = 9 + 6;
let reach = $derived(
	selected.length < 2
		? 0
		: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
			? COARSE_REACH
			: FINE_REACH,
);
let box = $derived.by(() => {
	const around = shown ? boxOf(selected, nodes) : null;
	if (!around || reach === 0) return around;
	const out = reach / (viewport.zoom || 1);
	return {
		x: around.x - out,
		y: around.y - out,
		width: around.width + out * 2,
		height: around.height + out * 2,
	};
});
// What the pane shows of the pill, measured (a phone's is taller and a Hungarian
// label wider): the placement keeps the whole of it inside the pane.
let measuredPill = $state.raw({ width: 0, height: 0 });
let placement = $derived(
	box
		? selectionPillPlacement(box, viewport, size, {
				avoid,
				size:
					measuredPill.width > 0 && measuredPill.height > 0
						? measuredPill
						: undefined,
			})
		: null,
);
let inv = $derived(viewport.zoom > 0 ? 1 / viewport.zoom : 1);

// Nothing selected any more: the next selection, even the same block, is a new one.
$effect(() => {
	if (key === "") dismissedKey = null;
});

let askLabel = $derived(
	`${$t("artifacts.canvas.ask")} (${selectionChordLabel("ask")})`,
);
let commentLabel = $derived(
	`${$t("artifacts.canvas.tool.comment")} (${selectionChordLabel("comment")})`,
);

/** Only while the reader is working on this board: a key pressed somewhere else in the panel is not for it. */
function insideBoard(): boolean {
	const board = layerEl?.closest("[data-testid='canvas-board']");
	return !board || board.contains(document.activeElement);
}

// Capture phase, so Escape is the pill's before the panel's own handler (which is
// registered earlier, and closes an expanded panel) can see it.
function handleKeydown(event: KeyboardEvent): void {
	if (event.defaultPrevented || readonly || tool !== "select") return;
	const target = event.target instanceof HTMLElement ? event.target : null;
	if (target?.closest("input, textarea, select, [contenteditable='true']"))
		return;
	if (event.key === "Escape") {
		if (!shown || !insideBoard()) return;
		event.preventDefault();
		event.stopPropagation();
		dismissedKey = key;
		return;
	}
	const chord = selectionChordFor(event);
	if (!chord || selected.length === 0 || hidden || !insideBoard()) return;
	if (chord === "ask" && askBusy) return;
	event.preventDefault();
	if (chord === "ask") onask(selected);
	else oncomment(selected);
}
</script>

<svelte:window onkeydowncapture={handleKeydown} />

<!-- z-index 3, inline: above Alfy's rings and the comment pins (2), which the flow's own layers sit under. -->
<div class="selection-layer" style="z-index: 3" style:--inv={inv} bind:this={layerEl}>
	{#if placement}
		<div
			class="anchor nopan"
			data-testid="canvas-selection-pill"
			data-side={placement.side}
			style:left="{placement.x}px"
			style:top="{placement.y}px"
		>
			<div
				class="pill"
				role="toolbar"
				aria-label={$t('artifacts.canvas.selection.label')}
				{@attach measuredBy((pillSize) => (measuredPill = pillSize))}
			>
				<button
					type="button"
					class="action"
					disabled={askBusy}
					aria-keyshortcuts={selectionChordAriaKeyShortcuts('ask')}
					title={askBusy ? $t('artifacts.canvas.ask.busy') : askLabel}
					data-testid="canvas-selection-ask"
					onclick={() => {
						if (!askBusy) onask(selected);
					}}
				>
					<Sparkles size={14} strokeWidth={2} aria-hidden="true" />
					{$t('artifacts.canvas.ask')}
				</button>
				<button
					type="button"
					class="action"
					aria-keyshortcuts={selectionChordAriaKeyShortcuts('comment')}
					title={commentLabel}
					data-testid="canvas-selection-comment"
					onclick={() => oncomment(selected)}
				>
					<MessageSquarePlus size={14} strokeWidth={2} aria-hidden="true" />
					{$t('artifacts.canvas.tool.comment')}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.selection-layer {
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	/* Hung from the block's edge and the size of a button whatever the zoom: scaled
	   by 1 / zoom from that point, centred, and stood off the block. Above, it also
	   clears the block's own toolbar. */
	.anchor {
		position: absolute;
		pointer-events: auto;
		transform-origin: 0 0;
		transform: scale(var(--inv)) translate(-50%, 14px);
		white-space: nowrap;
	}

	.anchor[data-side='above'] {
		transform: scale(var(--inv)) translate(-50%, calc(-100% - 60px));
	}

	.pill {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		height: 2.375rem; /* 38px, redesign §4.2 item 1 */
		padding: 0.375rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background-color: var(--surface-overlay);
		box-shadow: var(--shadow-lg, var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18)));
		animation: selection-pill-in var(--duration-standard, 150ms)
			var(--ease-emphasis, ease) both;
	}

	@keyframes selection-pill-in {
		from {
			opacity: 0;
			transform: translateY(4px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.action {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.625rem;
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-primary);
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.action:hover:not(:disabled) {
		background-color: var(--surface-elevated);
	}

	.action:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.action:disabled {
		color: var(--text-muted);
		cursor: not-allowed;
	}

	/* A thumb: the pill grows to 44 px targets (redesign §4.3, Phone). */
	@media (max-width: 480px) {
		.pill {
			height: 3.25rem;
		}

		.action {
			min-height: 2.75rem;
		}
	}
</style>
