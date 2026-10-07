import { expect, type Page, test } from "@playwright/test";
import {
	type Camera,
	centreOf,
	expectCamera,
	openBoard,
	settledCamera,
} from "./artifact-canvas-helpers";

// A laptop's touchpad drives the board the way Figma's does (CV-C). The owner's
// walk: the board answered a two-finger scroll by zooming, so a laptop had no way
// to move around it but by dragging. The rule: a two-finger scroll pans (both
// axes); a pinch zooms about the pointer, in proportion to the gesture; a mouse
// wheel pans too, and Ctrl or Command with the wheel zooms; Shift turns a scroll
// across; over the board the page never scrolls and the browser's history swipe is
// not offered.
//
// Every gesture here is a real wheel event: `page.mouse.wheel` sends what the
// browser itself does for a two-finger scroll (deltaX, deltaY), and a pinch is the
// browser's own Control + wheel, which is also what Ctrl with a mouse's wheel is.
// Modifiers are held with the keyboard, as a reader holds them.

type Point = { x: number; y: number };

// The owner's laptop is a Mac, and the flow library branches on it (the zoom key,
// how a pinch is scaled, where Shift turns a scroll), so the gestures run as a Mac
// sends them; the keys that differ between systems run again as Windows and Linux do
// (Playwright's own Desktop Chrome says Windows).
const MAC_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36";

/** A point of the pane with no block or layer on it, checked rather than assumed (in whole pixels: that is what a pointer event reports). */
async function ground(page: Page): Promise<Point> {
	const pane = await page.locator(".svelte-flow__pane").boundingBox();
	if (!pane) throw new Error("no pane");
	const point = {
		x: Math.round(pane.x + pane.width - 90),
		y: Math.round(pane.y + 90),
	};
	const element = await page.evaluate(
		({ x, y }) => document.elementFromPoint(x, y)?.className ?? "",
		point,
	);
	if (!String(element).includes("svelte-flow__pane")) {
		throw new Error(`the pane's top right corner is not empty ground: ${element}`);
	}
	return point;
}

/** One wheel event with the pointer where it says and the keys held for as long as it lasts. */
async function wheel(
	page: Page,
	at: Point,
	delta: { x?: number; y?: number },
	hold: string[] = [],
) {
	await page.mouse.move(at.x, at.y);
	for (const key of hold) await page.keyboard.down(key);
	await page.mouse.wheel(delta.x ?? 0, delta.y ?? 0);
	for (const key of [...hold].reverse()) await page.keyboard.up(key);
}

/** Where the board point under a screen point is, so a test can say "the pointer's point did not move". */
async function boardPointAt(page: Page, at: Point, camera: Camera) {
	const pane = await page.locator(".svelte-flow__pane").boundingBox();
	if (!pane) throw new Error("no pane");
	return {
		x: (at.x - pane.x - camera.x) / camera.zoom,
		y: (at.y - pane.y - camera.y) / camera.zoom,
	};
}

/** A mouse wheel's notch pans, and Shift turns it across. */
async function notchAndShift(page: Page) {
	await openBoard(page, "Wheel notch");
	const at = await ground(page);
	const start = await settledCamera(page);

	await wheel(page, at, { y: 100 });
	const down = await settledCamera(page);
	expectCamera(down, { ...start, y: start.y - 100 }, "one notch");

	// Shift with the wheel's vertical notch: across.
	await wheel(page, at, { y: 80 }, ["Shift"]);
	const across = await settledCamera(page);
	expectCamera(across, { ...down, x: down.x - 80 }, "Shift and a notch");

	// A system that already turned it (the event says deltaX): the same, not twice.
	await wheel(page, at, { x: 40 }, ["Shift"]);
	const already = await settledCamera(page);
	expectCamera(already, { ...across, x: across.x - 40 }, "Shift, already across");
}

/** Control and Command with the wheel zoom, a notch of it by one bounded step, about the pointer. */
async function modifierWheelZooms(page: Page) {
	await openBoard(page, "Modifier wheel");
	const at = await ground(page);
	const start = await settledCamera(page);

	// A mouse's notch is a hundred pixels: a step of about a tenth, not a jump to the limit.
	await wheel(page, at, { y: -100 }, ["Control"]);
	const control = await settledCamera(page);
	expect(control.zoom / start.zoom).toBeGreaterThan(1.05);
	expect(control.zoom / start.zoom).toBeLessThan(1.3);

	await wheel(page, at, { y: 100 }, ["Control"]);
	const back = await settledCamera(page);
	expect(back.zoom).toBeCloseTo(start.zoom, 2);

	await wheel(page, at, { y: -100 }, ["Meta"]);
	const command = await settledCamera(page);
	expect(command.zoom / start.zoom).toBeGreaterThan(1.05);
	expect(command.zoom / start.zoom).toBeLessThan(1.3);
	// Zooming is not panning: the point under the pointer stays.
	const pointAt = await boardPointAt(page, at, start);
	const stays = await boardPointAt(page, at, command);
	expect(stays.x).toBeCloseTo(pointAt.x, 1);
	expect(stays.y).toBeCloseTo(pointAt.y, 1);
}

test.describe("a laptop's touchpad and a mouse wheel on a board", () => {
	test.use({ userAgent: MAC_UA });

	test("a two-finger scroll pans the board in both axes, over the ground and over a block, and never zooms", async ({
		page,
	}) => {
		await openBoard(page, "Two fingers");
		const at = await ground(page);
		const start = await settledCamera(page);

		await wheel(page, at, { x: 60, y: 90 });
		const moved = await settledCamera(page);
		expectCamera(moved, { ...start, x: start.x - 60, y: start.y - 90 }, "down and right");

		await wheel(page, at, { x: -25, y: -40 });
		const back = await settledCamera(page);
		expectCamera(back, { ...moved, x: moved.x + 25, y: moved.y + 40 }, "up and left");

		// A touchpad's gesture is many small events: they add up, none of them zooms.
		for (let step = 0; step < 6; step++) await wheel(page, at, { x: 2, y: 3 });
		const small = await settledCamera(page);
		expectCamera(small, { ...back, x: back.x - 12, y: back.y - 18 }, "small steps");

		// Over a block it is the same: the block does not keep the wheel for itself.
		const over = await centreOf(page, "note-2");
		await wheel(page, over, { y: 50 });
		const overBlock = await settledCamera(page);
		expectCamera(overBlock, { ...small, y: small.y - 50 }, "over a block");
	});

	test("a mouse wheel's notch pans too, and Shift turns it across", async ({
		page,
	}) => {
		await notchAndShift(page);
	});

	test("a pinch zooms about the pointer, in proportion to the gesture", async ({
		page,
	}) => {
		await openBoard(page, "Pinch");
		const at = await ground(page);
		const start = await settledCamera(page);
		const pointAt = await boardPointAt(page, at, start);

		// Fingers apart: zoom in, and the point under the pointer stays under it.
		await wheel(page, at, { y: -8 }, ["Control"]);
		const closer = await settledCamera(page);
		expect(closer.zoom).toBeGreaterThan(start.zoom * 1.05);
		expect(closer.zoom).toBeLessThan(start.zoom * 1.25);
		const stays = await boardPointAt(page, at, closer);
		expect(stays.x).toBeCloseTo(pointAt.x, 1);
		expect(stays.y).toBeCloseTo(pointAt.y, 1);

		// Fingers together: zoom out, about the same point.
		await wheel(page, at, { y: 8 }, ["Control"]);
		const apart = await settledCamera(page);
		expect(apart.zoom).toBeCloseTo(start.zoom, 3);
		expect(apart.x).toBeCloseTo(start.x, 1);
		expect(apart.y).toBeCloseTo(start.y, 1);

		// Smooth: ten small events of a pinch zoom as far as one ten times as big, not in coarse steps.
		for (let step = 0; step < 10; step++) await wheel(page, at, { y: -1 }, ["Control"]);
		const small = await settledCamera(page);
		await wheel(page, at, { y: 10 }, ["Control"]);
		const undone = await settledCamera(page);
		expect(small.zoom).toBeGreaterThan(start.zoom * 1.05);
		expect(undone.zoom).toBeCloseTo(start.zoom, 2);
	});

	test("Control and Command with the wheel zoom, and a notch of it is one bounded step", async ({
		page,
	}) => {
		await modifierWheelZooms(page);
	});

	test("a pinch is one gesture to the board: the blocks' handles are sized once, where it ends", async ({
		page,
	}) => {
		await openBoard(page, "One gesture");
		const at = await ground(page);
		await settledCamera(page);
		const board = page.getByTestId("canvas-board");
		const sized = () =>
			board.evaluate((element) =>
				element.style.getPropertyValue("--canvas-inv-zoom"),
			);
		const before = Number(await sized());

		// The board's own record of the camera coming to rest is the style it sizes handles from.
		await board.evaluate((element) => {
			const seen: string[] = [];
			(element as unknown as { __sizes: string[] }).__sizes = seen;
			new MutationObserver(() =>
				seen.push(element.style.getPropertyValue("--canvas-inv-zoom")),
			).observe(element, { attributes: true, attributeFilter: ["style"] });
		});
		// Thirty events a few milliseconds apart: a whole pinch, and a long scroll beside it.
		await page.mouse.move(at.x, at.y);
		await page.keyboard.down("Control");
		for (let step = 0; step < 30; step++) await page.mouse.wheel(0, -4);
		await page.keyboard.up("Control");
		for (let step = 0; step < 30; step++) await page.mouse.wheel(3, 5);

		const camera = await settledCamera(page);
		await expect.poll(sized).not.toBe(String(before));
		const sizes = await board.evaluate(
			(element) => (element as unknown as { __sizes: string[] }).__sizes,
		);
		expect(sizes.length).toBeLessThanOrEqual(2);
		expect(Number(await sized())).toBeCloseTo(1 / camera.zoom, 3);
	});

	test("the zoom stops at its limits and the camera stays where it is there", async ({
		page,
	}) => {
		await openBoard(page, "Limits");
		const at = await ground(page);
		await settledCamera(page);

		for (let step = 0; step < 40; step++) {
			await wheel(page, at, { y: -100 }, ["Control"]);
		}
		const closest = await settledCamera(page);
		expect(closest.zoom).toBeCloseTo(2, 3);
		const point = await boardPointAt(page, at, closest);

		await wheel(page, at, { y: -100 }, ["Control"]);
		const still = await settledCamera(page);
		expectCamera(still, closest, "at the closest zoom");
		expect((await boardPointAt(page, at, still)).x).toBeCloseTo(point.x, 1);

		for (let step = 0; step < 60; step++) {
			await wheel(page, at, { y: 100 }, ["Control"]);
		}
		const farthest = await settledCamera(page);
		expect(farthest.zoom).toBeCloseTo(0.2, 3);
	});

	test("over the board the page never scrolls and the browser's history swipe is not offered", async ({
		page,
	}) => {
		await openBoard(page, "Page stays");
		const at = await ground(page);
		await settledCamera(page);

		// Every wheel event the board gets reaches the window already cancelled: the
		// browser has nothing left to do with it, which is what a history swipe,
		// a page zoom and a scroll all need.
		// (Looked at once the whole dispatch is over: the library stops the event
		// from reaching anyone after it, so a listener further up never hears it.)
		await page.evaluate(() => {
			const seen: boolean[] = [];
			(window as unknown as { __wheelsCancelled: boolean[] }).__wheelsCancelled =
				seen;
			window.addEventListener(
				"wheel",
				(event) => setTimeout(() => seen.push(event.defaultPrevented), 0),
				{ capture: true, passive: true },
			);
		});
		await wheel(page, at, { y: 120 });
		await wheel(page, at, { x: -90 });
		await wheel(page, at, { y: -6 }, ["Control"]);
		await wheel(page, at, { y: 60 }, ["Meta"]);
		await wheel(page, at, { y: 60 }, ["Shift"]);
		const over = await centreOf(page, "note-3");
		await wheel(page, over, { x: 50, y: 50 });
		await wheel(page, over, { y: -6 }, ["Control"]);
		// A pinch over the board's own chrome, off the pane: the page does not zoom there either.
		const toolbar = await page.getByTestId("canvas-toolbar").boundingBox();
		if (!toolbar) throw new Error("no toolbar");
		await wheel(
			page,
			{
				x: Math.round(toolbar.x + toolbar.width / 2),
				y: Math.round(toolbar.y + toolbar.height / 2),
			},
			{ y: -6 },
			["Control"],
		);
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(window as unknown as { __wheelsCancelled: boolean[] })
							.__wheelsCancelled,
				),
			)
			.toEqual(Array.from({ length: 8 }, () => true));

		// And what is scrolled inside the board does not carry on out of it.
		const board = page.getByTestId("canvas-board");
		await expect(board).toHaveCSS("overscroll-behavior-x", "none");
		await expect(board).toHaveCSS("overscroll-behavior-y", "none");
		expect(
			await page.evaluate(() => [
				document.scrollingElement?.scrollTop,
				document.scrollingElement?.scrollLeft,
			]),
		).toEqual([0, 0]);
	});

	test("Space and a drag, and the Hand tool, still pan; the wheel does not change what a drag does", async ({
		page,
	}) => {
		await openBoard(page, "Drags stay");
		const at = await ground(page);
		const start = await settledCamera(page);

		// Space and a drag on the ground.
		await page.mouse.move(at.x, at.y);
		await page.keyboard.down("Space");
		await page.mouse.down();
		await page.mouse.move(at.x - 70, at.y + 35, { steps: 8 });
		await page.mouse.up();
		await page.keyboard.up("Space");
		const dragged = await settledCamera(page);
		expectCamera(dragged, { ...start, x: start.x - 70, y: start.y + 35 }, "Space and a drag");

		// The Hand tool: a plain drag pans, and the wheel still pans beside it.
		await page.getByTestId("canvas-tool-pan").click();
		await page.mouse.move(at.x, at.y);
		await page.mouse.down();
		await page.mouse.move(at.x + 40, at.y - 20, { steps: 8 });
		await page.mouse.up();
		const hand = await settledCamera(page);
		expectCamera(hand, { ...dragged, x: dragged.x + 40, y: dragged.y - 20 }, "the Hand tool");
		await wheel(page, at, { y: 30 });
		expectCamera(
			await settledCamera(page),
			{ ...hand, y: hand.y - 30 },
			"the wheel with the Hand tool",
		);
	});
});

test.describe("the same wheel on Windows and Linux", () => {
	test("a mouse wheel's notch pans too, and Shift turns it across", async ({
		page,
	}) => {
		await notchAndShift(page);
	});

	test("Control and Command with the wheel zoom, and a notch of it is one bounded step", async ({
		page,
	}) => {
		await modifierWheelZooms(page);
	});
});
