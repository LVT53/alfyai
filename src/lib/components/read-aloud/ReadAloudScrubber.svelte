<script lang="ts">
/**
 * The sentence scrubber (spec §4.3): a slider whose value is a sentence. Its
 * notches sit at each sentence's share of the text and never move; a long
 * Document draws only its headings' (`drawn`), and every sentence is still a
 * place to land. A drag
 * follows the pointer exactly (one update per frame), lights the notch it
 * will land on and shows that sentence's start in a dark bubble; the release
 * (or a tap) jumps there, and the handle glides onto the notch.
 */
import { notchAtShare } from "$lib/client/read-aloud/timeline";
import { t } from "$lib/i18n";

let {
	notches,
	drawn = null,
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
	notches: number[];
	/** The sentences whose notch is drawn; null draws every sentence's. */
	drawn?: readonly number[] | null;
	progress: number;
	sentence: number;
	count: number;
	disabled: boolean;
	preview: (i: number) => string;
	onDragStart: () => void;
	onDragMove: (i: number) => void;
	onDragEnd: (i: number) => void;
	onStep: (i: number) => void;
} = $props();

/** The bubble keeps this far inside the player's edges. */
const BUBBLE_INSET_PX = 6;

let root = $state<HTMLDivElement | null>(null);
let bubble = $state<HTMLDivElement | null>(null);
let dragShare = $state<number | null>(null);
let target = $state<number | null>(null);
let settling = $state(false);
let bubbleShift = $state(0);
/** The bubble's words and place: kept after a release, so it fades out as it was. */
let bubbleWords = $state("");
let bubbleShare = $state(0);
let pendingX: number | null = null;
let frame: number | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

const clampShare = (share: number) => Math.min(1, Math.max(0, share));
const shown = $derived(dragShare ?? clampShare(progress));
const lit = $derived(dragShare === null ? null : target);
const percent = (share: number) => `${Math.round(share * 10000) / 100}%`;
const drawnNotches = $derived(drawn ?? notches.map((_, index) => index));

function shareAt(clientX: number): number {
	const rect = root?.getBoundingClientRect();
	if (!rect || rect.width <= 0) return 0;
	return clampShare((clientX - rect.left) / rect.width);
}

function schedule(callback: () => void) {
	if (typeof requestAnimationFrame === "function")
		frame = requestAnimationFrame(callback);
	else frame = setTimeout(callback, 16) as unknown as number;
}

function cancelFrame() {
	if (frame === null) return;
	if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
	clearTimeout(frame);
	frame = null;
}

function moveTo(clientX: number) {
	const share = shareAt(clientX);
	dragShare = share;
	bubbleShare = share;
	const next = notchAtShare(notches, share);
	if (next !== target) {
		target = next;
		bubbleWords = preview(next);
		onDragMove(next);
	}
}

/**
 * Keeps the bubble inside the player, measured after it shows its new words.
 * The shift comes from where the handle is and how wide the bubble is, never
 * from the bubble's own box: that box holds the shift (or, while the transform
 * moves, part of it), so reading it back would feed the shift on itself.
 */
$effect(() => {
	const share = dragShare;
	target;
	if (share === null || !bubble || !root) return;
	const track = root.getBoundingClientRect();
	const player = root
		.closest("[data-read-aloud-player]")
		?.getBoundingClientRect();
	const width = bubble.offsetWidth;
	if (!player || width === 0) {
		bubbleShift = 0;
		return;
	}
	const left = track.left + share * track.width - width / 2;
	const right = left + width;
	const min = player.left + BUBBLE_INSET_PX;
	const max = player.right - BUBBLE_INSET_PX;
	if (left < min) bubbleShift = min - left;
	else if (right > max) bubbleShift = Math.max(min - left, max - right);
	else bubbleShift = 0;
});

function onpointerdown(event: PointerEvent) {
	if (disabled || event.button > 0) return;
	event.preventDefault();
	root?.setPointerCapture?.(event.pointerId);
	settling = false;
	target = null;
	onDragStart();
	moveTo(event.clientX);
}

function onpointermove(event: PointerEvent) {
	if (dragShare === null) return;
	pendingX = event.clientX;
	if (frame !== null) return;
	schedule(() => {
		frame = null;
		if (pendingX !== null && dragShare !== null) moveTo(pendingX);
		pendingX = null;
	});
}

function finish(event: PointerEvent) {
	if (dragShare === null) return;
	cancelFrame();
	const landing = notchAtShare(notches, shareAt(event.clientX));
	pendingX = null;
	dragShare = null;
	target = null;
	settling = true;
	if (settleTimer) clearTimeout(settleTimer);
	settleTimer = setTimeout(() => {
		settling = false;
	}, 260);
	root?.releasePointerCapture?.(event.pointerId);
	onDragEnd(landing);
}

function onkeydown(event: KeyboardEvent) {
	if (disabled) return;
	const last = Math.max(0, count - 1);
	let next: number | null = null;
	if (event.key === "ArrowLeft" || event.key === "ArrowDown")
		next = sentence - 1;
	else if (event.key === "ArrowRight" || event.key === "ArrowUp")
		next = sentence + 1;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = last;
	if (next === null) return;
	event.preventDefault();
	const clamped = Math.min(last, Math.max(0, next));
	if (clamped !== sentence) onStep(clamped);
}
</script>

<div
	bind:this={root}
	class="read-aloud-scrubber"
	class:dragging={dragShare !== null}
	class:settling
	class:disabled
	role="slider"
	tabindex={disabled ? -1 : 0}
	aria-label={$t("readAloud.scrubber.label")}
	aria-valuemin={1}
	aria-valuemax={Math.max(1, count)}
	aria-valuenow={Math.min(count, sentence + 1)}
	aria-valuetext={$t("readAloud.scrubber.value", { n: Math.min(count, sentence + 1), total: count })}
	aria-disabled={disabled ? "true" : undefined}
	{onpointerdown}
	{onpointermove}
	onpointerup={finish}
	onpointercancel={finish}
	{onkeydown}
>
	<div class="read-aloud-track">
		<div class="read-aloud-fill" style:width={percent(shown)}></div>
		{#each drawnNotches as index (index)}
			<div class="read-aloud-notch" class:on={lit === index} style:left={percent(notches[index] ?? 0)}></div>
		{/each}
	</div>
	<div class="read-aloud-handle" style:left={percent(shown)}></div>
	<div
		bind:this={bubble}
		class="read-aloud-bubble"
		class:visible={dragShare !== null && target !== null}
		style:left={percent(bubbleShare)}
		style:--bubble-shift="{bubbleShift}px"
		aria-hidden="true"
	>
		{bubbleWords}
	</div>
</div>

<style>
	.read-aloud-scrubber {
		position: relative;
		flex: 1;
		min-width: 0;
		height: 40px;
		cursor: grab;
		touch-action: none;
		outline: none;
		user-select: none;
		-webkit-user-select: none;
	}

	.read-aloud-scrubber.dragging {
		cursor: grabbing;
	}

	/* In the pill's two rows (a phone, a narrow column) its row is 34 px: the pill sets it. */

	.read-aloud-scrubber.disabled {
		cursor: default;
		opacity: 0.5;
	}

	.read-aloud-scrubber:focus-visible .read-aloud-handle {
		box-shadow:
			0 0 0 3px var(--surface-page),
			0 0 0 5px var(--border-focus);
	}

	.read-aloud-track {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 4px;
		margin-top: -2px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--text-primary) 12%, transparent);
	}

	.read-aloud-fill {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		border-radius: 4px;
		background: var(--accent);
	}

	.read-aloud-notch {
		position: absolute;
		top: -3px;
		width: 2px;
		height: 10px;
		margin-left: -1px;
		border-radius: 1px;
		background: var(--surface-page);
		box-shadow: 0 0 0 0.5px color-mix(in srgb, var(--text-primary) 20%, transparent);
		transition:
			height var(--duration-micro) var(--ease-out),
			top var(--duration-micro) var(--ease-out),
			background-color var(--duration-micro) var(--ease-out);
	}

	.read-aloud-notch.on {
		top: -6px;
		height: 16px;
		background: var(--accent);
		box-shadow: none;
	}

	.read-aloud-handle {
		position: absolute;
		top: 50%;
		width: 16px;
		height: 16px;
		margin: -8px 0 0 -8px;
		border: 2px solid var(--accent);
		border-radius: 50%;
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
		transition: transform var(--duration-micro) var(--ease-out);
	}

	.dragging .read-aloud-handle {
		transform: scale(1.3);
	}

	.settling .read-aloud-handle {
		transition:
			left var(--duration-emphasis) var(--ease-emphasis),
			transform var(--duration-micro) var(--ease-out);
	}

	.settling .read-aloud-fill {
		transition: width var(--duration-emphasis) var(--ease-emphasis);
	}

	.read-aloud-bubble {
		position: absolute;
		bottom: calc(100% + 8px);
		z-index: 5;
		max-width: 240px;
		padding: 6px 9px;
		border-radius: 8px;
		background: var(--read-aloud-chip-bg);
		color: var(--read-aloud-chip-fg);
		font-family: var(--font-sans);
		font-size: 12px;
		line-height: 1.25;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
		opacity: 0;
		transform: translate(calc(-50% + var(--bubble-shift, 0px)), 3px);
		transition:
			opacity var(--duration-micro) var(--ease-out),
			transform var(--duration-micro) var(--ease-out);
	}

	.read-aloud-bubble.visible {
		opacity: 1;
		transform: translate(calc(-50% + var(--bubble-shift, 0px)), 0);
	}
</style>
