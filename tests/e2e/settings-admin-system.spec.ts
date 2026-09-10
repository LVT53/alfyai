import { expect, type Page, test } from "@playwright/test";

// Smoke coverage for the redesigned admin System screen: every page in the
// navigator opens and shows the card that belongs to it, the save bar reports
// nothing pending on arrival, and the read-only Diagnostics page carries all
// three of its surfaces.

// The shared `login` helper waits for the chat composer to become enabled,
// which needs a reachable model. This screen has nothing to do with chat, so it
// signs in and goes straight to Settings.
async function signIn(page: Page) {
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	const result = await page.evaluate(
		async (credentials) => {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(credentials),
			});
			return { ok: response.ok, status: response.status };
		},
		{
			email: process.env.E2E_EMAIL ?? "admin@local",
			password: process.env.E2E_PASSWORD ?? "admin123",
		},
	);
	expect(result.ok, `Login failed with status ${result.status}`).toBe(true);
}

const PAGES = [
	{ id: "general", card: "system-page-general" },
	{ id: "models", card: "system-page-models" },
	{ id: "aiTasks", card: "system-page-ai-tasks" },
	{ id: "integrations", card: "system-page-integrations" },
	{ id: "limits", card: "system-page-limits" },
	{ id: "skills", card: "system-page-skills" },
	{ id: "advanced", card: "system-page-advanced" },
] as const;

async function openSystemScreen(page: Page) {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	// The tab switch only takes once the page is hydrated.
	await expect(async () => {
		await page.getByRole("tab", { name: "Administration" }).click();
		await expect(page.getByTestId("admin-system-screen")).toBeVisible({
			timeout: 2000,
		});
	}).toPass({ timeout: 20000 });
}

test.describe("Admin System screen", () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
		await openSystemScreen(page);
	});

	test("opens every configuration page from the navigator", async ({
		page,
	}) => {
		for (const entry of PAGES) {
			await page.getByTestId(`system-nav-${entry.id}`).click();
			await expect(page.getByTestId(entry.card)).toBeVisible();
		}

		// Nothing was touched, so nothing is pending.
		await expect(page.getByTestId("system-save-bar")).toHaveAttribute(
			"data-pending",
			"0",
		);
		await expect(page.getByTestId("system-save")).toBeDisabled();
	});

	test("shows the Advanced page's groups, defaults and effect badges", async ({
		page,
	}) => {
		await page.getByTestId("system-nav-advanced").click();
		await expect(page.getByTestId("advanced-group-limits")).toBeVisible();
		await expect(page.getByTestId("advanced-group-atlas")).toBeVisible();
		await expect(page.getByTestId("advanced-group-debug")).toBeVisible();

		const row = page.getByTestId("advanced-row-FILE_PRODUCTION_MAX_OUTPUTS");
		await expect(row).toBeVisible();
		await expect(row.getByText("live")).toBeVisible();

		// The keys that stay environment-only are named, not hidden.
		await expect(page.getByTestId("advanced-env-only")).toContainText(
			"SESSION_SECRET",
		);
	});

	test("filters the Advanced page down to one group", async ({ page }) => {
		await page.getByTestId("system-nav-advanced").click();
		await page.getByTestId("advanced-filter").fill("TEI_");

		await expect(page.getByTestId("advanced-group-embeddings")).toBeVisible();
		await expect(page.getByTestId("advanced-group-limits")).toHaveCount(0);
	});

	test("opens all three read-only Diagnostics surfaces", async ({ page }) => {
		await page.getByTestId("system-nav-diagnostics").click();
		await expect(page.getByTestId("tool-health-section")).toBeVisible();
		await expect(page.getByTestId("tool-health-table")).toBeVisible();

		await page.getByRole("tab", { name: "Effective configuration" }).click();
		await expect(page.getByTestId("effective-config-table")).toBeVisible();

		await page.getByRole("tab", { name: "Routing coverage" }).click();
		await expect(page.getByTestId("routing-regions-section")).toBeVisible();
	});

	test("counts a pending edit, names its page, and discards it", async ({
		page,
	}) => {
		await page.getByTestId("system-nav-limits").click();
		const field = page.locator("#MAX_MESSAGE_LENGTH");
		const original = await field.inputValue();
		await field.fill("31000");

		const bar = page.getByTestId("system-save-bar");
		await expect(bar).toHaveAttribute("data-pending", "1");
		await expect(bar).toContainText("Limits");
		await expect(page.getByTestId("system-nav-dirty-limits")).toHaveText("1");

		await page.getByRole("button", { name: "Discard" }).click();
		await expect(bar).toHaveAttribute("data-pending", "0");
		await expect(field).toHaveValue(original);
	});

	test("keeps a pending edit through a trip to another sub-tab", async ({
		page,
	}) => {
		// Opening Users unmounts the whole System pane. The pending edit has to
		// come back with it, still counted and still saveable — re-reading the
		// baseline from the edited values would report it as saved and lose it.
		await page.getByTestId("system-nav-limits").click();
		const field = page.locator("#MAX_MESSAGE_LENGTH");
		const original = await field.inputValue();
		await field.fill("31234");

		const bar = page.getByTestId("system-save-bar");
		await expect(bar).toHaveAttribute("data-pending", "1");

		await page.getByRole("button", { name: "Users", exact: true }).click();
		await expect(page.getByTestId("admin-system-screen")).toBeHidden();
		await page.getByRole("button", { name: "System", exact: true }).click();
		await expect(page.getByTestId("admin-system-screen")).toBeVisible();

		await expect(bar).toHaveAttribute("data-pending", "1");
		await expect(page.getByTestId("system-save")).toBeEnabled();

		await page.getByTestId("system-nav-limits").click();
		await expect(page.locator("#MAX_MESSAGE_LENGTH")).toHaveValue("31234");

		await page.getByRole("button", { name: "Discard" }).click();
		await expect(bar).toHaveAttribute("data-pending", "0");
		await expect(page.locator("#MAX_MESSAGE_LENGTH")).toHaveValue(original);
	});

	test("finds a setting from the screen-wide search", async ({ page }) => {
		await page.getByTestId("system-search").fill("summarizer");
		await page.getByRole("option").first().click();

		await expect(page.getByTestId("system-page-ai-tasks")).toBeVisible();
		await expect(page.locator("#CONTEXT_SUMMARIZER_MODEL")).toBeVisible();
	});
});
