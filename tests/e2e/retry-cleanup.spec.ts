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

	test("retry after a failed turn sends the message again and leaves the earlier reply", async ({
		page,
	}) => {
		let streamCallCount = 0;
		let retryCallCount = 0;

		// The server keeps nothing of a failed turn, so a Retry has no reply of its
		// own to replace: it sends the message again through /api/chat/stream, and
		// /api/chat/retry, which deletes a reply, is not asked.
		await page.route("**/api/chat/stream", async (route) => {
			streamCallCount++;
			if (streamCallCount === 2) {
				await route.fulfill({
					status: 500,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ error: "Backend failure" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody(
					streamCallCount === 1 ? "Initial response" : "Retry succeeded",
				),
			});
		});

		await page.route("**/api/chat/retry", async (route) => {
			retryCallCount++;
			await route.abort();
		});

		await openConversationComposer(page);
		await sendMessage(page, "First message");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Initial response",
			{ timeout: 15000 },
		);

		await sendMessage(page, "Second message triggers error");
		const retryBtn = page.getByRole("button", { name: /retry/i });
		await expect(retryBtn).toBeVisible({ timeout: 15000 });
		await retryBtn.click();

		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"Retry succeeded",
			{ timeout: 15000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Initial response",
		);
		expect(streamCallCount).toBe(3);
		expect(retryCallCount).toBe(0);
	});

	test("regenerate sends conversationId and assistantMessageId", async ({
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

		await openConversationComposer(page);
		await sendMessage(page, "First message");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Initial response",
			{
				timeout: 15000,
			},
		);

		await page.getByRole("button", { name: "Regenerate" }).click();

		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"Retry response",
			{
				timeout: 15000,
			},
		);
		expect(capturedRetryBody).toBeTruthy();
		expect(capturedRetryBody?.conversationId).toBeTruthy();
		expect(capturedRetryBody?.assistantMessageId).toBeTruthy();
		expect(capturedRetryBody?.streamId).toBeTruthy();
	});

	test("retry after error shows fresh response", async ({ page }) => {
		// A first-turn failure has no persisted assistant message to retry, so the
		// client re-sends through /api/chat/stream (not /api/chat/retry). Fail the
		// first attempt, succeed on the retry.
		let streamCallCount = 0;
		await page.route("**/api/chat/stream", async (route) => {
			streamCallCount++;
			if (streamCallCount > 1) {
				await route.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
					body: buildSseBody("Fresh retry response here"),
				});
				return;
			}
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
				// Include all now-required fields so validation passes and the
				// request reaches the conversation-existence check (→ 404).
				body: JSON.stringify({
					conversationId: "non-existent-conversation-id",
					assistantMessageId: "non-existent-message-id",
					userMessageId: "non-existent-user-message-id",
					userMessage: "retry please",
				}),
			});
			return { status: response.status, body: await response.json() };
		});

		expect(result.status).toBe(404);
	});
});
