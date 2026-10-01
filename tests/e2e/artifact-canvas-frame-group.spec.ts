import { expect, type Page, test } from "@playwright/test";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import {
	dragBetween,
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
	versionRows,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// A frame is a group a reader can grab (the owner's walk: "what's the point of
// adding canvas elements into bigger groups if I can't even select the group when
// I click inside its empty areas or even move it/resize it anywhere?"). A frame
// let the pointer through everywhere but its name chip and a thin ring, so a click
// in it fell to the board behind, and only the chip moved it; it had four corner
// handles and no edge. Real pointer and keyboard input on a seeded board.

const FRAME = "frame-friday";
const NOTE_A = "note-museum";
const NOTE_B = "note-lunch";
const OUTSIDE = "note-outside";
const CAMERA = { x: 16, y: 16, zoom: 1 };
const FRAME_SIZE = { width: 360, height: 300 };

function seededBoard(): CanvasBody {
	const nodes: CanvasNode[] = [
		{
			id: FRAME,
			type: "frame",
			position: { x: 40, y: 40 },
			width: FRAME_SIZE.width,
			height: FRAME_SIZE.height,
			data: {
				kind: "frame",
				label: "Friday",
				width: FRAME_SIZE.width,
				height: FRAME_SIZE.height,
			},
		},
		{
			id: NOTE_A,
			type: "sticky",
			position: { x: 24, y: 48 },
			width: 150,
			parentId: FRAME,
			data: { kind: "sticky", text: "Museum", tone: "yellow" },
		},
		{
			id: NOTE_B,
			type: "sticky",
			position: { x: 120, y: 150 },
			width: 150,
			parentId: FRAME,
			data: { kind: "sticky", text: "Lunch", tone: "mint" },
		},
		{
			id: OUTSIDE,
			type: "sticky",
			position: { x: 520, y: 60 },
			width: 150,
			data: { kind: "sticky", text: "Outside", tone: "blue" },
		},
	];
	return { version: 1, nodes, edges: [], viewport: CAMERA, annotations: [] };
}

type Box = { x: number; y: number; width: number; height: number };

async function openBoard(page: Page): Promise<string> {
	await login(page);
	const conversationId = await createConversation(page, "Frame group");
	const artifactId = await seedCanvas(conversationId, seededBoard());
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return artifactId;
}

const frameNode = (page: Page) =>
	page.locator(`.svelte-flow__node[data-id="${FRAME}"]`);

/** A point inside the frame, `from` its top-left corner, on the screen. */
async function inFrame(page: Page, dx: number, dy: number) {
	const box = await nodeBox(page, FRAME);
	return { x: box.x + dx, y: box.y + dy };
}

/** The empty ground of the frame: right of the first note and above the second. */
const EMPTY = { dx: 290, dy: 70 };

async function selectedIds(page: Page): Promise<string[]> {
	return page
		.locator(".svelte-flow__node.selected")
		.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute("data-id") ?? ""),
		);
}

async function boxes(page: Page) {
	return {
		frame: await nodeBox(page, FRAME),
		a: await nodeBox(page, NOTE_A),
		b: await nodeBox(page, NOTE_B),
		outside: await nodeBox(page, OUTSIDE),
	};
}

function within(child: Box, frame: Box, slack = 1) {
	return (
		child.x >= frame.x - slack &&
		child.y >= frame.y - slack &&
		child.x + child.width <= frame.x + frame.width + slack &&
		child.y + child.height <= frame.y + frame.height + slack
	);
}

function centreOf(box: Box) {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Where a reader grabs a side of the frame: a quarter of the way along it, since the
 * middle of each side is the connection anchor (which wins there, as on every block).
 */
function grabPoint(strip: Box, side: string) {
	return side === "left" || side === "right"
		? { x: strip.x + strip.width / 2, y: strip.y + strip.height * 0.25 }
		: { x: strip.x + strip.width * 0.25, y: strip.y + strip.height / 2 };
}

async function selectFrameByEmptyArea(page: Page) {
	const at = await inFrame(page, EMPTY.dx, EMPTY.dy);
	await page.mouse.click(at.x, at.y);
	await expect.poll(() => selectedIds(page)).toEqual([FRAME]);
}

test.describe("a frame is a group a reader can grab", () => {
	test("a click in its empty area selects the frame; a click on a note in it selects the note", async ({
		page,
	}) => {
		await openBoard(page);
		expect(await selectedIds(page)).toEqual([]);

		await selectFrameByEmptyArea(page);
		// Selected, it shows the handles and its toolbar.
		await expect(
			frameNode(page).locator(".svelte-flow__resize-control.handle"),
		).toHaveCount(4);
		await expect(page.getByTestId("canvas-node-toolbar")).toBeVisible();

		// A note inside it is a note: the click is the note's.
		const a = await nodeBox(page, NOTE_A);
		await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
		await expect.poll(() => selectedIds(page)).toEqual([NOTE_A]);

		// Empty ground elsewhere lets go of everything.
		const pane = await page.locator(".svelte-flow__pane").boundingBox();
		if (!pane) throw new Error("no pane");
		await page.mouse.click(pane.x + pane.width - 70, pane.y + 70);
		await expect.poll(() => selectedIds(page)).toEqual([]);

		// Every part of the frame's ground works, not one spot: near each corner too.
		for (const [dx, dy] of [
			[14, 280],
			[340, 280],
			[300, 20],
		] as const) {
			const at = await inFrame(page, dx, dy);
			await page.mouse.click(at.x, at.y);
			await expect.poll(() => selectedIds(page)).toEqual([FRAME]);
			await page.mouse.click(pane.x + pane.width - 70, pane.y + 70);
			await expect.poll(() => selectedIds(page)).toEqual([]);
		}
	});

	test("the innermost frame under a click takes it", async ({ page }) => {
		await login(page);
		const conversationId = await createConversation(page, "Nested frames");
		const board = seededBoard();
		board.nodes.splice(1, 0, {
			id: "frame-inner",
			type: "frame",
			position: { x: 180, y: 40 },
			width: 150,
			height: 200,
			parentId: FRAME,
			data: { kind: "frame", label: "Inner", width: 150, height: 200 },
		});
		await seedCanvas(conversationId, board);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);
		const inner = await nodeBox(page, "frame-inner");
		await page.mouse.click(
			inner.x + inner.width - 20,
			inner.y + inner.height - 20,
		);
		await expect.poll(() => selectedIds(page)).toEqual(["frame-inner"]);
	});

	test("dragging the selected frame by its body moves it with its children, and they keep their places in it", async ({
		page,
	}) => {
		const artifactId = await openBoard(page);
		const before = await boxes(page);
		await selectFrameByEmptyArea(page);

		const from = await inFrame(page, 300, 260);
		await dragBetween(page, from, { x: from.x + 120, y: from.y + 70 });
		await savedStatus(page);

		const after = await boxes(page);
		// It moved (the library takes the first few pixels of a drag to start it), and
		// the notes moved exactly as far as the frame did.
		const dx = after.frame.x - before.frame.x;
		const dy = after.frame.y - before.frame.y;
		expect(dx).toBeGreaterThan(100);
		expect(dx).toBeLessThanOrEqual(120);
		expect(dy).toBeGreaterThan(55);
		expect(dy).toBeLessThanOrEqual(70);
		for (const key of ["a", "b"] as const) {
			expect(after[key].x - before[key].x).toBeCloseTo(dx, 0);
			expect(after[key].y - before[key].y).toBeCloseTo(dy, 0);
		}
		// What is not in the frame did not move, and the children are still in it.
		expect(after.outside).toEqual(before.outside);
		expect(within(after.a, after.frame)).toBe(true);
		expect(within(after.b, after.frame)).toBe(true);

		// Saved: the frame moved on the board and the children did not move in it.
		const saved = await storedBoard(artifactId);
		const byId = new Map(saved.nodes.map((node) => [node.id, node]));
		expect(byId.get(FRAME)?.position.x).toBeCloseTo(40 + dx, 0);
		expect(byId.get(FRAME)?.position.y).toBeCloseTo(40 + dy, 0);
		expect(byId.get(NOTE_A)?.position).toEqual({ x: 24, y: 48 });
		expect(byId.get(NOTE_A)?.parentId).toBe(FRAME);
		expect(byId.get(NOTE_B)?.position).toEqual({ x: 120, y: 150 });
		expect(byId.get(NOTE_B)?.parentId).toBe(FRAME);
		// One gesture, one version of the reader's (the seeded one was Alfy's).
		expect(await versionRows(artifactId)).toHaveLength(2);

		// And it is a step the reader can take back.
		await page.keyboard.press("Control+z");
		await expect
			.poll(async () => (await nodeBox(page, FRAME)).x)
			.toBeCloseTo(before.frame.x, 0);
		expect((await nodeBox(page, NOTE_A)).x).toBeCloseTo(before.a.x, 0);
		await page.keyboard.press("Control+Shift+z");
		await expect
			.poll(async () => (await nodeBox(page, FRAME)).x)
			.toBeCloseTo(after.frame.x, 0);
	});

	test("a frame that is not selected is not grabbed by its body: a drag on it is the board's", async ({
		page,
	}) => {
		await openBoard(page);
		const before = await boxes(page);
		const from = await inFrame(page, 300, 260);
		await dragBetween(page, from, { x: from.x + 60, y: from.y + 40 });
		const after = await boxes(page);
		expect(after.frame).toEqual(before.frame);
		expect(after.a).toEqual(before.a);
	});

	for (const handle of [
		{ name: "top-left", selector: ".handle.top.left", dx: -40, dy: -30 },
		{ name: "top", selector: ".line.top", dx: 0, dy: -30 },
		{ name: "top-right", selector: ".handle.top.right", dx: 40, dy: -30 },
		{ name: "right", selector: ".line.right", dx: 40, dy: 0 },
		{ name: "bottom-right", selector: ".handle.bottom.right", dx: 40, dy: 30 },
		{ name: "bottom", selector: ".line.bottom", dx: 0, dy: 30 },
		{ name: "bottom-left", selector: ".handle.bottom.left", dx: -40, dy: 30 },
		{ name: "left", selector: ".line.left", dx: -40, dy: 0 },
	] as const) {
		test(`the ${handle.name} handle resizes the frame, and the children stay where they are`, async ({
			page,
		}) => {
			const artifactId = await openBoard(page);
			const before = await boxes(page);
			await selectFrameByEmptyArea(page);
			const control = frameNode(page).locator(
				`.svelte-flow__resize-control${handle.selector}`,
			);
			await expect(control).toHaveCount(1);
			const at = await control.boundingBox();
			if (!at) throw new Error(`no ${handle.name} handle`);
			const from = handle.selector.startsWith(".line")
				? grabPoint(at, handle.name)
				: { x: at.x + at.width / 2, y: at.y + at.height / 2 };
			await dragBetween(page, from, {
				x: from.x + handle.dx,
				y: from.y + handle.dy,
			});
			await savedStatus(page);

			const after = await boxes(page);
			const growsLeft = handle.name.includes("left");
			const growsTop = handle.name.includes("top");
			const growsRight = handle.name.includes("right");
			const growsBottom = handle.name.includes("bottom");
			expect(after.frame.x).toBeCloseTo(
				before.frame.x + (growsLeft ? handle.dx : 0),
				0,
			);
			expect(after.frame.y).toBeCloseTo(
				before.frame.y + (growsTop ? handle.dy : 0),
				0,
			);
			expect(after.frame.width).toBeCloseTo(
				before.frame.width +
					(growsRight ? handle.dx : growsLeft ? -handle.dx : 0),
				0,
			);
			expect(after.frame.height).toBeCloseTo(
				before.frame.height +
					(growsBottom ? handle.dy : growsTop ? -handle.dy : 0),
				0,
			);
			// The notes are where they were on the screen, and inside.
			expect(after.a.x).toBeCloseTo(before.a.x, 0);
			expect(after.a.y).toBeCloseTo(before.a.y, 0);
			expect(after.b.x).toBeCloseTo(before.b.x, 0);
			expect(after.b.y).toBeCloseTo(before.b.y, 0);
			expect(within(after.a, after.frame)).toBe(true);
			expect(within(after.b, after.frame)).toBe(true);
			// One version, and the notes are still the frame's.
			expect(await versionRows(artifactId)).toHaveLength(2);
			const saved = await storedBoard(artifactId);
			expect(saved.nodes.find((node) => node.id === NOTE_A)?.parentId).toBe(
				FRAME,
			);
		});
	}

	test("a resize is a step the reader can undo", async ({ page }) => {
		await openBoard(page);
		const before = await nodeBox(page, FRAME);
		await selectFrameByEmptyArea(page);
		const at = await frameNode(page)
			.locator(".svelte-flow__resize-control.line.right")
			.boundingBox();
		if (!at) throw new Error("no right handle");
		const from = grabPoint(at, "right");
		await dragBetween(page, from, { x: from.x + 60, y: from.y });
		await savedStatus(page);
		expect((await nodeBox(page, FRAME)).width).toBeCloseTo(
			before.width + 60,
			0,
		);
		await page.keyboard.press("Control+z");
		await expect
			.poll(async () => (await nodeBox(page, FRAME)).width)
			.toBeCloseTo(before.width, 0);
	});

	for (const side of ["right", "bottom", "left", "top"] as const) {
		test(`the ${side} edge stops at the notes inside the frame when it is pulled in`, async ({
			page,
		}) => {
			await openBoard(page);
			const before = await boxes(page);
			await selectFrameByEmptyArea(page);
			const at = await frameNode(page)
				.locator(`.svelte-flow__resize-control.line.${side}`)
				.boundingBox();
			if (!at) throw new Error(`no ${side} handle`);
			const from = grabPoint(at, side);
			const far = {
				right: [-500, 0],
				left: [500, 0],
				bottom: [0, -500],
				top: [0, 500],
			}[side];
			await dragBetween(page, from, { x: from.x + far[0], y: from.y + far[1] });
			const after = await boxes(page);
			// Every note is still wholly inside, and stayed where it was.
			expect(within(after.a, after.frame)).toBe(true);
			expect(within(after.b, after.frame)).toBe(true);
			expect(after.a.x).toBeCloseTo(before.a.x, 0);
			expect(after.b.y).toBeCloseTo(before.b.y, 0);
			// The side stopped exactly at the nearest note: it is neither stuck at its old
			// place nor past the note.
			const stops = {
				right: [
					after.frame.x + after.frame.width,
					Math.max(before.a.x + before.a.width, before.b.x + before.b.width),
				],
				bottom: [
					after.frame.y + after.frame.height,
					Math.max(before.a.y + before.a.height, before.b.y + before.b.height),
				],
				left: [after.frame.x, Math.min(before.a.x, before.b.x)],
				top: [after.frame.y, Math.min(before.a.y, before.b.y)],
			}[side];
			expect(Math.abs(stops[0] - stops[1])).toBeLessThan(1.5);
		});
	}

	test("a selected frame's name, its anchors and its corners are not covered by the strips along its sides", async ({
		page,
	}) => {
		await openBoard(page);
		await selectFrameByEmptyArea(page);
		const topmost = (point: { x: number; y: number }, selector: string) =>
			page.evaluate(
				({ x, y, selector: wanted }) =>
					document.elementFromPoint(x, y)?.closest(wanted) !== null,
				{ ...point, selector },
			);
		const chip = await page.getByTestId("canvas-frame-label").boundingBox();
		if (!chip) throw new Error("no name chip");
		expect(
			await topmost(centreOf(chip), '[data-testid="canvas-frame-label"]'),
		).toBe(true);
		for (const side of ["top", "right", "bottom", "left"]) {
			const anchor = await frameNode(page)
				.locator(`.svelte-flow__handle[data-handleid="${side}"]`)
				.boundingBox();
			if (!anchor) throw new Error(`no ${side} anchor`);
			expect(
				await topmost(centreOf(anchor), ".svelte-flow__handle"),
				side,
			).toBe(true);
		}
		// The corners are the topmost of all, the name's own corner included (the chip
		// starts ten units from it).
		for (const corner of [
			"top.left",
			"top.right",
			"bottom.left",
			"bottom.right",
		]) {
			const handle = await frameNode(page)
				.locator(`.svelte-flow__resize-control.handle.${corner}`)
				.boundingBox();
			if (!handle) throw new Error(`no ${corner} corner`);
			const at = {
				x: handle.x + handle.width / 2,
				y: handle.y + handle.height / 2,
			};
			expect(
				await topmost(at, ".svelte-flow__resize-control.handle"),
				corner,
			).toBe(true);
		}
		// And the name still opens for renaming on a double-click.
		await page.getByTestId("canvas-frame-label").dblclick();
		await expect(
			page.getByRole("textbox", { name: "Frame name" }),
		).toBeFocused();
	});

	test("the arrow keys move a selected frame, with its children", async ({
		page,
	}) => {
		const artifactId = await openBoard(page);
		const before = await boxes(page);
		await selectFrameByEmptyArea(page);
		for (let press = 0; press < 4; press += 1) {
			await page.keyboard.press("ArrowRight");
		}
		await page.keyboard.press("ArrowDown");
		await savedStatus(page);
		const after = await boxes(page);
		const dx = after.frame.x - before.frame.x;
		const dy = after.frame.y - before.frame.y;
		expect(dx).toBeGreaterThan(0);
		expect(dy).toBeGreaterThan(0);
		expect(after.a.x - before.a.x).toBeCloseTo(dx, 0);
		expect(after.b.y - before.b.y).toBeCloseTo(dy, 0);
		expect(after.outside).toEqual(before.outside);
		const saved = await storedBoard(artifactId);
		expect(saved.nodes.find((node) => node.id === NOTE_A)?.position).toEqual({
			x: 24,
			y: 48,
		});
		await page.keyboard.press("Control+z");
		await expect
			.poll(async () => (await nodeBox(page, FRAME)).x)
			.toBeCloseTo(before.frame.x, 0);
	});

	test("Delete on the selected frame takes the frame and leaves its notes where they are", async ({
		page,
	}) => {
		const artifactId = await openBoard(page);
		const before = await boxes(page);
		await selectFrameByEmptyArea(page);
		await page.keyboard.press("Delete");
		await savedStatus(page);
		await expect(frameNode(page)).toHaveCount(0);
		const a = await nodeBox(page, NOTE_A);
		expect(a.x).toBeCloseTo(before.a.x, 0);
		expect(a.y).toBeCloseTo(before.a.y, 0);
		const saved = await storedBoard(artifactId);
		expect(saved.nodes.map((node) => node.id).sort()).toEqual(
			[NOTE_A, NOTE_B, OUTSIDE].sort(),
		);
		expect(
			saved.nodes.find((node) => node.id === NOTE_A)?.parentId,
		).toBeUndefined();
		await page.keyboard.press("Control+z");
		await expect(frameNode(page)).toHaveCount(1);
	});
});

test.describe("under a finger, on a phone", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

	type Touch = { x: number; y: number };

	/** One finger, through the browser's own touch input: down, along a straight line in steps, up. */
	async function drag(page: Page, from: Touch, to: Touch, steps = 10) {
		const client = await page.context().newCDPSession(page);
		await client.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ ...from, id: 1 }],
		});
		for (let step = 1; step <= steps; step += 1) {
			const t = step / steps;
			await client.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [
					{
						x: from.x + (to.x - from.x) * t,
						y: from.y + (to.y - from.y) * t,
						id: 1,
					},
				],
			});
		}
		await client.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
		await client.detach();
	}

	async function tapEmptyGround(page: Page) {
		const box = await nodeBox(page, FRAME);
		// On a narrow pane the frame runs past the edge: aim at the empty ground right of the notes.
		await page.touchscreen.tap(box.x + 300, box.y + 60);
		await expect.poll(() => selectedIds(page)).toEqual([FRAME]);
	}

	test("a tap in the frame's empty ground selects it", async ({ page }) => {
		await openBoard(page);
		expect(
			await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
		).toBe(true);
		await tapEmptyGround(page);
		await expect(
			frameNode(page).locator(".svelte-flow__resize-control.line"),
		).toHaveCount(4);
	});

	test("a finger drags the selected frame by its body, with its notes", async ({
		page,
	}) => {
		const artifactId = await openBoard(page);
		const before = await boxes(page);
		await tapEmptyGround(page);
		const from = { x: before.frame.x + 300, y: before.frame.y + 250 };
		await drag(page, from, { x: from.x - 40, y: from.y + 50 });
		await savedStatus(page);
		const after = await boxes(page);
		const dx = after.frame.x - before.frame.x;
		const dy = after.frame.y - before.frame.y;
		expect(dx).toBeLessThan(-25);
		expect(dy).toBeGreaterThan(30);
		expect(after.a.x - before.a.x).toBeCloseTo(dx, 0);
		expect(after.b.y - before.b.y).toBeCloseTo(dy, 0);
		const saved = await storedBoard(artifactId);
		expect(saved.nodes.find((node) => node.id === NOTE_A)?.position).toEqual({
			x: 24,
			y: 48,
		});
	});

	test("a finger resizes it from a side, whose strip is as tall as a fingertip", async ({
		page,
	}) => {
		await openBoard(page);
		const before = await nodeBox(page, FRAME);
		await tapEmptyGround(page);
		const strip = await frameNode(page)
			.locator(".svelte-flow__resize-control.line.bottom")
			.boundingBox();
		if (!strip) throw new Error("no bottom strip");
		expect(strip.height).toBeGreaterThanOrEqual(43);
		const from = grabPoint(strip, "bottom");
		await drag(page, from, { x: from.x, y: from.y + 60 });
		await expect
			.poll(async () => (await nodeBox(page, FRAME)).height)
			.toBeGreaterThan(before.height + 30);
	});
});
