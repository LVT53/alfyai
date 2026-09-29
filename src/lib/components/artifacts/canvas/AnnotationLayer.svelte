<script lang="ts">
/**
 * The drawing layer: the marks a reader draws on a board (pen, highlighter,
 * line, arrow, rectangle, ellipse, text), the eraser, and picking, moving,
 * nudging and deleting a mark. It renders inside the flow's viewport
 * (`<ViewportPortal target="front">`, mounted by the board), so every point is a
 * BOARD point: a stroke drawn at 100 % stays glued to what it was drawn on at any
 * zoom, and the PNG export, which clones that same viewport, gets the strokes
 * with no second render path.
 *
 * Three traps the prototype measured, each a test (`artifact-canvas-draw.spec.ts`):
 * - the pointer surface is sized from the VISIBLE PANE (`visibleBoardRect`), never
 *   from the portal's box, which is only as big as the nodes: at fit view on a
 *   163-block board an `inset: 0` pad caught 6 of 144 sample points, and the board
 *   silently stopped being drawable once the camera zoomed out;
 * - `z-index: 2`, explicitly: the library lifts every frame child to 1, so an
 *   `auto` layer sits under the notes inside a frame and the pen drags the note
 *   under it instead of drawing;
 * - the pointer rules live on the elements that own them (inline), not on a
 *   parent rule: the portal renders this into a sibling of the board's root, so a
 *   descendant selector written from there never matches, and the pad stayed at
 *   `pointer-events: none`.
 *
 * The pad takes the pointer only while a tool that draws (or the eraser) is
 * active. With Select, the pad lets everything through and each mark is picked by
 * its own hit shape, so a press on ink selects the ink and a press anywhere else
 * is the board's. There is one tab stop, the layer itself.
 *
 * A gesture is one step: the layer hands the whole new list to `onchange` once,
 * when the gesture ends, and the board makes it one step in the reader's history.
 */
import { t } from "$lib/i18n";
import type { Annotation, Pt } from "$lib/shared/artifacts/canvas";
import {
	ANNOTATION_TEXT_MAX_CHARS,
	decimateStroke,
	MAX_ANNOTATIONS_PER_BOARD,
	MAX_POINTS_PER_STROKE,
} from "$lib/shared/artifacts/canvas-body";
import {
	annotationBounds,
	arrowHead,
	baseSize,
	type DrawingTool,
	isDrawingTool,
	normRect,
	pickAnnotation,
	strokePath,
	type Tool,
	translate,
} from "./_lib/annotations";
import { newId } from "./_lib/ids";
import {
	type PaneSize,
	visibleBoardRect,
	type ViewportLike,
} from "./_lib/pane-rect";

let {
	annotations,
	viewport,
	paneSize,
	tool,
	ink,
	readonly = false,
	toBoard,
	onchange,
	ontoolchange,
	onannounce,
	onlimit,
}: {
	annotations: readonly Annotation[];
	viewport: ViewportLike;
	/** The visible pane, in pixels. */
	paneSize: PaneSize;
	tool: Tool;
	/** The ink a new mark is drawn in: a colour token (`var(--ink-blue)`). */
	ink: string;
	/** The board cannot change now: marks draw, but nothing can be drawn, picked or moved. */
	readonly?: boolean;
	/** A screen point to a board point (the flow's own conversion). */
	toBoard: (client: Pt) => Pt;
	/** One gesture is complete: the whole new list of marks. */
	onchange: (next: Annotation[]) => void;
	ontoolchange: (tool: Tool) => void;
	/** A line for the board's polite live region. */
	onannounce: (message: string) => void;
	/** A mark was refused because the board holds as many as it may: the board says so where the reader can see it. */
	onlimit: () => void;
} = $props();

const uid = $props.id();

/** A point closer than this (in screen pixels) to the last one adds nothing to a stroke. */
const MIN_STEP_PX = 1.5;
/** A shape dragged less than this (screen pixels) is a click, and leaves nothing. */
const MIN_SHAPE_PX = 4;
/** How far from ink (screen pixels) a press or the eraser still counts as on it. */
const REACH_PX = 6;
/** How far past its edge the pad reaches, so a pan that outruns the camera never shows a bare edge. */
const PAD_MARGIN_PX = 24;

let layerEl = $state<HTMLElement | null>(null);
let selectedId = $state<string | null>(null);
let draft = $state.raw<Annotation | null>(null);
let sweep = $state.raw<ReadonlySet<string>>(new Set());
let moving = $state.raw<{ id: string; dx: number; dy: number } | null>(null);
let textEdit = $state<{
	id: string | null;
	at: Pt;
	value: string;
	size: number;
	color: string;
} | null>(null);

const pointers = new Set<number>();
let startClient: Pt | null = null;
let lastPoint: Pt | null = null;

let drawing = $derived(isDrawingTool(tool) || tool === "eraser");
let selectable = $derived(tool === "select" && !readonly);
let zoom = $derived(viewport.zoom > 0 ? viewport.zoom : 1);
let pad = $derived(visibleBoardRect(paneSize, viewport, PAD_MARGIN_PX / zoom));
let measured = $derived(pad.width > 0 && pad.height > 0);
let selected = $derived(
	selectedId === null
		? null
		: (annotations.find((mark) => mark.id === selectedId) ?? null),
);
// One tab stop, and only while there is something for the keyboard to do here.
let focusable = $derived(drawing || annotations.length > 0);

$effect(() => {
	// A mark that is gone (an undo took it back, a delete) cannot stay selected.
	if (selectedId !== null && selected === null) selectedId = null;
});

$effect(() => {
	// Leaving Select lets go of the selection; a text being typed is finished.
	if (tool !== "select") selectedId = null;
});

function boardPoint(event: PointerEvent): Pt {
	return toBoard({ x: event.clientX, y: event.clientY });
}

function round(p: Pt): Pt {
	return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
}

// ---- Rendering helpers -----------------------------------------------------

const pathCache = new WeakMap<Annotation, string>();

function pathOf(mark: Annotation): string {
	let d = pathCache.get(mark);
	if (d === undefined) {
		d = strokePath(
			mark.points ?? [],
			mark.size,
			mark.kind === "highlighter" ? 0 : 0.5,
		);
		pathCache.set(mark, d);
	}
	return d;
}

const ORIGIN: Pt = { x: 0, y: 0 };

function polyline(points: readonly Pt[] | undefined): string {
	const list = points?.length ? points : [ORIGIN];
	// One point twice: a zero-length stroke with round caps is the dot it is.
	const drawn = list.length === 1 ? [list[0], list[0]] : list;
	return drawn.map((p) => `${p.x},${p.y}`).join(" ");
}

/** A mark's outline for its selection box: a few screen pixels of air all round. */
function boxOf(mark: Annotation) {
	const b = annotationBounds(mark);
	const air = 4 / zoom;
	return {
		x: b.x - air,
		y: b.y - air,
		width: b.width + air * 2,
		height: b.height + air * 2,
	};
}

/** What a pointer event carries: its coalesced samples when the browser kept them (a fast stroke is many points per frame), else itself. */
function samplesOf(event: PointerEvent): PointerEvent[] {
	const coalesced = event.getCoalescedEvents?.();
	return coalesced?.length ? coalesced : [event];
}

// ---- Committing ------------------------------------------------------------

function commitMark(mark: Annotation): void {
	if (annotations.length >= MAX_ANNOTATIONS_PER_BOARD) {
		onlimit();
		return;
	}
	onchange([...annotations, mark]);
}

function cancelGesture(): void {
	draft = null;
	sweep = new Set();
	startClient = null;
	lastPoint = null;
}

// ---- The pad: drawing and erasing -----------------------------------------

function markAt(point: Pt): Annotation | null {
	return pickAnnotation(annotations, point, REACH_PX / zoom);
}

function sweepTo(point: Pt): void {
	// Between the last sample and this one, so a quick flick cannot skip a thin line.
	const from = lastPoint ?? point;
	const steps = Math.max(
		1,
		Math.ceil((Math.hypot(point.x - from.x, point.y - from.y) * zoom) / 4),
	);
	let next: Set<string> | null = null;
	for (let i = 1; i <= steps; i += 1) {
		const at = {
			x: from.x + ((point.x - from.x) * i) / steps,
			y: from.y + ((point.y - from.y) * i) / steps,
		};
		const hit = markAt(at);
		if (hit && !sweep.has(hit.id) && !next?.has(hit.id)) {
			next ??= new Set(sweep);
			next.add(hit.id);
		}
	}
	if (next) sweep = next;
	lastPoint = point;
}

function handlePadPointerDown(event: PointerEvent): void {
	if (!drawing || readonly || !layerEl) return;
	// Middle and right buttons pan (the board leaves them to the library).
	if (event.pointerType === "mouse" && event.button !== 0) return;
	pointers.add(event.pointerId);
	if (pointers.size > 1) {
		// A second finger is a pinch, not a stroke: nothing of the first is kept.
		cancelGesture();
		return;
	}
	finishText(true);
	event.preventDefault();
	layerEl.setPointerCapture(event.pointerId);
	layerEl.focus({ preventScroll: true });
	const point = boardPoint(event);
	startClient = { x: event.clientX, y: event.clientY };
	lastPoint = point;
	if (tool === "eraser") {
		sweep = new Set();
		sweepTo(point);
		return;
	}
	if (!isDrawingTool(tool)) return;
	const kind: DrawingTool = tool;
	if (kind === "text") {
		const existing = markAt(point);
		if (existing?.kind === "text") openText(existing.at ?? point, existing);
		else openText(point);
		startClient = null;
		return;
	}
	const base = { id: newId(kind), kind, color: ink, size: baseSize(kind) };
	draft =
		kind === "pen" || kind === "highlighter"
			? { ...base, points: [point] }
			: { ...base, from: point, to: point };
}

function handlePadPointerMove(event: PointerEvent): void {
	if (!startClient || !pointers.has(event.pointerId)) return;
	if (tool === "eraser") {
		for (const sample of samplesOf(event)) sweepTo(boardPoint(sample));
		return;
	}
	const current = draft;
	if (!current) return;
	const samples = samplesOf(event);
	if (current.points) {
		const points = [...current.points];
		let last = lastPoint ?? points[points.length - 1];
		for (const sample of samples) {
			const point = boardPoint(sample);
			if (Math.hypot(point.x - last.x, point.y - last.y) * zoom < MIN_STEP_PX)
				continue;
			points.push(point);
			last = point;
		}
		lastPoint = last;
		if (points.length !== current.points.length) draft = { ...current, points };
		return;
	}
	draft = { ...current, to: boardPoint(event) };
}

function handlePadPointerUp(event: PointerEvent): void {
	if (!pointers.delete(event.pointerId)) return;
	const finished = draft;
	const swept = sweep;
	const kind = tool;
	const start = startClient;
	cancelGesture();
	if (!start) return;
	if (kind === "eraser") {
		if (swept.size > 0) {
			onchange(annotations.filter((mark) => !swept.has(mark.id)));
			onannounce($t("artifacts.canvas.markErased"));
		}
		return;
	}
	if (!finished) return;
	if (finished.points) {
		// A click is a dot; a stroke past the cap is thinned by distance, both ends kept.
		const points = decimateStroke(
			finished.points.map(round),
			MAX_POINTS_PER_STROKE,
		);
		commitMark({ ...finished, points });
		return;
	}
	if (!finished.from || !finished.to) return;
	const length = Math.hypot(
		finished.to.x - finished.from.x,
		finished.to.y - finished.from.y,
	);
	if (length * zoom < MIN_SHAPE_PX) return;
	commitMark({
		...finished,
		from: round(finished.from),
		to: round(finished.to),
	});
}

function handlePadPointerCancel(event: PointerEvent): void {
	pointers.delete(event.pointerId);
	cancelGesture();
}

// ---- Select: picking, moving ----------------------------------------------

let moveStart: Pt | null = null;

function handleMarkPointerDown(event: PointerEvent, mark: Annotation): void {
	if (!selectable || (event.pointerType === "mouse" && event.button !== 0))
		return;
	// A press on ink is ours: no compatibility mousedown, so nothing moves focus off the layer.
	event.preventDefault();
	selectedId = mark.id;
	layerEl?.focus({ preventScroll: true });
	moveStart = { x: event.clientX, y: event.clientY };
	moving = { id: mark.id, dx: 0, dy: 0 };
	(event.currentTarget as Element).setPointerCapture(event.pointerId);
}

function handleMarkPointerMove(event: PointerEvent): void {
	if (!moveStart || !moving) return;
	moving = {
		id: moving.id,
		dx: (event.clientX - moveStart.x) / zoom,
		dy: (event.clientY - moveStart.y) / zoom,
	};
}

function handleMarkPointerUp(): void {
	const gesture = moving;
	moveStart = null;
	moving = null;
	if (!gesture) return;
	// Under a few pixels it was a click: it selected, and that is all.
	if (Math.hypot(gesture.dx, gesture.dy) * zoom < MIN_SHAPE_PX) return;
	onchange(
		annotations.map((mark) =>
			mark.id === gesture.id
				? moved(translate(mark, gesture.dx, gesture.dy))
				: mark,
		),
	);
}

/** A moved mark, on the same 0.1 grid a drawn one is stored on. */
function moved(mark: Annotation): Annotation {
	return {
		...mark,
		...(mark.points ? { points: mark.points.map(round) } : {}),
		...(mark.from ? { from: round(mark.from) } : {}),
		...(mark.to ? { to: round(mark.to) } : {}),
		...(mark.at ? { at: round(mark.at) } : {}),
	};
}

// ---- Text ------------------------------------------------------------------

function openText(at: Pt, existing?: Annotation): void {
	textEdit = {
		id: existing?.id ?? null,
		at,
		value: existing?.text ?? "",
		size: existing?.size ?? baseSize("text"),
		color: existing?.color ?? ink,
	};
}

/** Puts the text being typed on the board (or, with `keep` false, drops it). Safe to call twice. */
function finishText(keep: boolean): void {
	const edit = textEdit;
	if (!edit) return;
	textEdit = null;
	if (!keep) return;
	const value = edit.value.trim();
	if (edit.id !== null) {
		const existing = annotations.find((mark) => mark.id === edit.id);
		if (!existing || value === (existing.text ?? "")) return;
		onchange(
			value === ""
				? annotations.filter((mark) => mark.id !== edit.id)
				: annotations.map((mark) =>
						mark.id === edit.id ? { ...mark, text: value } : mark,
					),
		);
		return;
	}
	if (value === "") return;
	commitMark({
		id: newId("text"),
		kind: "text",
		color: edit.color,
		size: edit.size,
		at: round(edit.at),
		text: value,
	});
}

function handleTextKeydown(event: KeyboardEvent): void {
	if (event.key !== "Enter" && event.key !== "Escape") return;
	event.preventDefault();
	event.stopPropagation();
	finishText(event.key === "Enter");
	layerEl?.focus({ preventScroll: true });
}

// ---- Keyboard --------------------------------------------------------------

const ARROWS: Record<string, Pt> = {
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
	ArrowUp: { x: 0, y: -1 },
	ArrowDown: { x: 0, y: 1 },
};

function consume(event: KeyboardEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function handleKeydown(event: KeyboardEvent): void {
	if (event.target !== layerEl) return;
	if (event.key === "Escape") {
		// The layer takes Escape first: the panel closes only when it has nothing to give up.
		if (draft || sweep.size > 0) {
			consume(event);
			cancelGesture();
		} else if (drawing) {
			consume(event);
			ontoolchange("select");
		} else if (selectedId !== null) {
			consume(event);
			selectedId = null;
		}
		return;
	}
	const mark = selected;
	if (!mark || readonly) return;
	if (event.key === "Delete" || event.key === "Backspace") {
		consume(event);
		selectedId = null;
		onchange(annotations.filter((other) => other.id !== mark.id));
		onannounce($t("artifacts.canvas.markDeleted"));
	} else if (event.key === "Enter" && mark.kind === "text") {
		consume(event);
		openText(mark.at ?? ORIGIN, mark);
	} else if (event.key in ARROWS) {
		consume(event);
		const step = event.shiftKey ? 10 : 1;
		const by = ARROWS[event.key];
		onchange(
			annotations.map((other) =>
				other.id === mark.id
					? translate(other, by.x * step, by.y * step)
					: other,
			),
		);
	}
}

function handleMarkDoubleClick(mark: Annotation): void {
	if (selectable && mark.kind === "text") openText(mark.at ?? ORIGIN, mark);
}

const CURSORS: Partial<Record<Tool, string>> = { eraser: "cell" };

let summary = $derived(
	$t("artifacts.canvas.drawingLayer.marks", { count: annotations.length }),
);
let selectedBox = $derived(selected ? boxOf(selected) : null);
</script>

{#snippet visual(mark: Annotation)}
	{#if mark.kind === "pen" || mark.kind === "highlighter"}
		<path
			d={pathOf(mark)}
			style:fill={mark.color}
			fill-opacity={mark.kind === "highlighter" ? 0.35 : 1}
		/>
	{:else if mark.kind === "line" && mark.from && mark.to}
		<line
			x1={mark.from.x}
			y1={mark.from.y}
			x2={mark.to.x}
			y2={mark.to.y}
			style:stroke={mark.color}
			stroke-width={mark.size}
			stroke-linecap="round"
		/>
	{:else if mark.kind === "arrow" && mark.from && mark.to}
		<line
			x1={mark.from.x}
			y1={mark.from.y}
			x2={mark.to.x}
			y2={mark.to.y}
			style:stroke={mark.color}
			stroke-width={mark.size}
			stroke-linecap="butt"
		/>
		<path d={arrowHead(mark.from, mark.to, mark.size)} style:fill={mark.color} />
	{:else if mark.kind === "rect" && mark.from && mark.to}
		{@const r = normRect(mark.from, mark.to)}
		<rect
			x={r.x}
			y={r.y}
			width={r.width}
			height={r.height}
			rx="2"
			fill="none"
			style:stroke={mark.color}
			stroke-width={mark.size}
			stroke-linejoin="round"
		/>
	{:else if mark.kind === "ellipse" && mark.from && mark.to}
		{@const r = normRect(mark.from, mark.to)}
		<ellipse
			cx={r.x + r.width / 2}
			cy={r.y + r.height / 2}
			rx={r.width / 2}
			ry={r.height / 2}
			fill="none"
			style:stroke={mark.color}
			stroke-width={mark.size}
		/>
	{:else if mark.kind === "text" && mark.at}
		<text
			x={mark.at.x}
			y={mark.at.y}
			font-size={mark.size}
			dominant-baseline="hanging"
			style:fill={mark.color}
			style:font-family="var(--font-sans)"
			class:annotation-text--editing={textEdit?.id === mark.id}
		>{mark.text}</text>
	{/if}
{/snippet}

{#snippet hit(mark: Annotation)}
	<!-- Ink is picked by its own shape, at least a fingertip wide at any zoom. -->
	{#if mark.kind === "pen" || mark.kind === "highlighter"}
		<polyline class="hit hit--stroke" points={polyline(mark.points)} style:stroke-width="max({mark.size}px, calc(16px / var(--annotation-zoom)))" />
	{:else if (mark.kind === "line" || mark.kind === "arrow") && mark.from && mark.to}
		<line class="hit hit--stroke" x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} style:stroke-width="max({mark.size}px, calc(16px / var(--annotation-zoom)))" />
	{:else if mark.kind === "rect" && mark.from && mark.to}
		{@const r = normRect(mark.from, mark.to)}
		<rect class="hit hit--stroke" x={r.x} y={r.y} width={r.width} height={r.height} style:stroke-width="max({mark.size}px, calc(16px / var(--annotation-zoom)))" />
	{:else if mark.kind === "ellipse" && mark.from && mark.to}
		{@const r = normRect(mark.from, mark.to)}
		<ellipse class="hit hit--stroke" cx={r.x + r.width / 2} cy={r.y + r.height / 2} rx={r.width / 2} ry={r.height / 2} style:stroke-width="max({mark.size}px, calc(16px / var(--annotation-zoom)))" />
	{:else if mark.kind === "text"}
		{@const b = annotationBounds(mark)}
		<rect class="hit hit--fill" x={b.x} y={b.y} width={b.width} height={b.height} />
	{/if}
{/snippet}

<!-- The layer's own box is zero-sized at the board's origin; everything in it is positioned in board units. `z-index: 2`, explicitly: see the header. -->
<div
	class="annotation-root"
	style="position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2; pointer-events: none; overflow: visible;"
	style:--annotation-zoom={zoom}
	data-testid="canvas-annotations"
>
	<svg
		class="annotation-ink"
		width="1"
		height="1"
		style="position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none;"
		aria-hidden="true"
		data-testid="canvas-ink"
	>
		{#each annotations as mark (mark.id)}
			<!-- Ink is picked by pointer here; the keyboard has the layer's own stop (arrows, Delete, Enter). -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<g
				class="mark nopan"
				class:mark--sweep={sweep.has(mark.id)}
				class:mark--picked={selectable}
				data-annotation-id={mark.id}
				data-kind={mark.kind}
				data-testid="canvas-mark"
				transform={moving?.id === mark.id ? `translate(${moving.dx} ${moving.dy})` : undefined}
				onpointerdown={(event) => handleMarkPointerDown(event, mark)}
				onpointermove={handleMarkPointerMove}
				onpointerup={handleMarkPointerUp}
				onpointercancel={handleMarkPointerUp}
				ondblclick={() => handleMarkDoubleClick(mark)}
			>
				{@render visual(mark)}
				{#if selectable}{@render hit(mark)}{/if}
			</g>
		{/each}
		{#if draft}
			<g class="mark mark--draft" data-testid="canvas-mark-draft">{@render visual(draft)}</g>
		{/if}
		{#if selectedBox}
			<rect
				class="selection"
				x={selectedBox.x}
				y={selectedBox.y}
				width={selectedBox.width}
				height={selectedBox.height}
				transform={moving?.id === selectedId ? `translate(${moving.dx} ${moving.dy})` : undefined}
				data-annotation-chrome
			/>
		{/if}
	</svg>

	<!-- The pointer surface, sized from the visible pane and only ever as big as it. -->
	<!-- The layer is one deliberate tab stop and hears the keyboard for the mark that is picked: an application region, by design. -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
	<div
		bind:this={layerEl}
		class="annotation-pad"
		role="application"
		tabindex={focusable ? 0 : -1}
		aria-label={$t("artifacts.canvas.drawingLayer")}
		aria-describedby="{uid}-summary"
		data-testid="canvas-drawing-layer"
		data-tool={tool}
		style:position="absolute"
		style:left={measured ? `${pad.left}px` : "0"}
		style:top={measured ? `${pad.top}px` : "0"}
		style:width={measured ? `${pad.width}px` : "100%"}
		style:height={measured ? `${pad.height}px` : "100%"}
		style:pointer-events={drawing && !readonly ? "auto" : "none"}
		style:touch-action={drawing ? "none" : "auto"}
		style:cursor={CURSORS[tool] ?? "crosshair"}
		style:z-index="2"
		onpointerdown={handlePadPointerDown}
		onpointermove={handlePadPointerMove}
		onpointerup={handlePadPointerUp}
		onpointercancel={handlePadPointerCancel}
		onkeydown={handleKeydown}
	></div>

	{#if textEdit}
		<input
			class="annotation-text nopan nodrag"
			type="text"
			value={textEdit.value}
			maxlength={ANNOTATION_TEXT_MAX_CHARS}
			aria-label={$t("artifacts.canvas.textMark")}
			style:left="{textEdit.at.x}px"
			style:top="{textEdit.at.y}px"
			style:font-size="{textEdit.size}px"
			style:color={textEdit.color}
			style:width="{Math.max(4, textEdit.value.length + 2)}ch"
			data-testid="canvas-text-input"
			{@attach (input) => {
				input.focus();
				input.select();
			}}
			oninput={(event) => {
				if (textEdit) textEdit.value = event.currentTarget.value;
			}}
			onkeydown={handleTextKeydown}
			onblur={() => finishText(true)}
		/>
	{/if}

	<span id="{uid}-summary" class="sr-only">{summary}</span>
</div>

<style>
	.annotation-pad:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.mark--sweep {
		opacity: 0.25;
	}

	.mark--picked .hit {
		fill: none;
		stroke: transparent;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: stroke;
		cursor: pointer;
	}

	.mark--picked .hit--fill {
		fill: transparent;
		stroke: none;
		pointer-events: all;
	}

	.annotation-text--editing {
		visibility: hidden;
	}

	.selection {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.5px;
		stroke-dasharray: 5 4;
		vector-effect: non-scaling-stroke;
		pointer-events: none;
	}

	.annotation-text {
		position: absolute;
		z-index: 3;
		box-sizing: content-box;
		min-width: 4ch;
		padding: 0;
		margin: 0;
		border: 0;
		border-bottom: 1px dashed var(--accent);
		outline: none;
		background: transparent;
		font-family: var(--font-sans);
		line-height: 1.3;
		pointer-events: auto;
	}
</style>
