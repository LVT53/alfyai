import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import { login, openConversationComposer } from "./helpers";

/**
 * Everyday redesign — the composer bar, the "+" menu and the phone sheets.
 *
 * Three things this covers that nothing else does: the bar is five controls
 * and no bare "0"; the menu is a real menu for the keyboard; and on a phone
 * the menu and the model picker are sheets that sit at the bottom of the
 * VIEWPORT — the assertion that would have caught the containing-block bug,
 * where a sheet opened from the landing page's translated composer rendered
 * 200px up the screen.
 */

const PHONE = { width: 390, height: 844 };
/** The window the owner reported the "+" menu clipping on. */
const SHORT_DESKTOP = { width: 1280, height: 720 };

/** Every state of every bar icon paints nothing behind the glyph. */
const NO_FILL = new Set(["rgba(0, 0, 0, 0)", "transparent"]);

async function backgroundOf(locator: Locator): Promise<string> {
	return locator.evaluate(
		(element) => getComputedStyle(element).backgroundColor,
	);
}

/**
 * A conversation with enough in it that the page scrolls and the composer
 * sits on the bottom edge of the window — which is the whole condition for
 * the "+" menu having nowhere to grow.
 *
 * Seeded rather than sent: the composer only has to BE at the bottom, and
 * driving twenty real turns through a model to get it there would make this
 * a test of the streaming stack.
 */
async function seedLongConversation(id: string): Promise<void> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();

	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));

	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId: admin.id,
		title: "A conversation long enough to scroll",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(messages).values(
		Array.from({ length: 24 }, (_, index) => ({
			id: `${id}-msg-${index}`,
			conversationId: id,
			messageSequence: index + 1,
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content:
				index % 2 === 0
					? `Question number ${index / 2 + 1} about the battery rules.`
					: "A paragraph of answer, long enough that the thread scrolls and the composer ends up on the bottom edge of the window rather than in the middle of the page.",
			createdAt: now,
		})),
	);
}

async function openMenuAtBottom(page: Page, conversationId: string) {
	await page.setViewportSize(SHORT_DESKTOP);
	await login(page);
	await page.goto(`/chat/${conversationId}`, {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("message-input")).toBeVisible();
	await page.getByTestId("composer-tools-trigger").click();
	const menu = page.getByTestId("composer-tools-menu");
	await expect(menu).toBeVisible();
	return menu;
}

/**
 * Assert a sheet's bottom edge is the VIEWPORT's bottom edge.
 *
 * Polled, because the sheet flies up from below and a box measured on the
 * first frame is still 260px down the screen. This is the assertion that
 * would have caught the containing-block bug: a sheet rendered inside the
 * landing page's translated composer settles ~200px short of the bottom and
 * never reaches it.
 */
async function expectPinnedToViewportBottom(sheet: Locator) {
	await expect
		.poll(
			async () => {
				const box = await sheet.boundingBox();
				if (!box) return Number.POSITIVE_INFINITY;
				return Math.abs(box.y + box.height - PHONE.height);
			},
			{ timeout: 3000 },
		)
		.toBeLessThanOrEqual(2);
}

test.describe("Composer Direction B — desktop", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await openConversationComposer(page);
	});

	test("the bar rests as plus, attach, accounts, thinking, send", async ({
		page,
	}) => {
		await expect(page.getByTestId("composer-tools-trigger")).toBeVisible();
		await expect(page.getByTestId("attach-toggle")).toBeVisible();
		await expect(page.getByTestId("connections-toggle")).toBeVisible();
		await expect(page.getByTestId("send-button")).toBeVisible();

		// No bare "0": with nothing connected the accounts icon rests
		// unfilled and carries no count at all.
		const accounts = page.getByTestId("connections-toggle");
		await expect(accounts).toHaveAttribute("aria-pressed", "false");
		await expect(accounts.locator(".composer-connections-count")).toHaveCount(
			0,
		);

		// Every control names itself AND its state, so one hover answers both
		// "what is this" and "is it on".
		const attachLabel = await page
			.getByTestId("attach-toggle")
			.getAttribute("aria-label");
		expect(attachLabel?.length ?? 0).toBeGreaterThan(0);
		expect(await page.getByTestId("attach-toggle").getAttribute("title")).toBe(
			attachLabel,
		);
	});

	test("the plus opens a menu the arrow keys can walk", async ({ page }) => {
		const trigger = page.getByTestId("composer-tools-trigger");
		await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
		await trigger.click();

		const menu = page.getByTestId("composer-tools-menu");
		await expect(menu).toBeVisible();
		await expect(trigger).toHaveAttribute("aria-expanded", "true");

		// Incognito lives here and nowhere else now.
		await expect(page.getByTestId("incognito-toggle")).toBeVisible();
		await expect(page.getByTestId("composer-menu-web-search")).toBeVisible();

		// Roving focus: the first row holds it, ArrowDown moves it on, and
		// the row that has it is the only one with tabindex 0.
		const firstRow = page.getByTestId("composer-menu-attach");
		await expect(firstRow).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(firstRow).not.toBeFocused();
		await expect(menu.locator('[role="menuitem"][tabindex="0"]')).toHaveCount(
			1,
		);

		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
	});

	test("a switch row flips in place and the menu stays open", async ({
		page,
	}) => {
		await page.getByTestId("composer-tools-trigger").click();
		const webSearch = page.getByTestId("composer-menu-web-search");
		await expect(webSearch).toHaveAttribute("aria-checked", "false");

		await webSearch.click();

		await expect(webSearch).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
	});

	// The owner: "the icons have a circle behind them, and I liked it better
	// when the active colour accent was more low-key." Nothing paints a disc
	// now — at rest, on hover, or on. What says "on" is the glyph colour and
	// a 4px dot under it.
	test("no icon paints a disc, in any state", async ({ page }) => {
		const attach = page.getByTestId("attach-toggle");
		expect(NO_FILL.has(await backgroundOf(attach))).toBe(true);

		await attach.hover();
		expect(NO_FILL.has(await backgroundOf(attach))).toBe(true);

		// The plus takes the same on-treatment while its menu is open.
		const plus = page.getByTestId("composer-tools-trigger");
		await plus.click();
		await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
		await expect(plus).toHaveClass(/composer-face--on/);
		expect(NO_FILL.has(await backgroundOf(plus))).toBe(true);

		const dot = await plus.evaluate((element) => {
			const style = getComputedStyle(element, "::after");
			return {
				content: style.content,
				width: style.width,
				background: style.backgroundColor,
			};
		});
		expect(dot.content).not.toBe("none");
		expect(dot.width).toBe("4px");
		expect(NO_FILL.has(dot.background)).toBe(false);
	});

	// "Manage connections" was a full-width row under the account switches,
	// where it read as one more account. It is the way OUT of the composer,
	// so it sits in the heading opposite the count.
	test("Manage connections is a link in the ACCOUNTS heading", async ({
		page,
	}) => {
		await page.getByTestId("composer-tools-trigger").click();
		const link = page.getByTestId("composer-menu-manage-connections");
		await expect(link).toBeVisible();

		const heading = page
			.getByTestId("composer-tools-menu")
			.locator(".menu-section", { has: link });
		await expect(heading).toHaveCount(1);
		await expect(link).toHaveCount(1);
		expect(await link.evaluate((element) => element.getAttribute("role"))).toBe(
			null,
		);

		// Heading text on the left, link on the right, on one line.
		const title = heading.locator(".menu-section__title");
		const titleBox = await title.boundingBox();
		const linkBox = await link.boundingBox();
		expect(linkBox?.x ?? 0).toBeGreaterThan(titleBox?.x ?? 0);
		expect(Math.abs((linkBox?.y ?? 0) - (titleBox?.y ?? 0))).toBeLessThan(24);

		// Tab reaches it: the arrow keys walk the rows, the link is above them.
		await link.focus();
		await expect(link).toBeFocused();
	});
});

// The two defects that only show up with the composer where it actually
// lives: on the bottom edge of a short window, at the end of a real thread.
test.describe("Composer Direction B — a short window with the composer at the bottom", () => {
	const CONVERSATION_ID = "conv-composer-short-window";

	test.beforeEach(async () => {
		await seedLongConversation(CONVERSATION_ID);
	});

	// The defect: the menu opened upward from a fixed `bottom: calc(100% +
	// 8px)` with no measurement, so its top was simply cut off.
	test("the menu opens fully inside the viewport", async ({ page }) => {
		const menu = await openMenuAtBottom(page, CONVERSATION_ID);

		const box = await menu.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
			SHORT_DESKTOP.height,
		);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
			SHORT_DESKTOP.width,
		);

		// Portalled, and measured — not an offset from the composer.
		await expect(
			menu.evaluate((element) => element.parentElement?.tagName ?? ""),
		).resolves.toBe("BODY");

		// Every row is reachable: the menu scrolls inside itself rather than
		// growing past the edge.
		const lastRow = page.getByTestId("composer-menu-style");
		await lastRow.scrollIntoViewIfNeeded();
		await expect(lastRow).toBeVisible();
	});

	// The defect: the model list opened upward from the Model row, over the
	// menu's own Atlas / Incognito / account rows.
	test("the model flyout opens beside the menu, not over its rows", async ({
		page,
	}) => {
		const menu = await openMenuAtBottom(page, CONVERSATION_ID);
		await page.getByTestId("model-selector-trigger").click();

		const flyout = page.getByRole("listbox", { name: /model/i }).first();
		await expect(flyout).toBeVisible();

		const menuBox = await menu.boundingBox();
		const flyoutBox = await flyout.boundingBox();
		expect(menuBox).not.toBeNull();
		expect(flyoutBox).not.toBeNull();
		if (!menuBox || !flyoutBox) return;

		// Disjoint boxes: the flyout is entirely to one side of the menu.
		const clearOnTheRight = flyoutBox.x >= menuBox.x + menuBox.width;
		const clearOnTheLeft = flyoutBox.x + flyoutBox.width <= menuBox.x;
		expect(clearOnTheRight || clearOnTheLeft).toBe(true);

		// And inside the window it was clamped to.
		expect(flyoutBox.y).toBeGreaterThanOrEqual(0);
		expect(flyoutBox.y + flyoutBox.height).toBeLessThanOrEqual(
			SHORT_DESKTOP.height,
		);
		expect(flyoutBox.x + flyoutBox.width).toBeLessThanOrEqual(
			SHORT_DESKTOP.width,
		);

		// The Atlas row it used to cover is still readable.
		await expect(page.getByTestId("composer-menu-atlas")).toBeVisible();
	});

	// Style is a second, smaller list next to Model and had the same problem.
	test("the style flyout opens beside the menu too", async ({ page }) => {
		const menu = await openMenuAtBottom(page, CONVERSATION_ID);
		const style = page.getByTestId("composer-menu-style");
		if ((await style.count()) === 0) {
			test.skip(true, "no personality profiles in this deployment");
			return;
		}
		await style.click();

		const flyout = page.locator(".model-selector__dropdown--flyout").first();
		await expect(flyout).toBeVisible();

		const menuBox = await menu.boundingBox();
		const flyoutBox = await flyout.boundingBox();
		if (!menuBox || !flyoutBox) throw new Error("boxes not measurable");
		expect(
			flyoutBox.x >= menuBox.x + menuBox.width ||
				flyoutBox.x + flyoutBox.width <= menuBox.x,
		).toBe(true);
	});
});

test.describe("Composer Direction B — phone sheets", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize(PHONE);
		await login(page);
		await openConversationComposer(page);
	});

	test("the menu becomes a sheet pinned to the bottom of the viewport", async ({
		page,
	}) => {
		await page.getByTestId("composer-tools-trigger").click();

		const menu = page.getByTestId("composer-tools-menu");
		await expect(menu).toBeVisible();
		await expect(page.getByTestId("composer-tools-menu-scrim")).toBeVisible();

		// The grabber is a 36x4 bar inside a 44px drag strip.
		const grabber = page.getByTestId("composer-tools-menu-grabber");
		await expect(grabber).toBeVisible();
		await expect
			.poll(async () => (await grabber.boundingBox())?.height ?? 0)
			.toBeGreaterThanOrEqual(44);

		// The whole point of the portal: the sheet's bottom edge is the
		// viewport's bottom edge, not wherever the composer happens to be.
		await expectPinnedToViewportBottom(menu);
		await expect(
			menu.evaluate((element) => element.parentElement?.tagName ?? ""),
		).resolves.toBe("BODY");

		// The bar keeps its 44px targets without a disc inside them.
		const barAttach = page.getByTestId("attach-toggle");
		await expect
			.poll(async () => (await barAttach.boundingBox())?.height ?? 0)
			.toBeGreaterThanOrEqual(44);
		expect(
			await barAttach.evaluate(
				(element) => getComputedStyle(element, "::before").content,
			),
		).toBe("none");

		// Rows are 44px targets, full width.
		const attach = page.getByTestId("composer-menu-attach");
		await expect
			.poll(async () => (await attach.boundingBox())?.height ?? 0)
			.toBeGreaterThanOrEqual(44);

		// The grabber is a dismissal, like every other sheet's.
		await grabber.click();
		await expect(menu).toBeHidden();
	});

	test("the model picker opens as a sheet from inside the menu", async ({
		page,
	}) => {
		await page.getByTestId("composer-tools-trigger").click();
		await page.getByTestId("model-selector-trigger").click();

		const sheet = page.getByRole("listbox", { name: /model/i }).first();
		await expect(sheet).toBeVisible();

		await expectPinnedToViewportBottom(sheet);

		// A picker ends in Cancel and a positive button — negative left,
		// positive right.
		const footer = sheet.locator(".model-selector__sheet-footer");
		await expect(footer).toBeVisible();
		const buttons = footer.locator("button");
		await expect(buttons).toHaveCount(2);
		const firstBox = await buttons.nth(0).boundingBox();
		const secondBox = await buttons.nth(1).boundingBox();
		expect(firstBox?.x ?? 0).toBeLessThan(secondBox?.x ?? 0);

		// Escape leaves the picker but keeps the menu it was opened from.
		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();
		await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
	});

	// One scrim per screen, not one per sheet.
	//
	// `--scrim` is a single token so two surfaces cannot disagree about how
	// dark "dimmed" is — and two of them laid over each other disagree with
	// both: 0.32 over 0.32 reads as 0.54. The picker's scrim also sat ABOVE
	// the menu's own sheet, so the menu you opened the picker from went dark
	// behind it, which is exactly what the board rules out ("the thing they
	// were anchored to stays visible above the scrim").
	test("a sheet opened from a sheet does not dim the page twice", async ({
		page,
	}) => {
		await page.getByTestId("composer-tools-trigger").click();
		await expect(page.getByTestId("composer-tools-menu-scrim")).toBeVisible();

		await page.getByTestId("model-selector-trigger").click();
		await expect(page.getByTestId("model-sheet-grabber")).toBeVisible();

		// Exactly one element paints --scrim, and it is the menu's.
		const scrims = await page.evaluate(
			() =>
				[...document.querySelectorAll<HTMLElement>("body *")].filter(
					(element) => {
						const background = getComputedStyle(element).backgroundColor;
						return (
							element.getBoundingClientRect().width >= window.innerWidth &&
							element.getBoundingClientRect().height >= window.innerHeight &&
							/^rgba\(0, 0, 0, 0\.\d+\)$/.test(background)
						);
					},
				).length,
		);
		expect(scrims).toBe(1);

		// And the menu behind the picker is still legible rather than dimmed.
		await expect(page.getByTestId("composer-menu-attach")).toBeVisible();
	});

	// The containing-block bug, on the one sheet the portal work missed.
	//
	// The LANDING page is the case that matters: it centres its composer with
	// `translateY(-50%)`, which makes that layer the containing block for
	// anything `position: fixed` inside it. The Library picker measured
	// 390x401 starting 221px down an 844px screen — its backdrop covering a
	// strip of the page instead of the page, and the picker itself floating
	// 231px above the bottom edge.
	test("the Library picker fills the viewport, not the composer, on the landing page", async ({
		page,
	}) => {
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("message-input")).toBeVisible();

		await page.getByTestId("attach-toggle").click();
		await expect(page.getByTestId("attachment-picker")).toBeVisible();
		await page.getByTestId("attachment-picker-library").click();

		const backdrop = page.locator(".linked-document-backdrop");
		await expect(backdrop).toBeVisible();
		await expect
			.poll(async () => {
				const box = await backdrop.boundingBox();
				if (!box) return null;
				return {
					x: Math.round(box.x),
					y: Math.round(box.y),
					width: Math.round(box.width),
					height: Math.round(box.height),
				};
			})
			.toEqual({ x: 0, y: 0, width: PHONE.width, height: PHONE.height });
	});
});
