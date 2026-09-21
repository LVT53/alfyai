import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("Authentication", () => {
	test("login page renders correctly", async ({ page }) => {
		await page.goto("/login");
		await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
		await expect(page.locator('[name="email"]')).toBeVisible();
		await expect(page.locator('[name="password"]')).toBeVisible();
		await expect(page.locator('button[type="submit"]')).toBeVisible();
		// Consistency pass: the first screen of the product carries the
		// wordmark, and the heading is on the serif title ramp.
		await expect(page.getByTestId("login-wordmark")).toBeVisible();
		await expect(page.getByTestId("login-wordmark")).toContainText("AlfyAI");
		const heading = page.getByRole("heading", { name: "Sign In" });
		await expect(heading).toHaveCSS("font-size", "24px");
		expect(
			await heading.evaluate((el) => getComputedStyle(el).fontFamily),
		).toContain("Libre Baskerville");
	});

	test("redirects unauthenticated users to login", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveURL(/\/login/);
	});

	// A page request gets the login screen; an API request gets a 401 it can
	// act on. It used to get the same 303, which `fetch` follows — so the
	// caller was handed a 200 and the login page's HTML.
	test("answers an unauthenticated API call with 401 JSON, not a redirect", async ({
		request,
	}) => {
		const response = await request.get("/api/conversations", {
			maxRedirects: 0,
		});

		expect(response.status()).toBe(401);
		expect(response.headers()["content-type"]).toContain("application/json");
		expect(await response.json()).toEqual({ error: "Unauthorized" });
	});

	test("keeps the public API routes reachable without a session", async ({
		request,
	}) => {
		const response = await request.get("/api/health", { maxRedirects: 0 });

		expect(response.status()).toBe(200);
	});

	// The client's half of the same contract: a session that dies underneath an
	// open tab ends on the login screen instead of silently failing every call.
	test("sends the tab to login when the session disappears mid-session", async ({
		page,
		context,
	}) => {
		await login(page);
		await page.waitForURL("/");

		await context.clearCookies();
		// The shell refreshes the conversation list whenever the window regains
		// focus — an ordinary API call through the shared HTTP layer, and the
		// most likely way a user meets an expired session.
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));

		await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
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
		// ADR-0043 Slice 16: logout opens a ConfirmDialog before ending the
		// session; confirm it to proceed to /login.
		const confirmBtn = page.getByTestId("confirm-delete");
		if (await confirmBtn.isVisible().catch(() => false)) {
			await confirmBtn.click();
		}
		await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
	});
});
