import { expect, test } from "@playwright/test";
import { buildAiSdkUiStreamBody } from "./helpers";

test.use({
	viewport: { width: 375, height: 667 },
	hasTouch: true,
	isMobile: true,
	userAgent:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
});

test.describe("Mobile CSS Scale-Up (Task 2)", () => {
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

	test("Task 2.1-2.2: Message content and input font sizes are 16px on mobile", async ({
		page,
	}) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: buildAiSdkUiStreamBody(
					"This is a test message with **bold** and *italic* text.",
				),
			});
		});

		await page.route("**/api/conversations/*/title", async (route) => {
			await route.fulfill({ json: { title: "Mobile Scale Test" } });
		});

		await page.waitForSelector('button:has-text("New Conversation")');
		await page.click('button:has-text("New Conversation")');
		await page.waitForURL("**/chat/**", { timeout: 5000 });

		const textarea = page.locator('[data-testid="message-input"]');
		await expect(textarea).toBeVisible();

		const inputFontSize = await textarea.evaluate((node) => {
			return window.getComputedStyle(node).fontSize;
		});
		expect(parseInt(inputFontSize)).toBeGreaterThanOrEqual(16);

		await textarea.fill("Test message for font size verification");
		const sendBtn = page.locator('[data-testid="send-button"]');
		await expect(sendBtn).toBeEnabled();
		await sendBtn.click();

		await page.waitForSelector('[data-testid="assistant-message"]', {
			state: "visible",
			timeout: 5000,
		});

		const messageContent = page
			.locator('[data-testid="assistant-message"] .prose')
			.first();
		await expect(messageContent).toBeVisible();

		const messageFontSize = await messageContent.evaluate((node) => {
			return window.getComputedStyle(node).fontSize;
		});
		expect(parseInt(messageFontSize)).toBeGreaterThanOrEqual(16);
	});

	test("Task 2.6: Code blocks are 14px minimum on mobile", async ({ page }) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: buildAiSdkUiStreamBody(
					'Here is some code:\n\n```javascript\nconst example = "Hello World";\nconsole.log(example);\n```',
				),
			});
		});

		await page.route("**/api/conversations/*/title", async (route) => {
			await route.fulfill({ json: { title: "Code Block Test" } });
		});

		await page.waitForSelector('button:has-text("New Conversation")');
		await page.click('button:has-text("New Conversation")');
		await page.waitForURL("**/chat/**", { timeout: 5000 });

		const textarea = page.locator('[data-testid="message-input"]');
		await textarea.fill("Show me some code");
		const sendBtn = page.locator('[data-testid="send-button"]');
		await sendBtn.click();

		await page.waitForSelector(".code-content pre code", {
			state: "visible",
			timeout: 5000,
		});

		const codeBlock = page.locator(".code-content pre code").first();
		await expect(codeBlock).toBeVisible();

		const codeFontSize = await codeBlock.evaluate((node) => {
			return window.getComputedStyle(node).fontSize;
		});
		expect(parseInt(codeFontSize)).toBeGreaterThanOrEqual(14);
	});

	test("Task 2.9: Primary buttons have 48px touch targets on mobile", async ({
		page,
	}) => {
		await page.waitForSelector('button:has-text("New Conversation")');
		await page.click('button:has-text("New Conversation")');
		await page.waitForURL("**/chat/**", { timeout: 5000 });

		const sendBtn = page.locator('[data-testid="send-button"]');
		await expect(sendBtn).toBeVisible();

		const sendBox = await sendBtn.boundingBox();
		expect(sendBox?.width).toBeGreaterThanOrEqual(48);
		expect(sendBox?.height).toBeGreaterThanOrEqual(48);

		const toolsBtn = page.locator('button[aria-label="Open composer tools"]');
		if (await toolsBtn.isVisible()) {
			const toolsBox = await toolsBtn.boundingBox();
			expect(toolsBox?.width).toBeGreaterThanOrEqual(48);
			expect(toolsBox?.height).toBeGreaterThanOrEqual(48);
		}
	});

	test("Task 2.10: No horizontal overflow on 375px viewport", async ({
		page,
	}) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: buildAiSdkUiStreamBody(
					"This is a very long message that should wrap properly on mobile screens without causing horizontal overflow or breaking the layout. It contains enough text to ensure we can verify the wrapping behavior.",
				),
			});
		});

		await page.route("**/api/conversations/*/title", async (route) => {
			await route.fulfill({ json: { title: "Overflow Test" } });
		});

		await page.waitForSelector('button:has-text("New Conversation")');
		await page.click('button:has-text("New Conversation")');
		await page.waitForURL("**/chat/**", { timeout: 5000 });

		const textarea = page.locator('[data-testid="message-input"]');
		await textarea.fill("Test overflow behavior with a long message");
		const sendBtn = page.locator('[data-testid="send-button"]');
		await sendBtn.click();

		await page.waitForSelector('[data-testid="assistant-message"]', {
			state: "visible",
			timeout: 5000,
		});

		const hasHorizontalOverflow = await page.evaluate(() => {
			return (
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth
			);
		});
		expect(hasHorizontalOverflow).toBe(false);

		const messageBubbles = page.locator('[data-testid="assistant-message"]');
		const count = await messageBubbles.count();
		for (let i = 0; i < count; i++) {
			const bubble = messageBubbles.nth(i);
			const box = await bubble.boundingBox();
			expect(box?.width).toBeLessThanOrEqual(375 * 0.95);
		}
	});

	test("Task 2.3-2.5: Sidebar and header elements meet minimum font sizes", async ({
		page,
	}) => {
		const hamburger = page.locator('button[aria-label="Toggle sidebar"]');
		await hamburger.click();
		await page.waitForTimeout(300);

		const sidebar = page.locator("aside");
		await expect(sidebar).toBeVisible();

		const sidebarFontSize = await sidebar.evaluate((node) => {
			const firstText = node.querySelector("p, span, div");
			return firstText ? window.getComputedStyle(firstText).fontSize : null;
		});
		if (sidebarFontSize) {
			expect(parseInt(sidebarFontSize)).toBeGreaterThanOrEqual(14);
		}

		const closeBtn = page.locator('button[aria-label="Close sidebar"]');
		await closeBtn.click();
		await page.waitForTimeout(300);

		const header = page.locator("header");
		await expect(header).toBeVisible();

		const headerFontSize = await header.evaluate((node) => {
			const firstText = node.querySelector("h1, h2, span, div");
			return firstText ? window.getComputedStyle(firstText).fontSize : null;
		});
		if (headerFontSize) {
			expect(parseInt(headerFontSize)).toBeGreaterThanOrEqual(15);
		}
	});
});

test.describe("Mobile CSS Scale-Up - 320px viewport (small phone)", () => {
	test.use({
		viewport: { width: 320, height: 568 },
		hasTouch: true,
		isMobile: true,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
	});

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

	test("Font sizes remain readable on 320px viewport", async ({ page }) => {
		await page.waitForSelector('button:has-text("New Conversation")');
		await page.click('button:has-text("New Conversation")');
		await page.waitForURL("**/chat/**", { timeout: 5000 });

		const textarea = page.locator('[data-testid="message-input"]');
		const inputFontSize = await textarea.evaluate((node) => {
			return window.getComputedStyle(node).fontSize;
		});
		expect(parseInt(inputFontSize)).toBeGreaterThanOrEqual(16);

		const hasHorizontalOverflow = await page.evaluate(() => {
			return (
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth
			);
		});
		expect(hasHorizontalOverflow).toBe(false);
	});
});
