import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import { createTourUser, markToursSeen } from "./artifact-tours-helpers";
import { login, waitForHydration } from "./helpers";

/**
 * Selecting several chats in the sidebar and acting on them at once, in a real
 * browser: the gestures (a modifier click, Shift-click, "Select" in a row's
 * menu on a phone), the bulk delete, move and pin, and the bar's place and
 * width. Each test makes its own reader, with chats and projects of its own, so
 * there is nothing to put back for the specs that share the worker's database:
 * the language is that reader's, the sidebar's width lives in this test's own
 * browser storage, and the admin and every shared setting are left alone.
 */

// Cmd on macOS, Ctrl elsewhere: the click that adds a chat to a selection.
const MOD = "ControlOrMeta" as const;

// Headless Chromium hides every scrollbar, and the list's own (8 px, beside the
// rows) takes room from the bar that a reader with a mouse has: with it hidden
// the width checks below would be easier than the real thing. Top-level because
// launchOptions forces its own worker and Playwright rejects it inside a
// describe group.
test.use({
	launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

// The app asks for `scrollbar-width: thin` and a `scrollbar-color` on everything,
// which on macOS gives an overlay scrollbar that takes no room even with the flag
// above, and Chromium then ignores the app's own `::-webkit-scrollbar { width: 8px }`.
// Reset on the list, that rule is the one that applies: the 8 px scrollbar a
// reader on Windows or Linux, or with a mouse, has beside the rows.
const CLASSIC_LIST_SCROLLBAR = `[data-testid="sidebar-scroll"] { scrollbar-width: auto; scrollbar-color: auto; }`;

/**
 * A chat the sidebar lists (one with no messages is not), `secondsAgo` old: the
 * newest chat is the first row, so a test can name a row by where it sits.
 */
async function seedChat(
	userId: string,
	title: string,
	secondsAgo: number,
): Promise<string> {
	const id = randomUUID();
	const at = new Date(Date.now() - secondsAgo * 1000);
	await db.insert(conversations).values({
		id,
		userId,
		title,
		createdAt: at,
		updatedAt: at,
	});
	await db.insert(messages).values([
		{
			id: `${id}-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: title,
			createdAt: at,
		},
		{
			id: `${id}-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "Noted.",
			createdAt: at,
		},
	]);
	return id;
}

/** The sidebar is the page's own panel from 1024 px up, and a drawer below it. */
function hasDockedSidebar(page: Page): boolean {
	return (page.viewportSize()?.width ?? 1280) >= 1024;
}

/**
 * A docked sidebar starts as a rail in a fresh browser: opens it, by the name its
 * button has in the reader's language (`ensureSidebarExpanded` knows only English).
 */
async function expandDockedSidebar(page: Page, language: "en" | "hu") {
	await page
		.locator("aside.transitions-enabled")
		.waitFor({ state: "visible", timeout: 5000 });
	const expand = page.getByRole("button", {
		name: language === "hu" ? "Oldalsáv kibontása" : "Expand sidebar",
	});
	if (await expand.isVisible().catch(() => false)) await expand.click();
}

/**
 * A reader with these chats, newest first, signed in on the home page. With a
 * project the bar has all five buttons (Move is there only when there is a
 * project to move to): the widest it gets.
 */
async function startWithChats(
	page: Page,
	titles: string[],
	language: "en" | "hu" = "en",
	options: { project?: string } = {},
) {
	const user = await createTourUser(language);
	await markToursSeen(user);
	if (options.project) await createProject(user.id, options.project);
	const ids: string[] = [];
	for (const [index, title] of titles.entries()) {
		ids.push(await seedChat(user.id, title, index));
	}
	await login(page, user.email, user.password);
	if (hasDockedSidebar(page)) await expandDockedSidebar(page, language);
	await expect(chatRow(page, titles[0])).toBeVisible();
	return { user, ids };
}

function chatRow(page: Page, title: string): Locator {
	return page.getByTestId("conversation-item").filter({ hasText: title });
}

function selectionCount(page: Page): Locator {
	return page.getByTestId("selection-count");
}

/** The header's button that opens the drawer, named in the reader's language. */
async function openPhoneSidebar(page: Page, toggleName = "Toggle sidebar") {
	await page.getByRole("button", { name: toggleName }).click();
	await expect(page.locator("aside.sidebar-panel")).toBeVisible();
}

type Extent = { scroll: number; client: number };

/** The bar on one line, nothing of it or of its count cut off. */
async function expectBarOnOneLine(page: Page) {
	const bar = page.getByTestId("sidebar-selection-bar");
	const barExtent: Extent = await bar.evaluate((element) => ({
		scroll: element.scrollWidth,
		client: element.clientWidth,
	}));
	expect(
		barExtent.scroll,
		"the bar does not overflow its width",
	).toBeLessThanOrEqual(barExtent.client);
	const countExtent: Extent = await selectionCount(page).evaluate(
		(element) => ({
			scroll: element.scrollWidth,
			client: element.clientWidth,
		}),
	);
	expect(countExtent.scroll, "the count is not cut off").toBeLessThanOrEqual(
		countExtent.client,
	);
	// Every button on one row: nothing wrapped under the rest.
	const tops = await bar
		.getByRole("button")
		.evaluateAll((buttons) =>
			buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
		);
	expect(new Set(tops).size, "the buttons share one line").toBe(1);
}

/** The bar lies inside the part of the list that can be seen. */
async function expectBarInView(page: Page, where: string) {
	const scroller = await page.getByTestId("sidebar-scroll").boundingBox();
	const bar = await page.getByTestId("sidebar-selection-bar").boundingBox();
	if (!scroller || !bar) throw new Error("no box for the list or the bar");
	expect(
		bar.y,
		`${where}: the bar starts inside the list`,
	).toBeGreaterThanOrEqual(scroller.y - 0.5);
	expect(
		bar.y + bar.height,
		`${where}: the bar ends inside the list`,
	).toBeLessThanOrEqual(scroller.y + scroller.height + 0.5);
}

async function scrollListTo(page: Page, position: "top" | "bottom") {
	await page.getByTestId("sidebar-scroll").evaluate((element, to) => {
		element.scrollTop = to === "top" ? 0 : element.scrollHeight;
	}, position);
}

test.describe("selecting chats in the sidebar", () => {
	test("selects chats with a modifier click and deletes them after confirming", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);

		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		await expect(selectionCount(page)).toHaveText("2 selected");

		await page.getByTestId("selection-delete").click();
		await expect(page.getByRole("dialog")).toContainText("Delete 2 chats?");
		await page.getByTestId("confirm-delete").click();

		await expect(chatRow(page, "Alpha plan")).toHaveCount(0);
		await expect(chatRow(page, "Bravo plan")).toHaveCount(0);
		await expect(chatRow(page, "Charlie plan")).toHaveCount(1);
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);

		await page.reload();
		await waitForHydration(page);
		await expect(chatRow(page, "Charlie plan")).toBeVisible();
		await expect(chatRow(page, "Alpha plan")).toHaveCount(0);
		await expect(chatRow(page, "Bravo plan")).toHaveCount(0);
	});

	test("opens the delete dialog on Cancel, so a second Enter deletes nothing", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });

		// Enter on the bar's Delete, then the Enter a held key goes on sending.
		await page.getByTestId("selection-delete").focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Delete 2 chats?");
		await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
		await page.keyboard.press("Enter");

		// It was Cancel that took it: the dialog is gone, the chats and the
		// selection are as they were, and the focus is back on Delete.
		await expect(dialog).toHaveCount(0);
		await expect(selectionCount(page)).toHaveText("2 selected");
		await expect(page.getByTestId("selection-delete")).toBeFocused();
		await expect(chatRow(page, "Alpha plan")).toBeVisible();
		await expect(chatRow(page, "Bravo plan")).toBeVisible();
	});

	test("selects a range with Shift-click in sidebar order", async ({
		page,
	}) => {
		await startWithChats(page, [
			"Alpha plan",
			"Bravo plan",
			"Charlie plan",
			"Delta plan",
		]);

		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Charlie plan").click({ modifiers: ["Shift"] });

		await expect(selectionCount(page)).toHaveText("3 selected");
		for (const title of ["Alpha plan", "Bravo plan", "Charlie plan"]) {
			await expect(chatRow(page, title)).toHaveAttribute(
				"data-selected",
				"true",
			);
		}
		await expect(chatRow(page, "Delta plan")).toHaveAttribute(
			"data-selected",
			"false",
		);
	});

	test("lets Shift-click extend the text selection inside the rename field", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan"]);

		await chatRow(page, "Alpha plan").click({ button: "right" });
		await page.getByTestId("rename-option").click();
		const input = page.getByTestId("title-input");
		await expect(input).toBeFocused();
		// The caret at the start, nothing selected (the field opens with it all selected).
		await input.press("Home");
		expect(
			await input.evaluate(
				(field: HTMLInputElement) => field.selectionEnd - field.selectionStart,
			),
		).toBe(0);

		// Shift-click at the far end of the field: the selection runs to it.
		const box = await input.boundingBox();
		if (!box) throw new Error("no box for the rename field");
		await input.click({
			modifiers: ["Shift"],
			position: { x: box.width - 4, y: box.height / 2 },
		});

		expect(
			await input.evaluate(
				(field: HTMLInputElement) => field.selectionEnd - field.selectionStart,
			),
		).toBe("Alpha plan".length);
	});

	test("moves a selection into a project and back", async ({ page }) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);
		const created = await page.request.post("/api/projects", {
			data: { name: "Trips" },
		});
		expect(created.ok(), `project create -> ${created.status()}`).toBe(true);
		const { id: projectId } = (await created.json()) as { id: string };
		await page.reload();
		await waitForHydration(page);
		const folder = page
			.getByTestId("project-drop-target")
			.filter({ hasText: "Trips" });
		await expect(folder).toBeVisible();

		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		await page.getByTestId("selection-move").click();
		await page
			.getByTestId("selection-move-option")
			.filter({ hasText: "Trips" })
			.click();

		// Both left Chats; they are under the folder, once it is open (a move never
		// opens or closes a folder on its own).
		const chats = page.getByTestId("unorganized-drop-target");
		await expect(chats.getByTestId("conversation-item")).toHaveCount(1);
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await folder.click();
		const inFolder = page.getByTestId(`project-conversations-${projectId}`);
		await expect(inFolder.getByTestId("conversation-item")).toHaveCount(2);
		await expect(chatRow(page, "Alpha plan")).toBeVisible();

		// And out again.
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		await expect(selectionCount(page)).toHaveText("2 selected");
		await page.getByTestId("selection-move").click();
		await page.getByTestId("selection-remove-from-project").click();

		await expect(chats.getByTestId("conversation-item")).toHaveCount(3);
		await expect(inFolder.getByTestId("conversation-item")).toHaveCount(0);
	});

	test("pins and unpins a selection", async ({ page }) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);

		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		await page.getByRole("button", { name: "Pin to sidebar" }).click();

		// Pinned shows them in the order they had.
		const pinned = page.getByTestId("pinned-conversations-section");
		await expect(pinned.getByTestId("conversation-item")).toHaveText([
			/Alpha plan/,
			/Bravo plan/,
		]);
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);

		// Both pinned: the same button now unpins.
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		await expect(page.getByTestId("selection-pin")).toHaveAccessibleName(
			"Unpin from sidebar",
		);
		await page.getByRole("button", { name: "Unpin from sidebar" }).click();

		await expect(page.getByTestId("pinned-conversations-section")).toHaveCount(
			0,
		);
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await expect(chatRow(page, "Alpha plan")).toBeVisible();
		await expect(chatRow(page, "Bravo plan")).toBeVisible();
	});

	test("deleting the open chat in a selection goes home", async ({ page }) => {
		const { ids } = await startWithChats(page, [
			"Alpha plan",
			"Bravo plan",
			"Charlie plan",
		]);
		await page.goto(`/chat/${ids[0]}`);
		await waitForHydration(page);
		await expect(page).toHaveURL(new RegExp(`/chat/${ids[0]}$`));

		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		await expect(selectionCount(page)).toHaveText("2 selected");
		await page.getByTestId("selection-delete").click();
		await page.getByTestId("confirm-delete").click();

		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(chatRow(page, "Alpha plan")).toHaveCount(0);
		await expect(chatRow(page, "Bravo plan")).toHaveCount(0);
		await expect(chatRow(page, "Charlie plan")).toBeVisible();
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
	});

	test("keeps the bar in view and on one line", async ({ page }) => {
		// The narrowest sidebar there is, in the language whose count is longest.
		await page.addInitScript(() => {
			localStorage.setItem("sidebarWidth", "240");
		});
		const titles = Array.from(
			{ length: 30 },
			(_, index) => `Beszélgetés ${String(index + 1).padStart(2, "0")}`,
		);
		await startWithChats(page, titles, "hu", { project: "Bécsi utazás" });
		const panel = page.locator("aside.sidebar-panel");
		await expect
			.poll(async () => (await panel.boundingBox())?.width, {
				message: "the sidebar is at its minimum width",
			})
			.toBe(240);

		await chatRow(page, titles[0]).click({ modifiers: [MOD] });
		await page.getByTestId("selection-select-all").click();
		await expect(selectionCount(page)).toHaveText("30 kijelölve");
		await expect(
			page.getByTestId("sidebar-selection-bar").getByRole("button"),
		).toHaveCount(5);

		// With the list's scrollbar beside it, which costs the bar its width.
		await page.addStyleTag({ content: CLASSIC_LIST_SCROLLBAR });
		await expect
			.poll(
				() =>
					page
						.getByTestId("sidebar-scroll")
						.evaluate((element) => element.offsetWidth - element.clientWidth),
				{ message: "the list shows its scrollbar" },
			)
			.toBe(8);
		await scrollListTo(page, "top");
		await expectBarInView(page, "at the top of the list");
		await expectBarOnOneLine(page);
		await scrollListTo(page, "bottom");
		await expectBarInView(page, "at the bottom of the list");
		await expectBarOnOneLine(page);
	});
});

// The bar is removed with the selection, and a button of it that holds the focus
// takes the focus along to <body>: a keyboard user would start again from the top
// of the page. A browser also drops the focus of a button that is switched off,
// which the bar's buttons are while a bulk call runs, so the focus has to be read
// when the person acts and put back on a row when the selection is over.
test.describe("keyboard focus when a selection ends", () => {
	test("puts the focus on the last chat picked when Cancel selection is pressed", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Charlie plan").click({ modifiers: [MOD] });

		await page.getByTestId("selection-close").focus();
		await page.keyboard.press("Enter");

		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await expect(chatRow(page, "Charlie plan")).toBeFocused();
	});

	test("puts the focus on a row after a bulk pin pressed from the keyboard", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });

		await page.getByTestId("selection-pin").focus();
		await page.keyboard.press("Enter");

		// Bravo, the last picked, is under Pinned now: the same chat in a new row.
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await expect(
			page
				.getByTestId("pinned-conversations-section")
				.getByTestId("conversation-item"),
		).toHaveCount(2);
		await expect(chatRow(page, "Bravo plan")).toBeFocused();
	});

	test("puts the focus on the first chat left after a bulk delete confirmed from the keyboard", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });

		await page.getByTestId("selection-delete").focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("dialog")).toContainText("Delete 2 chats?");
		await page.getByTestId("confirm-delete").focus();
		await page.keyboard.press("Enter");

		// Bravo, the last picked, is deleted with Alpha: Charlie is what is left.
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await expect(chatRow(page, "Alpha plan")).toHaveCount(0);
		await expect(chatRow(page, "Charlie plan")).toBeFocused();
	});

	test("puts the focus on the row after Select in its menu", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);

		await chatRow(page, "Bravo plan").click({ button: "right" });
		await page.getByTestId("select-option").click();

		await expect(selectionCount(page)).toHaveText("1 selected");
		await expect(chatRow(page, "Bravo plan")).toBeFocused();
	});
});

// The bar is a toolbar: one stop in the Tab order, the arrow keys, Home and End
// between its buttons. Its count is read aloud from a live region that the list
// keeps in the page, so that it is there before the first pick.
test.describe("the selection bar as a toolbar", () => {
	test("is one Tab stop, with the arrow keys, Home and End moving between its buttons", async ({
		page,
	}) => {
		// A project, so that the bar has all five buttons.
		await startWithChats(
			page,
			["Alpha plan", "Bravo plan", "Charlie plan"],
			"en",
			{ project: "Trips" },
		);
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		const bar = page.getByTestId("sidebar-selection-bar");
		const close = page.getByTestId("selection-close");
		const selectAll = page.getByTestId("selection-select-all");
		const del = page.getByTestId("selection-delete");

		// One of the five is in the Tab order, the first to begin with.
		await expect(bar.getByRole("button")).toHaveCount(5);
		await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
		await expect(close).toHaveAttribute("tabindex", "0");

		await close.focus();
		await page.keyboard.press("ArrowRight");
		await expect(selectAll).toBeFocused();
		await page.keyboard.press("End");
		await expect(del).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(close).toBeFocused();
		await page.keyboard.press("ArrowLeft");
		await expect(del).toBeFocused();
		await page.keyboard.press("Home");
		await expect(close).toBeFocused();

		// One Tab leaves the bar, and Shift+Tab comes back to the button that held
		// the focus, not to the first one.
		await page.keyboard.press("End");
		await expect(del).toBeFocused();
		await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
		await expect(del).toHaveAttribute("tabindex", "0");
		await page.keyboard.press("Tab");
		await expect(bar.locator(":focus")).toHaveCount(0);
		await page.keyboard.press("Shift+Tab");
		await expect(del).toBeFocused();
	});

	test("skips a button that is switched off", async ({ page }) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan"]);
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		// Every shown chat is picked: Select all is off.
		await expect(page.getByTestId("selection-select-all")).toBeDisabled();

		await page.getByTestId("selection-close").focus();
		await page.keyboard.press("ArrowRight");

		await expect(page.getByTestId("selection-pin")).toBeFocused();
	});

	test("reads the count from a live region that is in the page before the first pick", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan"]);
		const region = page.getByTestId("selection-live-region");

		await expect(region).toBeAttached();
		await expect(region).toHaveAttribute("aria-live", "polite");
		await expect(region).toHaveText("");
		// Visually hidden: it is there for a screen reader and draws nothing.
		const box = await region.boundingBox();
		expect(box?.width ?? 0).toBeLessThanOrEqual(1);
		expect(box?.height ?? 0).toBeLessThanOrEqual(1);

		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await expect(region).toHaveText("1 selected");
		await chatRow(page, "Bravo plan").click({ modifiers: [MOD] });
		await expect(region).toHaveText("2 selected");
		await expect(selectionCount(page)).toHaveText("2 selected");

		await page.getByTestId("selection-close").click();
		await expect(region).toHaveText("");
	});
});

test.describe("selecting chats on a phone", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test("starts a selection from the row menu on a phone", async ({ page }) => {
		const { ids } = await startWithChats(page, [
			"Alpha plan",
			"Bravo plan",
			"Charlie plan",
		]);
		await openPhoneSidebar(page);

		await chatRow(page, "Alpha plan")
			.getByRole("button", { name: "Conversation options" })
			.tap();
		await page.getByTestId("select-option").tap();
		await expect(selectionCount(page)).toHaveText("1 selected");
		await chatRow(page, "Bravo plan").tap();
		await expect(selectionCount(page)).toHaveText("2 selected");

		await page.getByTestId("selection-close").tap();
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);

		// With no selection open a tap opens the chat again.
		await chatRow(page, "Charlie plan").tap();
		await expect(page).toHaveURL(new RegExp(`/chat/${ids[2]}$`));
	});
});

test.describe("selecting chats on a 360 px phone", () => {
	test.use({
		viewport: { width: 360, height: 800 },
		hasTouch: true,
		isMobile: true,
	});

	test("keeps the bar in view and on one line", async ({ page }) => {
		const titles = Array.from(
			{ length: 30 },
			(_, index) => `Beszélgetés ${String(index + 1).padStart(2, "0")}`,
		);
		await startWithChats(page, titles, "hu", { project: "Bécsi utazás" });
		await openPhoneSidebar(page, "Oldalsáv ki/bekapcsolása");

		await chatRow(page, titles[0])
			.getByRole("button", { name: "Beszélgetés beállításai" })
			.tap();
		await page.getByTestId("select-option").tap();
		await page.getByTestId("selection-select-all").tap();
		await expect(selectionCount(page)).toHaveText("30 kijelölve");
		await expect(
			page.getByTestId("sidebar-selection-bar").getByRole("button"),
		).toHaveCount(5);

		await scrollListTo(page, "top");
		await expectBarInView(page, "at the top of the list");
		await expectBarOnOneLine(page);
		await scrollListTo(page, "bottom");
		await expectBarInView(page, "at the bottom of the list");
		await expectBarOnOneLine(page);
	});
});
