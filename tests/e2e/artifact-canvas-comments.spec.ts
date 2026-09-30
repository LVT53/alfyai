import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { artifacts, artifactVersions } from "../../src/lib/server/db/schema";
import {
	createComment,
	listComments,
} from "../../src/lib/server/services/artifacts";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import {
	cameraOf,
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
	seedThread,
	storedBoard,
	testUserId,
	versionRows,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import {
	createConversation,
	expectTopmost,
	login,
	waitForMotionToSettle,
} from "./helpers";

// Comments on the board (Feature 2 · Artifacts, Slice 3, T5): the Comment tool,
// the numbered pins, the list the header's button toggles (the Document's own
// cards, in a column, a drawer or the phone sheet), and `@Alfy` in a comment.
// What the unit suites cannot see is here: that a pin really paints above a
// frame's children, that the catcher really covers the pane, that the list and
// the pins are one state in a real browser, and that a board Alfy changed is
// drawn without a reload and saved over without a conflict. The model is not
// live here (no backend is configured); the `@Alfy` route is answered by the
// test, which writes the change to the database first, as the real one would.

const FRAME = "frame-saturday";
const LUNCH = "note-lunch";
const MUSEUM = "note-museum";
const CAMERA = { x: 16, y: 16, zoom: 1 };

function frame(): CanvasNode {
	return {
		id: FRAME,
		type: "frame",
		position: { x: 20, y: 20 },
		width: 320,
		height: 260,
		data: { kind: "frame", label: "Saturday", width: 320, height: 260 },
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
		width: 180,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

function board(): CanvasBody {
	return {
		version: 1,
		nodes: [
			frame(),
			note(LUNCH, 24, 64, "Lunch at the market", FRAME),
			note(MUSEUM, 420, 40, "Museum, 14:00"),
			{
				id: "text-1",
				type: "text",
				position: { x: 420, y: 220 },
				data: { kind: "text", text: "Weekend plan" },
			},
		],
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
}

async function open(page: Page, body: CanvasBody = board()) {
	const conversationId = await createConversation(page, "Comments");
	const artifactId = await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return artifactId;
}

/** The panel's header button, whichever of its two shells (desktop, phone) is showing and whatever the language. */
const commentsButton = (page: Page) =>
	page.locator("[data-testid='artifact-comments-button']:visible");

const pinsOf = (page: Page) => page.getByTestId("canvas-comment-pin");
const cards = (page: Page) => page.getByTestId("canvas-comment");

function centreOf(box: {
	x: number;
	y: number;
	width: number;
	height: number;
}) {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function pinCentre(page: Page, index = 0) {
	const box = await pinsOf(page).nth(index).boundingBox();
	if (!box) throw new Error("no pin box");
	return centreOf(box);
}

/** Arms the Comment tool, clicks a screen point, and writes the words in the list. */
async function commentAt(
	page: Page,
	point: { x: number; y: number },
	words: string,
) {
	await page.getByTestId("canvas-tool-comment").click();
	await expect(page.getByTestId("canvas-comment-catcher")).toBeVisible();
	await page.mouse.click(point.x, point.y);
	const composer = page.getByTestId("comment-composer");
	await expect(composer).toBeVisible();
	await composer.getByRole("textbox").fill(words);
	await composer.locator("button[type='submit']").click();
	await expect(composer).toHaveCount(0);
}

test.describe("comments on the Canvas", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("en");
		await login(page);
	});

	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	test("the Comment tool puts a comment on the block that was clicked: it is written in the list, and pinned to the block's top-right corner", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		const museum = await nodeBox(page, MUSEUM);

		await commentAt(page, centreOf(museum), "Is 14:00 too late?");

		// The tool let go of itself: one click, one comment.
		await expect(page.getByTestId("canvas-tool-comment")).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		await expect(page.getByTestId("canvas-comment-catcher")).toHaveCount(0);
		await expect(cards(page)).toHaveCount(1);
		await expect(cards(page).first()).toContainText("Is 14:00 too late?");
		await expect(cards(page).first()).toContainText("Museum, 14:00");

		await expect(pinsOf(page)).toHaveCount(1);
		await expect(pinsOf(page).first()).toHaveText("1");
		await expect(pinsOf(page).first()).toHaveAccessibleName(
			"Comment 1 on the board",
		);
		const pin = await pinCentre(page);
		expect(Math.abs(pin.x - (museum.x + museum.width))).toBeLessThan(3);
		expect(Math.abs(pin.y - museum.y)).toBeLessThan(3);

		// The header's button says how many are open.
		await expect(commentsButton(page)).toHaveAttribute(
			"aria-label",
			"Comments (1)",
		);

		const [stored] = await listComments({
			userId: await testUserId(),
			artifactId,
		});
		expect(stored.anchor).toEqual({ kind: "node", nodeId: MUSEUM });
		expect(stored.body).toBe("Is 14:00 too late?");
	});

	test("a click on empty board leaves a comment on that spot, in board coordinates, and it is still there after a reload", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		const frameBox = await nodeBox(page, FRAME);
		// Well below the frame and to the left of the notes: nothing is here.
		const spot = { x: frameBox.x + 60, y: frameBox.y + frameBox.height + 90 };

		await commentAt(page, spot, "Put the tram stop here?");

		const pin = await pinCentre(page);
		expect(Math.abs(pin.x - spot.x)).toBeLessThan(3);
		expect(Math.abs(pin.y - spot.y)).toBeLessThan(3);
		await expect(cards(page).first()).toContainText("a spot on the board");
		const [stored] = await listComments({
			userId: await testUserId(),
			artifactId,
		});
		expect(stored.anchor?.kind).toBe("point");

		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(pinsOf(page)).toHaveCount(1);
		const again = await pinCentre(page);
		expect(Math.abs(again.x - spot.x)).toBeLessThan(3);
		expect(Math.abs(again.y - spot.y)).toBeLessThan(3);
	});

	test("a block that is selected when the tool is armed takes the comment at once, with no second click", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		const museum = await nodeBox(page, MUSEUM);
		await page.mouse.click(museum.x + 90, museum.y + 20);
		await expect(
			page.locator(`.svelte-flow__node[data-id="${MUSEUM}"]`),
		).toHaveClass(/selected/);

		await page.getByTestId("canvas-tool-comment").click();

		await expect(page.getByTestId("comment-composer")).toBeVisible();
		await expect(page.getByTestId("comment-composer")).toContainText(
			"Museum, 14:00",
		);
		await expect(page.getByTestId("canvas-comment-catcher")).toHaveCount(0);
		await page
			.getByTestId("comment-composer")
			.getByRole("textbox")
			.fill("Book it?");
		await page
			.getByTestId("comment-composer")
			.locator("button[type='submit']")
			.click();
		await expect(cards(page)).toHaveCount(1);
		const [stored] = await listComments({
			userId: await testUserId(),
			artifactId,
		});
		expect(stored.anchor).toEqual({ kind: "node", nodeId: MUSEUM });
	});

	// RV-3 I4: an Insert selects the block it adds, and a block that is selected when
	// the tool is armed takes the comment at once, so a reader who inserted a note
	// and then reached for Comment had the click on the block they meant ignored:
	// the comment was written on the note they had just inserted.
	test("the Comment tool comments on the block that is clicked, even right after an Insert selected another", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);

		await page.getByTestId("canvas-insert-button").click();
		await page.getByTestId("canvas-insert-sticky").click();
		await expect(page.getByTestId("canvas-node")).toHaveCount(5);
		// The new note opens for typing at once; Escape finishes that, and it stays selected.
		await page.keyboard.press("Escape");
		await expect(
			page.locator('[data-testid="canvas-node"][data-selected="true"]'),
		).toHaveCount(1);

		await page.getByTestId("canvas-tool-comment").click();
		// The tool waits to be told where: the new note did not take the comment.
		await expect(page.getByTestId("canvas-comment-catcher")).toBeVisible();
		await expect(page.getByTestId("comment-composer")).toHaveCount(0);

		const museum = await nodeBox(page, MUSEUM);
		await page.mouse.click(museum.x + museum.width / 2, museum.y + 20);
		const composer = page.getByTestId("comment-composer");
		await expect(composer).toBeVisible();
		await expect(composer).toContainText("Museum, 14:00");
		await composer.getByRole("textbox").fill("Book it?");
		await composer.locator("button[type='submit']").click();
		await expect(cards(page)).toHaveCount(1);
		const [stored] = await listComments({
			userId: await testUserId(),
			artifactId,
		});
		expect(stored.anchor).toEqual({ kind: "node", nodeId: MUSEUM });
	});

	test("Escape lets go of the Comment tool without placing anything, and the catcher covers the pane but not the zoom", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await open(page);
		await page.getByTestId("canvas-tool-comment").click();
		const catcher = page.getByTestId("canvas-comment-catcher");
		await expect(catcher).toBeVisible();

		// Edge to edge: no block answers a probe at the pane's inner corners or its middle
		// (the toolbar and the corner panels may, and they are meant to be above it).
		const pane = await page.locator(".svelte-flow").first().boundingBox();
		if (!pane) throw new Error("no pane");
		const probes = [
			{ x: pane.x + 6, y: pane.y + 6 },
			{ x: pane.x + pane.width - 6, y: pane.y + 6 },
			{ x: pane.x + 6, y: pane.y + pane.height - 6 },
			{ x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 },
		];
		for (const probe of probes) {
			const kind = await page.evaluate((at) => {
				const hit = document.elementFromPoint(at.x, at.y);
				if (!hit) return "nothing";
				if (hit.closest("[data-testid='canvas-comment-catcher']"))
					return "catcher";
				if (hit.closest(".svelte-flow__node")) return "block";
				// The toolbar and the library's own panels (zoom, overview, attribution) are meant to be above it.
				if (
					hit.closest("[data-testid='canvas-toolbar'], .svelte-flow__panel")
				) {
					return "catcher";
				}
				return "other";
			}, probe);
			expect(kind, `probe at ${probe.x},${probe.y}`).toBe("catcher");
		}
		// The catcher sits over a block: a click there is the tool's, never the block's.
		const museum = await nodeBox(page, MUSEUM);
		const overBlock = await catcher.evaluate((node, at) => {
			const hit = document.elementFromPoint(at.x, at.y);
			return !!hit && node.contains(hit);
		}, centreOf(museum));
		expect(overBlock).toBe(true);
		// The library's zoom stays reachable above it.
		await expectTopmost(
			page.getByTestId("canvas-zoom").getByRole("button").first(),
			{
				message: "the zoom control must stay above the catcher",
				probe: "center",
			},
		);

		await page.getByTestId("canvas-tool-comment").focus();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("canvas-comment-catcher")).toHaveCount(0);
		await expect(page.getByTestId("canvas-tool-comment")).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		await expect(page.getByTestId("comment-composer")).toHaveCount(0);
	});

	test("a pin paints above a note inside a frame, and can be pressed there", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: LUNCH },
			"Vegetarian?",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(pinsOf(page)).toHaveCount(1);
		// The pin's corner sits on the child note; the frame's own children are lifted to z-index 1.
		await expectTopmost(pinsOf(page).first(), {
			message: "a pin must paint above what is in a frame",
			probe: "center",
		});
		await pinsOf(page).first().click();
		await expect(page.getByTestId("canvas-comments-rail")).toBeVisible();
		await expect(cards(page).first()).toBeFocused();
	});

	test("pressing a pin selects its thread in the list, and 'show on the board' centres the camera on its pin and rings it", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: MUSEUM },
			"About the museum",
		);
		await seedThread(
			artifactId,
			{ kind: "point", x: 30, y: 400 },
			"A spot below the frame",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(pinsOf(page)).toHaveCount(2);
		await expect(pinsOf(page).nth(0)).toHaveText("1");
		await expect(pinsOf(page).nth(1)).toHaveText("2");

		// The list is closed to begin with: a board's room is the board's.
		await expect(page.getByTestId("canvas-comments-rail")).toHaveCount(0);
		await pinsOf(page).nth(1).click();
		const rail = page.getByTestId("canvas-comments-rail");
		await expect(rail).toBeVisible();
		await expect(cards(page).nth(1)).toBeFocused();
		await expect(pinsOf(page).nth(1)).toHaveAttribute("aria-current", "true");

		// Send the camera somewhere else, then ask the card to show its pin.
		await page.getByTestId("canvas-tool-pan").click();
		const pane = await page.locator(".svelte-flow").first().boundingBox();
		if (!pane) throw new Error("no pane");
		await page.mouse.move(pane.x + 300, pane.y + 300);
		await page.mouse.down();
		await page.mouse.move(pane.x + 100, pane.y + 220, { steps: 8 });
		await page.mouse.up();
		const before = await cameraOf(page);
		await cards(page)
			.first()
			.getByRole("button", { name: "Show Museum, 14:00 on the board" })
			.click();
		await expect(pinsOf(page).first()).toHaveClass(/pin--flash/);
		await expect
			.poll(async () => {
				const camera = await cameraOf(page);
				return camera.x !== before.x || camera.y !== before.y;
			})
			.toBe(true);
		await waitForMotionToSettle(page);
		// The pin is now in the middle of the pane (the column is the pane's neighbour, not its part).
		const flow = await page.locator(".svelte-flow").first().boundingBox();
		const pin = await pinCentre(page, 0);
		if (!flow) throw new Error("no pane");
		expect(Math.abs(pin.x - (flow.x + flow.width / 2))).toBeLessThan(6);
		expect(Math.abs(pin.y - (flow.y + flow.height / 2))).toBeLessThan(6);
	});

	test("a thread whose block was deleted is in the folded group, dimmed, with no pin", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: "deleted-block" },
			"About the old note",
		);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: MUSEUM },
			"About the museum",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);

		// One pin, and it is the SECOND thread's: its number is its place in the list.
		await expect(pinsOf(page)).toHaveCount(1);
		await expect(pinsOf(page).first()).toHaveText("2");

		await commentsButton(page).click();
		const group = page.getByTestId("margin-orphaned-group");
		await expect(group).toContainText("1 comment on a block that was removed");
		await group.getByRole("button").click();
		const orphan = group.getByTestId("canvas-comment");
		await expect(orphan).toContainText("The block is gone.");
		await expect(orphan).toContainText("About the old note");
		await expect(orphan).toHaveClass(/is-orphaned/);
		expect(
			Number(await orphan.evaluate((node) => getComputedStyle(node).opacity)),
		).toBeLessThan(1);
	});

	test("deleting the block a comment is on takes its pin away and puts the thread in the folded group, at once", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: MUSEUM },
			"About the museum",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await commentsButton(page).click();
		await expect(pinsOf(page)).toHaveCount(1);
		await expect(page.getByTestId("margin-orphaned-group")).toHaveCount(0);

		const museum = await nodeBox(page, MUSEUM);
		await page.mouse.click(museum.x + 90, museum.y + 20);
		await page.keyboard.press("Delete");

		await expect(
			page.locator(`.svelte-flow__node[data-id="${MUSEUM}"]`),
		).toHaveCount(0);
		await expect(pinsOf(page)).toHaveCount(0);
		await expect(page.getByTestId("margin-orphaned-group")).toContainText(
			"1 comment on a block that was removed",
		);
		// The comment itself is not lost with its block.
		const [stored] = await listComments({
			userId: await testUserId(),
			artifactId,
		});
		expect(stored.body).toBe("About the museum");
	});

	test("the keyboard reaches the toolbar, then the blocks, then the pins, and a pin opens the list at its thread", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: MUSEUM },
			"Keyboard question",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);

		// Document order is tab order: toolbar, then blocks, then pins.
		const order = await page.evaluate(() => {
			const toolbar = document.querySelector("[data-testid='canvas-toolbar']");
			const blocks = [...document.querySelectorAll(".svelte-flow__node")];
			const pin = document.querySelector("[data-testid='canvas-comment-pin']");
			const follows = (a: Element | null, b: Element | null) =>
				!!a &&
				!!b &&
				!!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
			return {
				toolbarBeforeBlocks: blocks.every((block) => follows(toolbar, block)),
				blocksBeforePin: blocks.every((block) => follows(block, pin)),
			};
		});
		expect(order).toEqual({ toolbarBeforeBlocks: true, blocksBeforePin: true });

		await pinsOf(page).first().focus();
		await expect(pinsOf(page).first()).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("canvas-comments-rail")).toBeVisible();
		await expect(cards(page).first()).toBeFocused();
		await expect(cards(page).first()).toContainText("Keyboard question");
	});

	test("with reduced motion, jumping to a pin rings it without animating", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: MUSEUM },
			"Quiet please",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await commentsButton(page).click();
		await cards(page)
			.first()
			.getByRole("button", { name: "Show Museum, 14:00 on the board" })
			.click();
		const pin = pinsOf(page).first();
		await expect(pin).toHaveClass(/pin--flash/);
		expect(
			await pin.evaluate((node) => getComputedStyle(node).animationName),
		).toBe("none");
	});

	test("resolving a thread hides its pin and keeps its number; the quiet toggle brings it back, dimmed", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(artifactId, { kind: "point", x: 30, y: 400 }, "First");
		await seedThread(artifactId, { kind: "point", x: 90, y: 440 }, "Second");
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await commentsButton(page).click();
		await expect(cards(page)).toHaveCount(2);

		await cards(page).first().getByRole("button", { name: "Resolve" }).click();
		await expect(pinsOf(page)).toHaveCount(1);
		await expect(pinsOf(page).first()).toHaveText("2");
		await expect(commentsButton(page)).toHaveAttribute(
			"aria-label",
			"Comments (1)",
		);

		await page.getByRole("button", { name: "1 resolved" }).click();
		await expect(pinsOf(page)).toHaveCount(2);
		await expect(pinsOf(page).first()).toHaveText("1");
		await expect(pinsOf(page).first()).toHaveClass(/pin--resolved/);
		await expect(pinsOf(page).first()).toHaveAccessibleName(
			"Comment 1 on the board, resolved",
		);
	});

	test("the list is a drawer over the board when the panel is too narrow for a column, and Escape closes it", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		const artifactId = await open(page);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: MUSEUM },
			"Narrow question",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);

		await commentsButton(page).click();
		const drawer = page.getByTestId("comments-drawer");
		await expect(drawer).toBeVisible();
		await expect(page.getByTestId("canvas-comments-rail")).toHaveCount(0);
		await expect(drawer).toContainText("Narrow question");
		await expect(commentsButton(page)).toHaveAttribute("aria-pressed", "true");
		await page.keyboard.press("Escape");
		await expect(drawer).toHaveCount(0);
		await expect(commentsButton(page)).toHaveAttribute("aria-pressed", "false");
	});

	test("a comment placed while the panel is narrow opens the drawer with its box focused, ready to type", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		await open(page);
		const lunch = await nodeBox(page, LUNCH);
		await page.getByTestId("canvas-tool-comment").click();
		await page.mouse.click(lunch.x + 60, lunch.y + 30);
		const drawer = page.getByTestId("comments-drawer");
		await expect(drawer).toBeVisible();
		const box = drawer.getByTestId("comment-composer").getByRole("textbox");
		await expect(box).toBeFocused();
		// The drawer's own trap does not take the focus back to its close button once the reader is typing.
		await page.keyboard.type("Typed straight away");
		await expect(box).toHaveValue("Typed straight away");
	});

	test("on a phone the comment is written in a sheet, its pin stays on the board, and pressing the pin opens the sheet at its thread", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const artifactId = await open(page);
		// The museum note is off the phone's screen: the lunch note, inside the frame, is not.
		const lunch = await nodeBox(page, LUNCH);

		await page.getByTestId("canvas-tool-comment").click();
		await page.mouse.click(
			lunch.x + lunch.width / 2,
			lunch.y + lunch.height / 2,
		);
		const sheet = page.getByRole("dialog", { name: "Comments" });
		await expect(sheet).toBeVisible();
		// The reader who placed a comment is in its box: the sheet's own focus handling leaves them there.
		await expect(sheet.getByRole("textbox")).toBeFocused();
		await sheet.getByRole("textbox").fill("On my phone");
		await sheet.locator("button[type='submit']").click();
		await expect(cards(page)).toHaveCount(1);
		await sheet.getByRole("button", { name: "Close" }).click();
		await expect(sheet).toHaveCount(0);

		await expect(pinsOf(page)).toHaveCount(1);
		const pin = pinsOf(page).first();
		// A finger needs 44 px: the visible dot is 22, the hit area is not.
		const hit = await pin.evaluate((node) => {
			const after = getComputedStyle(node, "::after");
			return {
				width: parseFloat(after.width),
				height: parseFloat(after.height),
			};
		});
		expect(hit.width).toBeGreaterThanOrEqual(43);
		expect(hit.height).toBeGreaterThanOrEqual(43);

		await pin.click();
		await expect(page.getByRole("dialog", { name: "Comments" })).toBeVisible();
		await expect(cards(page).first()).toContainText("On my phone");
		const [stored] = await listComments({
			userId: await testUserId(),
			artifactId,
		});
		expect(stored.body).toBe("On my phone");
	});

	test("@Alfy: the reader's last step is saved before Alfy is asked, Alfy's change is drawn without a reload, the reply is in the thread, and the next save is not refused", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		const userId = await testUserId();
		// The reader's save is slow (a second and a half), so it is still on its way when
		// they ask: what Alfy is asked against must be what was SAVED, so the ask waits for it.
		await page.route("**/api/artifacts/*/body*", async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await route.continue();
		});
		let savedWhenAsked: string | null = null;
		// Alfy's answer, as the route would give it: the change is a new version first, then the reply.
		await page.route("**/api/artifacts/*/comments/*/alfy*", async (route) => {
			const stored = await storedBoard(artifactId);
			const lunchNode = stored.nodes.find((node) => node.id === LUNCH);
			savedWhenAsked =
				lunchNode?.data.kind === "sticky" ? lunchNode.data.text : null;
			const changed: CanvasBody = {
				...stored,
				nodes: [
					...stored.nodes,
					note("note-added-by-alfy", 420, 300, "Booked for 15:30"),
				],
			};
			const json = boardJson(changed);
			const rows = await versionRows(artifactId);
			const next = (rows.at(-1)?.versionNumber ?? 1) + 1;
			await db
				.update(artifacts)
				.set({ contentText: json, updatedAt: new Date() })
				.where(eq(artifacts.id, artifactId));
			await db.insert(artifactVersions).values({
				id: randomUUID(),
				artifactId,
				userId,
				versionNumber: next,
				author: "alfy",
				summary: "Alfy's comment reply",
				body: json,
				bodyHash: "alfy-hash",
				createdAt: new Date(),
			});
			const [root] = await listComments({ userId, artifactId });
			const reply = await createComment({
				userId,
				artifactId,
				anchor: null,
				author: "alfy",
				body: "Added a note for the new time.",
				parentId: root.id,
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					outcome: "applied",
					applied: 1,
					refused: 0,
					version: next,
					reply,
				}),
			});
		});

		// The reader's own step, made just before they ask: it must be saved first.
		const lunch = await nodeBox(page, LUNCH);
		await page.mouse.dblclick(lunch.x + 60, lunch.y + 30);
		await page.keyboard.press("End");
		await page.keyboard.type(" (two seats)");
		await page
			.getByTestId("canvas-board")
			.click({ position: { x: 700, y: 600 } });

		const museum = await nodeBox(page, MUSEUM);
		await commentAt(
			page,
			centreOf(museum),
			"@Alfy add a note with the new time, 15:30",
		);

		await expect(page.getByText("Added a note for the new time.")).toBeVisible({
			timeout: 15_000,
		});
		// Alfy's change is on the board without a reload, and nothing says it conflicted.
		await expect(page.getByText("Booked for 15:30")).toBeVisible();
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		// The reader's step was saved BEFORE Alfy was asked (Alfy read it), and is in Alfy's version too.
		expect(savedWhenAsked).toBe("Lunch at the market (two seats)");
		const rows = await versionRows(artifactId);
		expect(rows.map((row) => row.author)).toEqual(["alfy", "user", "alfy"]);
		expect(
			(await storedBoard(artifactId)).nodes.find((node) => node.id === LUNCH)
				?.data,
		).toMatchObject({ text: "Lunch at the market (two seats)" });
		// The reader's own undo is emptied: it could only take them back to before Alfy's change.
		await expect(page.getByTestId("canvas-undo")).toBeDisabled();

		// The next thing the reader does is saved, not refused as stale.
		const added = await nodeBox(page, "note-added-by-alfy");
		await page.mouse.move(added.x + 80, added.y + 20);
		await page.mouse.down();
		await page.mouse.move(added.x + 80, added.y + 140, { steps: 8 });
		await page.mouse.up();
		await expect
			.poll(async () => (await versionRows(artifactId)).at(-1)?.author, {
				timeout: 10_000,
			})
			.toBe("user");
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		expect(
			(await storedBoard(artifactId)).nodes.find(
				(node) => node.id === "note-added-by-alfy",
			)?.position.y,
		).toBeGreaterThan(300);
	});

	test("a step the reader takes while Alfy is answering is not lost silently: the board says it changed, and offers Reload", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		const userId = await testUserId();
		await page.route("**/api/artifacts/*/comments/*/alfy*", async (route) => {
			const stored = await storedBoard(artifactId);
			const json = boardJson({
				...stored,
				nodes: [...stored.nodes, note("note-late", 420, 300, "Booked")],
			});
			const rows = await versionRows(artifactId);
			const next = (rows.at(-1)?.versionNumber ?? 1) + 1;
			await db
				.update(artifacts)
				.set({ contentText: json, updatedAt: new Date() })
				.where(eq(artifacts.id, artifactId));
			await db.insert(artifactVersions).values({
				id: randomUUID(),
				artifactId,
				userId,
				versionNumber: next,
				author: "alfy",
				summary: "Alfy's comment reply",
				body: json,
				bodyHash: "alfy-hash-2",
				createdAt: new Date(),
			});
			const [root] = await listComments({ userId, artifactId });
			const reply = await createComment({
				userId,
				artifactId,
				anchor: null,
				author: "alfy",
				body: "Booked.",
				parentId: root.id,
			});
			// Alfy's change is written; the answer is on its way. The reader, who has not
			// heard yet, takes another step in the meantime: their save is against the
			// version they last saw, and the server is past it.
			await new Promise((resolve) => setTimeout(resolve, 3000));
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					outcome: "applied",
					applied: 1,
					refused: 0,
					version: next,
					reply,
				}),
			});
		});
		const museum = await nodeBox(page, MUSEUM);
		await commentAt(page, centreOf(museum), "@Alfy book it");
		// While Alfy thinks, the reader edits a note.
		const lunch = await nodeBox(page, LUNCH);
		await page.mouse.dblclick(lunch.x + 60, lunch.y + 30);
		await page.keyboard.press("End");
		await page.keyboard.type(" (and coffee)");
		await page
			.getByTestId("canvas-board")
			.click({ position: { x: 60, y: 420 } });

		await expect(page.getByTestId("canvas-conflict")).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByTestId("canvas-conflict")).toContainText(
			"Someone changed the board while you were drawing",
		);
		// What the reader wrote is still on their screen until they choose to reload.
		await expect(
			page.getByText("Lunch at the market (and coffee)"),
		).toBeVisible();
	});

	test("when Alfy cannot answer, the comment is still posted and the list says so", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await page.route("**/api/artifacts/*/comments/*/alfy*", (route) =>
			route.fulfill({
				status: 504,
				contentType: "application/json",
				body: JSON.stringify({ ok: false, reason: "aborted" }),
			}),
		);
		const museum = await nodeBox(page, MUSEUM);
		await commentAt(page, centreOf(museum), "@Alfy tidy this up");
		await expect(page.getByRole("alert")).toContainText(
			"Alfy could not answer just now. Your comment is posted.",
		);
		await expect(cards(page).first()).toContainText("@Alfy tidy this up");
		const [stored] = await listComments({
			userId: await testUserId(),
			artifactId,
		});
		expect(stored.body).toBe("@Alfy tidy this up");
	});

	test("says it in Hungarian: the tool, the pin, the list, the quote line", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 1440, height: 900 });
		const artifactId = await open(page);
		await seedThread(artifactId, { kind: "node", nodeId: MUSEUM }, "Túl késő?");
		await seedThread(
			artifactId,
			{ kind: "point", x: 30, y: 400 },
			"Ide jöhet a megálló",
		);
		await seedThread(
			artifactId,
			{ kind: "node", nodeId: "deleted" },
			"Régi jegyzet",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(page.getByTestId("canvas-tool-comment")).toHaveAccessibleName(
			"Megjegyzés",
		);
		await expect(pinsOf(page).first()).toHaveAccessibleName(
			"1. megjegyzés a táblán",
		);
		await commentsButton(page).click();
		await expect(page.getByTestId("canvas-comments-rail")).toContainText(
			"Megjegyzések",
		);
		await expect(page.getByTestId("canvas-comments-rail")).toContainText(
			"egy pont a táblán",
		);
		await expect(page.getByTestId("margin-orphaned-group")).toContainText(
			"1 megjegyzés egy törölt blokkon",
		);
		await page.getByTestId("canvas-tool-comment").click();
		await expect(
			page.getByTestId("canvas-comment-catcher"),
		).toHaveAccessibleName(
			"Kattints a táblára vagy egy blokkra a megjegyzés elhelyezéséhez.",
		);
	});
});
