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
	nodeBox,
	openBoard,
	openCanvasPanel,
	openChatAndReload,
	PHONE,
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

// ---- F8 -----------------------------------------------------------------------

/** The audit's weekend board, full enough that the pane has little free ground: two frames with notes, a chart, a flowchart. */
function crowdedBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "frame-sat",
				type: "frame",
				position: { x: 24, y: 70 },
				width: 440,
				height: 250,
				data: { kind: "frame", label: "Saturday", width: 440, height: 250 },
			},
			{
				id: "note-lunch",
				type: "sticky",
				position: { x: 20, y: 60 },
				parentId: "frame-sat",
				width: 190,
				data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
			},
			{
				id: "note-park",
				type: "sticky",
				position: { x: 230, y: 60 },
				parentId: "frame-sat",
				width: 190,
				data: { kind: "sticky", text: "Park and Gloriette", tone: "mint" },
			},
			{
				id: "frame-sun",
				type: "frame",
				position: { x: 500, y: 70 },
				width: 420,
				height: 250,
				data: { kind: "frame", label: "Sunday", width: 420, height: 250 },
			},
			{
				id: "note-belv",
				type: "sticky",
				position: { x: 20, y: 60 },
				parentId: "frame-sun",
				width: 190,
				data: { kind: "sticky", text: "Belvedere, 9:00", tone: "blue" },
			},
			{
				id: "chart",
				type: "chart",
				position: { x: 40, y: 360 },
				width: 360,
				data: {
					kind: "chart",
					label: "Costs",
					code: JSON.stringify({
						type: "bar",
						data: {
							labels: ["Museum", "Lunch", "Dinner"],
							datasets: [{ label: "EUR", data: [40, 30, 60] }],
						},
					}),
				},
			},
			{
				id: "flow",
				type: "mermaid",
				position: { x: 440, y: 360 },
				width: 480,
				data: {
					kind: "mermaid",
					label: "Airport to hotel",
					code: "flowchart LR\n  A[Plan] --> B[Build] --> C[Ship]",
				},
			},
		],
		edges: [],
		viewport: { x: 16, y: 16, zoom: 1 },
		annotations: [],
	};
}

type Placed = { id: string; frame: boolean; box: ScreenBox };
type ScreenBox = { left: number; top: number; right: number; bottom: number };

/** Every block on the board, as the reader sees it on the screen. */
async function blocksOnScreen(page: Page): Promise<Placed[]> {
	return page.locator(".svelte-flow__node").evaluateAll((nodes) =>
		nodes.map((node) => {
			const box = node.getBoundingClientRect();
			return {
				id: node.getAttribute("data-id") ?? "",
				frame: node.classList.contains("svelte-flow__node-frame"),
				box: {
					left: box.left,
					top: box.top,
					right: box.right,
					bottom: box.bottom,
				},
			};
		}),
	);
}

const meets = (a: ScreenBox, b: ScreenBox): boolean =>
	a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const holds = (outer: ScreenBox, inner: ScreenBox): boolean =>
	inner.left >= outer.left - 1 &&
	inner.top >= outer.top - 1 &&
	inner.right <= outer.right + 1 &&
	inner.bottom <= outer.bottom + 1;

async function screenBoxOf(
	locator: ReturnType<Page["locator"]>,
): Promise<ScreenBox> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("not on the screen");
	return {
		left: box.x,
		top: box.y,
		right: box.x + box.width,
		bottom: box.y + box.height,
	};
}

test.describe("F8: Insert puts each block where it can be used", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("five Inserts in a row on a crowded board: each wholly in the pane, clear of the toolbar, over nothing, and with the focus", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Crowded");
		await seedCanvas(conversationId, crowdedBoard(), "Crowded board");
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);
		await settledCamera(page);

		const kinds = ["sticky", "text", "frame", "chart", "checklist"];
		const problems: string[] = [];
		for (const kind of kinds) {
			const before = await blocksOnScreen(page);
			await insertButton(page).click();
			await expect(insertMenu(page)).toBeVisible();
			await insertMenu(page).getByTestId(`canvas-insert-${kind}`).click();
			await expect(insertMenu(page)).toHaveCount(0);
			await expect(page.locator(".svelte-flow__node")).toHaveCount(
				before.length + 1,
			);
			// The camera, if it moved to show the block, has arrived.
			await settledCamera(page);
			const now = await blocksOnScreen(page);
			const added = now.find(
				(block) => !before.some((old) => old.id === block.id),
			);
			if (!added) throw new Error(`no new ${kind}`);

			const pane = await screenBoxOf(page.getByTestId("canvas-board"));
			if (!holds(pane, added.box)) {
				problems.push(
					`${kind}: not wholly in the pane ${JSON.stringify(added.box)}`,
				);
			}
			const toolbar = await screenBoxOf(page.getByTestId("canvas-toolbar"));
			if (meets(added.box, toolbar))
				problems.push(`${kind}: under the toolbar`);
			for (const panel of await page.locator(".svelte-flow__panel").all()) {
				const box = await panel.boundingBox();
				if (!box) continue;
				const over = {
					left: box.x,
					top: box.y,
					right: box.x + box.width,
					bottom: box.y + box.height,
				};
				if (meets(added.box, over))
					problems.push(`${kind}: under a corner control`);
			}
			// The others as they are now: the camera may have moved to show the block.
			for (const block of now.filter((other) => other.id !== added.id)) {
				// A frame is a backdrop: a block may be in it, wholly, never across it.
				if (!meets(added.box, block.box)) continue;
				if (block.frame && holds(block.box, added.box) && kind !== "frame")
					continue;
				problems.push(`${kind}: over ${block.id}`);
			}
			// Every kind takes the focus the same way: the keyboard is in the block just made.
			const focused = await page.evaluate(
				(id) =>
					document
						.querySelector(`.svelte-flow__node[data-id="${id}"]`)
						?.contains(document.activeElement) ?? false,
				added.id,
			);
			if (!focused) problems.push(`${kind}: the focus is not in the block`);
			if (SHOTS && kind === "checklist") {
				await page.screenshot({ path: shot("f8-five-inserts-1440.png") });
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
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

// ---- F18 ------------------------------------------------------------------------

test.describe("F18: Keep and Undo do not make the board's own controls jump", () => {
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

	/** Where the toolbar, the overview and the zoom control are on every frame from now until `stop`. */
	async function watchControls(page: Page) {
		await page.evaluate(() => {
			const w = window as unknown as {
				__controls: {
					t: number;
					toolbar: number;
					overview: number;
					zoom: number;
				}[];
				__watching: boolean;
			};
			w.__controls = [];
			w.__watching = true;
			const top = (selector: string) =>
				document.querySelector(selector)?.getBoundingClientRect().top ??
				Number.NaN;
			const sample = () => {
				w.__controls.push({
					t: performance.now(),
					toolbar: top('[data-testid="canvas-toolbar"]'),
					overview: top(".svelte-flow__minimap"),
					zoom: top(".canvas-corner"),
				});
				if (w.__watching) requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
	}

	/** The largest distance any of them moved between two frames, and how far from where they started they ended. */
	async function stopWatching(page: Page) {
		return page.evaluate(() => {
			const w = window as unknown as {
				__controls: { toolbar: number; overview: number; zoom: number }[];
				__watching: boolean;
			};
			w.__watching = false;
			const frames = w.__controls;
			let jump = 0;
			for (let index = 1; index < frames.length; index += 1) {
				for (const key of ["toolbar", "overview", "zoom"] as const) {
					jump = Math.max(
						jump,
						Math.abs(frames[index][key] - frames[index - 1][key]),
					);
				}
			}
			// In how many frames the toolbar moved at all: a cut is one or two, a glide is a run of them.
			let moving = 0;
			for (let index = 1; index < frames.length; index += 1) {
				if (Math.abs(frames[index].toolbar - frames[index - 1].toolbar) > 0.5) {
					moving += 1;
				}
			}
			const first = frames[0];
			const last = frames[frames.length - 1];
			return {
				jump,
				moving,
				moved: Math.abs(last.toolbar - first.toolbar),
				frames: frames.length,
			};
		});
	}

	test("the bar's arrival and Keep move them smoothly, with the bar, never in one cut", async ({
		page,
	}) => {
		const scene = await openWithAlfy(page);
		try {
			await watchControls(page);
			await askAlfy(page, scene.artifactId, ADD_ONE_NOTE);
			await page.waitForTimeout(500);
			const arrival = await stopWatching(page);
			// The bar is ~48 px: it arrives as a height that grows, so what is pinned to the
			// board's bottom edge rises with it, a few pixels a frame.
			expect(arrival.moved, "the controls rise with the bar").toBeGreaterThan(
				30,
			);
			// A cut is the whole 48 px in one frame; a glide over a slow frame or two stays well under.
			expect(
				arrival.jump,
				"arrival: no frame moves them by the bar's whole height",
			).toBeLessThan(36);
			expect(
				arrival.moving,
				"arrival: a run of frames, not a cut",
			).toBeGreaterThanOrEqual(3);

			await watchControls(page);
			await page.getByRole("button", { name: /^Keep all/ }).click();
			await expect(page.getByTestId("canvas-review-bar")).toHaveCount(0);
			await page.waitForTimeout(500);
			const keep = await stopWatching(page);
			expect(
				keep.moved,
				"the controls settle back where they stood",
			).toBeGreaterThan(30);
			expect(
				keep.jump,
				"Keep: no frame moves them by the bar's whole height",
			).toBeLessThan(36);
			expect(
				keep.moving,
				"Keep: a run of frames, not a cut",
			).toBeGreaterThanOrEqual(3);
		} finally {
			await scene.cleanup();
		}
	});
});

// ---- F24 ------------------------------------------------------------------------

test.describe("F24: opening the comments column does not cut the board", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("a board the reader has not moved is fitted again to what the column leaves, after they used the Comment tool", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Comments");
		await seedCanvas(conversationId, planBoard(), "Plan board");
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);
		await settledCamera(page);
		const wide = await screenBoxOf(page.getByTestId("canvas-board"));

		// The reader's own way in: the Comment tool, then a block. Both are presses on the
		// board, and neither moves the camera.
		await page.getByTestId("canvas-tool-comment").click();
		await expect(page.getByTestId("canvas-comment-catcher")).toBeVisible();
		const lunch = await screenBoxOf(
			page.locator('.svelte-flow__node[data-id="note-lunch"]'),
		);
		await page.mouse.click(
			(lunch.left + lunch.right) / 2,
			(lunch.top + lunch.bottom) / 2,
		);
		await expect(page.getByTestId("comment-composer")).toBeVisible();
		await expect(page.getByTestId("canvas-comments-rail")).toBeVisible();

		await settledCamera(page);
		const narrow = await screenBoxOf(page.getByTestId("canvas-board"));
		expect(
			narrow.right - narrow.left,
			"the column took room from the board",
		).toBeLessThan(wide.right - wide.left - 200);
		// Every block is still wholly in the pane: nothing is cut by the column.
		const cut: string[] = [];
		for (const block of await blocksOnScreen(page)) {
			if (!holds(narrow, block.box)) cut.push(block.id);
		}
		expect(cut, `cut by the column: ${cut.join(", ")}`).toEqual([]);
		if (SHOTS) {
			await page.screenshot({
				path: shot("f24-comments-column-refit-1440.png"),
			});
		}
	});
});

// ---- F28 ------------------------------------------------------------------------

/** What the library draws for a corner of the picked block: the small dot the reader sees. */
const cornerOf = (page: Page, id: string) =>
	page.locator(
		`.svelte-flow__node[data-id="${id}"] .svelte-flow__resize-control.handle.bottom.right`,
	);

test.describe("F28: a resize handle keeps its small dot and has room to be hit", () => {
	test.describe("with a mouse", () => {
		test.use({ viewport: { width: 1440, height: 900 } });

		test("a press 10 px from the corner dot, off the 8 px square, still takes the handle", async ({
			page,
		}) => {
			await openBoard(page, "Handles");
			await page.locator('.svelte-flow__node[data-id="note-1"]').click();
			const corner = await cornerOf(page, "note-1").boundingBox();
			if (!corner) throw new Error("no corner handle");
			// The dot stays a dot.
			expect(corner.width).toBeLessThanOrEqual(12);
			if (SHOTS) {
				await page.screenshot({
					path: shot("f28-handles-attribution-1440.png"),
				});
			}
			const before = await nodeBox(page, "note-1");
			const from = {
				x: corner.x + corner.width / 2 + 10,
				y: corner.y + corner.height / 2 + 10,
			};
			await page.mouse.move(from.x, from.y);
			await page.mouse.down();
			await page.mouse.move(from.x + 30, from.y + 15, { steps: 4 });
			await page.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
			await page.mouse.up();
			const after = await nodeBox(page, "note-1");
			expect(
				after.width,
				"the note is wider by what the handle was dragged",
			).toBeGreaterThan(before.width + 40);
		});
	});

	test.describe("with a finger", () => {
		test.use({ hasTouch: true, viewport: PHONE });

		test("a touch 18 px to the side of the corner dot, a fingertip's reach, takes the handle", async ({
			page,
		}) => {
			await openBoard(page, "Handles on a phone");
			const note = await nodeBox(page, "note-1");
			await page.touchscreen.tap(
				note.x + note.width / 2,
				note.y + note.height / 2,
			);
			const corner = await cornerOf(page, "note-1").boundingBox();
			if (!corner) throw new Error("no corner handle");
			const before = await nodeBox(page, "note-1");
			// Beside the dot, level with it: clear of the selection's pill, which hangs under the block.
			const from = {
				x: corner.x + corner.width / 2 + 18,
				y: corner.y + corner.height / 2 - 6,
			};
			const client = await page.context().newCDPSession(page);
			await client.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ ...from, id: 1 }],
			});
			for (let step = 1; step <= 6; step += 1) {
				await client.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x: from.x + step * 10, y: from.y + step * 5, id: 1 }],
				});
			}
			await client.send("Input.dispatchTouchEvent", {
				type: "touchEnd",
				touchPoints: [],
			});
			await client.detach();
			const after = await nodeBox(page, "note-1");
			expect(
				after.width,
				"the note is wider, not the board moved",
			).toBeGreaterThan(before.width + 30);
		});
	});

	test.describe("the library's attribution", () => {
		test.use({ viewport: { width: 1440, height: 900 } });

		test("stays, in its corner, and is quieter than the board's own text", async ({
			page,
		}) => {
			await openBoard(page, "Attribution");
			const link = page.locator(".svelte-flow__attribution a");
			await expect(link).toBeVisible();
			await expect(link).toHaveText(/Svelte Flow/);
			const quiet = await page
				.locator(".svelte-flow__attribution")
				.evaluate((element) => Number(getComputedStyle(element).opacity));
			expect(quiet).toBeLessThanOrEqual(0.5);
			expect(quiet).toBeGreaterThan(0);
		});
	});
});
