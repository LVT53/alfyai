import { expect, test, type Page } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_STREAM_TEXT,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
	sendMessage,
} from "./helpers";

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

test.describe("Core user flows smoke", () => {
	test.beforeAll(async () => {
		await provider.start();
	});

	test.afterAll(async () => {
		await provider.stop();
	});

	test.beforeEach(async () => {
		await provider.reset();
	});

	test("logs in, sends from landing through the fake provider, and reloads the persisted response", async ({
		page,
	}) => {
		await login(page);
		const previousConfig = await snapshotAdminConfig(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		const previousSelectedModel = await snapshotBrowserSelectedModel(page);

		try {
			await configureFakeProviderAsDefault(page);

			await page.goto("/", { waitUntil: "domcontentloaded" });
			await openConversationComposer(page, { skipIfAlreadyOpen: true });

			await sendMessage(page, "Smoke test the main chat path.");
			await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
			await expect(page.getByTestId("user-message").first()).toContainText(
				"Smoke test the main chat path.",
				{ timeout: 10000 },
			);
			await expect(page.getByTestId("assistant-message").first()).toContainText(
				AI_SMOKE_STREAM_TEXT,
				{ timeout: 30000 },
			);

			const chatUrl = page.url();
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page).toHaveURL(chatUrl);
			await expect(page.getByTestId("assistant-message").first()).toContainText(
				AI_SMOKE_STREAM_TEXT,
				{ timeout: 15000 },
			);

			const streamedRequests = provider
				.requests()
				.filter((request) => request.path === "/v1/chat/completions");
			expect(
				streamedRequests.some((request) =>
					JSON.stringify(request.body).includes("Smoke test the main chat path."),
				),
			).toBe(true);
		} finally {
			await updateAdminConfig(page, previousConfig);
			await updateUserModelPreference(page, previousModelPreference);
			await setBrowserSelectedModel(page, previousSelectedModel);
		}
	});

	test("shows a stream failure, retries, and replaces it with a visible assistant response", async ({
		page,
	}) => {
		await login(page);

		let streamAttempts = 0;
		await page.route("**/api/chat/stream", async (route) => {
			streamAttempts += 1;
			if (streamAttempts > 1) {
				await route.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
					body: buildAiSdkUiStreamBody("Smoke retry recovered."),
				});
				return;
			}
			await route.fulfill({
				status: 500,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "Smoke provider failure" }),
			});
		});
		await page.route("**/api/chat/retry", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildAiSdkUiStreamBody("Smoke retry recovered."),
			});
		});

		await openConversationComposer(page, { skipIfAlreadyOpen: true });
		await sendMessage(page, "Trigger a retryable failure.");

		const retryButton = page.getByRole("button", { name: /retry/i });
		await expect(retryButton).toBeVisible({ timeout: 15000 });
		await retryButton.click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Smoke retry recovered.",
			{ timeout: 15000 },
		);
	});

	test("searches and opens a knowledge document in the workspace", async ({
		page,
	}) => {
		await login(page);
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await expect(
			page.getByRole("heading", { name: "Knowledge Base" }),
		).toBeVisible();

		const searchBox = page.getByRole("searchbox", {
			name: "Search documents",
		});
		await expect(searchBox).toBeVisible();

		const firstDocumentRow = page.locator("tbody tr").first();
		await expect(firstDocumentRow).toBeVisible({ timeout: 15000 });
		const documentName = normalizeDocumentName(
			await firstDocumentRow.locator(".document-name").innerText(),
		);
		expect(documentName.length).toBeGreaterThan(0);

		await searchBox.fill(documentName);
		const filteredDocumentRow = page
			.locator("tbody tr", { hasText: documentName })
			.first();
		await expect(filteredDocumentRow).toBeVisible({ timeout: 10000 });

		const workspaceTarget = await firstKnowledgeWorkspaceTarget(page, documentName);
		await page.goto(
			`/knowledge?open_artifact=${encodeURIComponent(workspaceTarget.artifactId)}&open_filename=${encodeURIComponent(workspaceTarget.filename)}&open_mime=${encodeURIComponent(workspaceTarget.mimeType ?? "")}`,
			{ waitUntil: "domcontentloaded" },
		);
		const workspace = page.locator(
			'aside.workspace-shell-desktop[aria-label="Document workspace"]',
		);
		await expect(workspace).toBeVisible({ timeout: 15000 });
		await expect(
			workspace.getByText(workspaceTarget.filename, { exact: true }),
		).toBeVisible({ timeout: 10000 });
	});

	test("validates an admin provider row and surfaces capability chips", async ({
		page,
	}) => {
		await login(page);
		const providerName = `smoke_provider_${Date.now()}`;
		const displayName = `Smoke Provider ${Date.now()}`;
		let providerId: string | null = null;

		try {
			const providerRow = await page.evaluate(
				async ({ name, baseUrl, displayName: nextDisplayName }) => {
					const response = await fetch("/api/admin/providers", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							name,
							displayName: nextDisplayName,
							baseUrl,
							apiKey: "fake-ai-smoke-key",
							modelName: "alfyai-fake-chat-model",
							enabled: true,
							sortOrder: 99,
							maxModelContext: 4096,
							compactionUiThreshold: 3000,
							targetConstructedContext: 2600,
							maxMessageLength: 2000,
							maxTokens: 512,
						}),
					});
					const body = (await response.json()) as {
						provider?: { id: string };
						error?: string;
					};
					return { ok: response.ok, status: response.status, body };
				},
				{
					name: providerName,
					displayName,
					baseUrl: provider.baseURL,
				},
			);
			expect(
				providerRow.ok,
				`provider create failed with ${providerRow.status}: ${providerRow.body.error ?? ""}`,
			).toBe(true);
			providerId = providerRow.body.provider?.id ?? null;
			expect(providerId).toBeTruthy();

			await page.goto("/settings", { waitUntil: "domcontentloaded" });
			await page.waitForLoadState("networkidle");
			await page.getByRole("button", { name: "Administration" }).click();
			await expect(page.getByText("Add Provider")).toBeVisible({
				timeout: 10000,
			});
			const row = page
				.getByText(displayName)
				.locator(
					"xpath=ancestor::div[contains(@class, 'items-center') and contains(@class, 'justify-between')][1]",
				);
			await expect(row).toBeVisible({ timeout: 15000 });
			await expect(
				row.locator('[aria-label^="Models API:"]').first(),
			).toBeVisible();

			await Promise.all([
				page.waitForResponse(
					(response) =>
						response.url().endsWith(`/api/admin/providers/${providerId}/validate`) &&
						response.request().method() === "POST" &&
						response.status() === 200,
				),
				row.getByRole("button", { name: "Test" }).click(),
			]);

			await expect(row.locator('[aria-label^="Chat:"]').first()).toBeVisible();
			await expect(
				row.locator('[aria-label^="Streaming:"]').first(),
			).toBeVisible();
		} finally {
			if (providerId) {
				await page.evaluate(async (id) => {
					await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
				}, providerId);
			}
		}
	});
});

async function configureFakeProviderAsDefault(page: Page): Promise<void> {
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
}

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

function normalizeDocumentName(rawName: string): string {
	return rawName
		.replace(/\s+/g, " ")
		.replace(/\s+(Original|Historical|v\d+)\s*$/i, "")
		.trim();
}

async function firstKnowledgeWorkspaceTarget(
	page: Page,
	preferredName: string,
): Promise<{ artifactId: string; filename: string; mimeType: string | null }> {
	return page.evaluate(async (name) => {
		const response = await fetch("/api/knowledge");
		if (!response.ok) {
			throw new Error(`Failed to load knowledge documents: ${response.status}`);
		}
		const data = (await response.json()) as {
			documents?: Array<{
				id: string;
				name: string;
				mimeType?: string | null;
				promptArtifactId?: string | null;
			}>;
		};
		const documents = data.documents ?? [];
		const target =
			documents.find((document) => document.name === name) ?? documents[0];
		if (!target) {
			throw new Error("Knowledge workspace smoke requires one local document");
		}
		return {
			artifactId: target.promptArtifactId ?? target.id,
			filename: target.name,
			mimeType: target.mimeType ?? null,
		};
	}, preferredName);
}
