<script lang="ts">
/**
 * The board's comment layer (Feature 2 · Artifacts, Slice 3): numbered pins for
 * the threads that are on a block or a spot, and — while the Comment tool is
 * armed — the catcher that takes the click that places a new one. It draws and
 * reports; it owns no thread (the editor holds them, the list shows them) and
 * knows nothing of the network.
 *
 * Two placements, on purpose (the traps the prototype measured):
 * - the pins live in board space, in the flow's FRONT viewport layer, so they
 *   stay where they were left when the board pans and zooms. That layer's
 *   frame children carry `z-index: 1`, so the root sets `z-index: 2` inline (a
 *   selector from an ancestor cannot reach portal content), is a zero-size box
 *   at the board's origin, takes no pointer itself, and only a pin does. A pin
 *   is counter-scaled by the zoom so it is 22 px on screen at any zoom: a
 *   board-space circle at the phone's fit zoom is 8 px, unusable with a thumb;
 * - the catcher is NOT in the portal. There `inset: 0` is the size of the
 *   nodes, not of what is on screen (a pad that big is the bug the drawing layer
 *   spent a test on); outside it, it is the pane. It sits under the library's
 *   own panels (the zoom, the overview), so they still work while it is armed.
 *
 * A click places a thread and hands the tool back to Select, so one click is one
 * comment: on the block it landed on (a frame's inside is board, so a click
 * there is a spot), else a spot. A block that is selected when the tool is
 * armed takes the thread at once, which is also the keyboard's way to it. The
 * words are written in the list, so what this reports is only where (`ondraft`).
 */
import { ViewportPortal } from "@xyflow/svelte";
import { untrack } from "svelte";
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import type { Tool } from "./_lib/annotations";
import { anchorPoint, nodeAt, pinAt, pinLabel } from "./_lib/comments";

/** How long a pin that was jumped to keeps its ring: long enough to find it, short enough not to nag. */
const FLASH_MS = 1800;

let {
	threads,
	nodes,
	viewport,
	tool,
	activeId = null,
	draft = null,
	showResolved = false,
	goto = null,
	toBoard,
	oncenter,
	onselect,
	ondraft,
	ontoolchange,
	onannounce,
}: {
	/** Every thread, in list order: a pin's number is its place here. */
	threads: readonly ArtifactComment[];
	/** The blocks as they are drawn now: a pin follows its block while it is dragged. */
	nodes: readonly CanvasNode[];
	viewport: { x: number; y: number; zoom: number };
	tool: Tool;
	/** The thread the list has selected: its pin is on. */
	activeId?: string | null;
	/** Where a comment was just placed and is waiting for its words. */
	draft?: Anchor | null;
	/** The list is showing resolved threads too: their pins show, dimmed. */
	showResolved?: boolean;
	/** One-shot "take me to this thread's pin": centre the camera on it and ring it. */
	goto?: { commentId: string; token: number } | null;
	toBoard: (point: { x: number; y: number }) => Pt;
	oncenter: (point: Pt) => void;
	onselect: (commentId: string) => void;
	ondraft: (anchor: Anchor) => void;
	ontoolchange: (tool: Tool) => void;
	onannounce: (message: string) => void;
} = $props();

let catcherEl = $state<HTMLButtonElement | null>(null);
let flashId = $state<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let appliedGoto = -1;

type Pin = { id: string; at: Pt; label: string; resolved: boolean };

let pins = $derived.by<Pin[]>(() => {
	const drawn: Pin[] = [];
	for (const thread of threads) {
		const resolved = thread.status === "resolved";
		if (resolved && !showResolved) continue;
		const at = pinAt(thread, nodes);
		if (at)
			drawn.push({
				id: thread.id,
				at,
				label: pinLabel(threads, thread.id),
				resolved,
			});
	}
	return drawn;
});

/** The pin of a comment that is not posted yet: the next number, on the block or spot it was placed. */
let draftPin = $derived.by<{ at: Pt; label: string } | null>(() => {
	const at = anchorPoint(draft, nodes);
	return at ? { at, label: String(threads.length + 1) } : null;
});

let pinScale = $derived(viewport.zoom > 0 ? 1 / viewport.zoom : 1);

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

// Jumping to a thread: the camera goes to its pin and the pin rings.
$effect(() => {
	const request = goto;
	if (!request || request.token === appliedGoto) return;
	appliedGoto = request.token;
	untrack(() => {
		const thread = threads.find(
			(candidate) => candidate.id === request.commentId,
		);
		const at = thread ? pinAt(thread, nodes) : null;
		if (!at) return;
		oncenter(at);
		flashId = request.commentId;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashId = null), FLASH_MS);
	});
});

$effect(() => () => {
	if (flashTimer) clearTimeout(flashTimer);
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

<!-- z-index 2, inline: the flow lifts the children of a frame to 1, and a selector from an ancestor cannot reach portal content. -->
<ViewportPortal target="front">
	<div class="comment-pins" style="z-index: 2" data-testid="canvas-comment-pins">
		{#each pins as pin (pin.id)}
			<button
				type="button"
				class="pin nopan"
				class:pin--on={activeId === pin.id}
				class:pin--resolved={pin.resolved}
				class:pin--flash={flashId === pin.id}
				style:left="{pin.at.x}px"
				style:top="{pin.at.y}px"
				style:--pin-scale={pinScale}
				style:z-index={activeId === pin.id ? 1 : undefined}
				aria-label={$t(
					pin.resolved
						? "artifacts.canvas.comment.pinResolved"
						: "artifacts.canvas.comment.pin",
					{ n: pin.label },
				)}
				aria-current={activeId === pin.id ? "true" : undefined}
				data-testid="canvas-comment-pin"
				data-thread-id={pin.id}
				onclick={() => onselect(pin.id)}
			>
				{pin.label}
			</button>
		{/each}
		{#if draftPin}
			<span
				class="pin pin--draft"
				style:left="{draftPin.at.x}px"
				style:top="{draftPin.at.y}px"
				style:--pin-scale={pinScale}
				role="img"
				aria-label={$t("artifacts.canvas.comment.pinDraft")}
				data-testid="canvas-comment-draft-pin"
			>
				{draftPin.label}
			</span>
		{/if}
	</div>
</ViewportPortal>

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
	.comment-pins {
		position: absolute;
		top: 0;
		left: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	/* The mockup's dot: the accent, a white number, 22 px on screen at any zoom
	   (counter-scaled about its own centre, which sits on the block's corner). */
	.pin {
		position: absolute;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin: -11px 0 0 -11px;
		padding: 0;
		border: 2px solid var(--surface-page);
		border-radius: 50%;
		background: var(--accent-fill);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
		color: var(--accent-contrast);
		font: 700 11px/1 var(--font-sans);
		font-variant-numeric: tabular-nums;
		transform: scale(var(--pin-scale, 1));
		pointer-events: auto;
		cursor: pointer;
	}

	/* A finger needs 44 px: the visible dot stays 22, the hit area does not. The
	   offset is from the padding box (the 2 px border is outside it), so -13. */
	button.pin::after {
		content: "";
		position: absolute;
		inset: -13px;
		border-radius: 50%;
	}

	.pin:hover {
		background: var(--accent-hover);
	}

	.pin:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.pin--on {
		box-shadow:
			0 0 0 3px var(--accent-tint-strong),
			0 1px 4px rgba(0, 0, 0, 0.3);
	}

	/* A resolved thread recedes: its number stays, its dot goes quiet and dashed. */
	.pin--resolved {
		border-style: dashed;
		border-color: var(--text-muted);
		background: var(--surface-elevated);
		color: var(--text-muted);
		box-shadow: none;
	}

	.pin--draft {
		border-style: dashed;
		border-color: var(--accent-fill);
		background: var(--surface-page);
		color: var(--accent-text);
		pointer-events: none;
	}

	.pin--flash {
		animation: pin-flash 0.9s ease-out 2;
	}

	@keyframes pin-flash {
		0%,
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
		40% {
			box-shadow: 0 0 0 9px var(--accent-tint-strong);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pin--flash {
			animation: none;
			box-shadow: 0 0 0 4px var(--accent-tint-strong);
		}
	}

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
		max-width: calc(100% - 24px);
		padding: 6px 12px;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-size: var(--text-sm);
		text-align: center;
		pointer-events: none;
	}
</style>
