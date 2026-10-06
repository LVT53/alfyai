import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	conversations,
	users,
} from "../../src/lib/server/db/schema";
import { login, TEST_EMAIL, waitForHydration } from "./helpers";

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
			// Exact: Step 14 gave the zero-count Documents chip its own "No
			// documents yet" reason (`title`/`aria-describedby`), which a loose
			// match against this empty-state heading would also catch.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
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
			// Exact: see the note in "documents section is visible" above.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
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
		// "Reading a row" is a tooltip on the portrait title now, not a card at
		// the bottom of the rail: nothing on the page until it is asked for.
		await expect(page.getByText("Reading a row")).toHaveCount(0);
		await page.getByRole("button", { name: "Reading a row" }).focus();
		const legend = page.getByRole("tooltip");
		await expect(legend).toBeVisible();
		await expect(legend).toContainText("Reading a row");
		await expect(legend).toContainText("you said it");

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
			// Exact: see the note in "documents section is visible" above.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
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
			// Exact: see the note in "documents section is visible" above.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
			return;
		}
		await expect(sortSelect).toBeVisible();
		// The hint row is gone; the limit rides on the Upload button, which
		// sits at the right end of the toolbar beside Sort.
		await expect(page.getByTestId("drop-hint")).toHaveCount(0);
		// exact: true — the Documents-tab filter chip row (Slice 7) renders
		// before this toolbar in DOM order once rows exist, and its "Uploaded"
		// chip's accessible name ("Filter: Uploaded, N items") otherwise also
		// matches "Upload" as a substring, so a non-exact `.first()` can
		// resolve to the chip instead of the real upload button.
		const upload = page.getByRole("button", { name: "Upload", exact: true });
		await expect(upload).toHaveAttribute("title", /100 MB/);

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

	// Ruling 69: Slides is shelved, so the type chips are the kinds that can
	// exist. Production offers no filter for something it cannot make.
	test("offers a chip for each kind that can be made, and none for Slides", async ({
		page,
	}) => {
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.getByRole("tab", { name: "Documents" }).click();

		const chips = page.getByTestId("documents-filter-chips");
		await expect(chips).toBeVisible();
		await expect(chips.getByRole("button")).toHaveText([
			/^\s*All/,
			/^\s*Documents/,
			/^\s*Canvas/,
			/^\s*Apps/,
			/^\s*Files/,
		]);
		await expect(page.getByTestId("documents-filter-chip-slides")).toHaveCount(
			0,
		);
		await expect(chips.getByText(/Slides/)).toHaveCount(0);
	});

	// Slice 7 (Feature 2, ADR-0066): the artifact family (Document/App/Canvas/
	// Slides) joins the Documents tab. Neither this spec nor any other seeded
	// a document/generated-file/artifact row before this slice, so this is
	// real end-to-end pipeline coverage, not a fixture that only proves the
	// seed worked — direct db writes, matching the repo's existing E2E
	// seeding convention (see conversation-title-refresh.spec.ts).
	test("shows a seeded artifact-family row with its chip, type pill and no download action", async ({
		page,
	}) => {
		// A bare conversation row, seeded directly like several other E2E specs
		// already do (see conversation-title-refresh.spec.ts) — no messages, no
		// live chat round trip, just an id for the artifact's ownership scope.
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-canvas-conv-${Date.now()}`;
		const artifactId = `e2e-canvas-${Date.now()}`;
		const artifactName = "Vienna trip board (e2e)";
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the Documents tab e2e case",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(artifacts).values({
			id: artifactId,
			userId: user.id,
			conversationId,
			type: "artifact",
			retrievalClass: "durable",
			name: artifactName,
			metadataJson: JSON.stringify({
				artifactType: "canvas",
				title: artifactName,
			}),
			createdAt: now,
			updatedAt: now,
		});

		try {
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await page.getByRole("tab", { name: "Documents" }).click();

			const row = page.locator("tbody tr", { hasText: artifactName });
			await expect(row).toBeVisible();
			await expect(row.locator(".col-type")).toHaveText("Canvas");

			// The "Canvas 1" chip narrows the list down to this row.
			const canvasChip = page.getByTestId("documents-filter-chip-canvas");
			await expect(canvasChip).toBeVisible();
			await canvasChip.click();
			await expect(page).toHaveURL(/type=canvas/);
			await expect(row).toBeVisible();

			// Actions column: Delete only, no Download.
			await expect(row.getByRole("button", { name: /download/i })).toHaveCount(
				0,
			);
			await expect(row.getByRole("button", { name: /delete/i })).toBeVisible();
		} finally {
			await db.delete(artifacts).where(eq(artifacts.id, artifactId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});

	// Ruling 60: the Documents tab's second-tier file-family filter, live only
	// under Files. Real end-to-end pipeline coverage of the actual registry ->
	// store -> route -> UI chain, like the artifact-family case above — no
	// earlier spec seeds this mix of real file types.
	test("Files -> PDF narrows to the PDF row, switching to Documents hides the second row, and 390px wraps without horizontal overflow", async ({
		page,
	}) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const stamp = Date.now();
		const conversationId = `e2e-file-family-conv-${stamp}`;
		const now = new Date();
		const pdfName = `Q1 report ${stamp}.pdf`;
		const docxName = `Meeting notes ${stamp}.docx`;
		const documentArtifactName = `Trip plan ${stamp}`;

		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the file-family e2e case",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(artifacts).values([
			{
				id: `e2e-ff-pdf-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: pdfName,
				mimeType: "application/pdf",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-docx-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: docxName,
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-xlsx-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: `Budget ${stamp}.xlsx`,
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-image-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: `Photo ${stamp}.png`,
				mimeType: "image/png",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-md-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: `Ideas ${stamp}.md`,
				mimeType: "text/markdown",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-document-${stamp}`,
				userId: user.id,
				conversationId,
				type: "artifact",
				retrievalClass: "durable",
				name: documentArtifactName,
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: documentArtifactName,
				}),
				createdAt: now,
				updatedAt: now,
			},
		]);

		try {
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await page.getByRole("tab", { name: "Documents" }).click();

			const filesChip = page.getByTestId("documents-filter-chip-uploaded");
			await expect(filesChip).toContainText("Files");
			await filesChip.click();
			await expect(page).toHaveURL(/type=uploaded/);

			await expect(
				page.getByTestId("documents-file-family-chips"),
			).toBeVisible();
			const pdfChip = page.getByTestId("documents-file-family-chip-pdf");
			await expect(pdfChip).toBeVisible();
			await pdfChip.click();
			await expect(page).toHaveURL(/family=pdf/);

			await expect(
				page.locator("tbody tr", { hasText: pdfName }),
			).toBeVisible();
			// The other seeded Files rows narrow OUT once PDF is the active family.
			await expect(page.locator("tbody tr", { hasText: docxName })).toHaveCount(
				0,
			);

			// Switching to a non-Files kind chip hides the second row entirely
			// and drops `family` from the URL in the same navigation.
			await page.getByTestId("documents-filter-chip-document").click();
			await expect(page).toHaveURL(/type=document/);
			await expect(page).not.toHaveURL(/family=/);
			await expect(page.getByTestId("documents-file-family-chips")).toHaveCount(
				0,
			);
			await expect(
				page.locator("tbody tr", { hasText: documentArtifactName }),
			).toBeVisible();

			// 390px: the two-tier chip row must wrap onto more lines, never
			// force the page to scroll horizontally.
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByTestId("documents-filter-chip-uploaded").click();
			await expect(
				page.getByTestId("documents-file-family-chips"),
			).toBeVisible();
			const hasHorizontalOverflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth >
					document.documentElement.clientWidth,
			);
			expect(hasHorizontalOverflow).toBe(false);
		} finally {
			await db
				.delete(artifacts)
				.where(eq(artifacts.conversationId, conversationId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});
});
