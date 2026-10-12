import { expect, test } from "@playwright/test";
import { AI_SMOKE_ITEM_TURN_TITLE } from "../fixtures/ai/chat-turn-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { runItemTurn, setLanguage } from "./chat-item-turn-helpers";

// FX-1 item 2 (RC-A new #2): the model the audit walked fails an edit or two a
// Document turn. A failed call printed its raw parameters and an English error,
// expanded, in a row named "Eszköz <uuid>" (with a green tick: the call had
// "finished"). It names what it tried now, in the reader's language, red, folded,
// with the model's own words behind a quiet "Részletek" and never the parameters.
//
// The model is scripted to make a Document, read it, and fail one edit and stop.
// Driven the way a reader does it (type, press Send, press the row), in Hungarian.

const RAW_PARAMETERS = [/artifactId/, /patches/, /\[object Object\]/];
// What opening the details may show: the model's own sentence, which names `patches`.
const RAW_PARAMETER_LINES = [
	/paraméterek/i,
	/artifactId/,
	/summary:/,
	/\[object Object\]/,
];
const ENGLISH_REFUSAL = /patch ops were malformed/i;
const FAILED_ROW = '[data-testid="tool-activity-row"][data-status="failed"]';
const ROW_NAME = `Nem sikerült szerkeszteni: ${AI_SMOKE_ITEM_TURN_TITLE}`;

test.describe("a failed edit in a turn that makes a Document", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
		await setLanguage("hu");
	});
	test.afterEach(async () => {
		await setLanguage("en");
	});

	test("is a folded row that names what it tried, with the details behind a press", async ({
		page,
	}) => {
		test.setTimeout(150_000);
		const turn = await runItemTurn(page, fakeProvider.baseURL, "giveup");
		try {
			// One Document, one card; the refusal is a row of its own under it.
			await expect(turn.deliverables.getByTestId("artifact-card")).toHaveCount(
				1,
			);
			const failed = turn.deliverables.locator(FAILED_ROW);
			await expect(failed).toHaveCount(1);
			await expect(
				failed,
				"the row names the item and says what failed, in the reader's language",
			).toHaveAccessibleName(ROW_NAME);
			await expect(failed).not.toContainText(/Eszköz|Tool/);

			// Folded: nothing technical on the page, neither the English of the model's
			// own words nor the call's parameters.
			await expect(failed).toHaveAttribute("aria-expanded", "false");
			const text = (await turn.reply.innerText()) ?? "";
			for (const raw of RAW_PARAMETERS) expect(text).not.toMatch(raw);
			expect(text).not.toMatch(ENGLISH_REFUSAL);

			// Behind a quiet "Részletek": the reason, never the parameters.
			await expect(failed).toContainText("Részletek");
			await failed.click();
			await expect(failed).toHaveAttribute("aria-expanded", "true");
			await expect(
				turn.deliverables.getByTestId("tool-activity-error"),
			).toContainText(ENGLISH_REFUSAL);
			const opened = (await turn.reply.innerText()) ?? "";
			for (const raw of RAW_PARAMETER_LINES) expect(opened).not.toMatch(raw);
			await failed.click();
			await expect(failed).toHaveAttribute("aria-expanded", "false");

			// The same after a reload.
			await page.reload({ waitUntil: "networkidle" });
			const again = page
				.getByTestId("message-deliverables")
				.locator(FAILED_ROW);
			await expect(again).toHaveAccessibleName(ROW_NAME);
			await expect(again).toHaveAttribute("aria-expanded", "false");
		} finally {
			await turn.restore();
		}
	});
});
