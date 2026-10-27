import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MAKE_IMAGE_FINAL_TEXT,
	AI_SMOKE_MAKE_IMAGE_MARKER,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { deleteProvidersWithPrefix, login, sendMessage } from "./helpers";
import {
	type FakeComfyUi,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
} from "./images-helpers";

// Making a picture from words, end to end (docs/plans/image-generation, part 2a):
// the fake chat model calls the app's real make_image tool, the real job engine
// sends the work to a fake ComfyUI, and the picture lands on the chat's card and
// in its artifact list. Every wait is on a state (the conversation detail, the
// chat's DOM), never on a pause.

const fakeProvider = createOpenAICompatibleProviderHarness();
const PROVIDER_PREFIX = "images_e2e_";

type ImageCardJson = {
	pickedTakeId: string | null;
	takes: Array<{ id: string; status: string; fileId: string | null }>;
};
type DetailJson = {
	imageCards: ImageCardJson[];
	artifacts: Array<{ kind: string }>;
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

		// The card has one succeeded take, and it is the pick.
		await expect
			.poll(
				async () => {
					const card = (await readDetail(page, conversationId as string))
						.imageCards[0];
					return card?.takes.map((take) => take.status).join(",") ?? "";
				},
				{ message: "the card holds one succeeded take", timeout: 30_000 },
			)
			.toBe("succeeded");
		const detail = await readDetail(page, conversationId as string);
		expect(detail.imageCards).toHaveLength(1);
		const [take] = detail.imageCards[0].takes;
		expect(detail.imageCards[0].pickedTakeId).toBe(take.id);
		expect(take.fileId, "the take has a picture").toBeTruthy();

		// The chat's artifact list has one Image.
		expect(
			detail.artifacts.filter((entry) => entry.kind === "image"),
		).toHaveLength(1);

		// The picture itself is a PNG.
		const file = await page.request.get(
			`/api/images/files/${take.fileId}?conversationId=${conversationId}`,
		);
		expect(file.status()).toBe(200);
		expect(file.headers()["content-type"]).toBe("image/png");
		const bytes = await file.body();
		expect([...bytes.subarray(0, 8)]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);

		// The picture server was asked once.
		expect(
			comfy.requests.filter(
				(request) => request.method === "POST" && request.path === "/prompt",
			),
		).toHaveLength(1);
	});
});
