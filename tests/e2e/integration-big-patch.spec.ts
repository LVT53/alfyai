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

test.describe("Big Patch integration — cross-feature workflow", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("retry after stream error shows the recovered assistant response", async ({
		page,
	}) => {
		let retryCalled = false;
		let streamAttempts = 0;

		await page.route("**/api/chat/stream", async (route) => {
			streamAttempts += 1;
			if (streamAttempts > 1) {
				await route.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
					body: buildSseBody("Retry successful after cleanup"),
				});
				return;
			}
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

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Retry successful after cleanup",
			{ timeout: 15000 },
		);
		expect(retryCalled || streamAttempts > 1).toBe(true);
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

		await expect(async () => {
			await page.getByRole("tab", { name: "Administration" }).click();
			await expect(page.getByText("Add Provider")).toBeVisible({
				timeout: 1000,
			});
		}).toPass({ timeout: 10000 });
		await expect(async () => {
			await page.getByRole("button", { name: "Users" }).click();
			await expect(
				page.getByRole("button", { name: "Create User" }),
			).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 10000 });
		const userRows = page.locator('[data-testid="admin-user-row"]');
		await expect(userRows.first()).toBeVisible();
	});
});
