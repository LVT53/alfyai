import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	users,
} from "../../src/lib/server/db/schema";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	boardJson,
	emptyCanvasBody,
} from "../../src/lib/shared/artifacts/canvas-body";
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
	map: "map-route",
} as const;

/** A board with every block kind this slice draws, and one it cannot (a map), at the default camera so it is fitted on open. */
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
				id: BOARD.map,
				type: "map",
				position: { x: 480, y: 400 },
				data: {
					kind: "map",
					route: "Vienna to Salzburg",
					map: {
						bounds: { minLat: 47.8, minLng: 13, maxLat: 48.2, maxLng: 16.4 },
						attribution: "OpenStreetMap",
					},
				},
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function seedCanvas(
	conversationId: string,
	body: CanvasBody,
	title = "Weekend board",
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	const json = boardJson(body);
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: json,
		metadataJson: JSON.stringify({ artifactType: "canvas", title }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy made the board",
		body: json,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

async function storedBoard(artifactId: string): Promise<CanvasBody> {
	const [row] = await db
		.select({ contentText: artifacts.contentText })
		.from(artifacts)
		.where(eq(artifacts.id, artifactId))
		.limit(1);
	return JSON.parse(row.contentText ?? "{}") as CanvasBody;
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** Opens the panel on the chat's one Canvas (the count button, then its row); a no-op when the reload already restored it. */
async function openCanvasPanel(page: Page) {
	const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
	const editor = page.getByTestId("canvas-editor");
	const alreadyShowing = await editor
		.waitFor({ state: "visible", timeout: 2_000 })
		.then(() => true)
		.catch(() => false);
	if (!alreadyShowing) {
		await page
			.getByTestId(
				isMobile ? "artifact-count-button-compact" : "artifact-count-button",
			)
			.click();
		await page
			.getByTestId(
				isMobile ? "artifact-panel-list-mobile" : "artifact-panel-list",
			)
			.getByTestId("artifact-row")
			.first()
			.click();
	}
	await expect(editor).toBeVisible();
	// The loading skeleton gives way to the board.
	await expect(page.getByTestId("canvas-board")).toBeVisible({
		timeout: 15_000,
	});
	// Svelte Flow reveals a node only once it has measured it.
	await expect(async () => {
		const hidden = await page
			.locator(".svelte-flow__node")
			.evaluateAll(
				(nodes) =>
					nodes.filter((node) => getComputedStyle(node).visibility === "hidden")
						.length,
			);
		expect(hidden).toBe(0);
	}).toPass({ timeout: 10_000 });
}

async function nodeCount(page: Page): Promise<number> {
	return page.getByTestId("canvas-node").count();
}

async function savedStatus(page: Page) {
	await expect(page.getByTestId("canvas-save-status")).toHaveText(/Saved/, {
		timeout: 10_000,
	});
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
			["checklist", "chart", "frame", "map", "sticky", "text"].sort(),
		);
		await expect(page.getByText("Lunch at the market")).toBeVisible();
		await expect(page.getByText("Weekend plan")).toBeVisible();
		await expect(page.getByTestId("canvas-frame-label")).toHaveText("Saturday");
		await expect(
			page.getByRole("checkbox", { name: "Passport: toggle done" }),
		).toBeChecked();
		// A kind this build has no component for is drawn as a card that says so,
		// and stays on the board.
		await expect(page.locator('[data-missing="true"]')).toHaveCount(1);
		await expect(
			page.getByText("This block's type is not supported any more."),
		).toBeVisible();
		// The chart is the chat's own: it painted a canvas element.
		await expect(
			page.getByTestId("canvas-chart").locator("canvas"),
		).toBeVisible();
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
		for (const name of ["Select", "Pan", "Undo", "Redo", "Insert"]) {
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

		// Tab order: Select, Pan (Undo and Redo are off with nothing to undo), Insert,
		// then on into the blocks.
		await toolbar.getByRole("button", { name: "Select" }).focus();
		await page.keyboard.press("Tab");
		await expect(toolbar.getByRole("button", { name: "Pan" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(toolbar.getByRole("button", { name: "Insert" })).toBeFocused();
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
