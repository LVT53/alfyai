import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import {
	cameraOf,
	expectCamera,
	openCanvasPanel,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	settledCamera,
	storedBoard,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

/**
 * A block's edit form opens where the reader can use it (final re-check RC-F, IMP-3).
 *
 * The form is drawn in the block, at the board's zoom, and it makes the block
 * taller. A block in the lower half of the pane put its Save and Cancel below the
 * pane, with the board's own palette over the rest of the form: the only way to
 * save was the keyboard. The phone has its own sheet (CV-B2); a window wide enough
 * for the form in the block now brings the form into view when it opens, by the
 * least the camera has to move, and never under the floating layers.
 *
 * Real input throughout: a click on the block, a click on its toolbar's Edit, the
 * keys of the title, and a click on Save.
 */

const FLOWCHART = [
	"flowchart TD",
	"  A[Airport] --> B[Bus or S-Bahn]",
	"  B --> C[Wien Mitte]",
	"  C --> D[U3 metro]",
	"  D --> E[Hotel]",
].join("\n");

const COSTS = JSON.stringify({
	type: "bar",
	data: {
		labels: ["Museum", "Lunch", "Dinner"],
		datasets: [{ label: "EUR", data: [40, 30, 60] }],
	},
});

function note(id: string, x: number, y: number): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 200,
		data: { kind: "sticky", text: `Note ${id}`, tone: "yellow" },
	};
}

/**
 * A board with its own camera (so it is not fitted on open and the blocks are where
 * they were put): two notes along the top and the block under test at `at`.
 */
function board(
	kind: "mermaid" | "chart",
	at: { x: number; y: number },
	width = 420,
): CanvasBody {
	const target: CanvasNode =
		kind === "mermaid"
			? {
					id: "target",
					type: "mermaid",
					position: at,
					width,
					data: { kind: "mermaid", label: "Airport to hotel", code: FLOWCHART },
				}
			: {
					id: "target",
					type: "chart",
					position: at,
					width,
					data: { kind: "chart", label: "Costs", code: COSTS },
				};
	return {
		version: 1,
		nodes: [note("a", 20, 20), note("b", 260, 20), target],
		edges: [],
		viewport: { x: 16, y: 16, zoom: 1 },
		annotations: [],
	};
}

type Rect = { left: number; top: number; right: number; bottom: number };

async function rectOf(locator: Locator): Promise<Rect | null> {
	const box = await locator.boundingBox();
	if (!box) return null;
	return {
		left: box.x,
		top: box.y,
		right: box.x + box.width,
		bottom: box.y + box.height,
	};
}

function meet(a: Rect, b: Rect): boolean {
	return (
		a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
	);
}

async function topmostAtCentre(page: Page, locator: Locator): Promise<boolean> {
	const handle = await locator.elementHandle();
	if (!handle) return false;
	return page.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const hit = document.elementFromPoint(
			box.left + box.width / 2,
			box.top + box.height / 2,
		);
		return hit !== null && (hit === element || element.contains(hit));
	}, handle);
}

/** Waits for what the block draws (the diagram, the plot), selects it with a click on its head and presses its toolbar's Edit. */
async function openForm(page: Page, kind: "mermaid" | "chart") {
	await expect(
		page
			.getByTestId(kind === "mermaid" ? "canvas-mermaid" : "canvas-chart")
			.first(),
	).toBeVisible({ timeout: 30_000 });
	await settledCamera(page);
	const head = page
		.locator('.svelte-flow__node[data-id="target"] .canvas-node__head')
		.first();
	const at = await head.boundingBox();
	if (!at) throw new Error("the block has no head on the screen");
	await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
	const edit = page.getByTestId("canvas-node-edit");
	await expect(edit).toBeVisible();
	const button = await edit.boundingBox();
	if (!button) throw new Error("the toolbar has no Edit");
	await page.mouse.click(
		button.x + button.width / 2,
		button.y + button.height / 2,
	);
	await expect(page.getByTestId("canvas-edit-form")).toBeVisible();
}

/** What the reader needs to be able to reach: the form's buttons, whole, and not under anything the board floats over it. */
async function expectFormReachable(page: Page, where: string) {
	const pane = await rectOf(page.getByTestId("canvas-board"));
	const save = page.getByTestId("canvas-edit-save");
	const cancel = page.getByTestId("canvas-edit-cancel");
	if (!pane) throw new Error("no board");
	for (const [name, button] of [
		["Save", save],
		["Cancel", cancel],
	] as const) {
		const rect = await rectOf(button);
		if (!rect) throw new Error(`no ${name} button ${where}`);
		expect(
			rect.top,
			`${name} is above the pane ${where}`,
		).toBeGreaterThanOrEqual(pane.top);
		expect(
			rect.bottom,
			`${name} is below the pane ${where}`,
		).toBeLessThanOrEqual(pane.bottom);
		expect(
			rect.left,
			`${name} is left of the pane ${where}`,
		).toBeGreaterThanOrEqual(pane.left);
		expect(
			rect.right,
			`${name} is right of the pane ${where}`,
		).toBeLessThanOrEqual(pane.right);
		expect(
			await topmostAtCentre(page, button),
			`something is over ${name} ${where}`,
		).toBe(true);
	}
	// The whole form clear of the palette, the zoom control and the overview.
	const form = await rectOf(page.getByTestId("canvas-edit-form"));
	if (!form) throw new Error("no form");
	for (const [name, layer] of [
		["the palette", page.getByTestId("canvas-toolbar")],
		["the zoom control", page.getByTestId("canvas-zoom")],
		["the overview", page.locator(".svelte-flow__minimap")],
	] as const) {
		if (!(await layer.count())) continue;
		const rect = await rectOf(layer);
		if (rect) {
			expect(meet(form, rect), `the form is under ${name} ${where}`).toBe(
				false,
			);
		}
	}
}

/** Signs in, seeds the board and opens the panel on it; answers the board's id, to read what was saved. */
async function openBoardWithId(page: Page, title: string, body: CanvasBody) {
	await login(page);
	const conversationId = await createConversation(page, title);
	const boardId = await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return boardId;
}

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
});

for (const kind of ["mermaid", "chart"] as const) {
	test(`${kind}: a form that opens low on the board is brought into view, whole and clear of the palette, and Save can be pressed`, async ({
		page,
	}) => {
		const boardId = await openBoardWithId(
			page,
			`Reveal ${kind}`,
			board(kind, { x: 60, y: 420 }),
		);
		await openForm(page, kind);
		await settledCamera(page);
		await expectFormReachable(page, "after the form opened low on the board");

		// The title is typed into, and a real click on Save keeps it.
		await page.getByTestId("canvas-edit-title").fill("Reptér és szálloda");
		const save = await page.getByTestId("canvas-edit-save").boundingBox();
		if (!save) throw new Error("no Save");
		await page.mouse.click(save.x + save.width / 2, save.y + save.height / 2);
		await expect(page.getByTestId("canvas-edit-form")).toHaveCount(0);
		await savedStatus(page);
		const stored = (await storedBoard(boardId)).nodes.find(
			(node) => node.id === "target",
		);
		expect((stored?.data as { label?: string }).label).toBe(
			"Reptér és szálloda",
		);
	});
}

test("a form at the right edge, low on the board, is not left under the overview or the zoom control", async ({
	page,
}) => {
	// The chart's right edge is within the pane's last 100 px: its Save (the form's
	// bottom right) lands where the overview and the zoom control are.
	await openBoardWithId(
		page,
		"Reveal right",
		board("chart", { x: 540, y: 420 }, 360),
	);
	await openForm(page, "chart");
	await settledCamera(page);
	await expectFormReachable(page, "after the form opened at the right edge");
});

test("a form that opens where it can be used does not move the board", async ({
	page,
}) => {
	await openBoardWithId(
		page,
		"Reveal none",
		board("chart", { x: 60, y: 80 }, 360),
	);
	const before = await settledCamera(page);
	await openForm(page, "chart");
	await page.waitForTimeout(600);
	expectCamera(
		await cameraOf(page),
		before,
		"the camera is the reader's: nothing moves it when the form already fits",
	);
	await expectFormReachable(page, "with the form near the top");
});
