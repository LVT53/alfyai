import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import { openBoard } from "./artifact-canvas-helpers";
import {
	openDocument,
	PROSE_MARKDOWN,
	seedDocument,
	setUiLanguage,
} from "./artifact-document-polish-helpers";
import { createTourUser, markToursSeen } from "./artifact-tours-helpers";
import {
	createEmptyConversation,
	ensureSidebarExpanded,
	login,
	waitForMotionToSettle,
} from "./helpers";

/**
 * FB-9 (ruling 77 and its amendments): the owner's own finds on a phone. Real
 * touch at the widths a phone has (390, 360, and 430 for the large ones), in
 * Hungarian, where a label is longest.
 */

const PHONE_WIDTHS = [390, 360, 430] as const;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("no bounding box");
	return box;
}

/** What each row of a menu says: its words, how many lines they take, and how tall the row is. */
async function menuRows(rows: Locator) {
	return rows.evaluateAll((els) =>
		els.map((el) => {
			const label = [...el.querySelectorAll("span")].find(
				(span) => (span.textContent ?? "").trim() !== "",
			);
			const range = document.createRange();
			if (label) range.selectNodeContents(label);
			return {
				text: label?.textContent?.trim() ?? "",
				lines: label ? range.getClientRects().length : 0,
				height: el.getBoundingClientRect().height,
			};
		}),
	);
}

function overlap(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.width - 0.5 &&
		b.x < a.x + a.width - 0.5 &&
		a.y < b.y + b.height - 0.5 &&
		b.y < a.y + a.height - 0.5
	);
}

async function seedChat(
	userId: string,
	title: string,
	projectId: string | null,
	secondsAgo: number,
): Promise<string> {
	const id = randomUUID();
	const at = new Date(Date.now() - secondsAgo * 1000);
	await db.insert(conversations).values({
		id,
		userId,
		title,
		projectId,
		createdAt: at,
		updatedAt: at,
	});
	await db.insert(messages).values([
		{
			id: `${id}-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "Szia",
			createdAt: at,
		},
		{
			id: `${id}-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "Szia!",
			createdAt: at,
		},
	]);
	return id;
}

async function openPhoneSidebar(page: Page) {
	await page.getByRole("button", { name: "Oldalsáv ki/bekapcsolása" }).click();
	await expect(page.locator("aside.sidebar-panel")).toBeVisible();
}

for (const width of PHONE_WIDTHS) {
	test.describe(`the sidebar on a phone, ${width} px wide (touch)`, () => {
		test.use({
			viewport: { width, height: 844 },
			hasTouch: true,
			isMobile: true,
		});

		test("the project folder's count and its buttons each have their own place, and each button takes a tap", async ({
			page,
		}) => {
			const user = await createTourUser("hu");
			await markToursSeen(user);
			const project = await createProject(user.id, "Bécsi utazás");
			const openChat = await seedChat(
				user.id,
				"Vonatok Budapestről Bécsbe",
				project.id,
				0,
			);
			await seedChat(
				user.id,
				"Szállás a belvárosban, a Ringhez közel, reggelivel együtt",
				project.id,
				1,
			);
			await seedChat(user.id, "Múzeumok és programok", project.id, 2);
			await seedChat(user.id, "Hazaút", null, 3);
			await login(page, user.email, user.password);
			await page.goto(`/chat/${openChat}`, { waitUntil: "networkidle" });
			await openPhoneSidebar(page);
			// The folder opens on a tap, so its chats sit right under it.
			const sidebar = page.locator("aside.sidebar-panel");
			await sidebar.getByText("Bécsi utazás").first().tap();
			await expect(sidebar.getByTestId("conversation-item")).toHaveCount(4);
			await waitForMotionToSettle(page);

			const count = page.getByTestId(`project-chat-count-${project.id}`);
			await expect(count).toHaveText("3");
			const projectRow = sidebar.locator(".group").filter({ has: count });
			const newChat = projectRow.getByRole("button", {
				name: /Bécsi utazás/,
			});
			const options = projectRow.getByRole("button", {
				name: "Projekt beállításai",
			});

			const countBox = await boxOf(count);
			const newChatBox = await boxOf(newChat);
			const optionsBox = await boxOf(options);
			const rowBox = await boxOf(projectRow);
			// Each has its own place: the number is not drawn over a button.
			expect(overlap(countBox, optionsBox), "count over the dots").toBe(false);
			expect(overlap(countBox, newChatBox), "count over new chat").toBe(false);
			expect(overlap(newChatBox, optionsBox), "the two buttons").toBe(false);
			// Finger-sized, and inside the row (no hit area spills onto the next one).
			for (const [name, box] of [
				["new chat", newChatBox],
				["options", optionsBox],
			] as const) {
				expect(box.width, `${name} width`).toBeGreaterThanOrEqual(43.5);
				expect(box.height, `${name} height`).toBeGreaterThanOrEqual(43.5);
				expect(box.y, `${name} top`).toBeGreaterThanOrEqual(rowBox.y - 0.5);
				expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(
					rowBox.y + rowBox.height + 0.5,
				);
			}
			// The title gives way, never the number or a button.
			const nameBox = await boxOf(projectRow.getByText("Bécsi utazás").first());
			expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(countBox.x + 0.5);

			// No two buttons of the list share a pixel: the folder's dots and the first
			// chat's dots (which sit right under it) used to share a few rows of them.
			const buttons = sidebar.locator(
				'[data-testid="conversation-item"] button, .group button',
			);
			const boxes: Box[] = [];
			for (const button of await buttons.all()) {
				if (await button.isVisible()) {
					boxes.push(await boxOf(button));
				}
			}
			expect(boxes.length).toBeGreaterThanOrEqual(6);
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					expect(overlap(boxes[i], boxes[j]), `buttons ${i} and ${j}`).toBe(
						false,
					);
				}
			}

			// A long chat title gives way to its dots, which stay whole inside the row.
			const long = sidebar
				.getByTestId("conversation-item")
				.filter({ hasText: "Szállás a belvárosban" });
			const longRow = await boxOf(long);
			const longDots = await boxOf(long.getByRole("button"));
			expect(longDots.x + longDots.width).toBeLessThanOrEqual(
				longRow.x + longRow.width + 0.5,
			);

			// A real tap on the dots opens the folder's menu.
			await page.touchscreen.tap(
				optionsBox.x + optionsBox.width / 2,
				optionsBox.y + optionsBox.height / 2,
			);
			await expect(page.locator(".project-menu")).toBeVisible();
		});
	});
}

/**
 * A keyboard chord is "plain wasted space" on a touch screen (ruling 77's
 * amendment): where the primary pointer is a finger no button, tooltip or hint
 * writes one, and the shortcuts and their `aria-keyshortcuts` stay. A desktop
 * with a mouse is unchanged. `keyboard-shortcuts.ts` is the one rule.
 */
const CHORD = /Ctrl|⌘|⌥|⇧|Cmd\+/;

/** Every tooltip and accessible name under a surface that writes a keyboard chord. */
async function chordsWrittenUnder(root: Locator): Promise<string[]> {
	return root.evaluate((element, source) => {
		const chord = new RegExp(source);
		const found: string[] = [];
		for (const node of element.querySelectorAll("[title], [aria-label]")) {
			for (const name of ["title", "aria-label"]) {
				const value = node.getAttribute(name);
				if (value && chord.test(value)) found.push(`${name}="${value}"`);
			}
		}
		return found;
	}, CHORD.source);
}

test.describe("no keyboard chord on a touch screen (390 px, touch)", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test("the sidebar's search chip, the search legend and the composer's slash hint are gone", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Touch hints");
		await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(page.getByTestId("slash-shortcut-hint")).toHaveCount(0);

		await page.getByRole("button", { name: "Toggle sidebar" }).tap();
		const sidebar = page.locator("aside.sidebar-panel");
		await expect(sidebar).toBeVisible();
		await waitForMotionToSettle(page);
		const searchPill = sidebar.getByRole("button", {
			name: "Search conversations",
		});
		await expect(searchPill).toBeVisible();
		await expect(sidebar.getByTestId("search-shortcut-hint")).toBeHidden();

		await searchPill.tap();
		const modal = page.getByRole("dialog");
		await expect(modal).toBeVisible();
		await expect(modal.locator(".search-kbd")).toHaveCount(0);
		await expect(modal.locator(".search-modal-footer")).toHaveCount(0);
	});

	test("the Document's toolbar names its Undo without keys, and keeps them for assistive technology", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Touch doc");
		await seedDocument(conversationId, {
			markdown: PROSE_MARKDOWN,
			pendingOps: 1,
		});
		const shell = await openDocument(page, conversationId);
		const toolbar = shell.getByRole("toolbar", { name: "Document" });
		const undo = toolbar.getByRole("button", { name: "Undo" });
		await expect(undo).toHaveAttribute("title", "Undo");
		await expect(undo).toHaveAttribute("aria-keyshortcuts", /Z/);
		expect(await chordsWrittenUnder(shell)).toEqual([]);
	});

	test("the board's toolbar and selection pill name no keys either", async ({
		page,
	}) => {
		await openBoard(page, "Touch board");
		const undo = page.getByTestId("canvas-undo");
		await expect(undo).toHaveAttribute("title", "Undo your last step");
		await expect(undo).toHaveAttribute("aria-keyshortcuts", /Z/);
		await page.locator('.svelte-flow__node[data-id="note-1"]').tap();
		const pill = page.getByTestId("canvas-selection-pill");
		await expect(pill).toBeVisible();
		await expect(page.getByTestId("canvas-selection-ask")).toHaveAttribute(
			"aria-keyshortcuts",
			/Alt\+A/,
		);
		expect(await chordsWrittenUnder(pill)).toEqual([]);
		expect(
			await chordsWrittenUnder(page.getByTestId("canvas-toolbar")),
		).toEqual([]);
	});
});

test.describe("keyboard chords stay on a desktop with a mouse", () => {
	test("the sidebar's chip, the search legend, the toolbar's and the pill's tooltips", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await openBoard(page, "Desktop board");
		await expect(page.getByTestId("canvas-undo")).toHaveAttribute(
			"title",
			/^Undo your last step \((Ctrl\+Z|⌘Z)\)$/,
		);
		await page.locator('.svelte-flow__node[data-id="note-1"]').click();
		await expect(page.getByTestId("canvas-selection-ask")).toHaveAttribute(
			"title",
			/^Ask Alfy \((Ctrl\+Alt\+A|⌥⌘A)\)$/,
		);
		await ensureSidebarExpanded(page);
		await expect(page.getByTestId("search-shortcut-hint")).toBeVisible();
		await page.getByRole("button", { name: "Search conversations" }).click();
		const modal = page.getByRole("dialog");
		await expect(modal.locator(".search-kbd").first()).toBeVisible();
	});
});

/**
 * FB-6 made the phone's review bar one row with two short words; in Hungarian
 * "Megtart" / "Visszavon" read as clipped verb stems (ruling 77's amendment: short,
 * natural Hungarian that does not crowd a row). The words are the pills' own.
 */
for (const [width, height, pendingOps] of [
	[390, 844, 1],
	[390, 844, 2],
	[360, 740, 2],
] as const) {
	test.describe(`the review bar on a phone, ${width} px, ${pendingOps} pending (Hungarian, touch)`, () => {
		test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });
		test.beforeEach(async ({ page }) => {
			await setUiLanguage("hu");
			await login(page);
		});
		test.afterEach(async () => {
			await setUiLanguage("en");
		});

		test("the two buttons say whole words, and the bar stays one row", async ({
			page,
		}) => {
			const conversationId = await createEmptyConversation(page, "Bar words");
			await seedDocument(conversationId, {
				markdown: PROSE_MARKDOWN,
				title: "Bécsi utazás",
				pendingOps,
			});
			const shell = await openDocument(page, conversationId);
			const bar = shell.getByRole("region", { name: "Alfy módosításai" });
			await expect(bar).toBeVisible({ timeout: 30_000 });
			await waitForMotionToSettle(page);

			// The accessible names do not change; the visible words are the pills' own.
			const keep = bar.getByRole("button", { name: "Mindet megtartom" });
			const undo = bar.getByRole("button", { name: "Mindet visszavonom" });
			await expect(keep).toHaveText("Megtartom", { useInnerText: true });
			await expect(undo).toHaveText("Visszavonom", { useInnerText: true });

			// Whole: the word fits inside its button, the button inside the bar.
			const barBox = await boxOf(bar);
			for (const [name, button] of [
				["keep", keep],
				["undo", undo],
			] as const) {
				const fits = await button.evaluate(
					(el) => el.scrollWidth <= el.clientWidth + 1,
				);
				expect(fits, `${name}'s word fits its button`).toBe(true);
				const b = await boxOf(button);
				expect(b.x, `${name} inside on the left`).toBeGreaterThanOrEqual(
					barBox.x,
				);
				expect(
					b.x + b.width,
					`${name} inside on the right`,
				).toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
				expect(b.height, `${name} is a finger's size`).toBeGreaterThanOrEqual(
					43.5,
				);
			}
			// One row, and the stepper (with several changes) shares it.
			expect(barBox.height, "one row").toBeLessThanOrEqual(64);
			if (pendingOps > 1) {
				await expect(bar.getByText("1 / 2")).toBeVisible();
			}
		});
	});
}

/**
 * A status chip's finger area (44 px, pulled back into its 26 px pill by negative
 * margins) reached 9 px under the pill, onto the change pill's buttons that sit
 * right under a changed line: 6 px of two targets that answer for the same pixels
 * (FB-9's note, FX-2). Each target keeps its own pixels.
 */
for (const width of [390, 360] as const) {
	test.describe(`a status chip and the change pill under it at ${width} px (Hungarian, touch)`, () => {
		test.use({
			viewport: { width, height: 844 },
			hasTouch: true,
			isMobile: true,
		});
		test.beforeEach(async ({ page }) => {
			await setUiLanguage("hu");
			await login(page);
		});
		test.afterEach(async () => {
			await setUiLanguage("en");
		});

		test("the chip's finger area does not overlap the pill's buttons", async ({
			page,
		}) => {
			const conversationId = await createEmptyConversation(page, "Chip");
			await seedDocument(conversationId, {
				markdown: PROSE_MARKDOWN,
				title: "Bécsi utazás",
				// The second block is the line with two status chips; its pill sits under it.
				pendingOps: 2,
			});
			const shell = await openDocument(page, conversationId);
			await expect(
				shell.locator(".alfy-change-bar-action").first(),
			).toBeVisible({ timeout: 30_000 });
			await waitForMotionToSettle(page);

			const chips = await shell
				.locator(".tracker-chip-select")
				.evaluateAll((els) =>
					els.map((el) => {
						const r = el.getBoundingClientRect();
						return { x: r.x, y: r.y, width: r.width, height: r.height };
					}),
				);
			const actions = await shell
				.locator(".alfy-change-bar-action")
				.evaluateAll((els) =>
					els.map((el) => {
						const r = el.getBoundingClientRect();
						return { x: r.x, y: r.y, width: r.width, height: r.height };
					}),
				);
			expect(chips.length, "the chips are on screen").toBeGreaterThanOrEqual(2);
			expect(
				actions.length,
				"the pill's buttons are on screen",
			).toBeGreaterThan(0);
			const overlaps: string[] = [];
			chips.forEach((chip, i) => {
				actions.forEach((action, j) => {
					if (overlap(chip, action)) {
						overlaps.push(
							`chip ${i} (${chip.y.toFixed(1)}-${(chip.y + chip.height).toFixed(1)}) over button ${j} (${action.y.toFixed(1)}-${(action.y + action.height).toFixed(1)})`,
						);
					}
				});
			});
			expect(overlaps, "no chip area reaches a pill button").toEqual([]);
			// The chips are still finger-sized where nothing sits under them.
			for (const chip of chips) {
				expect(chip.height).toBeGreaterThanOrEqual(35);
				expect(chip.width).toBeGreaterThanOrEqual(43.5);
			}

			// Real input: a tap on the lower edge of the chip's own pill is the chip's,
			// not the invisible finger area of the pill's button right under it.
			const firstChip = shell.locator(".tracker-chip-select").first();
			const pillBox = await boxOf(firstChip.locator(".."));
			const actionsBefore = await shell
				.locator(".alfy-change-bar-action")
				.count();
			await page.touchscreen.tap(
				pillBox.x + pillBox.width / 2,
				pillBox.y + pillBox.height - 3,
			);
			await expect(firstChip, "the tap reached the chip").toBeFocused();
			await expect(
				shell.locator(".alfy-change-bar-action"),
				"and the pill's buttons did not take it",
			).toHaveCount(actionsBefore);
		});
	});
}

/**
 * The panel's list used to say it twice: the eyebrow "Ez a beszélgetés" over
 * the title "Amit ez a beszélgetés készített" (ruling 77's amendment: one of
 * them goes). The title stays.
 */
async function openListInHungarian(page: Page) {
	const conversationId = await createEmptyConversation(page, "Lista");
	await seedDocument(conversationId, {
		markdown: PROSE_MARKDOWN,
		title: "Bécsi utazás",
	});
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	const isPhone = (page.viewportSize()?.width ?? 1440) < 768;
	await page
		.getByTestId(
			isPhone ? "artifact-count-button-compact" : "artifact-count-button",
		)
		.click();
	const list = page.getByTestId(
		isPhone ? "artifact-panel-list-mobile" : "artifact-panel-list",
	);
	await expect(list).toBeVisible();
	return list;
}

for (const [label, size, touch] of [
	["desktop", { width: 1440, height: 900 }, false],
	["phone", { width: 390, height: 844 }, true],
] as const) {
	test.describe(`the panel's list has one heading (${label}, Hungarian)`, () => {
		test.use({ viewport: size, hasTouch: touch });
		test.beforeEach(async ({ page }) => {
			await setUiLanguage("hu");
			await login(page);
		});
		test.afterEach(async () => {
			await setUiLanguage("en");
		});

		test("the title says what this chat made, and nothing repeats it above", async ({
			page,
		}) => {
			const list = await openListInHungarian(page);
			void list;
			const title = page.locator(
				'[data-testid="artifact-panel-list-title"]:visible',
			);
			await expect(title).toHaveText("Amit ez a beszélgetés készített");
			await expect(page.locator(".workspace-eyebrow:visible")).toHaveCount(0);
			await expect(
				page.getByText("Ez a beszélgetés", { exact: true }),
			).toHaveCount(0);
		});
	});
}

/**
 * The crowding sweep (item 5): in Hungarian the conversation menu's two longest
 * rows wrapped onto a second line in a 178 px menu ("Rögzítés az oldalsávra",
 * "Áthelyezés projektbe"; and, once pinned, "Rögzítés feloldása az oldalsávon"
 * on three), and the search field's placeholder was clipped at 360 px.
 */
for (const width of [360, 390] as const) {
	test.describe(`the sidebar's menu and the search field at ${width} px (Hungarian, touch)`, () => {
		test.use({
			viewport: { width, height: 844 },
			hasTouch: true,
			isMobile: true,
		});

		test("each row of the conversation menu is one line, pinned or not", async ({
			page,
		}) => {
			const user = await createTourUser("hu");
			await markToursSeen(user);
			const project = await createProject(user.id, "Bécsi utazás");
			await createProject(user.id, "Második projekt");
			const chat = await seedChat(
				user.id,
				"Vonatok Budapestről Bécsbe",
				project.id,
				0,
			);
			await login(page, user.email, user.password);
			await page.goto(`/chat/${chat}`, { waitUntil: "networkidle" });
			await openPhoneSidebar(page);
			const sidebar = page.locator("aside.sidebar-panel");
			await sidebar.getByText("Bécsi utazás").first().tap();
			await waitForMotionToSettle(page);
			const dots = sidebar
				.getByTestId("conversation-item")
				.first()
				.getByRole("button", { name: "Beszélgetés beállításai" });

			/** Every row of the open menu says its words on one line and is a finger's height (FX-2: 44 px, as every other phone control). */
			async function everyRowOneLine(state: string) {
				await dots.tap();
				const rows = page.locator(".conversation-option");
				await expect(rows.first()).toBeVisible();
				for (const row of await menuRows(rows)) {
					expect(row.lines, `${state}: "${row.text}" on one line`).toBe(1);
					expect(
						row.height,
						`${state}: "${row.text}" is a finger's size`,
					).toBeGreaterThanOrEqual(43.5);
				}
			}

			await everyRowOneLine("unpinned");
			await page
				.locator(".conversation-option")
				.filter({ hasText: "Rögzítés" })
				.tap();
			await expect(page.locator(".conversation-option")).toHaveCount(0);
			await everyRowOneLine("pinned");
		});

		test("the rows of the move-to-project submenu and of the project's own menu are a finger's height too", async ({
			page,
		}) => {
			const user = await createTourUser("hu");
			await markToursSeen(user);
			const project = await createProject(user.id, "Bécsi utazás");
			await createProject(user.id, "Második projekt");
			const chat = await seedChat(
				user.id,
				"Vonatok Budapestről Bécsbe",
				project.id,
				0,
			);
			await login(page, user.email, user.password);
			await page.goto(`/chat/${chat}`, { waitUntil: "networkidle" });
			await openPhoneSidebar(page);
			const sidebar = page.locator("aside.sidebar-panel");
			await sidebar.getByText("Bécsi utazás").first().tap();
			await waitForMotionToSettle(page);

			// The chat's menu, and the submenu its "Áthelyezés projektbe" opens.
			await sidebar
				.getByTestId("conversation-item")
				.first()
				.getByRole("button", { name: "Beszélgetés beállításai" })
				.tap();
			await page
				.locator(".conversation-option")
				.filter({ hasText: "Áthelyezés projektbe" })
				.tap();
			await expect(page.locator(".conversation-menu")).toHaveCount(2);
			const submenu = page
				.locator(".conversation-menu")
				.last()
				.locator(".conversation-option");
			const submenuRows = await menuRows(submenu);
			expect(submenuRows.length).toBeGreaterThanOrEqual(2);
			for (const row of submenuRows) {
				expect(
					row.height,
					`the submenu's "${row.text}" is a finger's size`,
				).toBeGreaterThanOrEqual(43.5);
			}
			await page.keyboard.press("Escape");

			// The project folder's own menu.
			const count = page.getByTestId(`project-chat-count-${project.id}`);
			const projectRow = sidebar.locator(".group").filter({ has: count });
			await projectRow
				.getByRole("button", { name: "Projekt beállításai" })
				.tap();
			const projectRows = await menuRows(page.locator(".project-option"));
			expect(projectRows.length).toBe(3);
			for (const row of projectRows) {
				expect(row.lines, `the project menu's "${row.text}" on one line`).toBe(
					1,
				);
				expect(
					row.height,
					`the project menu's "${row.text}" is a finger's size`,
				).toBeGreaterThanOrEqual(43.5);
			}
		});

		test("the search field's placeholder is not cut off", async ({ page }) => {
			const user = await createTourUser("hu");
			await markToursSeen(user);
			await login(page, user.email, user.password);
			await page.goto("/", { waitUntil: "networkidle" });
			await openPhoneSidebar(page);
			await page.locator(".search-pill").tap();
			const field = page.getByRole("dialog").getByRole("textbox");
			await expect(field).toBeVisible();
			const clipped = await field.evaluate((el) => {
				const input = el as HTMLInputElement;
				const probe = document.createElement("span");
				const style = getComputedStyle(input);
				probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing}`;
				probe.textContent = input.placeholder;
				document.body.append(probe);
				const needed = probe.getBoundingClientRect().width;
				probe.remove();
				const room =
					input.clientWidth -
					Number.parseFloat(style.paddingLeft) -
					Number.parseFloat(style.paddingRight);
				return { needed, room };
			});
			expect(
				clipped.needed,
				"the placeholder fits its field",
			).toBeLessThanOrEqual(clipped.room);
		});
	});
}
