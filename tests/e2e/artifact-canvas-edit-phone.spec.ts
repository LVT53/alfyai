import { expect, test } from "@playwright/test";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { centre } from "./artifact-canvas-edit-helpers";
import {
	KEYBOARD,
	openCanvasPanel,
	openChatAndReload,
	PHONE,
	seedCanvas,
	storedBoard,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { createConversation, login, waitForMotionToSettle } from "./helpers";

// The edit form of a block, on a phone (Feature 2 · Canvas, CV-B2). CV-B's form opens
// in the block, at the board's zoom, and a block low in a phone's pane left Save and
// Cancel below the fold, behind the board's own toolbar; at a zoomed-out board its
// fields were a few pixels tall. On a phone the form is the app's sheet, like the
// board's other phone surfaces: whole, at its own size, with its buttons pinned.

type Box = { x: number; y: number; width: number; height: number };

const boxOf = async (locator: import("@playwright/test").Locator) =>
	(await locator.boundingBox()) as Box;

const SALES = JSON.stringify({
	type: "bar",
	data: {
		labels: ["Apples", "Pears"],
		datasets: [{ label: "Sales", data: [30, 20] }],
	},
});

/** A chart whose top is low in a phone's pane: the form that opens on it is taller than the room under it. */
function lowChart(zoom: number): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "note",
				type: "sticky",
				position: { x: 0, y: 0 },
				width: 200,
				data: { kind: "sticky", text: "Above", tone: "yellow" },
			},
			{
				id: "sales",
				type: "chart",
				position: { x: 0, y: 420 / zoom },
				width: 330 / zoom,
				data: { kind: "chart", code: SALES, label: "Sales by fruit" },
			},
		],
		edges: [],
		viewport: { x: 12, y: 10, zoom },
		annotations: [],
	};
}

async function openPhoneBoard(
	page: import("@playwright/test").Page,
	body: CanvasBody,
) {
	await login(page);
	const conversationId = await createConversation(
		page,
		"A form near the bottom",
	);
	const boardId = await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return boardId;
}

/** A finger taps the chart's header, then the Edit button of its toolbar. */
async function tapEdit(page: import("@playwright/test").Page) {
	const head = centre(
		await boxOf(
			page.locator('.svelte-flow__node[data-id="sales"] .canvas-node__head'),
		),
	);
	await page.touchscreen.tap(head.x, head.y);
	const edit = page.getByTestId("canvas-node-edit");
	await expect(edit).toBeVisible();
	const at = centre(await boxOf(edit));
	await page.touchscreen.tap(at.x, at.y);
	await expect(page.getByTestId("canvas-edit-form")).toBeVisible();
	// The sheet slides up: what is measured next is measured where it will stay.
	await waitForMotionToSettle(page);
}

test.describe("on a phone, the edit form of a block keeps its buttons in view", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test.beforeEach(async () => {
		await setUiLanguage("en");
	});

	test("a chart low in the pane: Save and Cancel are in the window, on top, and a finger can press them", async ({
		page,
	}) => {
		const boardId = await openPhoneBoard(page, lowChart(1));
		await tapEdit(page);

		for (const testId of ["canvas-edit-save", "canvas-edit-cancel"]) {
			const button = page.getByTestId(testId);
			await expect(button).toBeVisible();
			await expect(button).toBeInViewport({ ratio: 1 });
			const box = await boxOf(button);
			expect(box.height).toBeGreaterThanOrEqual(44);
			// Nothing sits over it: what a finger meets at its centre is the button.
			const hit = await page.evaluate(
				({ x, y }) =>
					document.elementFromPoint(x, y)?.closest("button")?.dataset.testid,
				centre(box),
			);
			expect(hit).toBe(testId);
		}

		// The reader changes the title with the keyboard and saves with a tap.
		const title = page.getByTestId("canvas-edit-title");
		await title.tap();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.insertText("Fruit sales");
		const save = centre(await boxOf(page.getByTestId("canvas-edit-save")));
		await page.touchscreen.tap(save.x, save.y);
		await expect(page.getByTestId("canvas-edit-form")).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(
						(await storedBoard(boardId)).nodes.find(
							(node) => node.id === "sales",
						)?.data as { label?: string }
					).label,
			)
			.toBe("Fruit sales");
	});

	test("is as big as any other form, whatever the board's zoom is, and its fields are not so small that a phone zooms the page", async ({
		page,
	}) => {
		await openPhoneBoard(page, lowChart(0.4));
		await tapEdit(page);
		const title = page.getByTestId("canvas-edit-title");
		const source = page.getByTestId("canvas-edit-source");
		await expect(title).toBeVisible();
		for (const field of [title, source]) {
			expect(
				await field.evaluate((element) =>
					Number.parseFloat(getComputedStyle(element).fontSize),
				),
			).toBeGreaterThanOrEqual(16);
		}
		expect((await boxOf(title)).height).toBeGreaterThanOrEqual(36);
		await expect(page.getByTestId("canvas-edit-save")).toBeInViewport({
			ratio: 1,
		});
	});

	test("keeps Save in the window when the on-screen keyboard shortens the page, and the block behind it is still drawn", async ({
		page,
	}) => {
		await openPhoneBoard(page, lowChart(1));
		await tapEdit(page);
		const title = page.getByTestId("canvas-edit-title");
		await title.tap();
		await expect(title).toBeFocused();
		await page.setViewportSize({
			width: PHONE.width,
			height: PHONE.height - KEYBOARD,
		});
		await expect(page.getByTestId("canvas-edit-save")).toBeInViewport({
			ratio: 1,
		});
		await expect(page.getByTestId("canvas-edit-cancel")).toBeInViewport({
			ratio: 1,
		});
		// The chart is still on the board under the sheet: the form did not take its place.
		await expect(page.getByTestId("canvas-chart")).toHaveCount(1);
	});

	test("Cancel, a tap on the page behind the sheet and Escape write nothing and give the board back", async ({
		page,
	}) => {
		const boardId = await openPhoneBoard(page, lowChart(1));
		const before = (await storedBoard(boardId)).nodes.find(
			(node) => node.id === "sales",
		);

		await tapEdit(page);
		await page.getByTestId("canvas-edit-title").tap();
		await page.keyboard.insertText(" extra");
		const cancel = centre(await boxOf(page.getByTestId("canvas-edit-cancel")));
		await page.touchscreen.tap(cancel.x, cancel.y);
		await expect(page.getByTestId("canvas-edit-form")).toHaveCount(0);

		await tapEdit(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("canvas-edit-form")).toHaveCount(0);

		await tapEdit(page);
		await page.touchscreen.tap(PHONE.width / 2, 30);
		await expect(page.getByTestId("canvas-edit-form")).toHaveCount(0);

		await page.waitForTimeout(1500);
		expect(
			(await storedBoard(boardId)).nodes.find((node) => node.id === "sales"),
		).toEqual(before);
	});

	test("a window that grows past a phone's leaves no sheet over the page: the panel is rebuilt around it", async ({
		page,
	}) => {
		await openPhoneBoard(page, lowChart(1));
		await tapEdit(page);
		await expect(page.getByRole("dialog", { name: "Edit" })).toBeVisible();
		await page.setViewportSize({ width: 1000, height: 800 });
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByTestId("canvas-edit-form")).toHaveCount(0);
		// The sheet's lock on the page is let go.
		expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
	});
});
