import { expect, test } from "@playwright/test";
import { AI_SMOKE_ITEM_TURN_TITLE } from "../fixtures/ai/chat-turn-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { runItemTurn, setLanguage } from "./chat-item-turn-helpers";

// FX-1 item 3 (the owner's call on F16, RC-A section 1): a turn that creates an item
// and then works on it drew one card per call, three identical cards for one
// Document. A reply shows one card per item, as the item stands when the turn ends,
// and a failed attempt that a later call made good is a step of the turn (its
// rail), not a row of the reply.
//
// The model is scripted to make a Document, read it, and edit it: once, or with a
// refused edit before the good one. Driven the way a reader does it, in Hungarian.

const RAW_PARAMETERS = [/artifactId/, /patches/, /\[object Object\]/];
const FAILED_ROW = '[data-testid="tool-activity-row"][data-status="failed"]';

test.describe("an item a turn made and worked on", () => {
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

	test("is one card when it was made and edited once, not one per call", async ({
		page,
	}) => {
		test.setTimeout(150_000);
		const turn = await runItemTurn(page, fakeProvider.baseURL, "edit");
		try {
			await expect(turn.deliverables.getByTestId("artifact-card")).toHaveCount(
				1,
			);
			await expect(
				turn.deliverables.getByTestId("artifact-card"),
				"the card names the item",
			).toContainText(AI_SMOKE_ITEM_TURN_TITLE);
			await expect(turn.deliverables.locator(FAILED_ROW)).toHaveCount(0);
			// The card is the item as the edit left it: it says it was edited.
			await expect(turn.deliverables).toContainText("Szerkesztve");

			await page.reload({ waitUntil: "networkidle" });
			await expect(
				page.getByTestId("message-deliverables").getByTestId("artifact-card"),
			).toHaveCount(1);
		} finally {
			await turn.restore();
		}
	});

	test("is one card when an edit was refused and made again, and the refusal is no row of the reply", async ({
		page,
	}) => {
		test.setTimeout(150_000);
		const turn = await runItemTurn(page, fakeProvider.baseURL, "retry");
		try {
			await expect(turn.deliverables.getByTestId("artifact-card")).toHaveCount(
				1,
			);
			await expect(turn.deliverables.locator(FAILED_ROW)).toHaveCount(0);
			const text = (await turn.reply.innerText()) ?? "";
			for (const raw of RAW_PARAMETERS) expect(text).not.toMatch(raw);

			// It is still a step of the turn: the rail's strip says one edit was not made.
			await expect(
				turn.reply.getByText("Nem sikerült szerkeszteni"),
			).toBeVisible();

			// Reload: the same one card.
			await page.reload({ waitUntil: "networkidle" });
			await expect(
				page.getByTestId("message-deliverables").getByTestId("artifact-card"),
			).toHaveCount(1);
			await expect(
				page.getByTestId("message-deliverables").locator(FAILED_ROW),
			).toHaveCount(0);
		} finally {
			await turn.restore();
		}
	});
});
