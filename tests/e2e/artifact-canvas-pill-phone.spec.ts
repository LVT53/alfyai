import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	centreOf,
	KEYBOARD,
	openBoard,
	PAN_WAIT_MS,
	PHONE,
	settledCamera,
} from "./artifact-canvas-helpers";

/**
 * On a phone, with the keyboard up, the selection's pill and the block's own
 * toolbar do not overlap (final re-check RC-F, MIN-1; RV-F M-5, carried).
 *
 * The pill hangs a fixed 60 px over a block's top, which clears the toolbar a
 * pointer gets (36 px and its 12 px offset) and not the one a finger gets (44 px
 * buttons: the bar is 52 tall), so the pill's foot sat 4 px into the toolbar when a
 * note low on the board had been panned into view over the keyboard.
 *
 * A finger's taps, and the keyboard as a shorter viewport.
 */

const SHORT = { width: PHONE.width, height: PHONE.height - KEYBOARD };

async function rectOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("nothing on the screen to measure");
	return {
		left: box.x,
		top: box.y,
		right: box.x + box.width,
		bottom: box.y + box.height,
	};
}

async function pillAndToolbar(page: Page) {
	return {
		pill: await rectOf(page.getByTestId("canvas-selection-pill")),
		toolbar: await rectOf(page.getByTestId("canvas-node-toolbar")),
	};
}

test.describe("the selection's pill and the block's toolbar on a phone", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test("stand apart with the keyboard up over the lowest note", async ({
		page,
	}) => {
		await openBoard(page, "Pill and toolbar");
		const note = page.locator('.svelte-flow__node[data-id="note-6"]');
		const at = await centreOf(page, "note-6");
		await page.touchscreen.tap(at.x, at.y);
		await page.touchscreen.tap(at.x, at.y);
		await expect(note.locator("textarea")).toBeFocused();

		// The keyboard opens, and the camera brings the note into view over it.
		await page.setViewportSize(SHORT);
		await page.waitForTimeout(PAN_WAIT_MS);
		await settledCamera(page);
		await expect(page.getByTestId("canvas-selection-pill")).toBeVisible();
		await expect(page.getByTestId("canvas-node-toolbar")).toBeVisible();

		const { pill, toolbar } = await pillAndToolbar(page);
		const gap =
			pill.bottom <= toolbar.top
				? toolbar.top - pill.bottom
				: pill.top >= toolbar.bottom
					? pill.top - toolbar.bottom
					: -1;
		expect(
			gap,
			`the pill (${pill.top}..${pill.bottom}) overlaps the toolbar (${toolbar.top}..${toolbar.bottom})`,
		).toBeGreaterThanOrEqual(4);
	});
});
