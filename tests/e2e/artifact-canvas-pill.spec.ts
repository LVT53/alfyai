import { expect, type Page, test } from "@playwright/test";
import { createArtifact } from "../../src/lib/server/services/artifacts";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import {
	AI_SMOKE_CANVAS_EDIT_FINAL_TEXT,
	AI_SMOKE_CANVAS_EDIT_MARKER,
	encodeCanvasEditScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	dragBetween,
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	testUserId,
} from "./artifact-canvas-helpers";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createConversation, login, sendMessage } from "./helpers";

// The change pill (Keep / Undo) stays with what Alfy changed. The owner's walk:
// "sometimes the 'Keep Undo' row moves into weird locations far from the element."
// It hung from the top-right corner of the box that holds EVERY touched block, which
// for a change spread over the board is an empty corner of that box (or, past the
// pane, the pane's edge): near nothing. It now hangs from the block the review bar
// is showing, and follows the bar's stepper. A REAL `edit_artifact` call, through
// the real chat, through the fake provider (artifact-canvas-review.spec.ts's way).

const FRAME = "frame-saturday";
const LUNCH = "note-lunch";
const COFFEE = "note-coffee";
const MUSEUM = "note-museum";
const DINNER = "note-dinner";
const FAR = "note-far";
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

// Two notes stacked close together in a frame: the one below has another note
// right above it, where a pill hung over its top edge would land.
function board(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: FRAME,
				type: "frame",
				position: { x: 20, y: 20 },
				width: 320,
				height: 260,
				data: { kind: "frame", label: "Saturday", width: 320, height: 260 },
			},
			note(LUNCH, 24, 60, "Lunch at the market", FRAME),
			note(COFFEE, 24, 136, "Coffee", FRAME),
			note(MUSEUM, 420, 40, "Museum, 14:00"),
			note(DINNER, 420, 200, "Dinner, 19:30"),
			note(FAR, 900, 620, "Far away"),
		],
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
}

const fakeProvider = createOpenAICompatibleProviderHarness();

test.beforeAll(async () => {
	await fakeProvider.start();
});
test.afterAll(async () => {
	await fakeProvider.stop();
});
test.beforeEach(async () => {
	await fakeProvider.reset();
});

async function open(page: Page, options: { panel?: boolean } = {}) {
	await login(page);
	const previousPreference = await snapshotUserModelPreference(page);
	const conversationId = await createConversation(page, "Pill place");
	const created = await createArtifact({
		userId: await testUserId(),
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(board()),
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
	if (options.panel !== false) await openCanvasPanel(page);
	return {
		artifactId: created.artifact.id,
		cleanup: async () => {
			await updateUserModelPreference(page, previousPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		},
	};
}

async function askAlfy(page: Page, artifactId: string, ops: unknown[]) {
	await sendMessage(
		page,
		`${AI_SMOKE_CANVAS_EDIT_MARKER} ${encodeCanvasEditScenarioPayload({ artifactId, summary: "Changed things", ops })}`,
	);
	await expect(page.getByText(AI_SMOKE_CANVAS_EDIT_FINAL_TEXT)).toBeVisible({
		timeout: 30_000,
	});
}

const pill = (page: Page) => page.getByTestId("canvas-change-pill");

type Box = { x: number; y: number; width: number; height: number };

/** The shortest distance between two rectangles on the screen: 0 when they touch or overlap. */
function gap(a: Box, b: Box): number {
	const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0);
	const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0);
	return Math.hypot(dx, dy);
}

function overlap(a: Box, b: Box): number {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

/** How far the pill is from the changed block, and whether it sits inside the board's pane. */
async function pillAgainst(page: Page, changed: string) {
	await expect(pill(page)).toBeVisible({ timeout: 15_000 });
	// The landing glides and the camera may move to it: measure where it comes to rest.
	await page.waitForTimeout(1_400);
	const pillBox = await pill(page).boundingBox();
	const pane = await page.getByTestId("canvas-board").boundingBox();
	if (!pillBox || !pane) throw new Error("no pill or pane");
	return {
		pillBox,
		pane,
		distance: gap(pillBox, await nodeBox(page, changed)),
		inPane:
			pillBox.x >= pane.x - 0.5 &&
			pillBox.y >= pane.y - 0.5 &&
			pillBox.x + pillBox.width <= pane.x + pane.width + 0.5 &&
			pillBox.y + pillBox.height <= pane.y + pane.height + 0.5,
	};
}

/** The pill sits beside the block, not over any other. */
const NEAR = 40;

test.describe("the change pill stays with what changed", () => {
	test("a change to two blocks far apart: the pill is at the one the review bar shows, and follows the stepper to the other", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, [
				{
					op: "update_node",
					id: MUSEUM,
					data: { text: "Museum, 14:00 (tickets booked)" },
				},
				{ op: "update_node", id: FAR, data: { text: "Far away, changed" } },
			]);
			// The bar shows the first of the two: the pill is beside it, and not at the
			// empty corner of the box that holds both.
			const first = await pillAgainst(page, MUSEUM);
			expect(first.distance).toBeLessThan(NEAR);
			expect(first.inPane).toBe(true);
			await expect(page.getByTestId("canvas-review-bar")).toContainText(
				"1 / 2",
			);

			// Next change: the camera goes to the other block, and the pill goes with it.
			await page.getByRole("button", { name: "Next change" }).click();
			await expect(page.getByTestId("canvas-review-bar")).toContainText(
				"2 / 2",
			);
			await page.waitForTimeout(1_000);
			const second = await pillAgainst(page, FAR);
			expect(second.distance).toBeLessThan(NEAR);
			expect(second.inPane).toBe(true);
		} finally {
			await scene.cleanup();
		}
	});

	test("a note inside a frame, with another note right above it: the pill is beside it and covers no other block", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, [
				{ op: "update_node", id: COFFEE, data: { text: "Coffee, oat milk" } },
			]);
			const seen = await pillAgainst(page, COFFEE);
			expect(seen.distance).toBeLessThan(NEAR);
			expect(seen.inPane).toBe(true);
			for (const other of [LUNCH, MUSEUM, DINNER, FAR]) {
				expect(
					overlap(seen.pillBox, await nodeBox(page, other)),
					`the pill covers ${other}`,
				).toBe(0);
			}
		} finally {
			await scene.cleanup();
		}
	});

	test("after the reader panned and zoomed the board", async ({ page }) => {
		const scene = await open(page);
		try {
			const pane = await page.locator(".svelte-flow__pane").boundingBox();
			if (!pane) throw new Error("no pane");
			// Pan the board left and up, then zoom out over its middle.
			await dragBetween(
				page,
				{ x: pane.x + pane.width - 60, y: pane.y + 60 },
				{ x: pane.x + pane.width - 220, y: pane.y + 110 },
			);
			await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
			await page.keyboard.down("Control");
			await page.mouse.wheel(0, 240);
			await page.keyboard.up("Control");
			await page.waitForTimeout(500);
			await askAlfy(page, scene.artifactId, [
				{
					op: "update_node",
					id: DINNER,
					data: { text: "Dinner, 19:30, harbour" },
				},
			]);
			const seen = await pillAgainst(page, DINNER);
			expect(seen.distance).toBeLessThan(NEAR);
			expect(seen.inPane).toBe(true);
		} finally {
			await scene.cleanup();
		}
	});

	test("the block is panned out of view: the pill does not stay behind at the pane's edge, and is back with the block", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, [
				{
					op: "update_node",
					id: MUSEUM,
					data: { text: "Museum, 14:00 (late)" },
				},
			]);
			await pillAgainst(page, MUSEUM);
			const before = await nodeBox(page, MUSEUM);
			const pane = await page.locator(".svelte-flow__pane").boundingBox();
			if (!pane) throw new Error("no pane");
			// Pan the board with the middle button far enough that the museum is gone.
			await page.mouse.move(pane.x + 200, pane.y + pane.height - 140);
			await page.mouse.down({ button: "middle" });
			await page.mouse.move(pane.x + 200, pane.y + pane.height - 140 - 700, {
				steps: 10,
			});
			await page.mouse.up({ button: "middle" });
			await page.waitForTimeout(600);
			const moved = await nodeBox(page, MUSEUM);
			expect(moved.y + moved.height).toBeLessThan(pane.y);
			await expect(pill(page)).toBeHidden();
			// The review bar still offers the decision.
			await expect(page.getByTestId("canvas-review-bar")).toBeVisible();
			// Pan back: the pill is beside the block again.
			await page.mouse.move(pane.x + 200, pane.y + 140);
			await page.mouse.down({ button: "middle" });
			await page.mouse.move(pane.x + 200, pane.y + 140 + 700, { steps: 10 });
			await page.mouse.up({ button: "middle" });
			await page.waitForTimeout(600);
			const back = await pillAgainst(page, MUSEUM);
			expect(back.distance).toBeLessThan(NEAR);
			expect(Math.abs((await nodeBox(page, MUSEUM)).y - before.y)).toBeLessThan(
				3,
			);
		} finally {
			await scene.cleanup();
		}
	});
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("a note inside a frame: the pill is beside it, inside the pane, and Keep can be pressed", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const scene = await open(page, { panel: false });
		try {
			await askAlfy(page, scene.artifactId, [
				{
					op: "update_node",
					id: LUNCH,
					data: { text: "Lunch at the market, noon" },
				},
			]);
			await openCanvasPanel(page);
			const seen = await pillAgainst(page, LUNCH);
			expect(seen.distance).toBeLessThan(NEAR);
			expect(seen.inPane).toBe(true);
			await pill(page).getByRole("button", { name: /^Keep/ }).click();
			await expect(pill(page)).toContainText(/Kept/);
		} finally {
			await scene.cleanup();
		}
	});
});
