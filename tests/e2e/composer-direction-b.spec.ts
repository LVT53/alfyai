import { expect, type Locator, test } from "@playwright/test";
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
});
