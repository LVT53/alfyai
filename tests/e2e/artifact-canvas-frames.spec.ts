import { expect, test } from "@playwright/test";
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

// Frames, adoption and connectors on the Canvas (Feature 2 · Artifacts, Slice
// 3, T3). Each Svelte Flow v1 trap the prototype measured is a test here: the
// lowercase `onnodedragstop` (a drop that never adopts is the symptom of the
// camelCase spelling), one handle drag = one edge, a delete that takes its
// edges and not its neighbours, and the marquee wrapper that must not swallow
// clicks. Boards are seeded straight into the database.

const FRIDAY = "frame-friday";
const SATURDAY = "frame-saturday";

function frame(id: string, x: number, y: number, label: string): CanvasNode {
	return {
		id,
		type: "frame",
		position: { x, y },
		width: 280,
		height: 230,
		data: { kind: "frame", label, width: 280, height: 230 },
	};
}

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
		width: 170,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

/** A camera that is not the default, so the board is not fitted on open and screen positions are the seed's. */
const CAMERA = { x: 16, y: 16, zoom: 1 };

function board(
	nodes: CanvasNode[],
	edges: CanvasBody["edges"] = [],
): CanvasBody {
	return { version: 1, nodes, edges, viewport: CAMERA, annotations: [] };
}

async function open(page: import("@playwright/test").Page, body: CanvasBody) {
	const conversationId = await createConversation(page, "Frames");
	const artifactId = await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return artifactId;
}

function centreOf(box: {
	x: number;
	y: number;
	width: number;
	height: number;
}) {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("frames, adoption and connectors on the Canvas", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("a note dragged into a frame joins it: the parent lands in the saved board, re-based, as exactly one new version", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame(FRIDAY, 20, 20, "Friday"),
				note("note-a", 40, 300, "Museum"),
			]),
		);
		const start = centreOf(await nodeBox(page, "note-a"));
		const target = centreOf(await nodeBox(page, FRIDAY));

		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(target.x, target.y, { steps: 14 });
		// While the drag is on, the frame that would take the note says so.
		await expect(
			page.locator(
				`.svelte-flow__node[data-id="${FRIDAY}"] [data-testid="canvas-node"]`,
			),
		).toHaveAttribute("data-drop-target", "true");
		await page.mouse.up();
		await expect(
			page.locator(
				`.svelte-flow__node[data-id="${FRIDAY}"] [data-testid="canvas-node"]`,
			),
		).not.toHaveAttribute("data-drop-target", "true");
		await savedStatus(page);

		const saved = await storedBoard(artifactId);
		const adopted = saved.nodes.find((node) => node.id === "note-a");
		expect(adopted?.parentId).toBe(FRIDAY);
		// Frame-relative: the note sits inside the frame's 280 x 230, not at board coordinates.
		expect(adopted?.position.x).toBeGreaterThan(0);
		expect(adopted?.position.x).toBeLessThan(280);
		expect(adopted?.position.y).toBeGreaterThan(0);
		expect(adopted?.position.y).toBeLessThan(230);
		// Parents first in the body, the way the protocol and the library want it.
		expect(saved.nodes.map((node) => node.id)).toEqual([FRIDAY, "note-a"]);
		// One gesture, one version (the seeded one was Alfy's, so this is the reader's first).
		expect(await versionRows(artifactId)).toHaveLength(2);
		// And it is drawn inside the frame now.
		const frameBox = await nodeBox(page, FRIDAY);
		const noteBox = await nodeBox(page, "note-a");
		expect(noteBox.x).toBeGreaterThanOrEqual(frameBox.x);
		expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(
			frameBox.x + frameBox.width + 1,
		);
	});

	test("dragging it back out releases it, and it keeps the place on the board where it was dropped", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame(FRIDAY, 20, 20, "Friday"),
				note("note-a", 40, 60, "Museum", FRIDAY),
			]),
		);
		const start = centreOf(await nodeBox(page, "note-a"));
		const frameBox = await nodeBox(page, FRIDAY);
		const outside = {
			x: frameBox.x + frameBox.width / 2,
			y: frameBox.y + frameBox.height + 110,
		};
		await dragBetween(page, start, outside);
		await savedStatus(page);

		const saved = await storedBoard(artifactId);
		const released = saved.nodes.find((node) => node.id === "note-a");
		expect(released?.parentId).toBeUndefined();
		// Absolute now: well below the frame's bottom edge (20 + 230).
		expect(released?.position.y).toBeGreaterThan(250);
	});

	test("a nudge inside its frame moves the note and leaves who its parent is alone", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame(FRIDAY, 20, 20, "Friday"),
				note("note-a", 30, 70, "Museum", FRIDAY),
			]),
		);
		const start = centreOf(await nodeBox(page, "note-a"));
		await dragBetween(page, start, { x: start.x + 30, y: start.y + 20 });
		await savedStatus(page);
		const saved = await storedBoard(artifactId);
		const moved = saved.nodes.find((node) => node.id === "note-a");
		expect(moved?.parentId).toBe(FRIDAY);
		expect(moved?.position.x).toBeGreaterThan(50);
	});

	test("a loose note dropped outside every frame changes its position and nothing about frames", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame(FRIDAY, 20, 20, "Friday"),
				note("note-a", 40, 300, "Museum"),
			]),
		);
		const start = centreOf(await nodeBox(page, "note-a"));
		await dragBetween(page, start, { x: start.x + 120, y: start.y + 10 });
		await savedStatus(page);
		const moved = (await storedBoard(artifactId)).nodes.find(
			(node) => node.id === "note-a",
		);
		expect(moved?.parentId).toBeUndefined();
		expect(moved?.position.x).toBeGreaterThan(100);
	});

	test("a note moves straight from one frame into another, re-based to the new one", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame(FRIDAY, 10, 20, "Friday"),
				frame(SATURDAY, 320, 20, "Saturday"),
				note("note-a", 30, 70, "Museum", FRIDAY),
			]),
		);
		const start = centreOf(await nodeBox(page, "note-a"));
		const target = centreOf(await nodeBox(page, SATURDAY));
		await dragBetween(page, start, target);
		await savedStatus(page);
		const moved = (await storedBoard(artifactId)).nodes.find(
			(node) => node.id === "note-a",
		);
		expect(moved?.parentId).toBe(SATURDAY);
		expect(moved?.position.x).toBeLessThan(280);
	});

	test("a frame dragged over another frame is never adopted by it", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame(FRIDAY, 10, 20, "Friday"),
				frame(SATURDAY, 320, 20, "Saturday"),
			]),
		);
		const chips = page.getByTestId("canvas-frame-label");
		const from = centreOf(
			(await chips.nth(1).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 },
		);
		const target = centreOf(await nodeBox(page, FRIDAY));
		await dragBetween(page, from, { x: target.x, y: target.y - 60 });
		await savedStatus(page);
		const saved = await storedBoard(artifactId);
		expect(
			saved.nodes.find((node) => node.id === SATURDAY)?.parentId,
		).toBeUndefined();
		expect(
			saved.nodes.find((node) => node.id === FRIDAY)?.parentId,
		).toBeUndefined();
	});

	test("a drop on a stale version says so and saves nothing", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				frame(FRIDAY, 20, 20, "Friday"),
				note("note-a", 40, 300, "Museum"),
			]),
		);
		await page.route("**/api/artifacts/*/body**", (route) =>
			route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ ok: false, reason: "version_conflict" }),
			}),
		);
		const start = centreOf(await nodeBox(page, "note-a"));
		const target = centreOf(await nodeBox(page, FRIDAY));
		await dragBetween(page, start, target);
		const banner = page.getByTestId("canvas-conflict");
		await expect(banner).toBeVisible({ timeout: 10_000 });
		await expect(banner).toContainText("Someone changed the board");
		// Nothing was written on top of the newer version, and the board takes no more steps.
		expect(
			(await storedBoard(artifactId)).nodes.find((node) => node.id === "note-a")
				?.parentId,
		).toBeUndefined();
		expect(await versionRows(artifactId)).toHaveLength(1);
		await expect(page.getByTestId("canvas-insert-button")).toBeDisabled();
		// Reload shows the board as the server has it: the note is out of the frame.
		await page.unroute("**/api/artifacts/*/body**");
		await banner.getByRole("button", { name: "Reload" }).click();
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		const frameBox = await nodeBox(page, FRIDAY);
		const noteBox = await nodeBox(page, "note-a");
		expect(noteBox.y).toBeGreaterThan(frameBox.y + frameBox.height);
	});

	test("one drag from an anchor is one edge, and a reopened board draws it between the sides that face each other", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				note("note-a", 20, 40, "Museum"),
				note("note-b", 330, 200, "Lunch"),
			]),
		);
		await page
			.locator('.svelte-flow__node[data-id="note-a"]')
			.click({ position: { x: 20, y: 20 } });
		const anchor = page.locator(
			'.svelte-flow__handle[data-nodeid="note-a"][data-handleid="right"]',
		);
		await expect(anchor).toBeVisible();
		const from = centreOf(
			(await anchor.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 },
		);
		// A drop connects to the side it lands near (the library's connection radius), not to the middle of a block.
		const b = await nodeBox(page, "note-b");
		await dragBetween(page, from, { x: b.x + 6, y: b.y + b.height / 2 }, 16);
		await expect(page.locator(".svelte-flow__edge")).toHaveCount(1);
		await savedStatus(page);
		const saved = await storedBoard(artifactId);
		expect(saved.edges).toHaveLength(1);
		expect(saved.edges[0]).toMatchObject({
			source: "note-a",
			target: "note-b",
		});
		// The body stores no sides; a reopened board works them out from where the blocks are.
		expect(saved.edges[0]).not.toHaveProperty("sourceHandle");

		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(page.locator(".svelte-flow__edge")).toHaveCount(1);
		const noteA = await nodeBox(page, "note-a");
		const noteB = await nodeBox(page, "note-b");
		const path = await page
			.locator(".svelte-flow__edge path.svelte-flow__edge-path")
			.first()
			.boundingBox();
		if (!path) throw new Error("the edge has no path");
		// Note B is to the lower right of A, far more across than down: the edge runs from A's right side to B's left.
		expect(Math.abs(path.x - (noteA.x + noteA.width))).toBeLessThan(14);
		expect(Math.abs(path.x + path.width - noteB.x)).toBeLessThan(14);
	});

	test("deleting a selected block takes its edges and nothing else", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board(
				[
					note("note-a", 20, 40, "One"),
					note("note-b", 300, 40, "Two"),
					note("note-c", 160, 240, "Three"),
				],
				[
					{ id: "e-ab", source: "note-a", target: "note-b" },
					{ id: "e-bc", source: "note-b", target: "note-c" },
					{ id: "e-ac", source: "note-a", target: "note-c" },
				],
			),
		);
		await expect(page.locator(".svelte-flow__edge")).toHaveCount(3);
		await page
			.locator('.svelte-flow__node[data-id="note-b"]')
			.click({ position: { x: 20, y: 20 } });
		await page.keyboard.press("Delete");
		await expect(page.locator(".svelte-flow__edge")).toHaveCount(1);
		await savedStatus(page);
		const saved = await storedBoard(artifactId);
		expect(saved.nodes.map((node) => node.id).sort()).toEqual([
			"note-a",
			"note-c",
		]);
		expect(saved.edges).toEqual([
			{ id: "e-ac", source: "note-a", target: "note-c" },
		]);
	});

	test("deleting a frame keeps the notes that were inside it, where they were on the screen", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board(
				[
					frame(FRIDAY, 20, 20, "Friday"),
					note("note-a", 20, 60, "Museum", FRIDAY),
					note("note-b", 20, 150, "Lunch", FRIDAY),
				],
				[{ id: "e-ab", source: "note-a", target: "note-b" }],
			),
		);
		const before = await nodeBox(page, "note-a");
		await page.getByTestId("canvas-frame-label").click();
		await page.keyboard.press("Delete");
		await expect(
			page.locator(`.svelte-flow__node[data-id="${FRIDAY}"]`),
		).toHaveCount(0);
		await savedStatus(page);
		// Still on the board, in the same place, still connected.
		await expect(
			page.locator('.svelte-flow__node[data-id="note-a"]'),
		).toHaveCount(1);
		await expect(page.locator(".svelte-flow__edge")).toHaveCount(1);
		const after = await nodeBox(page, "note-a");
		expect(Math.abs(after.x - before.x)).toBeLessThan(1.5);
		expect(Math.abs(after.y - before.y)).toBeLessThan(1.5);
		const saved = await storedBoard(artifactId);
		expect(saved.nodes.map((node) => node.id)).toEqual(["note-a", "note-b"]);
		expect(saved.nodes.every((node) => node.parentId === undefined)).toBe(true);
		expect(saved.nodes[0].position).toEqual({ x: 40, y: 80 });
		expect(saved.edges).toHaveLength(1);
	});

	test("a checkbox inside a marquee-selected block is still clickable, and a selected note still opens on a double-click", async ({
		page,
	}) => {
		const artifactId = await open(
			page,
			board([
				note("note-a", 30, 40, "Museum"),
				{
					id: "list-a",
					type: "checklist",
					position: { x: 300, y: 40 },
					width: 240,
					data: {
						kind: "checklist",
						label: "Pack",
						items: [{ id: "i1", text: "Passport", done: false }],
					},
				},
			]),
		);
		// A marquee across both, from empty board.
		const a = await nodeBox(page, "note-a");
		const list = await nodeBox(page, "list-a");
		await dragBetween(
			page,
			{ x: a.x - 14, y: a.y - 14 },
			{ x: list.x + list.width + 14, y: list.y + list.height + 14 },
		);
		await expect(page.locator(".svelte-flow__node.selected")).toHaveCount(2);
		await page.getByRole("checkbox", { name: "Passport: toggle done" }).check();
		await savedStatus(page);
		const ticked = (await storedBoard(artifactId)).nodes.find(
			(node) => node.id === "list-a",
		);
		expect(ticked?.data).toMatchObject({ items: [{ id: "i1", done: true }] });
		// The wrapper over the selection swallowed neither.
		await page.getByTestId("canvas-sticky").dblclick();
		await expect(
			page.getByRole("textbox", { name: "Sticky note" }),
		).toBeFocused();
	});

	test.describe("a frame inside a frame (the protocol allows it; a reader never makes one)", () => {
		const OUTER = "frame-outer";
		const INNER = "frame-inner";

		function nested(): CanvasBody {
			const outer: CanvasNode = {
				id: OUTER,
				type: "frame",
				position: { x: 10, y: 10 },
				width: 560,
				height: 380,
				data: { kind: "frame", label: "Weekend", width: 560, height: 380 },
			};
			const inner: CanvasNode = {
				id: INNER,
				type: "frame",
				parentId: OUTER,
				position: { x: 30, y: 60 },
				width: 250,
				height: 200,
				data: { kind: "frame", label: "Saturday", width: 250, height: 200 },
			};
			return board([
				outer,
				inner,
				note("note-in", 20, 50, "Museum", INNER),
				note("note-out", 300, 80, "Lunch", OUTER),
			]);
		}

		test("is drawn inside its parent, and its notes inside it", async ({
			page,
		}) => {
			await open(page, nested());
			const outer = await nodeBox(page, OUTER);
			const inner = await nodeBox(page, INNER);
			const held = await nodeBox(page, "note-in");
			expect(inner.x).toBeGreaterThanOrEqual(outer.x);
			expect(inner.y).toBeGreaterThanOrEqual(outer.y);
			expect(inner.x + inner.width).toBeLessThanOrEqual(
				outer.x + outer.width + 1,
			);
			expect(inner.y + inner.height).toBeLessThanOrEqual(
				outer.y + outer.height + 1,
			);
			expect(held.x).toBeGreaterThanOrEqual(inner.x);
			expect(held.x + held.width).toBeLessThanOrEqual(
				inner.x + inner.width + 1,
			);
			// Both name chips are there and readable: neither frame hides the other.
			await expect(page.getByTestId("canvas-frame-label")).toHaveText([
				"Weekend",
				"Saturday",
			]);
		});

		test("takes a note dropped in it before its parent: the innermost frame wins", async ({
			page,
		}) => {
			const artifactId = await open(page, nested());
			const start = centreOf(await nodeBox(page, "note-out"));
			const target = centreOf(await nodeBox(page, INNER));
			await dragBetween(page, start, { x: target.x, y: target.y + 40 });
			await savedStatus(page);
			const moved = (await storedBoard(artifactId)).nodes.find(
				(node) => node.id === "note-out",
			);
			expect(moved?.parentId).toBe(INNER);
		});

		test("moves with its notes when dragged by its chip, and stays in its parent while it stays over it", async ({
			page,
		}) => {
			const artifactId = await open(page, nested());
			const before = await nodeBox(page, "note-in");
			const chip = centreOf(
				(await page.getByTestId("canvas-frame-label").nth(1).boundingBox()) ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0,
				},
			);
			await dragBetween(page, chip, { x: chip.x + 40, y: chip.y + 30 });
			await savedStatus(page);
			const after = await nodeBox(page, "note-in");
			expect(after.x - before.x).toBeGreaterThan(30);
			const saved = await storedBoard(artifactId);
			const inner = saved.nodes.find((node) => node.id === INNER);
			expect(inner?.parentId).toBe(OUTER);
			expect(inner?.position.x).toBeGreaterThan(30);
			expect(saved.nodes.find((node) => node.id === "note-in")?.parentId).toBe(
				INNER,
			);
		});

		test("is released to the board when dragged out of its parent, its notes still in it", async ({
			page,
		}) => {
			const artifactId = await open(page, nested());
			const outer = await nodeBox(page, OUTER);
			const chip = centreOf(
				(await page.getByTestId("canvas-frame-label").nth(1).boundingBox()) ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0,
				},
			);
			await dragBetween(page, chip, {
				x: chip.x,
				y: outer.y + outer.height + 150,
			});
			await savedStatus(page);
			const saved = await storedBoard(artifactId);
			expect(
				saved.nodes.find((node) => node.id === INNER)?.parentId,
			).toBeUndefined();
			expect(saved.nodes.find((node) => node.id === "note-in")?.parentId).toBe(
				INNER,
			);
			// Parents first, still.
			const order = saved.nodes.map((node) => node.id);
			expect(order.indexOf(INNER)).toBeLessThan(order.indexOf("note-in"));
		});

		test("stays whole when its parent is deleted: it moves up to the board with what is in it", async ({
			page,
		}) => {
			const artifactId = await open(page, nested());
			const before = await nodeBox(page, INNER);
			await page.getByTestId("canvas-frame-label").first().click();
			await page.keyboard.press("Delete");
			await expect(
				page.locator(`.svelte-flow__node[data-id="${OUTER}"]`),
			).toHaveCount(0);
			await savedStatus(page);
			const after = await nodeBox(page, INNER);
			expect(Math.abs(after.x - before.x)).toBeLessThan(1.5);
			expect(Math.abs(after.y - before.y)).toBeLessThan(1.5);
			const saved = await storedBoard(artifactId);
			expect(saved.nodes.map((node) => node.id).sort()).toEqual(
				[INNER, "note-in", "note-out"].sort(),
			);
			expect(
				saved.nodes.find((node) => node.id === INNER)?.parentId,
			).toBeUndefined();
			expect(saved.nodes.find((node) => node.id === "note-in")?.parentId).toBe(
				INNER,
			);
			expect(
				saved.nodes.find((node) => node.id === "note-out")?.parentId,
			).toBeUndefined();
		});
	});
});
