<script lang="ts">
/**
 * Read from here (spec §4.3): selecting text in a reply shows a dark pill that
 * reads from the start of the sentence the selection starts in, to the end of
 * the reply. It floats (fixed, on the body) and never moves a word: above the
 * selection, or below it on a touch screen, whose own menu takes the space
 * above. A long code block is read when the selection starts in it.
 */
import { Play } from "@lucide/svelte";
import {
	getReadAloud,
	type ReadAloudController,
	type Readability,
} from "$lib/client/read-aloud/controller";
import { t } from "$lib/i18n";
import { readAloudAvailable } from "$lib/stores/read-aloud";
import { portalToBody } from "$lib/utils/portal";

let {
	conversationId,
	composerHeight,
	controller = undefined,
}: {
	conversationId: string | null;
	composerHeight: number;
	controller?: ReadAloudController;
} = $props();

const reader = () => controller ?? getReadAloud();

/** The pill keeps this far from the selection, and this far inside the viewport. */
const GAP_PX = 8;
const EDGE_PX = 16;

type Target = {
	segmentIds: string[];
	node: Node;
	offset: number;
	first: DOMRect;
	last: DOMRect;
};

let target = $state<Target | null>(null);
let pill = $state<HTMLButtonElement | null>(null);
let place = $state({ top: 0, left: 0 });
let pressing = false;
const readability = new Map<string, Readability>();

function lineRects(range: Range): { first: DOMRect; last: DOMRect } | null {
	const rects = [...range.getClientRects()].filter(
		(rect) => rect.width > 0 || rect.height > 0,
	);
	const first = rects[0];
	const last = rects[rects.length - 1];
	if (first && last) return { first, last };
	if (typeof range.getBoundingClientRect !== "function") return null;
	const box = range.getBoundingClientRect();
	return { first: box, last: box };
}

async function inspect() {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		if (!pressing) target = null;
		return;
	}
	const range = selection.getRangeAt(0);
	const node = range.startContainer;
	const element = node instanceof Element ? node : node.parentElement;
	const row = element
		?.closest(".markdown-container")
		?.closest("[data-read-aloud-segments]");
	const segmentIds = (row?.getAttribute("data-read-aloud-segments") ?? "")
		.split(" ")
		.filter((id) => id !== "");
	if (!row || segmentIds.length === 0) {
		target = null;
		return;
	}
	const key = segmentIds.join(" ");
	let known = readability.get(key);
	if (!known || known.kind === "unknown") {
		known = await reader().assessReadability(segmentIds);
		readability.set(key, known);
	}
	const now = document.getSelection();
	if (!now || now.rangeCount === 0 || now.getRangeAt(0).startContainer !== node)
		return;
	const inCode = element?.closest(".code-block, pre") != null;
	if (!(known.kind === "ready" || (known.kind === "nothing" && inCode))) {
		target = null;
		return;
	}
	const rects = lineRects(range);
	target = rects
		? { segmentIds, node, offset: range.startOffset, ...rects }
		: null;
}

$effect(() => {
	if (!$readAloudAvailable) return;
	let frame: number | null = null;
	const schedule = () => {
		if (frame !== null) return;
		const run = () => {
			frame = null;
			void inspect();
		};
		frame =
			typeof requestAnimationFrame === "function"
				? requestAnimationFrame(run)
				: window.setTimeout(run, 16);
	};
	document.addEventListener("selectionchange", schedule);
	window.addEventListener("scroll", schedule, { capture: true, passive: true });
	window.addEventListener("resize", schedule);
	return () => {
		document.removeEventListener("selectionchange", schedule);
		window.removeEventListener("scroll", schedule, { capture: true });
		window.removeEventListener("resize", schedule);
		if (frame !== null) {
			if (typeof cancelAnimationFrame === "function")
				cancelAnimationFrame(frame);
			window.clearTimeout(frame);
		}
	};
});

/** Above the selection's first line, or below its last on a touch screen; inside the viewport, above the composer. */
$effect(() => {
	const current = target;
	if (!current) return;
	const box = pill?.getBoundingClientRect();
	const width = box?.width ?? 0;
	const height = box?.height ?? 0;
	const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
	const top = coarse
		? current.last.bottom + GAP_PX
		: current.first.top - GAP_PX - height;
	const left = coarse ? current.last.left : current.first.left;
	const maxTop = window.innerHeight - composerHeight - height - GAP_PX;
	const maxLeft = window.innerWidth - EDGE_PX - width;
	place = {
		top: Math.max(EDGE_PX, Math.min(top, maxTop)),
		left: Math.max(EDGE_PX, Math.min(left, maxLeft)),
	};
});

function press() {
	pressing = false;
	const current = target;
	if (!current || !conversationId) return;
	reader().start({
		conversationId,
		messageId: current.segmentIds[current.segmentIds.length - 1] as string,
		segmentIds: current.segmentIds,
		from: { node: current.node, offset: current.offset },
	});
	document.getSelection()?.removeAllRanges();
	target = null;
}
</script>

{#if $readAloudAvailable && target}
	<button
		bind:this={pill}
		use:portalToBody
		type="button"
		class="read-from-here"
		style:top="{place.top}px"
		style:left="{place.left}px"
		onpointerdown={(event) => {
			// Keep the selection: the press reads from it.
			event.preventDefault();
			pressing = true;
		}}
		onclick={press}
	>
		<Play size={13} strokeWidth={2.5} aria-hidden="true" />
		<span>{$t("readAloud.readFromHere")}</span>
	</button>
{/if}

<style>
	.read-from-here {
		position: fixed;
		z-index: 60;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px 0 10px;
		border: 0;
		border-radius: 999px;
		background: var(--read-aloud-chip-bg);
		color: var(--read-aloud-chip-fg);
		box-shadow: var(--shadow-lg);
		font-family: var(--font-sans);
		font-size: 12.5px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		animation: read-from-here-in var(--duration-standard) var(--ease-out);
	}

	.read-from-here:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	@keyframes read-from-here-in {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
	}
</style>
