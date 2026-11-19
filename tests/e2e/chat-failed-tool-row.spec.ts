import { expect, type Locator, test } from "@playwright/test";
import { AI_SMOKE_ITEM_TURN_TITLE } from "../fixtures/ai/chat-turn-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { runItemTurn, setLanguage } from "./chat-item-turn-helpers";

// The tool-row rule (`src/lib/components/chat/AGENTS.md`, "Tool Rows"): a row says
// what happened in plain words in the reader's language, a stop the app or the
// model makes on purpose is the quiet dash and not the red cross, and a row with
// nothing more to say has no body and no chevron.
//
// The model the audit walked sends an edit the tool refuses as malformed ("patch ops
// were malformed", English, written for the model) and gives up. That is a refusal
// the model corrects by itself, not a breakage: the server tags it
// `request_adjusted`, and the row says what was tried, on what, in Hungarian, as a
// stop. It used to be a red, folded "Nem sikerült szerkeszteni" with a "Részletek"
// disclosure that held the model's English, and before that a raw "Eszköz <uuid>"
// with a green tick.
//
// The model is scripted to make a Document, read it, and fail one edit and stop.
// Driven the way a reader does it (type, press Send), in Hungarian.

const RAW_PARAMETERS = [/artifactId/, /patches/, /\[object Object\]/];
const ENGLISH_REFUSAL = /patch ops were malformed/i;
// A refusal the model corrects by itself is a stop on purpose: the quiet dash.
const STOPPED_ROW = '[data-testid="tool-activity-row"][data-status="skipped"]';
const FAILED_ROW = '[data-testid="tool-activity-row"][data-status="failed"]';
const VERB = "Kérés pontosítása:";
const ROW_TITLE = `Kérés pontosítása: ${AI_SMOKE_ITEM_TURN_TITLE}`;

/** What the quiet row says and does not do: nothing to open, nothing in English. */
async function expectQuietRow(row: Locator) {
	// It says what was tried and on what, in the reader's language.
	await expect(row.getByTestId("tool-activity-verb")).toHaveText(VERB);
	await expect(row).toHaveText(
		new RegExp(`^${VERB}\\s*${AI_SMOKE_ITEM_TURN_TITLE}$`),
	);
	await expect(row).toHaveAttribute("title", ROW_TITLE);
	// No breakage word, no raw tool name, no disclosure, and nothing in English.
	await expect(row).not.toContainText(
		/Eszköz|Tool|Hiba|Nem sikerült|Részletek|Details|patch|malformed/i,
	);
	// Nothing more to say, so no body and no chevron: a plain line, not a button.
	await expect(row).toHaveJSProperty("tagName", "DIV");
	await expect(row).not.toHaveAttribute("aria-expanded", /.*/);
	await expect(row.locator(".act-chevron")).toHaveCount(0);
	await expect(
		row.locator("xpath=..").getByTestId("tool-activity-body"),
	).toHaveCount(0);
}

test.describe("a refused edit in a turn that makes a Document", () => {
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

	test("is a quiet stop that says what it tried, with nothing behind it", async ({
		page,
	}) => {
		test.setTimeout(150_000);
		const turn = await runItemTurn(page, fakeProvider.baseURL, "giveup");
		try {
			// One Document, one card; the refusal is a row of its own under it, and it
			// is a stop (the quiet dash), never the red cross of a breakage.
			await expect(turn.deliverables.getByTestId("artifact-card")).toHaveCount(
				1,
			);
			await expect(
				turn.deliverables.locator(FAILED_ROW),
				"a refusal the model corrects by itself is no breakage",
			).toHaveCount(0);
			const stopped = turn.deliverables.locator(STOPPED_ROW);
			await expect(stopped).toHaveCount(1);
			await expectQuietRow(stopped);

			// Nothing technical anywhere in the reply: neither the English of the
			// model's own words nor the call's parameters.
			const text = (await turn.reply.innerText()) ?? "";
			for (const raw of RAW_PARAMETERS) expect(text).not.toMatch(raw);
			expect(text).not.toMatch(ENGLISH_REFUSAL);

			// The same after a reload.
			await page.reload({ waitUntil: "networkidle" });
			const again = page
				.getByTestId("message-deliverables")
				.locator(STOPPED_ROW);
			await expect(again).toHaveCount(1);
			await expectQuietRow(again);
		} finally {
			await turn.restore();
		}
	});

	test("keeps its verb whole at a phone's width", async ({ page }) => {
		test.setTimeout(150_000);
		const turn = await runItemTurn(page, fakeProvider.baseURL, "giveup");
		try {
			await page.setViewportSize({ width: 390, height: 844 });
			const row = page.getByTestId("message-deliverables").locator(STOPPED_ROW);
			await expect(row).toHaveCount(1);
			// The verb never shrinks for the title: the title is what gets the ellipsis.
			const verb = row.getByTestId("tool-activity-verb");
			await verb.scrollIntoViewIfNeeded();
			await expect(verb).toHaveText(VERB);
			await expect(verb).toBeInViewport({ ratio: 1 });
		} finally {
			await turn.restore();
		}
	});
});
