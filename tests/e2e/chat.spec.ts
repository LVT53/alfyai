import { expect, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
} from "./helpers";

const MOCK_ASSISTANT_RESPONSE_TEXT =
	"Hello from mock assistant! This is a test response.";

function mockStreamRoute(
	page: import("@playwright/test").Page,
	text = MOCK_ASSISTANT_RESPONSE_TEXT,
) {
	return page.route("**/api/chat/stream", async (route) => {
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
			body: buildAiSdkUiStreamBody(text),
		});
	});
}

test.describe("Chat send/receive messages", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await mockStreamRoute(page);
	});

	test("message input is visible after creating a conversation", async ({
		page,
	}) => {
		await openConversationComposer(page);
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(page.getByTestId("send-button")).toBeVisible();
	});

	test("send button is disabled when input is empty", async ({ page }) => {
		await openConversationComposer(page);
		await expect(page.getByTestId("send-button")).toBeDisabled();
	});

	test("send button is enabled when input has text", async ({ page }) => {
		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Hello");
		await expect(page.getByTestId("send-button")).toBeEnabled();
	});

	test("sends a message and displays user message in chat", async ({
		page,
	}) => {
		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Hello AI!");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Hello AI!",
			{ timeout: 10000 },
		);
	});

	test("receives an assistant response after sending a message", async ({
		page,
	}) => {
		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Hello AI!");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			MOCK_ASSISTANT_RESPONSE_TEXT,
			{ timeout: 15000 },
		);
	});

	test("pressing Enter sends the message", async ({ page }) => {
		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Message via Enter key");
		await page.getByTestId("message-input").press("Enter");

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Message via Enter key",
			{ timeout: 10000 },
		);
	});

	test("landing-page send still works when conversation creation resolves after send", async ({
		page,
	}) => {
		let releaseConversationCreate: (() => void) | null = null;
		let conversationCreateStarted = false;
		const conversationCreateCanContinue = new Promise<void>((resolve) => {
			releaseConversationCreate = resolve;
		});

		await page.unroute("**/api/conversations");
		await page.route("**/api/conversations", async (route) => {
			if (route.request().method() !== "POST") {
				await route.continue();
				return;
			}

			conversationCreateStarted = true;
			await conversationCreateCanContinue;
			await route.continue();
		});

		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Race condition message");
		const sendAction = page.getByTestId("message-input").press("Enter");
		await expect.poll(() => conversationCreateStarted).toBe(true);
		releaseConversationCreate?.();
		await sendAction;

		await page.waitForURL(/\/chat\//, { timeout: 15000 });
		await expect(page.getByTestId("user-message").first()).toContainText(
			"Race condition message",
			{
				timeout: 10000,
			},
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			MOCK_ASSISTANT_RESPONSE_TEXT,
			{
				timeout: 15000,
			},
		);
	});

	test("navigation during an active stream does not send an explicit stop request", async ({
		page,
	}) => {
		await page.unroute("**/api/chat/stream");

		let stopRequests = 0;
		let releaseStream: (() => void) | null = null;
		const streamReleased = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});

		await page.route("**/api/chat/stream", async (route) => {
			await streamReleased;
			await route
				.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
					body: buildAiSdkUiStreamBody("Detached stream completed"),
				})
				.catch(() => {});
		});

		await page.route("**/api/chat/stream/stop", async (route) => {
			stopRequests += 1;
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stopped: true }),
			});
		});

		try {
			await openConversationComposer(page, { skipIfAlreadyOpen: true });
			await page
				.getByTestId("message-input")
				.fill("Navigate during active stream");
			await page.getByTestId("send-button").click();
			await expect(page.getByTestId("stop-button")).toBeVisible({
				timeout: 5000,
			});

			await page.goto("/");
			await expect(page.getByTestId("message-input")).toBeVisible({
				timeout: 15000,
			});
			await page.evaluate(
				() => new Promise((resolve) => requestAnimationFrame(resolve)),
			);

			expect(stopRequests).toBe(0);
		} finally {
			releaseStream?.();
		}
	});

	test("Shift+Enter does not send the message (newline)", async ({ page }) => {
		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Line 1");
		await page.getByTestId("message-input").press("Shift+Enter");

		await expect(page.getByTestId("user-message")).toHaveCount(0);
	});

	test("shows error and retry button when streaming fails", async ({
		page,
	}) => {
		await page.unroute("**/api/chat/stream");

		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 500,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "Internal server error" }),
			});
		});

		await openConversationComposer(page, { skipIfAlreadyOpen: true });
		await page.getByTestId("message-input").fill("Trigger error");
		await page.getByTestId("send-button").click();

		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible({
			timeout: 15000,
		});
	});
});
