import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	cameraOf,
	centreOf,
	expectCamera,
	KEYBOARD,
	openBoard,
	PHONE,
	placeInPane,
	settledCamera,
} from "./artifact-canvas-helpers";

// The block a reader types in stays in view when the on-screen keyboard opens
// (TR-D4). TR-D3 made a board stop moving at the reader's first touch, which
// leaves a note lower than the keyboard's top edge behind the keyboard: with
// `interactive-widget=resizes-content` (app.html) the keyboard shortens the page,
// and the browser cannot scroll the note into view (the flow library undoes its
// wrapper's scroll). So the camera pans, by the least distance, once. Every flow
// here is real input: a finger's taps, a mouse, keys, the wheel; the keyboard is the
// viewport shrinking the way it does on Android.

const SHORT = { width: PHONE.width, height: PHONE.height - KEYBOARD };
const BLOCK = (id: string) => `.svelte-flow__node[data-id="${id}"]`;

/** A finger double-taps a note to type in it: its field has the focus. */
async function openForTyping(page: Page, id: string): Promise<Locator> {
	const at = await centreOf(page, id);
	await page.touchscreen.tap(at.x, at.y);
	await page.touchscreen.tap(at.x, at.y);
	const field = page.locator(`${BLOCK(id)} textarea`);
	await expect(field).toBeFocused();
	return field;
}

/** Whether the reader sees all of every one of these: inside the pane, above the board's toolbar. */
async function inView(page: Page, ...parts: Locator[]): Promise<boolean> {
	const pane = await page.getByTestId("canvas-board").boundingBox();
	const toolbar = await page.getByTestId("canvas-toolbar").boundingBox();
	if (!pane || !toolbar) return false;
	for (const part of parts) {
		const box = await part.boundingBox();
		if (
			!box ||
			box.x < pane.x ||
			box.y < pane.y ||
			box.x + box.width > pane.x + pane.width ||
			box.y + box.height > toolbar.y
		) {
			return false;
		}
	}
	return true;
}

/** How far above the toolbar's top edge a part ends. */
async function clearance(page: Page, part: Locator): Promise<number> {
	const toolbar = await page.getByTestId("canvas-toolbar").boundingBox();
	const box = await part.boundingBox();
	if (!toolbar || !box) throw new Error("nothing to measure");
	return toolbar.y - (box.y + box.height);
}

/** A checklist of sixteen rows: a block taller than what a phone shows above its keyboard. */
function longList(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "list",
				type: "checklist" as const,
				position: { x: 0, y: 0 },
				width: 340,
				data: {
					kind: "checklist" as const,
					items: Array.from({ length: 16 }, (_, index) => ({
						id: `item-${index + 1}`,
						text: `Item ${index + 1}`,
						done: false,
					})),
				},
			},
		],
		edges: [],
		// A camera of its own, so that the list stays where it is put (a board with a stored camera is not fitted).
		viewport: { x: 24, y: 16, zoom: 0.8 },
		annotations: [],
	};
}

/** Starts writing down the camera's y at every frame; `read` says every different value it had. */
async function watchCameraY(page: Page) {
	await page.evaluate(() => {
		const seen: number[] = [];
		(window as unknown as { __cameraY: number[] }).__cameraY = seen;
		const frame = () => {
			const match = /translate\(-?[\d.]+px,\s*(-?[\d.]+)px\)/.exec(
				document.querySelector<HTMLElement>(".svelte-flow__viewport")?.style
					.transform ?? "",
			);
			const y = match ? Number(match[1]) : null;
			if (y !== null && seen[seen.length - 1] !== y) seen.push(y);
			requestAnimationFrame(frame);
		};
		frame();
	});
	return () =>
		page.evaluate(
			() => (window as unknown as { __cameraY: number[] }).__cameraY,
		);
}

test.describe("on a phone, when the keyboard opens over the note being typed in", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test("the lowest note is panned up above the toolbar, by the least distance and never zoomed", async ({
		page,
	}) => {
		await openBoard(page, "Lowest note");
		const fitted = await settledCamera(page);
		const field = await openForTyping(page, "note-6");
		const note = page.locator(BLOCK("note-6"));
		expectCamera(await settledCamera(page), fitted, "before the keyboard");
		expect(await inView(page, note)).toBe(true);

		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, note, field)).toBe(true);
		const typing = await settledCamera(page);
		expect(typing.zoom).toBeCloseTo(fitted.zoom, 3);
		expect(typing.x).toBeCloseTo(fitted.x, 1);
		expect(typing.y).toBeLessThan(fitted.y);
		// A small margin, not a note flung to the top: the least distance.
		const gap = await clearance(page, note);
		expect(gap).toBeGreaterThanOrEqual(8);
		expect(gap).toBeLessThanOrEqual(24);

		// What they type is where they can see it, and the board does not move for it.
		await page.keyboard.type(" and more");
		await expect(field).toHaveValue("Note 6 and more");
		expectCamera(await settledCamera(page), typing, "while typing");
		const placed = await placeInPane(page, "note-6");

		// The keyboard goes: the camera stays and nothing jumps.
		await page.setViewportSize(PHONE);
		expectCamera(await settledCamera(page), typing, "with the keyboard closed");
		const after = await placeInPane(page, "note-6");
		expect(after.x).toBeCloseTo(placed.x, 1);
		expect(after.y).toBeCloseTo(placed.y, 1);
	});

	test("a note in the row the toolbar sits over is lifted clear of it", async ({
		page,
	}) => {
		await openBoard(page, "Row under the toolbar");
		const fitted = await settledCamera(page);
		const field = await openForTyping(page, "note-4");
		const note = page.locator(BLOCK("note-4"));

		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, note, field)).toBe(true);
		const typing = await settledCamera(page);
		expect(typing.zoom).toBeCloseTo(fitted.zoom, 3);
		expect(typing.x).toBeCloseTo(fitted.x, 1);
		const gap = await clearance(page, note);
		expect(gap).toBeGreaterThanOrEqual(8);
		expect(gap).toBeLessThanOrEqual(24);
	});

	test("a keyboard that opens in two steps gets one pan, to where it ends", async ({
		page,
	}) => {
		await openBoard(page, "Two steps");
		const fitted = await settledCamera(page);
		const field = await openForTyping(page, "note-6");
		const note = page.locator(BLOCK("note-6"));
		const read = await watchCameraY(page);

		await page.setViewportSize({ width: PHONE.width, height: 700 });
		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, note, field)).toBe(true);
		const typing = await settledCamera(page);
		expect(typing.zoom).toBeCloseTo(fitted.zoom, 3);
		const gap = await clearance(page, note);
		expect(gap).toBeGreaterThanOrEqual(8);
		expect(gap).toBeLessThanOrEqual(24);

		// One glide from where the board was to where it is: never up and back.
		const ys = await read();
		expect(ys[0]).toBeCloseTo(fitted.y, 1);
		expect(ys[ys.length - 1]).toBeCloseTo(typing.y, 1);
		expect(ys.every((y, at) => at === 0 || y <= ys[at - 1])).toBe(true);
	});

	test("a pan happens once per focus: a taller keyboard after it is the reader's to deal with", async ({
		page,
	}) => {
		await openBoard(page, "Once");
		const field = await openForTyping(page, "note-6");
		const note = page.locator(BLOCK("note-6"));

		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, note, field)).toBe(true);
		const revealed = await settledCamera(page);

		// The reader zooms the board with the wheel (the field keeps the focus):
		// the camera is theirs, and a keyboard that grows is not met with a pan.
		const pane = await page.getByTestId("canvas-board").boundingBox();
		if (!pane) throw new Error("no board");
		await page.mouse.move(pane.x + 40, pane.y + 60);
		await page.mouse.wheel(0, -120);
		const zoomed = await settledCamera(page);
		expect(zoomed.zoom).not.toBeCloseTo(revealed.zoom, 2);
		await expect(field).toBeFocused();

		await page.setViewportSize({
			width: PHONE.width,
			height: PHONE.height - KEYBOARD - 60,
		});
		await page.waitForTimeout(600);
		expectCamera(await settledCamera(page), zoomed, "a taller keyboard");
	});

	test("a block taller than the room has the field being typed in revealed", async ({
		page,
	}) => {
		await openBoard(page, "Long list", longList());
		const fitted = await settledCamera(page);
		const row = page.locator(`${BLOCK("list")} input[type="text"]`).nth(13);
		await row.tap();
		await expect(row).toBeFocused();
		expect(await inView(page, row)).toBe(true);

		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, row)).toBe(true);
		const typing = await settledCamera(page);
		expect(typing.zoom).toBeCloseTo(fitted.zoom, 3);
		// The list cannot fit above the keyboard: it is the row that is brought in.
		expect(await inView(page, page.locator(BLOCK("list")))).toBe(false);
		const gap = await clearance(page, row);
		expect(gap).toBeGreaterThanOrEqual(8);
		expect(gap).toBeLessThanOrEqual(24);
		await page.keyboard.type(" done");
		await expect(row).toHaveValue("Item 14 done");
	});

	test("a note inserted from the toolbar, open for typing, is brought in whole, and the board does not zoom for the keyboard", async ({
		page,
	}) => {
		await openBoard(page, "Insert");
		const fitted = await settledCamera(page);
		await page.getByTestId("canvas-insert-button").tap();
		await page.getByTestId("canvas-insert-sticky").tap();
		const field = page.locator(".svelte-flow__node textarea");
		await expect(field).toBeFocused();
		const note = page.locator(".svelte-flow__node.selected");
		// The note is made where there was room, which is not all of it on screen.
		expectCamera(await settledCamera(page), fitted, "after the insert");

		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, note, field)).toBe(true);
		expect((await settledCamera(page)).zoom).toBeCloseTo(fitted.zoom, 3);
		await page.keyboard.type("Pack the tickets");
		await expect(field).toHaveValue("Pack the tickets");
	});
});

test.describe("on a phone, with motion", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test("the pan is a short glide over several frames", async ({ page }) => {
		await openBoard(page, "Glide");
		await settledCamera(page);
		const field = await openForTyping(page, "note-6");
		const read = await watchCameraY(page);

		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, field)).toBe(true);
		await settledCamera(page);
		const ys = await read();
		expect(ys.length).toBeGreaterThan(4);
	});
});

test.describe("on a phone, asked for reduced motion", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test("the pan is instant: the camera is at its place in one step", async ({
		page,
	}) => {
		await openBoard(page, "Instant");
		await page.emulateMedia({ reducedMotion: "reduce" });
		const fitted = await settledCamera(page);
		const field = await openForTyping(page, "note-6");
		const note = page.locator(BLOCK("note-6"));
		const read = await watchCameraY(page);

		await page.setViewportSize(SHORT);
		await expect.poll(() => inView(page, note, field)).toBe(true);
		const typing = await settledCamera(page);
		expect(typing.y).toBeLessThan(fitted.y);
		const ys = await read();
		expect(ys).toHaveLength(2);
	});
});

test.describe("on a desktop", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("nothing pans when the window shrinks over the note being typed in", async ({
		page,
	}) => {
		await openBoard(page, "Desktop");
		const fitted = await settledCamera(page);
		const at = await centreOf(page, "note-6");
		await page.mouse.dblclick(at.x, at.y);
		const field = page.locator(`${BLOCK("note-6")} textarea`);
		await expect(field).toBeFocused();

		await page.setViewportSize({ width: 1180, height: 640 });
		await page.waitForTimeout(800);
		// The window is now over the note, and the camera is where it was.
		expect(await inView(page, page.locator(BLOCK("note-6")))).toBe(false);
		expectCamera(await settledCamera(page), fitted, "window smaller");
		expect(await cameraOf(page)).toEqual(await settledCamera(page));
	});
});
