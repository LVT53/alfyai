import { expect, type Page, test } from "@playwright/test";
import { seedConversationWithContext } from "./context-ring-helpers";
import { login, waitForHydration } from "./helpers";

// The context-usage ring sits at the bottom of the composer and its panel is
// anchored to the ring's LEFT edge, growing right. On a wide window the panel
// fits; on a narrow one it does not — at 390x844 the panel's right edge landed
// at 587px, so roughly half of it, the layer chips included, was off screen.
//
// The viewport here is deliberately NOT a touch device: a narrow window driven by
// a mouse never reports a coarse pointer, and it is the window's width that the
// popup has to fit in. What this spec pins is that it stays on screen there. The
// popup is the same box at every width now (painted in <body>, placed from the
// ring's rectangle); where it stands next to its ring (on the home page, on a
// project's, on a touch screen, beside a docked document panel) is
// context-usage-ring-placement.spec.ts's.
//
// The ring only renders once there is something to measure, so the spec seeds
// a real conversation plus its persisted context status and usage row and
// loads the ordinary chat route: the panel under test is the production one,
// with production data.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const RING_CONVERSATION_ID = "e2e-context-ring-popover";

/**
 * A campaign modal can swallow the click that opens the panel. A fresh e2e
 * database has no campaign, but the spec does not depend on that.
 */
async function dismissCampaignModal(page: Page): Promise<void> {
	const modal = page.locator('[role="dialog"][aria-label*="ampaign"]');
	if (await modal.isVisible().catch(() => false)) {
		await modal.getByRole("button", { name: "Close" }).first().click();
		await expect(modal).toBeHidden();
	}
}

const popover = (page: Page) => page.locator(".ring-popover");

/**
 * Open the ring's panel and wait for it to actually be shown. `opacity: 0`
 * still counts as "visible" to Playwright, so the panel's own computed opacity
 * is the assertion that it is really on screen.
 */
async function openRingPopover(page: Page) {
	await page.locator(".ring-button").click();
	await expect
		.poll(() => popover(page).evaluate((el) => getComputedStyle(el).opacity))
		.toBe("1");
}

test.beforeEach(async ({ page }) => {
	await seedConversationWithContext(
		RING_CONVERSATION_ID,
		"Context ring popover layout",
	);
	await login(page);
	await page.goto(`/chat/${RING_CONVERSATION_ID}`, {
		waitUntil: "domcontentloaded",
	});
	await dismissCampaignModal(page);
	await expect(page.locator(".ring-button")).toBeVisible({ timeout: 15000 });
	// The panel opens from what the ring knows (a press, the mouse over it), so
	// the press has to land after the page has hydrated: the markup is there
	// first, and a click on it does nothing.
	await waitForHydration(page);
});

test.describe("context-usage popover on a narrow viewport", () => {
	test.use({ viewport: PHONE });

	test("keeps the whole panel inside a 390x844 viewport", async ({ page }) => {
		await openRingPopover(page);

		const box = await popover(page).boundingBox();
		expect(box, "the panel must have a box once it is open").not.toBeNull();
		if (!box) return;

		// The measured failure: right edge at 587 on a 390px viewport.
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);

		// Nothing may be pushed sideways to make room for it.
		const horizontalOverflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		expect(horizontalOverflow).toBeLessThanOrEqual(0);

		// Every row, and the layer chips, are on screen and reachable.
		const chips = page.locator(".popover-chip");
		await expect(chips).toHaveCount(3);
		for (let index = 0; index < 3; index += 1) {
			const chipBox = await chips.nth(index).boundingBox();
			expect(chipBox).not.toBeNull();
			if (!chipBox) continue;
			expect(chipBox.x).toBeGreaterThanOrEqual(0);
			expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(PHONE.width);
			expect(chipBox.y).toBeGreaterThanOrEqual(0);
			expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(PHONE.height);
		}
	});
});

test.describe("context-usage popover on desktop", () => {
	test.use({ viewport: DESKTOP });

	test("keeps the panel anchored to the ring at 1440x900", async ({ page }) => {
		await openRingPopover(page);

		const ringBox = await page.locator(".ring-root").boundingBox();
		const box = await popover(page).boundingBox();
		expect(ringBox).not.toBeNull();
		expect(box).not.toBeNull();
		if (!ringBox || !box) return;

		// Unchanged desktop behaviour: left edge on the ring's left edge and
		// the full 25rem width.
		expect(Math.abs(box.x - ringBox.x)).toBeLessThanOrEqual(1);
		expect(box.width).toBeCloseTo(400, 0);
		expect(box.x + box.width).toBeLessThanOrEqual(DESKTOP.width);
	});
});
