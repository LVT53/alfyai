import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	chatGeneratedFiles,
	messages,
} from "../../src/lib/server/db/schema";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import { seedCanvas, testUserId } from "./artifact-canvas-helpers";
import { createConversation } from "./helpers";

// What the specs about changing a block after it was inserted need: a chat that
// has made one of everything "From this chat" lists (a produced file, an App, a
// route, a chart, a Mermaid diagram, a photo search, a web search) with a board
// beside it, the Insert menu driven by the pointer, and the two ways a reader's
// hand reaches the board: a mouse, and a laptop's touchpad, whose cursor is never
// perfectly still between the press and the release.

export const TRIP_NOTES = "Vienna trip notes.md";

export const CHAT_CHART = {
	type: "bar",
	data: {
		labels: ["Apples", "Pears"],
		datasets: [{ label: "Sales", data: [30, 20] }],
	},
	options: { plugins: { title: { text: "Sales by fruit" } } },
};

export const CHAT_DIAGRAM =
	"flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Go]\n  B -->|no| D[Wait]";

const ROUTE = {
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

const APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tip calculator</title></head>
<body><h1>Tip calculator</h1><input aria-label="Bill"></body></html>`;

let sequence = 900;

export type Seeded = {
	conversationId: string;
	boardId: string;
	chatFileId: string;
};

/** A chat that has made one of everything the Insert menu's "From this chat" lists, and a board beside it (empty unless `body` says what it holds). */
export async function seedChat(
	page: Page,
	options: { title?: string; body?: (chatFileId: string) => CanvasBody } = {},
): Promise<Seeded> {
	const conversationId = await createConversation(
		page,
		options.title ?? "Board from the chat",
	);
	const userId = await testUserId();
	const now = new Date();

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

	sequence += 1;
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content: "It is about 27 km down the R600.",
		toolCalls: JSON.stringify([
			{
				type: "tool_call",
				callId: "call-map-1",
				name: "map_route",
				input: { action: "route", from: "Cork", to: "Kinsale" },
				status: "done",
				map: ROUTE,
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
		content: `Here is the chart.\n\n\`\`\`chart\n${JSON.stringify(CHAT_CHART)}\n\`\`\`\n\nAnd the flow.\n\n\`\`\`mermaid\n${CHAT_DIAGRAM}\n\`\`\`\n`,
		createdAt: new Date(now.getTime() + 2_000),
	});
	sequence += 1;
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content: "Found.",
		toolCalls: JSON.stringify([
			{
				type: "tool_call",
				callId: "call-photos-1",
				name: "photos",
				input: { action: "search", query: "sunset" },
				status: "done",
				metadata: { ok: true, action: "search", resultCount: 3 },
				candidates: ["p1", "p2", "p3"].map((id) => ({
					id: `photos:${id}`,
					title: `holiday-${id}.jpg`,
					url: "",
					snippet: `holiday-${id}.jpg`,
					sourceType: "tool",
					metadata: { thumbnailPath: `/api/assets/${id}/thumbnail` },
				})),
			},
			{
				type: "tool_call",
				callId: "call-search-1",
				name: "research_web",
				input: { query: "cork weather" },
				status: "done",
				sourceType: "web",
				metadata: { ok: true, evidenceReady: true, sourceCount: 3 },
				candidates: [1, 2, 3].map((n) => ({
					id: `src-${n}`,
					title: `Forecast source ${n}`,
					url: `https://weather${n}.example.com/cork`,
					snippet: `What source ${n} says.`,
					sourceType: "web",
					material: true,
					metadata: {
						provider: "parallel",
						authorityClass: "primary",
						authorityScore: 0.9,
						providerRank: n,
					},
				})),
			},
		]),
		createdAt: new Date(now.getTime() + 3_000),
	});

	const appId = randomUUID();
	await db.insert(artifacts).values({
		id: appId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: "Tip calculator",
		contentText: APP_HTML,
		metadataJson: JSON.stringify({
			artifactType: "app",
			title: "Tip calculator",
		}),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId: appId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		body: APP_HTML,
		bodyHash: "seed-hash",
		createdAt: now,
	});

	const boardId = await seedCanvas(
		conversationId,
		options.body ? options.body(chatFileId) : emptyCanvasBody(),
		"Board",
	);
	return { conversationId, boardId, chatFileId };
}

/** Opens the chat and the panel on its Canvas (the chat has made other things too, so the board is picked by its own row). */
export async function openTheBoard(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
	const board = page.getByTestId("canvas-board");
	if (!(await board.isVisible().catch(() => false))) {
		const list = page.getByTestId("artifact-panel-list");
		if (!(await list.isVisible().catch(() => false))) {
			await page.getByTestId("artifact-count-button").click();
		}
		await list
			.getByTestId("artifact-row")
			.filter({ hasText: /Canvas|Tábla/ })
			.click();
	}
	await expect(board).toBeVisible({ timeout: 15_000 });
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
	await page.waitForTimeout(600);
}

/** Inserts a row of the menu (written ones by name, "From this chat" ones by what the chat made) and waits for the block. */
export async function insertFromMenu(page: Page, name: RegExp) {
	await page.getByTestId("canvas-insert-button").click();
	const menu = page.getByTestId("canvas-insert-menu-list");
	await expect(menu).toBeVisible();
	// "From this chat" has read the chat once its reading line is gone.
	await expect(menu.getByText(/Looking through this chat/)).toHaveCount(0);
	await menu.getByRole("menuitem", { name }).first().click();
	await expect(menu).toHaveCount(0);
	await page.waitForTimeout(500);
}

// ---- The reader's hand ---------------------------------------------------

/** A mouse presses and releases on one spot; a touchpad's cursor wanders a pixel or two in between. */
export type Style = "mouse" | "touchpad";
export type Pt = { x: number; y: number };

const WOBBLE: Pt[] = [
	{ x: 1, y: 0 },
	{ x: 1, y: 1 },
	{ x: 0, y: 1 },
	{ x: 0, y: 0 },
];

export async function click(page: Page, style: Style, at: Pt, count = 1) {
	await page.mouse.move(at.x, at.y);
	for (let press = 1; press <= count; press++) {
		await page.mouse.down({ clickCount: press });
		if (style === "touchpad") {
			for (const step of WOBBLE) {
				await page.mouse.move(at.x + step.x, at.y + step.y);
			}
		}
		await page.mouse.up({ clickCount: press });
		if (press < count) await page.waitForTimeout(40);
	}
}

export async function drag(page: Page, style: Style, from: Pt, to: Pt) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	if (style === "touchpad") {
		for (const step of WOBBLE) {
			await page.mouse.move(from.x + step.x, from.y + step.y);
		}
	}
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	await page.mouse.move(to.x, to.y, {
		steps: style === "touchpad" ? Math.ceil(distance / 3) : 14,
	});
	await page.mouse.up();
}

export function centre(box: {
	x: number;
	y: number;
	width: number;
	height: number;
}): Pt {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The block's wrapper on the board (the library's own element: what a pointer meets). */
export const wrapperOf = (page: Page, id: string) =>
	page.locator(`.svelte-flow__node[data-id="${id}"]`);

/** The block's shell (the board's own element: carries what the block is and whether it is selected). */
export const nodeOf = (page: Page, id: string) =>
	page.locator(`[data-testid="canvas-node"][data-node-id="${id}"]`);

/** The one block of a kind on the board: its id, once it is there. */
export async function idOfKind(page: Page, kind: string): Promise<string> {
	const node = page
		.locator(`[data-testid="canvas-node"][data-kind="${kind}"]`)
		.first();
	await expect(node).toBeVisible({ timeout: 10_000 });
	return (await node.getAttribute("data-node-id")) as string;
}

/** A spot of bare board, away from every block and every control. */
export async function bareSpot(page: Page): Promise<Pt> {
	const pane = await page.getByTestId("canvas-board").boundingBox();
	if (!pane) throw new Error("no board");
	return { x: pane.x + 40, y: pane.y + 70 };
}
