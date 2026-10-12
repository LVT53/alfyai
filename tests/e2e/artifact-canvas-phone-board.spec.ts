import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
	centreOf,
	openCanvasPanel,
	openChatAndReload,
	PHONE,
	testUserId,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// The board on a phone (phase 5, FX-3, RC-A #10 and FB-4's concern 6): the review bar's
// sentence, the library's credit and the selection's pill, each against what stands near
// it at the bottom of a 360 px pane. Hungarian, a finger's taps, the real chat turn that
// changes the board (a fake model that sends an `edit_artifact` call), and the page asked
// only what it shows.

const SHOTS = process.env.FX3_SHOTS ?? null;

function shot(name: string): string {
	if (!SHOTS) throw new Error("no screenshot folder");
	mkdirSync(SHOTS, { recursive: true });
	return join(SHOTS, name);
}

const fakeProvider = createOpenAICompatibleProviderHarness();

function note(id: string, y: number, text: string): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x: 40, y },
		width: 190,
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

/** Six notes down the board, the lowest well under the first screen: a block low on a full board. */
function board(): CanvasBody {
	return {
		version: 1,
		nodes: [
			note("note-1", 40, "9:00 Schönbrunn"),
			note("note-2", 180, "12:30 Naschmarkt"),
			note("note-3", 320, "15:00 Belváros"),
			note("note-4", 460, "17:30 Prater"),
			note("note-5", 600, "19:30 Vacsora"),
			note("note-6", 740, "21:00 Heuriger"),
		],
		edges: [],
		viewport: { x: 16, y: 16, zoom: 1 },
		annotations: [],
	};
}

type Scene = { conversationId: string; cleanup: () => Promise<void> };

/** A board in a chat, a fake model to script Alfy's edit, nothing open yet. */
async function scene(page: Page): Promise<Scene> {
	await login(page);
	const previousPreference = await snapshotUserModelPreference(page);
	const conversationId = await createEmptyConversation(page, "Phone board");
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
	return {
		conversationId,
		cleanup: async () => {
			await updateUserModelPreference(page, previousPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		},
	};
}

async function rectOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("nothing on the screen to measure");
	return {
		left: box.x,
		top: box.y,
		right: box.x + box.width,
		bottom: box.y + box.height,
	};
}

const meet = (
	a: { left: number; top: number; right: number; bottom: number },
	b: { left: number; top: number; right: number; bottom: number },
) =>
	a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test.beforeAll(async () => {
	await fakeProvider.start();
});
test.afterAll(async () => {
	await fakeProvider.stop();
});
test.beforeEach(async () => {
	await fakeProvider.reset();
	await setUiLanguage("hu");
});
test.afterEach(async () => {
	await setUiLanguage("en");
});

test.describe("RC-A #10: the board on a phone", () => {
	test.use({
		hasTouch: true,
		isMobile: true,
		viewport: { width: 360, height: 800 },
	});

	test("the review bar's sentence is one or two lines when Alfy changed one block and removed another", async ({
		page,
	}) => {
		const chat = await scene(page);
		try {
			await sendMessage(
				page,
				`${AI_SMOKE_CANVAS_EDIT_MARKER} ${encodeCanvasEditScenarioPayload({
					artifactId: await firstBoardId(page, chat.conversationId),
					summary: "Tidied",
					ops: [
						{ op: "remove_node", id: "note-6" },
						{
							op: "add_node",
							node: {
								id: "text-new",
								type: "text",
								position: { x: 40, y: 900 },
								data: { kind: "text", text: "Vacsora után: Heuriger" },
							},
						},
					],
				})}`,
			);
			await expect(page.getByText(AI_SMOKE_CANVAS_EDIT_FINAL_TEXT)).toBeVisible(
				{
					timeout: 30_000,
				},
			);
			await openCanvasPanel(page);
			const bar = page.getByTestId("canvas-review-bar");
			await expect(bar).toBeVisible({ timeout: 15_000 });
			const text = bar.locator(".review-bar-text");
			await expect(text).toContainText("Alfy");
			const lines = await text.evaluate((element) => {
				const style = getComputedStyle(element);
				const line = Number.parseFloat(style.lineHeight);
				return Math.round(element.getBoundingClientRect().height / line);
			});
			expect(lines, "lines the sentence takes at 360 px").toBeLessThanOrEqual(
				2,
			);
			if (SHOTS) {
				await page.screenshot({
					path: shot("rc-a-10-phone360-review-bar-hu.png"),
				});
			}
		} finally {
			await chat.cleanup();
		}
	});
});

async function firstBoardId(
	page: Page,
	conversationId: string,
): Promise<string> {
	const response = await page.request.get(
		`/api/conversations/${conversationId}`,
	);
	const detail = (await response.json()) as {
		artifacts?: { id: string; kind: string }[];
	};
	const found = detail.artifacts?.find((item) => item.kind === "canvas");
	if (!found) throw new Error("the board is not in the conversation");
	return found.id;
}

test.describe("FB-4 concern 6 and RC-A #10: the credit and the pill on a phone", () => {
	test.use({ hasTouch: true, isMobile: true, viewport: PHONE });

	async function open(page: Page) {
		const chat = await scene(page);
		await openCanvasPanel(page);
		return chat;
	}

	test("the library's credit is in a corner the toolbar and the zoom control are not in", async ({
		page,
	}) => {
		const chat = await open(page);
		try {
			const credit = page.locator(".svelte-flow__attribution");
			await expect(credit).toBeVisible();
			const creditBox = await rectOf(credit);
			const toolbar = await rectOf(page.getByTestId("canvas-toolbar"));
			expect(meet(creditBox, toolbar), "the credit is under the toolbar").toBe(
				false,
			);
			const zoom = page.locator(".canvas-corner");
			if (await zoom.isVisible()) {
				expect(meet(creditBox, await rectOf(zoom))).toBe(false);
			}
			// It is still the library's credit, with its link.
			await expect(
				credit.getByRole("link", { name: "Svelte Flow" }),
			).toBeVisible();
			if (SHOTS) {
				await page.screenshot({ path: shot("rc-a-10-phone390-credit.png") });
			}
		} finally {
			await chat.cleanup();
		}
	});

	test("a low block's pill is not under the zoom control", async ({ page }) => {
		const chat = await open(page);
		try {
			const at = await centreOf(page, "note-4");
			await page.touchscreen.tap(at.x, at.y);
			const pill = page.getByTestId("canvas-selection-pill");
			await expect(pill).toBeVisible();
			const zoom = page.locator(".canvas-corner");
			if (await zoom.isVisible()) {
				const [pillBox, zoomBox] = [await rectOf(pill), await rectOf(zoom)];
				expect(
					meet(pillBox, zoomBox),
					`the pill (${JSON.stringify(pillBox)}) is under the zoom control (${JSON.stringify(zoomBox)})`,
				).toBe(false);
			}
		} finally {
			await chat.cleanup();
		}
	});
});
