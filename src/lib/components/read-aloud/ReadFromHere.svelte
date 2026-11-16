<script lang="ts">
/**
 * "Read from here" (spec §4.3): a dark pill on a selection in a reply. Pressing
 * it reads from the beginning of the sentence the selection starts in, to the
 * end of the reply.
 *
 * It never moves a word: the pill is `position: fixed`, moved to the body
 * (`portalToBody`) so that means the viewport, and it keeps the last selection
 * that was not collapsed, because pressing it can collapse the selection on a
 * phone before the click arrives. A selection in a reply that has nothing to
 * read (only long code) gets the pill only inside a code block, which the
 * person asked for explicitly. The press calls the controller's `start`
 * synchronously, since iOS lets a page play audio only from inside the
 * gesture's handler.
 */
import { Play } from "@lucide/svelte";
import {
	assessReadability,
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
	controller,
}: {
	conversationId: string | null;
	/** The composer layer's height: the pill stays above it. */
	composerHeight: number;
	controller?: ReadAloudController;
} = $props();

/** From the selection, and from the viewport's edges. */
const GAP_PX = 8;
const EDGE_PX = 16;
/** Used until the pill has been measured. */
const FALLBACK_SIZE = { width: 150, height: 40 };
/** A press collapses the selection on some phones: for this long after the press, a collapsed selection is not "gone". */
const PRESS_GRACE_MS = 800;

type Shown = {
	/** Where the selection starts: reading begins in the sentence that holds it. */
	node: Node;
	offset: number;
	segmentIds: string[];
	/** The selection, kept so the pill follows it while the page scrolls. */
	range: Range;
};

let shown = $state<Shown | null>(null);
let pill = $state<HTMLElement | null>(null);
let position = $state({ left: 0, top: 0 });
/** Bumped when the page scrolls or resizes: the pill is placed again. */
let layoutTick = $state(0);

let scheduled = false;
let frame = 0;
let token = 0;
let pressedAt = Number.NEGATIVE_INFINITY;
let assessed: { key: string; result: Readability } | null = null;

const clamp = (value: number, min: number, max: number): number =>
	Math.min(Math.max(value, min), Math.max(min, max));

function assess(segmentIds: readonly string[]): Promise<Readability> {
	return controller
		? controller.assessReadability(segmentIds)
		: assessReadability(segmentIds);
}

/** The reply a range starts in: its segments, and whether it starts in a code block. */
function originOf(
	range: Range,
): { segmentIds: string[]; inCode: boolean } | null {
	const start = range.startContainer;
	const element = start instanceof Element ? start : start.parentElement;
	const container = element?.closest(".markdown-container");
	const body = container?.closest("[data-read-aloud-segments]");
	if (!element || !container || !body) return null;
	const segmentIds = (body.getAttribute("data-read-aloud-segments") ?? "")
		.split(/\s+/u)
		.filter(Boolean);
	if (segmentIds.length === 0) return null;
	return { segmentIds, inCode: element.closest(".code-block, pre") !== null };
}

function hide(): void {
	shown = null;
	assessed = null;
}

async function evaluate(): Promise<void> {
	const mine = ++token;
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		// Pressing the pill can collapse the selection first: keep it for that moment.
		if (performance.now() - pressedAt > PRESS_GRACE_MS) hide();
		return;
	}
	const range = selection.getRangeAt(0);
	const origin = originOf(range);
	if (!origin) {
		hide();
		return;
	}
	const key = origin.segmentIds.join(" ");
	let result = assessed?.key === key ? assessed.result : null;
	if (!result) {
		result = await assess(origin.segmentIds);
		if (mine !== token) return;
		assessed = { key, result };
	}
	// A reply with nothing to read still reads a code block the person selected.
	const readable =
		result.kind === "ready" || (result.kind === "nothing" && origin.inCode);
	if (!readable || range.getClientRects().length === 0) {
		hide();
		return;
	}
	shown = {
		node: range.startContainer,
		offset: range.startOffset,
		segmentIds: origin.segmentIds,
		range: range.cloneRange(),
	};
}

function schedule(): void {
	if (scheduled) return;
	scheduled = true;
	frame = requestAnimationFrame(() => {
		scheduled = false;
		void evaluate();
	});
}

function relayout(): void {
	if (!shown || scheduled) return;
	scheduled = true;
	frame = requestAnimationFrame(() => {
		scheduled = false;
		layoutTick += 1;
	});
}

// Watch the selection while read aloud is on.
$effect(() => {
	if (!$readAloudAvailable) {
		hide();
		return;
	}
	document.addEventListener("selectionchange", schedule);
	window.addEventListener("scroll", relayout, { capture: true, passive: true });
	window.addEventListener("resize", relayout, { passive: true });
	return () => {
		document.removeEventListener("selectionchange", schedule);
		window.removeEventListener("scroll", relayout, { capture: true });
		window.removeEventListener("resize", relayout);
		if (scheduled) cancelAnimationFrame(frame);
		scheduled = false;
	};
});

// Place the pill: 8 px above the selection's first line, or on a touch screen
// 8 px below its last (the phone's own copy menu takes the room above); 16 px
// inside the viewport and above the composer layer.
$effect(() => {
	layoutTick;
	composerHeight;
	if (!shown || !pill) return;
	const rects = [...shown.range.getClientRects()];
	const first = rects[0];
	const last = rects[rects.length - 1];
	if (!first || !last) return;
	const width = pill.offsetWidth || FALLBACK_SIZE.width;
	const height = pill.offsetHeight || FALLBACK_SIZE.height;
	const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
	const wanted = coarse ? last.bottom + GAP_PX : first.top - GAP_PX - height;
	position = {
		left: clamp(
			first.left + first.width / 2 - width / 2,
			EDGE_PX,
			window.innerWidth - EDGE_PX - width,
		),
		top: clamp(wanted, EDGE_PX, window.innerHeight - composerHeight - height),
	};
});

function press(): void {
	const target = shown;
	if (!target || !conversationId) return;
	const messageId = target.segmentIds[target.segmentIds.length - 1];
	if (!messageId) return;
	// Inside the handler, before anything is awaited: the iOS unlock.
	(controller ?? getReadAloud()).start({
		conversationId,
		messageId,
		segmentIds: target.segmentIds,
		from: { node: target.node, offset: target.offset },
	});
	document.getSelection()?.removeAllRanges();
	hide();
}
</script>

{#if $readAloudAvailable && conversationId && shown}
	<button
		bind:this={pill}
		use:portalToBody
		type="button"
		class="read-from-here"
		data-testid="read-from-here"
		style:left="{position.left}px"
		style:top="{position.top}px"
		onpointerdown={() => (pressedAt = performance.now())}
		onmousedown={(event) => event.preventDefault()}
		onclick={press}
	>
		<Play size={13} strokeWidth={2.4} aria-hidden="true" />
		{$t("readAloud.readFromHere")}
	</button>
{/if}

<style>
	.read-from-here {
		position: fixed;
		z-index: 60;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px 8px 12px;
		border: 0;
		border-radius: 999px;
		background: var(--read-aloud-chip-bg);
		color: var(--read-aloud-chip-fg);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		cursor: pointer;
		box-shadow: var(--shadow-md);
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	.read-from-here:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	@media (pointer: coarse) {
		.read-from-here {
			padding: 11px 16px 11px 14px;
			font-size: 14px;
		}
	}
</style>
