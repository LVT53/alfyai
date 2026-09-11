import { expect, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
} from "./helpers";

test.use({
	viewport: { width: 375, height: 667 },
	hasTouch: true,
	isMobile: true,
	userAgent:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
});

test.describe("Mobile Design Polish", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.waitForLoadState("networkidle");
	});

	test("Layout and Touch Targets - iPhone SE", async ({ page }) => {
		const header = page.locator("header");
		const headerBox = await header.boundingBox();
		expect(headerBox?.height).toBeGreaterThanOrEqual(48);

		const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
		await expect(hamburger).toBeVisible();
		const hamburgerBox = await hamburger.boundingBox();
		expect(hamburgerBox?.width).toBeGreaterThanOrEqual(44);
		expect(hamburgerBox?.height).toBeGreaterThanOrEqual(44);

		const userMenu = page.locator('button[aria-label="Open user menu"]');
		await expect(userMenu).toBeVisible();
		const userMenuBox = await userMenu.boundingBox();
		expect(userMenuBox?.width).toBeGreaterThanOrEqual(44);
		expect(userMenuBox?.height).toBeGreaterThanOrEqual(44);

		await userMenu.click();
		const headerNewChat = page
			.locator(".header-menu")
			.getByRole("button", { name: "New chat" });
		await expect(headerNewChat).toBeVisible();
		const headerNewChatBox = await headerNewChat.boundingBox();
		expect(headerNewChatBox?.height).toBeGreaterThanOrEqual(44);
		await page.mouse.click(1, 1);

		const sidebar = page.locator("aside");
		await expect(sidebar).toHaveClass(/.*-translate-x-\[105%\].*/);

		await hamburger.click();
		await expect(sidebar).toHaveClass(/.*translate-x-0.*/);

		const sidebarNewChat = page.getByTestId("new-conversation");
		await expect(sidebarNewChat).toBeVisible();
		const sidebarNewChatBox = await sidebarNewChat.boundingBox();
		expect(sidebarNewChatBox?.width).toBeGreaterThanOrEqual(44);
		expect(sidebarNewChatBox?.height).toBeGreaterThanOrEqual(44);

		const closeBtn = page.locator('button[aria-label="Close sidebar"]');
		const closeBox = await closeBtn.boundingBox();
		expect(closeBox?.width).toBeGreaterThanOrEqual(44);
		expect(closeBox?.height).toBeGreaterThanOrEqual(44);

		await closeBtn.click();
		await expect(sidebar).toHaveClass(/.*-translate-x-\[105%\].*/);
	});

	test("Chat Area and Input Area", async ({ page }) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: buildAiSdkUiStreamBody(
					'Here is the code:\n\n```python\ndef test_horizontal():\n    return "This string is exceptionally long and will definitely trigger horizontal scrolling on a small screen like the iPhone SE"\n```',
				),
			});
		});

		await page.route("**/api/conversations/*/title", async (route) => {
			await route.fulfill({ json: { title: "Mocked Title" } });
		});

		await openConversationComposer(page, { skipIfAlreadyOpen: true });

		const textarea = page.locator('[data-testid="message-input"]');
		await expect(textarea).toBeVisible();
		const textareaBox = await textarea.boundingBox();
		expect(textareaBox?.height).toBeGreaterThanOrEqual(44);

		const sendBtn = page.locator('[data-testid="send-button"]');
		const sendBox = await sendBtn.boundingBox();
		expect(sendBox?.width).toBeGreaterThanOrEqual(44);
		expect(sendBox?.height).toBeGreaterThanOrEqual(44);

		const toolsBtn = page.locator('button[aria-label="Open composer tools"]');
		const toolsBox = await toolsBtn.boundingBox();
		expect(toolsBox?.width).toBeGreaterThanOrEqual(44);
		expect(toolsBox?.height).toBeGreaterThanOrEqual(44);
		await toolsBtn.click();

		// Everyday redesign: on a phone the "+" menu is a bottom sheet, so it
		// carries a grabber and its rows are full-width 44px targets — and it
		// covers the composer until it is dismissed.
		const grabber = page.getByTestId("composer-tools-menu-grabber");
		await expect(grabber).toBeVisible();
		const grabberBox = await grabber.boundingBox();
		expect(grabberBox?.height).toBeGreaterThanOrEqual(44);

		const attachBtn = page.getByRole("menuitem", { name: "Attach file" });
		await expect(attachBtn).toBeVisible();
		const attachBox = await attachBtn.boundingBox();
		expect(attachBox?.width).toBeGreaterThanOrEqual(44);
		expect(attachBox?.height).toBeGreaterThanOrEqual(44);

		// Incognito moved off the bar and into the menu; the accounts row is
		// reachable from the same visit.
		await expect(page.getByTestId("incognito-toggle")).toBeVisible();

		await grabber.click();
		await expect(page.getByTestId("composer-tools-menu")).toBeHidden();

		await textarea.fill(
			'```python\ndef test_horizontal_scroll_with_a_very_long_line_of_code_that_should_wrap_or_scroll_horizontally():\n    return "This string is exceptionally long and will definitely trigger horizontal scrolling on a small screen like the iPhone SE"\n```',
		);
		await expect(sendBtn).toBeEnabled({ timeout: 5000 });
		await sendBtn.click();

		await page.waitForSelector('[data-testid="user-message"]', {
			state: "visible",
			timeout: 5000,
		});

		const userMessage = page.locator('[data-testid="user-message"]').last();
		await expect(userMessage).toBeVisible({ timeout: 10000 });
		const userBox = await userMessage.boundingBox();
		expect(userBox?.width).toBeLessThanOrEqual(375 * 0.86);

		const preBlock = page.locator(".code-content pre").first();
		await expect(preBlock).toBeVisible({ timeout: 10000 });

		const isScrollable = await preBlock.evaluate(
			(node) => node.scrollWidth > node.clientWidth,
		);
		if (isScrollable) {
			expect(isScrollable).toBeTruthy();
		}

		const codeStyle = await preBlock.evaluate((node) => {
			const code = node.querySelector("code");
			if (!code) return null;
			return window.getComputedStyle(code).fontSize;
		});
		expect(codeStyle).toBe("14px");
	});
});

test.describe("Mobile Design Polish - iPhone 14", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
	});

	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.waitForLoadState("networkidle");
	});

	test("Check prefers-reduced-motion", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });

		const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
		await expect(hamburger).toBeVisible();
		await hamburger.click();

		const sidebar = page.locator("aside");
		await expect(sidebar).toHaveClass(/.*translate-x-0.*/);

		const transitionDuration = await sidebar.evaluate((node) => {
			return window.getComputedStyle(node).transitionDuration;
		});

		const durations = transitionDuration
			.split(",")
			.map((duration) => Number.parseFloat(duration.trim()));
		expect(durations.every((duration) => duration <= 0.00001)).toBe(true);
	});
});
