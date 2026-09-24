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

	test("edits the Parallel free allowance under the Parallel API key", async ({
		page,
	}) => {
		await page.getByTestId("system-nav-integrations").click();

		// The pane reads its config asynchronously, so nothing here is on screen
		// until that lands — and a field read before then is empty, not wrong.
		const row = page.locator('[data-config-key="PARALLEL_FREE_MONTHLY_USD"]');
		await expect(row).toBeVisible();

		// It is a billing setting for the same integration, so it reads in the
		// Web research group, directly under the key that enables Parallel.
		const keys = await page
			.locator("[data-config-key]")
			.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-config-key")),
			);
		expect(keys[keys.indexOf("PARALLEL_FREE_MONTHLY_USD") - 1]).toBe(
			"PARALLEL_API_KEY",
		);

		const field = page.locator("#PARALLEL_FREE_MONTHLY_USD");
		await expect(row.locator(".sys-unit")).toHaveText("$");
		await expect(field).toHaveValue(/\d/);
		const original = await field.inputValue();
		expect(original).toBe("5.00");

		await field.fill("0");
		await page.getByTestId("system-save").click();
		await expect(page.getByTestId("system-save-bar")).toHaveAttribute(
			"data-pending",
			"0",
		);

		// The allowance is a stored override, so it has to survive a reload.
		await page.reload();
		await openSystemScreen(page);
		await page.getByTestId("system-nav-integrations").click();
		await expect(page.locator("#PARALLEL_FREE_MONTHLY_USD")).toHaveValue(
			"0.00",
		);

		// Put the default back, so the run leaves no billing override behind.
		// A reset writes an empty override, which shows as an empty field until
		// the reload reads the environment default back in.
		await page
			.locator('[data-config-key="PARALLEL_FREE_MONTHLY_USD"]')
			.getByRole("button", { name: /reset/i })
			.click();
		await page.getByTestId("system-save").click();
		await expect(page.getByTestId("system-save-bar")).toHaveAttribute(
			"data-pending",
			"0",
		);

		await page.reload();
		await openSystemScreen(page);
		await page.getByTestId("system-nav-integrations").click();
		await expect(page.locator("#PARALLEL_FREE_MONTHLY_USD")).toHaveValue(
			original,
		);
	});

	// A saved whole-dollar allowance reads as "$ 5.00", but the field is still
	// one an admin types a number into, and the number typed has to be the
	// number stored. Real keystrokes, not `fill`: what this pins is the field's
	// treatment of each character as it arrives.
	test("types a fractional allowance without rewriting the digits", async ({
		page,
	}) => {
		await page.getByTestId("system-nav-integrations").click();
		const field = page.locator("#PARALLEL_FREE_MONTHLY_USD");
		await expect(field).toHaveValue(/\d/);

		await field.selectText();
		await page.keyboard.type("2.5");
		await expect(field).toHaveValue("2.5");

		// The typed number is the one the server ends up applying, and once it
		// is saved (not a draft) the money formatter takes over again.
		await page.getByTestId("system-save").click();
		await expect(page.getByTestId("system-save-bar")).toHaveAttribute(
			"data-pending",
			"0",
		);
		await page.reload();
		await openSystemScreen(page);
		await page.getByTestId("system-nav-integrations").click();
		await expect(page.locator("#PARALLEL_FREE_MONTHLY_USD")).toHaveValue(
			"2.50",
		);

		// Put the default back, so the run leaves no billing override behind.
		await page
			.locator('[data-config-key="PARALLEL_FREE_MONTHLY_USD"]')
			.getByRole("button", { name: /reset/i })
			.click();
		await page.getByTestId("system-save").click();
		await expect(page.getByTestId("system-save-bar")).toHaveAttribute(
			"data-pending",
			"0",
		);
	});
});

// The allowance meter on the System analytics Parallel API tab. The dev server
// answers `/api/analytics` from its own mock payload, so the Parallel block is
// added to that real response shape rather than seeded into SQLite — the pane
// then renders against everything it actually reads.
const ALLOWANCE_PARALLEL = {
	monthly: [{ month: "2026-06", turboCalls: 70, extractCalls: 50, costUsd: 0 }],
	totalTurboCalls: 70,
	totalExtractCalls: 50,
	totalCostUsd: 0,
	allowance: {
		allowanceMicros: 5_000_000,
		monthListMicros: 120_000,
		monthBilledMicros: 0,
		month: "2026-06",
	},
	monthRows: [
		{
			month: "2026-06",
			calls: 120,
			listMicros: 120_000,
			freeMicros: 120_000,
			billedMicros: 0,
		},
	],
};

test.describe("Admin Parallel allowance meter", () => {
	test.beforeEach(async ({ page }) => {
		await page.route("**/api/analytics*", async (route) => {
			const response = await route.fetch();
			const body = (await response.json()) as {
				system?: Record<string, unknown>;
			};
			await route.fulfill({
				response,
				json: {
					...body,
					system: { ...body.system, parallel: ALLOWANCE_PARALLEL },
				},
			});
		});
		await signIn(page);
		await openSystemScreen(page);
	});

	test("shows the allowance meter, the counted-cost tile and the month columns", async ({
		page,
	}) => {
		await page.getByRole("button", { name: "System analytics" }).click();
		await page.getByRole("tab", { name: "Parallel API" }).click();

		// The meter reads the month's list price against the allowance, and
		// names what users were charged beside it.
		const meter = page.getByTestId("parallel-allowance-meter");
		await expect(meter).toBeVisible();
		await expect(meter).toContainText("$0.12 of $5.00 free allowance used");
		await expect(meter).toContainText("users are charged $0.00");

		await expect(page.getByText("Counted as cost")).toBeVisible();

		const table = page.locator("#system-analytics-parallel-panel table");
		await expect(
			table.getByRole("columnheader", { name: "Free usage" }),
		).toBeVisible();
		await expect(
			table.getByRole("columnheader", { name: "Counted cost" }),
		).toBeVisible();
		// The month the allowance covers is drawn, so the columns are not just
		// headers: 120 calls, 120 free, none counted as cost.
		await expect(table.getByRole("row").nth(1)).toContainText("120");
	});
});
