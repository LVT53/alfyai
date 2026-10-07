import { expect, test } from "@playwright/test";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	bareSpot,
	centre,
	drag,
	nodeOf,
	openTheBoard,
	type Pt,
	seedChat,
	wrapperOf,
} from "./artifact-canvas-edit-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { login } from "./helpers";

// A touchpad's click is a click (Feature 2 · Canvas, CV-B). A laptop's cursor is
// never perfectly still between the press and the release: it wanders a pixel or
// two. The flow library takes any movement for a drag and drops the click that
// follows it, so on a touchpad a click on a File block did nothing, a click on a
// frame's ground did not pick the frame, and a click could nudge a note by a few
// pixels (an undo step of its own). The board tells the library how far a pointer
// may wander and still be pressing. A real drag must still move a block.

/** What the cursor does between the press and the release, in pixels from where it went down. */
const WANDERS: Record<string, Pt[]> = {
	"a pixel and a half": [{ x: 1, y: 1 }],
	"three pixels, out and back": [
		{ x: 1, y: 0 },
		{ x: 2, y: 1 },
		{ x: 3, y: 1 },
		{ x: 2, y: 0 },
		{ x: 0, y: 0 },
	],
};

function board(chatFileId: string): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "note",
				type: "sticky",
				position: { x: 0, y: 0 },
				width: 200,
				data: { kind: "sticky", text: "Hello", tone: "yellow" },
			},
			{
				id: "group",
				type: "frame",
				position: { x: 340, y: 0 },
				width: 300,
				height: 200,
				data: { kind: "frame", label: "Plans", width: 300, height: 200 },
			},
			{
				id: "trip",
				type: "file",
				position: { x: 0, y: 300 },
				width: 260,
				data: {
					kind: "file",
					fileId: chatFileId,
					name: "Vienna trip notes.md",
					mime: "text/markdown",
					bytes: 38,
					label: "MD",
				},
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

async function press(
	page: import("@playwright/test").Page,
	at: Pt,
	wander: Pt[],
) {
	await page.mouse.move(at.x, at.y);
	await page.mouse.down();
	for (const step of wander)
		await page.mouse.move(at.x + step.x, at.y + step.y);
	await page.mouse.up();
}

test.describe("a touchpad's click is a click", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("en");
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	for (const [name, wander] of Object.entries(WANDERS)) {
		test(`a click that wanders ${name}: selects a note without moving it, picks a frame by its ground, opens a file`, async ({
			page,
		}) => {
			const { conversationId } = await seedChat(page, { body: board });
			await openTheBoard(page, conversationId);
			const away = await bareSpot(page);

			const note = (await wrapperOf(page, "note").boundingBox()) as {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			await press(page, centre(note), wander);
			await expect(nodeOf(page, "note")).toHaveAttribute(
				"data-selected",
				"true",
			);
			const after = (await wrapperOf(page, "note").boundingBox()) as {
				x: number;
				y: number;
			};
			expect(Math.abs(after.x - note.x)).toBeLessThan(0.5);
			expect(Math.abs(after.y - note.y)).toBeLessThan(0.5);

			await press(page, away, wander);
			await expect(nodeOf(page, "note")).toHaveAttribute(
				"data-selected",
				"false",
			);
			const group = (await wrapperOf(page, "group").boundingBox()) as {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			await press(
				page,
				{ x: group.x + group.width * 0.5, y: group.y + group.height * 0.6 },
				wander,
			);
			await expect(nodeOf(page, "group")).toHaveAttribute(
				"data-selected",
				"true",
			);

			// The file opens in the panel's own viewer, in place of the board.
			await press(page, away, wander);
			const trip = (await wrapperOf(page, "trip").boundingBox()) as {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			await press(page, centre(trip), wander);
			await expect(page.getByTestId("canvas-board")).toHaveCount(0);
		});
	}

	for (const style of ["mouse", "touchpad"] as const) {
		test(`a real drag with a ${style} still moves a block where it was taken`, async ({
			page,
		}) => {
			const { conversationId } = await seedChat(page, { body: board });
			await openTheBoard(page, conversationId);
			const note = (await wrapperOf(page, "note").boundingBox()) as {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			const from = centre(note);
			await drag(page, style, from, { x: from.x + 120, y: from.y + 80 });
			const after = (await wrapperOf(page, "note").boundingBox()) as {
				x: number;
				y: number;
			};
			// What the pointer travelled, less the few pixels a press may wander before it is a drag.
			expect(after.x - note.x).toBeGreaterThan(105);
			expect(after.x - note.x).toBeLessThan(125);
			expect(after.y - note.y).toBeGreaterThan(65);
			expect(after.y - note.y).toBeLessThan(85);
		});
	}
});
