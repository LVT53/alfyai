import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { ARTIFACT_TOUR_DEFAULTS } from "../../src/lib/server/artifact-tour-defaults";
import { createTourUser, type TourKind } from "./artifact-tours-helpers";
import { login } from "./helpers";

// The admin's tour editor (RC-T I-2 and Minors 1-4, 9): what the pane shows for
// a tour, said and clicked the way an admin does it. Every flow is real pointer
// and keyboard input; the only API calls are the arrangements (a draft with a
// bare summary slide) and reading back what a reader would be served.

async function openCampaigns(
	page: Page,
	names: { tab: string; pane: string } = {
		tab: "Administration",
		pane: "Campaigns",
	},
) {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: names.tab }).click();
	await page.getByRole("button", { name: names.pane, exact: true }).click();
}

/**
 * A tour draft whose summary slide has no body, the way the seed now leaves it:
 * the arrangement is the API's, everything after it is the admin's.
 */
async function makeTourDraft(
	request: APIRequestContext,
	kind: TourKind,
	name: string,
	summary?: { en: string; hu: string },
): Promise<string> {
	const defaults = ARTIFACT_TOUR_DEFAULTS[kind];
	const created = await request.post("/api/admin/campaigns", {
		data: { type: "artifact_tour", name, releaseVersion: kind },
	});
	expect(created.status()).toBe(201);
	const id = ((await created.json()) as { campaign: { id: string } }).campaign
		.id;
	const filled = await request.patch(`/api/admin/campaigns/${id}`, {
		data: {
			slides: [
				{
					layoutType: "summary",
					sortOrder: 1,
					title: summary ?? defaults.summary,
					body: { en: "", hu: "" },
				},
				...defaults.slides.map((slide, index) => ({
					layoutType: "standard",
					sortOrder: index + 2,
					title: slide.title,
					body: slide.body,
				})),
			],
		},
	});
	expect(filled.ok()).toBe(true);
	return id;
}

async function servedSummary(
	request: APIRequestContext,
	kind: TourKind,
): Promise<{ source: string; summary: { en: string; hu: string } }> {
	const response = await request.get(`/api/artifact-tours/${kind}`);
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { tour: never }).tour;
}

async function removeDrafts(request: APIRequestContext, ids: string[]) {
	for (const id of ids) {
		await request.delete(`/api/admin/campaigns/${id}`).catch(() => undefined);
	}
}

const HINT =
	"The title is the line an empty Document, App or Canvas shows. Nothing else on this slide is shown.";

test.describe("the admin's tour editor", () => {
	test("publishes a tour whose summary slide has no body, and says what that slide is", async ({
		page,
	}) => {
		await login(page);
		const made: string[] = [];
		const edited = {
			en: "Nothing here yet. Ask for a tool.",
			hu: "Itt még semmi. Kérj egy eszközt.",
		};
		try {
			made.push(
				await makeTourDraft(page.request, "app", "E2E bare line tour", edited),
			);
			await openCampaigns(page);
			await page
				.getByTestId("admin-campaign-row")
				.filter({ hasText: "E2E bare line tour" })
				.click();
			await expect(
				page.getByRole("heading", { name: "E2E bare line tour" }).first(),
			).toBeVisible();

			// Slide one is the empty-state line: it says so, asks for its title
			// and has no body field to fill for words nobody sees.
			await expect(page.getByText(HINT)).toBeVisible();
			await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
				edited.en,
			);
			await expect(page.getByLabel("Body", { exact: true })).toHaveCount(0);

			// None of the fields no tour uses is offered on any slide.
			const rail = page.getByTestId("admin-campaign-slide-thumb");
			await expect(rail).toHaveCount(4);
			for (let index = 0; index < 4; index += 1) {
				await rail.nth(index).click();
				await expect(page.getByLabel("Alt text")).toHaveCount(0);
				await expect(page.getByLabel("Action destination")).toHaveCount(0);
				await expect(page.getByLabel("Action label")).toHaveCount(0);
				await expect(page.getByText("Desktop screenshot")).toHaveCount(0);
				await expect(page.getByText("Mobile screenshot")).toHaveCount(0);
			}
			// A step still has its words.
			await expect(page.getByLabel("Body", { exact: true })).toBeVisible();

			// The checklist has no complaint, and Publish is a click away.
			await expect(
				page.getByTestId("campaign-checklist").getByText(/Ready to publish/),
			).toBeVisible();
			const publish = page.getByRole("button", {
				name: "Publish",
				exact: true,
			});
			await expect(publish).toBeEnabled();
			await publish.click();
			await expect(page.getByText("Campaign published.")).toBeVisible();

			// What a reader is served is the admin's line.
			const served = await servedSummary(page.request, "app");
			expect(served.source).toBe("published");
			expect(served.summary).toEqual(edited);

			// Tours record nothing, so a published one has no performance to show.
			await expect(page.getByTestId("campaign-performance")).toHaveCount(0);

			// The Duplicate > edit > Publish loop leaves one live copy: the older
			// revision is archived by the newer one's publish, and archiving the
			// newest brings the code copy back.
			await page.getByRole("button", { name: "Duplicate as draft" }).click();
			await expect(
				page.getByRole("heading", { name: "E2E bare line tour copy" }).first(),
			).toBeVisible();
			await page.getByRole("button", { name: "Publish", exact: true }).click();
			await expect(page.getByText("Campaign published.")).toBeVisible();
			const rows = page
				.getByTestId("admin-campaign-row")
				.filter({ hasText: "E2E bare line tour" });
			await expect(rows.filter({ hasText: "Archived" })).toHaveCount(1);
			await expect(rows.filter({ hasText: "Published" })).toHaveCount(1);

			await page.getByTestId("campaign-menu").click();
			await page.getByRole("menuitem", { name: "Archive" }).click();
			await page.getByTestId("confirm-delete").click();
			await expect(page.getByText("Campaign archived.")).toBeVisible();
			const back = await servedSummary(page.request, "app");
			expect(back.source).toBe("default");
			expect(back.summary).toEqual(ARTIFACT_TOUR_DEFAULTS.app.summary);
		} finally {
			await removeDrafts(page.request, made);
		}
	});

	test("shows a tour draft's type as a tour in its details, read-only", async ({
		page,
	}) => {
		await login(page);
		const made: string[] = [];
		try {
			made.push(await makeTourDraft(page.request, "document", "E2E tour type"));
			await openCampaigns(page);
			await page
				.getByTestId("admin-campaign-row")
				.filter({ hasText: "E2E tour type" })
				.click();
			await page.getByRole("button", { name: "Campaign details" }).click();

			const dialog = page.getByRole("dialog");
			await expect(dialog.getByText("Tour · Document")).toBeVisible();
			// The kind is the tour's own, not a choice: no First-run, no Release.
			await expect(
				dialog.getByRole("button", { name: "First-run" }),
			).toHaveCount(0);
			await expect(dialog.getByRole("button", { name: "Release" })).toHaveCount(
				0,
			);
			await expect(dialog.getByLabel("Release")).toHaveCount(0);

			// The name is still the admin's to change, and the header keeps saying
			// what the campaign is.
			await dialog.getByLabel("Name").fill("E2E tour type, renamed");
			await dialog.getByRole("button", { name: "Save details" }).click();
			await expect(
				page.getByRole("heading", { name: "E2E tour type, renamed" }).first(),
			).toBeVisible();
			await expect(page.locator(".editor-meta")).toContainText(
				"Tour · Document",
			);
			await expect(page.locator(".editor-meta")).not.toContainText("Release");
		} finally {
			await removeDrafts(page.request, made);
		}
	});

	test("offers the Summary layout to a tour and to nothing else", async ({
		page,
	}) => {
		await login(page);
		const made: string[] = [];
		try {
			made.push(await makeTourDraft(page.request, "canvas", "E2E tour layout"));
			const release = await page.request.post("/api/admin/campaigns", {
				data: {
					type: "release_update",
					name: "E2E release layout",
					releaseVersion: "9.9.9",
				},
			});
			expect(release.status()).toBe(201);
			made.push(
				((await release.json()) as { campaign: { id: string } }).campaign.id,
			);
			const filled = await page.request.patch(
				`/api/admin/campaigns/${made[1]}`,
				{
					data: {
						slides: [
							{
								layoutType: "standard",
								sortOrder: 1,
								title: { en: "A", hu: "A" },
								body: { en: "B", hu: "B" },
							},
						],
					},
				},
			);
			expect(filled.ok()).toBe(true);
			await openCampaigns(page);

			async function layoutPills(name: string, slideIndex: number) {
				await page
					.getByTestId("admin-campaign-row")
					.filter({ hasText: name })
					.click();
				await expect(page.getByRole("heading", { name }).first()).toBeVisible();
				await page
					.getByTestId("admin-campaign-slide-thumb")
					.nth(slideIndex)
					.click();
				await page.getByTestId("campaign-slide-menu").click();
				await page.getByRole("menuitem", { name: /^Layout/ }).click();
				const dialog = page.getByRole("dialog");
				const pills = await dialog.locator(".pref-pill").allTextContents();
				await page.keyboard.press("Escape");
				await expect(dialog).toHaveCount(0);
				return pills.map((text) => text.trim());
			}

			expect(await layoutPills("E2E tour layout", 1)).toContain("Summary");
			expect(await layoutPills("E2E release layout", 0)).not.toContain(
				"Summary",
			);
		} finally {
			await removeDrafts(page.request, made);
		}
	});

	// RC-T Minor 4: the preview of a tour is the card a reader meets, drawn with
	// the draft's words, and a picture only.
	test("previews a tour as the reader's card, slide by slide, and follows what is typed", async ({
		page,
	}) => {
		await login(page);
		const made: string[] = [];
		const posted: string[] = [];
		page.on("request", (request) => {
			if (request.url().includes("/api/artifact-tours")) {
				posted.push(`${request.method()} ${request.url()}`);
			}
		});
		try {
			made.push(
				await makeTourDraft(page.request, "canvas", "E2E tour preview"),
			);
			await openCampaigns(page);
			await page
				.getByTestId("admin-campaign-row")
				.filter({ hasText: "E2E tour preview" })
				.click();
			const preview = page.getByTestId("tour-preview");
			const canvas = ARTIFACT_TOUR_DEFAULTS.canvas;

			// Slide one is the line an empty Canvas shows, with the link to the tour.
			await expect(preview.getByTestId("tour-preview-line")).toHaveText(
				canvas.summary.en,
			);
			await expect(
				preview.getByTestId("tour-preview-line-replay"),
			).toBeVisible();

			// A step is the card itself, for the slide chosen in the rail.
			const rail = page.getByTestId("admin-campaign-slide-thumb");
			await rail.nth(1).click();
			await expect(preview.getByTestId("artifact-tour-title")).toHaveText(
				canvas.slides[0].title.en,
			);
			await expect(preview.getByTestId("artifact-tour-step")).toHaveText(
				"Step 1 of 3",
			);
			await rail.nth(3).click();
			await expect(preview.getByTestId("artifact-tour-title")).toHaveText(
				canvas.slides[2].title.en,
			);
			await expect(preview.getByTestId("artifact-tour-step")).toHaveText(
				"Step 3 of 3",
			);

			// It follows the words as they are typed, and the card never takes the
			// keyboard from the field the admin is typing in.
			const title = page.getByLabel("Title", { exact: true });
			await title.click();
			await title.fill("Typed by the admin");
			await expect(preview.getByTestId("artifact-tour-title")).toHaveText(
				"Typed by the admin",
			);
			await expect(title).toBeFocused();

			// The language being edited is the language previewed.
			await page.getByRole("button", { name: "HU", exact: true }).click();
			await expect(preview.getByTestId("artifact-tour-title")).toHaveText(
				canvas.slides[2].title.hu,
			);

			// Nothing here announces anything: there is no device toggle, and the
			// card never wrote a "seen" row for the admin.
			await expect(page.getByRole("button", { name: "Mobile" })).toHaveCount(0);
			expect(posted.filter((entry) => entry.startsWith("POST"))).toEqual([]);
		} finally {
			await removeDrafts(page.request, made);
		}
	});

	test("counts a tour as three steps and the empty-state line, in both languages", async ({
		page,
	}) => {
		const admin = await createTourUser("hu", "admin");
		await login(page, admin.email, admin.password);
		const made: string[] = [];
		try {
			made.push(await makeTourDraft(page.request, "canvas", "E2E tour count"));
			await openCampaigns(page, { tab: "Adminisztráció", pane: "Kampányok" });
			const row = page
				.getByTestId("admin-campaign-row")
				.filter({ hasText: "E2E tour count" });
			await row.click();
			await expect(
				page.getByRole("heading", { name: "E2E tour count" }).first(),
			).toBeVisible();

			await expect(row).toContainText(
				"Bemutató · Tábla · 3 lépés + üres állapot sora",
			);
			await expect(page.locator(".editor-meta")).toContainText(
				"Bemutató · Tábla · 3 lépés + üres állapot sora",
			);
			await expect(page.locator(".editor-meta")).not.toContainText("4 dia");
		} finally {
			await removeDrafts(page.request, made);
		}
	});
});
