import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_STANDING_INSTRUCTION_MARKER,
	AI_SMOKE_STANDING_INSTRUCTION_TEXT,
	AI_SMOKE_SUGGEST_INSTRUCTION_FINAL_TEXT,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { login, openConversationComposer, sendMessage } from "./helpers";

/**
 * The join `instruction-suggestions.spec.ts` deliberately leaves out: a REAL
 * `suggest_instruction` tool call, driven by a scripted provider through the
 * real `/api/chat/stream` path, with the row appearing in the session that
 * produced it.
 *
 * The seeded spec starts from a message that already carries an offer, which is
 * a different question than "does an offer the model actually made reach the
 * user". It did not: the tool recorded the offer on its own call, the streaming
 * bridge rebuilt the turn's tool-call records from an enumerated field list and
 * dropped it, and the user read the model's own "Offered as a standing
 * instruction: …" prose while neither the terminal frame nor the persisted
 * message carried anything to review. That is the defect this test exists to
 * catch, so it asserts BOTH halves of it — the live row and the persisted
 * offer — off one real turn.
 */

const provider = createOpenAICompatibleProviderHarness();

const MARKER_MESSAGE = `${AI_SMOKE_STANDING_INSTRUCTION_MARKER} Always start summaries with Next Steps.`;

type TemporaryProviderModel = {
	providerId: string;
	modelId: string;
	selectedModel: `provider:${string}:${string}`;
};

const suggestionRow = (page: Page) =>
	page.getByTestId("instruction-suggestion");

/** The instructions editor, not the context ring's always-mounted popover. */
const instructionsDialog = (page: Page) =>
	page
		.locator('[role="dialog"]')
		.filter({ has: page.getByTestId("instructions-textarea") });

test.describe("instruction offer from a real tool call", () => {
	test.beforeAll(async () => {
		await provider.start();
	});

	test.afterAll(async () => {
		await provider.stop();
	});

	test.beforeEach(async () => {
		await provider.reset();
	});

	test("lands the Review/Dismiss row in the session that produced it, and persists the offer", async ({
		page,
	}) => {
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		const previousSelectedModel = await snapshotBrowserSelectedModel(page);
		let temporaryProvider: TemporaryProviderModel | null = null;

		try {
			temporaryProvider = await createTemporaryFakeProviderModel(page);
			await updateUserModelPreference(page, temporaryProvider.selectedModel);
			await setBrowserSelectedModel(page, temporaryProvider.selectedModel);
			await page.goto("/", { waitUntil: "domcontentloaded" });
			await openConversationComposer(page);

			const chatStreamResponse = page.waitForResponse(
				(response) =>
					response.url().endsWith("/api/chat/stream") &&
					response.request().method() === "POST",
			);
			await sendMessage(page, MARKER_MESSAGE);
			await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
			await expect((await chatStreamResponse).status()).toBe(200);

			// The provider answered the second round trip (the one carrying the tool
			// result) in text, so the turn only completes if the app really executed
			// a tool the provider asked for.
			await expect(page.getByTestId("assistant-message").first()).toContainText(
				AI_SMOKE_SUGGEST_INSTRUCTION_FINAL_TEXT,
				{ timeout: 30000 },
			);

			// Half one: the row is on screen NOW — the reported defect was a
			// narration promising a row that never appeared until a reload. No
			// navigation or reload happens between the turn finishing and this
			// assertion.
			const row = suggestionRow(page);
			await expect(row).toBeVisible({ timeout: 15000 });
			await expect(row).toContainText(AI_SMOKE_STANDING_INSTRUCTION_TEXT);
			expect(
				await page.locator('[data-testid="instruction-suggestion"]').count(),
			).toBe(1);

			// Half two: it is the persisted offer, not a client-side echo of the
			// model's prose — this is the record a reload reads.
			const conversationId = page.url().match(/\/chat\/([^/?#]+)/)?.[1];
			expect(conversationId).toBeTruthy();
			const persisted = await page.evaluate(async (id) => {
				const response = await fetch(`/api/conversations/${id}`);
				const body = (await response.json()) as {
					messages?: Array<{
						role: string;
						instructionSuggestions?: Array<{ text: string; status: string }>;
					}>;
				};
				const assistant = (body.messages ?? []).filter(
					(message) => message.role === "assistant",
				);
				return assistant.map((message) => message.instructionSuggestions);
			}, conversationId);
			expect(persisted).toContainEqual([
				expect.objectContaining({
					text: AI_SMOKE_STANDING_INSTRUCTION_TEXT,
					status: "pending",
				}),
			]);

			// Review still only opens the offer: cancelling leaves the instructions
			// untouched and the row in place.
			await row.getByRole("button", { name: "Review" }).click();
			// Scoped to the instructions dialog on purpose: the context-usage ring
			// keeps its popover in the DOM with role="dialog" once a turn has given
			// it a context status, so a bare getByRole("dialog") matches two.
			await expect(instructionsDialog(page)).toBeVisible({ timeout: 10000 });
			await expect(instructionsDialog(page).locator("mark")).toHaveText(
				AI_SMOKE_STANDING_INSTRUCTION_TEXT,
			);
			await instructionsDialog(page)
				.getByRole("button", { name: "Cancel" })
				.click();
			await expect(instructionsDialog(page)).toHaveCount(0);
			await expect(suggestionRow(page)).toBeVisible();
			expect(await readPersonalInstructions(page)).toBe(null);
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			await setBrowserSelectedModel(page, previousSelectedModel);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});
});

async function readPersonalInstructions(page: Page): Promise<string | null> {
	return page.evaluate(async () => {
		const response = await fetch("/api/settings");
		const body = (await response.json()) as {
			preferences?: { personalInstructions?: string | null };
		};
		return body.preferences?.personalInstructions ?? null;
	});
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
					name: `fake_suggest_provider_${unique}`,
					displayName: `Fake Suggest Provider ${unique}`,
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
					ok: false as const,
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
								displayName: "Fake Suggest Provider Model",
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
					ok: false as const,
					status: modelResponse.status,
					error: modelBody.error ?? "Provider model creation failed",
					providerId: providerBody.provider.id,
				};
			}

			return {
				ok: true as const,
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
		`fake provider setup failed with ${
			"status" in result ? result.status : "unknown"
		}: ${"error" in result ? result.error : ""}`,
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
