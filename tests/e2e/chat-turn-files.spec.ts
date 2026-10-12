import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_PRODUCE_PDF_FINAL_TEXT,
	AI_SMOKE_PRODUCE_PDF_MARKER,
	AI_SMOKE_PRODUCE_PDF_TITLE,
} from "../fixtures/ai/chat-turn-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// FX-1 item 1 (RC-A new #1): a file a turn makes was missing from the panel's
// list and the header's count until the page was reloaded. Driven the way a
// reader does it: type the request, press Send, wait for the answer, then look
// at the header and press the count button. The model is scripted to call
// `produce_file` for a source-first PDF (rendered in the server's own process).

/** The turn the scripted model runs: a sentence, `produce_file`, a closing sentence. */
async function runPdfTurn(page: Page, baseURL: string) {
	await login(page);
	const previousModelPreference = await snapshotUserModelPreference(page);
	const provider = await createTemporaryFakeProviderModel(page, baseURL);
	await updateUserModelPreference(page, provider.selectedModel);
	const conversationId = await createEmptyConversation(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	await sendMessage(page, AI_SMOKE_PRODUCE_PDF_MARKER);
	await expect(page.getByText(AI_SMOKE_PRODUCE_PDF_FINAL_TEXT)).toBeVisible({
		timeout: 45_000,
	});
	// The turn is over: the composer offers Send again, and the file's card is in the reply.
	await expect(page.getByTestId("stop-button")).toHaveCount(0, {
		timeout: 30_000,
	});
	await expect(page.getByTestId("file-production-card")).toBeVisible({
		timeout: 30_000,
	});
	return {
		conversationId,
		async restore() {
			await updateUserModelPreference(page, previousModelPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		},
	};
}

test.describe("a file the turn made", () => {
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

	test("is in the header's count and the panel's list when the turn ends, with no reload", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		const turn = await runPdfTurn(page, fakeProvider.baseURL);
		try {
			// The server has it by now: a read of the chat lists the file. What was
			// missing was the page asking again once the turn had ended.
			const detail = await page.request.get(
				`/api/conversations/${turn.conversationId}`,
			);
			const { artifacts } = (await detail.json()) as {
				artifacts: Array<{ kind: string; title: string }>;
			};
			expect(artifacts.map((item) => item.kind)).toEqual(["file"]);

			const count = page.getByTestId("artifact-count-button");
			await expect(count, "the header counts what the turn made").toBeVisible({
				timeout: 15_000,
			});
			await expect(count).toContainText("1");

			await count.click();
			const row = page
				.getByTestId("artifact-panel-list")
				.getByTestId("artifact-row");
			await expect(row, "the list has a row for the file").toHaveCount(1);
			await expect(row).toContainText(AI_SMOKE_PRODUCE_PDF_TITLE);
			await expect(row).toContainText("PDF");

			// What a reload shows is what the page showed before it.
			await page.reload({ waitUntil: "networkidle" });
			await expect(page.getByTestId("artifact-count-button")).toContainText(
				"1",
			);
		} finally {
			await turn.restore();
		}
	});

	test("is counted on a phone too, where the count button is the only way to the list", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 390, height: 844 });
		const turn = await runPdfTurn(page, fakeProvider.baseURL);
		try {
			const count = page.getByTestId("artifact-count-button-compact");
			await expect(
				count,
				"a phone's chat shows the count once the turn made a file",
			).toBeVisible({ timeout: 15_000 });
			await expect(count).toContainText("1");
		} finally {
			await turn.restore();
		}
	});
});
