<script lang="ts">
/**
 * The sentence scrubber of read aloud's player (spec §4.3). A slider whose
 * value is a sentence: the notches are the sentences' starts, placed by each
 * one's share of the reply's text and never moving, so the line is the same
 * before the later sentences have been made.
 *
 * Dragging: the handle and the fill follow the pointer exactly (moves are
 * coalesced per animation frame), the notch it would land on lights up, and a
 * dark bubble above the handle says which sentence that is. The reading is the
 * controller's: this component only reports (`onDragStart`, `onDragMove`,
 * `onDragEnd`, `onStep`) and shows what it is given. On release the handle
 * glides onto the notch (`--duration-emphasis`, `--ease-emphasis`, which
 * `app.css` collapses under reduced motion); a tap is a press and release in
 * one place and jumps the same way.
 */
import { untrack } from "svelte";
import { t } from "$lib/i18n";

let {
	notches,
	progress,
	sentence,
	count,
	disabled,
	preview,
	onDragStart,
	onDragMove,
	onDragEnd,
	onStep,
}: {
	/** Each sentence's start as a share of the text, in order. */
	notches: number[];
	/** The share of the text read, 0 to 1. */
	progress: number;
	/** The sentence being read. */
	sentence: number;
	count: number;
	disabled: boolean;
	/** The bubble's words for a sentence: "4/9 · Feed it once a day…". */
	preview: (index: number) => string;
	onDragStart: () => void;
	onDragMove: (index: number) => void;
	onDragEnd: (index: number) => void;
	onStep: (index: number) => void;
} = $props();

/** How far the bubble stays inside the player's edges. */
const BUBBLE_EDGE_PX = 6;

let root = $state<HTMLElement | null>(null);
let track = $state<HTMLElement | null>(null);
let bubble = $state<HTMLElement | null>(null);

/** The pointer's share of the track while it is down; null otherwise. */
let dragShare = $state<number | null>(null);
/** The sentence the drag would land on. */
let dragSentence = $state<number | null>(null);
/** After a release: the notch the handle glides to, until the reading moves on. */
let landedShare = $state<number | null>(null);
/** How far the bubble is pushed sideways to stay inside the player. */
let bubbleShift = $state(0);

let pendingX: number | null = null;
let scheduled = false;
let frame = 0;
let reportedSentence: number | null = null;
let lastProgress = untrack(() => progress);

const clamp01 = (value: number): number =>
	Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** A share as a CSS percentage, to a thousandth, so 0.575 is "57.5%" and not "57.49999999999999%". */
const percent = (share: number): string =>
	`${Math.round(clamp01(share) * 100_000) / 1000}%`;

const dragging = $derived(dragSentence !== null);
const shownShare = $derived(dragShare ?? landedShare ?? clamp01(progress));
const shownSentence = $derived(dragSentence ?? sentence);
const previewText = $derived(
	dragSentence === null ? "" : preview(dragSentence),
);

// The reading has moved on from the notch the handle landed on: follow it again.
$effect(() => {
	const current = progress;
	untrack(() => {
		if (landedShare !== null && current !== lastProgress) landedShare = null;
		lastProgress = current;
	});
});

// Keep the bubble 6 px inside the player: the nearest `[data-read-aloud-player]`
// (the pill), else the scrubber's own box.
$effect(() => {
	void previewText;
	if (dragShare === null || !bubble || !track || !root) {
		bubbleShift = 0;
		return;
	}
	const trackBox = track.getBoundingClientRect();
	const bounds = (
		root.closest("[data-read-aloud-player]") ?? root
	).getBoundingClientRect();
	const width = bubble.offsetWidth;
	const left = trackBox.left + dragShare * trackBox.width - width / 2;
	const min = bounds.left + BUBBLE_EDGE_PX;
	const max = bounds.right - BUBBLE_EDGE_PX - width;
	bubbleShift = Math.round(
		Math.min(Math.max(left, min), Math.max(min, max)) - left,
	);
});

function shareOf(clientX: number): number {
	const box = track?.getBoundingClientRect();
	if (!box || box.width <= 0) return 0;
	return clamp01((clientX - box.left) / box.width);
}

/** The last sentence that starts at or before a share of the text. */
function sentenceAt(share: number): number {
	let found = 0;
	for (let i = 0; i < notches.length; i++)
		if ((notches[i] ?? 0) <= share) found = i;
	return found;
}

function follow(clientX: number): void {
	const share = shareOf(clientX);
	const landing = sentenceAt(share);
	dragShare = share;
	dragSentence = landing;
	if (landing !== reportedSentence) {
		reportedSentence = landing;
		onDragMove(landing);
	}
}

function finishDrag(pointerId: number | null): void {
	const landing = dragSentence;
	if (landing === null) return;
	if (pointerId !== null && root?.hasPointerCapture?.(pointerId))
		root.releasePointerCapture(pointerId);
	dragShare = null;
	dragSentence = null;
	reportedSentence = null;
	landedShare = notches[landing] ?? 0;
	onDragEnd(landing);
}

function onpointerdown(event: PointerEvent): void {
	if (disabled || event.button !== 0) return;
	event.preventDefault();
	root?.focus({ preventScroll: true });
	root?.setPointerCapture?.(event.pointerId);
	landedShare = null;
	onDragStart();
	follow(event.clientX);
}

function onpointermove(event: PointerEvent): void {
	if (dragSentence === null) return;
	pendingX = event.clientX;
	if (scheduled) return;
	scheduled = true;
	frame = requestAnimationFrame(() => {
		scheduled = false;
		const x = pendingX;
		pendingX = null;
		if (x !== null && dragSentence !== null) follow(x);
	});
}

function onpointerup(event: PointerEvent): void {
	if (dragSentence === null) return;
	if (scheduled) cancelAnimationFrame(frame);
	scheduled = false;
	pendingX = null;
	// The release point, exactly, not the last frame's.
	follow(event.clientX);
	finishDrag(event.pointerId);
}

function onpointercancel(event: PointerEvent): void {
	if (dragSentence === null) return;
	if (scheduled) cancelAnimationFrame(frame);
	scheduled = false;
	pendingX = null;
	finishDrag(event.pointerId);
}

function onkeydown(event: KeyboardEvent): void {
	if (disabled || count <= 0) return;
	let target: number | null;
	switch (event.key) {
		case "ArrowRight":
		case "ArrowUp":
			target = sentence < count - 1 ? sentence + 1 : null;
			break;
		case "ArrowLeft":
		case "ArrowDown":
			target = Math.max(0, sentence - 1);
			break;
		case "Home":
			target = 0;
			break;
		case "End":
			target = count - 1;
			break;
		default:
			return;
	}
	event.preventDefault();
	if (target !== null) onStep(target);
}
</script>

<div
	bind:this={root}
	class="scrubber"
	role="slider"
	tabindex={disabled ? -1 : 0}
	aria-label={$t("readAloud.scrubber.label")}
	aria-valuemin={1}
	aria-valuemax={Math.max(1, count)}
	aria-valuenow={shownSentence + 1}
	aria-valuetext={$t("readAloud.scrubber.value", {
		n: shownSentence + 1,
		total: count,
	})}
	aria-disabled={disabled ? "true" : undefined}
	data-testid="read-aloud-scrubber"
	data-dragging={dragging ? "" : undefined}
	data-landing={!dragging && landedShare !== null ? "" : undefined}
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	{onpointercancel}
	{onkeydown}
>
	<div bind:this={track} class="track">
		<div class="fill" style:width={percent(shownShare)}></div>
		{#each notches as share, index (index)}
			<span
				class="notch"
				data-notch={index}
				data-lit={dragSentence === index ? "" : undefined}
				style:left={percent(share)}
			></span>
		{/each}
		<div class="handle" style:left={percent(shownShare)}></div>
	</div>
	{#if dragging}
		<div
			bind:this={bubble}
			class="bubble"
			data-testid="read-aloud-scrubber-bubble"
			style:left={percent(shownShare)}
			style:transform="translateX(-50%) translateX({bubbleShift}px)"
			aria-hidden="true"
		>
			{previewText}
		</div>
	{/if}
</div>

<style>
	.scrubber {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1 1 auto;
		min-width: 0;
		height: 32px;
		cursor: pointer;
		touch-action: none;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		outline: none;
	}

	.scrubber[aria-disabled='true'] {
		cursor: default;
		opacity: 0.5;
	}

	.track {
		position: relative;
		width: 100%;
		height: 4px;
		border-radius: 2px;
		background: var(--border-subtle);
	}

	.fill {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		border-radius: 2px;
		background: var(--accent);
	}

	.notch {
		position: absolute;
		top: 50%;
		width: 2px;
		height: 10px;
		border-radius: 1px;
		background: color-mix(in srgb, var(--text-secondary) 45%, transparent);
		transform: translate(-50%, -50%);
		transition:
			height var(--duration-micro) var(--ease-out),
			background-color var(--duration-micro) var(--ease-out);
	}

	.notch[data-lit] {
		height: 16px;
		background: var(--accent);
	}

	.handle {
		position: absolute;
		top: 50%;
		width: 16px;
		height: 16px;
		margin: -8px 0 0 -8px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: var(--shadow-sm);
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.scrubber[data-dragging] .handle {
		transform: scale(1.3);
	}

	/* Only the glide onto a notch is animated: while it plays, the handle follows
	   the reading every frame, and a transition would make it trail behind. */
	.scrubber[data-landing] .handle {
		transition:
			left var(--duration-emphasis) var(--ease-emphasis),
			transform var(--duration-standard) var(--ease-out);
	}

	.scrubber[data-landing] .fill {
		transition: width var(--duration-emphasis) var(--ease-emphasis);
	}

	.scrubber:focus-visible .handle {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent);
	}

	.bubble {
		position: absolute;
		bottom: calc(100% + 2px);
		z-index: 2;
		max-width: 260px;
		padding: 4px 8px;
		overflow: hidden;
		border-radius: 8px;
		background: var(--read-aloud-chip-bg);
		color: var(--read-aloud-chip-fg);
		font-size: 12px;
		line-height: 1.3;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		box-shadow: var(--shadow-md);
		pointer-events: none;
	}
</style>
