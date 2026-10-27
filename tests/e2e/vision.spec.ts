import { randomInt, randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../src/lib/server/db";
import { imageDescriptions } from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_PLAIN_TEXT,
	AI_SMOKE_STREAM_TEXT,
} from "../fixtures/ai/openai-compatible-scenarios";
import {
	type CapturedOpenAICompatibleRequest,
	createOpenAICompatibleProviderHarness,
} from "../mocks/ai-provider/openai-compatible-provider";
import {
	deleteProvidersWithPrefix,
	login,
	openConversationComposer,
	sendMessage,
	waitForHydration,
} from "./helpers";

// Alfy can see (docs/plans/image-generation, part 1), end to end: a model the
// admin marks "Can see images" is sent the pictures people attach, and the
// turns after it carry a few words about each picture instead of its pixels.
//
// The model is the fake OpenAI-compatible provider, whose `requests()` hold
// every body the app sent it: that is the only place the pixels can be seen.
// Pictures go in through the composer's real upload routes. The e2e build has
// no document service (MinerU), so a picture's text is never read: its job
// waits for a backend that is not there, which is exactly the state a seeing
// model must not be held up by. The fake model's default reply is what the
// background description call gets back, so that reply is the description.

const fakeProvider = createOpenAICompatibleProviderHarness();

const PROVIDER_PREFIX = "vision_e2e_";
const PICTURE_WIDTH = 64;
const PICTURE_HEIGHT = 48;
/** JPEG at quality 85 on a flat colour lands within a few steps of it. */
const COLOUR_TOLERANCE = 8;

type TemporaryModel = {
	providerId: string;
	modelId: string;
	displayName: string;
	selectedModel: string;
};

type Picture = {
	name: string;
	buffer: Buffer;
	colour: { r: number; g: number; b: number };
};

type ChatPart = { type: string; text?: string; image_url?: { url: string } };
type ChatMessage = { role: string; content: string | ChatPart[] };

// --- the temporary model -----------------------------------------------------

/** A provider and a model on the fake provider, made the way the admin API makes them. */
async function createTemporaryModel(page: Page): Promise<TemporaryModel> {
	const unique = randomUUID().slice(0, 8);
	const createdProvider = await page.request.post("/api/admin/providers", {
		data: {
			name: `${PROVIDER_PREFIX}${unique}`,
			displayName: `Vision E2E ${unique}`,
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

	const displayName = `Vision E2E Model ${unique}`;
	const createdModels = await page.request.post(
		`/api/admin/providers/${provider.id}/models/batch`,
		{
			data: {
				models: [
					{
						name: AI_SMOKE_MODEL_ID,
						displayName,
						contextLength: 8192,
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
	return {
		providerId: provider.id,
		modelId: models[0].id,
		displayName,
		selectedModel: `provider:${provider.id}:${models[0].id}`,
	};
}

async function readModelPreference(page: Page): Promise<string | null> {
	const response = await page.request.get("/api/settings");
	expect(response.ok(), `settings read -> ${response.status()}`).toBe(true);
	const { preferences } = (await response.json()) as {
		preferences?: { preferredModel?: string | null };
	};
	return preferences?.preferredModel ?? null;
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

/** Whether the model list the composer reads says this model can see images. */
async function listedAsSeeing(
	page: Page,
	model: TemporaryModel,
): Promise<boolean> {
	const response = await page.request.get("/api/models");
	expect(response.ok(), `model list -> ${response.status()}`).toBe(true);
	const { providers } = (await response.json()) as {
		providers: Array<{
			models: Array<{ id: string; supportsImages: boolean }>;
		}>;
	};
	const listed = providers
		.flatMap((entry) => entry.models)
		.find((entry) => entry.id === model.selectedModel);
	expect(listed, "the temporary model is in the model list").toBeDefined();
	return listed?.supportsImages === true;
}

// --- the admin's model form --------------------------------------------------

/**
 * The model's edit form on the admin Models page. It goes to /settings anew, so
 * a form opened after a save is read from a freshly loaded page, not from
 * whatever the page held before.
 */
async function openModelForm(
	page: Page,
	model: TemporaryModel,
): Promise<Locator> {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	await page.getByRole("tab", { name: "Administration" }).click();
	await expect(page.getByTestId("admin-system-screen")).toBeVisible();
	await page.getByTestId("system-nav-models").click();
	await page.getByTestId(`provider-models-${model.providerId}`).click();
	await page.getByRole("button", { name: `Edit ${model.displayName}` }).click();
	const form = page.getByRole("dialog", { name: "Edit Model" });
	await expect(form).toBeVisible();
	return form;
}

function canSeeImagesBox(form: Locator): Locator {
	return form.getByRole("checkbox", { name: "Can see images" });
}

/** Presses Save and returns once the server has the change and the form has closed. */
async function saveModelForm(
	page: Page,
	form: Locator,
	model: TemporaryModel,
): Promise<void> {
	const saved = page.waitForResponse(
		(response) =>
			response.request().method() === "PUT" &&
			response
				.url()
				.endsWith(
					`/api/admin/providers/${model.providerId}/models/${model.modelId}`,
				),
	);
	await form.getByRole("button", { name: "Save Changes" }).click();
	const response = await saved;
	expect(response.ok(), `model save -> ${response.status()}`).toBe(true);
	await expect(form).toBeHidden();
}

/** Ticks or unticks "Can see images" the way the admin does, and saves. */
async function setCanSeeImages(
	page: Page,
	model: TemporaryModel,
	canSee: boolean,
): Promise<void> {
	const form = await openModelForm(page, model);
	await canSeeImagesBox(form).setChecked(canSee);
	await saveModelForm(page, form, model);
}

// --- the picture -------------------------------------------------------------

/**
 * A small PNG of one flat colour, so it has no text in it. The colour is random
 * and so are the bytes: uploads are deduplicated per person by content, and no
 * other spec's picture may be this one.
 */
async function makePicture(): Promise<Picture> {
	const colour = {
		r: randomInt(40, 216),
		g: randomInt(40, 216),
		b: randomInt(40, 216),
	};
	const buffer = await sharp({
		create: {
			width: PICTURE_WIDTH,
			height: PICTURE_HEIGHT,
			channels: 3,
			background: colour,
		},
	})
		.png()
		.toBuffer();
	return { name: `vision-${randomUUID().slice(0, 8)}.png`, buffer, colour };
}

/**
 * Picks the file in the composer, which uploads it through the real routes, and
 * returns the id of the library item they made once its chip is up.
 */
async function attachPicture(page: Page, picture: Picture): Promise<string> {
	const fileInput = page.locator('input[type="file"]').first();
	// The composer is rendered on the server with its input disabled until it
	// hydrates; a disabled input takes no files.
	await expect(fileInput).toBeEnabled({ timeout: 20_000 });
	const uploaded = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith("/api/knowledge/upload/raw"),
	);
	await fileInput.setInputFiles({
		name: picture.name,
		mimeType: "image/png",
		buffer: picture.buffer,
	});
	const response = await uploaded;
	expect(response.ok(), `upload -> ${response.status()}`).toBe(true);
	const { artifact } = (await response.json()) as { artifact: { id: string } };
	// The placeholder that stands in for the bytes on their way has given way to
	// the picture's own chip.
	await expect(page.getByTestId("composer-chip-upload")).toHaveCount(0);
	await expect(page.getByTestId("composer-chip-attachment")).toBeVisible();
	return artifact.id;
}

/** The state of the reading of the picture's text, as the server tells the composer. */
async function textReadingStatus(
	page: Page,
	artifactId: string,
): Promise<string | undefined> {
	const response = await page.request.get(
		`/api/knowledge/extraction?artifactIds=${artifactId}`,
	);
	expect(response.ok(), `extraction read -> ${response.status()}`).toBe(true);
	const { jobs } = (await response.json()) as {
		jobs: Array<{ sourceArtifactId: string; status: string }>;
	};
	return jobs.find((job) => job.sourceArtifactId === artifactId)?.status;
}

async function storedDescription(
	artifactId: string,
): Promise<string | undefined> {
	const [row] = await db
		.select({ description: imageDescriptions.description })
		.from(imageDescriptions)
		.where(eq(imageDescriptions.artifactId, artifactId));
	return row?.description;
}

// --- what the fake model was sent --------------------------------------------

function bodyOf(request: CapturedOpenAICompatibleRequest): {
	stream?: boolean;
	messages?: ChatMessage[];
} {
	return (request.body ?? {}) as { stream?: boolean; messages?: ChatMessage[] };
}

function isStreamed(request: CapturedOpenAICompatibleRequest): boolean {
	return bodyOf(request).stream === true;
}

function userMessagesOf(
	request: CapturedOpenAICompatibleRequest,
): ChatMessage[] {
	return (bodyOf(request).messages ?? []).filter(
		(message) => message.role === "user",
	);
}

function partsOf(message: ChatMessage | undefined): ChatPart[] {
	return Array.isArray(message?.content) ? message.content : [];
}

function textOf(message: ChatMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => part.text ?? "").join("\n");
}

function chatCompletions(): CapturedOpenAICompatibleRequest[] {
	return fakeProvider
		.requests()
		.filter((request) => request.path === "/v1/chat/completions");
}

/**
 * The streamed chat request of the turn whose message is `text`, found by the
 * text itself (it is unique to this run). The first such request: a later
 * turn's history repeats an earlier message, and arrives after it.
 */
function findTurnRequest(
	text: string,
): CapturedOpenAICompatibleRequest | undefined {
	return chatCompletions().find(
		(candidate) =>
			isStreamed(candidate) && JSON.stringify(candidate.body).includes(text),
	);
}

/** The same, for a turn whose answer is on screen: the model has been asked by then. */
function turnRequest(text: string): CapturedOpenAICompatibleRequest {
	const request = findTurnRequest(text);
	if (!request) {
		throw new Error(`the model was never sent a chat turn holding "${text}"`);
	}
	return request;
}

/** The background call that asked the model to describe this very picture. */
function descriptionRequestFor(
	dataUrl: string,
): CapturedOpenAICompatibleRequest | undefined {
	return chatCompletions().find(
		(request) =>
			!isStreamed(request) &&
			partsOf(userMessagesOf(request).at(-1)).some(
				(part) => part.image_url?.url === dataUrl,
			),
	);
}

/**
 * What the model would see of a picture it was sent as a data URL: its format
 * and size, and how far its colour is from the picture that was attached.
 */
async function inspectSentPicture(dataUrl: string, attached: Picture) {
	const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
	const { format, width, height } = await sharp(bytes).metadata();
	const { channels } = await sharp(bytes).stats();
	const { r, g, b } = attached.colour;
	const colourDrift = Math.max(
		...[r, g, b].map((expected, channel) =>
			Math.abs(channels[channel].mean - expected),
		),
	);
	return { format, width, height, colourDrift };
}

// --- the spec ----------------------------------------------------------------

test.describe("Alfy can see images", () => {
	// What the spec changes outside its own temporary rows, put back afterwards:
	// the worker keeps its database from one spec file to the next.
	let previousModelPreference: string | null | undefined;
	let uploadedArtifactIds: Set<string>;

	test.beforeAll(async () => {
		await fakeProvider.start();
	});

	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async ({ page }) => {
		await fakeProvider.reset();
		uploadedArtifactIds = new Set();
		previousModelPreference = undefined;
		await login(page);
		previousModelPreference = await readModelPreference(page);
	});

	test.afterEach(async ({ page }) => {
		// The choice of model first: the provider it names goes next.
		if (previousModelPreference !== undefined) {
			await writeModelPreference(page, previousModelPreference);
		}
		for (const artifactId of uploadedArtifactIds) {
			await page.request.delete(`/api/knowledge/${artifactId}`);
		}
		await deleteProvidersWithPrefix(page, PROVIDER_PREFIX);
	});

	test("the admin ticks Can see images on a model, and the tick survives a reload", async ({
		page,
	}) => {
		const model = await createTemporaryModel(page);

		let form = await openModelForm(page, model);
		// A model nobody has ticked cannot see.
		await expect(canSeeImagesBox(form)).not.toBeChecked();
		await canSeeImagesBox(form).check();
		await saveModelForm(page, form, model);

		form = await openModelForm(page, model);
		await expect(canSeeImagesBox(form)).toBeChecked();
		// The list the composer reads agrees with the form.
		expect(await listedAsSeeing(page, model)).toBe(true);

		await canSeeImagesBox(form).uncheck();
		await saveModelForm(page, form, model);

		form = await openModelForm(page, model);
		await expect(canSeeImagesBox(form)).not.toBeChecked();
		expect(await listedAsSeeing(page, model)).toBe(false);
	});

	test("a model that can see is sent the picture while its text is unread, and later turns carry the words", async ({
		page,
	}) => {
		const model = await createTemporaryModel(page);
		await setCanSeeImages(page, model, true);
		await writeModelPreference(page, model.selectedModel);

		const picture = await makePicture();
		const run = randomUUID().slice(0, 8);
		const firstMessage = `vision-e2e-${run}-first What is in this picture?`;
		const followUp = `vision-e2e-${run}-second Which colour is it?`;
		let artifactId = "";
		let dataUrl = "";

		await test.step("the picture goes to the model as a JPEG, though nobody has read its text", async () => {
			await page.goto("/", { waitUntil: "domcontentloaded" });
			await openConversationComposer(page);
			artifactId = await attachPicture(page, picture);
			uploadedArtifactIds.add(artifactId);

			// The premise: the e2e build has no document service, so the job that
			// would read the picture's text is still waiting. Without it Send
			// would be open for the old reason too, and prove nothing.
			const status = await textReadingStatus(page, artifactId);
			expect(status, "the server has a job reading the picture").toBeDefined();
			expect(
				status,
				"that job is unfinished: the e2e build has no document service",
			).not.toBe("succeeded");

			await page.getByTestId("message-input").fill(firstMessage);
			const send = page.getByTestId("send-button");
			await expect(
				send,
				"a picture the model can see must not hold Send while its text is unread",
			).toBeEnabled({ timeout: 10_000 });
			await expect(
				page.getByTestId("composer-chip-attachment"),
			).not.toHaveAttribute("aria-busy", "true");
			await send.click();

			// The server's own gate lets the turn through as the composer did: the
			// model is asked. (A turn the server refuses ends in an error message
			// in the chat, and no request ever reaches the model.)
			await expect
				.poll(() => findTurnRequest(firstMessage) !== undefined, {
					message:
						"the server must take a picture the model can see without its text",
					timeout: 15_000,
				})
				.toBe(true);
			await expect(page).toHaveURL(/\/chat\//, { timeout: 20_000 });
			await expect(page.getByTestId("assistant-message").last()).toContainText(
				AI_SMOKE_STREAM_TEXT,
				{ timeout: 30_000 },
			);

			// The last user message of the model's request: the person's text,
			// then the picture as an image part holding a data URL.
			const parts = partsOf(userMessagesOf(turnRequest(firstMessage)).at(-1));
			expect(
				parts.map((part) => part.type),
				"the person's message goes to the model as text plus one picture",
			).toEqual(["text", "image_url"]);
			expect(parts[0]?.text).toContain(firstMessage);
			dataUrl = parts[1]?.image_url?.url ?? "";
			expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);

			// It is this picture, prepared: a JPEG of the PNG's size and colour.
			const sent = await inspectSentPicture(dataUrl, picture);
			expect(sent, "the model got a JPEG of the same size").toMatchObject({
				format: "jpeg",
				width: PICTURE_WIDTH,
				height: PICTURE_HEIGHT,
			});
			expect(
				sent.colourDrift,
				"the model got the colour that was attached",
			).toBeLessThanOrEqual(COLOUR_TOLERANCE);
		});

		await test.step("the model that saw it describes it in the background, and the words are kept", async () => {
			// The call is the app's own, to the same model, and the fake model's
			// default reply is what comes back. Each wait ends when the thing it
			// waits for has happened; neither one sleeps.
			await expect
				.poll(() => descriptionRequestFor(dataUrl) !== undefined, {
					message: "the model was asked to describe the picture",
					timeout: 15_000,
				})
				.toBe(true);
			await expect
				.poll(() => storedDescription(artifactId), {
					message: "the description of the picture was stored",
					timeout: 15_000,
				})
				.toBe(AI_SMOKE_PLAIN_TEXT);
		});

		await test.step("the next turn carries the description, not the picture", async () => {
			await sendMessage(page, followUp);
			await expect(page.getByTestId("assistant-message")).toHaveCount(2, {
				timeout: 30_000,
			});
			await expect(page.getByTestId("assistant-message").last()).toContainText(
				AI_SMOKE_STREAM_TEXT,
				{ timeout: 30_000 },
			);

			const secondTurn = turnRequest(followUp);
			expect(
				JSON.stringify(secondTurn.body),
				"the follow-up holds no picture",
			).not.toContain("image_url");
			// The earlier question, as the history carries it: its text, then a
			// line saying what its picture showed.
			const olderQuestion = userMessagesOf(secondTurn)[0];
			expect(textOf(olderQuestion)).toContain(firstMessage);
			expect(
				textOf(olderQuestion),
				"the earlier question carries the picture's description",
			).toContain(`[image: ${picture.name}: ${AI_SMOKE_PLAIN_TEXT}]`);
			expect(
				partsOf(olderQuestion).filter((part) => part.type === "image_url"),
				"the earlier question carries no picture",
			).toEqual([]);

			// The pixels went to the model twice in all: with the turn that
			// attached the picture, and with the one call that described it.
			const carrying = chatCompletions().filter((request) =>
				JSON.stringify(request.body).includes(dataUrl),
			);
			expect(carrying.filter(isStreamed)).toHaveLength(1);
			expect(carrying.filter((request) => !isStreamed(request))).toHaveLength(
				1,
			);
		});

		await test.step("unticked, the same picture holds Send again, as it does for any model that cannot see", async () => {
			// The follow-up's turn is over (the composer offers Send again) before
			// the page is left.
			await expect(page.getByTestId("send-button")).toBeVisible();
			await setCanSeeImages(page, model, false);
			expect(await listedAsSeeing(page, model)).toBe(false);

			// A new chat. The message is typed first, so Send is open until the
			// picture is attached.
			await page.goto("/", { waitUntil: "domcontentloaded" });
			await openConversationComposer(page);
			await page
				.getByTestId("message-input")
				.fill(`vision-e2e-${run}-third Is it the same picture?`);
			const send = page.getByTestId("send-button");
			await expect(send).toBeEnabled({ timeout: 10_000 });

			// The same file, through the same routes.
			uploadedArtifactIds.add(await attachPicture(page, picture));
			await expect(
				page.getByTestId("composer-chip-attachment"),
				"the picture is shown as still being prepared",
			).toHaveAttribute("aria-busy", "true");
			// No upload is in flight: one would say so beside the button. So what
			// holds Send is the picture, not the bytes on their way.
			await expect(page.getByTestId("send-disabled-hint")).toHaveCount(0);
			await expect(
				send,
				"a picture whose text is not ready must hold Send for a model that cannot see",
			).toBeDisabled();
		});
	});
});
