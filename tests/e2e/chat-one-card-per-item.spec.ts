import { expect, type Locator, test } from "@playwright/test";
import { AI_SMOKE_ITEM_TURN_TITLE } from "../fixtures/ai/chat-turn-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { runItemTurn, setLanguage } from "./chat-item-turn-helpers";

// FX-1 item 3 (the owner's call on F16, RC-A section 1): a turn that creates an item
// and then works on it drew one card per call, three identical cards for one
// Document. A reply shows one card per item, as the item stands when the turn ends,
// and a refused attempt that a later call made good is a step of the turn (its
// rail), not a row of the reply.
//
// The model is scripted to make a Document, read it, and edit it: once, or with a
// refused edit before the good one. A refused edit is a request the model corrects
// by itself, a stop on purpose (the tool-row rule, `src/lib/components/chat/AGENTS.md`,
// "Tool Rows"): its row is the quiet dash, never the red cross, and the rail's strip
// says "Kérés pontosítása", never that something failed. Driven the way a reader does
// it, in Hungarian.

const RAW_PARAMETERS = [/artifactId/, /patches/, /\[object Object\]/];
const FAILED_ROW = '[data-testid="tool-activity-row"][data-status="failed"]';
const STOPPED_ROW = '[data-testid="tool-activity-row"][data-status="skipped"]';

/** The reply draws no row of a refused attempt: neither as a breakage nor as a stop. */
async function expectNoAttemptRow(deliverables: Locator) {
	await expect(deliverables.locator(FAILED_ROW)).toHaveCount(0);
	await expect(deliverables.locator(STOPPED_ROW)).toHaveCount(0);
}

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
			await expectNoAttemptRow(turn.deliverables);
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
			await expectNoAttemptRow(turn.deliverables);
			// biome-ignore lint/performance/useDomNodeTextContent: innerText is rendered text, as a person sees it.
			const text = (await turn.reply.innerText()) ?? "";
			for (const raw of RAW_PARAMETERS) expect(text).not.toMatch(raw);

			// It is still a step of the turn: the rail's strip says Alfy adjusted one
			// request. The refusal is a stop on purpose, so it is never counted as
			// something that failed.
			await expect(turn.reply.getByText("Kérés pontosítása")).toBeVisible();
			await expect(
				turn.reply.getByText("Nem sikerült szerkeszteni"),
			).toHaveCount(0);

			// Reload: the same one card.
			await page.reload({ waitUntil: "networkidle" });
			await expect(
				page.getByTestId("message-deliverables").getByTestId("artifact-card"),
			).toHaveCount(1);
			await expectNoAttemptRow(page.getByTestId("message-deliverables"));
		} finally {
			await turn.restore();
		}
	});
});
