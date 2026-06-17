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
		await page.getByRole("tab", { name: "Documents" }).click();
		await expect(
			page.getByRole("heading", { name: "Documents" }),
		).toBeVisible();
		await expect(
			page.getByText("Browse and manage your uploaded and generated documents"),
		).toBeVisible();
		await expect(page.getByRole("region", { name: "Documents" })).toBeVisible();
		const searchbox = page.getByRole("searchbox", { name: "Search documents" });
		if ((await searchbox.count()) > 0) {
			await expect(searchbox).toBeVisible();
		} else {
			await expect(page.getByText("No documents")).toBeVisible();
		}
	});

	test("memory profile section is visible", async ({ page }) => {
		await expect(
			page.getByRole("tab", { name: "Memory Profile" }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "About You" }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Preferences" }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Goals & Ongoing Work" }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Constraints & Boundaries" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /refresh|reload/i }),
		).toHaveCount(0);
		await expect(page.getByText(/Focus Continuity|task memory|raw/i)).toHaveCount(
			0,
		);
	});

	test("document list does not render filter pills", async ({ page }) => {
		await page.getByRole("tab", { name: "Documents" }).click();
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

		await page.getByRole("tab", { name: "Documents" }).click();
		const firstDocumentRow = page.locator("tbody tr").first();
		if ((await firstDocumentRow.count()) === 0) {
			await expect(page.getByText("No documents")).toBeVisible();
			expect(pageErrors).toEqual([]);
			return;
		}
		await expect(firstDocumentRow).toBeVisible();
		await firstDocumentRow.click();
		await expect(page.getByTestId("workspace-main")).toBeVisible();

		expect(pageErrors).toEqual([]);
	});
});
