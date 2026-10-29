/**
 * Zoom and pan for the full-screen viewer (`ImageLightbox.svelte`, plan 2b
 * Task 22: "it should be possible to actually enlarge the picture").
 *
 * The picture is laid out FITTED in the stage (CSS alone: `max-width` and
 * `max-height` of the stage, never past its own size), and every zoom is a
 * `transform: translate() scale()` over that fitted box, origin at its centre,
 * which is the stage's centre. So the model works in "times fit": 1 is fit,
 * `actualScale` is 100% of the picture's own pixels. Nothing here re-lays the
 * picture out; only `transform` moves (MOTION-PARITY 3).
 *
 * The pure part (`zoomAbout`, `clampView`, `toggleFitActual`, ...) is what the
 * tests hold; `createLightboxZoom` wires it to the stage's wheel, pointer and
 * double-click events. Pinch reuses the panel's `pinch-zoom.ts` arithmetic
 * (`zoomFrom` with the viewer's own bounds, `distanceOf`, `midpointOf`, the
 * double-tap window), so the two pinches feel the same.
 */
import type { Attachment } from "svelte/attachments";
import {
	distanceOf,
	midpointOf,
	nextTap,
	type Tap,
	zoomFrom,
} from "$lib/components/artifacts/image/pinch-zoom";

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
/** `scale` is times fit; `x`/`y` move the fitted picture's centre from the stage's, in px. */
export type ZoomView = { scale: number; x: number; y: number };
export type ZoomFrame = {
	/** The picture's laid-out (untransformed) size: fit. */
	fitted: Size;
	/** The stage the picture is centred in. */
	stage: Size;
	/** The picture's own pixels. */
	natural: Size;
};

export const FIT_VIEW: ZoomView = Object.freeze({ scale: 1, x: 0, y: 0 });

/** However small the picture, the viewer can always go this far in. */
const MIN_MAX_ZOOM = 4;
/** One keyboard or button step. */
const STEP = 1.25;
/** How strongly a wheel pixel zooms, and the largest one event may move. */
const WHEEL_PER_PIXEL = 0.002;
const WHEEL_MAX_FACTOR = 1.5;
const LINE_PIXELS = 16;
/** Below this the view counts as fit (float dust from a pinch back). */
const FIT_EPSILON = 0.001;

/** How many times fit 100% is. Never under 1: fit never upscales. */
export function actualScale(frame: ZoomFrame): number {
	if (frame.fitted.width <= 0 || frame.natural.width <= 0) return 1;
	return Math.max(1, frame.natural.width / frame.fitted.width);
}

/** Fit is the floor; the ceiling is twice 100%, and never under 4x fit. */
export function scaleRange(frame: ZoomFrame): { min: number; max: number } {
	return { min: 1, max: Math.max(MIN_MAX_ZOOM, actualScale(frame) * 2) };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The scale in range, and the picture kept over the stage on every axis it overflows. */
export function clampView(view: ZoomView, frame: ZoomFrame): ZoomView {
	const { min, max } = scaleRange(frame);
	const scale = Math.min(max, Math.max(min, view.scale));
	if (scale <= min + FIT_EPSILON) return FIT_VIEW;
	const slackX = Math.max(
		0,
		(scale * frame.fitted.width - frame.stage.width) / 2,
	);
	const slackY = Math.max(
		0,
		(scale * frame.fitted.height - frame.stage.height) / 2,
	);
	const clamp = (value: number, slack: number) =>
		round(Math.min(slack, Math.max(-slack, value))) || 0;
	return { scale, x: clamp(view.x, slackX), y: clamp(view.y, slackY) };
}

/** Zooms to `nextScale` keeping the picture point under `point` (from the stage's centre) where it is. */
export function zoomAbout(
	view: ZoomView,
	nextScale: number,
	point: Point,
	frame: ZoomFrame,
): ZoomView {
	const { min, max } = scaleRange(frame);
	const scale = Math.min(max, Math.max(min, nextScale));
	const anchorX = (point.x - view.x) / view.scale;
	const anchorY = (point.y - view.y) / view.scale;
	return clampView(
		{ scale, x: point.x - anchorX * scale, y: point.y - anchorY * scale },
		frame,
	);
}

/** Double click or tap: fit goes to 100% (2x where 100% is fit) about the point; anything else goes to fit. */
export function toggleFitActual(
	view: ZoomView,
	point: Point,
	frame: ZoomFrame,
): ZoomView {
	if (view.scale > 1 + FIT_EPSILON) return FIT_VIEW;
	const actual = actualScale(frame);
	return zoomAbout(view, actual > 1 + 0.05 ? actual : 2, point, frame);
}

/** One + / - step about the stage's centre. */
export function stepZoom(
	view: ZoomView,
	direction: 1 | -1,
	frame: ZoomFrame,
): ZoomView {
	return zoomAbout(
		view,
		direction > 0 ? view.scale * STEP : view.scale / STEP,
		{ x: 0, y: 0 },
		frame,
	);
}

/** A drag moves the picture, never past its edges. */
export function panBy(
	view: ZoomView,
	dx: number,
	dy: number,
	frame: ZoomFrame,
): ZoomView {
	return clampView({ ...view, x: view.x + dx, y: view.y + dy }, frame);
}

/** What one wheel event multiplies the scale by: up (negative delta) zooms in. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaMode === 1 ? deltaY * LINE_PIXELS : deltaY;
	const factor = Math.exp(-pixels * WHEEL_PER_PIXEL);
	return Math.min(WHEEL_MAX_FACTOR, Math.max(1 / WHEEL_MAX_FACTOR, factor));
}

/** The zoom as a share of the picture's own size (fit of a 2x picture is 50%). */
export function zoomPercent(view: ZoomView, frame: ZoomFrame): number {
	return Math.round((view.scale / actualScale(frame)) * 100);
}

/** The picture's own pixels: the decoded image's, else its width/height attributes, else what it is drawn at. */
function naturalSizeOf(picture: HTMLElement, fitted: Size): Size {
	const image = picture instanceof HTMLImageElement ? picture : null;
	const attribute = (name: string) => Number(picture.getAttribute(name)) || 0;
	return {
		width: image?.naturalWidth || attribute("width") || fitted.width,
		height: image?.naturalHeight || attribute("height") || fitted.height,
	};
}

/** Where a pinch has the picture: the picture point under the fingers' start stays under their middle. */
function pinchView(
	gesture: { distance: number; scale: number; anchor: Point },
	fingers: { distance: number; mid: Point },
	frame: ZoomFrame,
): ZoomView {
	const scale = zoomFrom(gesture, fingers, scaleRange(frame));
	return clampView(
		{
			scale,
			x: fingers.mid.x - gesture.anchor.x * scale,
			y: fingers.mid.y - gesture.anchor.y * scale,
		},
		frame,
	);
}

export type LightboxZoom = {
	/** On the stage: wheel, drag, pinch, double click and double tap. */
	attach: Attachment<HTMLElement>;
	/** Measures again (the picture loaded, its size is known) and reports the view. */
	refresh(): void;
	/** Another picture: back to fit at once, no easing. */
	reset(): void;
	zoomIn(): void;
	zoomOut(): void;
	fit(): void;
	/** True once if the last press dragged or pinched: the click that ends it closes nothing. */
	consumeGesture(): boolean;
};

/**
 * The viewer's zoom on a stage. The picture is the stage's `[data-zoom-target]`.
 * `onChange` hears every view (the component shows the percent and the cursor).
 * A wheel, a drag and a pinch follow the hand in the frame it moves (one
 * `requestAnimationFrame` write, no transition); a double click, a key or a
 * button eases on `--duration-standard` / `--ease-out`, which the app's
 * reduced-motion rule makes instant.
 */
export function createLightboxZoom(
	onChange: (view: ZoomView, frame: ZoomFrame) => void,
): LightboxZoom {
	let stage: HTMLElement | null = null;
	let view: ZoomView = FIT_VIEW;
	let frameRequest = 0;
	let gestured = false;
	const pointers = new Map<number, Point>();
	let drag: { pointerId: number; last: Point; moved: number } | null = null;
	let pinch: {
		distance: number;
		scale: number;
		anchor: Point;
	} | null = null;
	let lastTap: Tap | null = null;
	let tapStart: { at: number; point: Point; multi: boolean } | null = null;

	const target = () =>
		stage?.querySelector<HTMLElement>("[data-zoom-target]") ?? null;

	function measure(): ZoomFrame | null {
		const picture = target();
		if (!stage || !picture) return null;
		const fitted = { width: picture.offsetWidth, height: picture.offsetHeight };
		return {
			fitted,
			natural: naturalSizeOf(picture, fitted),
			stage: { width: stage.clientWidth, height: stage.clientHeight },
		};
	}

	/** A point in the stage's own space: from its centre. */
	function fromCentre(clientX: number, clientY: number): Point {
		const rect = stage?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return {
			x: clientX - (rect.left + rect.width / 2),
			y: clientY - (rect.top + rect.height / 2),
		};
	}

	function write(): void {
		const picture = target();
		if (!picture) return;
		picture.style.transform =
			view.scale === 1 && view.x === 0 && view.y === 0
				? ""
				: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
	}

	function show(next: ZoomView, frame: ZoomFrame, animate: boolean): void {
		view = next;
		onChange(view, frame);
		const picture = target();
		if (!picture) return;
		if (animate) {
			if (frameRequest) cancelAnimationFrame(frameRequest);
			frameRequest = 0;
			picture.style.transition =
				"transform var(--duration-standard) var(--ease-out)";
			write();
			return;
		}
		picture.style.transition = "";
		if (frameRequest) return;
		frameRequest = requestAnimationFrame(() => {
			frameRequest = 0;
			write();
		});
	}

	function apply(
		change: (current: ZoomView, frame: ZoomFrame) => ZoomView,
		animate: boolean,
	): void {
		const frame = measure();
		if (!frame) return;
		show(change(view, frame), frame, animate);
	}

	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		const point = fromCentre(event.clientX, event.clientY);
		// A trackpad pinch arrives as a wheel with ctrlKey and small deltas.
		const delta = event.ctrlKey ? event.deltaY * 5 : event.deltaY;
		apply(
			(current, frame) =>
				zoomAbout(
					current,
					current.scale * wheelZoomFactor(delta, event.deltaMode),
					point,
					frame,
				),
			false,
		);
	}

	function beginPinch(): void {
		const [a, b] = [...pointers.values()];
		if (!a || !b) return;
		const midClient = midpointOf(a, b);
		const mid = fromCentre(midClient.x, midClient.y);
		drag = null;
		pinch = {
			distance: distanceOf(a, b),
			scale: view.scale,
			anchor: {
				x: (mid.x - view.x) / view.scale,
				y: (mid.y - view.y) / view.scale,
			},
		};
		gestured = true;
		if (tapStart) tapStart.multi = true;
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		const point = { x: event.clientX, y: event.clientY };
		pointers.set(event.pointerId, point);
		if (pointers.size === 1) {
			gestured = false;
			tapStart =
				event.pointerType === "touch"
					? { at: event.timeStamp, point, multi: false }
					: null;
			drag = { pointerId: event.pointerId, last: point, moved: 0 };
		} else if (pointers.size === 2 && event.pointerType === "touch") {
			beginPinch();
		}
	}

	/** Two fingers move: the picture follows them in the frame they move. */
	function movePinch(): void {
		const gesture = pinch;
		const [a, b] = [...pointers.values()];
		if (!gesture || !a || !b) return;
		const middle = midpointOf(a, b);
		const fingers = {
			distance: distanceOf(a, b),
			mid: fromCentre(middle.x, middle.y),
		};
		apply((_, frame) => pinchView(gesture, fingers, frame), false);
	}

	/** The drag keeps the picture even when the hand leaves the stage. */
	function capture(pointerId: number): void {
		if (!stage || stage.hasPointerCapture(pointerId)) return;
		try {
			stage.setPointerCapture(pointerId);
		} catch {
			// A pointer the browser no longer knows (lifted mid-move): the drag goes on uncaptured.
		}
	}

	/** One pointer moves: past a few pixels it is a drag, and a zoomed picture pans with it. */
	function moveDrag(event: PointerEvent, point: Point): void {
		if (!drag || drag.pointerId !== event.pointerId) return;
		const dx = point.x - drag.last.x;
		const dy = point.y - drag.last.y;
		drag.last = point;
		drag.moved += Math.abs(dx) + Math.abs(dy);
		if (drag.moved > 4) gestured = true;
		if (view.scale <= 1) return;
		if (gestured) capture(event.pointerId);
		apply((current, frame) => panBy(current, dx, dy, frame), false);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		const point = { x: event.clientX, y: event.clientY };
		pointers.set(event.pointerId, point);
		if (pinch && pointers.size >= 2) movePinch();
		else moveDrag(event, point);
	}

	/** The last finger came off a tap no drag or pinch joined: the second in the window toggles fit and 100%. */
	function endTap(event: PointerEvent): void {
		const started = tapStart;
		tapStart = null;
		if (!started || started.multi || gestured) return;
		const point = { x: event.clientX, y: event.clientY };
		const result = nextTap(lastTap, { at: event.timeStamp, point });
		lastTap = result.last;
		if (!result.double) return;
		gestured = true;
		const at = fromCentre(point.x, point.y);
		apply((current, frame) => toggleFitActual(current, at, frame), true);
	}

	function onPointerEnd(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		pointers.delete(event.pointerId);
		if (pointers.size < 2) pinch = null;
		if (drag?.pointerId === event.pointerId) drag = null;
		if (pointers.size === 0 && event.type !== "pointercancel") endTap(event);
	}

	function onDoubleClick(event: MouseEvent): void {
		event.preventDefault();
		const at = fromCentre(event.clientX, event.clientY);
		apply((current, frame) => toggleFitActual(current, at, frame), true);
	}

	function onResize(): void {
		apply((current, frame) => clampView(current, frame), false);
	}

	const attach: Attachment<HTMLElement> = (node) => {
		stage = node;
		node.style.touchAction = "none";
		node.addEventListener("wheel", onWheel, { passive: false });
		node.addEventListener("pointerdown", onPointerDown);
		node.addEventListener("pointermove", onPointerMove);
		node.addEventListener("pointerup", onPointerEnd);
		node.addEventListener("pointercancel", onPointerEnd);
		node.addEventListener("dblclick", onDoubleClick);
		window.addEventListener("resize", onResize);
		return () => {
			node.removeEventListener("wheel", onWheel);
			node.removeEventListener("pointerdown", onPointerDown);
			node.removeEventListener("pointermove", onPointerMove);
			node.removeEventListener("pointerup", onPointerEnd);
			node.removeEventListener("pointercancel", onPointerEnd);
			node.removeEventListener("dblclick", onDoubleClick);
			window.removeEventListener("resize", onResize);
			if (frameRequest) cancelAnimationFrame(frameRequest);
			frameRequest = 0;
			pointers.clear();
			stage = null;
			view = FIT_VIEW;
		};
	};

	return {
		attach,
		refresh: () => apply((current, frame) => clampView(current, frame), false),
		reset() {
			if (frameRequest) cancelAnimationFrame(frameRequest);
			frameRequest = 0;
			pointers.clear();
			drag = null;
			pinch = null;
			lastTap = null;
			view = FIT_VIEW;
			const picture = target();
			if (picture) {
				picture.style.transition = "";
				picture.style.transform = "";
			}
			const frame = measure();
			if (frame) onChange(view, frame);
		},
		zoomIn: () => apply((current, frame) => stepZoom(current, 1, frame), true),
		zoomOut: () =>
			apply((current, frame) => stepZoom(current, -1, frame), true),
		fit: () => apply(() => FIT_VIEW, true),
		consumeGesture() {
			const was = gestured;
			gestured = false;
			return was;
		},
	};
}
