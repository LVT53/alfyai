import { expect, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	createConversation,
	login,
	logout,
	openConversationComposer,
} from "./helpers";

const MOCK_RESPONSE = "This is a mock response from the AI.";

function mockStreamRoute(page: import("@playwright/test").Page) {
	return page.route("**/api/chat/stream", async (route) => {
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			},
			body: buildAiSdkUiStreamBody(MOCK_RESPONSE),
		});
	});
}

test.describe("Full User Journey", () => {
	test("user can login with valid credentials", async ({ page }) => {
		await login(page);
		await expect(page).toHaveURL("/");
		await expect(page.getByTestId("new-conversation")).toBeVisible({
			timeout: 10000,
		});
	});

	test("user can create a new conversation", async ({ page }) => {
		await login(page);
		await createConversation(page);
		await expect(page).toHaveURL(/\/chat\//);
		await expect(page.getByTestId("message-input")).toBeVisible();
	});

	test("user can send a message and receive a response", async ({ page }) => {
		await login(page);
		await mockStreamRoute(page);
		await openConversationComposer(page);
		await page.getByTestId("message-input").fill("Hello AI!");
		await page.getByTestId("send-button").click();
		await expect(page.getByTestId("user-message").first()).toContainText(
			"Hello AI!",
			{ timeout: 10000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			MOCK_RESPONSE,
			{ timeout: 15000 },
		);
	});

	test("user can logout", async ({ page }) => {
		await login(page);
		// logout() clicks Logout and confirms the ConfirmDialog (ADR-0043 Slice 16).
		await logout(page);
		await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
	});
});
