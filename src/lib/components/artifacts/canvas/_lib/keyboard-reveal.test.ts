import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type { ScreenRect } from "./floating";
import {
	REVEAL_MARGIN,
	REVEAL_PAN_MS,
	REVEAL_SETTLE_MS,
	type RevealFlow,
	revealForm,
	revealPan,
	visibleRoom,
	watchKeyboardReveal,
} from "./keyboard-reveal";

const rect = (
	left: number,
	top: number,
	right: number,
	bottom: number,
): ScreenRect => ({ left, top, right, bottom });

/** A 390 x 400 pane at the top of a phone's page, 100 px down. */
const ROOM = rect(0, 100, 390, 500);
const M = REVEAL_MARGIN;

describe("visibleRoom", () => {
	it("is the pane where nothing else is known", () => {
		expect(visibleRoom(ROOM, null)).toEqual(ROOM);
	});

	it("is the pane where the visual viewport covers it (an Android keyboard shortens the page itself)", () => {
		const view = { offsetLeft: 0, offsetTop: 0, width: 390, height: 500 };
		expect(visibleRoom(ROOM, view)).toEqual(ROOM);
	});

	it("loses the part of the pane an overlaid keyboard covers (iOS shrinks the visual viewport only)", () => {
		const view = { offsetLeft: 0, offsetTop: 0, width: 390, height: 380 };
		expect(visibleRoom(ROOM, view)).toEqual(rect(0, 100, 390, 380));
	});

	it("loses what the page was scrolled away from, above and beside", () => {
		const view = { offsetLeft: 30, offsetTop: 160, width: 300, height: 250 };
		expect(visibleRoom(ROOM, view)).toEqual(rect(30, 160, 330, 410));
	});
});

describe("revealPan", () => {
	const field = rect(20, 300, 200, 330);

	it("moves nothing for a block that is in view, even right at the edge", () => {
		expect(revealPan(rect(20, 120, 200, 200), field, ROOM, null)).toEqual({
			x: 0,
			y: 0,
		});
		// Touching the room's top edge and a foot that is 60 px inside.
		expect(revealPan(rect(20, 100, 200, 440), field, ROOM, null)).toEqual({
			x: 0,
			y: 0,
		});
	});

	it("moves a block below the room up by the least distance that leaves the margin", () => {
		const block = rect(20, 440, 200, 560);
		const pan = revealPan(block, field, ROOM, null);
		expect(pan).toEqual({ x: 0, y: 500 - M - 560 });
		expect(block.bottom + pan.y).toBe(ROOM.bottom - M);
	});

	it("moves a block above the room down by the least distance that leaves the margin", () => {
		const pan = revealPan(rect(20, 70, 200, 150), field, ROOM, null);
		expect(pan).toEqual({ x: 0, y: 100 + M - 70 });
	});

	it("pans along x as well, and only as far as each axis needs", () => {
		const pan = revealPan(rect(300, 440, 440, 520), field, ROOM, null);
		expect(pan).toEqual({ x: 390 - M - 440, y: 500 - M - 520 });
		expect(revealPan(rect(-60, 200, 40, 260), field, ROOM, null)).toEqual({
			x: M + 60,
			y: 0,
		});
	});

	it("leaves exactly no margin when the margin is 0", () => {
		expect(revealPan(rect(20, 480, 200, 560), field, ROOM, null, 0)).toEqual({
			x: 0,
			y: -60,
		});
	});

	describe("the toolbar", () => {
		// A bar along the foot of the pane, 40 px up from its bottom edge.
		const bar = rect(10, 450, 380, 490);

		it("takes the foot of the room where it stands under the block", () => {
			const block = rect(20, 380, 200, 470);
			const pan = revealPan(block, field, ROOM, bar);
			expect(pan).toEqual({ x: 0, y: 450 - M - 470 });
			expect(block.bottom + pan.y).toBe(bar.top - M);
		});

		it("leaves a block that is above it where it is", () => {
			expect(revealPan(rect(20, 300, 200, 420), field, ROOM, bar)).toEqual({
				x: 0,
				y: 0,
			});
		});

		it("does not count a bar that is not under the block's columns", () => {
			const pill = rect(140, 450, 250, 490);
			expect(revealPan(rect(20, 400, 100, 480), field, ROOM, pill)).toEqual({
				x: 0,
				y: 0,
			});
			expect(revealPan(rect(120, 400, 200, 480), field, ROOM, pill)).toEqual({
				x: 0,
				y: 450 - M - 480,
			});
		});

		it("counts the columns the block will have once it has panned along x", () => {
			const pill = rect(150, 450, 250, 490);
			// Past the right edge of a narrower room, clear of the pill where it stands;
			// panned in, it is over the pill, so it also clears the pill's top.
			const room = rect(0, 100, 290, 500);
			const pan = revealPan(rect(260, 400, 340, 480), field, room, pill);
			expect(pan).toEqual({ x: 290 - M - 340, y: 450 - M - 480 });
		});

		it("is no obstacle where the keyboard has put it out of the visible part of the pane", () => {
			// An overlaid keyboard: the room ends at 380 and the bar is under the keyboard.
			const room = rect(0, 100, 390, 380);
			const pan = revealPan(rect(20, 330, 200, 420), field, room, bar);
			expect(pan).toEqual({ x: 0, y: 380 - M - 420 });
		});
	});

	describe("a block taller than the room", () => {
		const tall = rect(20, 150, 360, 900);

		it("brings in the field being typed in, whole", () => {
			const row = rect(30, 600, 350, 630);
			const pan = revealPan(tall, row, ROOM, null);
			expect(pan).toEqual({ x: 0, y: 500 - M - 630 });
		});

		it("keeps a field that is in view where it is", () => {
			expect(revealPan(tall, rect(30, 200, 350, 230), ROOM, null)).toEqual({
				x: 0,
				y: 0,
			});
		});

		it("does not count what the toolbar takes as room the block could use", () => {
			// 400 px of room, but the bar takes 60 of it: a block 340 tall would fit the room and does not fit what is left.
			const bar = rect(10, 440, 380, 490);
			const block = rect(20, 200, 360, 540);
			const row = rect(30, 480, 350, 510);
			const pan = revealPan(block, row, ROOM, bar);
			expect(pan).toEqual({ x: 0, y: 440 - M - 510 });
		});

		it("starts a field that is itself taller than the room at the top of it", () => {
			const field = rect(30, 300, 350, 800);
			expect(revealPan(tall, field, ROOM, null)).toEqual({
				x: 0,
				y: 100 + M - 300,
			});
		});

		it("leaves a field that already fills the room alone", () => {
			const field = rect(30, 60, 350, 800);
			expect(revealPan(tall, field, ROOM, null)).toEqual({ x: 0, y: 0 });
		});
	});

	it("takes the field when the block is wider than the room", () => {
		const wide = rect(-100, 200, 600, 260);
		const pan = revealPan(wide, rect(-90, 210, 380, 250), ROOM, null);
		expect(pan).toEqual({ x: M + 90, y: 0 });
	});
});

describe("revealPan with several things standing in the pane's foot", () => {
	const field = rect(30, 300, 350, 330);
	// The toolbar in the middle of the foot and the overview at its right end.
	const palette = rect(10, 450, 250, 490);
	const overview = rect(270, 380, 380, 450);
	const bars = [palette, overview];

	it("is the single toolbar's answer for a list of one", () => {
		const block = rect(20, 380, 200, 470);
		expect(revealPan(block, field, ROOM, [palette])).toEqual(
			revealPan(block, field, ROOM, palette),
		);
		expect(revealPan(block, field, ROOM, [])).toEqual(
			revealPan(block, field, ROOM, null),
		);
	});

	it("clears the one that stands under the block's columns, and only that one", () => {
		// Over the palette's columns: above the palette's top, as for the toolbar alone.
		const left = rect(20, 380, 200, 470);
		expect(revealPan(left, field, ROOM, bars)).toEqual({
			x: 0,
			y: palette.top - M - left.bottom,
		});
		// Over the overview's columns: above the overview, which stands higher.
		const right = rect(280, 300, 370, 440);
		expect(revealPan(right, field, ROOM, bars)).toEqual({
			x: 0,
			y: overview.top - M - right.bottom,
		});
	});

	it("is not held up by a bar the block is not over", () => {
		// Beside the overview and clear of the palette's top: in view, nothing to do.
		const beside = rect(20, 300, 200, 420);
		expect(revealPan(beside, field, ROOM, bars)).toEqual({ x: 0, y: 0 });
	});

	it("clears both when the block is over both", () => {
		const across = rect(100, 380, 340, 470);
		expect(revealPan(across, field, ROOM, bars)).toEqual({
			x: 0,
			y: overview.top - M - across.bottom,
		});
	});
});

describe("revealForm", () => {
	let root: HTMLElement;
	let node: HTMLElement;
	let form: HTMLElement;
	let buttons: HTMLElement;
	let paneRect: ScreenRect;
	let nodeRect: ScreenRect;
	let formRect: ScreenRect | null;
	let buttonsRect: ScreenRect;
	let paletteRect: ScreenRect;
	let overviewRect: ScreenRect | null;

	function place(element: Element, where: () => ScreenRect | null) {
		element.getBoundingClientRect = () => {
			const r = where() ?? rect(0, 0, 0, 0);
			return {
				...r,
				x: r.left,
				y: r.top,
				width: r.right - r.left,
				height: r.bottom - r.top,
				toJSON: () => r,
			};
		};
	}

	beforeEach(() => {
		root = document.createElement("div");
		root.className = "canvas-board";
		root.innerHTML = `
			<div class="canvas-toolbar"></div>
			<div class="svelte-flow__minimap"></div>
			<div class="svelte-flow__node"><form><div class="edit__actions"></div></form></div>`;
		document.body.append(root);
		node = root.querySelector(".svelte-flow__node") as HTMLElement;
		form = root.querySelector("form") as HTMLElement;
		buttons = root.querySelector(".edit__actions") as HTMLElement;
		paneRect = rect(500, 120, 1440, 900);
		paletteRect = rect(750, 843, 1180, 888);
		overviewRect = rect(1290, 758, 1424, 846);
		nodeRect = rect(560, 550, 990, 880);
		formRect = null;
		buttonsRect = rect(840, 840, 990, 870);
		place(root, () => paneRect);
		place(root.querySelector(".canvas-toolbar") as Element, () => paletteRect);
		place(
			root.querySelector(".svelte-flow__minimap") as Element,
			() => overviewRect,
		);
		place(node, () => nodeRect);
		// A form fills its block unless it lies over the block's content.
		place(form, () => formRect ?? nodeRect);
		place(buttons, () => buttonsRect);
	});

	afterEach(() => {
		root.remove();
		vi.unstubAllGlobals();
	});

	it("pans a block that runs under the toolbar up until it clears it, with the margin, and glides", () => {
		const pan = revealForm(form);
		expect(pan).toEqual({
			x: 0,
			y: paletteRect.top - M - nodeRect.bottom,
			ms: REVEAL_PAN_MS,
		});
	});

	it("says nothing about a form that is where it can be used", () => {
		nodeRect = rect(560, 200, 990, 520);
		buttonsRect = rect(840, 480, 990, 510);
		expect(revealForm(form)).toBeNull();
	});

	it("keeps the form clear of the overview where it stands under its columns", () => {
		nodeRect = rect(1000, 500, 1420, 860);
		buttonsRect = rect(1270, 830, 1420, 860);
		const pan = revealForm(form);
		expect(pan?.y).toBe(
			overviewRect ? overviewRect.top - M - nodeRect.bottom : 0,
		);
	});

	it("takes the form's buttons into view when the block is taller than the room that is left", () => {
		nodeRect = rect(560, 300, 990, 1500);
		buttonsRect = rect(840, 1400, 990, 1430);
		const pan = revealForm(form);
		expect(pan?.y).toBe(paletteRect.top - M - buttonsRect.bottom);
	});

	it("clears the form, not only the block, when the form lies over the block's content and reaches past it", () => {
		// A small block with its form over the top of it, taller than the block.
		nodeRect = rect(560, 700, 990, 780);
		formRect = rect(560, 700, 990, 860);
		buttonsRect = rect(840, 820, 990, 850);
		const pan = revealForm(form);
		expect(pan?.y).toBe(paletteRect.top - M - formRect.bottom);
	});

	it("glides for no time when the reader asked for reduced motion", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query.includes("prefers-reduced-motion"),
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}));
		expect(revealForm(form)?.ms).toBe(0);
	});

	it("is nothing outside a board", () => {
		const loose = document.createElement("form");
		expect(revealForm(loose)).toBeNull();
	});
});

describe("watchKeyboardReveal", () => {
	let root: HTMLElement;
	let block: HTMLElement;
	let field: HTMLTextAreaElement;
	let outside: HTMLTextAreaElement;
	let toolbar: HTMLElement;
	let flow: RevealFlow;
	let setViewport: Mock<RevealFlow["setViewport"]>;
	let paneRect: ScreenRect;
	let blockRect: ScreenRect;
	let fieldRect: ScreenRect;
	let toolbarRect: ScreenRect;
	let stop: () => void;
	let resized: () => void;
	let view:
		| (EventTarget & {
				offsetLeft: number;
				offsetTop: number;
				width: number;
				height: number;
		  })
		| null;

	const isField = (target: EventTarget | null) =>
		target instanceof HTMLTextAreaElement;

	function place(element: HTMLElement, where: () => ScreenRect) {
		element.getBoundingClientRect = () => {
			const r = where();
			return {
				...r,
				x: r.left,
				y: r.top,
				width: r.right - r.left,
				height: r.bottom - r.top,
				toJSON: () => r,
			};
		};
	}

	function focusIn(target: HTMLElement) {
		target.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
	}

	function focusOut(target: HTMLElement) {
		target.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
	}

	/** The pane's height changes (a keyboard comes or goes): the observer fires and the page holds still. */
	function paneIs(bottom: number) {
		paneRect = { ...paneRect, bottom };
		toolbarRect = rect(10, bottom - 56, 380, bottom - 12);
		resized();
		vi.advanceTimersByTime(REVEAL_SETTLE_MS + 1);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		root = document.createElement("div");
		root.innerHTML = `
			<div class="canvas-toolbar"></div>
			<div class="svelte-flow__node" data-id="note"><textarea class="inside"></textarea></div>
			<textarea class="outside"></textarea>`;
		document.body.append(root);
		block = root.querySelector(".svelte-flow__node") as HTMLElement;
		field = root.querySelector(".inside") as HTMLTextAreaElement;
		outside = root.querySelector(".outside") as HTMLTextAreaElement;
		toolbar = root.querySelector(".canvas-toolbar") as HTMLElement;
		paneRect = rect(0, 100, 390, 844);
		blockRect = rect(200, 600, 350, 650);
		fieldRect = rect(205, 605, 345, 645);
		toolbarRect = rect(10, 776, 380, 832);
		place(root, () => paneRect);
		place(block, () => blockRect);
		place(field, () => fieldRect);
		place(toolbar, () => toolbarRect);
		setViewport = vi.fn<RevealFlow["setViewport"]>();
		flow = { getViewport: () => ({ x: 10, y: 50, zoom: 0.74 }), setViewport };
		view = null;
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resized = callback;
				}
				observe() {}
				disconnect() {}
			},
		);
		Object.defineProperty(window, "visualViewport", {
			configurable: true,
			get: () => view,
		});
		stop = watchKeyboardReveal(root, flow, isField);
	});

	afterEach(() => {
		stop();
		root.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		Reflect.deleteProperty(window, "visualViewport");
	});

	it("pans a block the keyboard covers into view, by the least distance, with the zoom it has", () => {
		focusIn(field);
		vi.advanceTimersByTime(REVEAL_SETTLE_MS + 1);
		expect(setViewport).not.toHaveBeenCalled();

		paneIs(508);
		expect(setViewport).toHaveBeenCalledTimes(1);
		const [camera, options] = setViewport.mock.calls[0];
		// The toolbar's top is 452: the block's bottom goes to 452 - margin.
		expect(camera).toEqual({
			x: 10,
			y: 50 + (452 - REVEAL_MARGIN - 650),
			zoom: 0.74,
		});
		expect(options).toEqual({ duration: REVEAL_PAN_MS });
	});

	it("leaves a field alone that takes the focus when nothing around it is changing", () => {
		// The keyboard is up already (another note was being typed in), and this block is under the toolbar.
		paneRect = rect(0, 100, 390, 508);
		toolbarRect = rect(10, 452, 380, 496);
		focusIn(field);
		vi.advanceTimersByTime(REVEAL_SETTLE_MS * 3);
		expect(setViewport).not.toHaveBeenCalled();
	});

	it("waits for the keyboard before panning a block that was out of view when it took the focus", () => {
		// A note just inserted, to the left of what the pane shows: it is the keyboard that makes the pan.
		blockRect = rect(-146, 440, 2, 487);
		fieldRect = rect(-140, 446, -4, 481);
		focusIn(field);
		vi.advanceTimersByTime(REVEAL_SETTLE_MS * 3);
		expect(setViewport).not.toHaveBeenCalled();

		paneIs(508);
		expect(setViewport).toHaveBeenCalledTimes(1);
		const [camera] = setViewport.mock.calls[0];
		expect(camera.x).toBe(10 + (REVEAL_MARGIN + 146));
		expect(camera.y).toBe(50 + (452 - REVEAL_MARGIN - 487));
	});

	it("does nothing for a block that is still in view", () => {
		blockRect = rect(200, 200, 350, 250);
		fieldRect = rect(205, 205, 345, 245);
		focusIn(field);
		paneIs(508);
		expect(setViewport).not.toHaveBeenCalled();
	});

	it("waits for a keyboard that opens in steps and pans once, to where it ends", () => {
		focusIn(field);
		paneRect = { ...paneRect, bottom: 700 };
		toolbarRect = rect(10, 644, 380, 688);
		resized();
		vi.advanceTimersByTime(REVEAL_SETTLE_MS / 2);
		paneRect = { ...paneRect, bottom: 508 };
		toolbarRect = rect(10, 452, 380, 496);
		resized();
		vi.advanceTimersByTime(REVEAL_SETTLE_MS / 2);
		expect(setViewport).not.toHaveBeenCalled();
		vi.advanceTimersByTime(REVEAL_SETTLE_MS);
		expect(setViewport).toHaveBeenCalledTimes(1);
		expect(setViewport.mock.calls[0][0].y).toBe(
			50 + (452 - REVEAL_MARGIN - 650),
		);
	});

	it("pans once per focus: a taller keyboard after it is left alone", () => {
		focusIn(field);
		paneIs(508);
		expect(setViewport).toHaveBeenCalledTimes(1);
		blockRect = rect(200, 380, 350, 430);
		paneIs(420);
		expect(setViewport).toHaveBeenCalledTimes(1);
	});

	it("takes the next opening of the keyboard on the same field as a new one", () => {
		focusIn(field);
		paneIs(508);
		expect(setViewport).toHaveBeenCalledTimes(1);
		paneIs(844);
		expect(setViewport).toHaveBeenCalledTimes(1);
		blockRect = rect(200, 600, 350, 650);
		paneIs(508);
		expect(setViewport).toHaveBeenCalledTimes(2);
	});

	it("does not pan when the keyboard closes", () => {
		focusIn(field);
		paneIs(508);
		setViewport.mockClear();
		paneIs(844);
		expect(setViewport).not.toHaveBeenCalled();
	});

	it("stops watching a field that has lost the focus", () => {
		focusIn(field);
		focusOut(field);
		paneIs(508);
		expect(setViewport).not.toHaveBeenCalled();
	});

	it("takes a field that is not in a block, or is not a text field, for none of its business", () => {
		focusIn(outside);
		paneIs(508);
		expect(setViewport).not.toHaveBeenCalled();
		focusIn(block);
		paneIs(509);
		expect(setViewport).not.toHaveBeenCalled();
	});

	it("moves with no glide when the reader asked for reduced motion", () => {
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({ matches: query.includes("reduce"), media: query }) as MediaQueryList,
		);
		focusIn(field);
		paneIs(508);
		expect(setViewport.mock.calls[0][1]).toEqual({ duration: 0 });
	});

	it("reads a focus that was there before it was watching", () => {
		stop();
		field.focus();
		stop = watchKeyboardReveal(root, flow, isField);
		paneIs(508);
		expect(setViewport).toHaveBeenCalledTimes(1);
	});

	it("looks at the visual viewport too, which an overlaid keyboard shrinks and the page does not", () => {
		view = Object.assign(new EventTarget(), {
			offsetLeft: 0,
			offsetTop: 0,
			width: 390,
			height: 744,
		});
		stop();
		stop = watchKeyboardReveal(root, flow, isField);
		focusIn(field);
		vi.advanceTimersByTime(REVEAL_SETTLE_MS + 1);
		expect(setViewport).not.toHaveBeenCalled();

		view.height = 408;
		view.dispatchEvent(new Event("resize"));
		vi.advanceTimersByTime(REVEAL_SETTLE_MS + 1);
		expect(setViewport).toHaveBeenCalledTimes(1);
		// The room ends at 408; the bar is under the keyboard, so the block's foot goes to 408 - margin.
		expect(setViewport.mock.calls[0][0].y).toBe(
			50 + (408 - REVEAL_MARGIN - 650),
		);
	});

	it("lets go of everything when it is stopped", () => {
		stop();
		focusIn(field);
		paneIs(508);
		expect(setViewport).not.toHaveBeenCalled();
	});
});
