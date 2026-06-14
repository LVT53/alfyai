import { expect, type Page, test } from "@playwright/test";
import {
	advancePastConversationRefreshDebounce,
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
	sendMessage,
} from "./helpers";

const MOCK_CONTENT_TEXT =
	"This is the extracted text from the integration test file.";

function buildSseBody(text: string): string {
	return buildAiSdkUiStreamBody(text);
}

async function triggerVisibilityChange(page: Page) {
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			writable: true,
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

test.describe("Big Patch integration — cross-feature workflow", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("drop file → appears in composer → send → appears in message → click → modal opens", async ({
		page,
	}) => {
		const ARTIFACT_ID = "integration-test-artifact";
		const FILE_NAME = "integration-test-doc.txt";

		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: ARTIFACT_ID,
						type: "source_document",
						retrievalClass: "durable",
						name: FILE_NAME,
						mimeType: "text/plain",
						sizeBytes: 256,
						conversationId: null,
						summary: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					normalizedArtifact: null,
					reusedExistingArtifact: false,
					honcho: { uploaded: false, mode: "none" },
					promptReady: true,
					promptArtifactId: ARTIFACT_ID,
					readinessError: null,
				}),
			});
		});

		await page.route("**/api/knowledge/**", async (route) => {
			const url = route.request().url();
			if (url.includes("/api/knowledge/") && !url.includes("/upload")) {
				await route.fulfill({
					status: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						artifact: {
							id: ARTIFACT_ID,
							name: FILE_NAME,
							contentText: MOCK_CONTENT_TEXT,
						},
						links: [],
					}),
				});
				return;
			}
			await route.continue();
		});

		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
				body: buildSseBody("I received your file. Here is my analysis."),
			});
		});

		await page.route("**/api/conversations/*/title", async (route) => {
			await route.fulfill({ json: { title: "Integration Test" } });
		});

		// ── Step 2: Open composer ──
		await openConversationComposer(page);

		// ── Step 3: Verify drag-and-drop overlay (file DnD feature) ──
		await page.locator(".chat-page").dispatchEvent("dragenter", {
			dataTransfer: { types: ["Files"], dropEffect: "copy" },
		});
		await expect(page.getByTestId("drop-zone-overlay")).toBeVisible();
		await expect(page.getByTestId("drop-zone-overlay")).toContainText(
			"Drop files to attach",
		);

		await page.locator(".chat-page").dispatchEvent("dragleave", {
			dataTransfer: { types: ["Files"] },
		});
		await expect(page.getByTestId("drop-zone-overlay")).toBeHidden();

		// ── Step 4: Upload file via input (Playwright can't do real OS DnD in headless) ──
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: FILE_NAME,
			mimeType: "text/plain",
			buffer: Buffer.from("Integration test file content"),
		});

		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator(".file-attachment").first()).toContainText(
			FILE_NAME,
		);

		// ── Step 5: Send the message with attachment ──
		await page.getByTestId("message-input").fill("Please analyze this file");
		await page.getByTestId("send-button").click();

		await page.waitForURL(/\/chat\//, { timeout: 15000 });

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Please analyze this file",
			{ timeout: 10000 },
		);

		const messageAttachment = page
			.locator('[data-testid="user-message"] .file-attachment')
			.first();
		await expect(messageAttachment).toBeVisible({ timeout: 10000 });
		await expect(messageAttachment).toContainText(FILE_NAME);

		// ── Step 6: Click the attachment to open the content modal ──
		await messageAttachment.click();

		await expect(page.locator('[role="dialog"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[role="dialog"]')).toContainText(FILE_NAME);
		await expect(page.locator("pre.content-text")).toContainText(
			MOCK_CONTENT_TEXT,
		);

		// ── Step 7: Close the modal via Escape ──
		await page.keyboard.press("Escape");
		await expect(page.locator('[role="dialog"]')).toBeHidden({
			timeout: 5000,
		});
	});

	test("retry after stream error then verify conversation list refreshes on focus", async ({
		page,
		context,
	}) => {
		let retryCalled = false;

		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 500,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "Backend failure" }),
			});
		});

		await page.route("**/api/chat/retry", async (route) => {
			retryCalled = true;
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody("Retry successful after cleanup"),
			});
		});

		// Send a message that fails
		await openConversationComposer(page);
		await sendMessage(page, "This will fail");

		const retryBtn = page.getByRole("button", { name: /retry/i });
		await expect(retryBtn).toBeVisible({ timeout: 15000 });

		await retryBtn.click();

		expect(retryCalled).toBe(true);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Retry successful after cleanup",
			{ timeout: 15000 },
		);

		// Verify conversation refresh: create a conversation in a second context, then trigger focus
		const page2 = await context.newPage();
		await login(page2);
		await openConversationComposer(page2);
		await sendMessage(page2, "Second context conversation");
		await page2.waitForURL(/\/chat\//, { timeout: 15000 });

		await advancePastConversationRefreshDebounce(page);
		const refreshResponse = page.waitForResponse(
			(candidate) =>
				candidate.url().endsWith("/api/conversations") &&
				candidate.request().method() === "GET",
			{ timeout: 10000 },
		);
		await triggerVisibilityChange(page);
		expect((await refreshResponse).status()).toBe(200);

		const conversationItems = page.getByTestId("conversation-item");
		await expect
			.poll(() => conversationItems.count(), { timeout: 10000 })
			.toBeGreaterThanOrEqual(2);

		await page2.close();
	});

	test("admin lastActiveAt is updated after browsing the app", async ({
		page,
	}) => {
		const beforeActivity = await page.evaluate(async () => {
			const response = await fetch("/api/admin/users");
			const body = (await response.json()) as {
				users: Array<{ id: string; email: string; lastActiveAt: number }>;
			};
			return body.users;
		});

		const adminUser = beforeActivity.find((u) => u.email === "admin@local");
		expect(adminUser).toBeDefined();
		if (!adminUser) {
			throw new Error("Expected admin user before activity");
		}

		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		const afterActivity = await page.evaluate(async () => {
			const response = await fetch("/api/admin/users");
			const body = (await response.json()) as {
				users: Array<{ id: string; email: string; lastActiveAt: number }>;
			};
			return body.users;
		});

		const adminUserAfter = afterActivity.find((u) => u.email === "admin@local");
		expect(adminUserAfter).toBeDefined();
		if (!adminUserAfter) {
			throw new Error("Expected admin user after activity");
		}
		expect(adminUserAfter.lastActiveAt).toBeGreaterThanOrEqual(
			adminUser.lastActiveAt,
		);

		await page.getByRole("button", { name: "Administration" }).click();
		await page.getByRole("button", { name: "Users" }).click();
		const userRows = page.locator('[data-testid="admin-user-row"]');
		await expect(userRows.first()).toBeVisible();
	});
});
