import { expect, type Page, test } from "@playwright/test";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	cameraOf,
	expectCamera,
	openBoard,
	settledCamera,
} from "./artifact-canvas-helpers";

/**
 * A board that was fitted before a block had drawn its real size (final re-check
 * RC-F, IMP-1).
 *
 * Alfy writes a flowchart with a width and no height: the panel draws it, and
 * Mermaid lays the diagram out a moment after the board has been fitted around
 * the block's empty frame. The block then grows downwards, so the first picture of
 * the board ran off the bottom with a band of nothing above it, until the reader
 * pressed Fit. The rule is the one TR-D1/TR-D3 built for the pane (the camera is
 * still where the fit left it and nobody has touched the board), now also for the
 * blocks: what the fit has to take in changed, so it takes it in again.
 *
 * Everything is the reader's own input or none at all: the board is opened and
 * left alone, then (the control) typed into.
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

/** A board written the way Alfy writes it: every block has a width, only the frames a height. A tail note, when asked for, is the lowest block, so its growth is what changes the room the blocks take. */
function tripBoard(withTail = false): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "frame-sat",
				type: "frame",
				position: { x: 40, y: 40 },
				width: 250,
				height: 250,
				data: { kind: "frame", label: "Saturday", width: 250, height: 250 },
			},
			{
				id: "n1",
				type: "sticky",
				position: { x: 20, y: 60 },
				parentId: "frame-sat",
				width: 190,
				data: { kind: "sticky", text: "Belvedere, 10:00", tone: "yellow" },
			},
			{
				id: "n2",
				type: "sticky",
				position: { x: 20, y: 140 },
				parentId: "frame-sat",
				width: 190,
				data: {
					kind: "sticky",
					text: "Lunch at the Naschmarkt",
					tone: "yellow",
				},
			},
			{
				id: "frame-sun",
				type: "frame",
				position: { x: 330, y: 40 },
				width: 250,
				height: 250,
				data: { kind: "frame", label: "Sunday", width: 250, height: 250 },
			},
			{
				id: "n3",
				type: "sticky",
				position: { x: 20, y: 60 },
				parentId: "frame-sun",
				width: 190,
				data: { kind: "sticky", text: "Schoenbrunn, 10:00", tone: "mint" },
			},
			{
				id: "chart",
				type: "chart",
				position: { x: 620, y: 40 },
				width: 360,
				data: { kind: "chart", label: "Costs", code: COSTS },
			},
			{
				id: "flow",
				type: "mermaid",
				position: { x: 40, y: 330 },
				width: 480,
				data: { kind: "mermaid", label: "Airport to hotel", code: FLOWCHART },
			},
			...(withTail
				? [
						{
							id: "tail",
							type: "sticky" as const,
							position: { x: 620, y: 760 },
							width: 240,
							data: {
								kind: "sticky" as const,
								text: "Pack the umbrella",
								tone: "yellow" as const,
							},
						},
					]
				: []),
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

type Box = { left: number; top: number; right: number; bottom: number };

/** What every block covers on the screen: the union of their boxes. */
async function contentBox(page: Page): Promise<Box> {
	return page.locator(".svelte-flow__node").evaluateAll((nodes) => {
		const boxes = nodes.map((node) => node.getBoundingClientRect());
		return {
			left: Math.min(...boxes.map((box) => box.left)),
			top: Math.min(...boxes.map((box) => box.top)),
			right: Math.max(...boxes.map((box) => box.right)),
			bottom: Math.max(...boxes.map((box) => box.bottom)),
		};
	});
}

async function paneAndPalette(page: Page) {
	const pane = await page.getByTestId("canvas-board").boundingBox();
	const palette = await page.getByTestId("canvas-toolbar").boundingBox();
	if (!pane || !palette) throw new Error("the board is not drawn");
	return { pane, palette };
}

/** The diagram has drawn: its SVG is there, and so is the room it takes. */
async function flowchartDrawn(page: Page) {
	await expect(
		page.getByTestId("canvas-mermaid").locator("svg").first(),
	).toBeVisible({ timeout: 30_000 });
}

for (const size of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
	{ width: 1100, height: 800 },
]) {
	test(`${size.width}x${size.height} docked: a board nobody touched is fitted around the flowchart once it has drawn`, async ({
		page,
	}) => {
		await page.setViewportSize(size);
		await openBoard(page, `Fit ${size.width}`, tripBoard());
		await flowchartDrawn(page);
		const { pane, palette } = await paneAndPalette(page);

		// The board follows the block's size: everything is in the room the fit
		// leaves (the pane's top, and the palette's top at the bottom).
		await expect
			.poll(async () => (await contentBox(page)).bottom, {
				message: "the flowchart runs off the bottom of the pane",
				timeout: 6_000,
			})
			.toBeLessThanOrEqual(palette.y + 1);
		const content = await contentBox(page);
		expect(content.top).toBeGreaterThanOrEqual(pane.y);
		expect(content.left).toBeGreaterThanOrEqual(pane.x);
		expect(content.right).toBeLessThanOrEqual(pane.x + pane.width);

		// And it is the fit the Fit button gives, not just a camera that happens to
		// show everything: no band of nothing above the content.
		const shown = await settledCamera(page);
		await page.getByTestId("canvas-fit").click();
		const fitted = await settledCamera(page);
		expectCamera(shown, fitted, "the first picture is what Fit gives");
	});
}

test("the board stays where the reader left it when a block they are typing in grows", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openBoard(page, "Fit then type", tripBoard(true));
	await flowchartDrawn(page);
	await expect
		.poll(async () => (await contentBox(page)).bottom, { timeout: 6_000 })
		.toBeLessThanOrEqual((await paneAndPalette(page)).palette.y + 1);
	const fitted = await settledCamera(page);

	// The reader's first touch of the board: a double click on the lowest note
	// opens it for typing. From then on the camera is theirs, whatever the note
	// grows to (it is the lowest block: its growth is what a fit would take in).
	const tail = page.locator('.svelte-flow__node[data-id="tail"]');
	const before = await tail.boundingBox();
	await tail.dblclick();
	await expect(page.locator("textarea:focus")).toBeVisible();
	await page.keyboard.type(
		" and a very long line that wraps over several rows of the note, again and again until the note is a good deal taller than it was, and again, and again",
	);
	await expect
		.poll(async () => (await tail.boundingBox())?.height ?? 0, {
			message: "the note grew while it was typed in",
		})
		.toBeGreaterThan((before?.height ?? 0) + 40);
	await page.waitForTimeout(500);
	expectCamera(
		await cameraOf(page),
		fitted,
		"the camera is the reader's once they touched the board",
	);
});
