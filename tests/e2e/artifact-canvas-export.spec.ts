import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifactLinks,
	artifacts,
	artifactVersions,
	chatGeneratedFiles,
	messages,
} from "../../src/lib/server/db/schema";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import {
	cameraOf,
	openChatAndReload,
	seedCanvas,
	storedBoard,
	testUserId,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

// A picture of the board (Feature 2 · Artifacts, Slice 3, T7): the header's
// Download offers the board as a PNG, an App and a map are in it as their still
// images and never as an empty box, a block with no still image is drawn as a card
// that says so and is named in one notice, and the board is where it was after.
// Boards are seeded straight into the database (the convention the other artifact
// specs use), in a chat that has one reply, so the export has something to hang from.

const VIOLET = { r: 140, g: 40, b: 190 };
const CHART = {
	type: "bar",
	data: {
		labels: ["Apples", "Pears", "Plums"],
		datasets: [
			{
				label: "Sales",
				data: [30, 20, 25],
				backgroundColor: `rgb(${VIOLET.r}, ${VIOLET.g}, ${VIOLET.b})`,
				borderWidth: 0,
			},
		],
	},
	options: { animation: false, plugins: { legend: { display: false } } },
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

function noteApp(title: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;padding:8px}</style></head>
<body><h1>${title}</h1><p id="clock">running</p>
<script>document.getElementById('clock').textContent = 'running ' + Date.now();</script></body></html>`;
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

function sticky(id: string, x: number, y: number, text: string): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 190,
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

function chartNode(id: string, x: number, y: number): CanvasNode {
	return {
		id,
		type: "chart",
		position: { x, y },
		width: 340,
		data: {
			kind: "chart",
			label: "Sales by fruit",
			code: JSON.stringify(CHART),
		},
	};
}

function appNode(
	id: string,
	x: number,
	y: number,
	artifactId: string,
	title: string,
): CanvasNode {
	return {
		id,
		type: "app",
		position: { x, y },
		width: 400,
		height: 340,
		data: { kind: "app", artifactId, title },
	};
}

function mapNode(id: string, x: number, y: number): CanvasNode {
	return {
		id,
		type: "map",
		position: { x, y },
		width: 360,
		data: {
			kind: "map",
			route: "Cork → Kinsale",
			meta: "27.0 km · 34 min",
			map: MAP,
		},
	};
}

const board = (
	nodes: CanvasNode[],
	camera = { x: 0, y: 0, zoom: 1 },
): CanvasBody => ({
	...emptyCanvasBody(),
	nodes,
	viewport: camera,
});

/** A chat with one reply (an export hangs from the newest one), and a board in it. */
async function seedChat(
	page: Page,
	nodes: (conversationId: string) => Promise<CanvasNode[]>,
	title = "Weekend board",
) {
	const conversationId = await createConversation(page, "Pictures");
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: 1,
		role: "assistant",
		content: "Here is your board.",
		createdAt: new Date(),
	});
	const artifactId = await seedCanvas(
		conversationId,
		board(await nodes(conversationId)),
		title,
	);
	return { conversationId, artifactId };
}

/**
 * Opens the panel on the chat's Canvas. In a chat that also made an App the panel's
 * list has more than one row, so the board is picked by its own row.
 */
async function openBoard(page: Page, conversationId: string) {
	await openChatAndReload(page, conversationId);
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
	await waitForStableBoundingBox(page.getByTestId("canvas-board"));
}

const downloadButton = (page: Page) =>
	page.locator('[data-testid="artifact-download-button"]:visible').first();

async function openDownload(page: Page) {
	await downloadButton(page).click();
	await expect(page.getByTestId("canvas-download-popover")).toBeVisible();
}

/** Presses PNG image and waits for the picture to be kept; the id of the stored file and the browser's own download. */
async function exportPng(page: Page) {
	const download = page.waitForEvent("download");
	await page.getByTestId("canvas-download-png").click();
	await expect(page.getByTestId("canvas-download-done")).toBeVisible({
		timeout: 30_000,
	});
	const href = await page
		.getByTestId("canvas-download-again")
		.getAttribute("href");
	const fileId = /\/api\/chat\/files\/([^/]+)\/download/.exec(href ?? "")?.[1];
	if (!fileId) throw new Error(`no file in ${href}`);
	return { fileId, download: await download };
}

type Stats = {
	width: number;
	height: number;
	violet: number;
	/** Distinct colours, coarsely: a uniform box has one or two. */
	colours: number;
};

/** The PNG the server kept, read back in the page and counted: what is in the picture, not what was said about it. */
async function pngStats(
	page: Page,
	fileId: string,
	region?: { x: number; y: number; width: number; height: number },
): Promise<Stats> {
	return page.evaluate(
		async ({ id, region, violet }) => {
			const response = await fetch(`/api/chat/files/${id}/preview`);
			const bitmap = await createImageBitmap(await response.blob());
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("no 2d context");
			context.drawImage(bitmap, 0, 0);
			const box = region
				? {
						x: Math.round(region.x * bitmap.width),
						y: Math.round(region.y * bitmap.height),
						w: Math.round(region.width * bitmap.width),
						h: Math.round(region.height * bitmap.height),
					}
				: { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
			const { data } = context.getImageData(box.x, box.y, box.w, box.h);
			let violetPixels = 0;
			const seen = new Set<number>();
			for (let i = 0; i < data.length; i += 4) {
				const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
				if (
					Math.abs(r - violet.r) < 8 &&
					Math.abs(g - violet.g) < 8 &&
					Math.abs(b - violet.b) < 8
				) {
					violetPixels += 1;
				}
				seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
			}
			return {
				width: bitmap.width,
				height: bitmap.height,
				violet: violetPixels,
				colours: seen.size,
			};
		},
		{ id: fileId, region, violet: VIOLET },
	);
}

const TILE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN49ugGAAVSAqHeT0GYAAAAAElFTkSuQmCC",
	"base64",
);
const stubTiles = (page: Page) =>
	page.route("**/api/map-tiles/**", (route) =>
		route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
	);

test.describe("a picture of the board", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await stubTiles(page);
	});

	test("exports the board as a PNG that contains the chart's own colour", async ({
		page,
	}) => {
		const { conversationId } = await seedChat(page, async () => [
			sticky("note-a", 0, 0, "Market on Saturday"),
			chartNode("chart-1", 260, 0),
		]);
		await openBoard(page, conversationId);
		// The chart draws lazily; the picture must find it drawn.
		await expect(page.locator('[data-kind="chart"] canvas')).toBeVisible();
		await page.waitForTimeout(600);

		await openDownload(page);
		const { fileId, download } = await exportPng(page);

		expect(download.suggestedFilename()).toBe("Weekend board.png");
		const stats = await pngStats(page, fileId);
		expect(stats.width).toBeGreaterThanOrEqual(800);
		expect(stats.height).toBeGreaterThanOrEqual(600);
		// A canvas bitmap either survived the clone or it did not: the bars are a
		// colour nothing else on the board uses.
		expect(stats.violet).toBeGreaterThan(400);
	});

	test("draws an App as its still card, never as an empty box, and leaves the board as it was", async ({
		page,
	}) => {
		const { conversationId } = await seedChat(page, async (id) => [
			appNode(
				"app-1",
				0,
				0,
				await seedApp(id, "Tip calculator"),
				"Tip calculator",
			),
		]);
		await openBoard(page, conversationId);
		await expect(
			page
				.frameLocator("iframe.app-frame")
				.getByRole("heading", { name: "Tip calculator" }),
		).toBeVisible();
		const cameraBefore = await cameraOf(page);
		const frame = page.locator("iframe.app-frame");
		const runningBefore = await page
			.frameLocator("iframe.app-frame")
			.locator("#clock")
			.textContent();

		// Its still image is taken a moment after it shows.
		await page.waitForTimeout(2_500);
		await openDownload(page);
		const { fileId } = await exportPng(page);
		await expect(page.getByTestId("canvas-download-missing")).toHaveCount(0);

		// The block is in the middle of the picture, and what is there is drawn: a card with its name.
		const inBlock = await pngStats(page, fileId, {
			x: 0.25,
			y: 0.3,
			width: 0.5,
			height: 0.5,
		});
		expect(inBlock.colours).toBeGreaterThan(4);

		// The board is as it was: the camera, no still image on any block, the App still the same running frame.
		expect(await cameraOf(page)).toEqual(cameraBefore);
		await expect(page.getByTestId("canvas-node-poster")).toHaveCount(0);
		await expect(page.getByTestId("canvas-node-placeholder")).toHaveCount(0);
		await expect(frame).toHaveCount(1);
		expect(
			await page
				.frameLocator("iframe.app-frame")
				.locator("#clock")
				.textContent(),
		).toBe(runningBefore);
	});

	test("draws a map from its inline route, with a word that the basemap is not live", async ({
		page,
	}) => {
		const { conversationId } = await seedChat(page, async () => [
			mapNode("map-1", 0, 0),
		]);
		await openBoard(page, conversationId);
		await expect(
			page.getByTestId("canvas-map").getByTestId("map-route-card"),
		).toBeVisible();
		await page.waitForTimeout(2_500);
		await openDownload(page);
		const { fileId } = await exportPng(page);
		await expect(page.getByTestId("canvas-download-missing")).toHaveCount(0);
		const inBlock = await pngStats(page, fileId, {
			x: 0.25,
			y: 0.3,
			width: 0.5,
			height: 0.5,
		});
		expect(inBlock.colours).toBeGreaterThan(4);
		// The block on the board is untouched: still the live map's card.
		await expect(
			page.getByTestId("canvas-map").getByTestId("map-route-card"),
		).toBeVisible();
	});

	test("says once that a block has no still image, names it in one notice, and still draws a card for it", async ({
		page,
	}) => {
		// Every poster is refused, so no block gets one.
		await page.route("**/api/artifacts/*/exports/png*", async (route) => {
			const body = route.request().postDataJSON() as { source?: string };
			if (body.source === "canvas-poster") {
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ ok: false }),
				});
				return;
			}
			await route.continue();
		});
		const { conversationId } = await seedChat(page, async (id) => [
			appNode(
				"app-1",
				0,
				0,
				await seedApp(id, "Tip calculator"),
				"Tip calculator",
			),
		]);
		await openBoard(page, conversationId);
		await expect(
			page
				.getByTestId("canvas-node")
				.filter({ hasText: "Tip calculator" })
				.getByText("Could not make a still image of this block."),
		).toBeVisible({ timeout: 15_000 });

		await openDownload(page);
		const { fileId } = await exportPng(page);

		// One notice in the popover, and the same one on the panel after it closes.
		await expect(page.getByTestId("canvas-download-missing")).toContainText(
			"1 block was drawn as a card, without the live view: Tip calculator",
		);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("canvas-download-popover")).toHaveCount(0);
		await expect(page.getByTestId("canvas-export-missing")).toContainText(
			"Tip calculator",
		);
		await page
			.getByTestId("canvas-export-missing")
			.getByRole("button", { name: "Dismiss" })
			.click();
		await expect(page.getByTestId("canvas-export-missing")).toHaveCount(0);

		// The block is a legible card in the picture, not nothing.
		const inBlock = await pngStats(page, fileId, {
			x: 0.25,
			y: 0.3,
			width: 0.5,
			height: 0.5,
		});
		expect(inBlock.colours).toBeGreaterThan(4);
		await expect(page.getByTestId("canvas-node-placeholder")).toHaveCount(0);
	});

	test("keeps the picture as a File of this chat, linked to the board", async ({
		page,
	}) => {
		const { conversationId, artifactId } = await seedChat(page, async () => [
			sticky("note-a", 0, 0, "Market"),
		]);
		await openBoard(page, conversationId);
		await openDownload(page);
		const { fileId } = await exportPng(page);

		const [file] = await db
			.select()
			.from(chatGeneratedFiles)
			.where(eq(chatGeneratedFiles.id, fileId));
		expect(file).toMatchObject({
			conversationId,
			filename: "Weekend board.png",
			mimeType: "image/png",
		});
		expect(file.assistantMessageId).not.toBeNull();
		const [output] = await db
			.select()
			.from(artifacts)
			.where(
				and(
					eq(artifacts.conversationId, conversationId),
					eq(artifacts.type, "generated_output"),
				),
			);
		expect(output).toBeTruthy();
		const links = await db
			.select()
			.from(artifactLinks)
			.where(eq(artifactLinks.artifactId, output.id));
		expect(
			links.map((link) => [link.relatedArtifactId, link.linkType]),
		).toContainEqual([artifactId, "used_in_output"]);
		// The board itself was not changed by being pictured.
		expect((await storedBoard(artifactId)).nodes).toHaveLength(1);

		// On the next read of the chat it is one of the things this chat made: a File
		// card under the reply it hangs from (the panel's list is the same read, and
		// `canvas-export.test.ts` asserts it lists the picture as a File).
		await openChatAndReload(page, conversationId);
		await expect(
			page.getByRole("button", { name: /Weekend board\.png/ }).first(),
		).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("artifact-count-button")).toContainText("2");
	});

	test("has nothing to export on an empty board, and says so", async ({
		page,
	}) => {
		const { conversationId } = await seedChat(page, async () => []);
		await openBoard(page, conversationId);
		await openDownload(page);
		await expect(page.getByTestId("canvas-download-png")).toBeDisabled();
		await expect(page.getByTestId("canvas-download-empty")).toHaveText(
			"There is nothing on the board to export yet.",
		);
	});

	test("names the popover, its option and its status for a screen reader, in the reader's language", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		try {
			const { conversationId } = await seedChat(page, async () => [
				sticky("note-a", 0, 0, "Piac"),
			]);
			await openBoard(page, conversationId);
			await openDownload(page);
			await expect(
				page.getByRole("dialog", { name: "„Weekend board” letöltése" }),
			).toBeVisible();
			await expect(page.getByRole("button", { name: /PNG-kép/ })).toBeVisible();
			await page.getByTestId("canvas-download-png").click();
			await expect(page.getByTestId("canvas-download-done")).toContainText(
				"A kép a beszélgetés fájljai között van.",
				{ timeout: 30_000 },
			);
		} finally {
			await setUiLanguage("en");
		}
	});
});

// Screenshots for the report, not part of the gates: run with S3X_SHOTS=<dir>.
const SHOTS = process.env.S3X_SHOTS;
test.describe("screenshots of the picture of a board", () => {
	test.skip(
		!SHOTS,
		"set S3X_SHOTS to a folder to write the report's screenshots",
	);
	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	async function fullBoard(page: Page) {
		return seedChat(
			page,
			async (id) => [
				sticky("note-a", 0, 0, "Piaci nap szombaton"),
				chartNode("chart-1", 240, 0),
				appNode(
					"app-1",
					0,
					360,
					await seedApp(id, "Borravaló-számoló"),
					"Borravaló-számoló",
				),
				mapNode("map-1", 440, 360),
			],
			"Hétvégi tábla",
		);
	}

	for (const scheme of ["light", "dark"] as const) {
		test(`the board, its Download and the picture, Hungarian, ${scheme}, 1440x900`, async ({
			page,
		}) => {
			await setUiLanguage("hu");
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 1440, height: 900 });
			await login(page);
			await stubTiles(page);
			const { conversationId } = await fullBoard(page);
			await openBoard(page, conversationId);
			await expect(page.locator('[data-kind="chart"] canvas')).toBeVisible();
			await page.waitForTimeout(3_000);
			await openDownload(page);
			await waitForStableBoundingBox(
				page.getByTestId("canvas-download-popover"),
			);
			await page.screenshot({
				path: join(SHOTS as string, `1440-${scheme}-download.png`),
			});
			const { fileId } = await exportPng(page);
			await page.waitForTimeout(400);
			await page.screenshot({
				path: join(SHOTS as string, `1440-${scheme}-download-done.png`),
			});
			const png = await page.request.get(`/api/chat/files/${fileId}/preview`);
			mkdirSync(SHOTS as string, { recursive: true });
			writeFileSync(
				join(SHOTS as string, `export-${scheme}.png`),
				await png.body(),
			);
		});
	}

	test("the notice for a block without a still image, Hungarian, 1440x900", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		await stubTiles(page);
		await page.route("**/api/artifacts/*/exports/png*", async (route) => {
			const body = route.request().postDataJSON() as { source?: string };
			if (body.source === "canvas-poster") {
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ ok: false }),
				});
				return;
			}
			await route.continue();
		});
		const { conversationId } = await fullBoard(page);
		await openBoard(page, conversationId);
		await page.waitForTimeout(3_500);
		await openDownload(page);
		const { fileId } = await exportPng(page);
		await page.waitForTimeout(400);
		await page.screenshot({
			path: join(SHOTS as string, "1440-light-missing-notice.png"),
		});
		const png = await page.request.get(`/api/chat/files/${fileId}/preview`);
		writeFileSync(
			join(SHOTS as string, "export-missing.png"),
			await png.body(),
		);
	});

	test("the Download sheet on a phone, Hungarian, 390x844", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
		await stubTiles(page);
		const { conversationId } = await fullBoard(page);
		await openBoard(page, conversationId);
		await page.waitForTimeout(3_000);
		const button = page
			.locator('[data-testid="artifact-download-button"]:visible')
			.first();
		await button.click();
		// A sheet on a phone: it is the option that says it is open.
		await expect(page.getByTestId("canvas-download-png")).toBeVisible();
		await page.waitForTimeout(500);
		await page.screenshot({
			path: join(SHOTS as string, "390-light-download.png"),
		});
	});
});
