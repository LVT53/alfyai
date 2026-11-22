import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MAKE_IMAGE_FINAL_TEXT,
	AI_SMOKE_MAKE_IMAGE_MARKER,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { createTourUser, markToursSeen } from "./artifact-tours-helpers";
import {
	configureFakeNormalChatCapacity,
	createEmptyConversation,
	deleteProvidersWithPrefix,
	login,
	sendMessage,
	waitForHydration,
} from "./helpers";
import {
	type FakeComfyUi,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
} from "./images-helpers";

// "Pictures and videos" (Settings > Profile) is each person's own switch. One
// person switches it off in their Settings; another, in a browser of their own,
// keeps it on. The fake chat model records every request, so the test reads
// what each person's turn was offered: the one who switched it off gets no
// make_image (and the turn guidance says why), the other still makes a picture.

const fakeProvider = createOpenAICompatibleProviderHarness();
const PROVIDER_PREFIX = "images_switch_e2e_";
const CARD =
	'[data-testid="message-deliverables"] [data-testid="artifact-card"]';

async function useTemporaryModel(page: Page): Promise<string> {
	const unique = randomUUID().slice(0, 8);
	const createdProvider = await page.request.post("/api/admin/providers", {
		data: {
			name: `${PROVIDER_PREFIX}${unique}`,
			displayName: `Pictures switch E2E ${unique}`,
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
						displayName: `Pictures switch E2E Model ${unique}`,
						contextLength: 131_072,
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
	const modelId = `provider:${provider.id}:${models[0].id}`;
	await configureFakeNormalChatCapacity(page, modelId);
	return modelId;
}

async function writePreferences(page: Page, data: Record<string, unknown>) {
	const response = await page.request.patch("/api/settings/preferences", {
		data,
	});
	expect(response.ok(), `preference write -> ${response.status()}`).toBe(true);
}

/** The switch on Settings > Profile, after the page has hydrated. */
async function pictureSwitch(page: Page) {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	return page.getByRole("switch", { name: "Pictures and videos" });
}

/** The tools the chat model was offered for the turn that sent `text`. */
function toolsOfferedFor(text: string): {
	tools: string[];
	lastUserMessage: string;
} {
	const turn = fakeProvider
		.requests()
		.map((request) => request.body as Record<string, unknown> | undefined)
		.find(
			(body) =>
				Array.isArray(body?.tools) && JSON.stringify(body).includes(text),
		);
	expect(turn, `a chat request carried "${text}"`).toBeTruthy();
	const tools =
		(
			turn?.tools as Array<{ function?: { name?: string } }> | undefined
		)?.flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])) ??
		[];
	const messages = (turn?.messages ?? []) as Array<{
		role: string;
		content: unknown;
	}>;
	const last = messages.filter((m) => m.role === "user").at(-1);
	return {
		tools,
		lastUserMessage:
			typeof last?.content === "string"
				? last.content
				: JSON.stringify(last?.content ?? ""),
	};
}

test.describe("Pictures and videos: each person's own switch", () => {
	let fake: FakeComfyUi | null = null;
	let previousModel: string | null = null;

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
		previousModel = preferences?.preferredModel ?? null;
		// A picture server, so make_image is offered to anyone who has it on.
		fake = await startFakeComfyUiForSpec(page);
	});

	test.afterEach(async ({ page }) => {
		// The shared admin goes back to how every other spec meets it.
		await writePreferences(page, {
			picturesAndVideosEnabled: true,
			preferredModel: previousModel,
		});
		await deleteProvidersWithPrefix(page, PROVIDER_PREFIX);
		if (fake) await stopFakeComfyUiForSpec(page, fake);
		fake = null;
	});

	test("one person's off never reaches another person: no make_image for them, a picture for the other", async ({
		page,
		browser,
	}) => {
		const modelId = await useTemporaryModel(page);
		await writePreferences(page, { preferredModel: modelId });

		// The first person switches it off in Settings, and it stays off.
		const mine = await pictureSwitch(page);
		await expect(mine).toHaveAttribute("aria-checked", "true");
		await mine.click();
		await expect(mine).toHaveAttribute("aria-checked", "false");
		await expect(mine).toBeEnabled();
		await expect(await pictureSwitch(page)).toHaveAttribute(
			"aria-checked",
			"false",
		);

		// Another person, in a browser of their own, still has it on.
		const other = await createTourUser("en");
		await markToursSeen(other);
		const context = await browser.newContext();
		let mineChat: string | null = null;
		try {
			const otherPage = await context.newPage();
			await login(otherPage, other.email, other.password);
			await expect(await pictureSwitch(otherPage)).toHaveAttribute(
				"aria-checked",
				"true",
			);
			await writePreferences(otherPage, { preferredModel: modelId });

			// The first person's turn: no make_image or make_video, and why.
			const plain = `Hello there ${randomUUID()}`;
			mineChat = await createEmptyConversation(page);
			await page.goto(`/chat/${mineChat}`, { waitUntil: "domcontentloaded" });
			await sendMessage(page, plain);
			await expect
				.poll(() => JSON.stringify(fakeProvider.requests()).includes(plain), {
					message: "the first person's turn reached the model",
				})
				.toBe(true);
			const offOffer = toolsOfferedFor(plain);
			expect(offOffer.tools).not.toContain("make_image");
			expect(offOffer.tools).not.toContain("make_video");
			// Finding pictures and asking are not making one.
			expect(offOffer.tools).toContain("image_search");
			expect(offOffer.tools).toContain("ask_user");
			expect(offOffer.lastUserMessage).toContain(
				"The user has switched off making pictures and videos",
			);

			// The other person's turn makes a picture, as before.
			const ask = `${AI_SMOKE_MAKE_IMAGE_MARKER} ${randomUUID()}`;
			const otherChat = await createEmptyConversation(otherPage);
			await otherPage.goto(`/chat/${otherChat}`, {
				waitUntil: "domcontentloaded",
			});
			await sendMessage(otherPage, ask);
			await expect(
				otherPage.getByTestId("assistant-message").last(),
			).toContainText(AI_SMOKE_MAKE_IMAGE_FINAL_TEXT, { timeout: 45_000 });
			await expect(otherPage.locator(CARD).last()).toBeVisible();
			const onOffer = toolsOfferedFor(ask);
			expect(onOffer.tools).toContain("make_image");
			expect(onOffer.lastUserMessage).not.toContain(
				"switched off making pictures and videos",
			);

			await otherPage.request.delete(`/api/conversations/${otherChat}`);
		} finally {
			await context.close();
			if (mineChat) await page.request.delete(`/api/conversations/${mineChat}`);
		}
	});
});
