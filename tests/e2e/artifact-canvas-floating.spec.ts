import { expect, type Page, test } from "@playwright/test";
import {
	applyArtifactOps,
	createArtifact,
	listVersions,
} from "../../src/lib/server/services/artifacts";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import {
	dragBetween,
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	testUserId,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// The layers that float over the board stay where the reader can use them (RC-3
// N3): the change pill inside the pane, the selection's pill inside the pane and
// never on the change pill's Keep and Undo (they hang from neighbouring blocks),
// and the zoom control out of the way of a selected block it would cover.

const UPPER = "note-upper";
const LOWER = "note-lower";

function note(id: string, x: number, y: number, text: string): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 180,
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

/**
 * Two notes one above the other with 48 between them (where the change pill hangs:
 * 16 above the lower note's corner), the lower one changed by Alfy and waiting for
 * the reader's Keep or Undo, the panel open on it.
 */
async function open(page: Page, at: { x: number; y: number }) {
	await login(page);
	const conversationId = await createConversation(page, "Floating");
	const userId = await testUserId();
	const board: CanvasBody = {
		version: 1,
		nodes: [
			note(UPPER, at.x, at.y, "Museum, 14:00"),
			note(LOWER, at.x, at.y + 112, "Lunch at the market"),
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Floating board",
		body: boardJson(board),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	const [newest] = await listVersions({
		userId,
		artifactId: created.artifact.id,
		conversationId,
		limit: 1,
	});
	const applied = await applyArtifactOps({
		userId,
		artifactId: created.artifact.id,
		conversationId,
		payload: {
			baseVersionId: newest.id,
			diff: {
				id: "d",
				summary: "Moved lunch",
				ops: [
					{ op: "update_node", id: LOWER, data: { text: "Lunch at 13:00" } },
				],
			},
		},
	});
	if (!applied.ok) throw new Error(applied.reason);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
}

const changePill = (page: Page) => page.getByTestId("canvas-change-pill");
const selectionPill = (page: Page) => page.getByTestId("canvas-selection-pill");

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: ReturnType<Page["locator"]>): Promise<Box> {
	const found = await locator.boundingBox();
	if (!found) throw new Error("no box");
	return found;
}

const meet = (a: Box, b: Box) =>
	a.x < b.x + b.width &&
	a.x + a.width > b.x &&
	a.y < b.y + b.height &&
	a.y + a.height > b.y;

/** Whether a point of the page is on the element, or on something inside it. */
function topmostIs(page: Page, point: { x: number; y: number }, css: string) {
	return page.evaluate(
		({ x, y, css }) => document.elementFromPoint(x, y)?.closest(css) !== null,
		{ x: point.x, y: point.y, css },
	);
}

async function inside(page: Page, inner: Box) {
	const pane = await box(page.getByTestId("canvas-board"));
	expect(inner.x, "left edge").toBeGreaterThanOrEqual(pane.x);
	expect(inner.x + inner.width, "right edge").toBeLessThanOrEqual(
		pane.x + pane.width,
	);
	expect(inner.y, "top edge").toBeGreaterThanOrEqual(pane.y);
	expect(inner.y + inner.height, "bottom edge").toBeLessThanOrEqual(
		pane.y + pane.height,
	);
}

test.describe("the layers that float over a board", () => {
	test("the selection's pill keeps off the change pill's Keep and Undo", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await open(page, { x: 420, y: 40 });
		await expect(changePill(page)).toBeVisible();

		// Under the upper note is where the change pill (above the lower one) hangs.
		await nodeBox(page, UPPER);
		await page
			.locator(`.svelte-flow__node[data-id="${UPPER}"]`)
			.click({ position: { x: 6, y: 6 } });
		const bar = selectionPill(page).getByRole("toolbar", { name: "Selection" });
		await expect(bar).toBeVisible();
		await expect
			.poll(async () => meet(await box(bar), await box(changePill(page))))
			.toBe(false);

		// Keep and Undo can be pressed: what is on top of them is themselves.
		for (const button of [".alfy-change-bar-keep", ".alfy-change-bar-undo"]) {
			const target = await box(changePill(page).locator(button));
			expect(
				await topmostIs(
					page,
					{ x: target.x + target.width / 2, y: target.y + target.height / 2 },
					button,
				),
				button,
			).toBe(true);
		}
		await inside(page, await box(bar));
		await inside(page, await box(changePill(page)));
	});

	test("on a phone, the change pill and the selection's pill stay inside the pane at the edge of the board", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		// Near the left edge the pill, which hangs to the left of the lower note's corner,
		// started off the screen, and the selection's, centred on the upper note, too.
		await open(page, { x: 12, y: 60 });
		await expect(changePill(page)).toBeVisible();
		await inside(page, await box(changePill(page)));

		await page
			.locator(`.svelte-flow__node[data-id="${UPPER}"]`)
			.click({ position: { x: 6, y: 6 } });
		const bar = selectionPill(page).getByRole("toolbar", { name: "Selection" });
		await expect(bar).toBeVisible();
		await expect
			.poll(async () => {
				const found = await box(bar);
				const pane = await box(page.getByTestId("canvas-board"));
				return (
					found.x >= pane.x && found.x + found.width <= pane.x + pane.width
				);
			})
			.toBe(true);
		await inside(page, await box(bar));
		await expect
			.poll(async () => meet(await box(bar), await box(changePill(page))))
			.toBe(false);
		// Keep is pressable through the selection's pill.
		const keep = await box(changePill(page).locator(".alfy-change-bar-keep"));
		expect(
			await topmostIs(
				page,
				{ x: keep.x + keep.width / 2, y: keep.y + keep.height / 2 },
				".alfy-change-bar-keep",
			),
		).toBe(true);
	});

	test("on a phone, the zoom control steps aside from a selected block it would cover", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await open(page, { x: 12, y: 60 });
		const zoom = page.getByTestId("canvas-zoom");
		await expect(zoom).toBeVisible();
		const chip = await box(zoom);

		// Drag the upper note so its lower right corner is under the control.
		const upper = await nodeBox(page, UPPER);
		await dragBetween(
			page,
			{ x: upper.x + 6, y: upper.y + 6 },
			{ x: chip.x - upper.width + 60, y: chip.y - upper.height + 20 },
		);
		const moved = await nodeBox(page, UPPER);
		expect(meet(moved, chip), "the note is under where the control is").toBe(
			true,
		);
		await expect(
			page.locator(`.svelte-flow__node[data-id="${UPPER}"]`),
		).toHaveClass(/selected/);

		// The control is out of the way: nothing of the block is under it.
		await expect(zoom).toBeHidden();
		const corner = {
			x: Math.min(moved.x + moved.width - 6, chip.x + chip.width - 6),
			y: Math.min(moved.y + moved.height - 6, chip.y + chip.height - 6),
		};
		expect(
			await topmostIs(page, corner, ".svelte-flow__node"),
			"the block's corner is the block",
		).toBe(true);

		// Nothing selected: it comes back (a click on the empty top of the pane).
		const pane = await box(page.getByTestId("canvas-board"));
		await page.mouse.click(pane.x + pane.width - 40, pane.y + 60);
		await expect(zoom).toBeVisible();
	});
});
