import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	createDocumentArtifact,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
import {
	undidAlfyChangeSummary,
	VERSION_SUMMARY,
} from "../../src/lib/shared/artifacts/version-summaries";
import { createConversation, login, workspacePanel } from "./helpers";

// Ruling 76 (the versioning build): History is a MODE of the panel — a
// read-only preview beside a day-grouped rail of moments — and the header says
// the latest moment instead of a number. Every flow here is real input (the
// pointer, the keyboard, a touch) against the real app and the real history,
// naming and restore routes; the rows are seeded through the artifact service
// in the vocabulary the server writes.

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

/** Counts the history route's requests (the page's `before` cursor) as the page makes them. */
function watchHistoryRequests(page: Page): Array<number | null> {
	const befores: Array<number | null> = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!/\/api\/artifacts\/[^/]+\/history$/.test(url.pathname)) return;
		const before = url.searchParams.get("before");
		befores.push(before === null ? null : Number(before));
	});
	return befores;
}
type Seed = {
	author: "user" | "alfy";
	summary: string;
	markdown: string;
};

/** A Document with the given versions in order (the first is its v1). */
async function seedDocument(
	conversationId: string,
	title: string,
	versions: Seed[],
): Promise<string> {
	const userId = await adminId();
	const [first, ...rest] = versions;
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title,
		markdown: first.markdown,
		author: first.author,
		summary: first.summary,
	});
	for (const version of rest) {
		await updateArtifactBody({
			userId,
			artifactId: artifact.id,
			conversationId,
			body: version.markdown,
			author: version.author,
			summary: version.summary,
		});
	}
	return artifact.id;
}

async function openChat(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

function historyButton(page: Page): Locator {
	return page
		.locator('[data-testid="artifact-history-button"]:visible')
		.first();
}

async function openDocumentInPanel(page: Page) {
	const countButton = page.getByTestId("artifact-count-button");
	if ((await countButton.getAttribute("aria-pressed")) !== "true") {
		await countButton.click();
	}
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click({ timeout: 30_000 });
	await expect(historyButton(page)).toBeVisible({ timeout: 30_000 });
}

/** Done joins the header's actions in both of the panel's shells; only the showing one counts. */
function doneButton(page: Page): Locator {
	return page.locator('[data-testid="artifact-history-done"]:visible').first();
}

function historyRegion(page: Page, title: string): Locator {
	return page.getByRole("region", { name: `History of ${title}` });
}

const THREE_VERSIONS: Seed[] = [
	{
		author: "alfy",
		summary: "Alfy wrote the first draft",
		markdown:
			"Friday\n\nArrive and walk.\n\nSaturday\n\nBelvedere in the morning.",
	},
	{
		author: "user",
		summary: "Edited",
		markdown:
			"Friday\n\nArrive and walk.\n\nSaturday\n\nBelvedere in the morning, then a cafe.",
	},
	{
		author: "alfy",
		summary: "Moved the museum to Thursday",
		markdown:
			"Friday\n\nArrive and walk.\n\nSaturday\n\nBelvedere in the morning, then a cafe.\n\nThursday\n\nThe museum.",
	},
];

test.describe("History mode", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("opens from the header's history button, selects the newest moment, and Done returns to the Document", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History open");
		await seedDocument(conversationId, "History open", THREE_VERSIONS);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);

		// The header says what happened last, never a number.
		await expect(historyButton(page)).toContainText("Changed by Alfy");
		await expect(historyButton(page)).not.toContainText(/\bv\d/);
		await expect(historyButton(page)).toHaveAttribute("aria-pressed", "false");

		await historyButton(page).click();
		const region = historyRegion(page, "History open");
		await expect(region).toBeVisible();
		await expect(historyButton(page)).toHaveAttribute("aria-pressed", "true");

		// The newest moment is selected, its words are in the preview, and Done joins the actions.
		const options = region.getByRole("option");
		await expect(options).toHaveCount(3);
		await expect(options.first()).toHaveAttribute("aria-selected", "true");
		await expect(options.first()).toContainText(
			"Alfy: Moved the museum to Thursday",
		);
		const preview = region.getByTestId("history-preview");
		await expect(preview).toContainText("The museum.");
		await expect(doneButton(page)).toBeVisible();
		// Comments and Download step aside while History is open.
		await expect(
			workspacePanel(page).getByTestId("artifact-download-button"),
		).toHaveCount(0);

		await doneButton(page).click();
		await expect(region).toHaveCount(0);
		await expect(historyButton(page)).toHaveAttribute("aria-pressed", "false");
		await expect(historyButton(page)).toBeFocused();
		// The Document is back, as it was.
		await expect(
			page.locator(".document-editor-host .document-content"),
		).toContainText("Belvedere in the morning");
	});

	test("returns to editing with the scroll where it was", async ({ page }) => {
		const conversationId = await createConversation(page, "History scroll");
		const paragraphs = Array.from(
			{ length: 60 },
			(_, index) => `Paragraph number ${index + 1} of the long plan.`,
		).join("\n\n");
		await seedDocument(conversationId, "History scroll", [
			{
				author: "alfy",
				summary: "Alfy wrote the first draft",
				markdown: paragraphs,
			},
			{
				author: "user",
				summary: "Edited",
				markdown: `${paragraphs}\n\nOne more.`,
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);

		const scroller = page.locator(".document-content-text").first();
		await scroller.hover();
		await page.mouse.wheel(0, 900);
		await expect
			.poll(() => scroller.evaluate((element) => element.scrollTop))
			.toBeGreaterThan(300);
		const before = await scroller.evaluate((element) => element.scrollTop);

		await historyButton(page).click();
		await expect(historyRegion(page, "History scroll")).toBeVisible();
		await doneButton(page).click();
		await expect(historyRegion(page, "History scroll")).toHaveCount(0);

		const after = await scroller.evaluate((element) => element.scrollTop);
		expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
	});

	test("saves what was just typed before it shows the history, so the step is in it (P10)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History flush");
		await seedDocument(conversationId, "History flush", [
			{
				author: "alfy",
				summary: "Alfy wrote the first draft",
				markdown: "Book the hotel.\n\nBook the flight.",
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);

		const editor = page.locator(".document-editor-host .document-content");
		await editor.getByText("Book the flight.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Window seat.");
		// Straight to History: the autosave's delay has not passed.
		await historyButton(page).click();

		const region = historyRegion(page, "History flush");
		await expect(region).toBeVisible();
		const options = region.getByRole("option");
		await expect(options).toHaveCount(2);
		await expect(options.first()).toContainText("You edited");
		await expect(region.getByTestId("history-preview")).toContainText(
			"Window seat.",
		);
	});

	test("the rail is a listbox of sentences that arrow keys walk, and Escape leaves History with the focus back on its button (T9)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History a11y");
		await seedDocument(conversationId, "History a11y", [
			...THREE_VERSIONS,
			{
				author: "user",
				summary: undidAlfyChangeSummary(3),
				markdown: THREE_VERSIONS[1].markdown,
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);
		await historyButton(page).click();

		const region = historyRegion(page, "History a11y");
		await expect(region).toBeVisible();
		const list = region.getByRole("listbox", { name: "Versions" });
		await expect(list).toBeVisible();

		// An Alfy change and the Undo that immediately followed it are one story: the
		// moment says it was undone, the Undo is a step under it, and no "v4" is printed.
		const options = list.getByRole("option");
		await expect(options).toHaveCount(4);
		await expect(options.nth(0)).toHaveAccessibleName(
			/Today \d\d:\d\d, Alfy: Moved the museum to Thursday\.( .*)? Undone\./,
		);
		await expect(options.nth(1)).toHaveAccessibleName(
			/Today \d\d:\d\d, You undid it\./,
		);
		await expect(options.nth(2)).toHaveAccessibleName(
			/Today \d\d:\d\d, You edited\./,
		);
		await expect(options.nth(3)).toHaveAccessibleName(
			/Today \d\d:\d\d, Alfy wrote the first draft\./,
		);
		await expect(list).not.toContainText(/\bv\d/);
		// Days are groups, named by their heading.
		await expect(list.getByRole("group", { name: "Today" })).toHaveCount(1);

		// The focus is in the list on the selected option; the arrows walk it and the preview follows.
		await expect(options.nth(0)).toBeFocused();
		const preview = region.getByTestId("history-preview");
		await expect(preview).toContainText("The museum.");
		await page.keyboard.press("ArrowDown");
		await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
		await expect(options.nth(1)).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
		await expect(preview).toContainText("then a cafe");
		await expect(preview).not.toContainText("The museum.");
		await page.keyboard.press("End");
		await expect(options.nth(3)).toHaveAttribute("aria-selected", "true");
		await expect(preview).not.toContainText("then a cafe");
		await page.keyboard.press("Home");
		await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

		// A polite live region says the selected moment once its preview has loaded.
		await expect(page.getByTestId("artifact-history-live")).toContainText(
			"Alfy: Moved the museum to Thursday",
		);

		await page.keyboard.press("Escape");
		await expect(region).toHaveCount(0);
		await expect(historyButton(page)).toBeFocused();
	});

	test("pages the history 50 rows at a time, keeping one Today group and the focus where a keyboard reader left it (T3)", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const conversationId = await createConversation(page, "History paging");
		const userId = await adminId();
		const artifact = await createDocumentArtifact({
			userId,
			conversationId,
			title: "History paging",
			markdown: "Revision 1.",
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		for (let i = 2; i <= 120; i++) {
			await updateArtifactBody({
				userId,
				artifactId: artifact.id,
				conversationId,
				body: `Revision ${i}.`,
				author: i % 2 === 0 ? "user" : "alfy",
				summary: i % 2 === 0 ? `Edited ${i}` : `Alfy rewrote revision ${i}`,
			});
		}
		const historyRequests = watchHistoryRequests(page);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);
		await historyButton(page).click();

		const region = historyRegion(page, "History paging");
		const options = region.getByRole("option");
		await expect(options).toHaveCount(50);
		const older = region.getByRole("button", { name: "Show older" });
		await expect(older).toBeVisible();
		await older.click();
		await expect(options).toHaveCount(100);
		await expect(older).toBeVisible();
		await expect(older).toBeFocused();
		await older.click();
		await expect(options).toHaveCount(120);
		// The button is gone; the keyboard reader lands on the first row that came in.
		await expect(older).toHaveCount(0);
		await expect(options.nth(100)).toBeFocused();
		// The days stay continuous across pages: all of it is Today.
		await expect(region.getByRole("group", { name: "Today" })).toHaveCount(1);
		expect(historyRequests).toEqual([null, 71, 21]);
	});

	test("says every moment in Hungarian: no English summary survives in the rail (T8)", async ({
		page,
	}) => {
		await db
			.update(users)
			.set({ uiLanguage: "hu" })
			.where(eq(users.email, "admin@local"));
		try {
			const conversationId = await createConversation(page, "Előzmények");
			await seedDocument(conversationId, "Előzmények", [
				{
					author: "alfy",
					summary: VERSION_SUMMARY.keptFromChat,
					markdown: "Péntek\n\nÉrkezés.",
				},
				{
					author: "user",
					summary: VERSION_SUMMARY.edited,
					markdown: "Péntek\n\nÉrkezés, séta.",
				},
				{
					author: "alfy",
					summary: VERSION_SUMMARY.alfyCommentReply,
					markdown: "Péntek\n\nÉrkezés, séta és kávé.",
				},
				{
					author: "user",
					summary: VERSION_SUMMARY.edited,
					markdown: "Péntek\n\nÉrkezés, séta és kávé, vacsora.",
				},
				{
					author: "alfy",
					summary: VERSION_SUMMARY.alfyEdit,
					markdown: "Péntek\n\nÉrkezés, séta és kávé, vacsora a Naschmarkton.",
				},
			]);
			await openChat(page, conversationId);
			await openDocumentInPanel(page);
			await historyButton(page).click();

			const region = page.getByRole("region", {
				name: "Előzmények – előzmények",
			});
			await expect(region).toBeVisible();
			const list = region.getByRole("listbox", { name: "Változatok" });
			const options = list.getByRole("option");
			await expect(options).toHaveCount(5);
			// Newest first: Alfy's own fallback ("Alfy's edit": no words of its own), the
			// reader's edit, Alfy's reply to a comment, the reader's edit, the kept reply.
			await expect(options.nth(0)).toContainText("Alfy módosította");
			await expect(options.nth(1)).toContainText("Szerkesztetted");
			await expect(options.nth(2)).toContainText(
				"Alfy módosította, válaszul a megjegyzésedre",
			);
			await expect(options.nth(3)).toContainText("Szerkesztetted");
			await expect(options.nth(4)).toContainText(
				"Megtartottad Alfy válaszát dokumentumként",
			);
			const text = (await list.innerText()).replace(/\s+/g, " ");
			for (const english of [
				"You ",
				"Alfy changed",
				"Alfy's",
				"Kept from",
				"Edited",
				"comment reply",
			]) {
				expect(text, `no "${english}" in the Hungarian rail`).not.toContain(
					english,
				);
			}
			// The header, too, says it in Hungarian.
			await expect(doneButton(page)).toHaveText("Kész");
		} finally {
			await db
				.update(users)
				.set({ uiLanguage: "en" })
				.where(eq(users.email, "admin@local"));
		}
	});
});

/** A Document body the way the server stores it: a marker line (the block's stable id) before every block. */
const withIds = (...blocks: Array<[string, string]>): string =>
	blocks.map(([id, text]) => `<!--b:${id}-->\n${text}`).join("\n\n");

test.describe("History mode: what changed, restore and names", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("marks what each version changed, steps through the changes, folds what did not, and compares with now", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History marks");
		const v1 = withIds(
			["h1", "# Friday"],
			["p1", "Arrive in the afternoon."],
			["h2", "# Saturday"],
			["p2", "Morning at the Belvedere."],
			["h3", "# Sunday"],
			["p3", "Schönbrunn, then home."],
			["h4", "# Packing"],
			["p4", "Passport and a rain jacket."],
		);
		const v2 = withIds(
			["h1", "# Friday"],
			["p1", "Arrive in the afternoon."],
			["h2", "# Saturday"],
			["p2", "Morning at the Albertina, then a cafe."],
			["h3", "# Sunday"],
			["p3", "Schönbrunn, then home."],
			["h4", "# Packing"],
			["p4", "Passport and a rain jacket."],
			["p5", "Museum tickets online."],
		);
		await seedDocument(conversationId, "History marks", [
			{ author: "alfy", summary: "Alfy wrote the first draft", markdown: v1 },
			{
				author: "alfy",
				summary: "Moved the museum to Saturday",
				markdown: v2,
			},
			{
				author: "user",
				summary: "Edited",
				markdown: v2.replace(
					"Museum tickets online.",
					"Museum tickets booked.",
				),
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);
		await historyButton(page).click();

		const region = historyRegion(page, "History marks");
		const options = region.getByRole("option");
		await expect(options).toHaveCount(3);

		// The reader's own change, a word replaced: the new word marked, the old struck,
		// and what did not change folded into one line that opens when asked.
		const preview = region.getByTestId("history-preview");
		await expect(preview.locator("mark")).toHaveText(["booked"]);
		await expect(preview.locator("del")).toHaveText(["online"]);
		const fold = preview.getByTestId("history-fold").first();
		await expect(fold).toContainText("unchanged");
		await expect(preview).not.toContainText("Schönbrunn, then home.");
		await fold.click();
		await expect(preview).toContainText("Schönbrunn, then home.");

		// Alfy's change: its words marked, a screen reader told "Added:" before each, in its accent.
		await options.nth(1).click();
		await expect(region.getByTestId("history-change-count")).toHaveText(
			"1 / 2",
		);
		await expect(preview.locator("mark").first()).toHaveAttribute(
			"data-sr",
			"Added: ",
		);
		await expect(
			preview.locator("mark", { hasText: "Albertina" }),
		).toBeVisible();
		await expect(
			preview.locator("del", { hasText: "Belvedere" }),
		).toBeVisible();
		await expect(preview.locator('.page[data-marks="alfy"]')).toHaveCount(1);

		// The stepper walks the changes and flashes each.
		await region.getByTestId("history-next-change").click();
		await expect(preview.locator(".block.flash")).toHaveCount(1);
		await region.getByTestId("history-next-change").click();
		await expect(region.getByTestId("history-change-count")).toHaveText(
			"2 / 2",
		);
		await page.keyboard.press("Alt+ArrowUp");
		await expect(region.getByTestId("history-change-count")).toHaveText(
			"1 / 2",
		);

		// The first version has no step of its own: its preview compares with now.
		await options.nth(2).click();
		await expect(region.getByTestId("history-compare-step")).toBeDisabled();
		await expect(region.getByTestId("history-compare-now")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		// What Restore would change: the words now has that this version does not are struck.
		await expect(
			preview.locator("del", { hasText: "Albertina" }),
		).toBeVisible();
		// The newest moment shows only its own changes and says it is now.
		await options.nth(0).click();
		await expect(region.getByTestId("history-compare-now")).toHaveCount(0);
		await expect(region).toContainText("This is how it looks now");
		// The number appears in the fine print and nowhere else.
		await expect(region.getByTestId("history-fine")).toHaveText("Version 3");
	});

	test("naming a version closes the typing burst: the next edit is a moment of its own, and the name stays on the first (T2)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History naming");
		await seedDocument(conversationId, "History naming", [
			{
				author: "alfy",
				summary: "Alfy wrote the first draft",
				markdown: "Book the hotel.\n\nBook the flight.",
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);

		const editor = page.locator(".document-editor-host .document-content");
		await editor.getByText("Book the flight.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Window seat.");
		await historyButton(page).click();
		const region = historyRegion(page, "History naming");
		const options = region.getByRole("option");
		await expect(options).toHaveCount(2);
		await expect(options.first()).toBeFocused();

		// Tab from the rail reaches the preview toolbar (past the rail's own "Got it" while
		// its hint shows); Name opens a field, Enter saves.
		await page.keyboard.press("Tab");
		await expect(
			region.getByTestId("history-help").getByRole("button"),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(region.getByTestId("history-name")).toBeFocused();
		await page.keyboard.press("Enter");
		const field = region.getByRole("textbox", { name: "Name this version" });
		await expect(field).toBeFocused();
		await expect(field).toHaveAttribute(
			"placeholder",
			"e.g. Before the client call",
		);
		await page.keyboard.type("Before the client call");
		await page.keyboard.press("Enter");

		// The name shows in bold above the headline, with the filter that finds it, and the
		// reader is told the next edits start a new version (the named one is never typed into).
		await expect(options.first()).toContainText("Before the client call");
		await expect(region.getByTestId("history-filter-named")).toBeVisible();
		await expect(region).toContainText("Your next edits start a new version.");
		await expect(page.getByTestId("artifact-history-live")).toContainText(
			"Named “Before the client call”",
		);

		// Back to the Document, type again: a new version, so two "You edited" moments.
		await doneButton(page).click();
		await expect(region).toHaveCount(0);
		await editor.getByText("Window seat.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Aisle.");
		await historyButton(page).click();
		await expect(options).toHaveCount(3);
		await expect(options.nth(0)).toContainText("You edited");
		await expect(options.nth(0)).not.toContainText("Before the client call");
		await expect(options.nth(1)).toContainText("You edited");
		await expect(options.nth(1)).toContainText("Before the client call");
		await expect(region.getByTestId("history-preview")).toContainText("Aisle.");

		// The Named filter lists only the named one; the name goes again from the toolbar.
		await region.getByTestId("history-filter-named").click();
		await expect(options).toHaveCount(1);
		await options.first().click();
		await region.getByTestId("history-remove-name").click();
		await expect(region.getByTestId("history-filter-named")).toHaveCount(0);
		await expect(options).toHaveCount(3);
	});

	test("restores what was typed a moment ago as the moment before the restore, with no conflict (T5)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History restore");
		await seedDocument(conversationId, "History restore", [
			{
				author: "alfy",
				summary: "Alfy wrote the first draft",
				markdown: "Book the hotel.\n\nBook the flight.",
			},
			{
				// Alfy's, so the reader's typing is a version of its own (the reader's
				// own version less than ten minutes old takes their typing into itself).
				author: "alfy",
				summary: "Added a window seat",
				markdown: "Book the hotel.\n\nBook the flight. Window seat.",
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);

		const editor = page.locator(".document-editor-host .document-content");
		await editor.getByText("Window seat.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Aisle.");
		// Straight to History and a restore: the autosave's delay has not passed.
		await historyButton(page).click();
		const region = historyRegion(page, "History restore");
		const options = region.getByRole("option");
		await expect(options).toHaveCount(3);
		await options.last().click();
		await region.getByTestId("history-restore").click();
		await expect(region.getByTestId("history-restore-question")).toContainText(
			"What you have now stays in History.",
		);
		// Escape closes the question first, and the focus goes back to the button that opened it.
		await page.keyboard.press("Escape");
		await expect(region.getByTestId("history-restore-question")).toHaveCount(0);
		await expect(region.getByTestId("history-restore")).toBeFocused();
		await region.getByTestId("history-restore").click();
		await region.getByTestId("history-restore-confirm").click();

		// The typed step is the moment right before the restore, and nothing was refused.
		await expect(options.nth(0)).toContainText("You restored");
		await expect(options.nth(1)).toContainText("You edited");
		await expect(page.getByTestId("history-toast")).toContainText("Restored");
		await doneButton(page).click();
		await expect(page.locator(".document-save-banner")).toHaveCount(0);
		// The Document shows what was restored, and the next edit is not refused as stale.
		await expect(editor).toContainText("Book the flight.");
		await expect(editor).not.toContainText("Window seat.");
		await editor.getByText("Book the flight.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Exit row.");
		await expect(editor).toContainText("Exit row.");
		await expect(page.locator(".document-save-banner")).toHaveCount(0);
	});

	test("answers a restore that something else outran inline, and lets the reader ask again", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History moved");
		const artifactId = await seedDocument(conversationId, "History moved", [
			{
				author: "alfy",
				summary: "Alfy wrote the first draft",
				markdown: "Book the hotel.",
			},
			{
				author: "user",
				summary: "Edited",
				markdown: "Book the hotel. Late checkout.",
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);
		await historyButton(page).click();
		const region = historyRegion(page, "History moved");
		const options = region.getByRole("option");
		await expect(options).toHaveCount(2);
		await options.last().click();
		await region.getByTestId("history-restore").click();

		// Another writer (another tab) lands a version while the question is open.
		await updateArtifactBody({
			userId: await adminId(),
			artifactId,
			conversationId,
			body: "Book the hotel. Late checkout. Breakfast.",
			author: "alfy",
			summary: "Added breakfast",
		});
		await region.getByTestId("history-restore-confirm").click();
		await expect(region.getByTestId("history-restore-question")).toContainText(
			"It changed while you were looking. Here's the latest.",
		);
		// The rail shows the latest, and asking again restores over it.
		await expect(options).toHaveCount(3);
		await expect(options.first()).toContainText("Added breakfast");
		await region.getByTestId("history-restore-confirm").click();
		await expect(page.getByTestId("history-toast")).toContainText("Restored");
		await expect(options.first()).toContainText("You restored");
	});
});

test.describe("History mode on a phone", () => {
	test.use({ hasTouch: true });

	test("is a sheet: tap a moment, see its preview, step through the moments, go back, close (T4)", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
		const conversationId = await createConversation(page, "History phone");
		await seedDocument(conversationId, "History phone", THREE_VERSIONS);
		await openChat(page, conversationId);

		// Open the Document in the panel the way a phone does.
		await page.getByTestId("artifact-count-button-compact").tap();
		await page
			.getByTestId("artifact-panel-list-mobile")
			.getByTestId("artifact-row")
			.first()
			.tap({ timeout: 30_000 });
		const button = historyButton(page);
		await expect(button).toBeVisible({ timeout: 30_000 });
		const buttonBox = await button.boundingBox();
		expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(24);

		await button.tap();
		const sheet = page.getByRole("dialog", { name: "History" });
		await expect(sheet).toBeVisible();
		const options = sheet.getByRole("option");
		await expect(options).toHaveCount(3);
		// Every moment is at least 56 px tall.
		for (let i = 0; i < 3; i++) {
			const box = await options.nth(i).boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
		}

		// Tap a moment: its preview is pushed inside the sheet, with a way back.
		await options.nth(1).tap();
		const preview = sheet.getByTestId("history-preview");
		await expect(preview).toBeVisible();
		await expect(preview).toContainText("then a cafe");
		await expect(preview).not.toContainText("The museum.");
		const back = sheet.getByRole("button", { name: "History" });
		await expect(back).toBeVisible();
		// The bottom bar steps between moments; its targets are 44 px.
		const older = sheet.getByRole("button", { name: "Previous version" });
		const newer = sheet.getByRole("button", { name: "Next version" });
		for (const control of [older, newer]) {
			const box = await control.boundingBox();
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
		await newer.tap();
		await expect(preview).toContainText("The museum.");
		await older.tap();
		await older.tap();
		await expect(preview).not.toContainText("then a cafe");

		// Restore: the question replaces the bottom bar, its buttons are 44 px.
		await sheet.getByTestId("history-restore").tap();
		const question = sheet.getByTestId("history-restore-question");
		await expect(question).toBeVisible();
		await expect(sheet.getByTestId("history-restore")).toHaveCount(0);
		for (const control of [
			sheet.getByTestId("history-restore-cancel"),
			sheet.getByTestId("history-restore-confirm"),
		]) {
			const box = await control.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
		await sheet.getByTestId("history-restore-cancel").tap();
		await expect(question).toHaveCount(0);
		await expect(sheet.getByTestId("history-restore")).toBeVisible();

		// The back gesture leaves the preview first, then the sheet.
		await page.keyboard.press("Escape");
		await expect(
			sheet.getByRole("listbox", { name: "Versions" }),
		).toBeVisible();
		await expect(preview).toHaveCount(0);
		await sheet.getByRole("option").nth(1).tap();
		await expect(preview).toBeVisible();
		await back.tap();
		await expect(
			sheet.getByRole("listbox", { name: "Versions" }),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(sheet).toHaveCount(0);
	});
});
