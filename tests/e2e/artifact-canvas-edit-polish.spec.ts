import { expect, test } from "@playwright/test";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	bareSpot,
	centre,
	click,
	nodeOf,
	openTheBoard,
	type Style,
	seedChat,
	wrapperOf,
} from "./artifact-canvas-edit-helpers";
import {
	centreOf,
	expectCamera,
	nodeCount,
	openBoard,
	PHONE,
	settledCamera,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { login } from "./helpers";

// The loose ends of CV-B (Feature 2 · Canvas, CV-B2). Every flow here is real input:
// a mouse, a finger, the keyboard and the wheel as a laptop's touchpad sends it.

test.describe("the wheel over a note being typed in", () => {
	test("pans the board, and a pinch zooms it, from over the text the reader is typing in", async ({
		page,
	}) => {
		await openBoard(page, "Wheel over a note being typed in");
		const at = await centreOf(page, "note-2");
		await click(page, "mouse", at, 2);
		const field = page.locator('.svelte-flow__node[data-id="note-2"] textarea');
		await expect(field).toBeFocused();
		const start = await settledCamera(page);

		// A two-finger scroll with the pointer on the words being edited (the field's own box, which is only as tall as its words): the board pans.
		const box = await field.boundingBox();
		if (!box) throw new Error("no field");
		const over = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		expect(
			await page.evaluate(
				({ x, y }) => document.elementFromPoint(x, y)?.tagName,
				over,
			),
		).toBe("TEXTAREA");
		await page.mouse.move(over.x, over.y);
		await page.mouse.wheel(40, 90);
		const moved = await settledCamera(page);
		expectCamera(
			moved,
			{ ...start, x: start.x - 40, y: start.y - 90 },
			"a scroll over the field",
		);
		// The reader is still typing where they were.
		await expect(field).toBeFocused();
		await page.keyboard.type("!");
		await expect(field).toHaveValue("Note 2!");

		// A pinch over it zooms the board about the pointer (and not the page).
		await page.keyboard.down("Control");
		await page.mouse.wheel(0, -8);
		await page.keyboard.up("Control");
		const zoomed = await settledCamera(page);
		expect(zoomed.zoom).toBeGreaterThan(moved.zoom * 1.05);
		await expect(field).toBeFocused();
	});
});

test.describe("Safari's pinch", () => {
	test("a trackpad pinch, which Safari reports as a gesture, zooms the board about the pointer and not the page", async ({
		page,
	}) => {
		await openBoard(page, "Safari's pinch");
		const pane = await page.locator(".svelte-flow__pane").boundingBox();
		if (!pane) throw new Error("no pane");
		const at = {
			x: Math.round(pane.x + pane.width - 90),
			y: Math.round(pane.y + 90),
		};
		const start = await settledCamera(page);

		// Chromium has no trackpad gestures of Safari's kind, so this is the one flow whose
		// event is made by the page: a plain event with what Safari's carries (the scale of
		// the gesture so far, and the pointer). What it checks is the wiring on the real board.
		const cancelled = await page.evaluate(({ x, y }) => {
			const target = document.elementFromPoint(x, y);
			const send = (type: string, scale: number) => {
				const event = new Event(type, { bubbles: true, cancelable: true });
				Object.assign(event, { scale, rotation: 0, clientX: x, clientY: y });
				target?.dispatchEvent(event);
				return event.defaultPrevented;
			};
			return [
				send("gesturestart", 1),
				send("gesturechange", 1.2),
				send("gesturechange", 1.5),
				send("gestureend", 1.5),
			];
		}, at);
		expect(cancelled).toEqual([true, true, true, true]);

		const zoomed = await settledCamera(page);
		expect(zoomed.zoom).toBeCloseTo(start.zoom * 1.5, 3);
		// The board point under the pointer stays under it.
		const point = (camera: typeof start) => ({
			x: (at.x - pane.x - camera.x) / camera.zoom,
			y: (at.y - pane.y - camera.y) / camera.zoom,
		});
		expect(point(zoomed).x).toBeCloseTo(point(start).x, 1);
		expect(point(zoomed).y).toBeCloseTo(point(start).y, 1);
	});
});

// ---- A File block: a click selects it, a double click or Enter opens it ----------

function fileBoard(chatFileId: string): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "note",
				type: "sticky",
				position: { x: 0, y: 0 },
				width: 200,
				data: { kind: "sticky", text: "Hello", tone: "yellow" },
			},
			{
				id: "trip",
				type: "file",
				position: { x: 0, y: 260 },
				width: 280,
				data: {
					kind: "file",
					fileId: chatFileId,
					name: "Vienna trip notes.md",
					mime: "text/markdown",
					bytes: 38,
					label: "MD",
				},
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

test.describe("a File block is picked like every other block", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("en");
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	for (const style of ["mouse", "touchpad"] as Style[]) {
		test(`a click with a ${style} selects it and shows its toolbar; a double click opens it in the panel`, async ({
			page,
		}) => {
			const { conversationId } = await seedChat(page, { body: fileBoard });
			await openTheBoard(page, conversationId);
			const board = page.getByTestId("canvas-board");
			const trip = centre(
				(await wrapperOf(page, "trip").boundingBox()) as never,
			);

			// A click is a pick: the block is selected, wears its toolbar, and nothing opens.
			await click(page, style, trip);
			await expect(nodeOf(page, "trip")).toHaveAttribute(
				"data-selected",
				"true",
			);
			await expect(page.getByTestId("canvas-node-toolbar")).toBeVisible();
			await expect(page.getByTestId("canvas-node-open")).toBeVisible();
			await expect(board).toBeVisible();
			await page.waitForTimeout(400);
			await expect(board).toBeVisible();

			// Another block takes the selection from it, as with any block.
			await click(
				page,
				style,
				centre((await wrapperOf(page, "note").boundingBox()) as never),
			);
			await expect(nodeOf(page, "trip")).toHaveAttribute(
				"data-selected",
				"false",
			);
			await expect(board).toBeVisible();

			// A double click opens the file in the panel's own viewer, in place of the board.
			await click(page, "mouse", await bareSpot(page));
			await click(page, style, trip, 2);
			await expect(board).toHaveCount(0);
		});
	}

	test("Enter opens it while the block has the focus", async ({ page }) => {
		const { conversationId } = await seedChat(page, { body: fileBoard });
		await openTheBoard(page, conversationId);
		const trip = centre((await wrapperOf(page, "trip").boundingBox()) as never);

		await click(page, "mouse", trip);
		await expect(nodeOf(page, "trip")).toHaveAttribute("data-selected", "true");
		await expect(wrapperOf(page, "trip")).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("canvas-board")).toHaveCount(0);
	});

	test("the Open button of its toolbar opens it with one click, and says which file", async ({
		page,
	}) => {
		const { conversationId } = await seedChat(page, { body: fileBoard });
		await openTheBoard(page, conversationId);
		const trip = centre((await wrapperOf(page, "trip").boundingBox()) as never);

		await click(page, "mouse", trip);
		const open = page.getByTestId("canvas-node-open");
		await expect(open).toBeVisible();
		await expect(open).toHaveAccessibleName("Open Vienna trip notes.md");
		await click(page, "mouse", centre((await open.boundingBox()) as never));
		await expect(page.getByTestId("canvas-board")).toHaveCount(0);
	});

	test("says how it opens, in English and in Hungarian", async ({ page }) => {
		const { conversationId } = await seedChat(page, { body: fileBoard });
		await openTheBoard(page, conversationId);
		await expect(page.getByTestId("canvas-file")).toHaveAttribute(
			"title",
			"Double-click to open",
		);
		await setUiLanguage("hu");
		await page.reload({ waitUntil: "networkidle" });
		await openTheBoard(page, conversationId);
		await expect(page.getByTestId("canvas-file")).toHaveAttribute(
			"title",
			"Dupla kattintással megnyílik",
		);
		await setUiLanguage("en");
	});
});

// ---- The toolbar of a block near the top of the pane ------------------------------

type Box = { x: number; y: number; width: number; height: number };

function nearTheTop(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "high",
				type: "sticky",
				position: { x: 0, y: 0 },
				width: 160,
				data: { kind: "sticky", text: "Right at the top", tone: "yellow" },
			},
			{
				id: "low",
				type: "sticky",
				position: { x: 300, y: 220 },
				width: 200,
				data: { kind: "sticky", text: "Further down", tone: "mint" },
			},
			{
				id: "plans",
				type: "frame",
				position: { x: 540, y: 0 },
				width: 300,
				height: 220,
				data: { kind: "frame", label: "Plans", width: 300, height: 220 },
			},
		],
		edges: [],
		// A camera of its own, so the board is not fitted: the first block's top is 14 px
		// below the pane's top, with no room for a toolbar above it.
		viewport: { x: 12, y: 14, zoom: 1 },
		annotations: [],
	};
}

/** One frame much taller than the pane, whose top is out of view. */
function tallFrame(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "page",
				type: "frame",
				position: { x: 100, y: -400 },
				width: 600,
				height: 2400,
				data: { kind: "frame", label: "Page", width: 600, height: 2400 },
			},
		],
		edges: [],
		viewport: { x: 12, y: 14, zoom: 1 },
		annotations: [],
	};
}

const boxOf = async (locator: import("@playwright/test").Locator) =>
	(await locator.boundingBox()) as Box;

/** Whether two boxes share any area. */
const overlap = (a: Box, b: Box) =>
	a.x < b.x + b.width &&
	a.x + a.width > b.x &&
	a.y < b.y + b.height &&
	a.y + a.height > b.y;

/** The whole of `part` is inside the pane, a few pixels clear of its edge. */
async function expectInPane(
	page: import("@playwright/test").Page,
	part: import("@playwright/test").Locator,
	what: string,
) {
	const pane = await boxOf(page.locator(".svelte-flow").first());
	const box = await boxOf(part);
	expect(box.x, `${what}: left`).toBeGreaterThanOrEqual(pane.x + 7);
	expect(box.y, `${what}: top`).toBeGreaterThanOrEqual(pane.y + 7);
	expect(box.x + box.width, `${what}: right`).toBeLessThanOrEqual(
		pane.x + pane.width - 7,
	);
	expect(box.y + box.height, `${what}: bottom`).toBeLessThanOrEqual(
		pane.y + pane.height - 7,
	);
}

test.describe("the toolbar of a selected block stays in the pane", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	test("goes below a block that has no room above it, slides in from the edge, and its buttons work", async ({
		page,
	}) => {
		await openBoard(page, "Toolbar at the top", nearTheTop());
		const block = page.locator('.svelte-flow__node[data-id="high"]');
		await click(page, "mouse", centre(await boxOf(block)));
		await expect(nodeOf(page, "high")).toHaveAttribute("data-selected", "true");
		const toolbar = page.getByTestId("canvas-node-toolbar");
		await expect(toolbar).toBeVisible();

		await expectInPane(page, toolbar, "the toolbar");
		const bar = await boxOf(toolbar);
		const at = await boxOf(block);
		// Below the block, not over it.
		expect(bar.y).toBeGreaterThanOrEqual(at.y + at.height);

		// Its buttons are pressed with a real click: Edit opens the note's words.
		await click(
			page,
			"mouse",
			centre(await boxOf(page.getByTestId("canvas-node-edit"))),
		);
		const field = page.locator("textarea.text-field__input");
		await expect(field).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(field).toHaveCount(0);

		// And Delete deletes it.
		await click(
			page,
			"mouse",
			centre(await boxOf(page.getByTestId("canvas-node-delete"))),
		);
		await expect.poll(() => nodeCount(page)).toBe(2);
	});

	test("stays above a block that has room for it", async ({ page }) => {
		await openBoard(page, "Toolbar with room", nearTheTop());
		const block = page.locator('.svelte-flow__node[data-id="low"]');
		await click(page, "mouse", centre(await boxOf(block)));
		const toolbar = page.getByTestId("canvas-node-toolbar");
		await expect(toolbar).toBeVisible();
		const bar = await boxOf(toolbar);
		const at = await boxOf(block);
		expect(bar.y + bar.height).toBeLessThanOrEqual(at.y);
		await expectInPane(page, toolbar, "the toolbar");
	});

	test("keeps off the selection's pill, which hangs under it when the toolbar is below the block", async ({
		page,
	}) => {
		await openBoard(page, "Toolbar and pill", nearTheTop());
		const block = page.locator('.svelte-flow__node[data-id="high"]');
		await click(page, "mouse", centre(await boxOf(block)));
		const toolbar = page.getByTestId("canvas-node-toolbar");
		const pill = page.getByTestId("canvas-selection-pill");
		await expect(toolbar).toBeVisible();
		await expect(pill).toBeVisible();
		await page.waitForTimeout(400);

		await expectInPane(page, pill, "the pill");
		const bar = await boxOf(toolbar);
		const hung = await boxOf(pill);
		expect(overlap(bar, hung), "the pill is not over the toolbar").toBe(false);
		// Both reachable: a real click on the pill's Comment button lands on it.
		await expect(page.getByTestId("canvas-selection-comment")).toBeVisible();
		const comment = await boxOf(page.getByTestId("canvas-selection-comment"));
		expect(
			await page.evaluate(
				({ x, y }) =>
					document
						.elementFromPoint(x, y)
						?.closest("[data-testid='canvas-selection-pill']") !== null,
				{ x: comment.x + comment.width / 2, y: comment.y + comment.height / 2 },
			),
		).toBe(true);
	});

	test("is below a frame that sits at the top of the pane, and pressable there", async ({
		page,
	}) => {
		await openBoard(page, "Frame toolbar at the top", nearTheTop());
		const block = page.locator('.svelte-flow__node[data-id="plans"]');
		const at = await boxOf(block);
		// A frame is picked by its ground.
		await click(page, "mouse", {
			x: at.x + at.width / 2,
			y: at.y + at.height * 0.6,
		});
		await expect(nodeOf(page, "plans")).toHaveAttribute(
			"data-selected",
			"true",
		);
		const toolbar = page.getByTestId("canvas-node-toolbar");
		await expect(toolbar).toBeVisible();
		await expectInPane(page, toolbar, "the toolbar");
		await click(
			page,
			"mouse",
			centre(await boxOf(page.getByTestId("canvas-node-delete"))),
		);
		await expect.poll(() => nodeCount(page)).toBe(2);
	});

	test("is kept in the pane over a block taller than the pane, whose top is out of view", async ({
		page,
	}) => {
		await openBoard(page, "Toolbar over a tall block", tallFrame());
		const block = page.locator('.svelte-flow__node[data-id="page"]');
		const at = await boxOf(block);
		expect(at.y).toBeLessThan(0);
		await click(page, "mouse", { x: at.x + at.width / 2, y: at.y + 700 });
		await expect(nodeOf(page, "page")).toHaveAttribute("data-selected", "true");
		const toolbar = page.getByTestId("canvas-node-toolbar");
		await expect(toolbar).toBeVisible();
		await expectInPane(page, toolbar, "the toolbar");
	});
});

test.describe("on a phone, the toolbar of a block at the top is in the pane too", () => {
	test.use({ hasTouch: true, viewport: PHONE });

	test("a tap picks the note and its toolbar is below it, whole, with buttons a finger can press", async ({
		page,
	}) => {
		await openBoard(page, "Phone toolbar at the top", nearTheTop());
		const block = page.locator('.svelte-flow__node[data-id="high"]');
		const at = centre(await boxOf(block));
		await page.touchscreen.tap(at.x, at.y);
		await expect(nodeOf(page, "high")).toHaveAttribute("data-selected", "true");
		const toolbar = page.getByTestId("canvas-node-toolbar");
		await expect(toolbar).toBeVisible();
		await expectInPane(page, toolbar, "the toolbar");
		const bar = await boxOf(toolbar);
		const note = await boxOf(block);
		expect(bar.y).toBeGreaterThanOrEqual(note.y + note.height);
		const del = await boxOf(page.getByTestId("canvas-node-delete"));
		expect(del.width).toBeGreaterThanOrEqual(44);
		await page.touchscreen.tap(del.x + del.width / 2, del.y + del.height / 2);
		await expect.poll(() => nodeCount(page)).toBe(2);
	});
});
