import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_PLAIN_TEXT,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	buildAiSdkUiStreamBody,
	configureFakeNormalChatCapacity,
	ensureSidebarExpanded,
	login,
	sendMessage,
} from "./helpers";

const provider = createOpenAICompatibleProviderHarness();

type TemporaryProviderModel = {
	providerId: string;
	modelId: string;
	selectedModel: `provider:${string}:${string}`;
};

async function mockForkLocalStream(page: Page, text: string) {
	await page.unroute("**/api/chat/stream");
	await page.route("**/api/chat/stream", async (route) => {
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			},
			body: buildAiSdkUiStreamBody(text),
		});
	});
}

test.describe("conversation forks", () => {
	test.beforeAll(async () => {
		await provider.start();
	});

	test.afterAll(async () => {
		await provider.stop();
	});

	test.beforeEach(async () => {
		await provider.reset();
	});

	test("forks a persisted response and keeps lineage usable across navigation and refresh", async ({
		page,
	}) => {
		await login(page);
		const sourceTitle = `Fork smoke ${Date.now()}`;
		const temporaryProvider = await createTemporaryFakeProviderModel(page);
		let sourceId = "";

		try {
			sourceId = await createPersistedSourceConversation(
				page,
				sourceTitle,
				temporaryProvider.selectedModel,
			);
			await page.goto(`/chat/${sourceId}`, { waitUntil: "domcontentloaded" });
		} finally {
			await deleteTemporaryProvider(page, temporaryProvider.providerId);
		}

		const assistantMessage = page.getByTestId("assistant-message").first();
		await expect(assistantMessage).toContainText(AI_SMOKE_PLAIN_TEXT, {
			timeout: 15000,
		});
		const assistantMessageId =
			(await assistantMessage.getAttribute("data-message-id")) ?? "";
		expect(assistantMessageId).toBeTruthy();

		await assistantMessage.hover();
		await page.getByRole("button", { name: "Fork from here" }).click();
		await page.waitForURL(
			(url) => {
				const conversationId = url.pathname.match(/^\/chat\/([^/]+)$/)?.[1];
				return Boolean(conversationId && conversationId !== sourceId);
			},
			{ timeout: 15000 },
		);
		const forkUrl = page.url();
		const forkId = forkUrl.match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		expect(forkId).not.toBe(sourceId);

		await expect(page.locator('[data-fork-opening="true"]')).toBeVisible();
		await expect(page.getByTestId("fork-boundary-marker")).toContainText(
			"Fork starts here",
		);
		await expect(
			page.getByRole("link", { name: /Open source conversation/ }),
		).toHaveAttribute(
			"href",
			`/chat/${sourceId}#message-${assistantMessageId}`,
		);

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("fork-boundary-marker")).toContainText(
			"Copied from",
		);
		await ensureSidebarExpanded(page);
		await expect(
			page
				.locator(`[data-conversation-id="${forkId}"]`)
				.getByLabel(/Fork of Fork smoke/),
		).toBeVisible();
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.getByTestId("fork-boundary-marker")).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth + 1,
			),
		).toBe(true);
		await page.setViewportSize({ width: 1280, height: 720 });

		await page.getByRole("link", { name: /Open source conversation/ }).click();
		await expect(page).toHaveURL(new RegExp(`/chat/${sourceId}`));
		await expect(page.getByTestId("fork-origin-marker")).toContainText(
			"Forked from this response",
		);
		await expect(page.getByRole("link", { name: /Open fork/ })).toHaveAttribute(
			"href",
			`/chat/${forkId}`,
		);

		await page.goto(forkUrl, { waitUntil: "domcontentloaded" });
		await mockForkLocalStream(page, "Fork local continuation response.");
		await sendMessage(page, "Continue inside the fork");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"Fork local continuation response.",
			{ timeout: 15000 },
		);

		const deleteResult = await page.evaluate(async (sourceConversationId) => {
			const response = await fetch(
				`/api/conversations/${sourceConversationId}`,
				{
					method: "DELETE",
				},
			);
			return { ok: response.ok, status: response.status };
		}, sourceId);
		expect(
			deleteResult.ok,
			`source delete failed with ${deleteResult.status}`,
		).toBe(true);

		await page.goto(forkUrl, { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("fork-boundary-marker")).toContainText(
			"Source conversation unavailable",
		);
		await expect(
			page.getByRole("link", { name: /Open source conversation/ }),
		).toHaveCount(0);
	});
});

async function createPersistedSourceConversation(
	page: Page,
	title: string,
	model: string,
): Promise<string> {
	const result = await page.evaluate(
		async ({ message, selectedModel }) => {
			const conversationResponse = await fetch("/api/conversations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: message }),
			});
			const conversation = (await conversationResponse.json()) as {
				id?: string;
				error?: string;
			};
			if (!conversationResponse.ok || !conversation.id) {
				return {
					ok: false,
					status: conversationResponse.status,
					error: conversation.error ?? "Conversation creation failed",
				};
			}

			const sendResponse = await fetch("/api/chat/send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					conversationId: conversation.id,
					message,
					model: selectedModel,
				}),
			});
			const sendBody = (await sendResponse.json()) as { error?: string };
			if (!sendResponse.ok) {
				return {
					ok: false,
					status: sendResponse.status,
					error: sendBody.error ?? "Chat send failed",
				};
			}

			return { ok: true, conversationId: conversation.id };
		},
		{ message: title, selectedModel: model },
	);

	expect(
		result.ok,
		`fork source setup failed with ${"status" in result ? result.status : "unknown"}: ${"error" in result ? result.error : ""}`,
	).toBe(true);
	if (!("conversationId" in result)) {
		throw new Error("Fork source setup did not return a conversation id");
	}
	return result.conversationId;
}

async function createTemporaryFakeProviderModel(
	page: Page,
): Promise<TemporaryProviderModel> {
	const result = await page.evaluate(
		async ({ apiKey, baseUrl, modelName }) => {
			const unique = Date.now();
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `fork_provider_${unique}`,
					displayName: `Fork Provider ${unique}`,
					baseUrl,
					apiKey,
				}),
			});
			const providerBody = (await providerResponse.json()) as {
				provider?: { id: string };
				error?: string;
			};
			if (!providerResponse.ok || !providerBody.provider?.id) {
				return {
					ok: false,
					status: providerResponse.status,
					error: providerBody.error ?? "Provider creation failed",
				};
			}

			const modelResponse = await fetch(
				`/api/admin/providers/${providerBody.provider.id}/models/batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						models: [
							{
								name: modelName,
								displayName: "Fork Provider Chat Model",
								contextLength: 131_072,
								supportsChat: true,
								supportsTools: true,
							},
						],
					}),
				},
			);
			const modelBody = (await modelResponse.json()) as {
				models?: Array<{ id: string }>;
				error?: string;
			};
			const modelId = modelBody.models?.[0]?.id;
			if (!modelResponse.ok || !modelId) {
				return {
					ok: false,
					status: modelResponse.status,
					error: modelBody.error ?? "Provider model creation failed",
					providerId: providerBody.provider.id,
				};
			}

			return {
				ok: true,
				providerId: providerBody.provider.id,
				modelId,
			};
		},
		{
			apiKey: AI_SMOKE_API_KEY,
			baseUrl: provider.baseURL,
			modelName: AI_SMOKE_MODEL_ID,
		},
	);

	expect(
		result.ok,
		`fake provider setup failed with ${"status" in result ? result.status : "unknown"}: ${"error" in result ? result.error : ""}`,
	).toBe(true);
	if (!("providerId" in result) || !("modelId" in result)) {
		throw new Error(
			"Fake provider setup did not return provider and model ids",
		);
	}
	await configureFakeNormalChatCapacity(
		page,
		`provider:${result.providerId}:${result.modelId}`,
	);
	return {
		providerId: result.providerId,
		modelId: result.modelId,
		selectedModel: `provider:${result.providerId}:${result.modelId}`,
	};
}

async function deleteTemporaryProvider(
	page: Page,
	providerId: string,
): Promise<void> {
	await page.evaluate(async (id) => {
		await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
	}, providerId);
}
