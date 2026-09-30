import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	messages,
} from "../../src/lib/server/db/schema";
import {
	applyOp,
	type BoardOp,
} from "../../src/lib/shared/artifacts/board-ops";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	estimatedNodeHeight,
	NODE_WIDTH,
} from "../../src/lib/shared/artifacts/canvas-blocks";
import {
	boardJson,
	emptyCanvasBody,
} from "../../src/lib/shared/artifacts/canvas-body";
import {
	cameraOf,
	nodeBox,
	nodeCount,
	openCanvasPanel,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
} from "./artifact-canvas-helpers";
import { createConversation, expectTopmost, login } from "./helpers";

// The Canvas kind, in the panel (Feature 2 · Artifacts, Slice 3, the board
// agent's part): a seeded board opens, draws its blocks, takes the note-shaped
// blocks from the Insert menu, saves what the reader does, and keeps its
// chrome clear of its content. Boards are seeded straight into the database —
// the convention artifacts-panel.spec.ts and artifact-app.spec.ts established,
// since `create_artifact` has no scriptable tool-call fixture.
//
// Drawing, connectors, reparenting, comments and Alfy's own changes belong to
// the slices after this one and are not exercised here.

const BOARD = {
	frame: "frame-saturday",
	note: "note-lunch",
	text: "text-plan",
	list: "list-pack",
	chart: "chart-budget",
	photo: "photo-trip",
} as const;

/** A board with every block kind this slice draws, and one it cannot (photos: their own slice), at the default camera so it is fitted on open. */
function seededBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: BOARD.frame,
				type: "frame",
				position: { x: 40, y: 40 },
				width: 360,
				height: 300,
				data: { kind: "frame", label: "Saturday", width: 360, height: 300 },
			},
			{
				id: BOARD.note,
				type: "sticky",
				parentId: BOARD.frame,
				position: { x: 20, y: 60 },
				width: 190,
				data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
			},
			{
				id: BOARD.text,
				type: "text",
				position: { x: 480, y: 60 },
				width: 240,
				data: { kind: "text", text: "Weekend plan" },
			},
			{
				id: BOARD.list,
				type: "checklist",
				position: { x: 480, y: 160 },
				width: 260,
				data: {
					kind: "checklist",
					label: "Pack",
					items: [
						{ id: "i1", text: "Passport", done: true },
						{ id: "i2", text: "Charger", done: false },
					],
				},
			},
			{
				id: BOARD.chart,
				type: "chart",
				position: { x: 40, y: 400 },
				width: 360,
				data: {
					kind: "chart",
					label: "Budget",
					code: '{"type":"bar","data":{"labels":["A","B"],"datasets":[{"data":[3,5]}]}}',
				},
			},
			{
				id: BOARD.photo,
				type: "photo",
				position: { x: 480, y: 400 },
				data: { kind: "photo", items: [] },
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

test.describe("the Canvas kind, in the panel", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("opens a seeded board in the panel and paints its blocks", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Put it on a board");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await expect(page.getByTestId("canvas-node")).toHaveCount(6);
		const kinds = await page
			.getByTestId("canvas-node")
			.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute("data-kind")),
			);
		expect(kinds.sort()).toEqual(
			["checklist", "chart", "frame", "photo", "sticky", "text"].sort(),
		);
		await expect(page.getByText("Lunch at the market")).toBeVisible();
		await expect(page.getByText("Weekend plan")).toBeVisible();
		await expect(page.getByTestId("canvas-frame-label")).toHaveText("Saturday");
		await expect(
			page.getByRole("checkbox", { name: "Passport: toggle done" }),
		).toBeChecked();
		// A photo block with no photos in it is drawn (every kind has a component
		// now, so none is drawn as the missing-kind card), says so, and stays on the board.
		await expect(page.locator('[data-missing="true"]')).toHaveCount(0);
		await expect(page.getByText("No photos in this block.")).toBeVisible();
		// The chart is the chat's own: it painted a canvas element.
		await expect(
			page.getByTestId("canvas-chart").locator("canvas"),
		).toBeVisible();
	});

	// RV-3 C1: Alfy could write a checklist whose items share an id, and the board
	// draws its rows by id, so the panel never left its loading skeleton and the
	// board could only be deleted. It opens now, with every item on it.
	test("opens a board whose checklist repeats an item id, with every item on it", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"A board Alfy numbered twice",
		);
		const board = seededBoard();
		board.nodes.push({
			id: "list-doubled",
			type: "checklist",
			position: { x: 480, y: 40 },
			data: {
				kind: "checklist",
				label: "Doubled",
				items: [
					{ id: "1", text: "First thing", done: false },
					{ id: "1", text: "Second thing", done: true },
				],
			},
		});
		await seedCanvas(conversationId, board);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const doubled = page
			.locator('[data-testid="canvas-node"][data-kind="checklist"]')
			.filter({ hasText: "Doubled" });
		await expect(doubled.getByRole("checkbox")).toHaveCount(2);
		await expect(
			doubled.getByRole("checkbox", { name: "First thing: toggle done" }),
		).not.toBeChecked();
		await expect(
			doubled.getByRole("checkbox", { name: "Second thing: toggle done" }),
		).toBeChecked();
	});

	// RV-3 C2: a block Alfy adds has no width of its own, and the board drew it as
	// wide as its words ran (a 120-character note came out 861 wide, through the
	// frame it was in), while Alfy was told a note is 190 wide. What Alfy adds is
	// stored 190 wide and drawn that wide, and is as tall as the estimate Alfy plans
	// with (never taller), so a board laid out from those numbers has no overlap.
	test("draws what Alfy adds inside its frame, as wide and as tall as Alfy is told", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "What Alfy made");
		const TEXTS = [
			"Museum, 10:00",
			"Ebéd a Nagycsarnokban, utána séta a Duna-parton",
			"Ebéd a Nagycsarnokban, utána séta a Duna-parton a Szabadság hídtól a Margit-szigetig és vissza a belvárosba",
			"Ebéd a Nagycsarnokban, utána séta a Duna-parton a Szabadság hídtól a Margit-szigetig, majd vacsora egy kis étteremben a Belvárosban, végül esti koncert a Művészetek Palotájában",
		];
		// The board Alfy's own ops make, laid out the way its tool text says to.
		let board = emptyCanvasBody();
		const ops: BoardOp[] = [
			{
				op: "add_frame",
				id: "frame-sat",
				label: "Szombat",
				position: { x: 40, y: 40 },
				size: { width: 420, height: 700 },
			},
		];
		const heights: number[] = [];
		let y = 50;
		TEXTS.forEach((text, index) => {
			const node = {
				id: `note-${index}`,
				type: "sticky",
				parentId: "frame-sat",
				position: { x: 20, y },
				data: { kind: "sticky", text, tone: "yellow" },
			};
			ops.push({ op: "add_node", node } as BoardOp);
			const height = estimatedNodeHeight({
				type: "sticky",
				width: NODE_WIDTH,
				data: { kind: "sticky", text, tone: "yellow" },
			});
			heights.push(height);
			y += height + 10;
		});
		for (const op of ops) board = applyOp(board, op);
		await seedCanvas(conversationId, board);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const frame = await nodeBox(page, "frame-sat");
		let previous: { bottom: number } | null = null;
		for (const [index, expected] of heights.entries()) {
			const id = `note-${index}`;
			// In board units, whatever the camera is doing.
			const drawn = await page
				.locator(`.svelte-flow__node[data-id="${id}"]`)
				.evaluate((el) => ({
					width: (el as HTMLElement).offsetWidth,
					height: (el as HTMLElement).offsetHeight,
				}));
			expect(drawn.width, `${id} width`).toBe(NODE_WIDTH);
			// Never taller than Alfy plans with (a line of slack is fine).
			expect(drawn.height, `${id} height`).toBeLessThanOrEqual(expected + 2);
			expect(drawn.height, `${id} height`).toBeGreaterThanOrEqual(
				expected - 20,
			);
			// Inside its frame, and clear of the note before it.
			const box = await nodeBox(page, id);
			expect(box.x, `${id} left`).toBeGreaterThanOrEqual(frame.x - 1);
			expect(box.x + box.width, `${id} right`).toBeLessThanOrEqual(
				frame.x + frame.width + 1,
			);
			expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(
				frame.y + frame.height + 1,
			);
			if (previous)
				expect(box.y, `${id} top`).toBeGreaterThanOrEqual(previous.bottom);
			previous = { bottom: box.y + box.height };
		}
	});

	test("draws the edges a board was saved with, label and all", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Saved edges");
		await seedCanvas(conversationId, {
			...seededBoard(),
			edges: [
				{ id: "edge-1", source: BOARD.note, target: BOARD.text, label: "then" },
			],
		});
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		// One edge, joining the two blocks it names, with the words it was saved with.
		await expect(page.locator(".svelte-flow__edge")).toHaveCount(1);
		await expect(
			page
				.locator(".svelte-flow__edge-label, .svelte-flow__edge-text")
				.filter({ hasText: "then" })
				.first(),
		).toBeAttached();
		const path = page.locator(".svelte-flow__edge-path").first();
		const d = await path.getAttribute("d");
		expect(d && d.length > 10).toBe(true);
	});

	test("says what an empty board is for, and points at Insert", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "A fresh board");
		await seedCanvas(conversationId, emptyCanvasBody(), "Fresh board");
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await expect(page.getByTestId("canvas-empty")).toHaveText(
			"Empty board. Insert a block or draw on it.",
		);
		await expect(page.getByTestId("canvas-node")).toHaveCount(0);
	});

	test("inserts each note-shaped kind from the Insert menu, and saves them", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Board to fill");
		const artifactId = await seedCanvas(
			conversationId,
			emptyCanvasBody(),
			"Board to fill",
		);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const kinds = ["sticky", "text", "frame", "chart", "checklist"] as const;
		for (const [index, kind] of kinds.entries()) {
			await page.getByTestId("canvas-insert-button").click();
			await expect(page.getByTestId("canvas-insert-menu")).toBeVisible();
			await page.getByTestId(`canvas-insert-${kind}`).click();
			await expect(page.getByTestId("canvas-node")).toHaveCount(index + 1);
			await expect(
				page.locator(`[data-testid="canvas-node"][data-kind="${kind}"]`),
			).toHaveCount(1);
			// What a reader writes opens for typing at once.
			if (kind === "sticky" || kind === "text" || kind === "frame") {
				const field = page.getByRole("textbox").last();
				await expect(field).toBeFocused();
				await page.keyboard.type(`${kind} words`);
				await page.keyboard.press("Escape");
			}
			await expect(page.getByTestId("canvas-empty")).toHaveCount(0);
			// Each block is a step of its own, and the menu is closed again.
			await expect(page.getByTestId("canvas-insert-menu")).toHaveCount(0);
		}

		await savedStatus(page);
		const stored = await storedBoard(artifactId);
		expect(stored.nodes.map((node) => node.type).sort()).toEqual(
			[...kinds].sort(),
		);
		const sticky = stored.nodes.find((node) => node.type === "sticky");
		expect(sticky?.data).toMatchObject({
			text: "sticky words",
			tone: "yellow",
		});
		const text = stored.nodes.find((node) => node.type === "text");
		expect(text?.data).toMatchObject({ text: "text words" });
		const frame = stored.nodes.find((node) => node.type === "frame");
		expect(frame?.data).toMatchObject({
			label: "frame words",
			width: 360,
			height: 260,
		});

		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(page.getByTestId("canvas-node")).toHaveCount(5);
		await expect(page.getByText("sticky words")).toBeVisible();
	});

	test("closes the Insert menu on Escape, which hands focus back to Insert, and on a click outside, which leaves focus where the reader clicked", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Menu manners");
		await seedCanvas(conversationId, emptyCanvasBody(), "Menu manners");
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const insert = page.getByTestId("canvas-insert-button");
		const menu = page.getByTestId("canvas-insert-menu");

		await insert.click();
		await expect(menu).toBeVisible();
		await expect(insert).toHaveAttribute("aria-expanded", "true");
		await expectTopmost(menu, {
			message: "the Insert menu paints above the board",
		});
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(insert).toHaveAttribute("aria-expanded", "false");
		await expect(insert).toBeFocused();

		await insert.click();
		await expect(menu).toBeVisible();
		await page
			.getByTestId("canvas-board")
			.click({ position: { x: 40, y: 40 } });
		await expect(menu).toHaveCount(0);
		await expect(insert).toHaveAttribute("aria-expanded", "false");
		// A press elsewhere is the reader going elsewhere: nothing pulls focus
		// back into the toolbar, and nothing was inserted.
		await expect(insert).not.toBeFocused();
		expect(await nodeCount(page)).toBe(0);
	});

	test("moves between the menu's rows with the arrow keys, one tab stop", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Menu keys");
		await seedCanvas(conversationId, emptyCanvasBody(), "Menu keys");
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await page.getByTestId("canvas-insert-button").click();
		const rows = page.getByRole("menuitem");
		await expect(rows).toHaveCount(5);
		// The popover puts focus on its first control in a timer of its own, straight
		// after it mounts; a row focused before that lands loses its focus to it (a
		// race a busy machine makes easy to lose). The keys are driven after it.
		await expect(
			page
				.getByTestId("canvas-insert-menu")
				.getByRole("button", { name: "Close" }),
		).toBeFocused();
		await rows.first().focus();
		await page.keyboard.press("ArrowDown");
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press("End");
		await expect(rows.last()).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(rows.first()).toBeFocused();
		// Only the row that has the roving position is a tab stop.
		const tabStops = await rows.evaluateAll(
			(nodes) =>
				nodes.filter((node) => node.getAttribute("tabindex") === "0").length,
		);
		expect(tabStops).toBe(1);
	});

	test("a tick on the board is a saved edit: it survives a reload", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Tick me");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const charger = page.getByRole("checkbox", {
			name: "Charger: toggle done",
		});
		await expect(charger).not.toBeChecked();
		await charger.check();
		await expect(charger).toBeChecked();
		await savedStatus(page);

		const stored = await storedBoard(artifactId);
		const list = stored.nodes.find((node) => node.id === BOARD.list);
		expect(list?.data).toMatchObject({
			items: [
				{ id: "i1", done: true },
				{ id: "i2", done: true },
			],
		});
		// A photo block with no photos in it came through the save untouched.
		expect(
			stored.nodes.find((node) => node.id === BOARD.photo)?.data,
		).toMatchObject({ kind: "photo", items: [] });
		expect(stored.nodes).toHaveLength(6);

		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(
			page.getByRole("checkbox", { name: "Charger: toggle done" }),
		).toBeChecked();
	});

	test("undoes and redoes the reader's own steps, from the toolbar and from the keyboard", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Undo me");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const undo = page.getByTestId("canvas-undo");
		const redo = page.getByTestId("canvas-redo");
		await expect(undo).toBeDisabled();
		await expect(redo).toBeDisabled();

		const charger = page.getByRole("checkbox", {
			name: "Charger: toggle done",
		});
		await charger.check();
		await expect(undo).toBeEnabled();
		await undo.click();
		await expect(charger).not.toBeChecked();
		await expect(redo).toBeEnabled();
		await redo.click();
		await expect(charger).toBeChecked();

		// From the keyboard, with the focus on the board and not in a field.
		await page.getByTestId("canvas-tool-select").focus();
		// The command key is the emulated browser's own (`navigator.platform`,
		// which Playwright's desktop Chrome reports as Windows): Ctrl.
		await page.keyboard.press("Control+z");
		await expect(charger).not.toBeChecked();
		await page.keyboard.press("Control+Shift+z");
		await expect(charger).toBeChecked();
	});

	test("edits a note in place, on a double-click, and keeps what is typed", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Edit a note");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await page.getByTestId("canvas-sticky").dblclick();
		const field = page.getByRole("textbox", { name: "Sticky note" });
		await expect(field).toBeFocused();
		await field.fill("Lunch at the market, then the museum");
		await page.keyboard.press("Escape");
		await expect(field).toHaveCount(0);
		await expect(
			page.getByText("Lunch at the market, then the museum"),
		).toBeVisible();
		await savedStatus(page);
		const stored = await storedBoard(artifactId);
		expect(
			stored.nodes.find((node) => node.id === BOARD.note)?.data,
		).toMatchObject({ text: "Lunch at the market, then the museum" });
	});

	test("moves a block by dragging it, and saves where it was dropped", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Move me");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const text = page.locator(`.svelte-flow__node[data-id="${BOARD.text}"]`);
		const box = await text.boundingBox();
		if (!box) throw new Error("the text block has no box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(
			box.x + box.width / 2 + 90,
			box.y + box.height / 2 + 50,
			{
				steps: 10,
			},
		);
		await page.mouse.up();
		await savedStatus(page);
		const moved = (await storedBoard(artifactId)).nodes.find(
			(node) => node.id === BOARD.text,
		);
		expect(moved?.position.x).toBeGreaterThan(480);
		expect(moved?.position.y).toBeGreaterThan(60);
	});

	test("deletes a selected block from its toolbar, and Undo brings it back", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Delete me");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await page.getByTestId("canvas-text").click();
		await expect(page.getByTestId("canvas-node-toolbar")).toBeVisible();
		await page.getByTestId("canvas-node-delete").click();
		await expect(page.getByTestId("canvas-node")).toHaveCount(5);
		await savedStatus(page);
		expect(
			(await storedBoard(artifactId)).nodes.some(
				(node) => node.id === BOARD.text,
			),
		).toBe(false);

		await page.getByTestId("canvas-undo").click();
		await expect(page.getByTestId("canvas-node")).toHaveCount(6);
		await expect(page.getByText("Weekend plan")).toBeVisible();
		await savedStatus(page);
		expect(
			(await storedBoard(artifactId)).nodes.some(
				(node) => node.id === BOARD.text,
			),
		).toBe(true);
	});

	test("deletes a selected block with the Delete key, but not while a field has the keyboard", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Keys delete");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		// Typing Backspace in a note's field edits the note; it never deletes it.
		await page.getByTestId("canvas-sticky").dblclick();
		const field = page.getByRole("textbox", { name: "Sticky note" });
		await expect(field).toBeFocused();
		await page.keyboard.press("Backspace");
		await expect(page.getByTestId("canvas-node")).toHaveCount(6);
		await page.keyboard.press("Escape");

		await page.getByTestId("canvas-text").click();
		await page.keyboard.press("Delete");
		await expect(page.getByTestId("canvas-node")).toHaveCount(5);
	});

	test("connects two blocks with one drag from an anchor: exactly one edge, with an id of the board's own", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Connect them");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await page.getByTestId("canvas-sticky").click();
		const anchor = page.locator(
			`.svelte-flow__handle[data-nodeid="${BOARD.note}"][data-handleid="right"]`,
		);
		await expect(anchor).toBeVisible();
		const from = await anchor.boundingBox();
		const target = await page
			.locator(`.svelte-flow__node[data-id="${BOARD.text}"]`)
			.boundingBox();
		if (!from || !target) throw new Error("no boxes");
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(
			target.x + target.width / 2,
			target.y + target.height / 2,
			{
				steps: 12,
			},
		);
		await page.mouse.up();
		await expect(page.locator(".svelte-flow__edge")).toHaveCount(1);
		await savedStatus(page);
		const { edges } = await storedBoard(artifactId);
		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({ source: BOARD.note, target: BOARD.text });
		expect(edges[0].id.length).toBeGreaterThan(0);
		expect(edges[0].id.length).toBeLessThanOrEqual(128);
		expect(edges[0].id.startsWith("xy-edge__")).toBe(false);
	});

	test("moves a frame by its name chip, and what is inside it goes along", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Move the frame");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const chip = page.getByTestId("canvas-frame-label");
		const before = await page.getByTestId("canvas-sticky").boundingBox();
		const at = await chip.boundingBox();
		if (!at || !before) throw new Error("no boxes");
		await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
		await page.mouse.down();
		await page.mouse.move(at.x + at.width / 2 + 70, at.y + at.height / 2 + 45, {
			steps: 10,
		});
		await page.mouse.up();
		await savedStatus(page);

		const after = await page.getByTestId("canvas-sticky").boundingBox();
		expect(after && after.x - before.x).toBeGreaterThan(50);
		const stored = await storedBoard(artifactId);
		const frame = stored.nodes.find((node) => node.id === BOARD.frame);
		const note = stored.nodes.find((node) => node.id === BOARD.note);
		expect(frame?.position.x).toBeGreaterThan(40);
		// The note keeps its place INSIDE the frame: it moved with it.
		expect(note?.parentId).toBe(BOARD.frame);
		expect(note?.position).toEqual({ x: 20, y: 60 });
	});

	test("resizes a frame from a corner, and its size is the same on the node and in its data", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Resize me");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await page.getByTestId("canvas-frame-label").click();
		const corner = page.locator(
			`.svelte-flow__node[data-id="${BOARD.frame}"] .svelte-flow__resize-control.handle.bottom.right`,
		);
		await expect(corner).toBeVisible();
		const at = await corner.boundingBox();
		if (!at) throw new Error("no corner box");
		await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
		await page.mouse.down();
		await page.mouse.move(at.x + at.width / 2 + 60, at.y + at.height / 2 + 40, {
			steps: 8,
		});
		await page.mouse.up();
		await savedStatus(page);
		const frame = (await storedBoard(artifactId)).nodes.find(
			(node) => node.id === BOARD.frame,
		);
		expect(frame?.width).toBeGreaterThan(360);
		expect(frame?.height).toBeGreaterThan(300);
		expect(frame?.data).toMatchObject({
			kind: "frame",
			width: frame?.width,
			height: frame?.height,
		});
	});

	test("keeps the board's own content clear of the toolbar and the minimap", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Clear of chrome");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const toolbar = page.getByTestId("canvas-toolbar");
		await expect(toolbar).toBeVisible();
		const rects = await page.evaluate(() => {
			const box = (element: Element | null) => {
				if (!element) return null;
				const { left, top, right, bottom } = element.getBoundingClientRect();
				return { left, top, right, bottom };
			};
			return {
				board: box(document.querySelector('[data-testid="canvas-board"]')),
				toolbar: box(document.querySelector('[data-testid="canvas-toolbar"]')),
				minimap: box(document.querySelector(".svelte-flow__minimap")),
				zoom: box(document.querySelector('[data-testid="canvas-zoom"]')),
				nodes: Array.from(
					document.querySelectorAll('[data-testid="canvas-node"]'),
				).map((node) => box(node.closest(".svelte-flow__node"))),
			};
		});
		expect(rects.board).not.toBeNull();
		const overlaps = (
			a: { left: number; top: number; right: number; bottom: number },
			b: { left: number; top: number; right: number; bottom: number },
		) =>
			a.left < b.right &&
			a.right > b.left &&
			a.top < b.bottom &&
			a.bottom > b.top;
		const chrome = [rects.toolbar, rects.minimap, rects.zoom].filter(
			(rect): rect is NonNullable<typeof rect> => rect !== null,
		);
		expect(chrome.length).toBeGreaterThanOrEqual(2);
		for (const node of rects.nodes) {
			expect(node).not.toBeNull();
			for (const item of chrome) {
				expect(
					node && overlaps(node, item),
					"a block sits under the board's chrome",
				).toBe(false);
			}
		}
		// And every block is inside the board.
		const board = rects.board;
		if (!board) return;
		for (const node of rects.nodes) {
			expect(
				node && node.left >= board.left - 1 && node.right <= board.right + 1,
			).toBe(true);
			expect(
				node && node.top >= board.top - 1 && node.bottom <= board.bottom + 1,
			).toBe(true);
		}
	});

	test("the zoom buttons zoom the board, in and out, and the level says so", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Zoom me");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const level = page.getByTestId("canvas-zoom-level");
		const before = (await cameraOf(page)).zoom;
		await page.getByTestId("canvas-zoom-in").click();
		await expect
			.poll(async () => (await cameraOf(page)).zoom)
			.toBeCloseTo(before * 1.2, 2);
		await expect(level).toHaveText(`${Math.round(before * 1.2 * 100)}%`);
		await page.getByTestId("canvas-zoom-out").click();
		await page.getByTestId("canvas-zoom-out").click();
		await expect
			.poll(async () => (await cameraOf(page)).zoom)
			.toBeCloseTo(before / 1.2, 2);
	});

	test("a bare pan is not a save", async ({ page }) => {
		const conversationId = await createConversation(page, "Look around");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const before = (
			await db
				.select({ id: artifactVersions.id })
				.from(artifactVersions)
				.where(eq(artifactVersions.artifactId, artifactId))
		).length;
		// Pan with the Pan tool, then zoom with the chip.
		await page.getByTestId("canvas-tool-pan").click();
		const board = page.getByTestId("canvas-board");
		const box = await board.boundingBox();
		if (!box) throw new Error("board has no box");
		await page.mouse.move(box.x + 80, box.y + box.height - 160);
		await page.mouse.down();
		await page.mouse.move(box.x + 200, box.y + box.height - 200, { steps: 8 });
		await page.mouse.up();
		await page.getByTestId("canvas-zoom-in").click();
		// Long enough for a settle delay and an autosave debounce to have passed.
		await page.waitForTimeout(2_500);
		const after = (
			await db
				.select({ id: artifactVersions.id })
				.from(artifactVersions)
				.where(eq(artifactVersions.artifactId, artifactId))
		).length;
		expect(after).toBe(before);
		await expect(page.getByTestId("canvas-save-status")).toHaveText("");
	});

	test("says so when another writer got there first, and keeps the reader's board on screen until they reload", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Two writers");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await page.route("**/api/artifacts/*/body**", (route) =>
			route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ ok: false, reason: "version_conflict" }),
			}),
		);
		await page.getByRole("checkbox", { name: "Charger: toggle done" }).check();
		const banner = page.getByTestId("canvas-conflict");
		await expect(banner).toBeVisible({ timeout: 10_000 });
		await expect(banner).toContainText(
			"Someone changed the board while you were drawing. Reload to see the newest version.",
		);
		// The reader's own step is still on screen, and the board no longer takes new ones.
		await expect(
			page.getByRole("checkbox", { name: "Charger: toggle done" }),
		).toBeChecked();
		await expect(page.getByTestId("canvas-insert-button")).toBeDisabled();

		await page.unroute("**/api/artifacts/*/body**");
		await banner.getByRole("button", { name: "Reload" }).click();
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		await expect(
			page.getByRole("checkbox", { name: "Charger: toggle done" }),
		).not.toBeChecked();
	});

	test("tells the reader when blocks could not be read, once, and lets them dismiss it", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Partly unreadable");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		// A body a version behind: a block of a kind nobody knows.
		const stored = JSON.parse(boardJson(seededBoard())) as CanvasBody;
		(stored.nodes as unknown[]).push({
			id: "ghost",
			type: "hologram",
			position: { x: 5, y: 5 },
			data: { kind: "hologram" },
		});
		await db
			.update(artifacts)
			.set({ contentText: JSON.stringify(stored) })
			.where(eq(artifacts.id, artifactId));
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const notice = page.getByTestId("canvas-dropped-notice");
		await expect(notice).toContainText(
			"1 block(s) could not be read and were left out.",
		);
		await expect(page.getByTestId("canvas-node")).toHaveCount(6);
		await notice.getByRole("button", { name: "Dismiss" }).click();
		await expect(notice).toHaveCount(0);
	});

	test("keeps working through a dropped connection: says so, and saves again when it is back", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Offline");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		await page.route("**/api/artifacts/*/body**", (route) =>
			route.abort("connectionrefused"),
		);
		await page.getByRole("checkbox", { name: "Charger: toggle done" }).check();
		const banner = page.getByTestId("canvas-offline");
		await expect(banner).toBeVisible({ timeout: 10_000 });
		await expect(banner).toContainText("You are offline.");
		// "Saved" stays off while nothing has been saved.
		await expect(page.getByTestId("canvas-save-status")).not.toHaveText(
			/Saved/,
		);
		// The board itself is still the reader's to use.
		await expect(page.getByTestId("canvas-insert-button")).toBeEnabled();

		await page.unroute("**/api/artifacts/*/body**");
		await page.evaluate(() => window.dispatchEvent(new Event("online")));
		await savedStatus(page);
		await expect(banner).toHaveCount(0);
		const list = (await storedBoard(artifactId)).nodes.find(
			(node) => node.id === BOARD.list,
		);
		expect(list?.data).toMatchObject({
			items: [{ done: true }, { done: true }],
		});
	});

	test("offers a retry when a save is refused, and says so when the board is too big or gone", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Refused saves");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		// A refusal that is not the reader's doing: a Retry, and it works.
		let refuse = true;
		await page.route("**/api/artifacts/*/body**", (route) =>
			refuse
				? route.fulfill({
						status: 400,
						contentType: "application/json",
						body: JSON.stringify({ ok: false, reason: "invalid_patch" }),
					})
				: route.continue(),
		);
		const charger = page.getByRole("checkbox", {
			name: "Charger: toggle done",
		});
		await charger.check();
		const failed = page.getByTestId("canvas-save-failed");
		await expect(failed).toContainText("Could not save the board.", {
			timeout: 10_000,
		});
		refuse = false;
		await failed.getByRole("button", { name: "Retry" }).click();
		await savedStatus(page);
		await expect(failed).toHaveCount(0);

		// Too big to save: a sentence, not silence.
		await page.unroute("**/api/artifacts/*/body**");
		await page.route("**/api/artifacts/*/body**", (route) =>
			route.fulfill({
				status: 413,
				contentType: "application/json",
				body: JSON.stringify({ ok: false, reason: "too_large" }),
			}),
		);
		await charger.uncheck();
		await expect(page.getByTestId("canvas-too-large")).toContainText(
			"This board is too big to save.",
			{ timeout: 10_000 },
		);

		// Deleted while open: the board area says so, and no further writes are tried.
		await page.unroute("**/api/artifacts/*/body**");
		await page.route("**/api/artifacts/*/body**", (route) =>
			route.fulfill({
				status: 404,
				contentType: "application/json",
				body: JSON.stringify({ ok: false, reason: "not_found" }),
			}),
		);
		await charger.check();
		await expect(page.getByTestId("canvas-deleted")).toContainText(
			"This board was deleted.",
			{ timeout: 10_000 },
		);
		await expect(page.getByTestId("canvas-board")).toHaveCount(0);
	});

	test("the chat's card says what the board holds and opens it", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Card and board");
		const artifactId = await seedCanvas(
			conversationId,
			seededBoard(),
			"Weekend board",
		);
		// The message a create_artifact call leaves behind (artifact-delete.spec.ts's shape).
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			messageSequence: 900,
			role: "assistant",
			content: "Made the board.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId: "e2e-canvas-call",
					name: "create_artifact",
					input: { artifactType: "canvas", title: "Weekend board" },
					status: "done",
					outputSummary: 'Created Canvas "Weekend board"',
					sourceType: "tool",
					metadata: {
						ok: true,
						artifactId,
						artifactKind: "canvas",
						artifactTitle: "Weekend board",
					},
				},
			]),
			createdAt: new Date(),
		});
		await openChatAndReload(page, conversationId);

		const head = page.getByTestId("artifact-card-head");
		await expect(head).toContainText("Canvas · 6 blocks");
		await expect(head).toContainText("v1");
		// No board is drawn in the chat: the card is the head, nothing more.
		await expect(page.locator(".svelte-flow")).toHaveCount(0);
		await head.click();
		await expect(page.getByTestId("canvas-board")).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByTestId("canvas-node")).toHaveCount(6);
	});

	test("offers a retry when the board cannot be opened", async ({ page }) => {
		const conversationId = await createConversation(page, "Cannot open");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		let failing = true;
		await page.route(/\/api\/artifacts\/[^/?]+(\?.*)?$/, (route) =>
			failing && route.request().method() === "GET"
				? route.fulfill({ status: 500, body: "{}" })
				: route.continue(),
		);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.first()
			.click();
		const error = page.getByTestId("canvas-load-error");
		await expect(error).toBeVisible({ timeout: 10_000 });
		await expect(error).toContainText("Could not open the board.");
		failing = false;
		await error.getByRole("button", { name: "Retry" }).click();
		await expect(page.getByTestId("canvas-board")).toBeVisible({
			timeout: 10_000,
		});
	});

	test("names every control and every block, and the keyboard reaches the toolbar before the blocks", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Names and order");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const toolbar = page.getByRole("toolbar", { name: "Canvas tools" });
		await expect(toolbar).toBeVisible();
		for (const name of [
			"Select",
			"Pan",
			"Draw",
			"Comment",
			"Undo",
			"Redo",
			"Insert",
			"Ask Alfy",
		]) {
			await expect(toolbar.getByRole("button", { name })).toBeVisible();
		}
		// A mode says whether it is on; the menu button says what it opens.
		await expect(
			toolbar.getByRole("button", { name: "Select" }),
		).toHaveAttribute("aria-pressed", "true");
		await expect(toolbar.getByRole("button", { name: "Pan" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		await expect(
			toolbar.getByRole("button", { name: "Insert" }),
		).toHaveAttribute("aria-haspopup", "menu");
		// Each block is announced by what it is and what it says.
		await expect(
			page.getByRole("group", { name: "Sticky note: Lunch at the market" }),
		).toBeVisible();
		await expect(
			page.getByRole("group", { name: "Text: Weekend plan" }),
		).toBeVisible();
		await expect(
			page.getByRole("group", { name: "Frame: Saturday" }),
		).toBeVisible();
		await expect(
			page.getByRole("group", { name: "Checklist: Pack" }),
		).toBeVisible();

		await expect(
			toolbar.getByRole("button", { name: "Comment" }),
		).toHaveAttribute("aria-pressed", "false");

		// Tab order: Select, Pan, Draw, Comment (Undo and Redo are off with nothing
		// to undo), Insert, Ask Alfy, then on into the blocks.
		await toolbar.getByRole("button", { name: "Select" }).focus();
		await page.keyboard.press("Tab");
		await expect(toolbar.getByRole("button", { name: "Pan" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(toolbar.getByRole("button", { name: "Draw" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(
			toolbar.getByRole("button", { name: "Comment" }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(toolbar.getByRole("button", { name: "Insert" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(
			toolbar.getByRole("button", { name: "Ask Alfy" }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		const landedOnABlock = await page.evaluate(() =>
			document.activeElement?.classList.contains("svelte-flow__node"),
		);
		expect(landedOnABlock).toBe(true);
		// And it shows where it is: a real outline, from the app's focus ring.
		const outline = await page.evaluate(() => {
			const style = getComputedStyle(document.activeElement as Element);
			return {
				style: style.outlineStyle,
				width: Number.parseFloat(style.outlineWidth),
			};
		});
		expect(outline.style).not.toBe("none");
		expect(outline.width).toBeGreaterThanOrEqual(2);
	});

	test("opens a block for editing from the keyboard: Enter on the focused note", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Keyboard edit");
		const artifactId = await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const note = page.getByRole("group", {
			name: "Sticky note: Lunch at the market",
		});
		await note.focus();
		await page.keyboard.press("Enter");
		const field = page.getByRole("textbox", { name: "Sticky note" });
		await expect(field).toBeFocused();
		await page.keyboard.type(", then coffee");
		await page.keyboard.press("Escape");
		// Focus is back on the note, not lost.
		await expect(note).toBeFocused();
		await savedStatus(page);
		expect(
			(await storedBoard(artifactId)).nodes.find(
				(node) => node.id === BOARD.note,
			)?.data,
		).toMatchObject({ text: "Lunch at the market, then coffee" });
	});

	test("collapses its toolbar on a phone: no Pan, and every button is a full-size touch target", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "On the phone");
		await seedCanvas(conversationId, seededBoard());
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const toolbar = page.getByTestId("canvas-toolbar");
		await expect(toolbar).toBeVisible();
		await expect(page.getByTestId("canvas-tool-select")).toBeVisible();
		await expect(page.getByTestId("canvas-insert-button")).toBeVisible();
		await expect(page.getByTestId("canvas-tool-pan")).toHaveCount(0);
		const box = await toolbar.boundingBox();
		expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
		// No overview on a phone: the room is the board's.
		await expect(page.locator(".svelte-flow__minimap")).toHaveCount(0);
		// Every tool is a full-size touch target.
		for (const button of await toolbar.getByRole("button").all()) {
			const size = await button.boundingBox();
			expect(size && size.width >= 44 && size.height >= 44).toBe(true);
		}
		// The zoom sits above the toolbar, not under it.
		const zoom = await page.getByTestId("canvas-zoom").boundingBox();
		expect(zoom && box && zoom.y + zoom.height <= box.y).toBe(true);
		await expect(
			page.getByRole("toolbar", { name: "Canvas tools" }),
		).toBeVisible();
	});
});
