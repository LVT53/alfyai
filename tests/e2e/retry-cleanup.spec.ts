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
		const assistantMessageId = "retry-cleanup-saved-assistant";
		const userMessageId = "retry-cleanup-saved-user";
		const retryAssistantMessageId = "retry-cleanup-regenerated-assistant";
		const generations: Record<string, unknown>[] = [];
		const retries: Record<string, unknown>[] = [];

		await page.route("**/api/chat/stream", async (route) => {
			expect(route.request().method()).toBe("POST");
			const body = route.request().postDataJSON() as Record<string, unknown>;
			generations.push(body);
			expect(generations).toHaveLength(1);
			expect(body.message).toBe("First message");
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				// The real server acknowledges durable IDs independently of client render keys.
				body: buildAiSdkUiStreamBody("Initial response", {
					assistantMessageId,
					userMessageId,
				}),
			});
		});

		await page.route("**/api/chat/retry", async (route) => {
			expect(route.request().method()).toBe("POST");
			retries.push(route.request().postDataJSON() as Record<string, unknown>);
			expect(retries).toHaveLength(1);
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildAiSdkUiStreamBody("Retry response", {
					assistantMessageId: retryAssistantMessageId,
					userMessageId,
				}),
			});
		});

		await openConversationComposer(page);
		await sendMessage(page, "First message");
		await expect(page.getByTestId("assistant-message")).toHaveCount(1);
		await expect(page.getByTestId("assistant-message")).toContainText(
			"Initial response",
			{ timeout: 15000 },
		);
		await expect(page.getByTestId("assistant-message")).toHaveAttribute(
			"data-message-id",
			assistantMessageId,
		);
		await expect(page.getByTestId("user-message")).toHaveAttribute(
			"data-message-id",
			userMessageId,
		);
		await expect(page).toHaveURL(/\/chat\/[^/]+$/);
		const conversationId = new URL(page.url()).pathname.split("/").at(-1);
		expect(generations[0].conversationId).toBe(conversationId);

		await page.getByRole("button", { name: "Regenerate" }).click();

		await expect(page.getByTestId("assistant-message")).toContainText(
			"Retry response",
			{ timeout: 15000 },
		);
		await expect(page.getByTestId("assistant-message")).toHaveAttribute(
			"data-message-id",
			retryAssistantMessageId,
		);
		expect(generations).toHaveLength(1);
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({
			conversationId,
			assistantMessageId,
			userMessageId,
			userMessage: "First message",
		});
		expect(retries[0].streamId).toEqual(expect.stringMatching(/\S+/));
		expect(retries[0].streamId).not.toBe(generations[0].streamId);
	});

	test("regenerate without authoritative receipt IDs keeps the reply and starts no generation", async ({
		page,
	}) => {
		let generationCount = 0;
		let retryCount = 0;
		await page.route("**/api/chat/stream", async (route) => {
			generationCount += 1;
			expect(generationCount).toBe(1);
			expect(route.request().postDataJSON().message).toBe("First message");
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
				body: buildAiSdkUiStreamBody(
					"Initial response without a saved receipt",
				),
			});
		});
		await page.route("**/api/chat/retry", async (route) => {
			retryCount += 1;
			await route.abort();
			expect(
				retryCount,
				"a client placeholder must never authorize a retry",
			).toBe(0);
		});
		await openConversationComposer(page);
		await sendMessage(page, "First message");
		const reply = page.getByTestId("assistant-message");
		await expect(reply).toHaveCount(1);
		await expect(reply).toContainText(
			"Initial response without a saved receipt",
		);
		await expect(page.getByTestId("stop-button")).toHaveCount(0);
		const placeholderId = await reply.getAttribute("data-message-id");
		expect(placeholderId).toEqual(expect.stringMatching(/\S+/));
		const originalProse = await reply.locator(".prose-container").textContent();

		await page.getByRole("button", { name: "Regenerate" }).click();

		await expect(reply).toHaveCount(1);
		await expect(reply).toHaveAttribute(
			"data-message-id",
			placeholderId as string,
		);
		await expect(reply.locator(".prose-container")).toHaveText(
			originalProse as string,
		);
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		await expect(page.getByTestId("stop-button")).toHaveCount(0);
		await expect(page.getByTestId("message-input")).toBeEnabled();
		expect(generationCount).toBe(1);
		expect(retryCount).toBe(0);
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
