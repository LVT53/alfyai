<script lang="ts">
/**
 * Read aloud's marks on a reply (spec §4.2): the sentence's tint, the spoken
 * word's marker and, while the scrubber is dragged, the target sentence. They
 * are an overlay BEHIND the text (`z-index: -1` inside the prose, which is
 * isolated only while it is marked), so marking never changes the reply's DOM
 * or its layout and can never paint over the composer layer. Each segment of
 * a reply draws only the ranges inside its own `container`.
 */
import { untrack } from "svelte";
import { fade } from "svelte/transition";
import { type Box, lineBoxes } from "$lib/client/read-aloud/line-rects";
import { readAloudView } from "$lib/stores/read-aloud";
import { reducedMotionAware } from "$lib/utils/motion";

let {
	replyLastId,
	container,
	onMarkedChange,
}: {
	replyLastId: string;
	container: HTMLElement | null;
	onMarkedChange: (marked: boolean) => void;
} = $props();

const markFade = reducedMotionAware(fade);
const FADE = { duration: 150 };

/** Bumped when the container's size changes: the boxes are measured again. */
let layoutTick = $state(0);

$effect(() => {
	const target = container;
	if (!target || typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver(() => {
		layoutTick += 1;
	});
	observer.observe(target);
	return () => observer.disconnect();
});

function boxesOf(ranges: readonly Range[]): Box[] {
	if (!container) return [];
	const rects: DOMRectReadOnly[] = [];
	for (const range of ranges) {
		if (!container.contains(range.commonAncestorContainer)) continue;
		rects.push(...range.getClientRects());
	}
	return rects.length === 0
		? []
		: lineBoxes(rects, container.getBoundingClientRect());
}

const layout = $derived.by(() => {
	layoutTick;
	const view = $readAloudView;
	if (view.status === "idle" || view.messageId !== replyLastId || !view.marks)
		return null;
	const dragging = view.drag !== null;
	const sentence = dragging ? [] : boxesOf(view.marks.sentence);
	const target = dragging ? boxesOf(view.marks.target) : [];
	const showWord =
		!dragging &&
		view.status !== "stopped" &&
		view.status !== "waiting" &&
		view.marks.word !== null;
	const word =
		showWord && view.marks.word
			? (boxesOf([view.marks.word])[0] ?? null)
			: null;
	if (sentence.length === 0 && target.length === 0 && word === null)
		return null;
	return { sentence, target, word, key: view.sentence };
});

const marked = $derived(layout !== null);

/** The word marker glides along a line (90 ms) and jumps, without sliding, to a new one. */
let wordBox = $state<Box | null>(null);
let jump = $state(true);

$effect.pre(() => {
	const next = layout?.word ?? null;
	const previous = untrack(() => wordBox);
	jump =
		previous === null || next === null || Math.abs(next.top - previous.top) > 2;
	wordBox = next;
});

$effect(() => {
	if (marked) untrack(() => onMarkedChange(true));
});
</script>

{#if layout}
	<div
		class="read-aloud-marks"
		aria-hidden="true"
		style="position: absolute; inset: 0; z-index: -1; pointer-events: none;"
		out:markFade={FADE}
		onoutroend={() => onMarkedChange(false)}
	>
		{#key layout.key}
			{#if layout.sentence.length > 0}
				<div class="read-aloud-sentence" in:markFade={FADE} out:markFade={FADE}>
					{#each layout.sentence as box, index (index)}
						<div
							class="read-aloud-box"
							style:left="{box.left}px"
							style:top="{box.top}px"
							style:width="{box.width}px"
							style:height="{box.height}px"
						></div>
					{/each}
				</div>
			{/if}
		{/key}
		{#each layout.target as box, index (index)}
			<div
				class="read-aloud-box read-aloud-target"
				style:left="{box.left}px"
				style:top="{box.top}px"
				style:width="{box.width}px"
				style:height="{box.height}px"
			></div>
		{/each}
		{#if wordBox}
			<div
				class="read-aloud-word"
				class:jump
				style:transform="translate({wordBox.left}px, {wordBox.top}px)"
				style:width="{wordBox.width}px"
				style:height="{wordBox.height}px"
			></div>
		{/if}
	</div>
{/if}

<style>
	.read-aloud-box {
		position: absolute;
		border-radius: 4px;
		background: var(--read-aloud-sentence);
	}

	.read-aloud-sentence {
		position: absolute;
		inset: 0;
	}

	.read-aloud-target {
		background: var(--read-aloud-target);
		box-shadow: 0 0 0 1px var(--read-aloud-target-edge);
	}

	.read-aloud-word {
		position: absolute;
		left: 0;
		top: 0;
		border-radius: 4px;
		background: var(--read-aloud-word);
		transition:
			transform 90ms linear,
			width 90ms linear;
	}

	.read-aloud-word.jump {
		transition: none;
	}
</style>
