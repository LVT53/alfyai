<script lang="ts">
// History's compare wipe (plan 2b T4, preflight §4 T4, MOTION-PARITY 6): the
// older picture underneath, the newer laid over it in the same reserved box and
// cut at the wipe's position, a line where they meet.
//
// The control is a native range input stretched over the whole picture, so a
// pointer press anywhere, a touch drag and the keyboard all move it the browser's
// own way. It reaches half a thumb past each edge, so the thumb's centre, the
// pointer and the line stand on the same pixel. The position is written straight
// to the top picture's `clip-path` and the line's `transform` in an animation
// frame (one write per frame however many inputs arrive), and neither has a CSS
// transition: the cut follows the finger, it never eases after it.
import type { Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";

let {
	beforeUrl,
	afterUrl,
	width,
	height,
	position = $bindable(50),
	label,
	beforeTag = null,
	afterTag = null,
	marks = undefined,
}: {
	beforeUrl: string;
	afterUrl: string;
	/** The newer picture's size: the box is reserved from it before either loads. */
	width: number;
	height: number;
	/** Where the cut stands, 0 (all newer) to 100 (all older), in % of the width. */
	position?: number;
	/** The range's accessible name. */
	label: string;
	/** The small words in the corners, over each side. */
	beforeTag?: string | null;
	afterTag?: string | null;
	/** Drawn over the older picture and under the newer, so they show on the older side only. */
	marks?: Snippet | undefined;
} = $props();

const KEY_STEP = 2;
const PAGE_STEP = 10;

let topElement = $state<HTMLImageElement | null>(null);
let lineElement = $state<HTMLElement | null>(null);
let beforeLoaded = $state(false);
let afterLoaded = $state(false);

function clamp(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/** Writes the cut where `position` says. Direct style writes: nothing for a transition to ease. */
function paint(): void {
	const at = clamp(position);
	if (topElement) topElement.style.clipPath = `inset(0 0 0 ${at}%)`;
	if (lineElement) lineElement.style.transform = `translateX(${at}cqw)`;
}

let frame = 0;
/** One paint per animation frame, of the newest position. */
function schedulePaint(): void {
	if (frame) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		paint();
	});
}

// The first paint is synchronous (no frame of an uncut picture); every move after
// it waits for the next frame.
const firstPaint: Attachment<HTMLElement> = () => {
	paint();
	return () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	};
};

$effect(() => {
	position;
	schedulePaint();
});

function handleInput(event: Event): void {
	position = clamp(Number((event.currentTarget as HTMLInputElement).value));
}

/** Where each key takes the cut from `at`: the arrows step a little (Shift more), Page more, Home and End to the ends. */
const KEY_MOVES: Record<string, (at: number, step: number) => number> = {
	ArrowLeft: (at, step) => at - step,
	ArrowDown: (at, step) => at - step,
	ArrowRight: (at, step) => at + step,
	ArrowUp: (at, step) => at + step,
	PageDown: (at) => at - PAGE_STEP,
	PageUp: (at) => at + PAGE_STEP,
	Home: () => 0,
	End: () => 100,
};

function handleKeydown(event: KeyboardEvent): void {
	if (!Object.hasOwn(KEY_MOVES, event.key)) return;
	const move = KEY_MOVES[event.key];
	event.preventDefault();
	position = clamp(move(position, event.shiftKey ? PAGE_STEP : KEY_STEP));
}

const valueText = $derived(`${Math.round(clamp(position))}%`);
</script>

<div
	class="compare-wipe"
	style:aspect-ratio="{width} / {height}"
	data-testid="compare-wipe"
	{@attach firstPaint}
>
	<img
		class="compare-wipe-img"
		class:is-loaded={beforeLoaded}
		src={beforeUrl}
		alt=""
		{width}
		{height}
		decoding="async"
		draggable="false"
		data-testid="compare-wipe-before"
		onload={() => (beforeLoaded = true)}
	/>
	{#if marks}
		<div class="compare-wipe-marks">{@render marks()}</div>
	{/if}
	<img
		bind:this={topElement}
		class="compare-wipe-img compare-wipe-top"
		class:is-loaded={afterLoaded}
		src={afterUrl}
		alt=""
		{width}
		{height}
		decoding="async"
		draggable="false"
		data-testid="compare-wipe-after"
		onload={() => (afterLoaded = true)}
	/>
	<span bind:this={lineElement} class="compare-wipe-line" aria-hidden="true" data-testid="compare-wipe-line">
		<span class="compare-wipe-grip"></span>
	</span>
	{#if beforeTag}
		<span class="compare-wipe-tag compare-wipe-tag-before" aria-hidden="true">{beforeTag}</span>
	{/if}
	{#if afterTag}
		<span class="compare-wipe-tag compare-wipe-tag-after" aria-hidden="true">{afterTag}</span>
	{/if}
	<input
		class="compare-wipe-range"
		type="range"
		min="0"
		max="100"
		step="any"
		value={position}
		aria-label={label}
		aria-valuetext={valueText}
		data-testid="compare-wipe-range"
		oninput={handleInput}
		onkeydown={handleKeydown}
	/>
</div>

<style>
	/* The box is the newer picture's shape before a byte arrives; its parent sizes it. */
	.compare-wipe {
		position: relative;
		display: block;
		width: 100%;
		overflow: hidden;
		container-type: inline-size;
		border-radius: inherit;
		background: var(--surface-elevated);
		user-select: none;
	}

	.compare-wipe-img {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		opacity: 0;
		transition: opacity var(--duration-standard) var(--ease-out);
		pointer-events: none;
	}

	.compare-wipe-img.is-loaded {
		opacity: 1;
	}

	/* The cut is written per frame; only its fade-in on load transitions. */
	.compare-wipe-top {
		will-change: clip-path;
	}

	.compare-wipe-marks {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.compare-wipe-line {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-primary) 28%, transparent);
		pointer-events: none;
		will-change: transform;
	}

	.compare-wipe-grip {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 1.75rem;
		height: 1.75rem;
		margin: -0.875rem 0 0 -0.875rem;
		border-radius: var(--radius-full);
		background: var(--surface-page);
		box-shadow: 0 1px 6px color-mix(in srgb, var(--text-primary) 30%, transparent);
	}

	.compare-wipe-tag {
		position: absolute;
		top: 0.5rem;
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--surface-page) 86%, transparent);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 700;
		pointer-events: none;
	}

	.compare-wipe-tag-before {
		left: 0.5rem;
	}

	.compare-wipe-tag-after {
		right: 0.5rem;
	}

	/* The control covers the picture and half a thumb past each edge, so the thumb's
	   centre is under the pointer at every position; it draws nothing itself. */
	.compare-wipe-range {
		--thumb: 2.75rem;
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--thumb) / -2);
		width: calc(100% + var(--thumb));
		height: 100%;
		margin: 0;
		padding: 0;
		background: transparent;
		opacity: 0;
		cursor: ew-resize;
		appearance: none;
		touch-action: pan-y;
	}

	.compare-wipe-range::-webkit-slider-runnable-track {
		height: 100%;
		background: transparent;
	}

	.compare-wipe-range::-webkit-slider-thumb {
		width: var(--thumb);
		height: 100%;
		appearance: none;
		background: transparent;
	}

	.compare-wipe-range::-moz-range-thumb {
		width: var(--thumb);
		height: 100%;
		border: 0;
		background: transparent;
	}

	.compare-wipe:has(.compare-wipe-range:focus-visible) .compare-wipe-grip {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
