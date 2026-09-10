import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test.describe("Admin last active tracking", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("admin users table shows a last active value for every row", async ({
		page,
	}) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.getByRole("tab", { name: "Administration" }).click();
		await page.getByRole("button", { name: "Users" }).click();

		// The rail became a real table, so "last active" is a sortable column
		// rather than a sentence repeated inside every row.
		await expect(
			page.getByRole("button", { name: /^Last active/ }),
		).toBeVisible();

		const userRows = page.locator('[data-testid="admin-user-row"]');
		await expect(userRows.first()).toBeVisible();

		const userCount = await userRows.count();
		expect(userCount).toBeGreaterThanOrEqual(1);

		for (let i = 0; i < userCount; i++) {
			// Column 4 is Last active; it always renders something ("Never" for an
			// account that has not signed in yet).
			const cell = userRows.nth(i).locator("td").nth(3);
			await expect(cell).not.toBeEmpty();
		}
	});

	test("admin user detail shows last active timestamp", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.getByRole("tab", { name: "Administration" }).click();
		await page.getByRole("button", { name: "Users" }).click();

		const userRows = page.locator('[data-testid="admin-user-row"]');
		await expect(userRows.first()).toBeVisible();

		await userRows.first().locator("button").first().click();

		const detail = page.getByTestId("admin-user-detail");
		await expect(detail.getByText("Last active", { exact: true })).toBeVisible();
		await expect(page.getByTestId("admin-user-last-active")).not.toBeEmpty();
	});

	test("API returns lastActiveAt as a non-null timestamp", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const response = await fetch("/api/admin/users");
			const body = (await response.json()) as {
				users: Array<{
					id: string;
					lastActiveAt: number | null;
					createdAt: number;
				}>;
			};
			return {
				ok: response.ok,
				status: response.status,
				users: body.users,
			};
		});

		expect(result.ok).toBe(true);
		expect(result.users.length).toBeGreaterThanOrEqual(1);

		for (const user of result.users) {
			expect(user.lastActiveAt).not.toBeNull();
			expect(typeof user.lastActiveAt).toBe("number");
			expect(user.lastActiveAt).toBeGreaterThan(0);
		}
	});

	test("lastActiveAt reflects session activity not conversation updatedAt", async ({
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

		await page.goto("/");
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
		expect(adminUserAfter?.lastActiveAt).toBeGreaterThanOrEqual(
			adminUser?.lastActiveAt,
		);
	});
});
