import { expect, type Page, test } from "@playwright/test";
import type {
	Annotation,
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
	storedAnnotations,
	storedBoard,
	versionRows,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// The drawing layer on the Canvas (Feature 2 · Artifacts, Slice 3, T4): the
// pen, the highlighter, shapes, text and the eraser, drawn in board
// coordinates above the frames, on a pad that is sized from the visible pane.
// Each trap the prototype measured is a test here, not a hope.

const CAMERA = { x: 16, y: 16, zoom: 1 };

function sticky(
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
		width: 190,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

function frame(id: string, x: number, y: number, label: string): CanvasNode {
	return {
		id,
		type: "frame",
		position: { x, y },
		width: 320,
		height: 230,
		data: { kind: "frame", label, width: 320, height: 230 },
	};
}

function board(
	nodes: CanvasNode[],
	annotations: Annotation[] = [],
	camera = CAMERA,
): CanvasBody {
	return { version: 1, nodes, edges: [], viewport: camera, annotations };
}

function pen(
	id: string,
	points: { x: number; y: number }[],
	color = "var(--ink-blue)",
): Annotation {
	return { id, kind: "pen", color, size: 4, points };
}

async function open(page: Page, body: CanvasBody) {
	const conversationId = await createConversation(page, "Drawing");
	const artifactId = await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return artifactId;
}

async function chooseTool(page: Page, tool: string) {
	const draw = page.getByTestId("canvas-tool-draw");
	if ((await draw.getAttribute("aria-pressed")) !== "true") await draw.click();
	await page.getByTestId(`canvas-tool-${tool}`).click();
	await expect(page.getByTestId("canvas-board")).toHaveAttribute(
		"data-tool",
		tool,
	);
}

/** Where a board point is on the screen right now. */
async function screenOf(page: Page, point: { x: number; y: number }) {
	const camera = await cameraOf(page);
	const pane = await page.locator(".svelte-flow__pane").boundingBox();
	if (!pane) throw new Error("no pane");
	return {
		x: pane.x + camera.x + point.x * camera.zoom,
		y: pane.y + camera.y + point.y * camera.zoom,
	};
}

test.describe("the drawing layer on the Canvas", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("draws a pen stroke, and it lands in the saved board in board coordinates", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([sticky("note-a", 60, 120, "Museum")]),
		);
		await chooseTool(page, "pen");
		const from = await screenOf(page, { x: 300, y: 100 });
		const to = await screenOf(page, { x: 420, y: 220 });
		await dragBetween(page, from, to, 12);
		await expect(page.getByTestId("canvas-mark")).toHaveCount(1);
		await savedStatus(page);

		const marks = await storedAnnotations(artifactId);
		expect(marks).toHaveLength(1);
		expect(marks[0]).toMatchObject({
			kind: "pen",
			color: "var(--ink-blue)",
			size: 4,
		});
		expect(marks[0].id).toMatch(/^pen-/);
		const points = marks[0].points ?? [];
		expect(points.length).toBeGreaterThan(4);
		// Board coordinates: the camera and the panel's own offset are not in them.
		expect(points[0].x).toBeCloseTo(300, -1);
		expect(points[0].y).toBeCloseTo(100, -1);
		const last = points[points.length - 1];
		expect(last.x).toBeCloseTo(420, -1);
		expect(last.y).toBeCloseTo(220, -1);
	});

	test("does not pan the board while the pen is active", async ({ page }) => {
		await open(page, board([sticky("note-a", 60, 120, "Museum")]));
		await chooseTool(page, "pen");
		const before = await cameraOf(page);
		await dragBetween(
			page,
			await screenOf(page, { x: 300, y: 100 }),
			await screenOf(page, { x: 420, y: 260 }),
		);
		expect(await cameraOf(page)).toEqual(before);
	});

	test("keeps a stroke glued to its block across a zoom", async ({ page }) => {
		await open(page, board([sticky("note-a", 60, 120, "Museum")]));
		await chooseTool(page, "pen");
		await dragBetween(
			page,
			await screenOf(page, { x: 80, y: 150 }),
			await screenOf(page, { x: 220, y: 190 }),
			12,
		);
		await expect(page.getByTestId("canvas-mark")).toHaveCount(1);
		const relative = async () => {
			const stroke = await page
				.locator('[data-testid="canvas-mark"] path')
				.first()
				.boundingBox();
			const note = await nodeBox(page, "note-a");
			if (!stroke) throw new Error("no stroke");
			return {
				left: (stroke.x - note.x) / note.width,
				width: stroke.width / note.width,
				top: (stroke.y - note.y) / note.width,
			};
		};
		const before = await relative();
		const zoomBefore = (await cameraOf(page)).zoom;
		await page.getByTestId("canvas-zoom-in").click();
		await expect
			.poll(async () => (await cameraOf(page)).zoom)
			.toBeGreaterThan(zoomBefore);
		await page.waitForTimeout(400);
		const after = await relative();
		expect(after.left).toBeCloseTo(before.left, 1);
		expect(after.width).toBeCloseTo(before.width, 1);
		expect(after.top).toBeCloseTo(before.top, 1);
	});

	test("draws above a note that sits inside a frame, instead of dragging the note under it", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame("frame-a", 20, 20, "Friday"),
				sticky("note-a", 40, 70, "Museum", "frame-a"),
			]),
		);
		await chooseTool(page, "pen");
		const note = await nodeBox(page, "note-a");
		// The layer answers for a point over the note, and sits above what the library lifts for a frame's children.
		const stacking = await page.evaluate(
			({ x, y }) => {
				const top = document.elementFromPoint(x, y);
				const layer = document.querySelector(
					'[data-testid="canvas-drawing-layer"]',
				) as HTMLElement;
				const nodeEl = document.querySelector(
					'.svelte-flow__node[data-id="note-a"]',
				) as HTMLElement;
				return {
					topIsLayer: !!top?.closest('[data-testid="canvas-drawing-layer"]'),
					layerZ: Number(getComputedStyle(layer).zIndex),
					noteZ: Number(getComputedStyle(nodeEl).zIndex),
				};
			},
			{ x: note.x + note.width / 2, y: note.y + note.height / 2 },
		);
		expect(stacking.topIsLayer).toBe(true);
		expect(stacking.layerZ).toBe(2);
		expect(stacking.noteZ).toBeLessThan(2);
		await dragBetween(
			page,
			{ x: note.x + 20, y: note.y + 20 },
			{ x: note.x + note.width - 20, y: note.y + note.height - 10 },
		);
		await savedStatus(page);
		const saved = await storedBoard(artifactId);
		expect(saved.annotations).toHaveLength(1);
		const held = saved.nodes.find((node) => node.id === "note-a");
		expect(held?.position).toEqual({ x: 40, y: 70 });
		expect(held?.parentId).toBe("frame-a");
	});

	test("a tool that draws starts from a board with nothing picked", async ({
		page,
	}) => {
		await open(page, board([sticky("note-a", 60, 120, "Museum")]));
		await page
			.locator('.svelte-flow__node[data-id="note-a"]')
			.click({ position: { x: 20, y: 20 } });
		await expect(page.locator(".svelte-flow__node.selected")).toHaveCount(1);
		await chooseTool(page, "pen");
		await expect(page.locator(".svelte-flow__node.selected")).toHaveCount(0);
		await expect(page.getByTestId("canvas-node-toolbar")).toHaveCount(0);
	});

	test("erases a whole mark with a drag over it, and only that one", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board(
				[],
				[
					pen("pen-a", [
						{ x: 100, y: 200 },
						{ x: 250, y: 200 },
						{ x: 400, y: 200 },
					]),
					pen("pen-b", [
						{ x: 100, y: 320 },
						{ x: 250, y: 320 },
						{ x: 400, y: 320 },
					]),
				],
			),
		);
		await expect(page.getByTestId("canvas-mark")).toHaveCount(2);
		await chooseTool(page, "eraser");
		await dragBetween(
			page,
			await screenOf(page, { x: 250, y: 170 }),
			await screenOf(page, { x: 250, y: 230 }),
			10,
		);
		await expect(page.getByTestId("canvas-mark")).toHaveCount(1);
		await savedStatus(page);
		expect(
			(await storedAnnotations(artifactId)).map((mark) => mark.id),
		).toEqual(["pen-b"]);
	});

	test("places a text mark, and edits it", async ({ page }) => {
		const artifactId = await open(page, board([]));
		await chooseTool(page, "text");
		const at = await screenOf(page, { x: 300, y: 150 });
		await page.mouse.click(at.x, at.y);
		const field = page.getByTestId("canvas-text-input");
		await expect(field).toBeFocused();
		await page.keyboard.type("Ferry at 9");
		await page.keyboard.press("Enter");
		await expect(field).toHaveCount(0);
		await expect(page.locator('[data-testid="canvas-mark"] text')).toHaveText(
			"Ferry at 9",
		);
		await savedStatus(page);
		const [placed] = await storedAnnotations(artifactId);
		expect(placed).toMatchObject({ kind: "text", text: "Ferry at 9" });
		expect(placed.at?.x).toBeCloseTo(300, -1);

		// Select, then double-click the words: the same mark opens for editing.
		await page.getByTestId("canvas-tool-select").click();
		const words = await page
			.locator('[data-testid="canvas-mark"] text')
			.boundingBox();
		if (!words) throw new Error("no text box");
		await page.mouse.dblclick(
			words.x + words.width / 2,
			words.y + words.height / 2,
		);
		await expect(field).toHaveValue("Ferry at 9");
		await field.fill("Ferry at 9:30");
		await page.keyboard.press("Enter");
		await savedStatus(page);
		const edited = await storedAnnotations(artifactId);
		expect(edited).toHaveLength(1);
		expect(edited[0]).toMatchObject({ id: placed.id, text: "Ferry at 9:30" });
	});

	test("select drags a marquee and leaves the camera; pan moves the camera", async ({
		page,
	}) => {
		await open(
			page,
			board([
				sticky("note-a", 40, 60, "One"),
				sticky("note-b", 300, 60, "Two"),
			]),
		);
		const before = await cameraOf(page);
		const a = await nodeBox(page, "note-a");
		const b = await nodeBox(page, "note-b");
		await dragBetween(
			page,
			{ x: a.x - 20, y: a.y - 20 },
			{ x: b.x + b.width + 20, y: b.y + b.height + 20 },
		);
		await expect(page.locator(".svelte-flow__node.selected")).toHaveCount(2);
		expect(await cameraOf(page)).toEqual(before);

		await page.getByTestId("canvas-tool-pan").click();
		await dragBetween(
			page,
			{ x: a.x + 100, y: a.y + 260 },
			{ x: a.x + 160, y: a.y + 300 },
		);
		const moved = await cameraOf(page);
		expect(moved.x - before.x).toBeGreaterThan(40);
		expect(moved.y - before.y).toBeGreaterThan(25);
	});

	test("a red ink draws in red, and says which ink is on", async ({ page }) => {
		const artifactId = await open(page, board([]));
		await chooseTool(page, "pen");
		await expect(page.getByTestId("canvas-ink-blue")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await page.getByTestId("canvas-ink-red").click();
		await expect(page.getByTestId("canvas-ink-red")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(page.getByTestId("canvas-ink-blue")).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		await dragBetween(
			page,
			await screenOf(page, { x: 100, y: 100 }),
			await screenOf(page, { x: 260, y: 160 }),
		);
		await savedStatus(page);
		expect((await storedAnnotations(artifactId))[0].color).toBe(
			"var(--ink-red)",
		);
		const fill = await page
			.locator('[data-testid="canvas-mark"] path')
			.evaluate((el) => getComputedStyle(el).fill);
		expect(fill).toBe("rgb(192, 57, 43)");
	});

	test("each gesture is one step: undo takes back one stroke, even when they came in a burst", async ({
		page,
	}) => {
		await open(page, board([]));
		await chooseTool(page, "pen");
		for (const y of [100, 150, 200]) {
			await dragBetween(
				page,
				await screenOf(page, { x: 100, y }),
				await screenOf(page, { x: 260, y: y + 10 }),
				6,
			);
		}
		await expect(page.getByTestId("canvas-mark")).toHaveCount(3);
		const undo = page.getByTestId("canvas-undo");
		await expect(undo).toHaveAccessibleName(/^Undo your last step/);
		await undo.click();
		await expect(page.getByTestId("canvas-mark")).toHaveCount(2);
		await undo.click();
		await expect(page.getByTestId("canvas-mark")).toHaveCount(1);
		await page.getByTestId("canvas-redo").click();
		await expect(page.getByTestId("canvas-mark")).toHaveCount(2);
	});

	test("reloading the board leaves every stroke where it was drawn", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([sticky("note-a", 60, 120, "Museum")]),
		);
		await chooseTool(page, "pen");
		await dragBetween(
			page,
			await screenOf(page, { x: 300, y: 100 }),
			await screenOf(page, { x: 420, y: 200 }),
		);
		await page.getByTestId("canvas-ink-green").click();
		await chooseTool(page, "rect");
		await dragBetween(
			page,
			await screenOf(page, { x: 100, y: 300 }),
			await screenOf(page, { x: 260, y: 380 }),
		);
		await savedStatus(page);
		const boxes = () =>
			page.locator('[data-testid="canvas-mark"]').evaluateAll((els) =>
				els.map((el) => {
					const box = (el as unknown as SVGGraphicsElement).getBBox();
					return {
						id: el.getAttribute("data-annotation-id"),
						x: box.x,
						width: box.width,
					};
				}),
			);
		// Measured the way it will be after the reload, with Select on (which adds each mark's hit shape).
		await page.getByTestId("canvas-tool-select").click();
		const before = await boxes();
		expect(before).toHaveLength(2);
		expect(
			(await storedAnnotations(artifactId)).map((mark) => mark.kind),
		).toEqual(["pen", "rect"]);

		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		const after = await boxes();
		expect(after.map((mark) => mark.id)).toEqual(before.map((mark) => mark.id));
		for (const [index, mark] of after.entries()) {
			expect(mark.x).toBeCloseTo(before[index].x, 0);
			expect(mark.width).toBeCloseTo(before[index].width, 0);
		}
	});

	test("Escape leaves the drawing tool and the panel stays open", async ({
		page,
	}) => {
		await open(page, board([]));
		await chooseTool(page, "pen");
		await dragBetween(
			page,
			await screenOf(page, { x: 100, y: 100 }),
			await screenOf(page, { x: 200, y: 160 }),
		);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("canvas-board")).toHaveAttribute(
			"data-tool",
			"select",
		);
		await expect(page.getByTestId("canvas-editor")).toBeVisible();
	});

	test("picks a mark with a click, nudges it with the arrows, and deletes it with the keyboard", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board(
				[],
				[
					pen("pen-a", [
						{ x: 100, y: 200 },
						{ x: 250, y: 200 },
						{ x: 400, y: 200 },
					]),
				],
			),
		);
		const on = await screenOf(page, { x: 250, y: 200 });
		await page.mouse.click(on.x, on.y);
		await expect(page.locator("[data-annotation-chrome]")).toBeVisible();
		await expect(page.getByTestId("canvas-drawing-layer")).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Shift+ArrowDown");
		await savedStatus(page);
		const [moved] = await storedAnnotations(artifactId);
		expect(moved.points?.[0]).toEqual({ x: 102, y: 210 });
		await page.keyboard.press("Escape");
		await expect(page.locator("[data-annotation-chrome]")).toHaveCount(0);
		await page.mouse.click(on.x + 2, on.y + 10);
		await expect(page.locator("[data-annotation-chrome]")).toBeVisible();
		await page.keyboard.press("Delete");
		await expect(page.getByTestId("canvas-mark")).toHaveCount(0);
		await savedStatus(page);
		expect(await storedAnnotations(artifactId)).toEqual([]);
	});

	test("moves a mark by dragging it, as one step", async ({ page }) => {
		const artifactId = await open(
			page,
			board(
				[],
				[
					pen("pen-a", [
						{ x: 100, y: 200 },
						{ x: 250, y: 200 },
						{ x: 400, y: 200 },
					]),
				],
			),
		);
		const on = await screenOf(page, { x: 250, y: 200 });
		await dragBetween(page, on, { x: on.x + 80, y: on.y + 40 });
		await savedStatus(page);
		const [moved] = await storedAnnotations(artifactId);
		expect(moved.points?.[0].x).toBeCloseTo(180, 0);
		expect(moved.points?.[0].y).toBeCloseTo(240, 0);
		await page.getByTestId("canvas-undo").click();
		await savedStatus(page);
		expect((await storedAnnotations(artifactId))[0].points?.[0]).toEqual({
			x: 100,
			y: 200,
		});
	});

	test("says so when the board holds as many marks as it may, and adds none", async ({
		page,
	}) => {
		const marks = Array.from({ length: 600 }, (_, index) =>
			pen(`pen-${index}`, [
				{ x: (index % 40) * 12, y: Math.floor(index / 40) * 12 },
			]),
		);
		const artifactId = await open(page, board([], marks));
		await chooseTool(page, "pen");
		await dragBetween(
			page,
			await screenOf(page, { x: 100, y: 300 }),
			await screenOf(page, { x: 200, y: 340 }),
		);
		await expect(page.getByTestId("canvas-limit-notice")).toContainText(
			"at most 600 marks",
		);
		await expect(page.getByTestId("canvas-mark")).toHaveCount(600);
		expect(await storedAnnotations(artifactId)).toHaveLength(600);
	});

	test("the pad covers the visible pane on a big board at fit view, and after zooming out and panning", async ({
		page,
	}) => {
		// 150 notes and no camera of its own: fitted on open, which is where the prototype's pad caught 6 of 144 points.
		const notes = Array.from({ length: 150 }, (_, index) =>
			sticky(
				`note-${index}`,
				(index % 15) * 230,
				Math.floor(index / 15) * 120,
				`Note ${index}`,
			),
		);
		await open(page, board(notes, [], { x: 0, y: 0, zoom: 1 }));
		await chooseTool(page, "pen");
		const coverage = async () =>
			page.evaluate(() => {
				const pane = (
					document.querySelector(".svelte-flow__pane") as HTMLElement
				).getBoundingClientRect();
				const layer = document.querySelector(
					'[data-testid="canvas-drawing-layer"]',
				) as HTMLElement;
				const rect = layer.getBoundingClientRect();
				let pad = 0;
				let missed = 0;
				for (let i = 0; i < 16; i += 1) {
					for (let j = 0; j < 10; j += 1) {
						const x = pane.x + (pane.width * (i + 0.5)) / 16;
						const y = pane.y + (pane.height * (j + 0.5)) / 10;
						const top = document.elementFromPoint(x, y);
						if (top?.closest('[data-testid="canvas-drawing-layer"]')) pad += 1;
						// The board's own chrome sits over the pane by design; anything else on top is a hole in the pad.
						else if (
							!top?.closest(
								".canvas-toolbar, .svelte-flow__minimap, .svelte-flow__panel, .svelte-flow__attribution",
							)
						)
							missed += 1;
					}
				}
				return {
					pad,
					missed,
					containsPane:
						rect.left <= pane.left + 1 &&
						rect.top <= pane.top + 1 &&
						rect.right >= pane.right - 1 &&
						rect.bottom >= pane.bottom - 1,
				};
			});
		const atFit = await coverage();
		expect(atFit.pad / (atFit.pad + atFit.missed)).toBeGreaterThanOrEqual(0.95);
		expect(atFit.pad).toBeGreaterThan(100);
		expect(atFit.containsPane).toBe(true);

		await page.getByTestId("canvas-zoom-out").click();
		await page.getByTestId("canvas-zoom-out").click();
		await page.getByTestId("canvas-zoom-out").click();
		const zoomedOut = await coverage();
		expect(
			zoomedOut.pad / (zoomedOut.pad + zoomedOut.missed),
		).toBeGreaterThanOrEqual(0.95);
		expect(zoomedOut.containsPane).toBe(true);

		// Panned far away, where nothing is: still there.
		await page.getByTestId("canvas-tool-pan").click();
		const pane = await page.locator(".svelte-flow__pane").boundingBox();
		if (!pane) throw new Error("no pane");
		await dragBetween(
			page,
			{ x: pane.x + 300, y: pane.y + 200 },
			{ x: pane.x + 700, y: pane.y + 500 },
			20,
		);
		await chooseTool(page, "pen");
		const panned = await coverage();
		expect(panned.pad / (panned.pad + panned.missed)).toBeGreaterThanOrEqual(
			0.95,
		);
		expect(panned.containsPane).toBe(true);
	});

	test("draws with a click too: a dot with the pen, and nothing from a click with a shape", async ({
		page,
	}) => {
		const artifactId = await open(page, board([]));
		await chooseTool(page, "pen");
		const dot = await screenOf(page, { x: 200, y: 150 });
		await page.mouse.click(dot.x, dot.y);
		await chooseTool(page, "rect");
		const shape = await screenOf(page, { x: 300, y: 150 });
		await page.mouse.click(shape.x, shape.y);
		await savedStatus(page);
		const marks = await storedAnnotations(artifactId);
		expect(marks.map((mark) => mark.kind)).toEqual(["pen"]);
		expect(marks[0].points).toHaveLength(1);
	});
});

test.describe("the drawing tools on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("open above the toolbar, wrapped to the width, every tool a full-size touch target", async ({
		page,
	}) => {
		await login(page);
		await open(page, board([sticky("note-a", 40, 60, "Museum")]));
		await page.getByTestId("canvas-tool-draw").click();
		const tray = page.getByTestId("canvas-draw-tray");
		await expect(tray).toBeVisible();
		const boardBox = await page.getByTestId("canvas-board").boundingBox();
		const trayBox = await tray.boundingBox();
		const barBox = await page.getByTestId("canvas-toolbar").boundingBox();
		if (!boardBox || !trayBox || !barBox) throw new Error("no boxes");
		// Inside the board, and clear of the toolbar under it.
		expect(trayBox.x).toBeGreaterThanOrEqual(boardBox.x);
		expect(trayBox.x + trayBox.width).toBeLessThanOrEqual(
			boardBox.x + boardBox.width + 0.5,
		);
		expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(barBox.y + 0.5);
		for (const button of await tray.getByRole("button").all()) {
			const size = await button.boundingBox();
			expect(size && size.width >= 44 && size.height >= 44).toBe(true);
		}
		// Eight tools and four inks do not fit on one 390 px line: the inks wrap under the tools.
		const pen = await page.getByTestId("canvas-tool-pen").boundingBox();
		const blue = await page.getByTestId("canvas-ink-blue").boundingBox();
		expect(pen && blue && blue.y > pen.y + pen.height - 1).toBe(true);
	});
});

test.describe("the drawing layer under a finger", () => {
	test.use({ hasTouch: true });

	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	type Touch = { x: number; y: number };

	/**
	 * A multi-touch gesture, through the browser's own touch input: the fingers go
	 * down one after another (a real hand does not land two at the same instant),
	 * then all move in step, then all lift.
	 */
	async function gesture(page: Page, from: Touch[], to: Touch[], steps = 10) {
		const client = await page.context().newCDPSession(page);
		const points = (list: Touch[]) =>
			list.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 }));
		for (let down = 1; down <= from.length; down += 1) {
			await client.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: points(from.slice(0, down)),
			});
		}
		for (let step = 1; step <= steps; step += 1) {
			const t = step / steps;
			await client.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: points(
					from.map((p, i) => ({
						x: p.x + (to[i].x - p.x) * t,
						y: p.y + (to[i].y - p.y) * t,
					})),
				),
			});
		}
		await client.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
		await client.detach();
	}

	test("a pinch on empty board zooms it", async ({ page }) => {
		await open(page, board([sticky("note-a", 40, 40, "Museum")]));
		expect(
			await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
		).toBe(true);
		const pane = await page.locator(".svelte-flow__pane").boundingBox();
		if (!pane) throw new Error("no pane");
		const cx = pane.x + pane.width / 2;
		const cy = pane.y + pane.height / 2 + 80;
		const before = await cameraOf(page);
		await gesture(
			page,
			[
				{ x: cx - 30, y: cy },
				{ x: cx + 30, y: cy },
			],
			[
				{ x: cx - 130, y: cy },
				{ x: cx + 130, y: cy },
			],
		);
		await expect
			.poll(async () => (await cameraOf(page)).zoom)
			.toBeGreaterThan(before.zoom * 1.5);
	});

	test("a pinch that starts on a block zooms the board like any other pinch, and never drags the block", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([sticky("note-a", 200, 120, "Museum")]),
		);
		const note = await nodeBox(page, "note-a");
		const before = await cameraOf(page);
		const start = { x: note.x + note.width / 2, y: note.y + note.height / 2 };
		await gesture(
			page,
			[start, { x: start.x + 120, y: start.y + 20 }],
			[
				{ x: start.x - 40, y: start.y },
				{ x: start.x + 220, y: start.y + 20 },
			],
		);
		// Svelte Flow 1.7.0 lets a second finger make it a pinch wherever the first
		// one landed (the spec's "dropped whole" is not what this version does), and
		// the block does not follow a finger: not on screen, not in what is saved.
		await expect
			.poll(async () => (await cameraOf(page)).zoom)
			.toBeGreaterThan(before.zoom * 1.5);
		await page.waitForTimeout(600);
		expect((await storedBoard(artifactId)).nodes[0].position).toEqual({
			x: 200,
			y: 120,
		});
		expect(await versionRows(artifactId)).toHaveLength(1);
	});

	test("a finger draws with the pen and does not pan; a second finger drops the stroke instead of leaving a mark", async ({
		page,
	}) => {
		const artifactId = await open(page, board([]));
		await chooseTool(page, "pen");
		const before = await cameraOf(page);
		const from = await screenOf(page, { x: 150, y: 150 });
		const to = await screenOf(page, { x: 320, y: 230 });
		await gesture(page, [from], [to]);
		await expect(page.getByTestId("canvas-mark")).toHaveCount(1);
		expect(await cameraOf(page)).toEqual(before);
		await savedStatus(page);
		expect(await storedAnnotations(artifactId)).toHaveLength(1);

		// Two fingers down together are a pinch, not two strokes.
		const a = await screenOf(page, { x: 200, y: 300 });
		await gesture(
			page,
			[a, { x: a.x + 60, y: a.y }],
			[
				{ x: a.x - 20, y: a.y },
				{ x: a.x + 90, y: a.y },
			],
		);
		await page.waitForTimeout(500);
		await expect(page.getByTestId("canvas-mark")).toHaveCount(1);
	});
});
