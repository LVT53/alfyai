<script lang="ts">
// The person's marks on the open picture (plan 2b T6, design 5.8). The layer
// lies over the picture's own rectangle, inside the box pinch-zoom transforms
// (F15), so a mark zooms and pans with the picture and every number here is a
// fraction of that rectangle (`mark-geometry.ts`), the numbers the server's
// painter reads.
//
// With Mark on, one pointer draws: the box follows the hand in the frame the
// pointer moved (its edges are written from the event, never through a
// transition), and a press that moves under 6 px is a tap, which removes the
// last-drawn box under it. A second pointer drops the box being drawn: the
// pinch belongs to the zoom. A finger's drag must not scroll anything, so the
// layer holds a non-passive `touchmove` listener (an action: Svelte 5's touch
// attributes are passive) and `touch-action: none` while Mark is on.
//
// Each box is a button that removes it ("Mark A, tap to remove"): with Mark off
// a click or a tap on it, with Mark on a tap on the layer, from the keyboard
// always. A removed box fades out on opacity alone; the colours are
// `MARK_COLOURS`, the panel's and the painter's one constant.
import type { ActionReturn } from "svelte/action";
import { fade } from "svelte/transition";
import { t } from "$lib/i18n";
import {
	type ImageMark,
	MARK_COLOURS,
	type MarkLetter,
} from "$lib/shared/artifacts/image-body";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import {
	boxFromDrag,
	dragBox,
	hitMark,
	type MarkBox,
	nextLetter,
	type Point,
} from "./mark-geometry";

let {
	marks,
	active,
	onChange,
	onRefused,
}: {
	marks: readonly ImageMark[];
	/** Mark is on: one pointer draws. Off: the pointer is the picture's (and the zoom's). */
	active: boolean;
	onChange: (marks: ImageMark[]) => void;
	/** A ninth box was drawn: the panel says "Up to 8 marks". */
	onRefused?: () => void;
} = $props();

/** A press that moves less than this is a tap. */
const TAP_SLOP_PX = 6;

const markFade = reducedMotionAware(fade);

let layer = $state<HTMLDivElement | null>(null);
/** The box being drawn, in fractions; null while nothing is drawn. */
let draft = $state.raw<MarkBox | null>(null);
/** The pointers down on the layer: a second one cancels the gesture. */
const pointers = new Set<number>();
/** The one pointer drawing, where it came down, and the rectangle it draws in. */
let gesture: {
	id: number;
	start: Point;
	rect: DOMRect;
	drawing: boolean;
} | null = null;

let draftLetter = $derived(nextLetter(marks));

function local(rect: DOMRect, event: PointerEvent): Point {
	return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function remove(letter: MarkLetter): void {
	onChange(marks.filter((mark) => mark.letter !== letter));
}

function handlePointerDown(event: PointerEvent): void {
	if (!active || !layer) return;
	if (event.pointerType === "mouse" && event.button !== 0) return;
	// The first pointer of a new press: nothing else is down, whatever was missed.
	if (event.isPrimary) pointers.clear();
	pointers.add(event.pointerId);
	if (pointers.size > 1) {
		// A second finger: this is a pinch, the zoom's. The box being drawn goes.
		gesture = null;
		draft = null;
		return;
	}
	const rect = layer.getBoundingClientRect();
	gesture = {
		id: event.pointerId,
		start: local(rect, event),
		rect,
		drawing: false,
	};
	try {
		layer.setPointerCapture?.(event.pointerId);
	} catch {
		// A pointer the browser no longer knows: the moves still arrive while over the layer.
	}
}

function handlePointerMove(event: PointerEvent): void {
	if (!gesture || event.pointerId !== gesture.id) return;
	const at = local(gesture.rect, event);
	if (
		!gesture.drawing &&
		Math.hypot(at.x - gesture.start.x, at.y - gesture.start.y) < TAP_SLOP_PX
	) {
		return;
	}
	gesture.drawing = true;
	draft = dragBox(gesture.start, at, gesture.rect);
}

function handlePointerUp(event: PointerEvent): void {
	pointers.delete(event.pointerId);
	const ended = gesture;
	if (!ended || event.pointerId !== ended.id) return;
	gesture = null;
	draft = null;
	const at = local(ended.rect, event);
	if (!ended.drawing) {
		const letter = hitMark(
			{ x: at.x / ended.rect.width, y: at.y / ended.rect.height },
			marks,
		);
		if (letter) remove(letter);
		return;
	}
	const box = boxFromDrag(ended.start, at, ended.rect);
	if (!box) return;
	const letter = nextLetter(marks);
	if (!letter) {
		onRefused?.();
		return;
	}
	onChange([...marks, { letter, ...box }]);
}

function handlePointerCancel(event: PointerEvent): void {
	pointers.delete(event.pointerId);
	if (gesture?.id !== event.pointerId) return;
	gesture = null;
	draft = null;
}

// Mark turned off mid-drag: nothing is left half drawn.
$effect(() => {
	if (active) return;
	pointers.clear();
	gesture = null;
	draft = null;
});

/**
 * Holds a finger's drag on the layer while Mark is on: a non-passive
 * `touchmove` listener whose `preventDefault` keeps the page and the panel
 * from scrolling under the box being drawn. Two fingers are left alone.
 */
function holdTouch(node: HTMLElement, on: boolean): ActionReturn<boolean> {
	let holding = on;
	const listener = (event: TouchEvent) => {
		if (holding && event.touches.length === 1) event.preventDefault();
	};
	node.addEventListener("touchmove", listener, { passive: false });
	return {
		update(next) {
			holding = next;
		},
		destroy() {
			node.removeEventListener("touchmove", listener);
		},
	};
}

const boxStyle = (box: MarkBox) => ({
	left: `${box.x * 100}%`,
	top: `${box.y * 100}%`,
	width: `${box.w * 100}%`,
	height: `${box.h * 100}%`,
});
</script>

<div
	bind:this={layer}
	class="mark-layer"
	class:is-active={active}
	role="presentation"
	data-testid="mark-layer"
	use:holdTouch={active}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerCancel}
>
	{#each marks as mark (mark.letter)}
		{@const at = boxStyle(mark)}
		<button
			type="button"
			class="mark"
			style:left={at.left}
			style:top={at.top}
			style:width={at.width}
			style:height={at.height}
			style:--mark-colour={MARK_COLOURS[mark.letter]}
			aria-label={$t('artifacts.image.panel.markA11y', { letter: mark.letter })}
			data-testid="mark-box"
			data-letter={mark.letter}
			onclick={() => remove(mark.letter)}
			out:markFade={{ duration: MOTION_DURATION.standard }}
		>
			<span class="mark-tag" aria-hidden="true">{mark.letter}</span>
		</button>
	{/each}
	{#if draft}
		{@const at = boxStyle(draft)}
		<div
			class="mark is-draft"
			style:left={at.left}
			style:top={at.top}
			style:width={at.width}
			style:height={at.height}
			style:--mark-colour={draftLetter ? MARK_COLOURS[draftLetter] : 'var(--text-muted)'}
			aria-hidden="true"
			data-testid="mark-draft"
		>
			{#if draftLetter}<span class="mark-tag">{draftLetter}</span>{/if}
		</div>
	{/if}
</div>

<style>
	.mark-layer {
		position: absolute;
		inset: 0;
		/* Mark off: the picture keeps the pointer (the zoom, the panel); only the boxes take a press. */
		pointer-events: none;
	}

	.mark-layer.is-active {
		pointer-events: auto;
		touch-action: none;
		cursor: crosshair;
	}

	/* A box follows the hand: its edges are written per event, and nothing on it
	   transitions (only its removal fades, through the out transition). */
	.mark {
		position: absolute;
		box-sizing: border-box;
		margin: 0;
		padding: 0;
		border: 2px solid var(--mark-colour);
		border-radius: var(--radius-sm);
		background: transparent;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.25);
		pointer-events: auto;
		cursor: pointer;
		transition: none;
	}

	/* With Mark on, the layer reads every press (a drag may start inside a box). */
	.mark-layer.is-active .mark {
		pointer-events: none;
	}

	.mark.is-draft {
		pointer-events: none;
	}

	.mark:focus-visible {
		outline: 2px solid var(--focus-ring, var(--text-primary));
		outline-offset: 2px;
	}

	.mark-tag {
		position: absolute;
		top: -1px;
		left: -1px;
		padding: 0 var(--space-xs);
		border-radius: var(--radius-sm) 0 var(--radius-sm) 0;
		background: var(--mark-colour);
		/* The mark colours are data, the same in both themes, and so is the letter on them. */
		color: #fff;
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 800;
		line-height: calc(var(--space-md) + var(--space-xs));
	}
</style>
