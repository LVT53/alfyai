import { expect, type Page, test } from "@playwright/test";
import {
	centreOf,
	expectCamera,
	KEYBOARD,
	openBoard,
	PAN_WAIT_MS,
	PHONE,
	placeInPane,
	settledCamera,
} from "./artifact-canvas-helpers";

// A board follows its pane only until the reader touches it (TR-D3). TR-D1 made
// a board fit itself again whenever its pane changes size, while the camera was
// still where the last fit left it, so a tour card arriving never leaves it
// mis-framed. The camera was only "the reader's" once they panned or zoomed, so a
// reader who tapped a note to type (and so opened the on-screen keyboard, which
// resizes the page on Android Chrome) or clicked a block on a desktop had the
// board zoom and move under them as the pane changed. Every flow here is real
// input: a finger's tap, a mouse click, keys; the keyboard is the viewport
// shrinking the way it does on the phone. (What the keyboard does to a note it
// covers is `artifact-canvas-keyboard.spec.ts`'s.)

/** Presses Tab until the focus is on something `selector` matches (how a keyboard reader gets to a block). */
async function tabTo(page: Page, selector: string, limit = 40) {
	for (let press = 0; press < limit; press++) {
		await page.keyboard.press("Tab");
		const there = await page.evaluate(
			(match) => document.activeElement?.matches(match) ?? false,
			selector,
		);
		if (there) return;
	}
	throw new Error(`Tab never reached ${selector} in ${limit} presses`);
}

test.describe("on a phone, when the on-screen keyboard comes and goes", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test("a board the reader tapped a note on to type stays where it is", async ({
		page,
	}) => {
		await openBoard(page, "Keyboard");
		const fitted = await settledCamera(page);
		// A note in the top row: the keyboard leaves it in view, so nothing needs to move.
		const note = await placeInPane(page, "note-2");

		// A finger double-taps a note to type in it, without panning first.
		const at = await centreOf(page, "note-2");
		await page.touchscreen.tap(at.x, at.y);
		await page.touchscreen.tap(at.x, at.y);
		const field = page.locator('.svelte-flow__node[data-id="note-2"] textarea');
		await expect(field).toBeFocused();

		// The keyboard opens: the page is shorter by what it takes.
		await page.setViewportSize({
			width: PHONE.width,
			height: PHONE.height - KEYBOARD,
		});
		await page.waitForTimeout(PAN_WAIT_MS);
		expectCamera(await settledCamera(page), fitted, "with the keyboard open");
		const typing = await placeInPane(page, "note-2");
		expect(typing.x).toBeCloseTo(note.x, 1);
		expect(typing.y).toBeCloseTo(note.y, 1);

		await page.keyboard.type(" and more");
		await expect(field).toHaveValue("Note 2 and more");
		expectCamera(await settledCamera(page), fitted, "while typing");

		// The keyboard goes: the board is where the reader left it.
		await page.setViewportSize(PHONE);
		expectCamera(await settledCamera(page), fitted, "with the keyboard closed");
		const after = await placeInPane(page, "note-2");
		expect(after.x).toBeCloseTo(note.x, 1);
		expect(after.y).toBeCloseTo(note.y, 1);
	});

	test("a tap on the empty ground, without a pan, is the reader's too", async ({
		page,
	}) => {
		await openBoard(page, "Empty ground");
		const fitted = await settledCamera(page);
		const pane = await page.getByTestId("canvas-board").boundingBox();
		if (!pane) throw new Error("no board");

		// Nothing under the finger: the right margin the fit leaves clear.
		await page.touchscreen.tap(pane.x + pane.width - 8, pane.y + 120);
		await page.setViewportSize({
			width: PHONE.width,
			height: PHONE.height - KEYBOARD,
		});
		expectCamera(await settledCamera(page), fitted, "pane shorter");
		await page.setViewportSize(PHONE);
		expectCamera(await settledCamera(page), fitted, "pane back");
	});

	test("a board nobody has touched still follows its pane, which is what a tour card needs", async ({
		page,
	}) => {
		await openBoard(page, "Untouched");
		const fitted = await settledCamera(page);

		await page.setViewportSize({
			width: PHONE.width,
			height: PHONE.height - KEYBOARD,
		});
		await expect
			.poll(async () => (await settledCamera(page)).zoom)
			.toBeLessThan(fitted.zoom);
		await page.setViewportSize(PHONE);
		expectCamera(await settledCamera(page), fitted, "back at full height");
	});
});

test.describe("on a desktop, when the window changes size", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("a board follows the window until the reader clicks a block, and not after", async ({
		page,
	}) => {
		await openBoard(page, "Window");
		const fitted = await settledCamera(page);

		// Nobody has touched it: it is fitted again to the window it has.
		await page.setViewportSize({ width: 1180, height: 640 });
		await expect
			.poll(async () => (await settledCamera(page)).zoom)
			.toBeLessThan(fitted.zoom);
		await page.setViewportSize({ width: 1440, height: 900 });
		expectCamera(await settledCamera(page), fitted, "back at 1440 x 900");

		// A click on a block is the reader's first touch, though it moves nothing.
		const note = await placeInPane(page, "note-4");
		const at = await centreOf(page, "note-4");
		await page.mouse.click(at.x, at.y);
		await expect(
			page.locator('.svelte-flow__node[data-id="note-4"]'),
		).toHaveClass(/selected/);

		await page.setViewportSize({ width: 1180, height: 640 });
		expectCamera(await settledCamera(page), fitted, "window smaller");
		const smaller = await placeInPane(page, "note-4");
		expect(smaller.x).toBeCloseTo(note.x, 1);
		expect(smaller.y).toBeCloseTo(note.y, 1);

		await page.setViewportSize({ width: 1440, height: 900 });
		expectCamera(await settledCamera(page), fitted, "window back");
	});

	test("a reader who only uses the keyboard has not got a board that moves either", async ({
		page,
	}) => {
		await openBoard(page, "Keys");
		const fitted = await settledCamera(page);

		// From the panel's title, Tab goes through the toolbar to the first note;
		// Enter opens it for typing. No pointer touches the board.
		await page.getByRole("heading", { name: "Weekend board" }).click();
		await tabTo(page, ".svelte-flow__node");
		await page.keyboard.press("Enter");
		const field = page.locator(".svelte-flow__node textarea");
		await expect(field).toBeFocused();

		await page.setViewportSize({ width: 1180, height: 640 });
		expectCamera(await settledCamera(page), fitted, "window smaller");
		await page.keyboard.type(" typed");
		await expect(field).toHaveValue("Note 1 typed");
		await page.setViewportSize({ width: 1440, height: 900 });
		expectCamera(await settledCamera(page), fitted, "window back");
	});

	test("the Fit button hands the camera back to the window until the next touch", async ({
		page,
	}) => {
		await openBoard(page, "Fit");
		const fitted = await settledCamera(page);

		const at = await centreOf(page, "note-2");
		await page.mouse.click(at.x, at.y);
		await page.setViewportSize({ width: 1180, height: 640 });
		expectCamera(await settledCamera(page), fitted, "touched, window smaller");

		// Fit fits the board to the window it is in now...
		await page.getByTestId("canvas-fit").click();
		const fitSmaller = await settledCamera(page);
		expect(fitSmaller.zoom).toBeLessThan(fitted.zoom);

		// ...and is the reference again: the board follows the window back.
		await page.setViewportSize({ width: 1440, height: 900 });
		expectCamera(await settledCamera(page), fitted, "fitted, window back");

		// Until the next touch.
		const again = await centreOf(page, "note-2");
		await page.mouse.click(again.x, again.y);
		await page.setViewportSize({ width: 1180, height: 640 });
		expectCamera(await settledCamera(page), fitted, "touched again");
	});
});
