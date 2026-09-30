import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifactKv,
	artifacts,
	artifactVersions,
	chatGeneratedFiles,
	messages,
} from "../../src/lib/server/db/schema";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import {
	nodeCount,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
	testUserId,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

// The blocks made from the chat (Feature 2 · Canvas, S3-R1): the Insert menu's
// "From this chat" lists what the board's own chat made, and a pick puts a File,
// an App, a map or a chart on the board. A chat is seeded straight into the
// database (the convention the other artifact specs use, since a tool call has no
// scriptable fixture): a produced file, two Apps, a route the map tool returned and
// a reply that drew a chart.

const TRIP_NOTES = "Vienna trip notes.md";
const CHART = {
	type: "bar",
	data: {
		labels: ["Apples", "Pears"],
		datasets: [{ label: "Sales", data: [30, 20] }],
	},
	options: { plugins: { title: { text: "Sales by fruit" } } },
};
const MAP = {
	bounds: { minLat: 51.706, minLng: -8.53, maxLat: 51.897, maxLng: -8.47 },
	markers: [
		{ lat: 51.897, lng: -8.47, label: "Cork", kind: "origin" },
		{ lat: 51.706, lng: -8.53, label: "Kinsale", kind: "destination" },
	],
	polyline: [
		[51.897, -8.47],
		[51.82, -8.495],
		[51.706, -8.53],
	],
	distanceM: 27_000,
	durationS: 2040,
	mode: "drive",
	originLabel: "Cork",
	destinationLabel: "Kinsale",
	attribution: "© OpenStreetMap contributors",
};

/** A small, real App: a note it keeps through window.alfy.storage and shows back. */
function noteApp(title: string): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;padding:8px}input{width:70%}</style></head>
<body>
<h1>${title}</h1>
<input id="note" aria-label="Note">
<button id="save" type="button">Save</button>
<p id="saved" aria-live="polite"></p>
<script>
(async function () {
  var input = document.getElementById('note');
  var out = document.getElementById('saved');
  if (window.alfy && window.alfy.storage) {
    var value = await window.alfy.storage.get('note');
    if (typeof value === 'string') { input.value = value; out.textContent = 'Saved: ' + value; }
  }
  document.getElementById('save').addEventListener('click', async function () {
    await window.alfy.storage.set('note', input.value);
    out.textContent = 'Saved: ' + input.value;
  });
})();
</script>
</body>
</html>`;
}

type Seeded = {
	conversationId: string;
	boardId: string;
	chatFileId: string;
	tipApp: string;
	habitApp: string;
};

let sequence = 100;

/** A chat that has made a file, two Apps, a route and a chart, and an empty board beside them. */
async function seedChat(
	page: Page,
	title = "Board from the chat",
): Promise<Seeded> {
	const conversationId = await createConversation(page, title);
	const userId = await testUserId();
	const now = new Date();

	// A produced file that really exists, so the panel's viewer can show it.
	const fileMessage = randomUUID();
	const chatFileId = randomUUID();
	const storagePath = join(conversationId, `${chatFileId}.md`);
	const onDisk = join(process.cwd(), "data", "chat-files", storagePath);
	mkdirSync(dirname(onDisk), { recursive: true });
	writeFileSync(onDisk, "# Vienna\n\nThree days, one museum a day.\n");
	sequence += 1;
	await db.insert(messages).values({
		id: fileMessage,
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content: "Here are the trip notes.",
		createdAt: now,
	});
	await db.insert(chatGeneratedFiles).values({
		id: chatFileId,
		conversationId,
		assistantMessageId: fileMessage,
		userId,
		filename: TRIP_NOTES,
		mimeType: "text/markdown",
		sizeBytes: 38,
		storagePath,
		createdAt: now,
	});

	// A route the map tool returned, and a reply that drew a chart.
	sequence += 1;
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content: "It is about 27 km down the R600, roughly 34 minutes.",
		toolCalls: JSON.stringify([
			{
				type: "tool_call",
				callId: "call-map-1",
				name: "map_route",
				input: { action: "route", from: "Cork", to: "Kinsale" },
				status: "done",
				map: MAP,
			},
		]),
		createdAt: new Date(now.getTime() + 1_000),
	});
	sequence += 1;
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content: `Here is the chart.\n\n\`\`\`chart\n${JSON.stringify(CHART)}\n\`\`\`\n`,
		createdAt: new Date(now.getTime() + 2_000),
	});

	const tipApp = await seedApp(conversationId, "Tip calculator");
	const habitApp = await seedApp(conversationId, "Habit tracker");
	const boardId = await seedCanvas(conversationId, emptyCanvasBody(), "Board");
	return { conversationId, boardId, chatFileId, tipApp, habitApp };
}

async function seedApp(conversationId: string, title: string): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	const html = noteApp(title);
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

/**
 * Opens the panel on the chat's Canvas. `openCanvasPanel` takes the panel list's
 * first row, which is the one Canvas in a chat that made nothing else; in a chat
 * that made a file and two Apps the board is picked by its own row.
 */
async function openBoard(page: Page) {
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
	// The panel slides in: what is measured next is measured where it will stay.
	await waitForStableBoundingBox(page.getByTestId("canvas-board"));
}

const insertButton = (page: Page) => page.getByTestId("canvas-insert-button");
// The menu's own list: in the popover on a laptop and in the sheet on a phone.
const menu = (page: Page) => page.getByTestId("canvas-insert-menu-list");

/** What the section and its reading line are called, in the language the UI is in. */
const SECTION = {
	en: { title: "From this chat", reading: "Looking through this chat…" },
	hu: { title: "Ebből a beszélgetésből", reading: "A beszélgetés átnézése…" },
} as const;

/** Opens the Insert menu and waits until "From this chat" has read the chat. */
async function openInsertMenu(page: Page, language: "en" | "hu" = "en") {
	await insertButton(page).click();
	await expect(menu(page)).toBeVisible();
	await expect(
		menu(page).getByRole("group", { name: SECTION[language].title }),
	).toBeVisible();
	await expect(menu(page).getByText(SECTION[language].reading)).toHaveCount(0);
}

/** Picks a row of "From this chat" by its visible name; the menu closes and the block lands. */
async function pickFromChat(
	page: Page,
	name: string | RegExp,
	language: "en" | "hu" = "en",
) {
	await openInsertMenu(page, language);
	await menu(page).getByRole("menuitem", { name }).click();
	await expect(menu(page)).toHaveCount(0);
}

/** Fits everything on the board into the view, so every block is on screen to be used. */
async function fitBoard(page: Page) {
	await page.getByTestId("canvas-fit").click();
	// The camera tweens; it has arrived when the zoom stops reading 100%.
	await expect(page.getByTestId("canvas-zoom-level")).not.toHaveText("100%");
	await page.waitForTimeout(500);
}

/**
 * The block's map has come up one way or the other: the interactive map drew its
 * route (`data-map-route-drawn`, true only when MapLibre's worker really parsed
 * the geometry, the failure the map card's own spec guards), or the card is on its
 * inline-SVG fallback (no WebGL, or the library could not load). Stuck between
 * the two is the only failure.
 */
async function expectMapSettled(page: Page) {
	const surface = page
		.getByTestId("canvas-map")
		.getByTestId("map-route-canvas");
	await expect
		.poll(
			async () => {
				if ((await surface.count()) === 0) return "fallback";
				return (await surface.getAttribute("data-map-route-drawn")) === "true"
					? "drawn"
					: "pending";
			},
			{ timeout: 20_000 },
		)
		.not.toBe("pending");
	await expect(
		page.getByTestId("canvas-map").getByTestId("map-route-fallback"),
	).toBeAttached();
}

const nodeOf = (page: Page, kind: string) =>
	page.locator(`[data-testid="canvas-node"][data-kind="${kind}"]`);

test.describe("blocks from this chat", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("en");
		await login(page);
	});

	test("lists what the chat made, grouped by kind, in the Insert menu", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await openInsertMenu(page);
		const list = menu(page);
		for (const name of ["Files", "Apps", "Maps", "Charts"]) {
			await expect(list.getByRole("group", { name })).toBeVisible();
		}
		await expect(
			list.getByRole("menuitem", { name: new RegExp(TRIP_NOTES) }),
		).toBeVisible();
		await expect(
			list.getByRole("menuitem", { name: /Tip calculator/ }),
		).toBeVisible();
		await expect(
			list.getByRole("menuitem", { name: /Habit tracker/ }),
		).toBeVisible();
		await expect(
			list.getByRole("menuitem", { name: /Cork → Kinsale/ }),
		).toBeVisible();
		await expect(
			list.getByRole("menuitem", { name: /Sales by fruit/ }),
		).toBeVisible();
		// The blocks made from the chat have no row of their own: only what the chat made.
		await expect(page.getByTestId("canvas-insert-file")).toHaveCount(0);
		await expect(page.getByTestId("canvas-insert-app")).toHaveCount(0);
		await expect(page.getByTestId("canvas-insert-map")).toHaveCount(0);
	});

	test("inserts a file, an App, a map and a chart, and all four are still there after a reload", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await pickFromChat(page, new RegExp(TRIP_NOTES));
		await expect(nodeOf(page, "file")).toHaveCount(1);
		await expect(page.getByTestId("canvas-file")).toContainText(TRIP_NOTES);

		await pickFromChat(page, /Tip calculator/);
		await expect(nodeOf(page, "app")).toHaveCount(1);
		await expect(
			page
				.frameLocator("iframe.app-frame")
				.getByRole("heading", { name: "Tip calculator" }),
		).toBeVisible();

		await pickFromChat(page, /Cork → Kinsale/);
		await expect(nodeOf(page, "map")).toHaveCount(1);
		await expect(
			page.getByTestId("canvas-map").getByTestId("map-route-card"),
		).toBeVisible();
		await expectMapSettled(page);

		await pickFromChat(page, /Sales by fruit/);
		await expect(nodeOf(page, "chart")).toHaveCount(1);
		await expect(
			page.getByTestId("canvas-chart").locator("canvas"),
		).toBeVisible();

		await savedStatus(page);
		const stored = await storedBoard(seeded.boardId);
		expect(stored.nodes.map((node) => node.type).sort()).toEqual([
			"app",
			"chart",
			"file",
			"map",
		]);
		const data = (type: string) =>
			stored.nodes.find((node) => node.type === type)?.data;
		expect(data("file")).toMatchObject({
			kind: "file",
			fileId: seeded.chatFileId,
			name: TRIP_NOTES,
			mime: "text/markdown",
			label: "MD",
		});
		expect(data("app")).toMatchObject({
			kind: "app",
			artifactId: seeded.tipApp,
			title: "Tip calculator",
		});
		expect(data("map")).toMatchObject({
			kind: "map",
			route: "Cork → Kinsale",
			meta: "27.0 km · 34 min",
			map: { originLabel: "Cork", destinationLabel: "Kinsale" },
		});
		expect(JSON.parse((data("chart") as { code: string }).code)).toEqual(CHART);
		// The chart's own title heads its block.
		expect(data("chart")).toMatchObject({ label: "Sales by fruit" });
		// An App has a size of its own to be drawn at, stored with it.
		const app = stored.nodes.find((node) => node.type === "app");
		expect(app?.width).toBeGreaterThan(0);
		expect(app?.height).toBeGreaterThan(0);

		await page.reload({ waitUntil: "networkidle" });
		await openBoard(page);
		expect(await nodeCount(page)).toBe(4);
		await expect(page.getByTestId("canvas-file")).toContainText(TRIP_NOTES);
		await expect(
			page
				.frameLocator("iframe.app-frame")
				.getByRole("heading", { name: "Tip calculator" }),
		).toBeVisible();
		await expect(
			page.getByTestId("canvas-map").getByTestId("map-route-card"),
		).toBeVisible();
		await expect(
			page.getByTestId("canvas-chart").locator("canvas"),
		).toBeVisible();
	});

	test("opens the file in the panel's viewer when its block is clicked", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, new RegExp(TRIP_NOTES));
		await expect(nodeOf(page, "file")).toHaveCount(1);
		await savedStatus(page);

		const preview = page.waitForResponse(
			(response) =>
				response
					.url()
					.includes(`/api/chat/files/${seeded.chatFileId}/preview`) &&
				response.status() === 200,
		);
		await page
			.getByRole("button", { name: new RegExp(`Open ${TRIP_NOTES}`) })
			.click();

		// The panel shows the file, in its own shared viewer; the board is left.
		await preview;
		await expect(page.getByTestId("canvas-editor")).toHaveCount(0);
		await expect(page.getByTestId("workspace-main")).toContainText(TRIP_NOTES);
		await expect(page.getByText("Three days, one museum a day.")).toBeVisible();
		// Nothing about the board changed: the block is still in what was saved.
		expect((await storedBoard(seeded.boardId)).nodes).toHaveLength(1);
	});

	test("runs two Apps on one board with storage of their own, never the board's", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, /Tip calculator/);
		await expect(nodeOf(page, "app")).toHaveCount(1);
		await pickFromChat(page, /Habit tracker/);
		await expect(nodeOf(page, "app")).toHaveCount(2);
		await fitBoard(page);

		const tip = page.frameLocator("iframe.app-frame").first();
		const habit = page.frameLocator("iframe.app-frame").last();
		await expect(
			tip.getByRole("heading", { name: "Tip calculator" }),
		).toBeVisible();
		await expect(
			habit.getByRole("heading", { name: "Habit tracker" }),
		).toBeVisible();

		await tip.getByRole("textbox", { name: "Note" }).fill("from the tip app");
		await tip.getByRole("button", { name: "Save" }).click();
		await expect(tip.getByText("Saved: from the tip app")).toBeVisible();
		await habit
			.getByRole("textbox", { name: "Note" })
			.fill("from the habit app");
		await habit.getByRole("button", { name: "Save" }).click();
		await expect(habit.getByText("Saved: from the habit app")).toBeVisible();

		// Each App's value is in its own store, and the board has none.
		const rowsOf = async (artifactId: string) =>
			db
				.select({ key: artifactKv.key, value: artifactKv.valueJson })
				.from(artifactKv)
				.where(eq(artifactKv.artifactId, artifactId));
		await expect
			.poll(async () => (await rowsOf(seeded.tipApp)).map((row) => row.value))
			.toEqual([JSON.stringify("from the tip app")]);
		await expect
			.poll(async () => (await rowsOf(seeded.habitApp)).map((row) => row.value))
			.toEqual([JSON.stringify("from the habit app")]);
		expect(await rowsOf(seeded.boardId)).toEqual([]);

		// And after a reload each App still holds only its own.
		await savedStatus(page);
		await page.reload({ waitUntil: "networkidle" });
		await openBoard(page);
		await expect(
			page
				.frameLocator("iframe.app-frame")
				.first()
				.getByText("Saved: from the tip app"),
		).toBeVisible();
		await expect(
			page
				.frameLocator("iframe.app-frame")
				.last()
				.getByText("Saved: from the habit app"),
		).toBeVisible();
	});

	test("says the App is no longer available once it is deleted, and draws no frame", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, /Tip calculator/);
		await expect(nodeOf(page, "app")).toHaveCount(1);
		await savedStatus(page);

		await db.delete(artifacts).where(eq(artifacts.id, seeded.tipApp));
		await page.reload({ waitUntil: "networkidle" });
		await openBoard(page);

		await expect(
			page.getByText("This App is no longer available."),
		).toBeVisible();
		await expect(page.locator("iframe.app-frame")).toHaveCount(0);
		// The block is still on the board: only what it pointed at is gone.
		expect(await nodeCount(page)).toBe(1);
		expect((await storedBoard(seeded.boardId)).nodes).toHaveLength(1);
	});

	test("the section is one part of the menu: arrow keys move through every row, one tab stop, Escape returns focus to Insert", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await insertButton(page).focus();
		await page.keyboard.press("Enter");
		await expect(menu(page)).toBeVisible();
		const rows = menu(page).getByRole("menuitem");
		// Five written rows, then what the chat offers: the row to search the web
		// first, then what the chat made (5 rows in this chat).
		await expect(rows).toHaveCount(11);

		// One tab stop for the whole menu, and it is a written row.
		const stops = await rows.evaluateAll((nodes) =>
			nodes
				.map((node, index) => ({ index, tab: node.getAttribute("tabindex") }))
				.filter((row) => row.tab === "0")
				.map((row) => row.index),
		);
		expect(stops).toHaveLength(1);
		expect(stops[0]).toBeLessThan(5);

		await rows.first().focus();
		await page.keyboard.press("End");
		await expect(rows.last()).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(rows.first()).toBeFocused();
		// Down from the last written row goes into what the chat offers.
		await rows.nth(4).focus();
		await page.keyboard.press("ArrowDown");
		await expect(rows.nth(5)).toHaveAccessibleName("Search the web…");
		await expect(rows.nth(5)).toBeFocused();
		await page.keyboard.press("Home");
		await expect(rows.first()).toBeFocused();

		// Enter on a chat row inserts it, and the menu closes.
		await rows.nth(6).focus();
		await page.keyboard.press("Enter");
		await expect(menu(page)).toHaveCount(0);
		expect(await nodeCount(page)).toBe(1);

		// Escape closes the menu and hands focus back to Insert.
		await insertButton(page).click();
		await expect(menu(page)).toBeVisible();
		await rows.nth(6).focus();
		await page.keyboard.press("Escape");
		await expect(menu(page)).toHaveCount(0);
		await expect(insertButton(page)).toBeFocused();
	});

	test("says quietly that there is nothing to insert in a chat that has made nothing", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Nothing made here");
		await seedCanvas(conversationId, emptyCanvasBody(), "Empty board");
		await openChatAndReload(page, conversationId);
		await openBoard(page);

		await insertButton(page).click();
		await expect(menu(page)).toBeVisible();
		await expect(
			menu(page).getByText("Nothing from this chat to insert yet."),
		).toBeVisible();
		// The five written rows, and the row to search the web: a search needs no chat history.
		await expect(menu(page).getByRole("menuitem")).toHaveCount(6);
	});

	test("keeps the written rows working when the chat cannot be read", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await page.route("**/api/artifacts/*/chat-blocks*", (route) =>
			route.fulfill({ status: 500, body: "{}" }),
		);

		await insertButton(page).click();
		await expect(
			menu(page).getByText("Couldn't look through this chat."),
		).toBeVisible();
		await page.unroute("**/api/artifacts/*/chat-blocks*");
		await menu(page).getByRole("button", { name: "Try again" }).click();
		await expect(
			menu(page).getByRole("menuitem", { name: /Tip calculator/ }),
		).toBeVisible();
		// A written row still works after a failed read.
		await menu(page).getByTestId("canvas-insert-sticky").click();
		await expect(nodeOf(page, "sticky")).toHaveCount(1);
	});

	test("draws a stored board's file, App, map and chart in place, with their own gestures", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Stored blocks");
		const tipApp = await seedApp(conversationId, "Tip calculator");
		const body: CanvasBody = {
			...emptyCanvasBody(),
			nodes: [
				{
					id: "file-1",
					type: "file",
					position: { x: 40, y: 40 },
					width: 260,
					data: {
						kind: "file",
						fileId: "some-chat-file",
						name: "budget.xlsx",
						mime: "",
						bytes: 4096,
						label: "XLSX",
					},
				},
				{
					id: "app-1",
					type: "app",
					position: { x: 40, y: 140 },
					width: 400,
					height: 340,
					data: { kind: "app", artifactId: tipApp, title: "Tip calculator" },
				},
				{
					id: "map-1",
					type: "map",
					position: { x: 500, y: 40 },
					width: 360,
					data: {
						kind: "map",
						route: "Cork → Kinsale",
						meta: "27.0 km · 34 min",
						map: MAP,
					},
				},
			],
		};
		await seedCanvas(conversationId, body, "Stored blocks");
		await openChatAndReload(page, conversationId);
		await openBoard(page);

		await expect(page.getByTestId("canvas-file")).toContainText("budget.xlsx");
		await expect(page.getByTestId("canvas-file")).toContainText("XLSX");
		await expect(
			page
				.frameLocator("iframe.app-frame")
				.getByRole("heading", { name: "Tip calculator" }),
		).toBeVisible();
		await expect(
			page.getByTestId("canvas-map").getByTestId("map-route-card"),
		).toBeVisible();
		// The App's frame is the panel's: exactly this sandbox, on the block too.
		await expect(page.locator("iframe.app-frame")).toHaveAttribute(
			"sandbox",
			"allow-scripts allow-forms",
		);
		// The board's gestures are kept off the App and the map.
		for (const testId of ["canvas-app", "canvas-map"]) {
			await expect(page.getByTestId(testId)).toHaveClass(/nodrag/);
			await expect(page.getByTestId(testId)).toHaveClass(/nowheel/);
			await expect(page.getByTestId(testId)).toHaveClass(/nopan/);
		}
		// Every block is a real node: it can be picked and it has anchors.
		expect(await nodeCount(page)).toBe(3);
	});
});

// A 1x1 paper-coloured PNG for every map tile, so a screenshot's map draws
// without reaching out to a public tile host (as map-route-card.spec.ts does).
const TILE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN49ugGAAVSAqHeT0GYAAAAAElFTkSuQmCC",
	"base64",
);
const stubTiles = (page: Page) =>
	page.route("**/api/map-tiles/**", (route) =>
		route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
	);

// Screenshots for the report, not part of the gates: run with S3R1_SHOTS=<dir>.
const SHOTS = process.env.S3R1_SHOTS;
test.describe("screenshots of blocks from this chat", () => {
	test.skip(
		!SHOTS,
		"set S3R1_SHOTS to a folder to write the report's screenshots",
	);

	// The other specs assume an English UI.
	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`the board with all four blocks, Hungarian, ${scheme}, 1440x900`, async ({
			page,
		}) => {
			await setUiLanguage("hu");
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 1440, height: 900 });
			await stubTiles(page);
			await login(page);
			const seeded = await seedChat(page);
			await openChatAndReload(page, seeded.conversationId);
			await openBoard(page);
			await pickFromChat(page, new RegExp(TRIP_NOTES), "hu");
			await pickFromChat(page, /Tip calculator/, "hu");
			await pickFromChat(page, /Cork → Kinsale/, "hu");
			await pickFromChat(page, /Sales by fruit/, "hu");
			await savedStatus(page).catch(() => undefined);
			await fitBoard(page);
			await page.waitForTimeout(1_200);
			await page.screenshot({
				path: join(SHOTS as string, `1440-${scheme}-board.png`),
			});
			if (scheme === "light") {
				await insertButton(page).click();
				await expect(
					menu(page).getByRole("group", { name: "Ebből a beszélgetésből" }),
				).toBeVisible();
				await page.waitForTimeout(400);
				await page.screenshot({
					path: join(SHOTS as string, "1440-light-insert-menu.png"),
				});
			}
		});
	}

	test("the same board on a phone, Hungarian, 390x844", async ({ page }) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 390, height: 844 });
		await stubTiles(page);
		await login(page);
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, new RegExp(TRIP_NOTES), "hu");
		await pickFromChat(page, /Tip calculator/, "hu");
		await pickFromChat(page, /Cork → Kinsale/, "hu");
		await pickFromChat(page, /Sales by fruit/, "hu");
		await fitBoard(page);
		await page.waitForTimeout(1_200);
		await page.screenshot({
			path: join(SHOTS as string, "390-light-board.png"),
		});
		await insertButton(page).click();
		await page.waitForTimeout(600);
		await page.screenshot({
			path: join(SHOTS as string, "390-light-insert-sheet.png"),
		});
	});
});
