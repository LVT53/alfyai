import { expect, test } from "@playwright/test";

import { login, waitForHydration } from "./helpers";

test.describe("Knowledge page", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await expect(
			page.getByRole("heading", { name: "Knowledge Base" }),
		).toBeVisible();
		await waitForHydration(page);
	});

	test("documents section is visible", async ({ page }) => {
		await page.getByRole("tab", { name: "Documents" }).click();
		await expect(
			page.getByRole("heading", { name: "Documents" }),
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
		// exact: true — the persona summary card heading ("What I remember about
		// you") otherwise also matches the "About You" substring.
		await expect(
			page.getByRole("heading", { name: "About You", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Preferences", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Goals & Ongoing Work", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", {
				name: "Constraints & Boundaries",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /refresh|reload/i }),
		).toHaveCount(0);
		await expect(
			page.getByText(/Focus Continuity|task memory|raw/i),
		).toHaveCount(0);
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
		// Opening a row requests the document workspace. Whether the preview
		// surface actually mounts depends on the document's retrievable content
		// (uploads without served preview content will not), so treat the
		// workspace as best-effort — the assertion under test is that opening a
		// document does not throw a runtime page error.
		await page
			.getByTestId("workspace-main")
			.waitFor({ state: "visible", timeout: 10000 })
			.catch(() => {});

		expect(pageErrors).toEqual([]);
	});

	test("the page title is the shared serif size", async ({ page }) => {
		const size = await page
			.getByRole("heading", { name: "Knowledge Base" })
			.evaluate((node) => getComputedStyle(node).fontSize);
		// 1.75rem against a 16px root.
		expect(size).toBe("28px");
	});

	test("each memory category states its own total", async ({ page }) => {
		const counts = page.getByTestId("memory-category-count");
		await expect(counts.first()).toBeVisible();
		// "N remembered · showing M" — never a bare list length.
		await expect(counts.first()).toHaveText(/remembered/);
	});

	test("the memory filter narrows every category at once", async ({ page }) => {
		const filter = page.getByRole("searchbox", { name: "Filter memories" });
		await expect(filter).toBeVisible();

		await filter.fill("zzz-no-such-memory-xyz");
		// With nothing matching anywhere, the card says so once rather than
		// leaving four silently short lists.
		await expect(page.getByTestId("memory-filter-no-matches")).toBeVisible();

		await filter.fill("");
		await expect(page.getByTestId("memory-filter-no-matches")).toHaveCount(0);
	});

	test("the filter chips carry a count and narrow to one category", async ({
		page,
	}) => {
		const chips = page.getByTestId("memory-filter-chip");
		await expect(chips.first()).toBeVisible();
		// All, plus one per category.
		expect(await chips.count()).toBe(5);

		await chips.nth(2).click();
		await expect(
			page.getByRole("heading", { name: "About You", exact: true }),
		).toHaveCount(0);

		await chips.nth(0).click();
		await expect(
			page.getByRole("heading", { name: "About You", exact: true }),
		).toBeVisible();
	});

	test("the rail explains how to read a row and how to reach the settings", async ({
		page,
	}) => {
		await expect(
			page.getByRole("heading", { name: "Reading a row" }),
		).toBeVisible();

		// Scoped to the card: an empty category's hint also links to memory
		// settings, so the bare name matches several links on this page.
		const aboutCard = page
			.getByRole("heading", { name: "What this is for" })
			.locator("xpath=ancestor::section[1]");
		await expect(aboutCard).toBeVisible();
		await expect(
			aboutCard.getByRole("link", { name: "Memory settings" }),
		).toBeVisible();
		await expect(
			aboutCard.getByRole("link", { name: /Clear memory and knowledge/ }),
		).toBeVisible();
	});

	test("documents give version and status columns of their own", async ({
		page,
	}) => {
		await page.getByRole("tab", { name: "Documents" }).click();

		const table = page.locator("table.documents-table");
		if ((await table.count()) === 0) {
			// No documents seeded in this run; the table is not drawn at all.
			await expect(page.getByText(/No documents/)).toBeVisible();
			return;
		}

		const headers = await table
			.locator("thead th")
			.evaluateAll((nodes) =>
				nodes.map((node) =>
					(node.textContent ?? "").replace(/[\u2195\u2191\u2193]/g, "").trim(),
				),
			);
		expect(headers.slice(2)).toEqual([
			"Name",
			"Version",
			"Type",
			"Status",
			"Size",
			"Date",
			"Actions",
		]);
	});

	test("documents keep their sort control, direction and drop zone", async ({
		page,
	}) => {
		await page.getByRole("tab", { name: "Documents" }).click();

		const sortSelect = page.getByLabel("Sort documents by");
		if ((await sortSelect.count()) === 0) {
			await expect(page.getByText(/No documents/)).toBeVisible();
			return;
		}
		await expect(sortSelect).toBeVisible();
		await expect(page.getByTestId("drop-hint")).toContainText(
			"Drop files here to upload",
		);

		// The direction toggle actually re-sorts: the server-managed list
		// carries the direction in the URL.
		await page.getByTestId("sort-direction").click();
		await expect(page).toHaveURL(/dir=asc/);
	});

	test("the memory filter keeps what you type", async ({ page }) => {
		const filter = page.getByRole("searchbox", { name: "Filter memories" });
		await filter.fill("nextcloud");
		await expect(filter).toHaveValue("nextcloud");
	});
});
