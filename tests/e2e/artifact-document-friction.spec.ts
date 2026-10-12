import { expect, test } from "@playwright/test";
import {
	openDocument,
	seedDocument,
	setUiLanguage,
} from "./artifact-document-polish-helpers";
import { createEmptyConversation, login } from "./helpers";

// The friction build's Document findings (ruling 77, FB-6): F6 Alfy is visibly at
// work, F13 a one-row review bar on a phone, F14 an @Alfy comment feels answered,
// F18 Keep does not move the text, F24 the comments column takes no room until
// there is a comment, F28 the add-tab button says what it does. Hungarian, the
// owner's language; every action is a real pointer, key or touch.

const MARKDOWN = [
	"# Bécsi hétvége",
	"",
	"Két nap a barátnőddel: szombat és vasárnap. A programok nagy része esőben is megy.",
	"",
	"## Szombat",
	"",
	"Schönbrunn és a Gloriette kilátása. Érdemes korán érkezni a tömeg elkerülése végett.",
	"",
	"Délben a Naschmarkt, utána a Karlsplatz.",
].join("\n");

test.beforeEach(async ({ page }) => {
	await setUiLanguage("hu");
	await login(page);
});

test.afterEach(async () => {
	await setUiLanguage("en");
});

test.describe("F28 the add-tab button says what it does", () => {
	test("the single-tab strip shows the button's words, not a bare plus", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F28");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		const add = shell.getByRole("button", { name: "Fül hozzáadása" });
		await expect(add).toBeVisible();
		// The words are on the button itself (not only in its accessible name).
		await expect(add).toHaveText("Fül hozzáadása");
		// And it still adds one.
		await add.click();
		await expect(shell.getByRole("tab")).toHaveCount(2);
	});
});
