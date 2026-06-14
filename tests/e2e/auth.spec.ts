import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("Authentication", () => {
	test("login page renders correctly", async ({ page }) => {
		await page.goto("/login");
		await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
		await expect(page.locator('[name="email"]')).toBeVisible();
		await expect(page.locator('[name="password"]')).toBeVisible();
		await expect(page.locator('button[type="submit"]')).toBeVisible();
	});

	test("redirects unauthenticated users to login", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveURL(/\/login/);
	});

	test("shows error on invalid credentials", async ({ page }) => {
		await page.goto("/login");
		await page.waitForSelector('input[name="email"]', { state: "visible" });
		await page.fill('[name="email"]', "wrong@email.com");
		await page.fill('[name="password"]', "wrongpassword");
		await page.click('button[type="submit"]');
		await expect(page.locator('[role="alert"]')).toBeVisible({
			timeout: 10000,
		});
	});

	test("shows error on empty form submission", async ({ page }) => {
		await page.goto("/login");
		await page.waitForSelector('input[name="email"]', { state: "visible" });
		await page.fill('[name="email"]', " ");
		await page.fill('[name="password"]', " ");
		await page.click('button[type="submit"]');
		await expect(page.locator('[role="alert"]')).toBeVisible({
			timeout: 10000,
		});
	});

	test("logs in with valid credentials and redirects to app", async ({
		page,
	}) => {
		await login(page);
		await expect(page).toHaveURL("/");
		await expect(page.getByTestId("new-conversation")).toBeVisible({
			timeout: 10000,
		});
	});

	test("logs out successfully", async ({ page }) => {
		await login(page);
		await page.waitForURL("/");
		await page.getByRole("button", { name: "Logout" }).click();
		await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
	});
});
