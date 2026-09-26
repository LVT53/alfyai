import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_CREATE_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_CREATE_ARTIFACT_MARKDOWN,
	AI_SMOKE_CREATE_ARTIFACT_MARKER,
	AI_SMOKE_CREATE_ARTIFACT_TITLE,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { createConversation, login, sendMessage } from "./helpers";

// The in-chat card (Feature 2, the cross-kind task after Slice 1's merge):
// today only a produced File gets a card in the chat message
// (ToolActivityRow renders ArtifactCard with chrome="body" for it) — the
// four new kinds (Document/App/Canvas/Slides) get none, so the user could
// only find what Alfy made through the header's count button. This proves
// the fix end to end, through a REAL create_artifact call (never a seeded
// artifact dressed up as a tool-call segment, which would prove nothing
// about the live wiring): the card appears WHILE the turn is still live,
// from the tool-call's own metadata; Open reaches the real panel on that
// exact item; and after a reload the identical card renders again, from the
// persisted tool-call segment plus ConversationDetail.artifacts.
//
// Mirrors artifact-document.spec.ts's own "T8 live" harness (the mechanism
// instruction-suggestion-live.spec.ts first established): a temporary
// provider row points the user's model preference at this fake OpenAI-
// compatible server, which recognizes the marker in the outbound request
// body and scripts a real create_artifact tool call — no encoded payload
// needed (unlike edit_artifact's own scenario), since create_artifact needs
// no ids or hashes resolved in advance.

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

async function createTemporaryFakeProviderModel(
	page: Page,
	baseUrl: string,
): Promise<{ providerId: string; modelId: string; selectedModel: string }> {
	const result = await page.evaluate(
		async ({ apiKey, base, modelName }) => {
			const unique = Date.now();
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `fake_create_artifact_provider_${unique}`,
					displayName: `Fake Create Artifact Provider ${unique}`,
					baseUrl: base,
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
								displayName: "Fake Create Artifact Provider Model",
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
		{ apiKey: AI_SMOKE_API_KEY, base: baseUrl, modelName: AI_SMOKE_MODEL_ID },
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

/**
 * Mirrors artifact-document.spec.ts's own helper: the model backend behind
 * the conversation's FIRST message (sent before the fake provider is even
 * configured, just to get a real conversation id) is unreachable in this
 * environment, so that first send never completes and leaves the "pending
 * message" flag set; clearing it directly is more reliable than racing the
 * client-side consume-on-mount logic.
 */
async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

test.describe("the in-chat artifact card — a real create_artifact call", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();

	test.beforeAll(async () => {
		await fakeProvider.start();
	});

	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	test("shows the card during the turn, Open reaches the panel on it, and it survives a reload", async ({
		page,
	}) => {
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let temporaryProvider: {
			providerId: string;
			selectedModel: string;
		} | null = null;

		try {
			const conversationId = await createConversation(page, "Plan a weekend");

			temporaryProvider = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			await updateUserModelPreference(page, temporaryProvider.selectedModel);

			await openChatAndReload(page, conversationId);

			await sendMessage(page, AI_SMOKE_CREATE_ARTIFACT_MARKER);

			await expect(
				page.getByText(AI_SMOKE_CREATE_ARTIFACT_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });

			// During the turn: the card is already there, from the tool call's own
			// metadata (artifactId/artifactKind/artifactTitle) — no reload needed,
			// and no separate fetch of ConversationDetail.artifacts either.
			const card = page.getByTestId("artifact-card");
			await expect(card).toBeVisible();
			// The title lives on the row's own line ("Created Weekend plan") —
			// chrome="body" renders no title of its own (slice-0.md Task S6 Step
			// 1.1), so the card must not repeat it. Asserted on the row, and as
			// an exact count on the page, so a regression that reintroduces the
			// header (duplicating the title) fails loudly here too.
			const row = page.getByTestId("tool-activity-row");
			await expect(row).toBeVisible();
			await expect(row.getByText(AI_SMOKE_CREATE_ARTIFACT_TITLE)).toBeVisible();
			await expect(page.getByText(AI_SMOKE_CREATE_ARTIFACT_TITLE)).toHaveCount(
				1,
			);

			// Open reaches the real panel on this exact item (the chat page's
			// existing panel-open path, ruling 51's conversationId included).
			await card
				.getByRole("button", { name: "Open" })
				.click({ timeout: 30_000 });
			const workspace = page.getByRole("complementary", {
				name: "Document workspace",
			});
			await expect(workspace).toBeVisible({ timeout: 30_000 });
			// A cold dev-server run compiles the workspace's lazy preview chunk
			// on this very first open, which can outrun the default 5s
			// assertion timeout under load — the same reason the two waits
			// around it already carry an explicit 30s budget.
			await expect(
				workspace.getByText("Book the museum tickets."),
			).toBeVisible({ timeout: 30_000 });

			// Survives a reload: the identical card renders again from the
			// persisted tool-call segment, enriched with ConversationDetail's own
			// artifacts for the preview — never a live-only state.
			await page.reload({ waitUntil: "networkidle" });
			const cardAfterReload = page.getByTestId("artifact-card");
			await expect(cardAfterReload).toBeVisible();
			const rowAfterReload = page.getByTestId("tool-activity-row");
			await expect(
				rowAfterReload.getByText(AI_SMOKE_CREATE_ARTIFACT_TITLE),
			).toBeVisible();
			// (No page-wide "exactly once" count here: the workspace panel from
			// the Open above legitimately persists across the reload and shows
			// the same title again in its own, distinct region — the "no title
			// of its own" rule this spec guards is about the CARD's body, never
			// about a separately-opened panel. The card-scoped, single-title
			// contract is already the "during the turn" assertion above and the
			// component tests in ArtifactCard.test.ts/ToolActivityRow.test.ts.)
			await cardAfterReload
				.getByRole("button", { name: "Open" })
				.click({ timeout: 30_000 });
			await expect(
				page.getByRole("complementary", { name: "Document workspace" }),
			).toBeVisible({ timeout: 30_000 });
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});
});

// Sanity: the scripted markdown really does contain the sentence the panel
// assertion above looks for, so a future edit to the fixture cannot silently
// desync this spec's own expectation from what the fake model actually sends.
test("fixture sanity: the scripted create_artifact markdown contains the expected sentence", () => {
	expect(AI_SMOKE_CREATE_ARTIFACT_MARKDOWN).toContain(
		"Book the museum tickets.",
	);
});
