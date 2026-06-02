import { expect, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
} from "./helpers";

const STREAMING_TEXT =
	"The quick brown fox jumps over the lazy dog this is streaming";

function buildSseBody(text: string, chunkDelayMs = 0): string {
	void chunkDelayMs;
	return buildAiSdkUiStreamBody(text);
}

test.describe("SSE streaming verification", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("tokens appear incrementally during streaming", async ({ page }) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
				body: buildSseBody(STREAMING_TEXT),
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Tell me something");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			STREAMING_TEXT,
			{ timeout: 20000 },
		);
	});

	test("streaming loading indicator appears during response", async ({
		page,
	}) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody("Hello world"),
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Trigger streaming");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Hello world",
			{ timeout: 15000 },
		);
	});

	test("full response text is intact after streaming completes", async ({
		page,
	}) => {
		const fullText = "Complete streaming response with multiple words here";

		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody(fullText),
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Full text test");
		await page.getByTestId("send-button").click();

		const assistantMsg = page.getByTestId("assistant-message").first();
		await expect(assistantMsg).toContainText(fullText, { timeout: 20000 });
	});

	test("stream error shows retry button", async ({ page }) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: `data: ${JSON.stringify({
					type: "data-stream-error",
					data: { message: "Stream timeout" },
					transient: true,
				})}\n\n`,
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Trigger stream error");
		await page.getByTestId("send-button").click();

		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible({
			timeout: 15000,
		});
	});

	test("retry after error resends last message", async ({ page }) => {
		let callCount = 0;

		await page.route("**/api/chat/stream", async (route) => {
			callCount++;
			if (callCount === 1) {
				await route.fulfill({
					status: 500,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ error: "Server error" }),
				});
			} else {
				await route.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
					body: buildSseBody("Retry succeeded"),
				});
			}
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Test retry flow");
		await page.getByTestId("send-button").click();

		const retryBtn = page.getByRole("button", { name: /retry/i });
		await expect(retryBtn).toBeVisible({ timeout: 15000 });
		await retryBtn.click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Retry succeeded",
			{ timeout: 15000 },
		);
	});

	test("queues the next message until the current stream completes", async ({
		page,
	}) => {
		let callCount = 0;
		const receivedMessages: string[] = [];

		await page.route("**/api/chat/stream", async (route) => {
			callCount += 1;
			const body = route.request().postDataJSON() as { message?: string };
			const message = body.message ?? "";
			receivedMessages.push(message);

			if (callCount === 1) {
				await new Promise((resolve) => setTimeout(resolve, 1200));
			}

			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildSseBody(`Reply to ${message}`),
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("First queued test");
		await page.getByTestId("send-button").click();
		await expect(page.getByTestId("stop-button")).toBeVisible({
			timeout: 5000,
		});

		await page.getByTestId("message-input").fill("Second queued test");
		await expect(page.getByTestId("queue-button")).toBeVisible();
		await page.getByTestId("queue-button").click();

		await expect(page.getByTestId("queued-message-banner")).toContainText(
			"Second queued test",
		);
		await page.waitForTimeout(150);
		expect(callCount).toBe(1);

		await expect.poll(() => callCount, { timeout: 10000 }).toBe(2);
		await expect(page.getByTestId("queued-message-banner")).toHaveCount(0);
		await expect(page.getByTestId("user-message")).toHaveCount(2, {
			timeout: 10000,
		});
		await expect(page.getByTestId("assistant-message")).toHaveCount(2, {
			timeout: 15000,
		});
		expect(receivedMessages).toEqual([
			"First queued test",
			"Second queued test",
		]);
	});

	test("stopping a stream restores the queued message as a draft", async ({
		page,
	}) => {
		let callCount = 0;
		let releaseStream: (() => void) | null = null;
		const streamReleased = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});

		await page.route("**/api/chat/stream", async (route) => {
			callCount += 1;
			await streamReleased;
			await route
				.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
					body: buildSseBody("This response should be stopped"),
				})
				.catch(() => {});
		});

		await page.route("**/api/chat/stream/stop", async (route) => {
			releaseStream?.();
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stopped: true }),
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Stop primary message");
		await page.getByTestId("send-button").click();
		await expect(page.getByTestId("stop-button")).toBeVisible({
			timeout: 5000,
		});

		await page.getByTestId("message-input").fill("Queued after stop");
		await expect(page.getByTestId("queue-button")).toBeVisible();
		await page.getByTestId("queue-button").click();
		await expect(page.getByTestId("queued-message-banner")).toContainText(
			"Queued after stop",
		);

		await page.getByTestId("stop-button").click();

		await expect(page.getByTestId("queued-message-banner")).toHaveCount(0);
		await expect(page.getByTestId("message-input")).toHaveValue(
			"Queued after stop",
		);
		await page.waitForTimeout(150);
		expect(callCount).toBe(1);
	});

	test("stop button stays enabled while waiting for generation", async ({
		page,
	}) => {
		let streamRequestBody: Record<string, unknown> | null = null;
		let stopRequestBody: Record<string, unknown> | null = null;
		let releaseStream: (() => void) | null = null;
		const streamReleased = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});

		await page.route("**/api/chat/stream", async (route) => {
			streamRequestBody = route.request().postDataJSON() as Record<
				string,
				unknown
			>;
			await streamReleased;
			await route
				.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
					body: buildSseBody("Stopped after waiting"),
				})
				.catch(() => {});
		});

		await page.route("**/api/chat/stream/stop", async (route) => {
			stopRequestBody = route.request().postDataJSON() as Record<
				string,
				unknown
			>;
			releaseStream?.();
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stopped: true }),
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Wait and stop");
		await page.getByTestId("send-button").click();
		await expect(page.getByTestId("stop-button")).toBeVisible({
			timeout: 5000,
		});

		const stopButton = page.getByTestId("stop-button");
		await expect(stopButton).toBeEnabled();
		await stopButton.click();

		await expect.poll(() => stopRequestBody).not.toBeNull();
		expect(stopRequestBody?.streamId).toBe(streamRequestBody?.streamId);
		await expect(page.getByTestId("stop-button")).toHaveCount(0);
	});

	test("stream errors restore the queued message instead of auto-sending it", async ({
		page,
	}) => {
		let callCount = 0;

		await page.route("**/api/chat/stream", async (route) => {
			callCount += 1;
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await route.fulfill({
				status: 500,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "Delayed failure" }),
			});
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Primary error message");
		await page.getByTestId("send-button").click();
		await expect(page.getByTestId("stop-button")).toBeVisible({
			timeout: 5000,
		});

		await page.getByTestId("message-input").fill("Queued after error");
		await expect(page.getByTestId("queue-button")).toBeVisible();
		await page.getByTestId("queue-button").click();
		await expect(page.getByTestId("queued-message-banner")).toContainText(
			"Queued after error",
		);

		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByTestId("queued-message-banner")).toHaveCount(0);
		await expect(page.getByTestId("message-input")).toHaveValue(
			"Queued after error",
		);
		expect(callCount).toBe(1);
	});
});
