import { expect, type Page, test } from "@playwright/test";
import { ARTIFACT_TOUR_DEFAULTS } from "../../src/lib/server/artifact-tour-defaults";
import { login } from "./helpers";

// A 1x1 PNG: enough for the slide's image input to open the crop dialog.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

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

	test("the crop dialog keeps Tab inside, cancels on Escape and hands focus back", async ({
		page,
	}) => {
		await openAdminPane(page, "Campaigns");
		await page.getByRole("button", { name: "New campaign" }).click();
		await page.locator("#campaign-dialog-name").fill("E2E crop focus");
		await page.getByRole("button", { name: "Create campaign" }).click();
		// The New campaign dialog returns focus to its opener as it finishes
		// fading out, which is a moment after its last click. Let it finish
		// before anything is focused on purpose: a click on "Add slide" inside
		// that moment gets its focus taken back by the opener, and this test
		// asserts that focus returns to "Add slide" once the crop closes.
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.getByRole("button", { name: "Add slide" }).click();
		await expect(
			page.locator('[data-testid="admin-campaign-slide-thumb"]'),
		).toHaveCount(1);

		await page
			.locator('input[type="file"][accept="image/*"]')
			.first()
			.setInputFiles({
				name: "shot.png",
				mimeType: "image/png",
				buffer: TINY_PNG,
			});
		const crop = page.getByRole("dialog", { name: "Crop campaign screenshot" });
		await expect(crop).toBeFocused();
		await expect(crop.getByRole("button", { name: "Save crop" })).toBeEnabled();

		// Focus starts on the panel itself: Shift+Tab wraps to the last control
		// rather than walking out to the page behind, and Tab wraps back.
		await page.keyboard.press("Shift+Tab");
		await expect(crop.getByRole("button", { name: "Save crop" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(crop.getByRole("button", { name: "Close" })).toBeFocused();

		// Escape cancels the crop and focus goes back to what had it before.
		await page.keyboard.press("Escape");
		await expect(crop).toBeHidden();
		await expect(page.getByRole("button", { name: "Add slide" })).toBeFocused();

		await page.getByTestId("campaign-menu").click();
		await page.getByRole("menuitem", { name: /Delete draft/ }).click();
		await page.getByTestId("confirm-delete").click();
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

	test("seeds the three shipped tour drafts from the campaign menu, and no Slides one", async ({
		page,
	}) => {
		await openAdminPane(page, "Campaigns");

		// Like the first-run seed: the menu belongs to an open campaign.
		await page.getByRole("button", { name: "New campaign" }).click();
		await page.locator("#campaign-dialog-name").fill("E2E tour seed host");
		await page.getByRole("button", { name: "Create campaign" }).click();
		await expect(
			page.getByRole("heading", { name: "E2E tour seed host" }).first(),
		).toBeVisible();

		await page.getByTestId("campaign-menu").click();
		await page.getByRole("menuitem", { name: /Seed tour drafts/ }).click();

		// Ruling 69: Document, App and Canvas ship; Slides is shelved. (A rerun
		// against the same database seeds nothing new and reports the existing
		// three, so the count in the message is not asserted.)
		await expect(
			page.getByText(
				/Created \d+ tour drafts?\.|The tour drafts already exist\./,
			),
		).toBeVisible();
		const rows = page.locator('[data-testid="admin-campaign-row"]');
		for (const name of ["Document tour", "App tour", "Canvas tour"]) {
			await expect(rows.filter({ hasText: name }).first()).toBeVisible();
		}
		await expect(rows.filter({ hasText: "Slides tour" })).toHaveCount(0);
	});

	// Ruling 71: a tour is found by its release text, so a tour whose release
	// names no kind that ships would publish and reach nobody. The pane's own
	// "New campaign" dialog only makes first-run and release campaigns, so a
	// tour with such a release can only come from the API; the arrangement is
	// made there, and everything the admin sees and clicks is the pane's.
	test("refuses to publish a tour whose release names no kind that ships, and says why in the checklist", async ({
		page,
	}) => {
		const slides = [
			{
				layoutType: "summary",
				sortOrder: 1,
				title: ARTIFACT_TOUR_DEFAULTS.canvas.summary,
				body: { en: "A second line.", hu: "Egy második sor." },
			},
			...ARTIFACT_TOUR_DEFAULTS.canvas.slides.map((slide, index) => ({
				layoutType: "standard",
				sortOrder: index + 2,
				title: slide.title,
				body: slide.body,
			})),
		];
		const made: string[] = [];
		async function tourDraft(name: string, releaseVersion: string) {
			const created = await page.request.post("/api/admin/campaigns", {
				data: { type: "artifact_tour", name, releaseVersion },
			});
			expect(created.status()).toBe(201);
			const id = ((await created.json()) as { campaign: { id: string } })
				.campaign.id;
			made.push(id);
			const filled = await page.request.patch(`/api/admin/campaigns/${id}`, {
				data: { slides },
			});
			expect(filled.ok()).toBe(true);
			return id;
		}

		try {
			const typoId = await tourDraft("E2E typo tour", "2.1.0");
			await tourDraft("E2E good tour", "canvas");
			await openAdminPane(page, "Campaigns");

			// The tour that names no kind: the pane says what it is, the checklist
			// says what is wrong, and Publish is not clickable.
			const rail = page.getByTestId("admin-campaign-row");
			await rail.filter({ hasText: "E2E typo tour" }).click();
			await expect(
				page.getByRole("heading", { name: "E2E typo tour" }).first(),
			).toBeVisible();
			await expect(page.locator(".editor-meta")).toContainText(
				"Tour · 2.1.0 · 3 steps + empty-state line",
			);
			const checklist = page.getByTestId("campaign-checklist");
			await expect(checklist.getByText("1 check failing")).toBeVisible();
			await expect(
				checklist.getByText("Tour kind: Document, App or Canvas"),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Publish", exact: true }),
			).toBeDisabled();

			// A client that skips the pane meets the server's own refusal.
			const refused = await page.request.post(
				`/api/admin/campaigns/${typoId}/publish`,
			);
			expect(refused.status()).toBe(400);
			expect(await refused.json()).toMatchObject({
				fieldErrors: {
					tourKind:
						"A tour campaign's release must be the kind it introduces: document, app or canvas.",
				},
			});

			// The same tour under a kind that ships is ready, in the kind's own word.
			await rail.filter({ hasText: "E2E good tour" }).click();
			await expect(
				page.getByRole("heading", { name: "E2E good tour" }).first(),
			).toBeVisible();
			await expect(page.locator(".editor-meta")).toContainText(
				"Tour · Canvas · 3 steps + empty-state line",
			);
			await expect(
				page.getByTestId("campaign-checklist").getByText(/Ready to publish/),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Publish", exact: true }),
			).toBeEnabled();
		} finally {
			for (const id of made) {
				await page.request.delete(`/api/admin/campaigns/${id}`);
			}
		}
	});

	test("stacks the slide rail into a filmstrip of equal frames", async ({
		page,
	}) => {
		await openAdminPane(page, "Campaigns");

		await page.getByRole("button", { name: "New campaign" }).click();
		await page.locator("#campaign-dialog-name").fill("E2E filmstrip");
		await page.getByRole("button", { name: "Create campaign" }).click();
		await expect(
			page.getByRole("heading", { name: "E2E filmstrip" }).first(),
		).toBeVisible();

		// Two slides whose titles are very different lengths: a flex item's
		// automatic minimum size used to let the longer one stretch its own
		// frame, so no two thumbnails were the same width — or, through the
		// 16:10 ratio, the same height.
		await page.getByRole("button", { name: "Add slide" }).click();
		await page.getByLabel("Title", { exact: true }).fill("Hi");
		await page.getByRole("button", { name: "Add slide" }).click();
		await page
			.getByLabel("Title", { exact: true })
			.fill("A slide title long enough to stretch its own frame");

		const thumbs = page.locator('[data-testid="admin-campaign-slide-thumb"]');
		await expect(thumbs).toHaveCount(2);

		await page.setViewportSize({ width: 900, height: 900 });
		const boxes = [
			await thumbs.nth(0).boundingBox(),
			await thumbs.nth(1).boundingBox(),
		];
		expect(Math.round(boxes[0]?.width ?? 0)).toBe(
			Math.round(boxes[1]?.width ?? 1),
		);
		expect(Math.round(boxes[0]?.height ?? 0)).toBe(
			Math.round(boxes[1]?.height ?? 1),
		);

		await page.setViewportSize({ width: 1600, height: 900 });
		await page.getByTestId("campaign-menu").click();
		await page.getByRole("menuitem", { name: /Delete draft/ }).click();
		await page.getByTestId("confirm-delete").click();
		await expect(
			page.getByRole("heading", { name: "E2E filmstrip" }),
		).toHaveCount(0);
	});
});
