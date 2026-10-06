import { expect, type Page, test } from "@playwright/test";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
	settledCamera,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// A board follows its pane only until the reader touches it (TR-D3). TR-D1 made
// a board fit itself again whenever its pane changes size, while the camera was
// still where the last fit left it, so a tour card arriving never leaves it
// mis-framed. The camera was only "the reader's" once they panned or zoomed, so a
// reader who tapped a note to type (and so opened the on-screen keyboard, which
// resizes the page on Android Chrome) or clicked a block on a desktop had the
// board zoom and move under them as the pane changed. Every flow here is real
// input: a finger's tap, a mouse click, keys; the keyboard is the viewport
// shrinking the way it does on the phone.

const PHONE = { width: 390, height: 844 };
// What an on-screen keyboard takes of a phone's height.
const KEYBOARD = 336;

/** Six notes in two columns: tall enough that a shorter pane changes the fit, legible when fitted to a phone. */
function sixNotes(): CanvasBody {
	return {
		version: 1,
		nodes: Array.from({ length: 6 }, (_, index) => ({
			id: `note-${index + 1}`,
			type: "sticky" as const,
			position: { x: (index % 2) * 240, y: Math.floor(index / 2) * 220 },
			width: 200,
			data: {
				kind: "sticky" as const,
				text: `Note ${index + 1}`,
				tone: "yellow" as const,
			},
		})),
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

type Camera = { x: number; y: number; zoom: number };

function expectCamera(actual: Camera, expected: Camera, message: string) {
	expect(actual.x, `${message}: x`).toBeCloseTo(expected.x, 1);
	expect(actual.y, `${message}: y`).toBeCloseTo(expected.y, 1);
	expect(actual.zoom, `${message}: zoom`).toBeCloseTo(expected.zoom, 3);
}

/** A block's box measured from the board's own top left corner: where the reader sees it, whatever the page around the board does. */
async function placeInPane(page: Page, id: string) {
	const pane = await page.getByTestId("canvas-board").boundingBox();
	if (!pane) throw new Error("no board");
	const box = await nodeBox(page, id);
	return { x: box.x - pane.x, y: box.y - pane.y };
}

async function centreOf(page: Page, id: string) {
	const box = await nodeBox(page, id);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

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

async function openBoard(page: Page, title: string) {
	await login(page);
	const conversationId = await createConversation(page, title);
	await seedCanvas(conversationId, sixNotes());
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
}

test.describe("on a phone, when the on-screen keyboard comes and goes", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test("a board the reader tapped a note on to type stays where it is", async ({
		page,
	}) => {
		await openBoard(page, "Keyboard");
		const fitted = await settledCamera(page);
		const note = await placeInPane(page, "note-4");

		// A finger double-taps a note to type in it, without panning first.
		const at = await centreOf(page, "note-4");
		await page.touchscreen.tap(at.x, at.y);
		await page.touchscreen.tap(at.x, at.y);
		const field = page.locator('.svelte-flow__node[data-id="note-4"] textarea');
		await expect(field).toBeFocused();

		// The keyboard opens: the page is shorter by what it takes.
		await page.setViewportSize({
			width: PHONE.width,
			height: PHONE.height - KEYBOARD,
		});
		expectCamera(await settledCamera(page), fitted, "with the keyboard open");
		const typing = await placeInPane(page, "note-4");
		expect(typing.x).toBeCloseTo(note.x, 1);
		expect(typing.y).toBeCloseTo(note.y, 1);

		await page.keyboard.type(" and more");
		await expect(field).toHaveValue("Note 4 and more");
		expectCamera(await settledCamera(page), fitted, "while typing");

		// The keyboard goes: the board is where the reader left it.
		await page.setViewportSize(PHONE);
		expectCamera(await settledCamera(page), fitted, "with the keyboard closed");
		const after = await placeInPane(page, "note-4");
		expect(after.x).toBeCloseTo(note.x, 1);
		expect(after.y).toBeCloseTo(note.y, 1);
	});

	test("a note inserted from the toolbar opens for typing without the board moving for the keyboard", async ({
		page,
	}) => {
		await openBoard(page, "Insert");
		const fitted = await settledCamera(page);

		await page.getByTestId("canvas-insert-button").tap();
		await page.getByTestId("canvas-insert-sticky").tap();
		const field = page.locator(".svelte-flow__node textarea");
		await expect(field).toBeFocused();
		expectCamera(await settledCamera(page), fitted, "after the insert");

		await page.setViewportSize({
			width: PHONE.width,
			height: PHONE.height - KEYBOARD,
		});
		expectCamera(await settledCamera(page), fitted, "with the keyboard open");
		await page.keyboard.type("Pack the tickets");
		await expect(field).toHaveValue("Pack the tickets");
		await page.setViewportSize(PHONE);
		expectCamera(await settledCamera(page), fitted, "with the keyboard closed");
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
