import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	applyArtifactOps,
	createArtifact,
	createDocumentArtifact,
	getKv,
	listVersions,
	setKv,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import {
	madeAppSummary,
	regeneratedAppSummary,
	undidAlfyChangeSummary,
	VERSION_SUMMARY,
} from "../../src/lib/shared/artifacts/version-summaries";
import { openCanvasPanel, openChatAndReload } from "./artifact-canvas-helpers";
import {
	createConversation,
	login,
	waitForHydration,
	workspacePanel,
} from "./helpers";

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

// ---- The board and the App in History (VB-3) -------------------------------------

function boardNote(
	id: string,
	x: number,
	y: number,
	text: string,
	parentId?: string,
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 180,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

/** A weekend board: Saturday's frame with a lunch in it, the museum and a dinner beside it. */
function weekendBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "frame-saturday",
				type: "frame",
				position: { x: 20, y: 20 },
				width: 320,
				height: 240,
				data: { kind: "frame", label: "Saturday", width: 320, height: 240 },
			},
			boardNote("note-lunch", 24, 64, "Lunch at the market", "frame-saturday"),
			boardNote("note-museum", 420, 40, "Museum, 14:00"),
			boardNote("note-dinner", 420, 200, "Dinner, 19:30"),
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

/** What Alfy plans for Sunday: a new frame with a note in it, and the museum moved. */
const PLAN_SUNDAY = [
	{
		op: "add_frame",
		id: "frame-sunday",
		label: "Sunday",
		position: { x: 20, y: 320 },
		size: { width: 320, height: 200 },
	},
	{
		op: "add_node",
		node: {
			id: "note-brunch",
			type: "sticky",
			parentId: "frame-sunday",
			position: { x: 20, y: 60 },
			data: { kind: "sticky", text: "Brunch, 10:30", tone: "mint" },
		},
	},
	{ op: "move", id: "note-museum", to: { x: 470, y: 100 } },
];

test.describe("History mode: a board", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("an Alfy change undone on the review bar folds in History, its preview rings what it touched, and Restore brings it back (T7)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History board");
		const userId = await adminId();
		const created = await createArtifact({
			userId,
			conversationId,
			kind: "canvas",
			title: "History board",
			body: boardJson(weekendBoard()),
			author: "alfy",
			versionSummary: VERSION_SUMMARY.alfyFirstDraft,
		});
		if (!created.ok) throw new Error(created.reason);
		const artifactId = created.artifact.id;
		const [newest] = await listVersions({
			userId,
			artifactId,
			conversationId,
			limit: 1,
		});
		const applied = await applyArtifactOps({
			userId,
			artifactId,
			conversationId,
			payload: {
				baseVersionId: newest.id,
				diff: { id: "d", summary: "Planned Sunday", ops: PLAN_SUNDAY },
			},
		});
		if (!applied.ok) throw new Error(applied.reason);

		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);
		// Alfy's change waits on the review bar; the reader takes it back with a click.
		const bar = page.getByTestId("canvas-review-bar");
		await expect(bar).toBeVisible();
		await bar.getByRole("button", { name: /^Undo/ }).click();
		await expect(
			page.locator('.svelte-flow__node[data-id="note-brunch"]'),
		).toHaveCount(0);

		// The header opens History: Alfy's change and the Undo that took it back are ONE moment.
		await historyButton(page).click();
		const region = historyRegion(page, "History board");
		await expect(region).toBeVisible();
		const options = region.getByRole("option");
		await expect(options).toHaveCount(3);
		await expect(options.nth(0)).toContainText("Planned Sunday");
		await expect(options.nth(0)).toContainText("Undone");
		await expect(options.nth(1)).toContainText("You undid it");
		await expect(options.nth(2)).toContainText("Alfy made the board");
		// Nothing prints a version number but the fine print.
		await expect(historyButton(page)).not.toContainText(/\bv\d/);

		// Its preview is the board as Alfy left it, with what it touched ringed and tagged.
		const preview = region.getByTestId("history-preview");
		await expect(preview).toBeVisible();
		await expect(
			preview.locator('.svelte-flow__node[data-id="note-brunch"]'),
		).toBeVisible();
		await expect(preview.getByTestId("canvas-history-ring")).toHaveCount(3);
		// In the board's own order: the museum was there before the new frame and its note.
		await expect(preview.getByTestId("canvas-history-tag")).toHaveText([
			"Moved",
			"New",
			"New",
		]);
		await expect(preview.getByTestId("canvas-history-trail")).toHaveCount(1);
		// Alfy's own colour: the layer says whose change it is.
		await expect(
			preview.locator('[data-testid="canvas-history-layer"][data-tone="alfy"]'),
		).toHaveCount(1);
		await expect(region.getByTestId("history-change-count")).toHaveText(
			"1 / 3",
		);
		// Read-only: no toolbar to change it with, and a drag on a block moves nothing.
		await expect(preview.getByTestId("canvas-tool-select")).toHaveCount(0);

		// The changes are a list of buttons a keyboard reaches: each says what happened to which block.
		const changes = preview.getByTestId("history-board-changes");
		await expect(changes.getByRole("button")).toHaveText([
			"Museum, 14:00, moved",
			"Sunday, added",
			"Brunch, 10:30, added",
		]);

		// The version before it: nothing to compare with, so the board shows with no marks.
		await options.last().click();
		await expect(preview.getByTestId("canvas-history-ring")).toHaveCount(0);
		await expect(
			preview.locator('.svelte-flow__node[data-id="note-lunch"]'),
		).toBeVisible();
		await expect(
			preview.locator('.svelte-flow__node[data-id="note-brunch"]'),
		).toHaveCount(0);

		// Compared with now, Alfy's version has what Restore would bring back.
		await options.first().click();
		await region.getByTestId("history-compare-now").click();
		await expect(preview.getByTestId("canvas-history-ring")).toHaveCount(3);
		await expect(
			preview.locator('[data-testid="canvas-history-layer"][data-tone="user"]'),
		).toHaveCount(1);
		await region.getByTestId("history-compare-step").click();

		// Restore: the question names the version by its time, never "text".
		await region.getByTestId("history-restore").click();
		const question = region.getByTestId("history-restore-question");
		await expect(question).toContainText("What you have now stays in History.");
		await expect(question).not.toContainText(/text/i);
		await region.getByTestId("history-restore-confirm").click();
		await expect(page.getByTestId("history-toast")).toContainText("Restored");
		await expect(options.first()).toContainText("You restored");

		// Done: the board is Alfy's again, and the next step is saved, not refused as stale.
		await doneButton(page).click();
		await expect(region).toHaveCount(0);
		await expect(
			page.locator('.svelte-flow__node[data-id="note-brunch"]'),
		).toBeVisible();
		await expect(page.getByTestId("canvas-save-status")).not.toContainText(
			"conflict",
		);
	});
});

// ---- An App in History (VB-3, T6) ------------------------------------------------

/**
 * The App's first version, written to be hostile: it reads today's saved data the
 * way an App does, and when it finds it is running as a PREVIEW (the version route's
 * address, which a live App's is not) it skips its own bridge and posts a raw
 * `alfy.storage` set to its parent, as an old version of an App can. The preview
 * must show it running and must change nothing. (Run live, as the App it was, it
 * does nothing of the kind: it was the App for a while, and what it wrote then is
 * its own.)
 */
const FIRST_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Trip budget</title></head>
<body>
<h1 data-testid="app-heading">Trip budget, first version</h1>
<p id="today" data-testid="app-today">reading…</p>
<script>
(async function () {
  try {
    var value = await window.alfy.storage.get('mood');
    document.getElementById('today').textContent = 'today: ' + String(value);
  } catch (error) {
    document.getElementById('today').textContent = 'blocked';
  }
  if (location.pathname.indexOf('/versions/') !== -1) {
    parent.postMessage({ v: 1, kind: 'alfy.storage', method: 'set', id: 9001, args: ['mood', 'overwritten'] }, '*');
    document.getElementById('today').setAttribute('data-posted', 'yes');
  }
})();
</script>
</body>
</html>`;

const SECOND_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Trip budget</title></head>
<body>
<h1 data-testid="app-heading">Trip budget, second version</h1>
<p id="today" data-testid="app-today">now with a total</p>
<p data-testid="app-total">Total: 364</p>
</body>
</html>`;

/** A version the current rules forbid (it sends its own document away): it can no longer run, and Code still shows it. */
const RUNAWAY_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Trip budget</title></head>
<body>
<h1>Trip budget, runaway</h1>
<script>
setTimeout(function () { window.location.href = "/login"; }, 800);
</script>
</body>
</html>`;

/** An App with the given versions in order (the first is its v1) and one saved value, `mood`, which is today's. */
async function seedApp(
	conversationId: string,
	title: string,
	versions: Array<{ html: string; summary: string }>,
): Promise<string> {
	const userId = await adminId();
	const [first, ...rest] = versions;
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "app",
		title,
		body: first.html,
		author: "alfy",
		versionSummary: first.summary,
	});
	if (!created.ok) throw new Error(created.reason);
	for (const version of rest) {
		await updateArtifactBody({
			userId,
			artifactId: created.artifact.id,
			conversationId,
			body: version.html,
			author: "alfy",
			summary: version.summary,
		});
	}
	await setKv({
		userId,
		artifactId: created.artifact.id,
		conversationId,
		key: "mood",
		valueJson: JSON.stringify("calm"),
	});
	return created.artifact.id;
}

test.describe("History mode: an App", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("a rebuilt App's first version runs in History with its storage read-only, its Code shows the difference, and Restore brings it back (T6)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History app");
		const artifactId = await seedApp(conversationId, "Trip budget", [
			{
				html: FIRST_APP_HTML,
				summary: madeAppSummary("a trip budget with a total"),
			},
		]);
		const userId = await adminId();

		// What a rebuild does on the server, run when the panel asks for one: the panel's
		// own button and popover are the real thing, the model call is not.
		await page.route("**/api/artifacts/*/app/regenerate", async (route) => {
			await updateArtifactBody({
				userId,
				artifactId,
				conversationId,
				body: SECOND_APP_HTML,
				author: "alfy",
				summary: regeneratedAppSummary("add a total"),
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					version: 2,
					title: "Trip budget",
					verification: { checked: false, verdict: "clean", reason: null },
				}),
			});
		});
		// Nothing a preview does may write the App's saved data: every call the page
		// makes to the storage route that is not a read is watched.
		const writes: string[] = [];
		page.on("request", (request) => {
			if (
				/\/api\/artifacts\/[^/]+\/app\/kv/.test(request.url()) &&
				request.method() !== "GET"
			) {
				writes.push(`${request.method()} ${request.url()}`);
			}
		});

		await openChat(page, conversationId);
		await openDocumentInPanel(page);

		// The rebuild's own words carry no version numbers, and say where the old one stays.
		await page.getByRole("button", { name: /Change this app/ }).click();
		await expect(
			page.getByText("The previous version stays in History."),
		).toBeVisible();
		await page.getByLabel("What should change?").fill("add a total");
		await page.getByRole("button", { name: "Rebuild" }).click();
		const toast = page.getByText("Alfy rebuilt it");
		await expect(toast).toBeVisible();
		await expect(historyButton(page)).toContainText("Rebuilt by Alfy");
		await expect(historyButton(page)).not.toContainText(/\bv\d/);

		// History: two moments; the first version is the one that stored the hostile code.
		await historyButton(page).click();
		const region = historyRegion(page, "Trip budget");
		await expect(region).toBeVisible();
		const options = region.getByRole("option");
		await expect(options).toHaveCount(2);
		await expect(options.first()).toContainText("add a total");
		await options.last().click();

		// Preview: that version RUNNING, in the same sandbox, against today's saved data.
		const preview = region.getByTestId("history-app-preview");
		await expect(preview.getByTestId("history-app-runs")).toHaveText(
			"Runs with today's saved data; changes aren't saved.",
		);
		const frame = preview.locator("iframe");
		await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms");
		await expect(frame).toHaveAttribute(
			"src",
			new RegExp(
				`/api/artifacts/${artifactId}/versions/[^/]+/app(\\?conversationId=[^&]+)?$`,
			),
		);
		const inFrame = preview.frameLocator("iframe");
		await expect(inFrame.getByTestId("app-heading")).toHaveText(
			"Trip budget, first version",
		);
		await expect(inFrame.getByTestId("app-today")).toHaveText("today: calm");
		// The hostile version posted a raw write to its parent as soon as it had read (the
		// attribute says it did): the parent refused it, so today's saved data is what it
		// was and no call was made.
		await expect(inFrame.getByTestId("app-today")).toHaveAttribute(
			"data-posted",
			"yes",
		);
		await page.waitForTimeout(600);
		expect(writes).toEqual([]);
		expect(
			await getKv({ userId, artifactId, conversationId, key: "mood" }),
		).toBe(JSON.stringify("calm"));

		// Code: the lines this version has that now does not, and the lines it lost.
		await region.getByTestId("history-app-tab-code").click();
		const code = region.getByTestId("history-app-code");
		await expect(
			code.locator(".line-add", { hasText: "first version" }),
		).toBeVisible();
		await expect(
			code.locator(".line-del", { hasText: "second version" }),
		).toBeVisible();
		await expect(region.getByTestId("history-change-count")).toContainText(
			"1 /",
		);
		// The next version selected comes up on the tab the reader was reading.
		await options.first().click();
		await expect(region.getByTestId("history-app-code")).toBeVisible();
		await options.last().click();
		await expect(region.getByTestId("history-app-code")).toBeVisible();
		await region.getByTestId("history-app-tab-preview").click();

		// Restore: the question says what stays as it is, then the old version runs again.
		await region.getByTestId("history-restore").click();
		const question = region.getByTestId("history-restore-question");
		await expect(question).toContainText("What you have now stays in History.");
		await expect(question).toContainText("Saved data stays as it is now.");
		await region.getByTestId("history-restore-confirm").click();
		await expect(page.getByTestId("history-toast")).toContainText("Restored");
		await expect(options.first()).toContainText("You restored");
		await doneButton(page).click();
		await expect(region).toHaveCount(0);
		await expect(
			page.frameLocator("iframe.app-frame").getByTestId("app-heading"),
		).toHaveText("Trip budget, first version");
		expect(writes).toEqual([]);
		expect(
			await getKv({ userId, artifactId, conversationId, key: "mood" }),
		).toBe(JSON.stringify("calm"));
	});

	test("a version the rules now forbid is Code only: the reader is told, and the code is there (T6)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History runaway");
		await seedApp(conversationId, "Trip budget", [
			{
				html: SECOND_APP_HTML,
				summary: madeAppSummary("a trip budget"),
			},
			{
				html: RUNAWAY_APP_HTML,
				summary: regeneratedAppSummary("make it dramatic"),
			},
			{
				html: FIRST_APP_HTML.replace("first version", "third"),
				summary: regeneratedAppSummary("calm it down"),
			},
		]);
		await openChat(page, conversationId);
		await openDocumentInPanel(page);
		await historyButton(page).click();
		const region = historyRegion(page, "Trip budget");
		const options = region.getByRole("option");
		await expect(options).toHaveCount(3);

		// The middle version cannot run now: Preview is out, Code is the view, and it says why.
		await options.nth(1).click();
		await expect(region.getByTestId("history-app-code-only")).toHaveText(
			"This version can't run any more, so only its code is shown.",
		);
		await expect(region.getByTestId("history-app-tab-preview")).toBeDisabled();
		const code = region.getByTestId("history-app-code");
		await expect(code).toContainText("window.location.href");
		await expect(region.locator("iframe")).toHaveCount(0);

		// Another version runs, and comes up on Preview again.
		await options.nth(2).click();
		await expect(region.getByTestId("history-app-code-only")).toHaveCount(0);
		await expect(region.getByTestId("history-app-tab-preview")).toBeEnabled();
		await expect(
			region
				.getByTestId("history-app-preview")
				.frameLocator("iframe")
				.getByTestId("app-heading"),
		).toHaveText("Trip budget, second version");
	});

	test("the toast's Undo takes the rebuild back as one moment with it, and History says so (T6)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History undo app");
		const artifactId = await seedApp(conversationId, "Trip budget", [
			{ html: FIRST_APP_HTML, summary: madeAppSummary("a trip budget") },
		]);
		const userId = await adminId();
		await page.route("**/api/artifacts/*/app/regenerate", async (route) => {
			await updateArtifactBody({
				userId,
				artifactId,
				conversationId,
				body: SECOND_APP_HTML,
				author: "alfy",
				summary: regeneratedAppSummary("add a total"),
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					version: 2,
					title: "Trip budget",
					verification: { checked: false, verdict: "clean", reason: null },
				}),
			});
		});
		await openChat(page, conversationId);
		await openDocumentInPanel(page);
		await page.getByRole("button", { name: /Change this app/ }).click();
		await page.getByLabel("What should change?").fill("add a total");
		await page.getByRole("button", { name: "Rebuild" }).click();
		await expect(page.getByText("Alfy rebuilt it")).toBeVisible();
		await page.getByRole("button", { name: "Undo" }).click();
		await expect(
			page.frameLocator("iframe.app-frame").getByTestId("app-heading"),
		).toHaveText("Trip budget, first version");

		await historyButton(page).click();
		const region = historyRegion(page, "Trip budget");
		const options = region.getByRole("option");
		// The rebuild and the Undo that took it back are one moment (with the Undo as its step),
		// and the version they were made from is the other.
		await expect(options).toHaveCount(3);
		await expect(options.nth(0)).toContainText("add a total");
		await expect(options.nth(1)).toContainText("You undid it");
		await expect(options.nth(2)).toContainText("Alfy built the app");
	});
});

// ---- The library's last version number (VB-3) -------------------------------------

test.describe("The library says what changed last", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("an artifact row's Version cell says who changed it and when, never a number (ruling 76, Q2)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Library moments");
		await seedDocument(conversationId, "Library plan reader", [
			{
				author: "alfy",
				summary: "Alfy wrote the first draft",
				markdown: "Friday\n\nArrive.",
			},
			{
				author: "user",
				summary: "Edited",
				markdown: "Friday\n\nArrive early.",
			},
		]);
		await seedDocument(conversationId, "Library plan alfy", [
			{
				author: "alfy",
				summary: "Alfy wrote the first draft",
				markdown: "Friday\n\nArrive.",
			},
			{
				author: "alfy",
				summary: "Moved the museum to Thursday",
				markdown: "Friday\n\nArrive.\n\nThursday\n\nThe museum.",
			},
		]);

		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.getByRole("tab", { name: "Documents" }).click();

		const readerRow = page.locator("tbody tr", {
			hasText: "Library plan reader",
		});
		await expect(readerRow.locator(".col-version")).toContainText(
			"Edited by you",
		);
		await expect(readerRow.locator(".col-version")).toContainText(
			/just now|min ago/,
		);
		const alfyRow = page.locator("tbody tr", { hasText: "Library plan alfy" });
		await expect(alfyRow.locator(".col-version")).toContainText(
			"Changed by Alfy",
		);
		// No number anywhere in either row's Version cell.
		for (const row of [readerRow, alfyRow]) {
			await expect(row.locator(".col-version")).not.toContainText(/\bv\d/);
		}
	});
});

test.describe("History mode on a phone: an App and a board", () => {
	test.use({ hasTouch: true });

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
	});

	async function openSheet(page: Page, conversationId: string) {
		await openChat(page, conversationId);
		await page.getByTestId("artifact-count-button-compact").tap();
		await page
			.getByTestId("artifact-panel-list-mobile")
			.getByTestId("artifact-row")
			.first()
			.tap({ timeout: 30_000 });
		await expect(historyButton(page)).toBeVisible({ timeout: 30_000 });
		await historyButton(page).tap();
		const sheet = page.getByRole("dialog", { name: "History" });
		await expect(sheet).toBeVisible();
		return sheet;
	}

	test("an App's preview runs in the sheet, and its tabs and folds are 44 px targets (T6)", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "History app phone");
		// A source whose top is the same in both versions (so there is a fold) and whose
		// bottom is all different (so the difference is taller than the sheet).
		const longApp = (heading: string, word: string) =>
			`<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Trip budget</title></head>\n<body>\n<h1 data-testid="app-heading">${heading}</h1>\n${Array.from(
				{ length: 24 },
				(_, index) => `<p>Line ${index + 1} of the budget</p>`,
			).join("\n")}\n${Array.from(
				{ length: 30 },
				(_, index) => `<p>${word} number ${index + 1}</p>`,
			).join("\n")}\n</body>\n</html>`;
		await seedApp(conversationId, "Trip budget", [
			{
				html: longApp("Trip budget, long first", "Old"),
				summary: madeAppSummary("a trip budget"),
			},
			{
				html: longApp("Trip budget, long second", "New"),
				summary: regeneratedAppSummary("rename it"),
			},
		]);
		const sheet = await openSheet(page, conversationId);
		await sheet.getByRole("option").last().tap();

		// The first version runs in the frame, with the note, inside the sheet.
		const preview = sheet.getByTestId("history-app-preview");
		await expect(preview.getByTestId("history-app-runs")).toBeVisible();
		const frame = preview.locator("iframe");
		await expect(frame).toBeVisible();
		expect((await frame.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
			150,
		);
		await expect(
			preview.frameLocator("iframe").getByTestId("app-heading"),
		).toHaveText("Trip budget, long first");

		// The tabs are targets a finger can hit.
		for (const tab of [
			sheet.getByTestId("history-app-tab-preview"),
			sheet.getByTestId("history-app-tab-code"),
		]) {
			expect((await tab.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
		await sheet.getByTestId("history-app-tab-code").tap();
		const code = sheet.getByTestId("history-app-code");
		await expect(code).toBeVisible();
		await expect(code.locator(".line-add, .line-del").first()).toBeVisible();
		// The difference is taller than the panel, and the panel scrolls to its last line.
		expect(
			await code.evaluate((el) => el.scrollHeight - el.clientHeight),
		).toBeGreaterThan(100);
		await code.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(code.locator(".line").last()).toBeInViewport();
		await expect(
			code.locator(".line-add", { hasText: "Old number 30" }),
		).toBeInViewport();
		const folds = await sheet.getByTestId("history-fold").all();
		expect(folds.length).toBeGreaterThan(0);
		for (const fold of folds) {
			expect((await fold.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
				44,
			);
		}
		// Nothing is wider than the sheet.
		const widths = await page.evaluate(() => ({
			page: document.documentElement.scrollWidth,
			view: window.innerWidth,
		}));
		expect(widths.page).toBeLessThanOrEqual(widths.view);
	});

	test("a board's preview fits the sheet, ringed and tagged, and a tap on it changes nothing (T7)", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"History board phone",
		);
		const userId = await adminId();
		const created = await createArtifact({
			userId,
			conversationId,
			kind: "canvas",
			title: "History board phone",
			body: boardJson(weekendBoard()),
			author: "alfy",
			versionSummary: VERSION_SUMMARY.alfyFirstDraft,
		});
		if (!created.ok) throw new Error(created.reason);
		const [newest] = await listVersions({
			userId,
			artifactId: created.artifact.id,
			conversationId,
			limit: 1,
		});
		const applied = await applyArtifactOps({
			userId,
			artifactId: created.artifact.id,
			conversationId,
			payload: {
				baseVersionId: newest.id,
				diff: { id: "d", summary: "Planned Sunday", ops: PLAN_SUNDAY },
			},
		});
		if (!applied.ok) throw new Error(applied.reason);

		const sheet = await openSheet(page, conversationId);
		await sheet.getByRole("option").first().tap();
		const preview = sheet.getByTestId("history-preview");
		await expect(preview.getByTestId("canvas-history-ring")).toHaveCount(3);
		// Everything marked is inside the sheet's own width.
		const box = await preview.boundingBox();
		for (const ring of await preview.getByTestId("canvas-history-ring").all()) {
			const ringBox = await ring.boundingBox();
			expect(ringBox).not.toBeNull();
			expect((ringBox?.x ?? 0) + (ringBox?.width ?? 0)).toBeLessThanOrEqual(
				(box?.x ?? 0) + (box?.width ?? 0) + 1,
			);
		}
		// A tap on a block selects nothing and the board is not changed: no toolbar, no step.
		await preview.locator('.svelte-flow__node[data-id="note-lunch"]').tap();
		await expect(preview.locator(".svelte-flow__node.selected")).toHaveCount(0);
		await expect(preview.getByTestId("canvas-tool-select")).toHaveCount(0);
		const widths = await page.evaluate(() => ({
			page: document.documentElement.scrollWidth,
			view: window.innerWidth,
		}));
		expect(widths.page).toBeLessThanOrEqual(widths.view);
	});
});
