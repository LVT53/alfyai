/**
 * Pinch-to-zoom for the panel's picture on a phone (plan 2b T3, MOTION-PARITY 8,
 * F24). Two fingers zoom (1x to 4x) and pan; a double tap goes back to 1x; one
 * finger is left alone, for the Mark tool (T6) and for the panel's own scroll.
 *
 * Only `transform` moves, on the element marked `data-pinch-target` inside the
 * node (or its first child), and it follows the fingers in the frame they move
 * (one `requestAnimationFrame` write per frame, no transition while pinching).
 * The way back to 1x eases on the motion tokens; the app's reduced-motion rule
 * makes it instant. `touch-action: none` is set on the node alone while the
 * action is on, so the page and the panel keep their own gestures everywhere
 * else, and the pointers of a pinch stop at the node: no handler above it (the
 * phone sheet's) starts a gesture of its own from them.
 */
import type { ActionReturn } from "svelte/action";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** The zoom a pinch has reached: the start's scale times how far the fingers spread, clamped to 1..4. */
export function zoomFrom(
	start: { distance: number; scale: number },
	now: { distance: number },
): number {
	const raw =
		start.distance > 0
			? (start.scale * now.distance) / start.distance
			: start.scale;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw));
}

export type PinchZoomOptions = { enabled: boolean };

type Point = { x: number; y: number };

/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

function distanceOf(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpointOf(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function pinchZoom(
	node: HTMLElement,
	options: PinchZoomOptions,
): ActionReturn<PinchZoomOptions> {
	let enabled = false;
	let scale = 1;
	let x = 0;
	let y = 0;
	let frame = 0;
	const pointers = new Map<number, Point>();
	/** The pinch under way: where it started, in screen space and in the picture's own. */
	let gesture: {
		distance: number;
		scale: number;
		mid: Point;
		/** The picture's untransformed centre and size when the pinch began. */
		centre: Point;
		width: number;
		height: number;
		/** The picture point under the start midpoint, from the centre, unscaled. */
		anchor: Point;
	} | null = null;
	/** A single finger's tap: where and when it came down, and whether a pinch joined it. */
	let tap: { at: number; point: Point; pinched: boolean } | null = null;
	let lastTap: { at: number; point: Point } | null = null;

	const target = (): HTMLElement | null =>
		node.querySelector<HTMLElement>("[data-pinch-target]") ??
		(node.firstElementChild as HTMLElement | null);

	function paint(): void {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			const element = target();
			if (!element) return;
			element.style.transform =
				scale === 1 && x === 0 && y === 0
					? ""
					: `translate(${x}px, ${y}px) scale(${scale})`;
		});
	}

	/** Back to 1x, easing on the tokens (instant under reduced motion: the global rule). */
	function reset(animate: boolean): void {
		scale = 1;
		x = 0;
		y = 0;
		gesture = null;
		const element = target();
		if (element && animate) {
			element.style.transition =
				"transform var(--duration-standard) var(--ease-out)";
			const done = () => {
				element.style.transition = "";
				element.removeEventListener("transitionend", done);
			};
			element.addEventListener("transitionend", done);
		}
		paint();
	}

	/** Keeps the zoomed picture over its box: no empty band can be dragged in. */
	function clampPan(width: number, height: number): void {
		const maxX = ((scale - 1) * width) / 2;
		const maxY = ((scale - 1) * height) / 2;
		x = Math.min(maxX, Math.max(-maxX, x));
		y = Math.min(maxY, Math.max(-maxY, y));
	}

	function beginPinch(): void {
		const element = target();
		const [a, b] = [...pointers.values()];
		if (!element || !a || !b) return;
		const rect = element.getBoundingClientRect();
		const centre = {
			x: rect.left + rect.width / 2 - x,
			y: rect.top + rect.height / 2 - y,
		};
		const mid = midpointOf(a, b);
		element.style.transition = "";
		gesture = {
			distance: distanceOf(a, b),
			scale,
			mid,
			centre,
			width: rect.width / scale,
			height: rect.height / scale,
			anchor: {
				x: (mid.x - centre.x - x) / scale,
				y: (mid.y - centre.y - y) / scale,
			},
		};
		if (tap) tap.pinched = true;
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.pointerType !== "touch") return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.size === 1) {
			tap = {
				at: event.timeStamp,
				point: { x: event.clientX, y: event.clientY },
				pinched: false,
			};
		}
		if (pointers.size === 2) {
			event.stopPropagation();
			beginPinch();
		}
	}

	function onPointerMove(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.size < 2 || !gesture) return;
		event.stopPropagation();
		const [a, b] = [...pointers.values()];
		const mid = midpointOf(a, b);
		scale = zoomFrom(gesture, { distance: distanceOf(a, b) });
		// The picture point that was under the fingers stays under them.
		x = mid.x - gesture.centre.x - gesture.anchor.x * scale;
		y = mid.y - gesture.centre.y - gesture.anchor.y * scale;
		clampPan(gesture.width, gesture.height);
		paint();
	}

	function onPointerEnd(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		const wasPinch = pointers.size >= 2;
		pointers.delete(event.pointerId);
		if (wasPinch) event.stopPropagation();
		if (pointers.size < 2) {
			gesture = null;
			if (scale <= 1.01 && (x !== 0 || y !== 0 || scale !== 1)) reset(true);
		}
		if (pointers.size > 0 || event.type === "pointercancel") return;
		const ended = tap;
		tap = null;
		if (!ended || ended.pinched) return;
		const point = { x: event.clientX, y: event.clientY };
		if (
			lastTap &&
			event.timeStamp - lastTap.at <= DOUBLE_TAP_MS &&
			distanceOf(lastTap.point, point) <= DOUBLE_TAP_PX
		) {
			lastTap = null;
			if (scale !== 1 || x !== 0 || y !== 0) reset(true);
			return;
		}
		lastTap = { at: event.timeStamp, point };
	}

	function enable(): void {
		if (enabled) return;
		enabled = true;
		node.style.touchAction = "none";
		node.addEventListener("pointerdown", onPointerDown);
		node.addEventListener("pointermove", onPointerMove);
		node.addEventListener("pointerup", onPointerEnd);
		node.addEventListener("pointercancel", onPointerEnd);
	}

	function disable(): void {
		if (!enabled) return;
		enabled = false;
		node.style.touchAction = "";
		node.removeEventListener("pointerdown", onPointerDown);
		node.removeEventListener("pointermove", onPointerMove);
		node.removeEventListener("pointerup", onPointerEnd);
		node.removeEventListener("pointercancel", onPointerEnd);
		pointers.clear();
		tap = null;
		lastTap = null;
		reset(false);
	}

	if (options.enabled) enable();

	return {
		update(next) {
			if (next.enabled) enable();
			else disable();
		},
		destroy() {
			disable();
			if (frame) cancelAnimationFrame(frame);
		},
	};
}
