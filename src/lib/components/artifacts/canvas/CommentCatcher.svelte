<script lang="ts">
/**
 * The Comment tool's catcher (Feature 2 · Artifacts, Slice 3): while the tool
 * is armed, a button over the whole pane that takes the click that places a
 * comment. It is NOT in the flow's viewport layer: there `inset: 0` is the size
 * of the nodes, not of what is on screen (a pad that big is the bug the drawing
 * layer spent a test on); outside it, it is the pane. It sits above the blocks
 * (the flow's renderer is at 4) and under its panels (5), so the zoom and the
 * overview stay usable while a comment is being placed.
 *
 * A click places a thread and hands the tool back to Select, so one click is one
 * comment: on the block it landed on (a frame's inside is board, so a click
 * there is a spot), else a spot. A block that is selected when the tool is armed
 * takes the thread at once, which is also the keyboard's way to it (and a key
 * press on the catcher places a spot in the middle of the pane). The words are
 * written in the list, so what this reports is only where (`ondraft`).
 */
import { untrack } from "svelte";
import { t } from "$lib/i18n";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import type { Tool } from "./_lib/tools";
import { nodeAt } from "./_lib/comments";

let {
	nodes,
	tool,
	toBoard,
	ondraft,
	ontoolchange,
	onannounce,
}: {
	/** The blocks as they are drawn now: a click is judged against where they are. */
	nodes: readonly CanvasNode[];
	tool: Tool;
	toBoard: (point: { x: number; y: number }) => Pt;
	ondraft: (anchor: Anchor) => void;
	ontoolchange: (tool: Tool) => void;
	onannounce: (message: string) => void;
} = $props();

let catcherEl = $state<HTMLButtonElement | null>(null);

function place(anchor: Anchor): void {
	ondraft(anchor);
	ontoolchange("select");
	onannounce($t("artifacts.canvas.comment.placed"));
}

function handleCatch(event: MouseEvent): void {
	// A keyboard press on the catcher has no pointer position: it lands in the middle of the pane.
	const rect = catcherEl?.getBoundingClientRect();
	const keyboard = event.detail === 0;
	const point = toBoard(
		keyboard && rect
			? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
			: { x: event.clientX, y: event.clientY },
	);
	const hit = keyboard ? null : nodeAt(point, nodes);
	place(
		hit
			? { kind: "node", nodeId: hit.id }
			: { kind: "point", x: point.x, y: point.y },
	);
}

// A block that is selected when the tool is armed takes the comment at once.
$effect(() => {
	if (tool !== "comment") return;
	untrack(() => {
		const selected = nodes.find((node) => node.selected);
		if (selected) place({ kind: "node", nodeId: selected.id });
	});
});

/** Escape lets go of the tool, when the focus is on this board: the tool is a mode, so it must have a way out that is not a click. */
function handleWindowKeydown(event: KeyboardEvent): void {
	if (tool !== "comment" || event.key !== "Escape" || event.defaultPrevented) {
		return;
	}
	const board = catcherEl?.closest("[data-testid='canvas-board']");
	if (!board?.contains(document.activeElement)) return;
	event.preventDefault();
	ontoolchange("select");
}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if tool === "comment"}
	<button
		type="button"
		class="catcher"
		bind:this={catcherEl}
		aria-label={$t("artifacts.canvas.comment.placeHint")}
		data-testid="canvas-comment-catcher"
		onclick={handleCatch}
	>
		<span class="catcher__hint" aria-hidden="true">
			{$t("artifacts.canvas.comment.placeHint")}
		</span>
	</button>
{/if}

<style>
	/* The pane, edge to edge, above the blocks (the flow's renderer is at 4) and
	   under its panels (5), so the zoom and the overview stay usable while a
	   comment is being placed. */
	.catcher {
		position: absolute;
		inset: 0;
		z-index: 4;
		display: block;
		width: 100%;
		height: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: crosshair;
	}

	.catcher:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.catcher__hint {
		position: absolute;
		top: 12px;
		left: 50%;
		max-width: min(300px, calc(100% - 24px));
		padding: 6px 12px;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: 10px;
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-size: var(--text-xs);
		line-height: 1.35;
		text-align: center;
		pointer-events: none;
	}
</style>
