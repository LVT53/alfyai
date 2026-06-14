import { expect, test } from "@playwright/test";

test.describe("Responsive Layout", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");

		if (page.url().includes("/login")) {
			await page.waitForLoadState("domcontentloaded");
			await page.waitForSelector('input[name="email"]', { state: "visible" });
			await page.fill('input[name="email"]', "admin@local");
			await page.fill('input[name="password"]', "admin123");
			await page.click('button[type="submit"]');
			await page.waitForURL("**/");
		}
	});

	test.describe("Mobile Layout", () => {
		test.use({
			viewport: { width: 375, height: 667 },
			hasTouch: true,
			isMobile: true,
		});

		test("sidebar collapses on mobile", async ({ page }) => {
			const sidebar = page.locator("aside");
			await expect(sidebar).toHaveClass(/.*-translate-x-\[105%\].*/);

			const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
			await expect(hamburger).toBeVisible();
			await hamburger.click();

			await expect(sidebar).toHaveClass(/.*translate-x-0.*/, { timeout: 5000 });
			await expect(sidebar).toBeVisible();

			const closeBtn = page.locator('button[aria-label="Close sidebar"]');
			await closeBtn.click();
			await expect(sidebar).toHaveClass(/.*-translate-x-\[105%\].*/, {
				timeout: 5000,
			});
		});

		test("header is visible with correct touch targets", async ({ page }) => {
			const header = page.locator("header");
			await expect(header).toBeVisible();

			const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
			await expect(hamburger).toBeVisible();

			const newChatBtn = page.locator('button[aria-label="New chat"]');
			await expect(newChatBtn).toBeVisible();
		});
	});

	test.describe("Tablet Layout", () => {
		test.use({
			viewport: { width: 900, height: 1024 },
			hasTouch: true,
		});

		test("header remains available until desktop sidebar takes over", async ({
			page,
		}) => {
			const header = page.locator("header");
			await expect(header).toBeVisible();

			const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
			await expect(hamburger).toBeVisible();

			const sidebar = page.locator("aside");
			await expect(sidebar).toHaveClass(/.*-translate-x-\[105%\].*/);

			await hamburger.click();
			await expect(sidebar).toHaveClass(/.*translate-x-0.*/, { timeout: 5000 });
		});
	});

	test.describe("Desktop Layout", () => {
		test.use({
			viewport: { width: 1920, height: 1080 },
		});

		test("sidebar expanded on desktop", async ({ page }) => {
			const sidebar = page.locator("aside");
			await expect(sidebar).toBeVisible();

			const mainContent = page.locator("main");
			await expect(mainContent).toBeVisible();

			const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
			await expect(hamburger).toBeHidden();
		});

		test("desktop relies on the persistent sidebar instead of the mobile header", async ({
			page,
		}) => {
			const header = page.locator("header");
			await expect(header).toBeHidden();
		});
	});
});
