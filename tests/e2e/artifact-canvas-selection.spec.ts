import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { artifacts } from "../../src/lib/server/db/schema";
import {
	applyArtifactOps,
	createArtifact,
	createComment,
	listComments,
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

// Asking Alfy about blocks, and commenting on them (Feature 2 · Artifacts, Slice 3,
// step 3): the pill a selection raises, the toolbar's Ask Alfy, the composer they
// open in the comments list, and how the answer lands. The model is not live here
// (no backend is configured): the `@Alfy` route is answered by the test, which
// applies the change through the real ops envelope first (so the review marker and
// the version are real), writes Alfy's reply, and answers as the route would.

const MUSEUM = "note-museum";
const DINNER = "note-dinner";
const LUNCH = "note-lunch";
const CAMERA = { x: 16, y: 16, zoom: 1 };

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
			{
				id: "frame-saturday",
				type: "frame",
				position: { x: 20, y: 20 },
				width: 320,
				height: 260,
				data: { kind: "frame", label: "Saturday", width: 320, height: 260 },
			},
			note(LUNCH, 24, 64, "Lunch at the market", "frame-saturday"),
			note(MUSEUM, 420, 40, "Museum, 14:00"),
			note(DINNER, 420, 200, "Dinner, 19:30"),
		],
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
}

async function open(page: Page) {
	await login(page);
	const conversationId = await createConversation(page, "Selection");
	const userId = await testUserId();
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(board()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return { conversationId, artifactId: created.artifact.id, userId };
}

const node = (page: Page, id: string) =>
	page.locator(`.svelte-flow__node[data-id="${id}"]`);
const pill = (page: Page) => page.getByTestId("canvas-selection-pill");
const composer = (page: Page) => page.getByTestId("comment-composer");

/** A block is selected by a click on its corner: the middle of a note is its text. */
async function select(page: Page, id: string) {
	await node(page, id).click({ position: { x: 6, y: 6 } });
}

/** The museum and the dinner, together: a box drawn over both from empty board, the way a reader does it. */
async function selectBoth(page: Page) {
	const museum = await nodeBox(page, MUSEUM);
	const dinner = await nodeBox(page, DINNER);
	await dragBetween(
		page,
		{ x: museum.x - 24, y: museum.y - 24 },
		{ x: dinner.x + dinner.width + 24, y: dinner.y + dinner.height + 24 },
	);
}

/** Alfy's answer, as the route would give it: the change goes in through the ops envelope, then the reply. */
async function stubAlfy(
	page: Page,
	scene: { artifactId: string; conversationId: string; userId: string },
	ops: unknown[],
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
		const reply = await createComment({
			userId: scene.userId,
			artifactId: scene.artifactId,
			anchor: null,
			author: "alfy",
			body: "Put them side by side.",
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
				reply,
			}),
		});
	});
}

test.describe("the pill a selection raises", () => {
	test("appears under the selected block, clear of the block's own toolbar, and hides on Escape", async ({
		page,
	}) => {
		await open(page);
		await expect(pill(page)).toBeHidden();

		await select(page, MUSEUM);
		await expect(pill(page)).toBeVisible();
		const toolbar = page.getByRole("toolbar", { name: "Selection" });
		await expect(toolbar).toBeVisible();
		await expect(
			toolbar.getByRole("button", { name: /^Ask Alfy/ }),
		).toBeVisible();
		await expect(
			toolbar.getByRole("button", { name: /^Comment/ }),
		).toBeVisible();

		// Under the block, centred, and not on top of the block's own toolbar (above the
		// block when there is room for it, below it when the block is too near the top of
		// the pane: the pill then stands under the toolbar).
		const block = await nodeBox(page, MUSEUM);
		const bar = await toolbar.boundingBox();
		if (!bar) throw new Error("no pill box");
		expect(bar.y).toBeGreaterThanOrEqual(block.y + block.height);
		expect(
			Math.abs(bar.x + bar.width / 2 - (block.x + block.width / 2)),
		).toBeLessThan(4);
		const blockToolbar = await page
			.getByTestId("canvas-node-toolbar")
			.first()
			.boundingBox();
		if (blockToolbar) {
			const apart =
				blockToolbar.y + blockToolbar.height <= bar.y ||
				bar.y + bar.height <= blockToolbar.y;
			expect(apart, "the pill is clear of the block's own toolbar").toBe(true);
			// The toolbar is on one side of the block or the other, never over it.
			const clear =
				blockToolbar.y + blockToolbar.height <= block.y ||
				blockToolbar.y >= block.y + block.height;
			expect(clear, "the toolbar is not over the block").toBe(true);
		}

		// Escape hides the pill and keeps the selection.
		await page.keyboard.press("Escape");
		await expect(pill(page)).toBeHidden();
		await expect(page.getByTestId("canvas-node-toolbar").first()).toBeVisible();
		// A different selection brings it back.
		await select(page, DINNER);
		await expect(pill(page)).toBeVisible();
	});

	test("is not there with nothing selected, and follows a selection of several blocks", async ({
		page,
	}) => {
		await open(page);
		await selectBoth(page);
		await expect(pill(page)).toBeVisible();
		// Under both, not just the first: level with the lower one.
		const upper = await nodeBox(page, MUSEUM);
		const lower = await nodeBox(page, DINNER);
		const bar = await pill(page).boundingBox();
		if (!bar) throw new Error("no pill box");
		expect(bar.y).toBeGreaterThanOrEqual(
			Math.max(upper.y + upper.height, lower.y + lower.height),
		);
		// Nothing selected: click the empty board.
		await page
			.locator(".svelte-flow__pane")
			.click({ position: { x: 30, y: 400 } });
		await expect(pill(page)).toBeHidden();
	});
});

test.describe("Comment and Ask Alfy open the composer on what is selected", () => {
	test("Comment opens an empty box on the block, and the pill steps aside while it is open", async ({
		page,
	}) => {
		await open(page);
		await select(page, MUSEUM);
		await page.getByTestId("canvas-selection-comment").click();
		await expect(composer(page)).toBeVisible();
		await expect(composer(page)).toContainText("New comment on: Museum, 14:00");
		await expect(composer(page).getByRole("textbox")).toHaveValue("");
		await expect(pill(page)).toBeHidden();
		await composer(page).getByRole("textbox").fill("Is this still right?");
		await composer(page).getByRole("button", { name: "Post" }).click();
		await expect(page.getByTestId("canvas-comment")).toContainText(
			"Is this still right?",
		);
	});

	test("Ask Alfy starts with Alfy's name, names every selected block, and the change lands as one change to review", async ({
		page,
	}) => {
		const scene = await open(page);
		await stubAlfy(page, scene, [
			{ op: "move", id: MUSEUM, to: { x: 470, y: 60 } },
			{ op: "move", id: DINNER, to: { x: 470, y: 220 } },
		]);
		await selectBoth(page);
		await page.getByTestId("canvas-selection-ask").click();

		await expect(composer(page)).toContainText(
			"New comment on: Museum, 14:00 and 1 more",
		);
		const field = composer(page).getByRole("textbox");
		await expect(field).toHaveValue("@Alfy ");
		await field.pressSequentially("put these side by side");
		await expect(
			composer(page).getByRole("button", { name: /^Ask Alfy/ }),
		).toBeVisible();
		await composer(page)
			.getByRole("button", { name: /^Ask Alfy/ })
			.click();

		// The request names both blocks (Alfy reads the thread, not the selection).
		await expect
			.poll(
				async () =>
					(
						await listComments({
							userId: scene.userId,
							artifactId: scene.artifactId,
						})
					).length,
			)
			.toBeGreaterThan(0);
		const [thread] = await listComments({
			userId: scene.userId,
			artifactId: scene.artifactId,
		});
		expect(thread.body).toContain("@Alfy put these side by side");
		expect(thread.body).toContain("“Museum, 14:00”");
		expect(thread.body).toContain("“Dinner, 19:30”");
		expect(thread.anchor).toEqual({ kind: "node", nodeId: MUSEUM });

		// Alfy's answer lands as one change to review, exactly as a chat turn's does.
		const review = page.getByTestId("canvas-review-bar");
		await expect(review).toContainText("Alfy changed 2 blocks.", {
			timeout: 30_000,
		});
		await expect(page.getByTestId("canvas-change-pill")).toBeVisible();
		// The reply that made it wears the change's state.
		await expect(page.getByTestId("canvas-comment")).toContainText(
			"Edited · waiting for you",
		);
		await page.getByRole("button", { name: /^Keep all/ }).click();
		await expect(page.getByTestId("canvas-comment")).toContainText("Kept");
		await expect(review).toBeHidden();
	});

	test("the toolbar's Ask Alfy with nothing selected is about the whole board", async ({
		page,
	}) => {
		const scene = await open(page);
		await page.getByTestId("canvas-tool-ask").click();
		await expect(composer(page)).toContainText(
			"New comment on: the whole board",
		);
		await expect(composer(page).getByRole("textbox")).toHaveValue("@Alfy ");
		await composer(page).getByRole("textbox").pressSequentially("tidy up");
		await stubAlfy(page, scene, [
			{ op: "move", id: MUSEUM, to: { x: 470, y: 60 } },
		]);
		await composer(page)
			.getByRole("button", { name: /^Ask Alfy/ })
			.click();
		await expect
			.poll(
				async () =>
					(
						await listComments({
							userId: scene.userId,
							artifactId: scene.artifactId,
						})
					).length,
			)
			.toBeGreaterThan(0);
		const [thread] = await listComments({
			userId: scene.userId,
			artifactId: scene.artifactId,
		});
		expect(thread.anchor?.kind).toBe("point");
		expect(thread.body).toContain("@Alfy tidy up");
	});

	test("with a block selected the toolbar's Ask Alfy is about that block", async ({
		page,
	}) => {
		await open(page);
		await select(page, DINNER);
		await page.getByTestId("canvas-tool-ask").click();
		await expect(composer(page)).toContainText("New comment on: Dinner, 19:30");
		await expect(composer(page).getByRole("textbox")).toHaveValue("@Alfy ");
	});
});

test.describe("by keyboard", () => {
	test.beforeEach(async ({ page }) => {
		// Pinned, so the chord pressed here is the one the app reads on any machine.
		await page.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, "platform", {
				get: () => "Linux x86_64",
			});
			Object.defineProperty(Navigator.prototype, "userAgentData", {
				get: () => ({ platform: "Linux" }),
			});
		});
	});

	test("Ctrl+Alt+A asks Alfy and Ctrl+Alt+M comments, on the selected block", async ({
		page,
	}) => {
		await open(page);
		await select(page, MUSEUM);
		// The pill is what says it is ready (it and the comment parts load on the first selection).
		await expect(pill(page)).toBeVisible();
		await page.keyboard.press("Control+Alt+a");
		await expect(composer(page)).toContainText("New comment on: Museum, 14:00");
		await expect(composer(page).getByRole("textbox")).toHaveValue("@Alfy ");
		await page.keyboard.press("Escape");
		await expect(composer(page)).toBeHidden();

		await select(page, DINNER);
		await expect(pill(page)).toBeVisible();
		await page.keyboard.press("Control+Alt+m");
		await expect(composer(page)).toContainText("New comment on: Dinner, 19:30");
		await expect(composer(page).getByRole("textbox")).toHaveValue("");
	});

	test("both buttons of the pill are reachable and work from the keyboard", async ({
		page,
	}) => {
		await open(page);
		await select(page, MUSEUM);
		const ask = page.getByTestId("canvas-selection-ask");
		await ask.focus();
		await expect(ask).toBeFocused();
		await expect(ask).toHaveAttribute("aria-keyshortcuts", "Control+Alt+A");
		await page.keyboard.press("Enter");
		await expect(composer(page).getByRole("textbox")).toHaveValue("@Alfy ");
		await page.keyboard.press("Escape");

		await select(page, MUSEUM);
		const comment = page.getByTestId("canvas-selection-comment");
		await comment.focus();
		await page.keyboard.press("Space");
		await expect(composer(page).getByRole("textbox")).toHaveValue("");
	});
});

test("Alfy's answer to a request lands where the board's own record can be read again", async ({
	page,
}) => {
	const scene = await open(page);
	await stubAlfy(page, scene, [
		{ op: "move", id: MUSEUM, to: { x: 470, y: 60 } },
	]);
	await select(page, MUSEUM);
	await page.getByTestId("canvas-selection-ask").click();
	await composer(page).getByRole("textbox").pressSequentially("move it right");
	await composer(page)
		.getByRole("button", { name: /^Ask Alfy/ })
		.click();
	await expect(page.getByTestId("canvas-review-bar")).toBeVisible({
		timeout: 30_000,
	});
	// The marker is Alfy's, and it survives a reload: the same one change waits.
	const [row] = await db
		.select({ metadataJson: artifacts.metadataJson })
		.from(artifacts)
		.where(eq(artifacts.id, scene.artifactId));
	expect(
		(
			JSON.parse(row.metadataJson ?? "{}") as {
				review?: { throughVersion: number };
			}
		).review?.throughVersion,
	).toBe(1);
	await page.reload({ waitUntil: "networkidle" });
	await openCanvasPanel(page);
	await expect(page.getByTestId("canvas-review-bar")).toContainText(
		"Alfy changed 1 block.",
		{ timeout: 15_000 },
	);
});
