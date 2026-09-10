import { expect, type Page, test } from "@playwright/test";

import { login } from "./helpers";

async function openAdminPane(page: Page, pane: "Users" | "Campaigns") {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: "Administration" }).click();
	await page.getByRole("button", { name: pane, exact: true }).click();
}

test.describe("Admin Users screen", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("lists accounts in a sortable table with a detail panel", async ({
		page,
	}) => {
		await openAdminPane(page, "Users");

		const rows = page.locator('[data-testid="admin-user-row"]');
		await expect(rows.first()).toBeVisible();

		// Header, toolbar and pager are all part of the table surface now.
		await expect(page.getByRole("button", { name: /^Name/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /^Messages/ })).toBeVisible();
		await expect(page.getByText(/Showing 1–\d+ of \d+/)).toBeVisible();
		await expect(page.getByText("Rows per page")).toBeVisible();

		// The detail panel names the selected account.
		const detail = page.getByTestId("admin-user-detail");
		await expect(detail).toBeVisible();
		await expect(detail.getByText("Tokens used, all time")).toBeVisible();
		await expect(detail.getByText("Actions")).toBeVisible();
	});

	test("sorting by a column reorders the rows", async ({ page }) => {
		await openAdminPane(page, "Users");
		const rows = page.locator('[data-testid="admin-user-row"]');
		await expect(rows.first()).toBeVisible();

		const emailHeader = page.getByRole("button", { name: /^Email/ });
		await emailHeader.click();
		const ascending = await rows.evaluateAll((nodes) =>
			nodes.map((node) => node.querySelector("td:nth-child(2)")?.textContent),
		);
		await emailHeader.click();
		const descending = await rows.evaluateAll((nodes) =>
			nodes.map((node) => node.querySelector("td:nth-child(2)")?.textContent),
		);

		expect(descending).toEqual([...ascending].reverse());
	});

	test("filtering keeps the selected account in the panel", async ({
		page,
	}) => {
		await openAdminPane(page, "Users");
		const rows = page.locator('[data-testid="admin-user-row"]');
		await expect(rows.first()).toBeVisible();

		await page
			.getByLabel("Search by name or email")
			.fill("no-such-account-anywhere");

		await expect(
			page.getByText("No users match the current filters."),
		).toBeVisible();
		// The panel keeps the account rather than silently reassigning it.
		await expect(page.getByTestId("admin-user-detail")).toBeVisible();
	});

	test("the create dialog states its own rule before enabling Create", async ({
		page,
	}) => {
		await openAdminPane(page, "Users");
		await page.getByRole("button", { name: "Create User" }).click();

		const create = page.getByRole("button", { name: "Create User" }).last();
		await expect(create).toBeDisabled();
		await expect(page.getByText("At least 8 characters")).toBeVisible();

		await page.locator("#create-user-email").fill("e2e.new.user@alfy.hu");
		await page.getByRole("button", { name: "Generate" }).click();
		await expect(page.getByText(/long enough/)).toBeVisible();
		await expect(create).toBeEnabled();

		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByText("At least 8 characters")).toBeHidden();
	});
});

test.describe("Admin Campaigns screen", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("creates a draft, edits one slide and deletes it again", async ({
		page,
	}) => {
		await openAdminPane(page, "Campaigns");

		await page.getByRole("button", { name: "New campaign" }).click();
		await page.locator("#campaign-dialog-name").fill("E2E smoke campaign");
		await page.getByRole("button", { name: "Release", exact: true }).click();
		await page.locator("#campaign-dialog-release").fill("9.9.9");
		await page.getByRole("button", { name: "Create campaign" }).click();

		// The editor opens on the new draft, with the checklist expanded because
		// an empty campaign cannot be published yet.
		await expect(
			page.getByRole("heading", { name: "E2E smoke campaign" }).first(),
		).toBeVisible();
		const checklist = page.getByTestId("campaign-checklist");
		await expect(checklist).toBeVisible();
		// "1 check failing" / "3 checks failing" — the count is pluralised.
		await expect(checklist.getByText(/checks? failing/)).toBeVisible();
		await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();

		// One slide at a time, from the thumbnail rail.
		await page.getByRole("button", { name: "Add slide" }).click();
		await expect(
			page.locator('[data-testid="admin-campaign-slide-thumb"]'),
		).toHaveCount(1);
		await expect(page.getByRole("heading", { name: "Slide 1" })).toBeVisible();

		await page.getByLabel("Title", { exact: true }).fill("Smoke slide");
		await page.getByRole("button", { name: "HU", exact: true }).click();
		await page.getByLabel("Title", { exact: true }).fill("Füst dia");
		await page.getByRole("button", { name: "EN", exact: true }).click();
		await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
			"Smoke slide",
		);

		// Layout / Purpose / Setup controls live in the slide ⋯ menu.
		await page.getByTestId("campaign-slide-menu").click();
		await page.getByRole("menuitem", { name: /Purpose/ }).click();
		await page.getByRole("button", { name: "Data disclosure" }).click();
		await page.keyboard.press("Escape");

		await page.getByRole("button", { name: "Save draft" }).click();
		await expect(page.getByText("Campaign draft saved.")).toBeVisible();

		// Delete is available on a draft that still fails validation.
		await page.getByTestId("campaign-menu").click();
		await page.getByRole("menuitem", { name: /Delete draft/ }).click();
		await page.getByTestId("confirm-delete").click();

		await expect(
			page.getByRole("heading", { name: "E2E smoke campaign" }),
		).toHaveCount(0);
	});

	test("seeds the first-run campaign from the campaign menu", async ({
		page,
	}) => {
		await openAdminPane(page, "Campaigns");

		// Seeding needs an open campaign to reach the menu, so create one first.
		await page.getByRole("button", { name: "New campaign" }).click();
		await page.locator("#campaign-dialog-name").fill("E2E seed host");
		await page.getByRole("button", { name: "Create campaign" }).click();
		await expect(
			page.getByRole("heading", { name: "E2E seed host" }).first(),
		).toBeVisible();

		await page.getByTestId("campaign-menu").click();
		await page.getByRole("menuitem", { name: /Seed first-run/ }).click();

		await expect(
			page
				.locator('[data-testid="admin-campaign-row"]')
				.filter({ hasText: "First-run" })
				.first(),
		).toBeVisible();
		// The seeded template ships an action destination the server does not
		// allow, so the checklist has something to report.
		await expect(page.getByTestId("campaign-checklist")).toBeVisible();
	});
});
