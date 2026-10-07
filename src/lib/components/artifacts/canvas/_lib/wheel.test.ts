import { afterEach, describe, expect, it, vi } from "vitest";
import {
	nextCamera,
	type WheelCamera,
	type WheelFlow,
	type WheelInput,
	watchWheel,
	wheelKeeper,
} from "./wheel";

const RANGE = { min: 0.2, max: 2 };
const AT: WheelCamera = { x: 40, y: -30, zoom: 1 };

/** A wheel event as the browser reports it, with the pointer at (200, 120) of the pane. */
const wheel = (over: Partial<WheelInput> = {}): WheelInput => ({
	deltaX: 0,
	deltaY: 0,
	deltaMode: 0,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	x: 200,
	y: 120,
	...over,
});

/** The board point under a screen point, for "the pointer's point did not move". */
const under = (camera: WheelCamera, x: number, y: number) => ({
	x: (x - camera.x) / camera.zoom,
	y: (y - camera.y) / camera.zoom,
});

describe("nextCamera: a scroll pans", () => {
	it("moves the board by what the fingers did, in both axes, and never zooms", () => {
		expect(nextCamera(wheel({ deltaX: 30, deltaY: 50 }), AT, RANGE)).toEqual({
			x: 10,
			y: -80,
			zoom: 1,
		});
		expect(nextCamera(wheel({ deltaX: -5, deltaY: -9 }), AT, RANGE)).toEqual({
			x: 45,
			y: -21,
			zoom: 1,
		});
	});

	it("moves it by the same screen distance at any zoom", () => {
		const zoomedIn = { x: 0, y: 0, zoom: 1.7 };
		expect(nextCamera(wheel({ deltaY: 100 }), zoomedIn, RANGE)).toEqual({
			x: 0,
			y: -100,
			zoom: 1.7,
		});
	});

	it("counts a wheel that reports lines or pages in pixels", () => {
		expect(nextCamera(wheel({ deltaY: 3, deltaMode: 1 }), AT, RANGE)?.y).toBe(
			-90,
		);
		expect(nextCamera(wheel({ deltaY: 1, deltaMode: 2 }), AT, RANGE)?.y).toBe(
			-430,
		);
	});

	it("moves nothing for an event with no distance in it", () => {
		expect(nextCamera(wheel(), AT, RANGE)).toBeNull();
		expect(nextCamera(wheel({ shiftKey: true }), AT, RANGE)).toBeNull();
	});
});

describe("nextCamera: Shift turns a scroll across", () => {
	it("turns a vertical notch into a horizontal pan", () => {
		expect(
			nextCamera(wheel({ deltaY: 80, shiftKey: true }), AT, RANGE),
		).toEqual({ x: -40, y: -30, zoom: 1 });
	});

	it("does not turn it twice when the system already did (the event says deltaX)", () => {
		expect(
			nextCamera(wheel({ deltaX: 80, shiftKey: true }), AT, RANGE),
		).toEqual({ x: -40, y: -30, zoom: 1 });
	});

	it("keeps the dominant direction of a diagonal gesture", () => {
		expect(
			nextCamera(wheel({ deltaX: 60, deltaY: 10, shiftKey: true }), AT, RANGE),
		).toEqual({ x: -20, y: -40, zoom: 1 });
	});
});

describe("nextCamera: a pinch and Control or Command with the wheel zoom", () => {
	it("zooms in for fingers apart (a negative delta) and out for fingers together", () => {
		const closer = nextCamera(wheel({ deltaY: -8, ctrlKey: true }), AT, RANGE);
		const apart = nextCamera(wheel({ deltaY: 8, ctrlKey: true }), AT, RANGE);
		expect(closer?.zoom).toBeGreaterThan(1.05);
		expect(closer?.zoom).toBeLessThan(1.15);
		expect(apart?.zoom).toBeLessThan(0.95);
		expect(apart?.zoom).toBeGreaterThan(0.85);
	});

	it("keeps the board point under the pointer under it", () => {
		const before = under(AT, 200, 120);
		const next = nextCamera(wheel({ deltaY: -9, ctrlKey: true }), AT, RANGE);
		const after = under(next as WheelCamera, 200, 120);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
	});

	it("is in proportion to the gesture: ten small events zoom as far as one of ten times the size", () => {
		let camera: WheelCamera = AT;
		for (let step = 0; step < 10; step++) {
			camera = nextCamera(
				wheel({ deltaY: -1, ctrlKey: true }),
				camera,
				RANGE,
			) as WheelCamera;
		}
		const once = nextCamera(wheel({ deltaY: -10, ctrlKey: true }), AT, RANGE);
		expect(camera.zoom).toBeCloseTo(once?.zoom ?? 0, 9);
		expect(camera.x).toBeCloseTo(once?.x ?? 0, 6);
		expect(camera.y).toBeCloseTo(once?.y ?? 0, 6);
	});

	it("takes a mouse's notch as one step of about a tenth, not as a jump to the limit", () => {
		const notch = nextCamera(wheel({ deltaY: -100, ctrlKey: true }), AT, RANGE);
		expect(notch?.zoom).toBeGreaterThan(1.1);
		expect(notch?.zoom).toBeLessThan(1.15);
		// Whatever is larger than the step is the step.
		expect(
			nextCamera(wheel({ deltaY: -4000, ctrlKey: true }), AT, RANGE)?.zoom,
		).toBe(notch?.zoom);
		expect(
			nextCamera(wheel({ deltaY: 3, deltaMode: 1, ctrlKey: true }), AT, RANGE)
				?.zoom,
		).toBeLessThan(0.9);
	});

	it("is the same for Command as for Control", () => {
		expect(nextCamera(wheel({ deltaY: -6, metaKey: true }), AT, RANGE)).toEqual(
			nextCamera(wheel({ deltaY: -6, ctrlKey: true }), AT, RANGE),
		);
	});

	it("does not turn a zoom into a pan when Shift is also held", () => {
		const shifted = nextCamera(
			wheel({ deltaY: -6, ctrlKey: true, shiftKey: true }),
			AT,
			RANGE,
		);
		expect(shifted).toEqual(
			nextCamera(wheel({ deltaY: -6, ctrlKey: true }), AT, RANGE),
		);
	});

	it("stops at the limits and says nothing moved there", () => {
		const closest = { x: 5, y: 6, zoom: 2 };
		const farthest = { x: 5, y: 6, zoom: 0.2 };
		expect(
			nextCamera(wheel({ deltaY: -9, ctrlKey: true }), closest, RANGE),
		).toBeNull();
		expect(
			nextCamera(wheel({ deltaY: 9, ctrlKey: true }), farthest, RANGE),
		).toBeNull();
		// A step that would pass the limit ends on it, about the pointer.
		const nearly = { x: 0, y: 0, zoom: 1.95 };
		const last = nextCamera(
			wheel({ deltaY: -100, ctrlKey: true }),
			nearly,
			RANGE,
		);
		expect(last?.zoom).toBe(2);
	});

	it("moves nothing for a zoom of no distance", () => {
		expect(nextCamera(wheel({ ctrlKey: true }), AT, RANGE)).toBeNull();
	});
});

/** A pane holding a block, the block holding a child: what a wheel event's path is made of. */
function scene() {
	const board = document.createElement("div");
	const pane = document.createElement("div");
	pane.className = "svelte-flow__zoom";
	const block = document.createElement("div");
	const child = document.createElement("span");
	block.append(child);
	pane.append(block);
	board.append(pane);
	document.body.append(board);
	return { board, pane, block, child };
}

/** What `scrollHeight` and `clientHeight` would say, which jsdom does not lay out. */
function scrolls(
	element: HTMLElement,
	room: { height?: number; width?: number },
	overflow = "auto",
) {
	Object.defineProperty(element, "scrollHeight", {
		value: 100 + (room.height ?? 0),
		configurable: true,
	});
	Object.defineProperty(element, "clientHeight", {
		value: 100,
		configurable: true,
	});
	Object.defineProperty(element, "scrollWidth", {
		value: 100 + (room.width ?? 0),
		configurable: true,
	});
	Object.defineProperty(element, "clientWidth", {
		value: 100,
		configurable: true,
	});
	// Both axes by name: jsdom does not spread the shorthand into the longhands.
	element.style.overflowX = overflow;
	element.style.overflowY = overflow;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("wheelKeeper: what keeps the wheel for itself", () => {
	const down = { deltaX: 0, deltaY: 40, deltaMode: 0 };

	it("is nobody, over plain blocks and the ground", () => {
		const { pane, child } = scene();
		expect(wheelKeeper({ target: child, ...down }, pane, false)).toBeNull();
		expect(wheelKeeper({ target: pane, ...down }, pane, false)).toBeNull();
	});

	it("is a block that says so (the library's nowheel), pinch included", () => {
		const { pane, block, child } = scene();
		block.classList.add("nowheel");
		expect(wheelKeeper({ target: child, ...down }, pane, false)).toBe(
			"nowheel",
		);
		expect(wheelKeeper({ target: child, ...down }, pane, true)).toBe("nowheel");
	});

	it("does not take a nowheel above the pane for the pane's own", () => {
		const { board, pane, child } = scene();
		board.classList.add("nowheel");
		expect(wheelKeeper({ target: child, ...down }, pane, false)).toBeNull();
	});

	it("is an element that scrolls the way the wheel goes", () => {
		const { pane, block, child } = scene();
		scrolls(block, { height: 300 });
		expect(wheelKeeper({ target: child, ...down }, pane, false)).toBe(
			"scrolls",
		);
		// The wheel going sideways is not what this one scrolls to.
		expect(
			wheelKeeper(
				{ target: child, deltaX: 40, deltaY: 0, deltaMode: 0 },
				pane,
				false,
			),
		).toBeNull();
	});

	it("is an element that scrolls sideways, for a wheel going sideways", () => {
		const { pane, block, child } = scene();
		scrolls(block, { width: 200 });
		expect(
			wheelKeeper(
				{ target: child, deltaX: 40, deltaY: 5, deltaMode: 0 },
				pane,
				false,
			),
		).toBe("scrolls");
	});

	it("is not an element with a pixel of room, or one that clips, or one that is not asked to scroll", () => {
		const { pane, block, child } = scene();
		scrolls(block, { height: 1 });
		expect(wheelKeeper({ target: child, ...down }, pane, false)).toBeNull();
		scrolls(block, { height: 300 }, "hidden");
		expect(wheelKeeper({ target: child, ...down }, pane, false)).toBeNull();
		scrolls(block, { height: 300 }, "visible");
		expect(wheelKeeper({ target: child, ...down }, pane, false)).toBeNull();
	});

	it("leaves a pinch and Control with the wheel to the board over what only scrolls", () => {
		const { pane, block, child } = scene();
		scrolls(block, { height: 300 });
		expect(wheelKeeper({ target: child, ...down }, pane, true)).toBeNull();
	});
});

/** A real wheel event, as a browser dispatches one: it bubbles and can be cancelled. */
function wheelEvent(over: WheelEventInit = {}): WheelEvent {
	return new WheelEvent("wheel", {
		bubbles: true,
		cancelable: true,
		clientX: 200,
		clientY: 120,
		...over,
	});
}

describe("watchWheel: the events over the pane", () => {
	function watched() {
		const parts = scene();
		const set = vi.fn();
		let camera: WheelCamera = { ...AT };
		const flow: WheelFlow = {
			getViewport: () => camera,
			setViewport: (next) => {
				camera = next;
				set(next);
			},
		};
		const seenByLibrary = vi.fn();
		// The library's own listener: bubble phase, on the same element.
		parts.pane.addEventListener("wheel", seenByLibrary);
		const stop = watchWheel(parts.board, flow, RANGE.min, RANGE.max);
		return { ...parts, set, seenByLibrary, stop, camera: () => camera };
	}

	it("pans on a scroll, cancels it, and keeps it from the library", () => {
		const { child, set, seenByLibrary } = watched();
		const event = wheelEvent({ deltaX: 10, deltaY: 25 });
		child.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(set).toHaveBeenCalledWith({ x: 30, y: -55, zoom: 1 });
		expect(seenByLibrary).not.toHaveBeenCalled();
	});

	it("zooms on a pinch about the pointer and cancels the page's own zoom", () => {
		const { child, set, camera } = watched();
		const event = wheelEvent({ deltaY: -9, ctrlKey: true });
		child.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(set).toHaveBeenCalledTimes(1);
		expect(camera().zoom).toBeGreaterThan(1);
		const after = under(camera(), 200, 120);
		const before = under(AT, 200, 120);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
	});

	it("cancels an event that moves nothing too: the page has no use for it either", () => {
		const { child, set } = watched();
		const event = wheelEvent({ deltaY: 0, deltaX: 0 });
		child.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(set).not.toHaveBeenCalled();
	});

	it("leaves a nowheel block's wheel to it and to the library, and cancels only a zoom", () => {
		const { block, child, set, seenByLibrary } = watched();
		block.classList.add("nowheel");
		const scroll = wheelEvent({ deltaY: 30 });
		child.dispatchEvent(scroll);
		expect(scroll.defaultPrevented).toBe(false);
		const pinch = wheelEvent({ deltaY: -9, ctrlKey: true });
		child.dispatchEvent(pinch);
		expect(pinch.defaultPrevented).toBe(true);
		expect(seenByLibrary).toHaveBeenCalledTimes(2);
		expect(set).not.toHaveBeenCalled();
	});

	it("leaves a scrolling block's wheel to the browser, and keeps it from the library", () => {
		const { block, child, set, seenByLibrary } = watched();
		scrolls(block, { height: 300 });
		const scroll = wheelEvent({ deltaY: 30 });
		child.dispatchEvent(scroll);
		expect(scroll.defaultPrevented).toBe(false);
		expect(seenByLibrary).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		// A pinch over it is still the board's.
		const pinch = wheelEvent({ deltaY: -9, ctrlKey: true });
		child.dispatchEvent(pinch);
		expect(pinch.defaultPrevented).toBe(true);
		expect(set).toHaveBeenCalledTimes(1);
	});

	it("measures the pointer from the pane's corner", () => {
		const { pane, child, camera } = watched();
		pane.getBoundingClientRect = () =>
			({ left: 150, top: 100, right: 650, bottom: 500 }) as DOMRect;
		child.dispatchEvent(wheelEvent({ deltaY: -9, ctrlKey: true }));
		// The pointer is (50, 20) from the corner: that is the point that stays.
		const before = under(AT, 50, 20);
		const after = under(camera(), 50, 20);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
	});

	it("does not leave the page's own zoom to a pinch over the board's chrome, which is not the pane", () => {
		const { board, set } = watched();
		const toolbar = document.createElement("div");
		board.append(toolbar);
		const pinch = wheelEvent({ deltaY: -9, ctrlKey: true });
		toolbar.dispatchEvent(pinch);
		expect(pinch.defaultPrevented).toBe(true);
		const command = wheelEvent({ deltaY: -9, metaKey: true });
		toolbar.dispatchEvent(command);
		expect(command.defaultPrevented).toBe(true);
		// A plain scroll there is nobody's business here, and the camera stays where it is.
		const scroll = wheelEvent({ deltaY: 30 });
		toolbar.dispatchEvent(scroll);
		expect(scroll.defaultPrevented).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it("keeps what scrolls inside the board from carrying on out of it, and gives that back when let go", () => {
		const { board, stop } = watched();
		expect(board.style.overscrollBehavior).toBe("none");
		stop();
		expect(board.style.overscrollBehavior).toBe("");
	});

	it("is not an event the board takes once it is let go, and takes nothing where there is no pane", () => {
		const { child, set, stop } = watched();
		stop();
		const event = wheelEvent({ deltaY: 25 });
		child.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(set).not.toHaveBeenCalled();
		const empty = document.createElement("div");
		expect(() =>
			watchWheel(
				empty,
				{ getViewport: () => AT, setViewport: set },
				RANGE.min,
				RANGE.max,
			)(),
		).not.toThrow();
	});
});

/**
 * A pinch as Safari reports it on a laptop's trackpad: not a Control + wheel but a
 * gesture event, which carries the scale of the whole gesture so far (1 at its start)
 * and where the pointer is. jsdom has no GestureEvent, so it is a plain event with the
 * members Safari's has.
 */
function gestureEvent(
	type: "gesturestart" | "gesturechange" | "gestureend",
	scale: number,
	at: { x: number; y: number } | null = { x: 200, y: 120 },
) {
	return Object.assign(
		new Event(type, { bubbles: true, cancelable: true }),
		{ scale, rotation: 0 },
		at ? { clientX: at.x, clientY: at.y } : {},
	);
}

/** A finger on a screen: the touch events a touch pinch comes with. */
function touchEvent(type: "touchstart" | "touchend", touches: number) {
	return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
		touches: Array.from({ length: touches }, () => ({})),
	});
}

describe("watchWheel: Safari's pinch is a gesture event, not a wheel", () => {
	function pinched() {
		const parts = scene();
		const set = vi.fn();
		let camera: WheelCamera = { ...AT };
		const flow: WheelFlow = {
			getViewport: () => camera,
			setViewport: (next) => {
				camera = next;
				set(next);
			},
		};
		const stop = watchWheel(parts.board, flow, RANGE.min, RANGE.max);
		return { ...parts, set, stop, camera: () => camera };
	}

	it("zooms about the pointer by what the fingers did, and cancels the page's own zoom the whole way", () => {
		const { child, set, camera } = pinched();
		const start = gestureEvent("gesturestart", 1);
		child.dispatchEvent(start);
		expect(start.defaultPrevented).toBe(true);
		expect(set).not.toHaveBeenCalled();

		const first = gestureEvent("gesturechange", 1.25);
		child.dispatchEvent(first);
		expect(first.defaultPrevented).toBe(true);
		expect(camera().zoom).toBeCloseTo(1.25, 9);
		// The board point under the pointer stays under it.
		const before = under(AT, 200, 120);
		const after = under(camera(), 200, 120);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);

		const end = gestureEvent("gestureend", 1.25);
		child.dispatchEvent(end);
		expect(end.defaultPrevented).toBe(true);
	});

	it("takes a scale as the whole gesture so far: many small events zoom as far as one big one", () => {
		const { child, camera } = pinched();
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		for (const scale of [1.1, 1.3, 1.6, 1.9]) {
			child.dispatchEvent(gestureEvent("gesturechange", scale));
		}
		expect(camera().zoom).toBeCloseTo(1.9, 9);
		// Fingers back together, to where they began: the zoom is where it was.
		child.dispatchEvent(gestureEvent("gesturechange", 1));
		expect(camera().zoom).toBeCloseTo(1, 9);
	});

	it("starts from a scale of 1 again with every gesture", () => {
		const { child, camera } = pinched();
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		child.dispatchEvent(gestureEvent("gesturechange", 1.5));
		child.dispatchEvent(gestureEvent("gestureend", 1.5));
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		child.dispatchEvent(gestureEvent("gesturechange", 1.2));
		expect(camera().zoom).toBeCloseTo(1.8, 9);
	});

	it("stops at the zoom's limits, and a gesture that moves nothing there moves no camera", () => {
		const { child, set, camera } = pinched();
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		child.dispatchEvent(gestureEvent("gesturechange", 20));
		expect(camera().zoom).toBe(RANGE.max);
		const moves = set.mock.calls.length;
		child.dispatchEvent(gestureEvent("gesturechange", 21));
		expect(set).toHaveBeenCalledTimes(moves);
		child.dispatchEvent(gestureEvent("gesturechange", 0.01));
		expect(camera().zoom).toBe(RANGE.min);
	});

	it("measures the pointer from the pane's corner", () => {
		const { pane, child, camera } = pinched();
		pane.getBoundingClientRect = () =>
			({ left: 150, top: 100, right: 650, bottom: 500 }) as DOMRect;
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		child.dispatchEvent(gestureEvent("gesturechange", 1.5));
		const before = under(AT, 50, 20);
		const after = under(camera(), 50, 20);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
	});

	it("falls back to where the pointer last was when the event does not say, and to the pane's middle with none", () => {
		const { board, pane, child, camera } = pinched();
		pane.getBoundingClientRect = () =>
			({
				left: 0,
				top: 0,
				right: 400,
				bottom: 300,
				width: 400,
				height: 300,
			}) as DOMRect;
		child.dispatchEvent(gestureEvent("gesturestart", 1, null));
		child.dispatchEvent(gestureEvent("gesturechange", 1.5, null));
		// Nowhere known: the middle of the pane (200, 150).
		let before = under(AT, 200, 150);
		let after = under(camera(), 200, 150);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);

		board.dispatchEvent(
			Object.assign(new Event("pointermove", { bubbles: true }), {
				clientX: 60,
				clientY: 40,
				pointerType: "mouse",
			}),
		);
		child.dispatchEvent(gestureEvent("gestureend", 1.5, null));
		child.dispatchEvent(gestureEvent("gesturestart", 1, null));
		const held = camera();
		child.dispatchEvent(gestureEvent("gesturechange", 1.2, null));
		before = under(held, 60, 40);
		after = under(camera(), 60, 40);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
	});

	it("leaves a nowheel block's camera alone and cancels only the page's zoom", () => {
		const { block, child, set } = pinched();
		block.classList.add("nowheel");
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		const change = gestureEvent("gesturechange", 1.5);
		child.dispatchEvent(change);
		expect(change.defaultPrevented).toBe(true);
		expect(set).not.toHaveBeenCalled();
	});

	it("cancels the page's zoom over the board's chrome and leaves the camera alone there", () => {
		const { board, set } = pinched();
		const toolbar = document.createElement("div");
		board.append(toolbar);
		for (const [type, scale] of [
			["gesturestart", 1],
			["gesturechange", 1.4],
			["gestureend", 1.4],
		] as const) {
			const event = gestureEvent(type, scale);
			toolbar.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		}
		expect(set).not.toHaveBeenCalled();
	});

	it("leaves a finger's pinch to the library: while a touch is down, a gesture is neither zoomed nor cancelled", () => {
		const { child, set } = pinched();
		child.dispatchEvent(touchEvent("touchstart", 2));
		const start = gestureEvent("gesturestart", 1);
		child.dispatchEvent(start);
		const change = gestureEvent("gesturechange", 1.5);
		child.dispatchEvent(change);
		expect(start.defaultPrevented).toBe(false);
		expect(change.defaultPrevented).toBe(false);
		expect(set).not.toHaveBeenCalled();

		// The fingers lift: the trackpad is the board's again.
		child.dispatchEvent(touchEvent("touchend", 0));
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		const trackpad = gestureEvent("gesturechange", 1.5);
		child.dispatchEvent(trackpad);
		expect(trackpad.defaultPrevented).toBe(true);
		expect(set).toHaveBeenCalledTimes(1);
	});

	it("is a mouse moving that tells the board no finger is down any more, whatever was missed", () => {
		const { board, child, set } = pinched();
		child.dispatchEvent(touchEvent("touchstart", 1));
		board.dispatchEvent(
			Object.assign(new Event("pointermove", { bubbles: true }), {
				clientX: 5,
				clientY: 5,
				pointerType: "mouse",
			}),
		);
		child.dispatchEvent(gestureEvent("gesturestart", 1));
		child.dispatchEvent(gestureEvent("gesturechange", 1.5));
		expect(set).toHaveBeenCalledTimes(1);
	});

	it("takes nothing once it is let go", () => {
		const { child, set, stop } = pinched();
		stop();
		const start = gestureEvent("gesturestart", 1);
		child.dispatchEvent(start);
		child.dispatchEvent(gestureEvent("gesturechange", 1.5));
		expect(start.defaultPrevented).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});
});
