import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test.describe("Knowledge page", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await expect(
			page.getByRole("heading", { name: "Knowledge Base" }),
		).toBeVisible();
	});

	test("documents section is visible", async ({ page }) => {
		await expect(
			page.getByRole("heading", { name: "Documents" }),
		).toBeVisible();
		await expect(
			page.getByText("Browse and manage your uploaded and generated documents"),
		).toBeVisible();
		await expect(
			page.getByRole("searchbox", { name: "Search documents" }),
		).toBeVisible();
	});

	test("memory profile section is visible", async ({ page }) => {
		await expect(
			page.getByRole("heading", { name: "Memory Overview" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Manage focus continuity" }),
		).toBeVisible();
	});

	test("memory management entrypoints are visible", async ({ page }) => {
		await expect(
			page.getByRole("heading", { name: "Manage focus continuity" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Manage focus continuity" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Manage persona memory" }),
		).toBeVisible();
	});

	test("document list does not render filter pills", async ({ page }) => {
		await expect(
			page.getByRole("radiogroup", { name: "Document filter" }),
		).toHaveCount(0);
		const filterOptionInputs = page.locator(
			'input[type="radio"][name="document-filter"]',
		);
		await expect(filterOptionInputs).toHaveCount(0);
	});

	test("opening a knowledge document does not trigger runtime page errors", async ({
		page,
	}) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => {
			pageErrors.push(error.message);
		});

		const firstDocumentRow = page.locator("tbody tr").first();
		await expect(firstDocumentRow).toBeVisible();
		await firstDocumentRow.click();
		await expect(page.getByTestId("workspace-main")).toBeVisible();

		expect(pageErrors).toEqual([]);
	});
});
