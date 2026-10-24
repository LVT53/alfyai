import { afterEach, describe, expect, it, vi } from "vitest";
import { followAnchor } from "./anchored-popup";

// What a browser would measure is stated here, because jsdom measures nothing:
// a control at a place, a popup of a width and a list height, a window of a
// size. What the browser does with the numbers is the e2e specs' (the outline
// list's and the context ring's).

type Box = { left: number; top: number; width: number; height: number };

function rectOf(box: Box): DOMRect {
	return {
		...box,
		x: box.left,
		y: box.top,
		right: box.left + box.width,
		bottom: box.top + box.height,
		toJSON: () => ({}),
	} as DOMRect;
}

function setWindow(width: number, height: number) {
	for (const [key, value] of [
		["innerWidth", width],
		["innerHeight", height],
	] as const) {
		Object.defineProperty(window, key, {
			configurable: true,
			writable: true,
			value,
		});
	}
}

function define(node: HTMLElement, key: string, value: unknown) {
	Object.defineProperty(node, key, { configurable: true, get: () => value });
}

function setUp(options: {
	window: { width: number; height: number };
	anchor: Box;
	popupWidth?: number;
	listHeight?: number;
}) {
	setWindow(options.window.width, options.window.height);
	const state = { anchor: options.anchor };
	const anchor = document.createElement("button");
	anchor.getBoundingClientRect = () => rectOf(state.anchor);
	const popup = document.createElement("div");
	popup.getBoundingClientRect = () =>
		rectOf({
			left: 0,
			top: 0,
			width: options.popupWidth ?? 220,
			height: options.listHeight ?? 100,
		});
	// A popup with a 1px border and nothing scrolled away yet.
	define(popup, "scrollHeight", options.listHeight ?? 100);
	define(popup, "offsetHeight", (options.listHeight ?? 100) + 2);
	define(popup, "clientHeight", options.listHeight ?? 100);
	return { state, anchor, popup };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	setWindow(1024, 768);
});

describe("followAnchor", () => {
	it("hangs the popup above its control, left edges aligned, a gap clear of it", () => {
		const { anchor, popup } = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 700, width: 44, height: 44 },
		});
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 260,
			onPlace,
		});

		// 8px above the control's top edge, measured from the window's bottom.
		expect(onPlace).toHaveBeenLastCalledWith(
			`left:300px;bottom:${768 - 700 + 8}px;max-height:260px;`,
			false,
		);
		stop();
	});

	it("pulls it back from the window's edge by the width it really has", () => {
		const { anchor, popup } = setUp({
			window: { width: 390, height: 844 },
			anchor: { left: 311, top: 747, width: 24, height: 24 },
			popupWidth: 220,
		});
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 260,
			onPlace,
		});

		expect(onPlace.mock.lastCall?.[0]).toContain(`left:${390 - 220 - 16}px;`);
		stop();
	});

	it("keeps the side margin it is given instead of the composer's", () => {
		const { anchor, popup } = setUp({
			window: { width: 390, height: 844 },
			anchor: { left: 221, top: 785, width: 48, height: 48 },
			popupWidth: 382,
		});
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 480,
			sideMargin: 4,
			onPlace,
		});

		expect(onPlace.mock.lastCall?.[0]).toContain("left:4px;");
		stop();
	});

	it("drops below its control when the list does not fit above and there is more room below", () => {
		const { anchor, popup } = setUp({
			window: { width: 1024, height: 300 },
			anchor: { left: 300, top: 120, width: 24, height: 24 },
			listHeight: 220,
		});
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 260,
			onPlace,
		});

		// The room below, less the window's margin: never taller than that.
		expect(onPlace).toHaveBeenLastCalledWith(
			`left:300px;top:${120 + 24 + 8}px;max-height:${300 - (120 + 24) - 16}px;`,
			// 220px of list in the 140px there is below the control.
			true,
		);
		stop();
	});

	it("stays above, scrolling inside the room it has, when below is no roomier", () => {
		const { anchor, popup } = setUp({
			window: { width: 1024, height: 420 },
			anchor: { left: 300, top: 250, width: 24, height: 24 },
			listHeight: 400,
		});
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 480,
			onPlace,
		});

		expect(onPlace).toHaveBeenLastCalledWith(
			`left:300px;bottom:${420 - 250 + 8}px;max-height:${250 - 16}px;`,
			true,
		);
		stop();
	});

	it("says whether the content is taller than the room it was given", () => {
		const fits = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 700, width: 24, height: 24 },
			listHeight: 300,
		});
		const crowded = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 400, width: 24, height: 24 },
			listHeight: 300,
		});
		const onFits = vi.fn();
		const onCrowded = vi.fn();

		// 302px of content, 480px allowed, 684px of room above: it fits.
		const stopFits = followAnchor({
			anchor: () => fits.anchor,
			popup: fits.popup,
			maxHeight: 480,
			onPlace: onFits,
		});
		// The same content with a cap of 260: it is taller than the room it is given.
		const stopCrowded = followAnchor({
			anchor: () => crowded.anchor,
			popup: crowded.popup,
			maxHeight: 260,
			onPlace: onCrowded,
		});

		expect(onFits.mock.lastCall?.[1]).toBe(false);
		expect(onCrowded.mock.lastCall?.[1]).toBe(true);
		stopFits();
		stopCrowded();
	});

	it("does nothing until the control exists, and places as soon as it does", () => {
		const { anchor, popup } = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 700, width: 24, height: 24 },
		});
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		let bound: HTMLElement | null = null;
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => bound,
			popup,
			maxHeight: 260,
			onPlace,
		});
		expect(onPlace).not.toHaveBeenCalled();

		bound = anchor;
		vi.advanceTimersToNextFrame();

		expect(onPlace).toHaveBeenCalledTimes(1);
		stop();
	});

	it("goes with its control when the control moves, with no event to say so", () => {
		const { state, anchor, popup } = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 700, width: 24, height: 24 },
		});
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		const onPlace = vi.fn();
		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 260,
			onPlace,
		});
		expect(onPlace).toHaveBeenCalledTimes(1);

		// A frame in which nothing moved asks nothing of the browser's layout.
		vi.advanceTimersToNextFrame();
		expect(onPlace).toHaveBeenCalledTimes(1);

		// The home page's composer glides, a pill grows: the control moves.
		state.anchor = { left: 340, top: 600, width: 24, height: 24 };
		vi.advanceTimersToNextFrame();

		expect(onPlace).toHaveBeenCalledTimes(2);
		expect(onPlace).toHaveBeenLastCalledWith(
			`left:340px;bottom:${768 - 600 + 8}px;max-height:260px;`,
			false,
		);
		stop();
	});

	it("goes with the window when it is resized", () => {
		const { anchor, popup } = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 700, width: 24, height: 24 },
		});
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		const onPlace = vi.fn();
		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 260,
			onPlace,
		});

		setWindow(1024, 900);
		vi.advanceTimersToNextFrame();

		expect(onPlace).toHaveBeenLastCalledWith(
			`left:300px;bottom:${900 - 700 + 8}px;max-height:260px;`,
			false,
		);
		stop();
	});

	it("is placed again when the popup itself changes size", () => {
		const { anchor, popup } = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 700, width: 24, height: 24 },
		});
		const observed: Element[] = [];
		let notify: () => void = () => {};
		class FakeResizeObserver {
			constructor(callback: () => void) {
				notify = callback;
			}
			observe(element: Element) {
				observed.push(element);
			}
			disconnect() {
				observed.length = 0;
			}
		}
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 260,
			onPlace,
		});
		expect(observed).toEqual([popup]);
		expect(onPlace).toHaveBeenCalledTimes(1);

		notify();
		expect(onPlace).toHaveBeenCalledTimes(2);

		stop();
		expect(observed).toEqual([]);
	});

	// The composer's command tray: as wide as the composer it opens from (less
	// a little), centred on it rather than starting at its left edge.
	it("takes its width from the control and stands centred on it when asked", () => {
		const { anchor, popup } = setUp({
			window: { width: 1280, height: 720 },
			anchor: { left: 278, top: 306, width: 772, height: 152 },
			listHeight: 200,
		});
		const onPlace = vi.fn();

		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 368,
			width: (rect) => Math.min(704, rect.width * 0.95),
			align: "center",
			onPlace,
		});

		// Set before the height is read: the list wraps at the width it gets.
		expect(popup.style.width).toBe("704px");
		expect(onPlace).toHaveBeenLastCalledWith(
			`width:704px;left:${278 + (772 - 704) / 2}px;bottom:${720 - 306 + 8}px;max-height:${306 - 16}px;`,
			false,
		);
		stop();
	});

	// It opens while the user types, so on a phone the keyboard is up: it
	// covers the bottom of the window without making the window any shorter.
	describe("measured against what is on screen", () => {
		function setVisible(offsetTop: number, height: number) {
			vi.stubGlobal("visualViewport", {
				offsetTop,
				offsetLeft: 0,
				height,
				width: 390,
			});
		}

		it("does not drop under the keyboard when the window says there is room there", () => {
			const { anchor, popup } = setUp({
				window: { width: 390, height: 844 },
				anchor: { left: 4, top: 150, width: 382, height: 138 },
				listHeight: 280,
			});
			const onWindow = vi.fn();
			const onScreen = vi.fn();

			// Without the option the 556px below the composer look free.
			const stopWindow = followAnchor({
				anchor: () => anchor,
				popup,
				maxHeight: 288,
				onPlace: onWindow,
			});
			expect(onWindow.mock.lastCall?.[0]).toContain(`top:${288 + 8}px;`);
			stopWindow();

			// The keyboard leaves 420px: 132 below the composer, 150 above.
			setVisible(0, 420);
			const stopScreen = followAnchor({
				anchor: () => anchor,
				popup,
				maxHeight: 288,
				visibleViewport: true,
				onPlace: onScreen,
			});
			expect(onScreen).toHaveBeenLastCalledWith(
				`left:16px;bottom:${844 - 150 + 8}px;max-height:${150 - 16}px;`,
				true,
			);
			stopScreen();
		});

		it("counts from the part of the window that is on screen", () => {
			// The browser scrolled the window 100px to keep the field in view.
			const { anchor, popup } = setUp({
				window: { width: 390, height: 844 },
				anchor: { left: 4, top: 250, width: 382, height: 138 },
				listHeight: 100,
			});
			setVisible(100, 420);
			const onPlace = vi.fn();

			const stop = followAnchor({
				anchor: () => anchor,
				popup,
				maxHeight: 288,
				visibleViewport: true,
				onPlace,
			});

			// 8px above the composer, in the window's own coordinates.
			expect(onPlace).toHaveBeenLastCalledWith(
				`left:16px;bottom:${844 - 250 + 8}px;max-height:${150 - 16}px;`,
				false,
			);
			stop();
		});

		it("is placed again when the keyboard comes or goes", () => {
			const { anchor, popup } = setUp({
				window: { width: 390, height: 844 },
				anchor: { left: 4, top: 150, width: 382, height: 138 },
				listHeight: 280,
			});
			vi.useFakeTimers({
				toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
			});
			setVisible(0, 844);
			const onPlace = vi.fn();
			const stop = followAnchor({
				anchor: () => anchor,
				popup,
				maxHeight: 288,
				visibleViewport: true,
				onPlace,
			});
			expect(onPlace.mock.lastCall?.[0]).toContain(`top:${288 + 8}px;`);

			setVisible(0, 420);
			vi.advanceTimersToNextFrame();

			expect(onPlace.mock.lastCall?.[0]).toContain(
				`bottom:${844 - 150 + 8}px;`,
			);
			stop();
		});
	});

	it("stops looking once it is stopped", () => {
		const { state, anchor, popup } = setUp({
			window: { width: 1024, height: 768 },
			anchor: { left: 300, top: 700, width: 24, height: 24 },
		});
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		const onPlace = vi.fn();
		const stop = followAnchor({
			anchor: () => anchor,
			popup,
			maxHeight: 260,
			onPlace,
		});

		stop();
		state.anchor = { left: 340, top: 600, width: 24, height: 24 };
		vi.advanceTimersToNextFrame();

		expect(onPlace).toHaveBeenCalledTimes(1);
	});
});
