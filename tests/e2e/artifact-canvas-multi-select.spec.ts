import { expect, type Page, test } from "@playwright/test";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import {
	cameraOf,
	dragBetween,
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// Several blocks at once (the owner's walk: "multi-select elements on the canvas and
// move them/resize them together"). Real pointer, keyboard and finger input on a
// seeded board. Select tool: a drag on empty board is a marquee that takes what it
// ENCLOSES (the whole of a block, so it never grabs a frame it only crosses);
// Shift-, Ctrl- and Cmd-click add and remove; panning stays on the Hand tool.

const CAMERA = { x: 16, y: 16, zoom: 1 };
const NOTE = { width: 150, height: 90 };

function note(
	id: string,
	x: number,
	y: number,
	text: string,
	parentId?: string,
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: NOTE.width,
		height: NOTE.height,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

/** Four notes in a square, one on its own to the right. */
function notesBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			note("a", 60, 60, "Museum"),
			note("b", 260, 60, "Lunch"),
			note("c", 60, 220, "Train"),
			note("d", 260, 220, "Hotel"),
			note("e", 480, 140, "Outside"),
		],
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
}

const FRAME_SIZE = { width: 360, height: 300 };

/** A frame holding two notes, and two notes beside it. */
function frameBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "frame",
				type: "frame",
				position: { x: 40, y: 40 },
				width: FRAME_SIZE.width,
				height: FRAME_SIZE.height,
				data: { kind: "frame", label: "Friday", ...FRAME_SIZE },
			},
			note("g", 24, 48, "Garden", "frame"),
			note("h", 180, 150, "Cafe", "frame"),
			note("out1", 520, 60, "Beside one"),
			note("out2", 520, 200, "Beside two"),
		],
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
}

async function open(page: Page, board: CanvasBody): Promise<string> {
	await login(page);
	const conversationId = await createConversation(page, "Multi select");
	const artifactId = await seedCanvas(conversationId, board);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return artifactId;
}

type Box = { x: number; y: number; width: number; height: number };

async function selectedIds(page: Page): Promise<string[]> {
	const ids = await page
		.locator(".svelte-flow__node.selected")
		.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute("data-id") ?? ""),
		);
	return ids.sort();
}

async function boxesOf(page: Page, ids: readonly string[]) {
	const boxes: Record<string, Box> = {};
	for (const id of ids) boxes[id] = await nodeBox(page, id);
	return boxes;
}

function union(boxes: readonly Box[]): Box {
	const left = Math.min(...boxes.map((box) => box.x));
	const top = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.width));
	const bottom = Math.max(...boxes.map((box) => box.y + box.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

const centreOf = (box: Box) => ({
	x: box.x + box.width / 2,
	y: box.y + box.height / 2,
});

/** A marquee from empty board: press, drag in steps, let go. */
async function marquee(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
) {
	await dragBetween(page, from, to, 16);
}

/** The marquee that encloses these blocks with a margin all round. */
async function marqueeAround(page: Page, ids: readonly string[], margin = 16) {
	const area = union(Object.values(await boxesOf(page, ids)));
	await marquee(
		page,
		{ x: area.x - margin, y: area.y - margin },
		{ x: area.x + area.width + margin, y: area.y + area.height + margin },
	);
}

async function selectWithMarquee(page: Page, ids: readonly string[]) {
	await marqueeAround(page, ids);
	await expect.poll(() => selectedIds(page)).toEqual([...ids].sort());
}

/** Picks these blocks the way a reader does: a click, then Shift-click for each more. */
async function pick(page: Page, ids: readonly string[]) {
	const [first, ...rest] = ids;
	await page.locator(`.svelte-flow__node[data-id="${first}"]`).click();
	for (const id of rest) {
		await page
			.locator(`.svelte-flow__node[data-id="${id}"]`)
			.click({ modifiers: ["Shift"] });
	}
	await expect.poll(() => selectedIds(page)).toEqual([...ids].sort());
}

const groupBox = (page: Page) => page.getByTestId("canvas-group-box");
const groupHandle = (page: Page, which: string) =>
	page.getByTestId(`canvas-group-handle-${which}`);

async function handleCentre(page: Page, which: string) {
	const box = await groupHandle(page, which).boundingBox();
	if (!box) throw new Error(`no group handle ${which}`);
	return centreOf(box);
}

/** What a handle drag should leave, from the boxes before it: the scale about the anchor, per axis. */
function scaled(
	box: Box,
	anchor: { x: number; y: number },
	sx: number,
	sy: number,
): Box {
	return {
		x: anchor.x + (box.x - anchor.x) * sx,
		y: anchor.y + (box.y - anchor.y) * sy,
		width: box.width * sx,
		height: box.height * sy,
	};
}

function expectBox(actual: Box, wanted: Box, tolerance = 2) {
	expect(Math.abs(actual.x - wanted.x)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(actual.y - wanted.y)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(actual.width - wanted.width)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(actual.height - wanted.height)).toBeLessThanOrEqual(
		tolerance,
	);
}

/** Counts the saves the board makes from now on (one gesture is one save). */
function countSaves(page: Page, artifactId: string) {
	let count = 0;
	page.on("request", (request) => {
		if (
			request.url().includes(`/api/artifacts/${artifactId}/body`) &&
			request.method() !== "GET"
		)
			count += 1;
	});
	return () => count;
}

const undo = (page: Page) => page.keyboard.press("Control+z");
const redo = (page: Page) => page.keyboard.press("Control+Shift+z");

test.describe("selecting several blocks", () => {
	test("Shift-click adds a block, and Shift-click on a selected one takes it out", async ({
		page,
	}) => {
		await open(page, notesBoard());
		await page.locator('.svelte-flow__node[data-id="a"]').click();
		await expect.poll(() => selectedIds(page)).toEqual(["a"]);
		await page
			.locator('.svelte-flow__node[data-id="b"]')
			.click({ modifiers: ["Shift"] });
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b"]);
		await page
			.locator('.svelte-flow__node[data-id="c"]')
			.click({ modifiers: ["Shift"] });
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b", "c"]);
		await page
			.locator('.svelte-flow__node[data-id="b"]')
			.click({ modifiers: ["Shift"] });
		await expect.poll(() => selectedIds(page)).toEqual(["a", "c"]);
		// A plain click picks one block again.
		await page.locator('.svelte-flow__node[data-id="d"]').click();
		await expect.poll(() => selectedIds(page)).toEqual(["d"]);
	});

	test("Cmd-click adds a block too, and takes a picked one out", async ({
		page,
	}) => {
		await open(page, notesBoard());
		await page.locator('.svelte-flow__node[data-id="a"]').click();
		await page
			.locator('.svelte-flow__node[data-id="b"]')
			.click({ modifiers: ["Meta"] });
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b"]);
		await page
			.locator('.svelte-flow__node[data-id="a"]')
			.click({ modifiers: ["Meta"] });
		await expect.poll(() => selectedIds(page)).toEqual(["b"]);
	});

	test("Ctrl-click adds a block too", async ({ page }) => {
		// On a Mac a Ctrl-click is a right click (the browser sends the context menu and the
		// board drops the held keys): there the Cmd-click above is the chord.
		test.skip(
			process.platform === "darwin",
			"Ctrl-click is a right click on a Mac",
		);
		await open(page, notesBoard());
		await page.locator('.svelte-flow__node[data-id="a"]').click();
		await page
			.locator('.svelte-flow__node[data-id="b"]')
			.click({ modifiers: ["Control"] });
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b"]);
	});

	test("a marquee takes what it encloses, never a block it only crosses, and leaves the camera", async ({
		page,
	}) => {
		await open(page, notesBoard());
		const before = await cameraOf(page);
		const boxes = await boxesOf(page, ["a", "b", "c", "d"]);
		// Around the top row, and half way over the lower one.
		await marquee(
			page,
			{ x: boxes.a.x - 20, y: boxes.a.y - 20 },
			{ x: boxes.b.x + boxes.b.width + 20, y: boxes.c.y + 30 },
		);
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b"]);
		expect(await cameraOf(page)).toEqual(before);
		// Around all four: all four.
		await page.mouse.click(boxes.d.x + 300, boxes.d.y + 200);
		await selectWithMarquee(page, ["a", "b", "c", "d"]);
	});

	test("a marquee drawn inside a frame takes the notes in it, not the frame", async ({
		page,
	}) => {
		await open(page, frameBoard());
		const frame = await nodeBox(page, "frame");
		await marquee(
			page,
			{ x: frame.x + 8, y: frame.y + 36 },
			{ x: frame.x + frame.width - 8, y: frame.y + frame.height - 8 },
		);
		await expect.poll(() => selectedIds(page)).toEqual(["g", "h"]);
	});

	test("Escape clears the selection, and a drag on the Hand tool pans without selecting", async ({
		page,
	}) => {
		await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b"]);
		// The box (and with it this key) arrives a beat after the second block is picked.
		await expect(groupBox(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect.poll(() => selectedIds(page)).toEqual([]);
		await expect(groupBox(page)).toHaveCount(0);

		const before = await cameraOf(page);
		await page.getByTestId("canvas-tool-pan").click();
		const boxes = await boxesOf(page, ["a", "d"]);
		await dragBetween(
			page,
			{ x: boxes.a.x - 20, y: boxes.a.y - 20 },
			{ x: boxes.d.x + 200, y: boxes.d.y + 120 },
		);
		expect(await selectedIds(page)).toEqual([]);
		const after = await cameraOf(page);
		expect(after.x).toBeGreaterThan(before.x + 100);
	});
});

test.describe("panning stays where it was", () => {
	test("Space and a drag, and the middle button, pan the board and pick nothing", async ({
		page,
	}) => {
		await open(page, notesBoard());
		const boxes = await boxesOf(page, ["a", "d"]);
		const from = { x: boxes.a.x - 30, y: boxes.d.y + boxes.d.height + 60 };
		const before = await cameraOf(page);
		await page.keyboard.down("Space");
		await dragBetween(page, from, { x: from.x + 90, y: from.y + 40 });
		await page.keyboard.up("Space");
		const afterSpace = await cameraOf(page);
		expect(afterSpace.x - before.x).toBeGreaterThan(60);
		expect(afterSpace.y - before.y).toBeGreaterThan(20);
		expect(await selectedIds(page)).toEqual([]);

		await page.mouse.move(from.x, from.y);
		await page.mouse.down({ button: "middle" });
		await page.mouse.move(from.x - 70, from.y - 30, { steps: 10 });
		await page.mouse.up({ button: "middle" });
		const afterMiddle = await cameraOf(page);
		expect(afterSpace.x - afterMiddle.x).toBeGreaterThan(40);
		expect(afterSpace.y - afterMiddle.y).toBeGreaterThan(15);
		expect(await selectedIds(page)).toEqual([]);
	});
});

test.describe("the box around several blocks", () => {
	test("two selected blocks get one box with eight handles, and give up their own corners and toolbars", async ({
		page,
	}) => {
		await open(page, notesBoard());
		await page.locator('.svelte-flow__node[data-id="a"]').click();
		// One block: its own corners and toolbar, no group box.
		await expect(groupBox(page)).toHaveCount(0);
		await expect(page.getByTestId("canvas-node-toolbar")).toHaveCount(1);
		await page
			.locator('.svelte-flow__node[data-id="d"]')
			.click({ modifiers: ["Shift"] });
		await expect(groupBox(page)).toBeVisible();
		for (const which of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
			await expect(groupHandle(page, which)).toBeVisible();
		}
		await expect(page.getByTestId("canvas-node-toolbar")).toHaveCount(0);
		await expect(page.locator(".svelte-flow__resize-control")).toHaveCount(0);
		await expect(page.getByTestId("canvas-group-toolbar")).toBeVisible();
		// It hugs the two blocks, a few pixels out.
		const boxes = await boxesOf(page, ["a", "d"]);
		const around = union([boxes.a, boxes.d]);
		const drawn = await groupBox(page).boundingBox();
		if (!drawn) throw new Error("no group box");
		expect(drawn.x).toBeLessThanOrEqual(around.x);
		expect(drawn.x).toBeGreaterThan(around.x - 14);
		expect(drawn.y).toBeLessThanOrEqual(around.y);
		expect(drawn.y).toBeGreaterThan(around.y - 14);
		expect(drawn.x + drawn.width).toBeGreaterThanOrEqual(
			around.x + around.width,
		);
		expect(drawn.x + drawn.width).toBeLessThan(around.x + around.width + 14);
		// Down to one block: the box goes and the block's own controls come back.
		await page
			.locator('.svelte-flow__node[data-id="d"]')
			.click({ modifiers: ["Shift"] });
		await expect(groupBox(page)).toHaveCount(0);
		await expect(page.getByTestId("canvas-node-toolbar")).toHaveCount(1);
	});
});

test.describe("moving together", () => {
	test("dragging one selected block moves them all, as one step and one save", async ({
		page,
	}) => {
		const artifactId = await open(page, notesBoard());
		await pick(page, ["a", "b", "c"]);
		const before = await boxesOf(page, ["a", "b", "c", "d", "e"]);
		const saves = countSaves(page, artifactId);
		const from = centreOf(before.b);
		await dragBetween(page, from, { x: from.x + 90, y: from.y + 70 });
		await savedStatus(page);
		const after = await boxesOf(page, ["a", "b", "c", "d", "e"]);
		// The library starts a drag one step into the move, so it falls a little short of the
		// pointer's 90 x 70; what matters is that all three went by the same amount.
		const dx = after.a.x - before.a.x;
		const dy = after.a.y - before.a.y;
		expect(dx).toBeGreaterThan(70);
		expect(dx).toBeLessThanOrEqual(90.5);
		expect(dy).toBeGreaterThan(50);
		for (const id of ["b", "c"]) {
			expect(after[id].x - before[id].x).toBeCloseTo(dx, 0);
			expect(after[id].y - before[id].y).toBeCloseTo(dy, 0);
		}
		expect(after.d).toEqual(before.d);
		expect(after.e).toEqual(before.e);
		expect(saves()).toBe(1);
		// The group box went with them.
		await expect(groupBox(page)).toBeVisible();
		// Stored: the three moved by the same amount, the others stayed.
		const stored = await storedBoard(artifactId);
		const at = (id: string) =>
			stored.nodes.find((node) => node.id === id)?.position ?? { x: 0, y: 0 };
		expect(at("a").x - 60).toBeCloseTo(dx, 0);
		expect(at("b").x - 260).toBeCloseTo(dx, 0);
		expect(at("c").y - 220).toBeCloseTo(dy, 0);
		expect(at("d")).toEqual({ x: 260, y: 220 });
		// One Undo takes all three back; one Redo puts them forward.
		await undo(page);
		await expect
			.poll(async () => (await nodeBox(page, "a")).x)
			.toBeCloseTo(before.a.x, 0);
		expect((await nodeBox(page, "b")).x).toBeCloseTo(before.b.x, 0);
		expect((await nodeBox(page, "c")).y).toBeCloseTo(before.c.y, 0);
		await redo(page);
		await expect
			.poll(async () => (await nodeBox(page, "c")).y)
			.toBeCloseTo(after.c.y, 0);
		expect((await nodeBox(page, "a")).x).toBeCloseTo(after.a.x, 0);
	});

	test("the arrow keys nudge every selected block", async ({ page }) => {
		const artifactId = await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b"]);
		const before = await boxesOf(page, ["a", "b", "c"]);
		// The library nudges one snap step, 5 px, a press (20 with Shift).
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowDown");
		await expect
			.poll(async () => (await nodeBox(page, "b")).x - before.b.x)
			.toBeCloseTo(10, 0);
		const after = await boxesOf(page, ["a", "b", "c"]);
		expect(after.a.x - before.a.x).toBeCloseTo(10, 0);
		expect(after.a.y - before.a.y).toBeCloseTo(5, 0);
		expect(after.b.y - before.b.y).toBeCloseTo(5, 0);
		expect(after.c).toEqual(before.c);
		await savedStatus(page);
		const stored = await storedBoard(artifactId);
		expect(stored.nodes.find((node) => node.id === "a")?.position).toEqual({
			x: 70,
			y: 65,
		});
		await undo(page);
		await expect
			.poll(async () => (await nodeBox(page, "a")).x)
			.toBeCloseTo(before.a.x, 0);
		expect((await nodeBox(page, "b")).x).toBeCloseTo(before.b.x, 0);
	});

	test("two notes dragged out of a frame leave it together, and two dragged in join it together", async ({
		page,
	}) => {
		const artifactId = await open(page, frameBoard());
		await selectWithMarquee(page, ["g", "h"]);
		const before = await boxesOf(page, ["g", "h"]);
		// Out, to the empty ground below the frame.
		const from = centreOf(before.g);
		await dragBetween(page, from, { x: from.x + 40, y: from.y + 330 }, 20);
		await savedStatus(page);
		const stored = await storedBoard(artifactId);
		const g = stored.nodes.find((node) => node.id === "g");
		const h = stored.nodes.find((node) => node.id === "h");
		expect(g?.parentId).toBeUndefined();
		expect(h?.parentId).toBeUndefined();
		// Where they were, in board coordinates, plus the same move for both (the frame's
		// corner is at 40, 40; the library starts a drag a step into the pointer's 40 x 330).
		const moved = {
			x: (g?.position.x ?? 0) - (40 + 24),
			y: (g?.position.y ?? 0) - (40 + 48),
		};
		expect(moved.x).toBeGreaterThan(25);
		expect(moved.y).toBeGreaterThan(300);
		expect((h?.position.x ?? 0) - (40 + 180)).toBeCloseTo(moved.x, 0);
		expect((h?.position.y ?? 0) - (40 + 150)).toBeCloseTo(moved.y, 0);
		await undo(page);
		await expect
			.poll(async () => {
				const board = await storedBoard(artifactId);
				return board.nodes.find((node) => node.id === "g")?.parentId;
			})
			.toBe("frame");

		// And in: the two notes beside the frame, dropped into its empty ground.
		await page.mouse.click(10, 10);
		await selectWithMarquee(page, ["out1", "out2"]);
		const outside = await boxesOf(page, ["out1", "frame"]);
		const grab = centreOf(outside.out1);
		await dragBetween(
			page,
			grab,
			{
				x: outside.frame.x + 150,
				y: outside.frame.y + 90,
			},
			20,
		);
		// The status still says "Saved" from the first move: wait for the board itself.
		const parentOf = async (id: string) =>
			(await storedBoard(artifactId)).nodes.find((node) => node.id === id)
				?.parentId;
		await expect.poll(() => parentOf("out1")).toBe("frame");
		await expect.poll(() => parentOf("out2")).toBe("frame");
	});
});

test.describe("resizing together", () => {
	test("the bottom-right handle scales the blocks' places and sizes with the box", async ({
		page,
	}) => {
		const artifactId = await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b", "c", "d"]);
		const ids = ["a", "b", "c", "d"] as const;
		const before = await boxesOf(page, [...ids, "e"]);
		const area = union(ids.map((id) => before[id]));
		const saves = countSaves(page, artifactId);
		const from = await handleCentre(page, "se");
		await dragBetween(page, from, { x: from.x + 120, y: from.y + 60 }, 16);
		await savedStatus(page);
		const sx = (area.width + 120) / area.width;
		const sy = (area.height + 60) / area.height;
		const anchor = { x: area.x, y: area.y };
		for (const id of ids) {
			expectBox(await nodeBox(page, id), scaled(before[id], anchor, sx, sy));
		}
		expect(await nodeBox(page, "e")).toEqual(before.e);
		// The box follows what it holds.
		const drawn = await groupBox(page).boundingBox();
		if (!drawn) throw new Error("no group box");
		expect(drawn.x + drawn.width).toBeGreaterThan(area.x + area.width + 100);
		expect(saves()).toBe(1);
		// Stored the same way: positions in board units, sizes on the blocks.
		const stored = await storedBoard(artifactId);
		const d = stored.nodes.find((node) => node.id === "d");
		expect(d?.width).toBeCloseTo(NOTE.width * sx, 0);
		expect(d?.height).toBeCloseTo(NOTE.height * sy, 0);
		// One Undo: all four back where they were. One Redo: forward again.
		await undo(page);
		for (const id of ids) {
			await expect
				.poll(async () => (await nodeBox(page, id)).width)
				.toBeCloseTo(before[id].width, 0);
			expectBox(await nodeBox(page, id), before[id], 1);
		}
		await redo(page);
		await expect
			.poll(async () => (await nodeBox(page, "d")).width)
			.toBeCloseTo(before.d.width * sx, 0);
	});

	test("the top-left handle holds the opposite corner still", async ({
		page,
	}) => {
		await open(page, notesBoard());
		await pick(page, ["a", "d"]);
		const before = await boxesOf(page, ["a", "d"]);
		const area = union([before.a, before.d]);
		const from = await handleCentre(page, "nw");
		await dragBetween(page, from, { x: from.x - 60, y: from.y - 40 }, 14);
		const sx = (area.width + 60) / area.width;
		const sy = (area.height + 40) / area.height;
		const anchor = { x: area.x + area.width, y: area.y + area.height };
		await expect
			.poll(async () => (await nodeBox(page, "a")).width)
			.toBeCloseTo(before.a.width * sx, 0);
		expectBox(await nodeBox(page, "a"), scaled(before.a, anchor, sx, sy));
		expectBox(await nodeBox(page, "d"), scaled(before.d, anchor, sx, sy));
		const d = await nodeBox(page, "d");
		expect(d.x + d.width).toBeCloseTo(area.x + area.width, 0);
		expect(d.y + d.height).toBeCloseTo(area.y + area.height, 0);
	});

	test("an edge handle scales one way only", async ({ page }) => {
		await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b", "c", "d"]);
		const ids = ["a", "b", "c", "d"] as const;
		const before = await boxesOf(page, ids);
		const area = union(ids.map((id) => before[id]));
		const from = await handleCentre(page, "e");
		await dragBetween(page, from, { x: from.x + 70, y: from.y + 40 }, 12);
		const sx = (area.width + 70) / area.width;
		await expect
			.poll(async () => (await nodeBox(page, "d")).width)
			.toBeCloseTo(before.d.width * sx, 0);
		for (const id of ids) {
			const now = await nodeBox(page, id);
			// Heights and tops did not move: the drag's vertical part is ignored.
			expect(now.height).toBeCloseTo(before[id].height, 0);
			expect(now.y).toBeCloseTo(before[id].y, 0);
			expect(now.x).toBeCloseTo(area.x + (before[id].x - area.x) * sx, 0);
		}
	});

	test("it shrinks no further than the smallest a block may be, and what is left is still in proportion", async ({
		page,
	}) => {
		await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b", "c", "d"]);
		const ids = ["a", "b", "c", "d"] as const;
		const before = await boxesOf(page, ids);
		const area = union(ids.map((id) => before[id]));
		const from = await handleCentre(page, "se");
		// Far past the opposite corner.
		await dragBetween(page, from, { x: area.x - 40, y: area.y - 40 }, 20);
		// The note's smallest is 96 x 64: the box stops where its first block does.
		const small = await boxesOf(page, ids);
		for (const id of ids) {
			expect(small[id].width).toBeGreaterThanOrEqual(95);
			expect(small[id].height).toBeGreaterThanOrEqual(63);
		}
		const shrunk = union(ids.map((id) => small[id]));
		expect(shrunk.width).toBeGreaterThan(0);
		// Same scale on every block: the arrangement kept its shape.
		const sx = small.a.width / before.a.width;
		const sy = small.a.height / before.a.height;
		for (const id of ids) {
			expect(small[id].width / before[id].width).toBeCloseTo(sx, 1);
			expect(small[id].height / before[id].height).toBeCloseTo(sy, 1);
			expect(small[id].x).toBeCloseTo(area.x + (before[id].x - area.x) * sx, 0);
		}
		// It is as small as it can be on the axis that ran out first.
		expect(
			Math.min(small.a.width - 96, small.a.height - 64),
		).toBeLessThanOrEqual(1.5);
	});

	test("a pause in the middle of a drag does not split it into two steps", async ({
		page,
	}) => {
		const artifactId = await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b", "c", "d"]);
		const before = await boxesOf(page, ["a", "d"]);
		const saves = countSaves(page, artifactId);
		const from = await handleCentre(page, "se");
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x + 50, from.y + 30, { steps: 6 });
		// Longer than the board's settle delay: it still holds the step open.
		await page.waitForTimeout(900);
		await page.mouse.move(from.x + 100, from.y + 60, { steps: 6 });
		await page.mouse.up();
		await expect.poll(saves).toBe(1);
		await page.waitForTimeout(1200);
		expect(saves()).toBe(1);
		await undo(page);
		await expect
			.poll(async () => (await nodeBox(page, "d")).width)
			.toBeCloseTo(before.d.width, 0);
		expectBox(await nodeBox(page, "a"), before.a, 1);
	});

	test("Escape while dragging a handle puts everything back", async ({
		page,
	}) => {
		await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b"]);
		const before = await boxesOf(page, ["a", "b"]);
		const from = await handleCentre(page, "se");
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x + 80, from.y + 50, { steps: 8 });
		expect((await nodeBox(page, "b")).width).toBeGreaterThan(
			before.b.width + 5,
		);
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await expect
			.poll(async () => (await nodeBox(page, "b")).width)
			.toBeCloseTo(before.b.width, 0);
		expectBox(await nodeBox(page, "a"), before.a, 1);
		// The selection is still there: Escape cancelled the gesture, nothing more.
		expect(await selectedIds(page)).toEqual(["a", "b"]);
	});

	test("a selected frame takes the notes in it along when the box is resized", async ({
		page,
	}) => {
		const artifactId = await open(page, frameBoard());
		await page.locator('.svelte-flow__node[data-id="out1"]').click();
		// The frame and a note beside it, picked by Shift-click on the frame's chip.
		const frameBefore = await nodeBox(page, "frame");
		await page.keyboard.down("Shift");
		await page.mouse.click(frameBefore.x + 300, frameBefore.y + 70);
		await page.keyboard.up("Shift");
		await expect.poll(() => selectedIds(page)).toEqual(["frame", "out1"]);
		const before = await boxesOf(page, ["frame", "g", "h", "out1"]);
		const area = union([before.frame, before.out1]);
		const from = await handleCentre(page, "se");
		await dragBetween(page, from, { x: from.x + 100, y: from.y + 80 }, 14);
		await savedStatus(page);
		const sx = (area.width + 100) / area.width;
		const sy = (area.height + 80) / area.height;
		const anchor = { x: area.x, y: area.y };
		for (const id of ["frame", "g", "h", "out1"]) {
			expectBox(
				await nodeBox(page, id),
				scaled(before[id], anchor, sx, sy),
				2.5,
			);
		}
		// They are still its notes.
		const stored = await storedBoard(artifactId);
		expect(stored.nodes.find((node) => node.id === "g")?.parentId).toBe(
			"frame",
		);
		expect(stored.nodes.find((node) => node.id === "h")?.parentId).toBe(
			"frame",
		);
		await undo(page);
		await expect
			.poll(async () => (await nodeBox(page, "frame")).width)
			.toBeCloseTo(before.frame.width, 0);
		expectBox(await nodeBox(page, "g"), before.g, 1);
	});

	test("the group is the same after a reload", async ({ page }) => {
		const artifactId = await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b"]);
		const from = await handleCentre(page, "se");
		await dragBetween(page, from, { x: from.x + 90, y: from.y + 30 }, 12);
		await savedStatus(page);
		const stored = await storedBoard(artifactId);
		const b = stored.nodes.find((node) => node.id === "b");
		expect(b?.width).toBeGreaterThan(NOTE.width + 20);
		const grown = await nodeBox(page, "b");
		await page.reload();
		await openCanvasPanel(page);
		expectBox(await nodeBox(page, "b"), grown, 1.5);
	});
});

test.describe("deleting together", () => {
	test("Delete removes every selected block, as one step", async ({ page }) => {
		const artifactId = await open(page, notesBoard());
		await pick(page, ["a", "b", "c"]);
		await page.keyboard.press("Delete");
		await expect(page.locator('.svelte-flow__node[data-id="a"]')).toHaveCount(
			0,
		);
		await expect(page.locator('.svelte-flow__node[data-id="c"]')).toHaveCount(
			0,
		);
		await expect(page.locator('.svelte-flow__node[data-id="d"]')).toHaveCount(
			1,
		);
		await savedStatus(page);
		expect((await storedBoard(artifactId)).nodes.map((n) => n.id)).toEqual([
			"d",
			"e",
		]);
		await undo(page);
		await expect(page.locator(".svelte-flow__node")).toHaveCount(5);
	});

	test("the group toolbar's Delete does the same, and says how many", async ({
		page,
	}) => {
		const artifactId = await open(page, notesBoard());
		await selectWithMarquee(page, ["a", "b"]);
		const button = page.getByRole("button", { name: "Delete 2 blocks" });
		await expect(button).toBeVisible();
		await button.click();
		await expect(page.locator(".svelte-flow__node")).toHaveCount(3);
		await savedStatus(page);
		expect((await storedBoard(artifactId)).nodes.map((n) => n.id)).toEqual([
			"c",
			"d",
			"e",
		]);
	});

	test("a deleted frame leaves the notes it held where they are", async ({
		page,
	}) => {
		const artifactId = await open(page, frameBoard());
		const frame = await nodeBox(page, "frame");
		await page.mouse.click(frame.x + 300, frame.y + 70);
		await page
			.locator('.svelte-flow__node[data-id="out1"]')
			.click({ modifiers: ["Shift"] });
		await expect.poll(() => selectedIds(page)).toEqual(["frame", "out1"]);
		await page.keyboard.press("Delete");
		await expect(
			page.locator('.svelte-flow__node[data-id="frame"]'),
		).toHaveCount(0);
		await savedStatus(page);
		const stored = await storedBoard(artifactId);
		expect(stored.nodes.map((node) => node.id).sort()).toEqual([
			"g",
			"h",
			"out2",
		]);
		expect(stored.nodes.every((node) => node.parentId === undefined)).toBe(
			true,
		);
	});
});

test.describe("on a phone", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

	function phoneBoard(): CanvasBody {
		const small = (id: string, x: number, y: number, text: string) => ({
			...note(id, x, y, text),
			width: 110,
			height: 70,
		});
		return {
			version: 1,
			nodes: [
				small("a", 24, 100, "Museum"),
				small("b", 170, 100, "Lunch"),
				small("c", 24, 230, "Train"),
				small("d", 170, 230, "Hotel"),
			],
			edges: [],
			viewport: { x: 0, y: 0, zoom: 1 },
			annotations: [],
		};
	}

	type Touch = { x: number; y: number };

	/** One finger, through the browser's own touch input: down, hold, along a line, up. */
	async function finger(
		page: Page,
		from: Touch,
		to: Touch,
		options: { hold?: number; steps?: number } = {},
	) {
		const client = await page.context().newCDPSession(page);
		await client.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ ...from, id: 1 }],
		});
		if (options.hold) await page.waitForTimeout(options.hold);
		const steps = options.steps ?? 1;
		for (let step = 1; step <= steps; step += 1) {
			if (from.x === to.x && from.y === to.y) break;
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

	const longPress = (page: Page, at: Touch) =>
		finger(page, at, at, { hold: 700 });

	test("a long press starts a selection, taps add and remove, a tap on the board ends it", async ({
		page,
	}) => {
		await open(page, phoneBoard());
		const boxes = await boxesOf(page, ["a", "b", "c", "d"]);
		await longPress(page, centreOf(boxes.a));
		await expect.poll(() => selectedIds(page)).toEqual(["a"]);
		await page.touchscreen.tap(centreOf(boxes.b).x, centreOf(boxes.b).y);
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b"]);
		await page.touchscreen.tap(centreOf(boxes.d).x, centreOf(boxes.d).y);
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b", "d"]);
		await page.touchscreen.tap(centreOf(boxes.b).x, centreOf(boxes.b).y);
		await expect.poll(() => selectedIds(page)).toEqual(["a", "d"]);
		await page.touchscreen.tap(300, 700);
		await expect.poll(() => selectedIds(page)).toEqual([]);
		// Without a long press a tap is the old tap: it picks one block.
		await page.touchscreen.tap(centreOf(boxes.c).x, centreOf(boxes.c).y);
		await page.touchscreen.tap(centreOf(boxes.b).x, centreOf(boxes.b).y);
		await expect.poll(() => selectedIds(page)).toEqual(["b"]);
	});

	test("a finger drags the selection and resizes it from handles a fingertip wide", async ({
		page,
	}) => {
		const artifactId = await open(page, phoneBoard());
		const boxes = await boxesOf(page, ["a", "b", "c", "d"]);
		await longPress(page, centreOf(boxes.a));
		await page.touchscreen.tap(centreOf(boxes.b).x, centreOf(boxes.b).y);
		await expect.poll(() => selectedIds(page)).toEqual(["a", "b"]);
		await expect(groupBox(page)).toBeVisible();
		// Corners, and the edges long enough for two fingertips to tell apart: 44 px each.
		for (const which of ["nw", "ne", "se", "sw", "n", "s"]) {
			const handle = await groupHandle(page, which).boundingBox();
			expect(handle?.width).toBeGreaterThanOrEqual(43);
			expect(handle?.height).toBeGreaterThanOrEqual(43);
		}
		const trash = await page.getByTestId("canvas-group-delete").boundingBox();
		expect(trash?.width).toBeGreaterThanOrEqual(43);
		expect(trash?.height).toBeGreaterThanOrEqual(43);
		// The two blocks are 70 px tall: no room for a left and right handle between the corners.
		await expect(groupHandle(page, "e")).toHaveCount(0);
		await expect(groupHandle(page, "w")).toHaveCount(0);
		// Drag by a selected block: both go, by the same amount (the browser holds back the first
		// 15 px or so of a finger's travel as slop, so it falls short of the finger's 60).
		const from = centreOf(boxes.b);
		await finger(page, from, { x: from.x + 30, y: from.y + 70 }, { steps: 10 });
		await expect
			.poll(async () => (await nodeBox(page, "a")).y - boxes.a.y)
			.toBeGreaterThan(25);
		const movedA = await nodeBox(page, "a");
		const movedB = await nodeBox(page, "b");
		expect(movedB.x - boxes.b.x).toBeCloseTo(movedA.x - boxes.a.x, 0);
		expect(movedB.y - boxes.b.y).toBeCloseTo(movedA.y - boxes.a.y, 0);
		expect((await nodeBox(page, "c")).y).toBeCloseTo(boxes.c.y, 0);
		// Resize from the bottom-right handle.
		const before = await boxesOf(page, ["a", "b"]);
		const area = union([before.a, before.b]);
		const grip = await handleCentre(page, "se");
		await finger(page, grip, { x: grip.x + 30, y: grip.y + 40 }, { steps: 10 });
		const sx = (area.width + 30) / area.width;
		await expect
			.poll(async () => (await nodeBox(page, "b")).width)
			.toBeCloseTo(before.b.width * sx, 0);
		await savedStatus(page);
		const stored = await storedBoard(artifactId);
		expect(stored.nodes.find((node) => node.id === "b")?.width).toBeCloseTo(
			110 * sx,
			0,
		);
	});
});
