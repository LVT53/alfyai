import { expect, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
	sendMessage,
} from "./helpers";

function buildSseBody(text: string): string {
	return buildAiSdkUiStreamBody(text);
}

test.describe("Atomic retry with cleanup", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("retry after stream error calls /api/chat/retry endpoint", async ({
		page,
	}) => {
		let streamCallCount = 0;
		let retryCallCount = 0;

		await page.route("**/api/chat/stream", async (route) => {
			streamCallCount++;
			await route.fulfill({
				status: 500,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "Backend failure" }),
			});
		});

		await page.route("**/api/chat/retry", async (route) => {
			retryCallCount++;
			const reqBody = route.request().postDataJSON() as Record<string, unknown>;
			expect(reqBody.conversationId).toBeTruthy();
			expect(reqBody.assistantMessageId).toBeTruthy();
			expect(reqBody.streamId).toBeTruthy();
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody("Retry cleanup succeeded"),
			});
		});

		await openConversationComposer(page);
		await sendMessage(page, "Test retry cleanup");

		const retryBtn = page.getByRole("button", { name: /retry/i });
		await expect(retryBtn).toBeVisible({ timeout: 15000 });
		await retryBtn.click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Retry cleanup succeeded",
			{ timeout: 15000 },
		);
		expect(streamCallCount).toBe(1);
		expect(retryCallCount).toBe(1);
	});

	test("retry sends conversationId and assistantMessageId", async ({
		page,
	}) => {
		let capturedRetryBody: Record<string, unknown> | null = null;

		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody("Initial response"),
			});
		});

		await openConversationComposer(page);
		await sendMessage(page, "First message");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Initial response",
			{
				timeout: 15000,
			},
		);

		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 500,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "Fail on second try" }),
			});
		});

		await sendMessage(page, "Second message triggers error");
		const retryBtn = page.getByRole("button", { name: /retry/i });
		await expect(retryBtn).toBeVisible({ timeout: 15000 });

		await page.route("**/api/chat/retry", async (route) => {
			capturedRetryBody = route.request().postDataJSON() as Record<
				string,
				unknown
			>;
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody("Retry response"),
			});
		});

		await retryBtn.click();

		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"Retry response",
			{
				timeout: 15000,
			},
		);
		expect(capturedRetryBody).toBeTruthy();
		expect(capturedRetryBody?.conversationId).toBeTruthy();
		expect(capturedRetryBody?.assistantMessageId).toBeTruthy();
	});

	test("retry after error shows fresh response", async ({ page }) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 500,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "Timeout" }),
			});
		});

		await page.route("**/api/chat/retry", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody("Fresh retry response here"),
			});
		});

		await openConversationComposer(page);
		await sendMessage(page, "Trigger error then retry");

		const retryBtn = page.getByRole("button", { name: /retry/i });
		await expect(retryBtn).toBeVisible({ timeout: 15000 });
		await retryBtn.click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Fresh retry response here",
			{ timeout: 15000 },
		);
	});

	test("retry endpoint returns 400 for missing conversationId", async ({
		page,
	}) => {
		await page.route("**/api/chat/retry", async (route) => {
			await route.continue();
		});

		const result = await page.evaluate(async () => {
			const response = await fetch("/api/chat/retry", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ assistantMessageId: "some-id" }),
			});
			return { status: response.status, body: await response.json() };
		});

		expect(result.status).toBe(400);
		expect(result.body.error).toContain("conversationId");
	});

	test("retry endpoint returns 404 for non-existent conversation", async ({
		page,
	}) => {
		const result = await page.evaluate(async () => {
			const response = await fetch("/api/chat/retry", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					conversationId: "non-existent-conversation-id",
					assistantMessageId: "non-existent-message-id",
				}),
			});
			return { status: response.status, body: await response.json() };
		});

		expect(result.status).toBe(404);
	});
});
