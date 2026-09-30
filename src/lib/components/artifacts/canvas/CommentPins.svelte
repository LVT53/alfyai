<script lang="ts">
/**
 * The pins of a board's comment threads (Feature 2 · Artifacts, Slice 3): a
 * numbered dot for each thread that is on a block or a spot, in BOARD space, so
 * it stays where it was left when the board pans and zooms. The editor renders
 * this inside the flow's front viewport layer (`<ViewportPortal target="front">`,
 * which it already has; this file imports nothing from the flow, so loading
 * comments on demand does not pull the library into a second chunk). That layer's
 * frame children carry `z-index: 1`, so the root sets `z-index: 2` inline (a
 * selector from an ancestor cannot reach portal content), is a zero-size box at
 * the board's origin, takes no pointer itself, and only a pin does. A pin is
 * counter-scaled by the zoom so it is 22 px on screen at any zoom: a board-space
 * circle at the phone's fit zoom is 8 px, unusable with a thumb.
 *
 * It draws and reports; it owns no thread (the controller holds them, the list
 * shows them) and knows nothing of the network. A jump to a thread
 * (`goto`) centres the camera on its pin (`oncenter`) and rings it.
 */
import { untrack } from "svelte";
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import { anchorPoint, pinAt, pinLabel } from "./_lib/comments";

/** How long a pin that was jumped to keeps its ring: long enough to find it, short enough not to nag. */
const FLASH_MS = 1800;

let {
	threads,
	nodes,
	viewport,
	activeId = null,
	draft = null,
	showResolved = false,
	goto = null,
	oncenter,
	onselect,
}: {
	/** Every thread, in list order: a pin's number is its place here. */
	threads: readonly ArtifactComment[];
	/** The blocks as they are drawn now: a pin follows its block while it is dragged. */
	nodes: readonly CanvasNode[];
	viewport: { x: number; y: number; zoom: number };
	/** The thread the list has selected: its pin is on. */
	activeId?: string | null;
	/** Where a comment was just placed and is waiting for its words. */
	draft?: Anchor | null;
	/** The list is showing resolved threads too: their pins show, dimmed. */
	showResolved?: boolean;
	/** One-shot "take me to this thread's pin": centre the camera on it and ring it. */
	goto?: { commentId: string; token: number } | null;
	oncenter: (point: Pt) => void;
	onselect: (commentId: string) => void;
} = $props();

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
</script>

<!-- z-index 2, inline: the flow lifts the children of a frame to 1, and a selector from an ancestor cannot reach portal content. -->
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
		box-shadow: var(--shadow-md);
		color: var(--on-accent);
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
		box-shadow: 0 0 0 3px var(--accent-tint);
	}

	.pin:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.pin--on {
		box-shadow:
			0 0 0 3px var(--accent-tint-strong),
			var(--shadow-md);
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
</style>
