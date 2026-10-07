/**
 * What a laptop's touchpad and a mouse wheel do on the board (CV-C).
 *
 * The flow library's own wheel handling is a map's: a scroll zooms, a pinch is scaled
 * for one kind of device (ten times the pixels on a Mac, as the browser sends them),
 * and a mouse's notch under Control jumps to the end of the zoom. A laptop's touchpad
 * is Figma's:
 *
 *   two-finger scroll, a mouse wheel   pan, both axes, by what the fingers did
 *   Shift with either                  pan across (a system that already turned it says deltaX)
 *   a pinch (the browser's Control + wheel), Control or Command with the wheel
 *                                      zoom about the pointer, in proportion to the gesture,
 *                                      one event at most a step of about a tenth
 *
 * so the board takes the wheel events over its pane first (a capture listener on the
 * library's zoom element) and moves the camera itself; the library never sees them.
 * Space and a drag, the Hand tool, the middle button and a finger are the library's
 * own and are not here. What a block keeps for itself is left alone: the library's
 * `nowheel` (a map that zooms, an App, an edit form), and any element
 * that scrolls the way the wheel goes (the browser scrolls it; `overscroll-behavior` on
 * the board keeps the rest of the gesture from carrying on out of it).
 *
 * Safari reports a trackpad's pinch as a gesture (`gesturestart`, `gesturechange`,
 * `gestureend`, with a `scale`), not as a Control + wheel, so a pinch there zoomed
 * nothing and zoomed the page instead (CV-B2). The board takes those too: the same zoom,
 * about the pointer, by what the fingers did, and the page's own zoom is cancelled over
 * the whole board. A finger on a screen pinches through touch events (iOS Safari
 * reports gestures for those as well), which are the library's and are left alone.
 *
 * Loaded when the board mounts, in its own chunk, so the editor's first paint carries
 * only the line that asks for it. It imports nothing from the editor and no flow
 * library: it is handed the camera's two members and the zoom's limits.
 */

/** The camera, as the flow library keeps it. */
export type WheelCamera = { x: number; y: number; zoom: number };

/** The two members of the flow library's helpers this needs. */
export type WheelFlow = {
	getViewport: () => WheelCamera;
	setViewport: (camera: WheelCamera) => unknown;
};

/** How far the board may be zoomed. */
export type ZoomRange = { min: number; max: number };

/** What a wheel event says that matters here; `x` and `y` are where the pointer is, from the pane's top left corner. */
export type WheelInput = {
	deltaX: number;
	deltaY: number;
	deltaMode: number;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	x: number;
	y: number;
};

/** A wheel that counts in lines (Firefox's notched one) or pages, in pixels. */
const LINE_PX = 20;
const PAGE_PX = 400;
/**
 * How far a pixel of a pinch zooms, in octaves. A pinch is many small events (a few
 * pixels each), and this is the gain that makes a whole one cover the range of the
 * zoom without the board jumping from frame to frame.
 */
const OCTAVES_PER_PX = 0.014;
/**
 * The most pixels one event may zoom by: a notch of a mouse wheel is a hundred of
 * them and is one step (about a tenth), where the same notch scaled like a pinch
 * would be the whole range. A touchpad's events are far below it and never reach it.
 */
const MAX_ZOOM_PX = 12;

/** The library's name for "this block keeps the wheel"; its own pan and zoom skip anything under it. */
const KEEPS_WHEEL = ".nowheel";
/** The element the library listens to for wheel events: the pane and everything on it. */
const PANE = ".svelte-flow__zoom";

function pixels(delta: number, mode: number): number {
	return mode === 1 ? delta * LINE_PX : mode === 2 ? delta * PAGE_PX : delta;
}

function between(value: number, least: number, most: number): number {
	return Math.min(most, Math.max(least, value));
}

/**
 * The camera after zooming by `ratio` about the point (`x`, `y`) of the pane: the board
 * point under it stays under it. Null when that moves nothing (the zoom is at its limit).
 */
export function zoomAbout(
	camera: WheelCamera,
	ratio: number,
	x: number,
	y: number,
	range: ZoomRange,
): WheelCamera | null {
	const zoom = between(camera.zoom * ratio, range.min, range.max);
	const by = zoom / camera.zoom;
	if (!(by > 0) || by === 1) return null;
	return { zoom, x: x - (x - camera.x) * by, y: y - (y - camera.y) * by };
}

/** Where the camera goes for one wheel event; null when the event moves nothing (a zoom at its limit, a delta of 0). */
export function nextCamera(
	input: WheelInput,
	camera: WheelCamera,
	range: ZoomRange,
): WheelCamera | null {
	const dx = pixels(input.deltaX, input.deltaMode);
	const dy = pixels(input.deltaY, input.deltaMode);
	if (input.ctrlKey || input.metaKey) {
		const along = dy || dx;
		if (!along) return null;
		const step = between(along, -MAX_ZOOM_PX, MAX_ZOOM_PX);
		return zoomAbout(
			camera,
			2 ** (-step * OCTAVES_PER_PX),
			input.x,
			input.y,
			range,
		);
	}
	// Shift turns a vertical scroll across; a system that did it already sent deltaX.
	const across = input.shiftKey && Math.abs(dy) > Math.abs(dx);
	const moveX = across ? dy : dx;
	const moveY = across ? 0 : dy;
	if (!moveX && !moveY) return null;
	return { zoom: camera.zoom, x: camera.x - moveX, y: camera.y - moveY };
}

/** Whether `element` scrolls along the axis the wheel is mostly moving in. */
function scrollsAlong(element: Element, vertical: boolean): boolean {
	const room = vertical
		? element.scrollHeight - element.clientHeight
		: element.scrollWidth - element.clientWidth;
	if (room <= 1) return false;
	const style = getComputedStyle(element);
	const overflow = vertical ? style.overflowY : style.overflowX;
	return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/**
 * Who, between the pointer and the pane, keeps the wheel: a block that says so
 * (`nowheel`: the library's own convention, so the events reach it untouched), or an
 * element that scrolls the way the wheel goes (the browser scrolls it). A pinch or a
 * Control or Command wheel belongs to the board over anything that merely scrolls.
 */
export function wheelKeeper(
	event: Pick<Event, "target"> &
		Pick<WheelInput, "deltaX" | "deltaY" | "deltaMode">,
	pane: Element,
	zooms: boolean,
): "nowheel" | "scrolls" | null {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return null;
	const keeper = target.closest(KEEPS_WHEEL);
	if (keeper && pane.contains(keeper)) return "nowheel";
	if (zooms) return null;
	const vertical =
		Math.abs(pixels(event.deltaY, event.deltaMode)) >=
		Math.abs(pixels(event.deltaX, event.deltaMode));
	for (
		let element: Element | null = target;
		element && element !== pane;
		element = element.parentElement
	) {
		if (scrollsAlong(element, vertical)) return "scrolls";
	}
	return null;
}

function handleWheel(
	event: WheelEvent,
	pane: Element,
	flow: WheelFlow,
	range: ZoomRange,
): void {
	const zooms = event.ctrlKey || event.metaKey;
	const keeper = wheelKeeper(event, pane, zooms);
	if (keeper === "nowheel") {
		// The block keeps its wheel; the page's own zoom is nobody's here.
		if (zooms) event.preventDefault();
		return;
	}
	if (keeper === "scrolls") {
		// The browser scrolls it: the library must not take it from the block.
		event.stopImmediatePropagation();
		return;
	}
	// Nothing is left for the browser to do with it: no page scroll, no history swipe, no page zoom.
	event.preventDefault();
	event.stopImmediatePropagation();
	const box = pane.getBoundingClientRect();
	const next = nextCamera(
		{
			deltaX: event.deltaX,
			deltaY: event.deltaY,
			deltaMode: event.deltaMode,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			shiftKey: event.shiftKey,
			x: event.clientX - box.left,
			y: event.clientY - box.top,
		},
		flow.getViewport(),
		range,
	);
	if (next) void flow.setViewport(next);
}

/** What Safari reports of a trackpad's pinch: a GestureEvent, which lib.dom does not describe. */
type PinchEvent = Event & { scale: number; clientX?: number; clientY?: number };

/**
 * Safari's pinch over the board. `scale` is how far the fingers have spread since the
 * gesture began (1 at its start), so one event zooms by its change since the last,
 * about the pointer: the board follows the fingers one to one. The page's own zoom is
 * cancelled wherever the gesture is over the board; the camera moves only over the pane
 * and not over a block that keeps its wheel (a map, an App, an edit form). A touch that
 * is down means the fingers are on a screen, whose pinch is the library's own.
 */
function watchGestures(
	board: HTMLElement,
	pane: Element,
	flow: WheelFlow,
	range: ZoomRange,
): () => void {
	let scale = 1;
	let touching = false;
	let pointer: { x: number; y: number } | null = null;
	const touch = (event: Event) => {
		touching = ((event as TouchEvent).touches?.length ?? 0) > 0;
	};
	// Where the pointer is for a gesture that does not say; a mouse moving is no finger down, whatever touch event was missed.
	const move = (event: Event) => {
		const { clientX, clientY, pointerType } = event as PointerEvent;
		pointer = { x: clientX, y: clientY };
		if (pointerType !== "touch") touching = false;
	};
	const gesture = (event: Event) => {
		if (touching) return;
		event.preventDefault();
		if (event.type === "gesturestart") scale = 1;
		if (event.type !== "gesturechange") return;
		const target = event.target instanceof Element ? event.target : null;
		const { scale: now, clientX, clientY } = event as PinchEvent;
		const ratio = now / scale;
		scale = now;
		if (
			!target ||
			!pane.contains(target) ||
			wheelKeeper({ target, deltaX: 0, deltaY: 0, deltaMode: 0 }, pane, true)
		) {
			return;
		}
		const box = pane.getBoundingClientRect();
		const x = (clientX ?? pointer?.x ?? box.left + box.width / 2) - box.left;
		const y = (clientY ?? pointer?.y ?? box.top + box.height / 2) - box.top;
		const next = zoomAbout(flow.getViewport(), ratio, x, y, range);
		if (next) void flow.setViewport(next);
	};
	const touches = ["touchstart", "touchend", "touchcancel"];
	const gestures = ["gesturestart", "gesturechange", "gestureend"];
	for (const type of touches) {
		board.addEventListener(type, touch, { capture: true, passive: true });
	}
	board.addEventListener("pointermove", move, { capture: true, passive: true });
	// Not passive: the page's own zoom is what this cancels.
	for (const type of gestures) {
		board.addEventListener(type, gesture, { capture: true, passive: false });
	}
	return () => {
		for (const type of touches) board.removeEventListener(type, touch, true);
		board.removeEventListener("pointermove", move, true);
		for (const type of gestures) board.removeEventListener(type, gesture, true);
	};
}

/** A pinch over the board's own chrome (the toolbar, the zoom, the overview) is not the page's to zoom either. */
function keepPageZoom(event: Event): void {
	const { ctrlKey, metaKey } = event as WheelEvent;
	if (ctrlKey || metaKey) event.preventDefault();
}

/**
 * Takes the wheel over the board's pane (`board` holds the library's zoom element)
 * for a camera that zooms between `min` and `max`; returns the way to give it back.
 *
 * It also sets the board's `overscroll-behavior` here rather than in its style: what
 * scrolls inside the board stops at it (no page scroll, no history swipe), and a
 * declaration in the board's style would sit in the editor's first paint.
 */
export function watchWheel(
	board: HTMLElement,
	flow: WheelFlow,
	min: number,
	max: number,
): () => void {
	const pane = board.querySelector(PANE);
	if (!pane) return () => {};
	const range = { min, max };
	const listen = (event: Event) =>
		handleWheel(event as WheelEvent, pane, flow, range);
	const before = board.style.overscrollBehavior;
	board.style.overscrollBehavior = "none";
	// Not passive: the page's own handling of the event is what this cancels.
	pane.addEventListener("wheel", listen, { capture: true, passive: false });
	board.addEventListener("wheel", keepPageZoom, { passive: false });
	const stopGestures = watchGestures(board, pane, flow, range);
	return () => {
		stopGestures();
		pane.removeEventListener("wheel", listen, { capture: true });
		board.removeEventListener("wheel", keepPageZoom);
		board.style.overscrollBehavior = before;
	};
}
