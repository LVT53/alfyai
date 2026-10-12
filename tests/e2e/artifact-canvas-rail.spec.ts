import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	applyArtifactOps,
	createComment,
	listComments,
	listVersions,
} from "../../src/lib/server/services/artifacts";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import {
	cameraOf,
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
	settledCamera,
	testUserId,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { createEmptyConversation, login } from "./helpers";

// The comments column and the board (phase 5, FX-3, RC-A #7). The column takes 300 px
// off the right of the board's pane. A board the reader has the camera of (one saved
// with a camera of its own, or panned, or zoomed) is not re-fitted for it, so what was on
// its right side ended under the column. The camera is the reader's: the zoom stays and the
// board only slides over by what is needed to keep in view what they were looking at, and
// slides back when the column goes. Real pointer and keyboard input; the page is only
// asked what it shows.

const SHOTS = process.env.FX3_SHOTS ?? null;

function shot(name: string): string {
	if (!SHOTS) throw new Error("no screenshot folder");
	mkdirSync(SHOTS, { recursive: true });
	return join(SHOTS, name);
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
		width: 190,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

/** Three columns that fill the pane at the camera the board is saved with: the reader's own, so nothing re-fits it. */
function threeColumns(): CanvasBody {
	const frame = (id: string, label: string, x: number): CanvasNode => ({
		id,
		type: "frame",
		position: { x, y: 40 },
		width: 340,
		height: 300,
		data: { kind: "frame", label, width: 340, height: 300 },
	});
	return {
		version: 1,
		nodes: [
			frame("frame-sat", "Saturday", 40),
			note("note-sat", 20, 60, "Lunch at the market", "frame-sat"),
			frame("frame-sun", "Sunday", 420),
			note("note-sun", 20, 60, "Brunch, 10:30", "frame-sun"),
			note("note-east-1", 800, 60, "Dinner, 19:30"),
			note("note-east-2", 800, 200, "Concert, 21:00"),
		],
		edges: [],
		viewport: { x: 8, y: 24, zoom: 0.9 },
		annotations: [],
	};
}

const commentsButton = (page: Page) =>
	page.locator("[data-testid='artifact-comments-button']:visible");

async function open(page: Page, body: CanvasBody = threeColumns()) {
	await login(page);
	const conversationId = await createEmptyConversation(page, "Rail");
	await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
}

async function pane(page: Page) {
	const box = await page.getByTestId("canvas-board").boundingBox();
	if (!box) throw new Error("no board");
	return box;
}

test.describe("RC-A #7: the comments column does not crop a board the reader has the camera of", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("opening it slides the board over by what is needed, keeps the zoom, and closing it slides it back", async ({
		page,
	}) => {
		await open(page);
		const before = await settledCamera(page);
		const east = await nodeBox(page, "note-east-2");
		const wide = await pane(page);
		// The setup is the audit's: the last column is in view with the whole pane.
		expect(east.x + east.width).toBeLessThan(wide.x + wide.width);

		await commentsButton(page).click();
		await expect(page.getByTestId("canvas-comments-rail")).toBeVisible();
		await expect
			.poll(
				async () => {
					const narrow = await pane(page);
					const box = await nodeBox(page, "note-east-2");
					return narrow.x + narrow.width - (box.x + box.width);
				},
				{ message: "room between the last column and the comments column" },
			)
			.toBeGreaterThanOrEqual(8);
		// The reader's camera is theirs: the zoom is what they left, and only the board slid.
		const opened = await settledCamera(page);
		expect(opened.zoom, "zoom").toBeCloseTo(before.zoom, 4);
		expect(opened.y, "y").toBeCloseTo(before.y, 1);
		expect(opened.x, "slid left").toBeLessThan(before.x);
		if (SHOTS) {
			await page.screenshot({
				path: shot("rc-a-7-rail-opened-touched-board.png"),
			});
		}

		await commentsButton(page).click();
		await expect(page.getByTestId("canvas-comments-rail")).toHaveCount(0);
		const closed = await settledCamera(page);
		expect(closed.x, "back where it was: x").toBeCloseTo(before.x, 0);
		expect(closed.y, "back where it was: y").toBeCloseTo(before.y, 0);
		expect(closed.zoom, "back where it was: zoom").toBeCloseTo(before.zoom, 4);
	});

	test("a board the reader moved themselves while the column was open is left where they put it when it closes", async ({
		page,
	}) => {
		await open(page);
		await commentsButton(page).click();
		await expect(page.getByTestId("canvas-comments-rail")).toBeVisible();
		await settledCamera(page);
		// The reader pans the board with the wheel (a touchpad's two-finger scroll).
		const board = await pane(page);
		await page.mouse.move(
			board.x + board.width / 2,
			board.y + board.height / 2,
		);
		await page.mouse.wheel(-120, 0);
		const placed = await settledCamera(page);

		await commentsButton(page).click();
		await expect(page.getByTestId("canvas-comments-rail")).toHaveCount(0);
		const closed = await settledCamera(page);
		expect(closed.x, "their camera").toBeCloseTo(placed.x, 0);
		expect(closed.y, "their camera").toBeCloseTo(placed.y, 0);
		expect((await cameraOf(page)).zoom).toBeCloseTo(placed.zoom, 4);
	});
});

// ---- The thread card in the 300 px column -----------------------------------------

/** Alfy's answer, as the route would give it: a rewrite goes in through the ops envelope, then the reply, in Hungarian. */
async function stubAlfy(
	page: Page,
	scene: { artifactId: string; conversationId: string; userId: string },
	ops: unknown[],
	reply: string,
) {
	await page.route("**/api/artifacts/*/comments/*/alfy*", async (route) => {
		const [newest] = await listVersions({
			userId: scene.userId,
			artifactId: scene.artifactId,
			conversationId: scene.conversationId,
			limit: 1,
		});
		const applied = await applyArtifactOps({
			userId: scene.userId,
			artifactId: scene.artifactId,
			conversationId: scene.conversationId,
			payload: {
				baseVersionId: newest.id,
				diff: { id: "d", summary: "Alfy's comment reply", ops },
			},
		});
		if (!applied.ok) throw new Error(applied.reason);
		const [root] = await listComments({
			userId: scene.userId,
			artifactId: scene.artifactId,
		});
		const answer = await createComment({
			userId: scene.userId,
			artifactId: scene.artifactId,
			anchor: null,
			author: "alfy",
			body: reply,
			parentId: root.id,
		});
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				outcome: "applied",
				applied: applied.applied,
				refused: 0,
				version: applied.version,
				reply: answer,
			}),
		});
	});
}

test.describe("RC-A #7: the board's thread card keeps every line inside itself in the 300 px column", () => {
	test.use({ viewport: { width: 1440, height: 900 } });
	test.afterEach(async () => {
		await setUiLanguage("en");
	});

	test("an Alfy reply with a change waiting, in Hungarian, is not wider than its card", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await login(page);
		const conversationId = await createEmptyConversation(page, "Rail");
		const userId = await testUserId();
		const body = threeColumns();
		body.nodes = body.nodes.map((node) =>
			node.id === "note-sat"
				? {
						...node,
						data: {
							kind: "sticky",
							text: "15:00 Belváros: Stephansdom (torony: 10:00–17:30), Hofburg",
							tone: "yellow",
						},
					}
				: node,
		);
		const artifactId = await seedCanvas(conversationId, body);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);
		await stubAlfy(
			page,
			{ artifactId, conversationId, userId },
			[
				{
					op: "update_node",
					id: "note-east-1",
					data: { text: "Vacsora, 19:30, asztalfoglalással" },
				},
			],
			"Bővítettem a szombat délutáni programot a nyitvatartási időkkel és pontosabb tervekkel.",
		);
		await page.getByTestId("canvas-tool-comment").click();
		const note = await nodeBox(page, "note-sat");
		await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2);
		const composer = page.getByTestId("comment-composer");
		await composer
			.getByRole("textbox")
			.fill(
				"Ez túl rövid. @Alfy írd át úgy, hogy legyen benne a nyitvatartási idő is.",
			);
		await composer.getByRole("button", { name: /^Alfy/ }).click();
		const card = page.getByTestId("canvas-comment").first();
		await expect(card).toContainText("rád vár", { timeout: 20_000 });

		const report = await card.evaluate((root) => {
			const box = root.getBoundingClientRect();
			const offenders: string[] = [];
			for (const element of root.querySelectorAll("*")) {
				const rect = element.getBoundingClientRect();
				if (rect.width === 0) continue;
				// A line that is cut short with an ellipsis is meant to be (the quote); one that
				// runs past its card, or is wider than the box that holds it, is clipped.
				const ellipsis = getComputedStyle(element).textOverflow === "ellipsis";
				if (
					rect.right > box.right - 1 ||
					(!ellipsis && element.scrollWidth > element.clientWidth + 1)
				) {
					offenders.push(
						`${element.tagName.toLowerCase()}.${(element as HTMLElement).className} right=${Math.round(rect.right)} (card ${Math.round(box.right)}) scroll=${element.scrollWidth}/${element.clientWidth} "${(element.textContent ?? "").trim().slice(0, 40)}"`,
					);
				}
			}
			return {
				card: `${Math.round(box.left)}..${Math.round(box.right)}`,
				offenders,
			};
		});
		if (SHOTS)
			await page.screenshot({ path: shot("rc-a-7-thread-card-hu.png") });
		expect(report.offenders).toEqual([]);
	});
});
