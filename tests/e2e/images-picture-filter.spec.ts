import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MAKE_IMAGE_BLOCKED_TEXT,
	AI_SMOKE_MAKE_IMAGE_FINAL_TEXT,
	AI_SMOKE_MAKE_IMAGE_MARKER,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	clearAdminConfig,
	deleteProvidersWithPrefix,
	login,
	sendMessage,
	TEST_EMAIL,
} from "./helpers";
import {
	type FakeComfyUi,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
} from "./images-helpers";

// The explicit-picture filter, end to end (plan 2b Task 18): the fake chat
// model calls the real make_image, the real job engine renders on the fake
// ComfyUI, and the app's picture check (the stub classifier, which the e2e
// servers run: IMAGE_CHECK_CLASSIFIER=stub) judges the picture. The fake paints
// the stub's marker colour, a flat magenta: no explicit picture exists anywhere
// in this test. Every wait is on a state, never on a pause.

// The stub's "explicit" marker (STUB_EXPLICIT_COLOUR in
// src/lib/server/services/images/picture-check/classifier.ts).
const MARKER = "#ff00ff";

const fakeProvider = createOpenAICompatibleProviderHarness();
const PROVIDER_PREFIX = "images_filter_e2e_";

type ImageCardJson = {
	pickedTakeId: string | null;
	takes: Array<{
		id: string;
		status: string;
		fileId: string | null;
		errorCode: string | null;
	}>;
};
type DetailJson = { imageCards: ImageCardJson[] };

async function markerPicture(input: { width: number; height: number }) {
	return new Uint8Array(
		await sharp({
			create: {
				width: input.width,
				height: input.height,
				channels: 3,
				background: MARKER,
			},
		})
			.png()
			.toBuffer(),
	);
}

async function useTemporaryModel(page: Page): Promise<void> {
	const unique = randomUUID().slice(0, 8);
	const createdProvider = await page.request.post("/api/admin/providers", {
		data: {
			name: `${PROVIDER_PREFIX}${unique}`,
			displayName: `Picture filter E2E ${unique}`,
			baseUrl: fakeProvider.baseURL,
			apiKey: AI_SMOKE_API_KEY,
		},
	});
	expect(createdProvider.ok()).toBe(true);
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
						displayName: `Picture filter E2E Model ${unique}`,
						contextLength: 8192,
						supportsChat: true,
						supportsTools: true,
					},
				],
			},
		},
	);
	expect(createdModels.ok()).toBe(true);
	const { models } = (await createdModels.json()) as {
		models: Array<{ id: string }>;
	};
	await writeModelPreference(page, `provider:${provider.id}:${models[0].id}`);
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

async function ownUserId(page: Page): Promise<string> {
	const response = await page.request.get("/api/admin/users");
	expect(response.ok()).toBe(true);
	const { users } = (await response.json()) as {
		users: Array<{ id: string; email: string }>;
	};
	const me = users.find((user) => user.email === TEST_EMAIL);
	if (!me) throw new Error("the signed-in admin is not in the users list");
	return me.id;
}

async function setExempt(page: Page, userId: string, exempt: boolean) {
	const response = await page.request.patch(`/api/admin/users/${userId}`, {
		data: { explicitPictureFilterExempt: exempt },
	});
	expect(response.ok(), `exemption -> ${response.status()}`).toBe(true);
}

async function readDetail(page: Page, conversationId: string) {
	const response = await page.request.get(
		`/api/conversations/${conversationId}`,
	);
	expect(response.ok(), `detail read -> ${response.status()}`).toBe(true);
	return (await response.json()) as DetailJson;
}

test.describe("The explicit-picture filter", () => {
	let fake: FakeComfyUi | null = null;
	let previousModelPreference: string | null = null;
	let conversationId: string | null = null;
	let userId = "";

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
		expect(settings.ok()).toBe(true);
		const { preferences } = (await settings.json()) as {
			preferences?: { preferredModel?: string | null };
		};
		previousModelPreference = preferences?.preferredModel ?? null;
		userId = await ownUserId(page);
		fake = await startFakeComfyUiForSpec(page);
		fake.setOptions({ render: markerPicture });
		await useTemporaryModel(page);
	});

	test.afterEach(async ({ page }) => {
		await writeModelPreference(page, previousModelPreference);
		await setExempt(page, userId, false);
		await clearAdminConfig(page, ["IMAGE_EXPLICIT_FILTER_ENABLED"]);
		if (conversationId) {
			await page.request.delete(`/api/conversations/${conversationId}`);
			conversationId = null;
		}
		await deleteProvidersWithPrefix(page, PROVIDER_PREFIX);
		if (fake) await stopFakeComfyUiForSpec(page, fake);
		fake = null;
	});

	/** Opens a new chat, asks the fake model for a picture and waits for its reply. */
	async function askForPicture(page: Page, reply: string) {
		const created = await page.request.post("/api/conversations", { data: {} });
		expect(created.ok()).toBe(true);
		const body = (await created.json()) as {
			conversation?: { id: string };
			id?: string;
		};
		conversationId = body.conversation?.id ?? body.id ?? null;
		expect(conversationId).toBeTruthy();
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await sendMessage(page, `${AI_SMOKE_MAKE_IMAGE_MARKER} ${randomUUID()}`);
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			reply,
			{ timeout: 45_000 },
		);
	}

	/** Waits until the card's one take has finished, then returns it. */
	async function settledTake(page: Page) {
		await expect
			.poll(
				async () => {
					const card = (await readDetail(page, conversationId as string))
						.imageCards[0];
					const take = card?.takes[0];
					return take && take.status !== "queued" && take.status !== "running"
						? take.status
						: "pending";
				},
				{ message: "the take has finished", timeout: 30_000 },
			)
			.not.toBe("pending");
		const card = (await readDetail(page, conversationId as string))
			.imageCards[0];
		return { card, take: card.takes[0] };
	}

	test("blocks a picture that looks explicit: the card says so, nothing is served, Alfy says it was blocked", async ({
		page,
	}) => {
		await askForPicture(page, AI_SMOKE_MAKE_IMAGE_BLOCKED_TEXT);

		const { card, take } = await settledTake(page);
		expect(take).toMatchObject({
			status: "failed",
			errorCode: "image_blocked",
			fileId: null,
		});
		expect(card.pickedTakeId).toBeNull();

		const shown = page.getByTestId("image-card-blocked");
		await expect(shown).toBeVisible();
		await expect(shown).toContainText("This picture was blocked.");
		await expect(page.getByTestId("image-card-retry")).toHaveCount(0);
		await expect(page.getByTestId("image-card-picture")).toHaveCount(0);

		// Nothing was stored for the take: no file id, and nothing answers for it.
		const file = await page.request.get(
			`/api/images/files/${take.id}?conversationId=${conversationId}`,
		);
		expect(file.status()).toBe(404);
		// The picture server did render it once; the app kept none of it.
		expect(
			(fake as FakeComfyUi).requests.filter(
				(request) => request.method === "POST" && request.path === "/prompt",
			),
		).toHaveLength(1);
	});

	test("shows the picture to a person an admin exempted", async ({ page }) => {
		await setExempt(page, userId, true);
		await askForPicture(page, AI_SMOKE_MAKE_IMAGE_FINAL_TEXT);

		const { take } = await settledTake(page);
		expect(take.status).toBe("succeeded");
		expect(take.fileId).toBeTruthy();
		await expect(page.getByTestId("image-card-picture")).toBeVisible();
		const file = await page.request.get(
			`/api/images/files/${take.fileId}?conversationId=${conversationId}`,
		);
		expect(file.status()).toBe(200);
	});

	test("shows the picture when the filter is off for the whole install", async ({
		page,
	}) => {
		const off = await page.request.put("/api/admin/config", {
			data: { IMAGE_EXPLICIT_FILTER_ENABLED: "false" },
		});
		expect(off.ok(), `filter off -> ${off.status()}`).toBe(true);
		await askForPicture(page, AI_SMOKE_MAKE_IMAGE_FINAL_TEXT);

		const { take } = await settledTake(page);
		expect(take.status).toBe("succeeded");
		await expect(page.getByTestId("image-card-picture")).toBeVisible();
	});
});
