import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../src/lib/server/db";
import { imageJobs } from "../../src/lib/server/db/schema";
import {
	canvasForNewPicture,
	H3_NEW_PICTURE_CANVAS,
	NEW_PICTURE_CANVAS,
	type PictureSize,
} from "../../src/lib/server/services/images/canvas";
import {
	AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT,
	AI_SMOKE_CHANGE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
	AI_SMOKE_TRANSPARENT_PICTURE_MARKER,
	AI_SMOKE_TRANSPARENT_PICTURE_TITLE,
} from "../fixtures/ai/late-picture-scenario";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MAKE_IMAGE_FINAL_TEXT,
	AI_SMOKE_MAKE_IMAGE_MARKER,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	configureFakeNormalChatCapacity,
	createEmptyConversation,
	deleteProvidersWithPrefix,
	login,
	sendMessage,
} from "./helpers";
import {
	comfyRequests,
	type FakeComfyUi,
	type FakePictureServers,
	graphNodeByClass,
	setPictureModel,
	startFakeComfyUiForSpec,
	startPictureServersForSpec,
	stopFakeComfyUiForSpec,
	stopPictureServersForSpec,
	submittedCanvas,
	submittedImageSlots,
	submittedPrompts,
	submittedPromptText,
} from "./images-helpers";

// Making a picture from words, end to end (docs/plans/image-generation, part 2a):
// the fake chat model calls the app's real make_image tool, the real job engine
// sends the work to a fake ComfyUI, and the picture lands on the chat's card and
// in its artifact list. Every wait is on a state (the conversation detail, the
// chat's DOM), never on a pause.
//
// The MiniMax-H3-Image block (docs/plans/minimax-h3-image, Task 5) runs the same
// app against TWO fakes, one per picture server: `COMFYUI_URL` is the Qwen 0.43
// stand-in and `COMFYUI_H3_URL` the H3 0.44 one, exactly as the live pair is
// wired. Which fake received a prompt, what graph it carried and whether the
// other service was freed before it are the assertions; no real GPU is involved.

const fakeProvider = createOpenAICompatibleProviderHarness();
const PROVIDER_PREFIX = "images_e2e_";

const CARD =
	'[data-testid="message-deliverables"] [data-testid="artifact-card"]';
const LOADED = `${CARD} [data-testid="image-card-stage"] [data-testid="image-picture-after"].is-loaded`;

const FOUR_MEGAPIXEL = { width: 2496, height: 1664 };
const ONE_MEGAPIXEL = { width: 1248, height: 832 };

type ImageCardJson = {
	artifactId: string | null;
	pickedTakeId: string | null;
	takes: Array<{
		id: string;
		status: string;
		fileId: string | null;
		width: number;
		height: number;
	}>;
};
type DetailJson = {
	imageCards: ImageCardJson[];
	artifacts: Array<{ kind: string }>;
};

type StoredTakeRequest = {
	model: string;
	mode: string;
	canvas: { width: number; height: number };
	transparent: boolean;
	marks: Array<{ letter: string }> | null;
	inputs: Array<{ role?: string }>;
};

async function createTemporaryModel(page: Page): Promise<string> {
	const unique = randomUUID().slice(0, 8);
	const createdProvider = await page.request.post("/api/admin/providers", {
		data: {
			name: `${PROVIDER_PREFIX}${unique}`,
			displayName: `Images E2E ${unique}`,
			baseUrl: fakeProvider.baseURL,
			apiKey: AI_SMOKE_API_KEY,
		},
	});
	expect(
		createdProvider.ok(),
		`provider create -> ${createdProvider.status()}`,
	).toBe(true);
	const { provider } = (await createdProvider.json()) as {
		provider: { id: string };
	};
	const createdModels = await page.request.post(
		`/api/admin/providers/${provider.id}/models/batch`,
		{
			data: {
				models: [
					{
						name: AI_SMOKE_MODEL_ID,
						displayName: `Images E2E Model ${unique}`,
						contextLength: 131_072,
						supportsChat: true,
						supportsTools: true,
					},
				],
			},
		},
	);
	expect(createdModels.ok(), `model create -> ${createdModels.status()}`).toBe(
		true,
	);
	const { models } = (await createdModels.json()) as {
		models: Array<{ id: string }>;
	};
	await configureFakeNormalChatCapacity(
		page,
		`provider:${provider.id}:${models[0].id}`,
	);
	return `provider:${provider.id}:${models[0].id}`;
}

async function writeModelPreference(
	page: Page,
	preferredModel: string | null,
): Promise<void> {
	const response = await page.request.patch("/api/settings/preferences", {
		data: { preferredModel },
	});
	expect(response.ok(), `preference write -> ${response.status()}`).toBe(true);
}

async function readDetail(page: Page, conversationId: string) {
	const response = await page.request.get(
		`/api/conversations/${conversationId}`,
	);
	expect(response.ok(), `detail read -> ${response.status()}`).toBe(true);
	return (await response.json()) as DetailJson;
}

async function openChat(page: Page): Promise<string> {
	const conversationId = await createEmptyConversation(page);
	await page.goto(`/chat/${conversationId}`, {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("message-input")).toBeVisible();
	return conversationId;
}

/** Sends the late-picture turn and waits until the picture is on the card and the reply is whole. */
async function makePicture(
	page: Page,
	marker = AI_SMOKE_LATE_PICTURE_MARKER,
): Promise<void> {
	await sendMessage(page, marker);
	await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
	await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
		timeout: 30_000,
	});
}

/**
 * Waits for card `index` (0-based) to hold `takes` settled takes, its pick and
 * its Image item (a picture's change makes a NEW card for the same Image, so a
 * spec that changes one names the second card).
 */
async function waitForSettledCardAt(
	page: Page,
	conversationId: string,
	index: number,
	takes: number,
): Promise<ImageCardJson> {
	await expect
		.poll(
			async () => {
				const card = (await readDetail(page, conversationId)).imageCards[index];
				const settled =
					card?.takes.length === takes &&
					card.takes.every((entry) => entry.status === "succeeded") &&
					card.pickedTakeId !== null &&
					card.artifactId !== null;
				return settled ? "settled" : JSON.stringify(card ?? null);
			},
			{
				message: `card ${index} holds ${takes} settled take(s)`,
				timeout: 30_000,
			},
		)
		.toBe("settled");
	return (await readDetail(page, conversationId)).imageCards[index];
}

/** The first card, settled (the shape most tests use). */
async function waitForSettledCard(
	page: Page,
	conversationId: string,
	takes: number,
): Promise<ImageCardJson> {
	return waitForSettledCardAt(page, conversationId, 0, takes);
}

/** The take rows of a conversation, oldest first, with their stored requests. */
async function storedTakes(
	conversationId: string,
): Promise<Array<{ request: StoredTakeRequest; requestJson: string }>> {
	const rows = await db
		.select()
		.from(imageJobs)
		.where(eq(imageJobs.conversationId, conversationId))
		.orderBy(desc(imageJobs.createdAt));
	return rows
		.map((row) => ({
			request: JSON.parse(row.requestJson) as StoredTakeRequest,
			requestJson: row.requestJson,
		}))
		.reverse();
}

/** A stored PNG's real pixel size, as the app serves it. */
async function fileSize(
	page: Page,
	fileId: string,
	conversationId: string,
): Promise<{ width: number; height: number; channels: number }> {
	const response = await page.request.get(
		`/api/images/files/${fileId}?conversationId=${conversationId}`,
	);
	expect(response.status(), "the picture file is served").toBe(200);
	const meta = await sharp(await response.body()).metadata();
	return {
		width: meta.width ?? 0,
		height: meta.height ?? 0,
		channels: meta.channels ?? 0,
	};
}

/** The card's More → Download file, read with sharp before the download goes away. */
async function downloadSize(
	page: Page,
	card: Locator,
): Promise<{ width: number; height: number }> {
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "More" }).click();
	await page.getByTestId("image-card-download").click();
	const download = await downloading;
	const path = await download.path();
	expect(path, "the download has a file").toBeTruthy();
	const meta = await sharp(readFileSync(path as string)).metadata();
	return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** Opens the card's panel and its History, and checks the version is the picture served. */
async function expectHistoryHolds(page: Page, fileId: string): Promise<void> {
	await page.locator(CARD).last().getByTestId("artifact-card-head").click();
	await expect(
		page
			.locator(
				'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded',
			)
			.first(),
	).toBeVisible({ timeout: 20_000 });
	await page
		.locator('[data-testid="artifact-history-button"]:visible')
		.first()
		.click();
	const history = page.getByTestId("artifact-history");
	await expect(history).toBeVisible();
	const options = history.getByTestId("history-option");
	await expect(options.first()).toContainText("Alfy made the picture");
	await options.first().click();
	const preview = history.getByTestId("image-version-preview");
	await expect(preview).toHaveAttribute("data-status", "ready");
	await expect(preview.locator("img").first()).toHaveAttribute(
		"src",
		new RegExp(fileId),
	);
}

/** A mouse drag across the open picture, from one fraction of its frame to another. */
async function dragBox(
	page: Page,
	from: [number, number],
	to: [number, number],
): Promise<void> {
	const box = await page.getByTestId("image-body-frame").boundingBox();
	if (!box) throw new Error("no picture frame on screen");
	const at = ([fx, fy]: [number, number]) => ({
		x: box.x + box.width * fx,
		y: box.y + box.height * fy,
	});
	const start = at(from);
	const end = at(to);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	for (let step = 1; step <= 12; step++) {
		await page.mouse.move(
			start.x + ((end.x - start.x) * step) / 12,
			start.y + ((end.y - start.y) * step) / 12,
		);
		await page.evaluate(
			() => new Promise<void>((done) => requestAnimationFrame(() => done())),
		);
	}
	await page.mouse.up();
}

function area(size: { width: number; height: number }): number {
	return size.width * size.height;
}

test.describe("Making a picture from words", () => {
	let fake: FakeComfyUi | null = null;
	let previousModelPreference: string | null = null;
	let conversationId: string | null = null;

	test.beforeAll(async () => {
		await fakeProvider.start();
	});

	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async ({ page }) => {
		await fakeProvider.reset();
		await login(page);
		const settings = await page.request.get("/api/settings");
		expect(settings.ok(), `settings read -> ${settings.status()}`).toBe(true);
		const { preferences } = (await settings.json()) as {
			preferences?: { preferredModel?: string | null };
		};
		previousModelPreference = preferences?.preferredModel ?? null;
		fake = await startFakeComfyUiForSpec(page);
	});

	test.afterEach(async ({ page }) => {
		await writeModelPreference(page, previousModelPreference);
		if (conversationId) {
			await page.request.delete(`/api/conversations/${conversationId}`);
			conversationId = null;
		}
		await deleteProvidersWithPrefix(page, PROVIDER_PREFIX);
		if (fake) await stopFakeComfyUiForSpec(page, fake);
		fake = null;
	});

	test("a picture made from words lands as an Image", {
		tag: "@smoke",
	}, async ({ page }) => {
		const comfy = fake as FakeComfyUi;
		await writeModelPreference(page, await createTemporaryModel(page));

		// The conversation exists before the turn, so no first-send race.
		const created = await page.request.post("/api/conversations", { data: {} });
		expect(created.ok(), `conversation create -> ${created.status()}`).toBe(
			true,
		);
		const body = (await created.json()) as {
			conversation?: { id: string };
			id?: string;
		};
		conversationId = body.conversation?.id ?? body.id ?? null;
		expect(conversationId, "the conversation has an id").toBeTruthy();

		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await sendMessage(page, `${AI_SMOKE_MAKE_IMAGE_MARKER} ${randomUUID()}`);

		await expect(page.getByTestId("assistant-message").last()).toContainText(
			AI_SMOKE_MAKE_IMAGE_FINAL_TEXT,
			{ timeout: 45_000 },
		);

		// The card has one succeeded take, it is the pick, and the chat's artifact
		// list has the Image: the take landing, the pick and the item are three
		// writes, so the wait is on all of them, not on the take alone.
		const settledCard = await waitForSettledCard(
			page,
			conversationId as string,
			1,
		);
		const detail = await readDetail(page, conversationId as string);
		expect(detail.imageCards).toHaveLength(1);
		const [take] = detail.imageCards[0].takes;
		expect(detail.imageCards[0].pickedTakeId).toBe(take.id);
		expect(take.fileId, "the take has a picture").toBeTruthy();

		// The chat's artifact list has one Image.
		expect(
			detail.artifacts.filter((entry) => entry.kind === "image"),
		).toHaveLength(1);

		// Qwen regression: the Qwen fake got the Qwen 1 MP graph at 30 steps, on
		// `COMFYUI_URL`, and nothing was widened to a print canvas.
		const prompt = submittedPrompts(comfy)[0];
		expect(prompt, "the picture server was asked once").toBeTruthy();
		expect(
			graphNodeByClass(prompt.graph, "TextEncodeQwenImage21"),
			"the Qwen text encoder is in the graph",
		).toBeTruthy();
		const sampler = graphNodeByClass(prompt.graph, "KSampler");
		expect(sampler?.inputs?.steps, "Qwen's 30 steps").toBe(30);
		expect(submittedCanvas(prompt.graph)).toEqual(ONE_MEGAPIXEL);
		expect(submittedPromptText(prompt.graph)).not.toContain(
			"This is an RGBA format image with transparency.",
		);

		// The picture itself is a 1 MP PNG.
		const size = await fileSize(
			page,
			take.fileId as string,
			conversationId as string,
		);
		expect({ width: size.width, height: size.height }).toEqual(ONE_MEGAPIXEL);
		expect(area(size)).toBeLessThan(4 * 1024 * 1024);

		// The picture server was asked once.
		expect(comfyRequests(comfy, "POST", "/prompt")).toHaveLength(1);
		expect(settledCard.artifactId).toBeTruthy();
	});
});

const SIZES: PictureSize[] = [
	"landscape",
	"portrait",
	"square",
	"wide",
	"tall",
];

test.describe("MiniMax-H3-Image at 4 MP", () => {
	let servers: FakePictureServers | null = null;
	let previousModelPreference: string | null = null;
	let conversationId: string | null = null;

	test.beforeAll(async () => {
		await fakeProvider.start();
	});

	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async ({ page }) => {
		await fakeProvider.reset();
		await login(page);
		const settings = await page.request.get("/api/settings");
		expect(settings.ok(), `settings read -> ${settings.status()}`).toBe(true);
		const { preferences } = (await settings.json()) as {
			preferences?: { preferredModel?: string | null };
		};
		previousModelPreference = preferences?.preferredModel ?? null;
		await writeModelPreference(page, await createTemporaryModel(page));
		servers = await startPictureServersForSpec(page, "h3");
	});

	test.afterEach(async ({ page }) => {
		// A held request or queue must not keep the closing fakes waiting.
		servers?.qwen.holdRequests("/free", false);
		servers?.h3.holdRequests("/free", false);
		servers?.h3.holdQueue(false);
		await writeModelPreference(page, previousModelPreference);
		if (conversationId) {
			await page.request.delete(`/api/conversations/${conversationId}`);
			conversationId = null;
		}
		await deleteProvidersWithPrefix(page, PROVIDER_PREFIX);
		await stopPictureServersForSpec(page, servers);
		servers = null;
	});

	test("makes a 4 MP picture on H3's server, on the card, in History and on Download", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		conversationId = await openChat(page);
		await makePicture(page);
		const card = await waitForSettledCard(page, conversationId, 1);

		// The H3 server received the only prompt; the Qwen server received none.
		const prompts = submittedPrompts(h3);
		expect(prompts).toHaveLength(1);
		expect(submittedPrompts(qwen)).toHaveLength(0);
		const [prompt] = prompts;
		expect(
			graphNodeByClass(prompt.graph, "MiniMaxH3ImageConditioning"),
			"H3's conditioning node",
		).toBeTruthy();
		expect(graphNodeByClass(prompt.graph, "TextEncodeQwenImage21")).toBeFalsy();
		expect(
			graphNodeByClass(prompt.graph, "KSampler")?.inputs?.steps,
			"H3's 6 steps",
		).toBe(6);
		expect(submittedCanvas(prompt.graph)).toEqual(FOUR_MEGAPIXEL);

		// No 8/16 MP: the requested canvas is the 4 MP one, not a doubled print.
		expect(area(submittedCanvas(prompt.graph))).toBeLessThan(8 * 1024 * 1024);

		// The card's take is told the real 4 MP size (the card draws a thumbnail
		// of it; the file itself is checked below).
		expect({
			width: card.takes[0].width,
			height: card.takes[0].height,
		}).toEqual(FOUR_MEGAPIXEL);

		// The served file, its History version and its Download are that same 4 MP PNG.
		const fileId = card.takes[0].fileId as string;
		expect(await fileSize(page, fileId, conversationId)).toMatchObject({
			...FOUR_MEGAPIXEL,
		});
		expect(await downloadSize(page, page.locator(CARD).last())).toEqual(
			FOUR_MEGAPIXEL,
		);
		await expectHistoryHolds(page, fileId);

		// The stored take is H3's, at the 4 MP canvas and 6 steps, transparent false.
		const [stored] = await storedTakes(conversationId);
		expect(stored.request.model).toBe("h3");
		expect(stored.request.canvas).toEqual(FOUR_MEGAPIXEL);
		expect(stored.request.transparent).toBe(false);

		// The cross-model free runs on the selected model's OTHER service, never
		// on the selected one, and before its prompt.
		expect(comfyRequests(qwen, "POST", "/free").length).toBeGreaterThanOrEqual(
			1,
		);
		expect(comfyRequests(h3, "POST", "/free")).toHaveLength(0);
	});

	test("a change uses H3's edit graph, ten slots and <Picture 1>, at 4 MP", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		conversationId = await openChat(page);
		await makePicture(page);
		const first = await waitForSettledCard(page, conversationId, 1);

		await sendMessage(
			page,
			`${AI_SMOKE_CHANGE_PICTURE_MARKER} ${first.artifactId}`,
		);
		await expect(
			page.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
		).toBeVisible({ timeout: 45_000 });
		const card = await waitForSettledCardAt(page, conversationId, 1, 1);

		const prompts = submittedPrompts(h3);
		expect(prompts).toHaveLength(2);
		expect(submittedPrompts(qwen)).toHaveLength(0);
		const edit = prompts[1];
		expect(
			graphNodeByClass(edit.graph, "MiniMaxH3ImageConditioning"),
		).toBeTruthy();
		expect(graphNodeByClass(edit.graph, "KSampler")?.inputs?.steps).toBe(6);
		expect(submittedCanvas(edit.graph)).toEqual(FOUR_MEGAPIXEL);
		// The edit graph keeps the same ten slots; only the base one is wired.
		expect(submittedImageSlots(edit.graph)).toHaveLength(1);
		expect(submittedPromptText(edit.graph)).toMatch(/^<Picture 1> /);
		expect(area(submittedCanvas(edit.graph))).toBeLessThan(8 * 1024 * 1024);

		const stored = await storedTakes(conversationId);
		expect(stored).toHaveLength(2);
		expect(stored[1].request).toMatchObject({
			model: "h3",
			mode: "edit",
			canvas: FOUR_MEGAPIXEL,
			marks: null,
		});
		expect(stored[1].request.inputs[0]?.role).not.toBe("marked");

		const latest = card.takes[0].fileId as string;
		expect(await fileSize(page, latest, conversationId)).toMatchObject({
			...FOUR_MEGAPIXEL,
		});
	});

	test("a boxed change carries its marks into an H3 take that still lands at 4 MP", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		conversationId = await openChat(page);
		await makePicture(page);
		const first = await waitForSettledCard(page, conversationId, 1);

		// Draw one box over the fake render's change area (the middle 20%).
		await page.locator(CARD).last().getByTestId("artifact-card-head").click();
		await expect(
			page
				.locator(
					'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded',
				)
				.first(),
		).toBeVisible({ timeout: 20_000 });
		await page.getByTestId("image-body-mark").click();
		await dragBox(page, [0.3, 0.3], [0.7, 0.7]);
		await expect(page.getByTestId("mark-box")).toHaveCount(1);
		await expect(page.getByTestId("composer-chip-marks")).toContainText(
			"Marks A",
		);

		await sendMessage(
			page,
			`${AI_SMOKE_CHANGE_PICTURE_MARKER} ${first.artifactId}`,
		);
		await expect(
			page.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
		).toBeVisible({ timeout: 45_000 });
		const card = await waitForSettledCardAt(page, conversationId, 1, 1);

		const prompts = submittedPrompts(h3);
		expect(prompts).toHaveLength(2);
		expect(submittedPrompts(qwen)).toHaveLength(0);
		expect(submittedCanvas(prompts[1].graph)).toEqual(FOUR_MEGAPIXEL);
		expect(submittedPromptText(prompts[1].graph)).toMatch(/^<Picture 1> /);

		// The boxed take really carried the person's marks; the model is sent the
		// clean base, so the marks live on the request, not in its picture slots.
		const stored = await storedTakes(conversationId);
		expect(stored[1].request.marks).toHaveLength(1);
		expect(stored[1].request.marks?.[0]?.letter).toBe("A");
		// The guard accepted it, so the take succeeded.
		expect(card.takes[0].status).toBe("succeeded");
		expect(
			await fileSize(page, card.takes[0].fileId as string, conversationId),
		).toMatchObject({ ...FOUR_MEGAPIXEL });
	});

	test("H3 print stays 4 MP, every H3 size is 4 MP, and Qwen keeps 1 MP / 4 MP print", () => {
		// The app's own canvases: H3 ignores print and never reaches 8 or 16 MP;
		// Qwen keeps today's 1 MP generate and 4 MP print exactly.
		for (const size of SIZES) {
			const plain = canvasForNewPicture(size, false, "h3");
			const printed = canvasForNewPicture(size, true, "h3");
			expect(printed, `H3 ${size} print is a no-op`).toEqual(plain);
			expect(plain).toEqual(H3_NEW_PICTURE_CANVAS[size]);
			expect(area(plain)).toBeGreaterThan(4 * 1024 * 1024 - 100_000);
			expect(area(plain), `H3 ${size} stays under 8 MP`).toBeLessThan(
				8 * 1024 * 1024,
			);
		}
		for (const size of SIZES) {
			const plain = canvasForNewPicture(size, false, "qwen");
			const printed = canvasForNewPicture(size, true, "qwen");
			expect(plain).toEqual(NEW_PICTURE_CANVAS[size]);
			expect(printed).toEqual({
				width: NEW_PICTURE_CANVAS[size].width * 2,
				height: NEW_PICTURE_CANVAS[size].height * 2,
			});
			expect(area(printed), `Qwen ${size} print is 4 MP`).toBeLessThan(
				8 * 1024 * 1024,
			);
		}
		// The landscape pair the specs above use, named once.
		expect(canvasForNewPicture("landscape", true, "h3")).toEqual(
			FOUR_MEGAPIXEL,
		);
		expect(canvasForNewPicture("landscape", true, "qwen")).toEqual(
			FOUR_MEGAPIXEL,
		);
	});

	test("an H3 take frees the Qwen server before it submits, and never frees its own", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		conversationId = await openChat(page);
		// Park the cross-model free: the H3 prompt must not appear until it runs.
		qwen.holdRequests("/free", true);
		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		await expect
			.poll(() => comfyRequests(qwen, "POST", "/free").length, {
				message: "the Qwen server is asked to free its models",
				timeout: 30_000,
			})
			.toBe(1);
		expect(comfyRequests(h3, "POST", "/prompt")).toHaveLength(0);
		qwen.holdRequests("/free", false);
		await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
		await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
			timeout: 30_000,
		});
		await waitForSettledCard(page, conversationId, 1);

		expect(comfyRequests(h3, "POST", "/prompt")).toHaveLength(1);
		expect(comfyRequests(h3, "POST", "/free")).toHaveLength(0);
		expect(comfyRequests(qwen, "POST", "/free")).toHaveLength(1);
		expect(comfyRequests(qwen, "POST", "/prompt")).toHaveLength(0);
	});

	test("a Qwen take frees the H3 server before it submits, and never frees its own", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		await setPictureModel(page, "qwen");
		conversationId = await openChat(page);
		h3.holdRequests("/free", true);
		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		await expect
			.poll(() => comfyRequests(h3, "POST", "/free").length, {
				message: "the H3 server is asked to free its models",
				timeout: 30_000,
			})
			.toBe(1);
		expect(comfyRequests(qwen, "POST", "/prompt")).toHaveLength(0);
		h3.holdRequests("/free", false);
		await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
		await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
			timeout: 30_000,
		});
		await waitForSettledCard(page, conversationId, 1);

		expect(comfyRequests(qwen, "POST", "/prompt")).toHaveLength(1);
		expect(comfyRequests(qwen, "POST", "/free")).toHaveLength(0);
		expect(comfyRequests(h3, "POST", "/free")).toHaveLength(1);
		expect(comfyRequests(h3, "POST", "/prompt")).toHaveLength(0);
	});

	test("a take queued under H3 stops on H3's server after the switch to Qwen", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		conversationId = await openChat(page);
		h3.holdQueue(true);
		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		await expect
			.poll(() => submittedPrompts(h3).length, {
				message: "the H3 take reached H3's queue",
				timeout: 30_000,
			})
			.toBe(1);
		const stop = page.locator(CARD).last().getByTestId("image-card-stop");
		await expect(stop).toBeVisible({ timeout: 30_000 });

		// The Admin switch is live, but the queued take keeps H3's server.
		await setPictureModel(page, "qwen");
		await stop.click();
		await expect
			.poll(
				() =>
					comfyRequests(h3, "POST", "/queue").filter((request) => {
						const json = request.json as { delete?: unknown } | undefined;
						return Array.isArray(json?.delete) && json.delete.length > 0;
					}).length,
				{ message: "H3's queue is asked to delete the take", timeout: 20_000 },
			)
			.toBeGreaterThanOrEqual(1);
		h3.holdQueue(false);

		// Nothing on the new model's server was cancelled or asked to make one.
		expect(comfyRequests(qwen, "POST", "/interrupt")).toHaveLength(0);
		expect(comfyRequests(qwen, "POST", "/queue")).toHaveLength(0);
		expect(submittedPrompts(qwen)).toHaveLength(0);
		const [stored] = await storedTakes(conversationId);
		expect(stored.request.model).toBe("h3");
	});

	test("Another on an H3 card keeps H3 while Qwen is selected, and the reverse", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		conversationId = await openChat(page);
		await makePicture(page);
		await waitForSettledCard(page, conversationId, 1);
		expect(submittedPrompts(h3)).toHaveLength(1);

		// H3 card, Admin switched to Qwen: Another still goes to H3's server.
		await setPictureModel(page, "qwen");
		await page.locator(CARD).last().getByTestId("image-card-another").click();
		await expect
			.poll(() => submittedPrompts(h3).length, {
				message: "the H3 card's Another uses H3's server",
				timeout: 30_000,
			})
			.toBe(2);
		await waitForSettledCard(page, conversationId, 2);
		expect(submittedPrompts(qwen)).toHaveLength(0);

		// A Qwen card made now, while Qwen is selected.
		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
		await expect.poll(() => submittedPrompts(qwen).length).toBe(1);
		await expect
			.poll(async () => {
				const detail = await readDetail(page, conversationId as string);
				return detail.imageCards.length;
			})
			.toBe(2);
		const qwenCard = await waitForSettledCardAt(page, conversationId, 1, 1);

		// Qwen card, Admin switched back to H3: Another still goes to Qwen's server.
		await setPictureModel(page, "h3");
		await page.locator(CARD).last().getByTestId("image-card-another").click();
		await expect
			.poll(() => submittedPrompts(qwen).length, {
				message: "the Qwen card's Another uses Qwen's server",
				timeout: 30_000,
			})
			.toBe(2);
		await waitForSettledCardAt(page, conversationId, 1, 2);
		expect(submittedPrompts(h3)).toHaveLength(2);
		expect(qwenCard.artifactId).toBeTruthy();
	});

	test("H3 refuses transparent before a card or take; Qwen makes it after the switch", async ({
		page,
	}) => {
		const { qwen, h3 } = servers as FakePictureServers;
		conversationId = await openChat(page);
		await sendMessage(page, AI_SMOKE_TRANSPARENT_PICTURE_MARKER);

		// The person sees "Picture not made" and why, and no card exists.
		const row = page
			.getByTestId("tool-activity-row")
			.filter({ hasText: "Picture not made" });
		await expect(row).toBeVisible({ timeout: 45_000 });
		await row.click();
		await expect(page.getByTestId("tool-activity-error")).toContainText(
			"H3 cannot make transparent pictures. Switch the Admin “Picture model” to Qwen.",
		);
		await expect(page.locator(CARD)).toHaveCount(0);
		const refused = await readDetail(page, conversationId);
		expect(refused.imageCards).toHaveLength(0);
		expect(
			refused.artifacts.filter((entry) => entry.kind === "image"),
		).toHaveLength(0);
		const takesAfterRefusal = await storedTakes(conversationId);
		expect(takesAfterRefusal, "no take was queued").toHaveLength(0);
		expect(submittedPrompts(h3)).toHaveLength(0);
		expect(submittedPrompts(qwen)).toHaveLength(0);

		// Qwen is the fallback the person is told to switch to.
		await setPictureModel(page, "qwen");
		await sendMessage(page, AI_SMOKE_TRANSPARENT_PICTURE_MARKER);
		await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
		const card = await waitForSettledCard(page, conversationId, 1);
		expect(submittedPrompts(qwen)).toHaveLength(1);
		expect(submittedPrompts(h3)).toHaveLength(0);
		const transparent = submittedPrompts(qwen)[0];
		expect(
			graphNodeByClass(transparent.graph, "TextEncodeQwenImage21"),
		).toBeTruthy();
		expect(submittedCanvas(transparent.graph)).toEqual(ONE_MEGAPIXEL);
		expect(submittedPromptText(transparent.graph)).toContain(
			"This is an RGBA format image with transparency.",
		);
		const size = await fileSize(
			page,
			card.takes[0].fileId as string,
			conversationId,
		);
		expect(size.channels, "Qwen's transparent PNG keeps its alpha").toBe(4);
		await expect(
			page.locator(CARD).last().getByTestId("image-picture"),
		).toHaveClass(/image-checkerboard/);
		await expect(page.locator(CARD).last()).toContainText(
			AI_SMOKE_TRANSPARENT_PICTURE_TITLE,
		);
	});
});
