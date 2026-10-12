import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { artifacts, artifactVersions } from "../../src/lib/server/db/schema";
import { createArtifact } from "../../src/lib/server/services/artifacts";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import {
	boardJson,
	emptyCanvasBody,
} from "../../src/lib/shared/artifacts/canvas-body";
import {
	AI_SMOKE_CANVAS_EDIT_FINAL_TEXT,
	AI_SMOKE_CANVAS_EDIT_MARKER,
	encodeCanvasEditScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	cameraOf,
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
	settledCamera,
	testUserId,
} from "./artifact-canvas-helpers";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// The board's friction (phase 5, FB-4, ruling 77): what the audit found walking a
// board like the owner, built on real input. One spec for the whole round, each
// finding in its own describe, so the red run of a finding is its own.

const SHOTS = process.env.FB4_SHOTS ?? null;

function shot(name: string): string {
	if (!SHOTS) throw new Error("no screenshot folder");
	mkdirSync(SHOTS, { recursive: true });
	return join(SHOTS, name);
}

const insertButton = (page: Page) => page.getByTestId("canvas-insert-button");
const insertMenu = (page: Page) => page.getByTestId("canvas-insert-menu-list");

/** An App row in the chat, written straight to the database the way the other Canvas specs do. */
async function seedApp(
	conversationId: string,
	title: string,
	madeMinutesAgo: number,
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const at = new Date(Date.now() - madeMinutesAgo * 60_000);
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: html,
		metadataJson: JSON.stringify({ artifactType: "app", title }),
		createdAt: at,
		updatedAt: at,
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
		createdAt: at,
	});
	return artifactId;
}

test.describe("F9: rows of one name are told apart in the Insert menu", () => {
	test("two Apps called alike say when each was made, and a name of its own says nothing more", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Same names");
		await seedApp(conversationId, "Tip calculator", 25);
		await seedApp(conversationId, "Tip calculator", 2);
		await seedApp(conversationId, "Habit tracker", 5);
		await seedCanvas(conversationId, emptyCanvasBody(), "Board");
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.filter({ hasText: /Canvas|Tábla/ })
			.click();
		await expect(page.getByTestId("canvas-board")).toBeVisible({
			timeout: 15_000,
		});

		await insertButton(page).click();
		await expect(insertMenu(page)).toBeVisible();
		const apps = insertMenu(page)
			.getByTestId("canvas-chat-item")
			.and(page.locator('[data-kind="app"]'));
		await expect(apps).toHaveCount(3);

		const rows = await apps.allInnerTexts();
		const tips = rows.filter((row) => row.includes("Tip calculator"));
		expect(tips).toHaveLength(2);
		// Two rows that read alike no longer do: each carries its own time, never a version.
		expect(new Set(tips).size).toBe(2);
		for (const row of tips) {
			expect(row).toMatch(/\d{1,2}:\d{2}/);
			expect(row).not.toMatch(/\bv\d|version|verzi/i);
		}
		// A row with a name of its own has nothing to add.
		const habit = rows.find((row) => row.includes("Habit tracker")) ?? "";
		expect(habit.trim()).toBe("Habit tracker");
		if (SHOTS) {
			await page.screenshot({ path: shot("f9-insert-menu-same-names.png") });
		}
	});
});

// ---- F11 ---------------------------------------------------------------------

/** The audit's own: the way from the airport to the hotel, five boxes across. */
const AIRPORT = [
	"flowchart LR",
	"  A[Bécs-Schwechat reptér] --> B[S-Bahn S7 vagy CAT]",
	"  B --> C[Wien Mitte]",
	"  C --> D[Metró vagy villamos]",
	"  D --> E[Szálloda a belvárosban]",
].join("\n");

function flowBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "flow",
				type: "mermaid",
				position: { x: 40, y: 40 },
				width: 480,
				data: { kind: "mermaid", label: "Reptér → szálloda", code: AIRPORT },
			},
		],
		edges: [],
		// A camera of its own, so the board is not fitted: 100% is what the reader gets.
		viewport: { x: 16, y: 16, zoom: 1 },
		annotations: [],
	};
}

test.describe("F11: a wide flowchart is drawn where it can be read", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("the audit's five-box flowchart is read at its own size at 100%, and its block never shows the raw source first", async ({
		page,
	}) => {
		// Every moment the source of a diagram is in the block, seen from the first frame on.
		await page.addInitScript(() => {
			const w = window as unknown as { __rawSourceSeen: boolean };
			w.__rawSourceSeen = false;
			const look = () => {
				if (
					document.querySelector(
						'[data-testid="canvas-mermaid"] .markdown-diagram-source, [data-testid="canvas-mermaid"] .markdown-mermaid-placeholder',
					)
				) {
					w.__rawSourceSeen = true;
				}
			};
			new MutationObserver(look).observe(document, {
				childList: true,
				subtree: true,
			});
		});
		await login(page);
		const conversationId = await createEmptyConversation(page, "Flowchart");
		await seedCanvas(conversationId, flowBoard(), "Flow board");
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const svg = page
			.getByTestId("canvas-mermaid")
			.locator(".markdown-mermaid svg");
		await expect(svg).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("canvas-zoom-level")).toHaveText("100%");

		// What the picture is drawn at, against its own size: a third made the words 5 px.
		const drawn = await svg.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const own = (element as unknown as SVGSVGElement).viewBox.baseVal;
			// The smallest line of words in the picture, as it stands on the screen.
			const heights = Array.from(element.querySelectorAll("text"))
				.filter((text) => (text.textContent ?? "").trim() !== "")
				.map((text) => text.getBoundingClientRect().height);
			return {
				scale: box.width / own.width,
				labelHeight: heights.length > 0 ? Math.min(...heights) : 0,
			};
		});
		expect(drawn.scale).toBeGreaterThan(0.7);
		expect(drawn.labelHeight).toBeGreaterThan(14);

		expect(
			await page.evaluate(
				() =>
					(window as unknown as { __rawSourceSeen: boolean }).__rawSourceSeen,
			),
			"the block showed the raw Mermaid source before the drawing",
		).toBe(false);
		if (SHOTS) {
			await page.screenshot({ path: shot("f11-wide-flowchart-1440.png") });
		}
	});
});

// ---- Alfy's change to a board (F12, F18) -----------------------------------------

const fakeProvider = createOpenAICompatibleProviderHarness();

/** Two frames side by side, a note below, in a camera the board fits itself: what the audit's weekend board was. */
function planBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "frame-sat",
				type: "frame",
				position: { x: 20, y: 20 },
				width: 400,
				height: 260,
				data: { kind: "frame", label: "Saturday", width: 400, height: 260 },
			},
			{
				id: "note-lunch",
				type: "sticky",
				position: { x: 24, y: 64 },
				parentId: "frame-sat",
				width: 180,
				data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
			},
			{
				id: "frame-sun",
				type: "frame",
				position: { x: 460, y: 20 },
				width: 400,
				height: 260,
				data: { kind: "frame", label: "Sunday", width: 400, height: 260 },
			},
			{
				id: "note-brunch",
				type: "sticky",
				position: { x: 24, y: 64 },
				parentId: "frame-sun",
				width: 180,
				data: { kind: "sticky", text: "Brunch, 10:30", tone: "mint" },
			},
			{
				id: "note-museum",
				type: "sticky",
				position: { x: 20, y: 340 },
				width: 200,
				data: { kind: "sticky", text: "Museum, 14:00", tone: "blue" },
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

type Scene = {
	conversationId: string;
	artifactId: string;
	cleanup: () => Promise<void>;
};

/** A board made through the service, a fake model to script Alfy's edit, the chat and the panel open on it. */
async function openWithAlfy(page: Page): Promise<Scene> {
	await login(page);
	const previousPreference = await snapshotUserModelPreference(page);
	const conversationId = await createEmptyConversation(page);
	const userId = await testUserId();
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(planBoard()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	const provider = await createTemporaryFakeProviderModel(
		page,
		fakeProvider.baseURL,
	);
	await updateUserModelPreference(page, provider.selectedModel);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return {
		conversationId,
		artifactId: created.artifact.id,
		cleanup: async () => {
			await updateUserModelPreference(page, previousPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		},
	};
}

/** What the reader asks the chat: the fake model answers with an `edit_artifact` call of exactly these ops. */
async function askAlfy(page: Page, artifactId: string, ops: unknown[]) {
	await sendMessage(
		page,
		`${AI_SMOKE_CANVAS_EDIT_MARKER} ${encodeCanvasEditScenarioPayload({ artifactId, summary: "Changed the plan", ops })}`,
	);
	await expect(page.getByText(AI_SMOKE_CANVAS_EDIT_FINAL_TEXT)).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId("canvas-review-bar")).toBeVisible({
		timeout: 15_000,
	});
}

/** "Add a note next to the Saturday ones": the note, the frame that grew to hold it, the other frame aside, and an arrow. */
const ADD_ONE_NOTE = [
	{
		op: "add_node",
		node: {
			id: "note-new",
			type: "sticky",
			parentId: "frame-sat",
			position: { x: 220, y: 64 },
			data: { kind: "sticky", text: "Schönbrunn, 9:00", tone: "mint" },
		},
	},
	{ op: "update_node", id: "frame-sat", data: { width: 520, height: 260 } },
	{ op: "move", id: "frame-sun", to: { x: 580, y: 20 } },
	{
		op: "add_edge",
		edge: { id: "edge-new", source: "note-new", target: "note-museum" },
	},
];

const reviewBar = (page: Page) => page.getByTestId("canvas-review-bar");

test.describe("F12: Alfy's change to a board is counted and worded as the reader sees it", () => {
	test.use({ viewport: { width: 1440, height: 900 } });
	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	test("one note added is one change on the bar and on the card, though a frame grew, another went aside and an arrow was drawn; the camera stays where it was", async ({
		page,
	}) => {
		const scene = await openWithAlfy(page);
		try {
			// The board is fitted and untouched: a board that follows what it takes in.
			const before = await settledCamera(page);
			await askAlfy(page, scene.artifactId, ADD_ONE_NOTE);
			await expect(reviewBar(page)).toContainText("Alfy changed 1 block.");
			await expect(reviewBar(page)).toContainText("1 / 1");
			await expect(
				page.locator(".artifact-card-pending").first(),
			).toContainText("1 change to review");
			// What is on screen did not move under the reader: no zoom to the change, no glide back.
			await page.waitForTimeout(1_800);
			const after = await settledCamera(page);
			expect(after.zoom, "zoom").toBeCloseTo(before.zoom, 4);
			expect(after.x, "x").toBeCloseTo(before.x, 1);
			expect(after.y, "y").toBeCloseTo(before.y, 1);
			if (SHOTS) {
				await page.screenshot({ path: shot("f12-one-note-one-change.png") });
			}
		} finally {
			await scene.cleanup();
		}
	});

	test("a note rewritten is one block changed, not one changed and one removed", async ({
		page,
	}) => {
		const scene = await openWithAlfy(page);
		try {
			await askAlfy(page, scene.artifactId, [
				{ op: "remove_node", id: "note-museum" },
				{
					op: "add_node",
					node: {
						id: "note-museum-new",
						type: "sticky",
						position: { x: 20, y: 340 },
						data: {
							kind: "sticky",
							text: "Museum, 14:00, with the audio guide",
							tone: "blue",
						},
					},
				},
			]);
			await expect(reviewBar(page)).toContainText("Alfy changed 1 block.");
			await expect(reviewBar(page)).not.toContainText("removed");
			await expect(
				page.locator(".artifact-card-pending").first(),
			).toContainText("1 change to review");
		} finally {
			await scene.cleanup();
		}
	});
});

void cameraOf;
