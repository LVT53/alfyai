import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_STREAM_TEXT,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { login, openConversationComposer, sendMessage } from "./helpers";

const provider = createOpenAICompatibleProviderHarness();

type TemporaryProviderModel = {
	providerId: string;
	modelId: string;
	selectedModel: `provider:${string}:${string}`;
};

test.describe("fake OpenAI-compatible provider app journey", () => {
	test.beforeAll(async () => {
		await provider.start();
	});

	test.afterAll(async () => {
		await provider.stop();
	});

	test.beforeEach(async () => {
		await provider.reset();
	});

	test("shows delayed turn cost without reload after a real fake-provider stream", async ({
		page,
	}) => {
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		const previousSelectedModel = await snapshotBrowserSelectedModel(page);
		let temporaryProvider: TemporaryProviderModel | null = null;

		try {
			temporaryProvider = await createTemporaryFakeProviderModel(page);
			const pricing = await page.request.put(
				`/api/admin/providers/${temporaryProvider.providerId}/models/${temporaryProvider.modelId}`,
				{
					data: {
						inputUsdMicrosPer1m: 1_000_000_000,
						outputUsdMicrosPer1m: 1_000_000_000,
					},
				},
			);
			expect(pricing.ok()).toBe(true);

			await updateUserModelPreference(page, temporaryProvider.selectedModel);
			await setBrowserSelectedModel(page, temporaryProvider.selectedModel);

			await page.goto("/", { waitUntil: "domcontentloaded" });
			await openConversationComposer(page);
			const chatStreamResponse = page.waitForResponse(
				(response) =>
					response.url().endsWith("/api/chat/stream") &&
					response.request().method() === "POST",
			);

			let pendingUsageReads = 0;
			await page.route(
				"**/api/conversations/*/messages/*/usage",
				async (route) => {
					if (pendingUsageReads++ < 2) {
						await route.fulfill({ status: 202, json: { status: "pending" } });
					} else {
						await route.continue();
					}
				},
			);
			const accountingReady = page.waitForResponse(
				(response) =>
					response.url().endsWith("/usage") && response.status() === 200,
			);
			await sendMessage(page, "Say hello through the fake provider.");
			await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
			await expect((await chatStreamResponse).status()).toBe(200);
			await expect(page.getByTestId("assistant-message").first()).toContainText(
				AI_SMOKE_STREAM_TEXT,
				{ timeout: 30000 },
			);

			const usage = await (await accountingReady).json();
			expect(usage.status).toBe("ready");
			expect(usage.costUsd).toBeGreaterThan(0);
			const assistant = page.getByTestId("assistant-message").first();
			await assistant.hover();
			const reply = assistant.locator("..");
			await reply.getByRole("button", { name: "Info", exact: true }).hover();
			await expect(reply.locator(".info-popover")).toContainText(
				`$${usage.costUsd.toFixed(6)}`,
			);
			await page.locator(".ring-button").click();
			await expect(page.locator(".popover-cost-hero")).toContainText(
				`$${(usage.totalCostUsdMicros / 1_000_000).toFixed(4)}`,
			);
			await expect(page.locator(".popover-cost-secondary")).toHaveText(
				`$${usage.costUsd.toFixed(4)}`,
			);

			const streamedChatRequests = provider
				.requests()
				.filter(
					(request) =>
						request.path === "/v1/chat/completions" &&
						isOpenAIChatCompletionBody(request.body) &&
						request.body.stream === true,
				);
			const userChatRequest = streamedChatRequests.find((request) =>
				JSON.stringify(request.body).includes(
					"Say hello through the fake provider.",
				),
			);
			expect(userChatRequest).toBeTruthy();
			expect(userChatRequest).toMatchObject({
				method: "POST",
				authorization: "Bearer [redacted]",
				body: {
					model: AI_SMOKE_MODEL_ID,
					stream: true,
					stream_options: { include_usage: true },
				},
			});
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			await setBrowserSelectedModel(page, previousSelectedModel);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});
});

function isOpenAIChatCompletionBody(
	body: unknown,
): body is { stream?: unknown } {
	return body != null && typeof body === "object";
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
					name: `fake_provider_${unique}`,
					displayName: `Fake Provider ${unique}`,
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
								displayName: "Fake Provider Chat Model",
								contextLength: 8192,
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

async function snapshotUserModelPreference(page: Page): Promise<string | null> {
	return page.evaluate(async () => {
		const response = await fetch("/api/settings");
		if (!response.ok) {
			throw new Error(`Failed to snapshot user settings: ${response.status}`);
		}
		const data = (await response.json()) as {
			preferences?: { preferredModel?: string | null };
		};
		return data.preferences?.preferredModel ?? null;
	});
}

async function updateUserModelPreference(
	page: Page,
	preferredModel: string | null,
): Promise<void> {
	const result = await page.evaluate(async (nextPreferredModel) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferredModel: nextPreferredModel }),
		});
		return { ok: response.ok, status: response.status };
	}, preferredModel);

	expect(
		result.ok,
		`User model preference update failed with ${result.status}`,
	).toBe(true);
}

async function snapshotBrowserSelectedModel(
	page: Page,
): Promise<string | null> {
	return page.evaluate(() => localStorage.getItem("selectedModel"));
}

async function setBrowserSelectedModel(
	page: Page,
	selectedModel: string | null,
): Promise<void> {
	await page.evaluate((nextSelectedModel) => {
		if (nextSelectedModel === null) {
			localStorage.removeItem("selectedModel");
			return;
		}
		localStorage.setItem("selectedModel", nextSelectedModel);
	}, selectedModel);
}
