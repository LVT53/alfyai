import { expect, type Page, test } from "@playwright/test";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import {
	dragBetween,
	nodeBox,
	nodeCount,
	openCanvasPanel,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
} from "./artifact-canvas-helpers";
import { createConversation, expectTopmost, login } from "./helpers";

// The reader's own undo and redo on a Canvas (ruling 16), driven the way a person
// drives it: real pointer and keyboard input on a seeded board, the autosave
// allowed to write, and the focus left wherever the action and the next click
// left it. The owner's walk found "I can't undo actions" with every gate green,
// because the earlier test focused the toolbar's Select button by hand before it
// pressed the chord: a person's focus is on the page's body after a click on the
// empty board, after a block is deleted, in a field they have not typed in, or on
// a checkbox, and ⌘/Ctrl+Z did nothing in each of those.

const FRAME = "frame-friday";
const INSIDE = "note-inside";
const OUTSIDE = "note-outside";
const LIST = "list-pack";
const CAMERA = { x: 16, y: 16, zoom: 1 };

function seededBoard(): CanvasBody {
	const nodes: CanvasNode[] = [
		{
			id: FRAME,
			type: "frame",
			position: { x: 20, y: 20 },
			width: 280,
			height: 230,
			data: { kind: "frame", label: "Friday", width: 280, height: 230 },
		},
		{
			id: INSIDE,
			type: "sticky",
			position: { x: 30, y: 60 },
			width: 170,
			parentId: FRAME,
			data: { kind: "sticky", text: "Inside", tone: "yellow" },
		},
		{
			id: OUTSIDE,
			type: "sticky",
			position: { x: 400, y: 60 },
			width: 170,
			data: { kind: "sticky", text: "Outside", tone: "mint" },
		},
		{
			id: LIST,
			type: "checklist",
			position: { x: 400, y: 220 },
			width: 240,
			data: {
				kind: "checklist",
				label: "Pack",
				items: [
					{ id: "i1", text: "Passport", done: true },
					{ id: "i2", text: "Charger", done: false },
				],
			},
		},
	];
	return { version: 1, nodes, edges: [], viewport: CAMERA, annotations: [] };
}

/** The emulated desktop Chrome reports Windows (Ctrl); a Mac reader has ⌘, which the page reads from `navigator`. */
async function pretendToBeAMac(page: Page) {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "userAgentData", {
			value: { platform: "macOS" },
			configurable: true,
		});
		Object.defineProperty(navigator, "platform", {
			value: "MacIntel",
			configurable: true,
		});
	});
}

async function openBoard(page: Page, options: { mac?: boolean } = {}) {
	if (options.mac) await pretendToBeAMac(page);
	await login(page);
	const conversationId = await createConversation(page, "Undo a board");
	const artifactId = await seedCanvas(conversationId, seededBoard());
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return artifactId;
}

const undoChord = (mac: boolean) => (mac ? "Meta+z" : "Control+z");
const redoChord = (mac: boolean) => (mac ? "Meta+Shift+z" : "Control+Shift+z");

/** The autosave has written, and a moment more has passed: the board is as a reader finds it a few seconds later. */
async function settle(page: Page) {
	await savedStatus(page);
	await page.waitForTimeout(1100);
}

/** A click on the board's empty ground, as a reader deselects: the focus goes wherever the page puts it. */
async function clickEmptyBoard(page: Page) {
	const pane = await page.locator(".svelte-flow__pane").boundingBox();
	if (!pane) throw new Error("the board has no pane");
	const at = { x: pane.x + pane.width - 70, y: pane.y + 70 };
	const hit = await page.evaluate(
		({ x, y }) =>
			document.elementFromPoint(x, y)?.classList.contains("svelte-flow__pane"),
		at,
	);
	expect(hit, "the spot clicked must be the empty board").toBe(true);
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(250);
}

function centreOf(box: {
	x: number;
	y: number;
	width: number;
	height: number;
}) {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

type Box = { x: number; y: number; width: number; height: number };

function near(actual: Box, expected: Box) {
	expect(Math.abs(actual.x - expected.x)).toBeLessThan(2);
	expect(Math.abs(actual.y - expected.y)).toBeLessThan(2);
	expect(Math.abs(actual.width - expected.width)).toBeLessThan(2);
	expect(Math.abs(actual.height - expected.height)).toBeLessThan(2);
}

/** What a reader does, how to tell it is done, and how to tell it is undone. */
type Scene = {
	act: () => Promise<void>;
	done: () => Promise<void>;
	undone: () => Promise<void>;
	/** Deselect with a click on the empty board before the chord: what most readers do next. */
	deselect?: boolean;
};

/**
 * One action, undone and redone: by the chord with the focus where the action left
 * it (after the autosave), then by the toolbar's buttons, then by the chord once more.
 */
async function proveUndoAndRedo(page: Page, scene: Scene, mac = false) {
	await scene.act();
	await settle(page);
	await scene.done();
	if (scene.deselect) await clickEmptyBoard(page);

	await page.keyboard.press(undoChord(mac));
	await scene.undone();
	await page.keyboard.press(redoChord(mac));
	await scene.done();

	await page.getByTestId("canvas-undo").click();
	await scene.undone();
	await page.getByTestId("canvas-redo").click();
	await scene.done();
}

test.describe("undo and redo of the reader's own steps on a Canvas", () => {
	test("moving a note: the chord after the autosave, with the pointer left on the empty board", async ({
		page,
	}) => {
		const artifactId = await openBoard(page);
		const start = await nodeBox(page, OUTSIDE);
		let moved = start;
		await proveUndoAndRedo(page, {
			deselect: true,
			act: async () => {
				const from = centreOf(start);
				await dragBetween(page, from, { x: from.x + 90, y: from.y + 60 });
				moved = await nodeBox(page, OUTSIDE);
			},
			done: async () => {
				await expect
					.poll(async () => (await nodeBox(page, OUTSIDE)).x, {
						timeout: 3_000,
					})
					.toBeGreaterThan(start.x + 60);
			},
			undone: async () => {
				await expect
					.poll(
						async () => Math.abs((await nodeBox(page, OUTSIDE)).x - start.x),
						{
							timeout: 3_000,
						},
					)
					.toBeLessThan(2);
				near(await nodeBox(page, OUTSIDE), start);
			},
		});
		expect(moved.x).toBeGreaterThan(start.x + 60);
		// And what is saved follows what the reader sees.
		await savedStatus(page);
		const stored = (await storedBoard(artifactId)).nodes.find(
			(node) => node.id === OUTSIDE,
		);
		expect(stored?.position.x).toBeGreaterThan(450);
	});

	test("moving a note: the chord with the focus still on the note", async ({
		page,
	}) => {
		await openBoard(page);
		const start = await nodeBox(page, OUTSIDE);
		await proveUndoAndRedo(page, {
			act: async () => {
				const from = centreOf(start);
				await dragBetween(page, from, { x: from.x + 90, y: from.y + 60 });
			},
			done: async () => {
				await expect
					.poll(async () => (await nodeBox(page, OUTSIDE)).x)
					.toBeGreaterThan(start.x + 60);
			},
			undone: async () => {
				await expect
					.poll(async () =>
						Math.abs((await nodeBox(page, OUTSIDE)).x - start.x),
					)
					.toBeLessThan(2);
			},
		});
	});

	test("adding a note and not typing in it: the chord takes the note back", async ({
		page,
	}) => {
		await openBoard(page);
		const before = await nodeCount(page);
		await proveUndoAndRedo(page, {
			act: async () => {
				await page.getByTestId("canvas-insert-button").click();
				await page.getByTestId("canvas-insert-sticky").click();
				await expect(
					page.getByRole("textbox", { name: "Sticky note" }),
				).toBeFocused();
			},
			done: async () => {
				await expect.poll(() => nodeCount(page)).toBe(before + 1);
			},
			undone: async () => {
				await expect.poll(() => nodeCount(page)).toBe(before);
			},
		});
	});

	test("adding a note and typing in it: the chord takes the words back, then the note", async ({
		page,
	}) => {
		await openBoard(page);
		const before = await nodeCount(page);
		await page.getByTestId("canvas-insert-button").click();
		await page.getByTestId("canvas-insert-sticky").click();
		const field = page.getByRole("textbox", { name: "Sticky note" });
		await expect(field).toBeFocused();
		await page.keyboard.type("Museum at ten");
		await clickEmptyBoard(page);
		await settle(page);
		await expect(page.getByText("Museum at ten")).toBeVisible();

		await page.keyboard.press(undoChord(false));
		await expect(page.getByText("Museum at ten")).toHaveCount(0);
		expect(await nodeCount(page)).toBe(before + 1);
		await page.keyboard.press(undoChord(false));
		await expect.poll(() => nodeCount(page)).toBe(before);
		await page.keyboard.press(redoChord(false));
		await expect.poll(() => nodeCount(page)).toBe(before + 1);
		await page.keyboard.press(redoChord(false));
		await expect(page.getByText("Museum at ten")).toBeVisible();
	});

	test("drawing a stroke: the chord after the autosave, with the pointer left on the empty board", async ({
		page,
	}) => {
		await openBoard(page);
		const marks = page.getByTestId("canvas-mark");
		await proveUndoAndRedo(page, {
			deselect: true,
			act: async () => {
				await page.getByTestId("canvas-tool-draw").click();
				await page.getByTestId("canvas-tool-pen").click();
				const layer = await page
					.getByTestId("canvas-drawing-layer")
					.boundingBox();
				if (!layer) throw new Error("no drawing layer");
				await dragBetween(
					page,
					{ x: layer.x + 300, y: layer.y + 320 },
					{ x: layer.x + 430, y: layer.y + 350 },
				);
				await page.getByTestId("canvas-tool-select").click();
			},
			done: async () => {
				await expect(marks).toHaveCount(1);
			},
			undone: async () => {
				await expect(marks).toHaveCount(0);
			},
		});
	});

	test("deleting a block with the Delete key: the chord brings it back", async ({
		page,
	}) => {
		await openBoard(page);
		await proveUndoAndRedo(page, {
			act: async () => {
				await page.mouse.click(
					centreOf(await nodeBox(page, OUTSIDE)).x,
					centreOf(await nodeBox(page, OUTSIDE)).y,
				);
				await page.keyboard.press("Delete");
			},
			done: async () => {
				await expect(
					page.locator(`.svelte-flow__node[data-id="${OUTSIDE}"]`),
				).toHaveCount(0);
			},
			undone: async () => {
				await expect(
					page.locator(`.svelte-flow__node[data-id="${OUTSIDE}"]`),
				).toHaveCount(1);
			},
		});
	});

	test("deleting a block with its trash button: the chord brings it back", async ({
		page,
	}) => {
		await openBoard(page);
		await proveUndoAndRedo(page, {
			act: async () => {
				const at = centreOf(await nodeBox(page, OUTSIDE));
				await page.mouse.click(at.x, at.y);
				await page.getByTestId("canvas-node-delete").click();
			},
			done: async () => {
				await expect(
					page.locator(`.svelte-flow__node[data-id="${OUTSIDE}"]`),
				).toHaveCount(0);
			},
			undone: async () => {
				await expect(
					page.locator(`.svelte-flow__node[data-id="${OUTSIDE}"]`),
				).toHaveCount(1);
			},
		});
	});

	test("resizing a frame by its corner: the chord after the autosave, with the pointer left on the empty board", async ({
		page,
	}) => {
		await openBoard(page);
		const start = await nodeBox(page, FRAME);
		await proveUndoAndRedo(page, {
			deselect: true,
			act: async () => {
				await page.getByTestId("canvas-frame-label").click();
				const corner = await page
					.locator(
						".svelte-flow__resize-control.handle.canvas-resize.bottom.right",
					)
					.boundingBox();
				if (!corner) throw new Error("no resize corner");
				const from = centreOf(corner);
				await dragBetween(page, from, { x: from.x + 60, y: from.y + 50 });
			},
			done: async () => {
				await expect
					.poll(async () => (await nodeBox(page, FRAME)).width)
					.toBeGreaterThan(start.width + 40);
			},
			undone: async () => {
				await expect
					.poll(async () =>
						Math.abs((await nodeBox(page, FRAME)).width - start.width),
					)
					.toBeLessThan(2);
				near(await nodeBox(page, FRAME), start);
			},
		});
	});

	test("ticking a checklist item: the chord with the focus on the checkbox", async ({
		page,
	}) => {
		await openBoard(page);
		const charger = page.getByRole("checkbox", {
			name: "Charger: toggle done",
		});
		await proveUndoAndRedo(page, {
			act: async () => {
				await charger.check();
			},
			done: async () => {
				await expect(charger).toBeChecked();
			},
			undone: async () => {
				await expect(charger).not.toBeChecked();
			},
		});
	});

	test("on a Mac (⌘Z): a moved note and a deleted block", async ({ page }) => {
		await openBoard(page, { mac: true });
		const start = await nodeBox(page, OUTSIDE);
		await proveUndoAndRedo(
			page,
			{
				deselect: true,
				act: async () => {
					const from = centreOf(start);
					await dragBetween(page, from, { x: from.x + 90, y: from.y + 60 });
				},
				done: async () => {
					await expect
						.poll(async () => (await nodeBox(page, OUTSIDE)).x)
						.toBeGreaterThan(start.x + 60);
				},
				undone: async () => {
					await expect
						.poll(async () =>
							Math.abs((await nodeBox(page, OUTSIDE)).x - start.x),
						)
						.toBeLessThan(2);
				},
			},
			true,
		);
		await proveUndoAndRedo(
			page,
			{
				act: async () => {
					// The scene before ended with a Redo. A Redo (like every undo) hands the
					// library fresh blocks, and a block is `visibility: hidden`, so it takes no
					// pointer, until the library has measured it again on the next frame. Its box
					// is the same rect either way, so `nodeBox` cannot tell: a click made at once
					// fell through to the empty board, nothing was picked, and Delete deleted
					// nothing (one run in four). Wait until the card is what the point hits.
					await expectTopmost(
						page.locator(`.svelte-flow__node[data-id="${LIST}"]`),
						{ message: "the checklist takes a pointer again after the redo" },
					);
					// The card's header, where nothing is pressable: a click on a checkbox would
					// leave the focus in an input, which the library's Delete key does not serve.
					const box = await nodeBox(page, LIST);
					await page.mouse.click(box.x + box.width / 2, box.y + 14);
					await page.keyboard.press("Delete");
				},
				done: async () => {
					await expect(
						page.locator(`.svelte-flow__node[data-id="${LIST}"]`),
					).toHaveCount(0);
				},
				undone: async () => {
					await expect(
						page.locator(`.svelte-flow__node[data-id="${LIST}"]`),
					).toHaveCount(1);
				},
			},
			true,
		);
	});

	test("after the panel has been closed and opened again", async ({ page }) => {
		await openBoard(page);
		await page
			.getByRole("button", { name: "Close document workspace" })
			.click();
		await expect(page.getByTestId("canvas-editor")).toHaveCount(0);
		await openCanvasPanel(page);
		const start = await nodeBox(page, OUTSIDE);
		await proveUndoAndRedo(page, {
			deselect: true,
			act: async () => {
				const from = centreOf(start);
				await dragBetween(page, from, { x: from.x - 70, y: from.y + 80 });
			},
			done: async () => {
				await expect
					.poll(async () => (await nodeBox(page, OUTSIDE)).y)
					.toBeGreaterThan(start.y + 50);
			},
			undone: async () => {
				await expect
					.poll(async () =>
						Math.abs((await nodeBox(page, OUTSIDE)).y - start.y),
					)
					.toBeLessThan(2);
			},
		});
	});
});
