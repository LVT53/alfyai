import { expect, test, type Page } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_STREAM_TEXT,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { login, openConversationComposer, sendMessage } from "./helpers";

const provider = createOpenAICompatibleProviderHarness();

const MODEL_CONFIG_KEYS = [
	"MODEL_1_BASEURL",
	"MODEL_1_API_KEY",
	"MODEL_1_NAME",
	"MODEL_1_DISPLAY_NAME",
	"MODEL_1_MAX_TOKENS",
	"HONCHO_ENABLED",
	"DEFAULT_NEW_USER_MODEL",
] as const;

type ModelConfigKey = (typeof MODEL_CONFIG_KEYS)[number];
type ConfigSnapshot = Record<ModelConfigKey, string>;

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

	test("sends a real chat stream through the configured fake provider", async ({
		page,
	}) => {
		await login(page);
		const previousConfig = await snapshotAdminConfig(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		const previousSelectedModel = await snapshotBrowserSelectedModel(page);

		try {
			await updateAdminConfig(page, {
				MODEL_1_BASEURL: provider.baseURL,
				MODEL_1_API_KEY: AI_SMOKE_API_KEY,
				MODEL_1_NAME: AI_SMOKE_MODEL_ID,
				MODEL_1_DISPLAY_NAME: "Fake Provider",
				MODEL_1_MAX_TOKENS: "256",
				HONCHO_ENABLED: "false",
				DEFAULT_NEW_USER_MODEL: "model1",
			});
			await updateUserModelPreference(page, "model1");
			await setBrowserSelectedModel(page, "model1");

			await page.goto("/", { waitUntil: "domcontentloaded" });
			await openConversationComposer(page);
			const chatStreamResponse = page.waitForResponse(
				(response) =>
					response.url().endsWith("/api/chat/stream") &&
					response.request().method() === "POST",
			);

			await sendMessage(page, "Say hello through the fake provider.");
			await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
			await expect((await chatStreamResponse).status()).toBe(200);
			await expect(page.getByTestId("assistant-message").first()).toContainText(
				AI_SMOKE_STREAM_TEXT,
				{ timeout: 30000 },
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
				JSON.stringify(request.body).includes("Say hello through the fake provider."),
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
			await updateAdminConfig(page, previousConfig);
			await updateUserModelPreference(page, previousModelPreference);
			await setBrowserSelectedModel(page, previousSelectedModel);
		}
	});
});

async function snapshotAdminConfig(page: Page): Promise<ConfigSnapshot> {
	return page.evaluate(async (keys) => {
		const response = await fetch("/api/admin/config");
		if (!response.ok) {
			throw new Error(`Failed to snapshot admin config: ${response.status}`);
		}
		const data = (await response.json()) as {
			overrides?: Record<string, string>;
		};
		return Object.fromEntries(
			keys.map((key) => [key, data.overrides?.[key] ?? ""]),
		) as ConfigSnapshot;
	}, MODEL_CONFIG_KEYS);
}

async function updateAdminConfig(
	page: Page,
	values: Partial<Record<ModelConfigKey, string>>,
): Promise<void> {
	const result = await page.evaluate(async (nextValues) => {
		const response = await fetch("/api/admin/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(nextValues),
		});
		return { ok: response.ok, status: response.status };
	}, values);

	expect(result.ok, `Admin config update failed with ${result.status}`).toBe(
		true,
	);
}

function isOpenAIChatCompletionBody(
	body: unknown,
): body is { stream?: unknown } {
	return body != null && typeof body === "object";
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

async function snapshotBrowserSelectedModel(page: Page): Promise<string | null> {
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
