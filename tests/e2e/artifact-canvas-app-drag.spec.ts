import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifactKv,
	artifacts,
	artifactVersions,
} from "../../src/lib/server/db/schema";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import {
	nodeBox,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
	testUserId,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

// An App block dragged into (or out of) a frame (Feature 2 · Canvas, RV-3 I1).
// The library draws the blocks in the order of the board's list, and a block that
// joins a frame listed AFTER it has to be listed after that frame (a frame comes
// before what it holds), so the App's wrapper is moved in the page. A browser
// reloads an iframe whose ancestor is moved, and that reload used to be taken for
// the App navigating itself: a false "this App tried to leave its sandbox" alarm
// on an ordinary drag. The tripwire itself (ruling 58) must keep catching an App
// that really navigates, so that is asserted here too, on a board.

/** A counter that keeps its count in memory AND in its own storage, and says which document it is (a new document is a new boot id). */
const COUNTER_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Counter</title>
<style>body { font-family: Helvetica, Arial, sans-serif; padding: 12px; }</style>
</head>
<body>
<h1>Counter</h1>
<button id="inc" type="button">Count</button>
<output id="n" data-testid="counter-n">0</output>
<output id="boot" data-testid="counter-boot"></output>
<script>
(function () {
  var n = 0;
  var out = document.getElementById('n');
  document.getElementById('boot').textContent = String(Math.random()).slice(2);
  document.getElementById('inc').addEventListener('click', function () {
    n += 1;
    out.textContent = String(n);
    if (window.alfy && window.alfy.storage) window.alfy.storage.set('n', n);
  });
  if (window.alfy && window.alfy.storage) {
    window.alfy.storage.get('n').then(function (saved) {
      if (typeof saved === 'number' && saved > n) {
        n = saved;
        out.textContent = String(n);
      }
    });
  }
})();
</script>
</body>
</html>`;

/** An App that navigates ITSELF a moment after it loads: what the tripwire exists for. */
const RUNAWAY_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Runaway</title></head>
<body>
<h1>Runaway</h1>
<script>
setTimeout(function () { window.location.href = "/login"; }, 1500);
</script>
</body>
</html>`;

async function seedApp(
	conversationId: string,
	title: string,
	html: string,
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: html,
		metadataJson: JSON.stringify({ artifactType: "app", title }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		body: html,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

function appBlock(id: string, artifactId: string, title: string): CanvasNode {
	return {
		id,
		type: "app",
		position: { x: 40, y: 40 },
		width: 400,
		height: 340,
		data: { kind: "app", artifactId, title },
	};
}

function frameBlock(id: string, x: number, y: number): CanvasNode {
	return {
		id,
		type: "frame",
		position: { x, y },
		width: 440,
		height: 400,
		data: { kind: "frame", label: "Sunday", width: 440, height: 400 },
	};
}

/**
 * Opens the panel on the chat's Canvas. `openCanvasPanel` takes the panel list's
 * first row, which is the one Canvas in a chat that made nothing else; in a chat
 * that made two Apps the board is picked by its own row.
 */
async function openBoardPanel(page: Page) {
	const editor = page.getByTestId("canvas-editor");
	const alreadyShowing = await editor
		.waitFor({ state: "visible", timeout: 2_000 })
		.then(() => true)
		.catch(() => false);
	if (!alreadyShowing) {
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.filter({ hasText: /Canvas|Tábla/ })
			.click();
	}
	await expect(editor).toBeVisible();
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
	await waitForStableBoundingBox(page.getByTestId("canvas-board"));
}

/** What the counter App has stored under its own key (null until it has written one). */
async function storedCount(appId: string): Promise<number | null> {
	const rows = await db
		.select({ value: artifactKv.valueJson })
		.from(artifactKv)
		.where(eq(artifactKv.artifactId, appId));
	const row = rows.find((candidate) => candidate.value !== undefined);
	return row ? (JSON.parse(row.value) as number) : null;
}

/** A camera that is not the default, so the board is not fitted on open and screen positions are the seed's. */
const CAMERA = { x: 16, y: 16, zoom: 1 };

async function openBoard(
	page: Page,
	nodesFor: (apps: { counter: string; runaway: string }) => CanvasNode[],
) {
	const conversationId = await createConversation(page, "An App on a board");
	const counter = await seedApp(conversationId, "Counter", COUNTER_APP_HTML);
	const runaway = await seedApp(conversationId, "Runaway", RUNAWAY_APP_HTML);
	const body: CanvasBody = {
		version: 1,
		nodes: nodesFor({ counter, runaway }),
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
	const artifactId = await seedCanvas(conversationId, body, "Board");
	await openChatAndReload(page, conversationId);
	await openBoardPanel(page);
	return { artifactId, counter, runaway };
}

/** Presses the block's header, drags it so its centre is over the other block's centre, and lets go. */
async function dragBlockOnto(page: Page, blockId: string, overId: string) {
	const head = page.locator(
		`.svelte-flow__node[data-id="${blockId}"] .canvas-node__head`,
	);
	const headBox = await head.boundingBox();
	if (!headBox) throw new Error("no header to drag by");
	const block = await nodeBox(page, blockId);
	const target = await nodeBox(page, overId);
	const dx = target.x + target.width / 2 - (block.x + block.width / 2);
	const dy = target.y + target.height / 2 - (block.y + block.height / 2);
	const from = { x: headBox.x + 60, y: headBox.y + headBox.height / 2 };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + dx, from.y + dy, { steps: 16 });
	await page.mouse.up();
}

/** Presses the block's header and drags it by this much: one pointer gesture. */
async function dragBlockBy(
	page: Page,
	blockId: string,
	dx: number,
	dy: number,
) {
	const head = page.locator(
		`.svelte-flow__node[data-id="${blockId}"] .canvas-node__head`,
	);
	const headBox = await head.boundingBox();
	if (!headBox) throw new Error("no header to drag by");
	const from = { x: headBox.x + 60, y: headBox.y + headBox.height / 2 };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + dx, from.y + dy, { steps: 16 });
	await page.mouse.up();
}

const notice = (page: Page) =>
	page.getByTestId("canvas-app").getByRole("alert");

test.describe("an App block and the frames of a board", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await setUiLanguage("en");
	});

	test("an App dragged into a frame that is listed after it keeps running: no false sandbox alarm, one frame, its storage intact", async ({
		page,
	}) => {
		// The frame is listed AFTER the App: the usual order when a frame is put
		// around an App that is already on the board.
		const { artifactId, counter } = await openBoard(page, ({ counter }) => [
			appBlock("app-1", counter, "Counter"),
			frameBlock("frame-late", 470, 40),
		]);
		const app = page.frameLocator("iframe.app-frame");
		await app.getByRole("button", { name: "Count" }).click();
		await app.getByRole("button", { name: "Count" }).click();
		await expect(app.getByTestId("counter-n")).toHaveText("2");
		// The App's own storage has the count (the bridge writes it on its own).
		await expect(async () => {
			expect(await storedCount(counter)).toBe(2);
		}).toPass();

		await dragBlockOnto(page, "app-1", "frame-late");
		await savedStatus(page);

		// Adopted: the stored block names its frame, listed after it.
		const saved = await storedBoard(artifactId);
		expect(saved.nodes.map((node) => [node.id, node.parentId])).toEqual([
			["frame-late", undefined],
			["app-1", "frame-late"],
		]);
		// No alarm, and the App is still ONE running frame.
		await expect(notice(page)).toHaveCount(0);
		await expect(page.locator("iframe.app-frame")).toHaveCount(1);
		// Its storage is untouched by the drag, and the App picks its count up again.
		expect(await storedCount(counter)).toBe(2);
		await expect(app.getByTestId("counter-n")).toHaveText("2");
		// It is running: it counts on from where it was.
		await app.getByRole("button", { name: "Count" }).click();
		await expect(app.getByTestId("counter-n")).toHaveText("3");
		await expect(async () => {
			expect(await storedCount(counter)).toBe(3);
		}).toPass();
		await expect(notice(page)).toHaveCount(0);
	});

	test("an App dragged into a frame that is listed before it, and out of it again, is not reloaded at all: the library moves nothing, so its document is the one that was running", async ({
		page,
	}) => {
		const { artifactId, counter } = await openBoard(page, ({ counter }) => [
			frameBlock("frame-early", 470, 40),
			appBlock("app-1", counter, "Counter"),
		]);
		const app = page.frameLocator("iframe.app-frame");
		await app.getByRole("button", { name: "Count" }).click();
		await expect(app.getByTestId("counter-n")).toHaveText("1");
		const boot = await app.getByTestId("counter-boot").textContent();

		await dragBlockOnto(page, "app-1", "frame-early");
		await savedStatus(page);
		expect(
			(await storedBoard(artifactId)).nodes.map((node) => [
				node.id,
				node.parentId,
			]),
		).toEqual([
			["frame-early", undefined],
			["app-1", "frame-early"],
		]);
		await expect(notice(page)).toHaveCount(0);
		// The very same document, mid-count: nothing reloaded it.
		await expect(app.getByTestId("counter-boot")).toHaveText(boot ?? "");
		await expect(app.getByTestId("counter-n")).toHaveText("1");

		// And out again, to the far side of the frame.
		await dragBlockBy(page, "app-1", -560, 0);
		await expect(async () => {
			const nodes = (await storedBoard(artifactId)).nodes;
			expect(nodes.find((node) => node.id === "app-1")?.parentId).toBe(
				undefined,
			);
		}).toPass({ timeout: 10_000 });
		await savedStatus(page);
		await expect(notice(page)).toHaveCount(0);
		await expect(page.locator("iframe.app-frame")).toHaveCount(1);
		await expect(app.getByTestId("counter-boot")).toHaveText(boot ?? "");
		expect(await storedCount(counter)).toBe(1);
	});

	test("an App on a board that navigates itself still trips the tripwire: the frame is torn down and the notice says so, and the reload brings a fresh frame", async ({
		page,
	}) => {
		await openBoard(page, ({ runaway }) => [
			appBlock("app-1", runaway, "Runaway"),
		]);
		await expect(
			page.frameLocator("iframe.app-frame").getByRole("heading", {
				name: "Runaway",
			}),
		).toBeVisible();

		// The fixture navigates itself; the page tears the frame down and says so.
		await expect(notice(page)).toContainText(
			"This app tried to leave its sandbox, so Alfy stopped it.",
			{ timeout: 15_000 },
		);
		await expect(page.locator("iframe.app-frame")).toHaveCount(0);

		await page.getByRole("button", { name: "Reload the app" }).click();
		await expect(page.locator("iframe.app-frame")).toHaveCount(1);
	});
});

// Screenshots for the report, not part of the gates: run with FC_SHOTS=<dir>.
const SHOTS = process.env.FC_SHOTS;
test.describe("screenshots of an App in a frame", () => {
	test.skip(
		!SHOTS,
		"set FC_SHOTS to a folder to write the report's screenshots",
	);

	// The other specs assume an English UI.
	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	test("the App in the frame it was dragged into, still running, Hungarian, light, 1440x900", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		await openBoard(page, ({ counter }) => [
			appBlock("app-1", counter, "Counter"),
			frameBlock("frame-late", 470, 40),
		]);
		const app = page.frameLocator("iframe.app-frame");
		await app.getByRole("button", { name: "Count" }).click();
		await app.getByRole("button", { name: "Count" }).click();
		await dragBlockOnto(page, "app-1", "frame-late");
		await savedStatus(page).catch(() => undefined);
		await app.getByRole("button", { name: "Count" }).click();
		await expect(app.getByTestId("counter-n")).toHaveText("3");
		await page.waitForTimeout(800);
		await page.screenshot({
			path: join(SHOTS as string, "1440-light-app-in-frame.png"),
		});
	});
});
