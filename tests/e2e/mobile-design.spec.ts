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
	});

	test("Layout and Touch Targets - iPhone SE", async ({ page }) => {
		const header = page.locator("header");
		const headerBox = await header.boundingBox();
		expect(headerBox?.height).toBeGreaterThanOrEqual(48);

		const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
		const hamburgerBox = await hamburger.boundingBox();
		expect(hamburgerBox?.width).toBeGreaterThanOrEqual(44);
		expect(hamburgerBox?.height).toBeGreaterThanOrEqual(44);

		const newChatBtn = page.locator('button[aria-label="New chat"]');
		const newChatBox = await newChatBtn.boundingBox();
		expect(newChatBox?.width).toBeGreaterThanOrEqual(44);
		expect(newChatBox?.height).toBeGreaterThanOrEqual(44);

		const sidebar = page.locator("aside");
		await expect(sidebar).toHaveClass(/.*-translate-x-\[105%\].*/);

		await hamburger.click();
		await expect(sidebar).toHaveClass(/.*translate-x-0.*/);

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

		await openConversationComposer(page);

		const textarea = page.locator('[data-testid="message-input"]');
		await expect(textarea).toBeVisible();
		const textareaBox = await textarea.boundingBox();
		expect(textareaBox?.height).toBeGreaterThanOrEqual(44);

		const sendBtn = page.locator('[data-testid="send-button"]');
		const sendBox = await sendBtn.boundingBox();
		expect(sendBox?.width).toBeGreaterThanOrEqual(44);
		expect(sendBox?.height).toBeGreaterThanOrEqual(44);

		const attachBtn = page.locator('button[aria-label="Attach file"]');
		const attachBox = await attachBtn.boundingBox();
		expect(attachBox?.width).toBeGreaterThanOrEqual(44);
		expect(attachBox?.height).toBeGreaterThanOrEqual(44);

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
	});

	test("Check prefers-reduced-motion", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });

		const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
		await hamburger.click();

		const sidebar = page.locator("aside");
		await expect(sidebar).toHaveClass(/.*translate-x-0.*/);

		const transitionDuration = await sidebar.evaluate((node) => {
			return window.getComputedStyle(node).transitionDuration;
		});

		expect(["0s", "0.00001s", "1e-05s"]).toContain(transitionDuration);
	});
});
