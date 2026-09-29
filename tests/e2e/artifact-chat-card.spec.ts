import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { createDocumentArtifact } from "../../src/lib/server/services/artifacts";
import { runReadArtifactTool } from "../../src/lib/server/services/normal-chat-tools/artifact-tools/read";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_CREATE_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_CREATE_ARTIFACT_MARKDOWN,
	AI_SMOKE_CREATE_ARTIFACT_MARKER,
	AI_SMOKE_CREATE_ARTIFACT_TITLE,
	AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_EDIT_ARTIFACT_MARKER,
	AI_SMOKE_MODEL_ID,
	encodeEditArtifactScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createConversation,
	login,
	sendMessage,
	workspacePanel,
} from "./helpers";

/** Mirrors artifact-document.spec.ts's own private helper (each e2e file
 *  keeps its own copy rather than sharing one — the established pattern
 *  across this test suite). */
async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

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
		// Found flaky by the orchestrator (~1 run in 3), failing at two
		// different points across runs: once at toBeEnabled() on
		// message-input (inside login()/createConversation(), both near the
		// very start), once waiting for the Document workspace text (near the
		// very end). Two disparate failure points on the SAME test point at
		// one shared cause rather than a logic race at either spot: this test
		// has no test.setTimeout of its own, so it inherits playwright.config.ts's
		// global 60_000ms default — but it already budgets 30s EACH for three
		// separate slow steps (the final assistant text, the workspace
		// becoming visible, the workspace's own text), on top of login,
		// conversation creation, and provider setup. None of those 30s
		// allowances is meant to be "normal" — they exist for a cold
		// dev-server compiling the Tiptap-heavy Document editor chunk for the
		// first time (see the comment above the workspace-text assertion
		// below) — but when the environment IS that slow, the cumulative
		// elapsed time can cross the 60s ceiling before any single await
		// reaches ITS OWN allowance, and Playwright fails whatever happened
		// to be in flight at that moment: sometimes an early one (this
		// matches the toBeEnabled() failures), sometimes a late one (this
		// matches the workspace-text failures). Sibling specs with similarly
		// long live-model flows already call test.setTimeout for exactly this
		// reason (atlas-job-flow.spec.ts uses 120_000) — this one just never
		// did. Proof: 5 consecutive green runs of this spec (see fxd-report.md).
		test.setTimeout(120_000);

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
			// The title lives on the row's own compact line ("Created Weekend
			// plan") AND on the standalone card's own head (Wave 2.5 Step 12
			// deliberately overturned the old "chrome=body, no title of its own"
			// contract for this chrome — see ArtifactCard.svelte's header
			// comment): exactly two occurrences, never a bare row-only one or a
			// runaway third.
			const row = page.getByTestId("tool-activity-row");
			await expect(row).toBeVisible();
			await expect(row.getByText(AI_SMOKE_CREATE_ARTIFACT_TITLE)).toBeVisible();
			await expect(page.getByText(AI_SMOKE_CREATE_ARTIFACT_TITLE)).toHaveCount(
				2,
			);

			// Open reaches the real panel on this exact item (the chat page's
			// existing panel-open path, ruling 51's conversationId included).
			// chrome="full"'s head is one button (redesign §5.2), so its
			// accessible name is the whole head's text, not the bare word
			// "Open" — click by the head's own testid instead.
			await card.getByTestId("artifact-card-head").click({ timeout: 30_000 });
			const workspace = workspacePanel(page);
			await expect(workspace).toBeVisible({ timeout: 30_000 });
			// A cold dev-server run compiles the workspace's lazy preview chunk
			// on this very first open, which can outrun the default 5s
			// assertion timeout under load — the same reason the two waits
			// around it already carry an explicit 30s budget.
			await expect(workspace.getByText("Book the museum tickets.")).toBeVisible(
				{ timeout: 30_000 },
			);

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
				.getByTestId("artifact-card-head")
				.click({ timeout: 30_000 });
			await expect(workspacePanel(page)).toBeVisible({ timeout: 30_000 });
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});

	// Found by the final re-check (pre-existing): with the panel showing its
	// list ("What this chat made"), pressing a chat card's Open did nothing —
	// the page opened the item but never left the list, and the panel's list
	// state wins over an open item. Opening a specific item from anywhere leaves
	// the list and shows that item.
	test("Open on a chat card while the panel shows its list leaves the list and shows that item", async ({
		page,
	}) => {
		test.setTimeout(120_000);
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

			// The panel shows the list, not an item: the list's own landmark is the
			// list's title, so the item landmark ("Weekend plan, Document") is absent.
			await page.getByTestId("artifact-count-button").click();
			const list = page.getByTestId("artifact-panel-list");
			await expect(list).toBeVisible();
			await expect(workspacePanel(page)).toHaveCount(0);

			// The chat card's Open, pressed with the list showing.
			await page
				.getByTestId("artifact-card")
				.getByTestId("artifact-card-head")
				.click();

			// That item's header takes the list's place. (A cold dev-server run
			// compiles the workspace's lazy Document chunk on this first open — the
			// same reason every other first open in this file carries a 30s budget.)
			const workspace = workspacePanel(page);
			await expect(workspace).toBeVisible({ timeout: 30_000 });
			await expect(workspace.getByTestId("artifact-panel-title")).toHaveText(
				AI_SMOKE_CREATE_ARTIFACT_TITLE,
			);
			await expect(list).toHaveCount(0);
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});

	// Final polish D4 (rd/recheck2.md): a Document made by a create_artifact call
	// of THIS turn could already be made again from the chat — the deleted card
	// offers Regenerate — but the delete confirm said "can't be undone" until a
	// reload, because the list it reads the promise from is only marked from
	// messages the server has persisted.
	test('Delete on a Document made in this very turn promises Regenerate, not "can\'t be undone", without a reload', async ({
		page,
	}) => {
		test.setTimeout(120_000);
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

			// No reload: the turn is over and the card is on screen.
			await page
				.getByTestId("artifact-card")
				.getByTestId("artifact-card-head")
				.click({ timeout: 30_000 });
			const workspace = workspacePanel(page);
			await expect(workspace).toBeVisible({ timeout: 30_000 });
			await workspace
				.getByRole("button", { name: "Delete document" })
				.click({ timeout: 15_000 });
			const dialog = page.getByRole("dialog", {
				name: "Delete this document?",
			});
			await expect(dialog).toBeVisible();
			await expect(dialog).toContainText(AI_SMOKE_CREATE_ARTIFACT_TITLE);
			await expect(dialog).toContainText(
				"You can regenerate it from the chat.",
			);
			await expect(dialog).not.toContainText("can't be undone");
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});

	// Wave 2.5 review F2 (291-293): "the in-chat card's version is stale" —
	// a live edit_artifact call bumped a seeded v1 Document to v2, but the
	// card kept reading "v1" because +page.svelte's hydrateConversationDetail
	// (the turn-finalize refresh normal streaming completion calls) never
	// copied `artifacts` out of the payload, unlike its sibling
	// applyConversationDetailMetadata (the polling-fallback path) which
	// always has. ThinkingBlock.svelte's buildEnrichedToolActivityItem derives
	// the card's own `preview` — versionNumber included — by matching the
	// tool call's artifactId against that same array, so the fix is the one
	// missing field copy; no new plumbing needed.
	test("the in-chat card's version follows a live edit_artifact call without a reload", async ({
		page,
	}) => {
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let temporaryProvider: {
			providerId: string;
			selectedModel: string;
		} | null = null;

		try {
			const conversationId = await createConversation(page, "Plan a trip");

			// A real Document artifact, seeded directly (through the real
			// service, never a raw insert) so it starts at v1 with genuine
			// block ids/hashes — mirrors artifact-document.spec.ts's own T8
			// live setup.
			const userId = await testUserId();
			const seeded = await createDocumentArtifact({
				userId,
				conversationId,
				title: "Trip plan",
				markdown: "Book the hotel.\n\nBook the flight.",
				author: "user",
				summary: "Seeded for E2E",
			});
			const readResult = await runReadArtifactTool({
				userId,
				conversationId,
				artifactId: seeded.id,
				detail: "blocks",
				abortSignal: new AbortController().signal,
			});
			const blocks =
				readResult.modelPayload.success && "blocks" in readResult.modelPayload
					? (readResult.modelPayload.blocks as Array<{
							blockId: string;
							hash: string;
							text: string;
						}>)
					: [];
			const applyBlock = blocks.find((b) => b.text === "Book the hotel.");
			const refuseBlock = blocks.find((b) => b.text === "Book the flight.");
			expect(applyBlock, "the seeded 'Book the hotel.' block").toBeTruthy();
			expect(refuseBlock, "the seeded 'Book the flight.' block").toBeTruthy();

			temporaryProvider = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			await updateUserModelPreference(page, temporaryProvider.selectedModel);

			await openChatAndReload(page, conversationId);

			const markerMessage = `${AI_SMOKE_EDIT_ARTIFACT_MARKER} ${encodeEditArtifactScenarioPayload(
				{
					artifactId: seeded.id,
					applyBlockId: applyBlock?.blockId ?? "",
					applyBaseHash: applyBlock?.hash ?? "",
					refuseBlockId: refuseBlock?.blockId ?? "",
				},
			)}`;
			await sendMessage(page, markerMessage);

			await expect(
				page.getByText(AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });

			// No reload here — this is exactly the gap the review found: the
			// turn is over, the card is already on screen, and the server-side
			// version is already 2.
			const card = page.getByTestId("artifact-card");
			await expect(card).toBeVisible();
			await expect(card.getByText("v2")).toBeVisible({ timeout: 10_000 });
			await expect(card.getByText("v1")).not.toBeVisible();
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
