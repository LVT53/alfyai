import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import { createTourUser, markToursSeen } from "./artifact-tours-helpers";
import { login, waitForHydration, waitForMotionToSettle } from "./helpers";

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
	// The first row is visible while the sidebar is still opening: it grows from its
	// 48 px rail over 240 ms, and the row is in it at about 20 px wide, its centre on
	// its own options button. The width transition spends two frames at its start (the
	// page runs them back to back after the list mounts), and Playwright takes two
	// frames with the same box for a target that has settled: a click that starts now
	// can be accepted in that pair, land on the options button, open the row's menu
	// and pick nothing. Wait until the motion has ended.
	await waitForMotionToSettle(page);
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
	// The drawer slides in: until it has, a row's box is where it starts, off screen.
	await waitForMotionToSettle(page);
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
		await waitForMotionToSettle(page);

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
		// The folder slides open: a row in it is clipped until it has.
		await waitForMotionToSettle(page);

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
		await waitForMotionToSettle(page);

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
// when the person acts and put back on a row when the selection is over. Only for
// the keyboard: a mouse press leaves a button focused too, but not shown as
// keyboard focus (`:focus-visible`), and the row it would go to scrolls the list.
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

	test("puts the focus on the row after Select chosen with the keyboard in its menu", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);

		// The row's menu is open; the keyboard reaches Select and presses Enter on it
		// (a key press makes the item that holds the focus focus-visible).
		await chatRow(page, "Bravo plan").click({ button: "right" });
		await page.getByTestId("select-option").focus();
		await page.keyboard.press("Enter");

		await expect(selectionCount(page)).toHaveText("1 selected");
		await expect(chatRow(page, "Bravo plan")).toBeFocused();
	});

	test("leaves the focus alone after Select is clicked in a row's menu", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);

		await chatRow(page, "Bravo plan").click({ button: "right" });
		await page.getByTestId("select-option").click();

		await expect(selectionCount(page)).toHaveText("1 selected");
		// The page has had its frames: a focus that was going to move has moved.
		await waitForMotionToSettle(page);
		await expect(
			page.locator('[data-testid="conversation-item"]:focus'),
		).toHaveCount(0);
	});

	test("leaves the focus alone when Cancel selection is clicked", async ({
		page,
	}) => {
		await startWithChats(page, ["Alpha plan", "Bravo plan", "Charlie plan"]);
		await chatRow(page, "Alpha plan").click({ modifiers: [MOD] });
		await chatRow(page, "Charlie plan").click({ modifiers: [MOD] });

		await page.getByTestId("selection-close").click();

		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await waitForMotionToSettle(page);
		await expect(
			page.locator('[data-testid="conversation-item"]:focus'),
		).toHaveCount(0);
	});
});

// Putting the focus on a row scrolls the list to it. In a long list scrolled to
// its bottom that is the whole list: a person who deleted the last two chats with
// the mouse must stay where they were, and one on the keyboard needs the row the
// focus went to in view.
test.describe("scrolling when a selection ends", () => {
	const LONG_LIST = Array.from(
		{ length: 40 },
		(_, index) => `Plan ${String(index + 1).padStart(2, "0")}`,
	);

	/** How far the list's scroll is from its bottom, in px. */
	async function distanceFromBottom(page: Page): Promise<number> {
		return page
			.getByTestId("sidebar-scroll")
			.evaluate(
				(element) =>
					element.scrollHeight - element.clientHeight - element.scrollTop,
			);
	}

	async function pickTheLastTwo(page: Page) {
		await scrollListTo(page, "bottom");
		await chatRow(page, "Plan 40").click({ modifiers: [MOD] });
		await chatRow(page, "Plan 39").click({ modifiers: [MOD] });
		await expect(selectionCount(page)).toHaveText("2 selected");
	}

	test("leaves the list at its bottom when the last two chats are deleted with the mouse", async ({
		page,
	}) => {
		await startWithChats(page, LONG_LIST);
		await pickTheLastTwo(page);
		const scrolledTo = await page
			.getByTestId("sidebar-scroll")
			.evaluate((element) => element.scrollTop);
		expect(scrolledTo, "the list starts scrolled down").toBeGreaterThan(200);

		await page.getByTestId("selection-delete").click();
		await page.getByTestId("confirm-delete").click();

		await expect(chatRow(page, "Plan 40")).toHaveCount(0);
		await expect(chatRow(page, "Plan 39")).toHaveCount(0);
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		// The list has had its frames, so a scroll that was going to happen has.
		await waitForMotionToSettle(page);
		await expect
			.poll(() => distanceFromBottom(page), {
				message: "the list is still at its bottom, not thrown to the first row",
			})
			.toBeLessThanOrEqual(1);
		expect(
			await page
				.getByTestId("sidebar-scroll")
				.evaluate((element) => element.scrollTop),
		).toBeGreaterThan(200);
	});

	test("scrolls the first chat left into view when the last two are deleted with the keyboard", async ({
		page,
	}) => {
		await startWithChats(page, LONG_LIST);
		await pickTheLastTwo(page);

		await page.getByTestId("selection-delete").focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("dialog")).toContainText("Delete 2 chats?");
		await page.getByTestId("confirm-delete").focus();
		await page.keyboard.press("Enter");

		// Plan 39 and 40 are gone, so the focus goes to the first row, which the
		// keyboard's ring has to show: the list scrolls up to it.
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await expect(chatRow(page, "Plan 40")).toHaveCount(0);
		await expect(chatRow(page, "Plan 01")).toBeFocused();
		await expect(chatRow(page, "Plan 01")).toBeInViewport();
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

// Set MOTION_VIDEO_DIR to keep a video of each drag test (t10-<name>.webm) and
// its numbers (t10-<name>.json); unset, nothing is recorded or written. Top-level
// because a video forces its own worker, which Playwright rejects in a describe
// group: with it set every test here records, and only the drag tests keep theirs.
const DRAG_VIDEO_DIR = process.env.MOTION_VIDEO_DIR ?? null;
test.use({
	video: DRAG_VIDEO_DIR
		? { mode: "on", size: { width: 1280, height: 800 } }
		: "off",
});

/** Starts a mouse drag on a row and leaves it held a little way off it. */
async function startDrag(page: Page, row: Locator) {
	const box = await row.boundingBox();
	if (!box) throw new Error("no box for the dragged row");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12, {
		steps: 4,
	});
}

/** Moves a held drag onto the target and lets it go there. */
async function dropOn(page: Page, target: Locator) {
	const box = await target.boundingBox();
	if (!box) throw new Error("no box for the drop target");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
}

/**
 * Watches the sidebar from now on: every layout shift (with or without recent
 * input: a drag is input, and the list must not move for the bin either way),
 * and the properties the bin animates when it comes in.
 */
async function watchSidebarMotion(page: Page) {
	await page.evaluate(() => {
		const record = { shift: 0, binAnimated: [] as string[] };
		(window as unknown as { __t10: typeof record }).__t10 = record;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & {
				value: number;
			})[]) {
				record.shift += entry.value;
			}
		}).observe({ type: "layout-shift" });
		new MutationObserver(() => {
			const bin = document.querySelector('[data-testid="sidebar-drop-bin"]');
			if (!bin) return;
			for (const animation of bin.getAnimations()) {
				const effect = animation.effect as KeyframeEffect | null;
				for (const frame of effect?.getKeyframes() ?? []) {
					for (const key of Object.keys(frame)) {
						if (
							["offset", "easing", "composite", "computedOffset"].includes(key)
						)
							continue;
						if (!record.binAnimated.includes(key)) record.binAnimated.push(key);
					}
				}
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
}

async function readSidebarMotion(page: Page) {
	return page.evaluate(
		() =>
			(window as unknown as { __t10: { shift: number; binAnimated: string[] } })
				.__t10,
	);
}

/** A still of the sidebar mid-drag, beside the videos, when they are kept. */
async function snapSidebar(page: Page, name: string) {
	if (!DRAG_VIDEO_DIR) return;
	await waitForMotionToSettle(page);
	mkdirSync(DRAG_VIDEO_DIR, { recursive: true });
	await page
		.locator("aside.sidebar-panel")
		.screenshot({ path: join(DRAG_VIDEO_DIR, `t10-${name}.png`) });
}

/** Where every row is: the list must not move while the bin is up. */
async function rowTops(page: Page): Promise<number[]> {
	return page
		.getByTestId("conversation-item")
		.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().top));
}

test.describe("dragging chats in the sidebar", () => {
	test.afterEach(async ({ page }, testInfo) => {
		const video = page.video();
		const metrics = await readSidebarMotion(page).catch(() => null);
		await page.close();
		if (!video || !DRAG_VIDEO_DIR) return;
		mkdirSync(DRAG_VIDEO_DIR, { recursive: true });
		const name = `t10-${testInfo.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")}`;
		await video.saveAs(join(DRAG_VIDEO_DIR, `${name}.webm`));
		writeFileSync(
			join(DRAG_VIDEO_DIR, `${name}.json`),
			JSON.stringify({ title: testInfo.title, ...metrics }, null, 2),
		);
	});

	test("drags three selected chats into a folder and moves all three", async ({
		page,
	}) => {
		const { ids } = await startWithChats(
			page,
			["Alpha plan", "Bravo plan", "Charlie plan", "Delta plan"],
			"en",
			{ project: "Trips" },
		);
		const folder = page
			.getByTestId("project-drop-target")
			.filter({ hasText: "Trips" });
		await expect(folder).toBeVisible();
		await watchSidebarMotion(page);
		for (const title of ["Alpha plan", "Bravo plan", "Charlie plan"]) {
			await chatRow(page, title).click({ modifiers: [MOD] });
		}
		await expect(selectionCount(page)).toHaveText("3 selected");
		await expect(page.getByTestId("sidebar-drag-preview")).toHaveText(
			"3 chats",
		);

		const batch = page.waitForRequest(
			(request) =>
				request.method() === "POST" &&
				request.url().endsWith("/api/conversations/batch"),
		);
		await startDrag(page, chatRow(page, "Bravo plan"));
		await expect(page.getByTestId("sidebar-drop-bin")).toBeVisible();
		await dropOn(page, folder);

		// The three, in the order the sidebar shows them.
		expect((await batch).postDataJSON()).toMatchObject({
			action: "move",
			ids: ids.slice(0, 3),
		});
		const chats = page.getByTestId("unorganized-drop-target");
		await expect(chats.getByTestId("conversation-item")).toHaveCount(1);
		await expect(chatRow(page, "Delta plan")).toBeVisible();
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await expect(page.getByTestId("sidebar-drop-bin")).toHaveCount(0);
		await expect(page.getByTestId("selection-live-region")).toHaveText(
			"Moved 3 chats to Trips",
		);
		// A collapsed folder stays collapsed; the three are in it once it is opened.
		await folder.click();
		await expect(
			page
				.getByTestId("project-folder-drop-zone")
				.filter({ hasText: "Trips" })
				.getByTestId("conversation-item"),
		).toHaveCount(3);
	});

	test("asks before deleting a selection dropped on the bin; Cancel keeps it, Delete deletes it", async ({
		page,
	}) => {
		await startWithChats(page, [
			"Alpha plan",
			"Bravo plan",
			"Charlie plan",
			"Delta plan",
		]);
		for (const title of ["Alpha plan", "Bravo plan", "Charlie plan"]) {
			await chatRow(page, title).click({ modifiers: [MOD] });
		}
		const bin = page.getByTestId("sidebar-drop-bin");
		await watchSidebarMotion(page);

		await startDrag(page, chatRow(page, "Alpha plan"));
		await expect(bin).toBeVisible();
		await expect(bin).toHaveAttribute("aria-label", "Drop to delete");
		await snapSidebar(page, "bin-over-selection-bar");
		await dropOn(page, bin);
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Delete 3 chats?");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(selectionCount(page)).toHaveText("3 selected");
		await expect(page.getByTestId("conversation-item")).toHaveCount(4);

		await startDrag(page, chatRow(page, "Charlie plan"));
		await dropOn(page, bin);
		await expect(dialog).toContainText("Delete 3 chats?");
		await page.getByTestId("confirm-delete").click();

		await expect(page.getByTestId("conversation-item")).toHaveCount(1);
		await expect(chatRow(page, "Delta plan")).toBeVisible();
		await expect(page.getByTestId("sidebar-selection-bar")).toHaveCount(0);
		await page.reload();
		await waitForHydration(page);
		await expect(chatRow(page, "Delta plan")).toBeVisible();
		await expect(chatRow(page, "Alpha plan")).toHaveCount(0);
	});

	test("drags one unselected row into a folder as before, and the bin never moves the list", async ({
		page,
	}) => {
		const { ids } = await startWithChats(
			page,
			["Alpha plan", "Bravo plan", "Charlie plan"],
			"en",
			{ project: "Trips" },
		);
		const folder = page
			.getByTestId("project-drop-target")
			.filter({ hasText: "Trips" });
		await expect(folder).toBeVisible();
		const bin = page.getByTestId("sidebar-drop-bin");
		await expect(bin).toHaveCount(0);
		await watchSidebarMotion(page);
		const before = await rowTops(page);

		const move = page.waitForRequest(
			(request) =>
				request.method() === "PATCH" &&
				request.url().endsWith(`/api/conversations/${ids[1]}`),
		);
		await startDrag(page, chatRow(page, "Bravo plan"));
		await expect(bin).toBeVisible();
		await waitForMotionToSettle(page);
		// The bin lies over the foot of the list, inside it, and nothing moved.
		const scroller = await page.getByTestId("sidebar-scroll").boundingBox();
		const binBox = await bin.boundingBox();
		if (!scroller || !binBox) throw new Error("no box for the list or the bin");
		expect(binBox.y + binBox.height).toBeLessThanOrEqual(
			scroller.y + scroller.height + 0.5,
		);
		expect(binBox.y + binBox.height).toBeGreaterThan(
			scroller.y + scroller.height - 24,
		);
		expect(await rowTops(page)).toEqual(before);
		await snapSidebar(page, "bin-single-drag");
		await dropOn(page, folder);

		expect((await move).postDataJSON()).toEqual({
			projectId: expect.any(String),
		});
		await expect(bin).toHaveCount(0);
		await expect(
			page
				.getByTestId("unorganized-drop-target")
				.getByTestId("conversation-item"),
		).toHaveCount(2);
		const motion = await readSidebarMotion(page);
		expect(motion.shift, "no layout shift while the bin came and went").toBe(0);
		expect(motion.binAnimated.sort()).toEqual(["opacity", "transform"]);
	});

	test("lays the bin over the foot of a long list that scrolls, and moves no row", async ({
		page,
	}) => {
		const titles = Array.from(
			{ length: 30 },
			(_, index) => `Plan ${String(index + 1).padStart(2, "0")}`,
		);
		await startWithChats(page, titles);
		await chatRow(page, titles[0]).click({ modifiers: [MOD] });
		await chatRow(page, titles[1]).click({ modifiers: [MOD] });
		await watchSidebarMotion(page);
		const before = await rowTops(page);

		await startDrag(page, chatRow(page, titles[0]));
		const bin = page.getByTestId("sidebar-drop-bin");
		await expect(bin).toBeVisible();
		await waitForMotionToSettle(page);
		const scroller = await page.getByTestId("sidebar-scroll").boundingBox();
		const binBox = await bin.boundingBox();
		if (!scroller || !binBox) throw new Error("no box for the list or the bin");
		expect(binBox.y + binBox.height).toBeLessThanOrEqual(
			scroller.y + scroller.height + 0.5,
		);
		expect(binBox.y + binBox.height).toBeGreaterThan(
			scroller.y + scroller.height - 24,
		);
		expect(await rowTops(page)).toEqual(before);
		await snapSidebar(page, "bin-long-list");
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await expect(bin).toHaveCount(0);
		expect((await readSidebarMotion(page)).shift).toBe(0);
		await expect(selectionCount(page)).toHaveText("2 selected");
	});

	test("shows the bin at once, with no animation, under reduced motion", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await startWithChats(page, ["Alpha plan", "Bravo plan"]);
		await watchSidebarMotion(page);

		await startDrag(page, chatRow(page, "Alpha plan"));
		const bin = page.getByTestId("sidebar-drop-bin");
		await expect(bin).toBeVisible();
		expect(
			await bin.evaluate((element) => element.getAnimations().length),
		).toBe(0);
		await dropOn(page, bin);
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Delete this conversation?");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByTestId("conversation-item")).toHaveCount(2);
		const motion = await readSidebarMotion(page);
		expect(motion.shift).toBe(0);
		expect(motion.binAnimated).toEqual([]);
	});
});
