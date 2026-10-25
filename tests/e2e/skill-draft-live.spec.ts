import { expect, test } from "@playwright/test";
import {
	AI_SMOKE_SKILL_DRAFT_EXAMPLE,
	AI_SMOKE_SKILL_DRAFT_INSTRUCTIONS,
	AI_SMOKE_SKILL_DRAFT_MARKER,
	AI_SMOKE_SKILL_DRAFT_NAME,
	AI_SMOKE_SKILL_DRAFT_TEXT,
} from "../fixtures/ai/chat-turn-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

/**
 * A skill the model drafts, end to end on the real `/api/chat/stream` path: the
 * scripted model writes its reply and a `<skill_control_v1>` envelope split
 * across frames where a real stream split one, and the Save / Dismiss card must
 * be on screen in the session that drafted it.
 *
 * Both halves of the 2026-10-25 defect fail here. The server's leaked-output
 * cleanup read the envelope's `{"vers…` line as a leaked produce_file payload
 * and swallowed it (the draft was lost on a quarter of real turns), and the
 * browser's terminal-frame parser dropped `skillDrafts`, so even a kept draft
 * waited for a reload.
 */
test.describe("a skill the model drafts", () => {
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

	test("lands its card in the session that drafted it, and Save opens the saved skill", async ({
		page,
	}) => {
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		const provider = await createTemporaryFakeProviderModel(
			page,
			fakeProvider.baseURL,
		);
		let savedSkillId: string | null = null;

		try {
			await updateUserModelPreference(page, provider.selectedModel);
			const conversationId = await createEmptyConversation(page);
			await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
			await sendMessage(page, AI_SMOKE_SKILL_DRAFT_MARKER);
			await expect(page.getByText(AI_SMOKE_SKILL_DRAFT_TEXT)).toBeVisible({
				timeout: 45_000,
			});
			await expect(page.getByTestId("stop-button")).toHaveCount(0, {
				timeout: 30_000,
			});

			// No reload or navigation between the turn and this: the card is
			// drawn from the terminal frame of the stream that drafted it.
			const card = page.getByRole("article", {
				name: `Skill draft: ${AI_SMOKE_SKILL_DRAFT_NAME}`,
			});
			await expect(card).toBeVisible({ timeout: 15_000 });
			await expect(card).toContainText(AI_SMOKE_SKILL_DRAFT_INSTRUCTIONS);
			await expect(card).toContainText(AI_SMOKE_SKILL_DRAFT_EXAMPLE);
			await expect(page.getByText("skill_control_v1")).toHaveCount(0);

			await card.getByRole("button", { name: "Save private skill" }).click();
			const openSaved = card.getByRole("link", { name: "Open in Skills" });
			await expect(openSaved).toBeVisible({ timeout: 15_000 });
			const href = (await openSaved.getAttribute("href")) ?? "";
			savedSkillId = new URLSearchParams(href.split("?")[1] ?? "").get("skill");
			expect(savedSkillId).toBeTruthy();

			await openSaved.click();
			await expect(page.getByTestId("skills-manager")).toBeVisible({
				timeout: 15_000,
			});
			await expect(page.getByLabel("Display name")).toHaveValue(
				AI_SMOKE_SKILL_DRAFT_NAME,
			);
			await expect(page.getByLabel("Instructions")).toHaveValue(
				AI_SMOKE_SKILL_DRAFT_INSTRUCTIONS,
			);
		} finally {
			if (savedSkillId) {
				await page.evaluate(async (id) => {
					await fetch(`/api/skills/${encodeURIComponent(id)}`, {
						method: "DELETE",
					});
				}, savedSkillId);
			}
			await updateUserModelPreference(page, previousModelPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		}
	});
});
