import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import SettingsAdminCampaignsPane from "./SettingsAdminCampaignsPane.svelte";

vi.mock("$app/navigation", () => ({
	invalidateAll: vi.fn(),
}));

vi.mock("$lib/client/api/campaigns", () => ({
	archiveAdminCampaign: vi.fn(),
	createAdminCampaign: vi.fn(),
	deleteAdminCampaignDraft: vi.fn(),
	duplicateAdminCampaign: vi.fn(),
	fetchAdminCampaign: vi.fn(),
	fetchAdminCampaigns: vi.fn(),
	publishAdminCampaign: vi.fn(),
	seedArtifactTours: vi.fn(),
	seedFirstRunCampaign: vi.fn(),
	updateAdminCampaign: vi.fn(),
}));

vi.mock("$lib/client/api/campaign-assets", () => ({
	fetchAdminCampaignAsset: vi.fn(),
	uploadCampaignAssetSource: vi.fn(),
	saveCampaignAssetCrop: vi.fn(),
}));

import { invalidateAll } from "$app/navigation";
import {
	fetchAdminCampaignAsset,
	uploadCampaignAssetSource,
} from "$lib/client/api/campaign-assets";
import {
	archiveAdminCampaign,
	deleteAdminCampaignDraft,
	fetchAdminCampaign,
	fetchAdminCampaigns,
	publishAdminCampaign,
	seedArtifactTours,
	updateAdminCampaign,
} from "$lib/client/api/campaigns";
import { ApiError } from "$lib/client/api/http";

const mockArchiveAdminCampaign = archiveAdminCampaign as ReturnType<
	typeof vi.fn
>;
const mockDeleteAdminCampaignDraft = deleteAdminCampaignDraft as ReturnType<
	typeof vi.fn
>;
const mockFetchAdminCampaigns = fetchAdminCampaigns as ReturnType<typeof vi.fn>;
const mockFetchAdminCampaign = fetchAdminCampaign as ReturnType<typeof vi.fn>;
const mockPublishAdminCampaign = publishAdminCampaign as ReturnType<
	typeof vi.fn
>;
const mockUpdateAdminCampaign = updateAdminCampaign as ReturnType<typeof vi.fn>;
const mockSeedArtifactTours = seedArtifactTours as ReturnType<typeof vi.fn>;
const mockUploadCampaignAssetSource = uploadCampaignAssetSource as ReturnType<
	typeof vi.fn
>;
const mockFetchAdminCampaignAsset = fetchAdminCampaignAsset as ReturnType<
	typeof vi.fn
>;
const mockInvalidateAll = invalidateAll as ReturnType<typeof vi.fn>;

/** Waits for the editor to have loaded the selected campaign. */
async function waitForEditor(name = "Welcome tour") {
	await waitFor(() => {
		expect(screen.getAllByRole("heading", { name }).length).toBeGreaterThan(0);
	});
}

function openSlideMenu() {
	return fireEvent.click(screen.getByTestId("campaign-slide-menu"));
}

function openCampaignMenu() {
	return fireEvent.click(screen.getByTestId("campaign-menu"));
}

describe("SettingsAdminCampaignsPane", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchAdminCampaigns.mockResolvedValue([
			{
				id: "campaign-1",
				type: "first_run_onboarding",
				version: 3,
				name: "Welcome tour",
				status: "draft",
				slideCount: 2,
				updatedAt: "2026-05-17T08:00:00.000Z",
			},
		]);
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			type: "first_run_onboarding",
			version: 3,
			name: "Welcome tour",
			releaseVersion: "1.0.0",
			status: "draft",
			analyticsSummary: {
				autoShown: 7,
				completed: 3,
				skipped: 1,
				replayOpened: 2,
				completionRate: 0.75,
			},
			slides: [
				{
					id: "slide-setup",
					kind: "setup",
					sortOrder: 1,
					semanticRole: "feature",
					setupControls: ["ui_language", "theme"],
					titleEn: "Set up AlfyAI",
					titleHu: "AlfyAI beállítása",
					bodyEn: "Connect your tools.",
					bodyHu: "Kapcsold össze az eszközeidet.",
					altEn: "Setup screenshot",
					altHu: "Beállítás képernyőkép",
					desktopAssetId: "setup-desktop",
					mobileAssetId: "setup-mobile",
				},
				{
					id: "slide-standard",
					kind: "standard",
					sortOrder: 2,
					semanticRole: "data_disclosure",
					titleEn: "Start chatting",
					titleHu: "Kezdj beszélgetni",
					bodyEn: "Ask a question.",
					bodyHu: "Tegyél fel egy kérdést.",
					altEn: "Chat screenshot",
					altHu: "Chat képernyőkép",
					desktopAssetId: "standard-desktop",
					mobileAssetId: "standard-mobile",
					actionLabelEn: "Open chat",
					actionLabelHu: "Chat megnyitása",
				},
			],
			validationErrors: [
				{ path: "slides.1.actionUrl", message: "Action URL is required." },
			],
		});
		mockUpdateAdminCampaign.mockImplementation(async (_id, payload) => ({
			id: "campaign-1",
			type: payload.type ?? "first_run_onboarding",
			version: 3,
			name: payload.name ?? "Welcome tour",
			status: "draft",
			slides: payload.slides ?? [],
		}));
		mockDeleteAdminCampaignDraft.mockResolvedValue(undefined);
		mockArchiveAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			status: "archived",
		});
		mockPublishAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			status: "published",
			slides: [],
		});
		mockFetchAdminCampaignAsset.mockResolvedValue({
			id: "setup-desktop",
			assetKind: "crop",
			variant: "desktop",
			status: "draft",
			sourceAssetId: "setup-source",
			originalFilename: "welcome-desk.webp",
			mimeType: "image/webp",
			sizeBytes: 148 * 1024,
			width: 1600,
			height: 1000,
		});
		mockInvalidateAll.mockResolvedValue(undefined);
	});

	it("opens one slide at a time, chosen from the thumbnail rail", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		const thumbs = screen.getAllByTestId("admin-campaign-slide-thumb");
		expect(thumbs).toHaveLength(2);
		expect(
			screen.getByRole("heading", { name: "Slide 1" }),
		).toBeInTheDocument();
		expect(screen.getByDisplayValue("Set up AlfyAI")).toBeInTheDocument();
		expect(
			screen.queryByDisplayValue("Start chatting"),
		).not.toBeInTheDocument();

		await fireEvent.click(thumbs[1]);
		expect(
			screen.getByRole("heading", { name: "Slide 2" }),
		).toBeInTheDocument();
		expect(screen.getByDisplayValue("Start chatting")).toBeInTheDocument();
	});

	it("switches the open slide between English and Magyar with two pills", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		expect(screen.getByDisplayValue("Set up AlfyAI")).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "HU" }));
		expect(screen.getByDisplayValue("AlfyAI beállítása")).toBeInTheDocument();
		expect(screen.queryByDisplayValue("Set up AlfyAI")).not.toBeInTheDocument();
	});

	it("reorders slides from the slide ⋯ menu and saves the new payload", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		await openSlideMenu();
		await fireEvent.click(screen.getByRole("menuitem", { name: /Move down/ }));
		await fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

		await waitFor(() => {
			expect(mockUpdateAdminCampaign).toHaveBeenCalled();
		});

		const [, payload] = mockUpdateAdminCampaign.mock.calls[0];
		expect(payload).toEqual(
			expect.objectContaining({
				name: "Welcome tour",
				type: "first_run_onboarding",
				releaseVersion: "1.0.0",
			}),
		);
		expect(payload.slides.map((slide: { id?: string }) => slide.id)).toEqual([
			"slide-standard",
			"slide-setup",
		]);
		expect(payload.slides[0]).toEqual(
			expect.objectContaining({
				id: "slide-standard",
				kind: "standard",
				sortOrder: 1,
				semanticRole: "data_disclosure",
				titleEn: "Start chatting",
				titleHu: "Kezdj beszélgetni",
			}),
		);
		expect(payload.slides[1]).toEqual(
			expect.objectContaining({
				id: "slide-setup",
				kind: "setup",
				sortOrder: 2,
				semanticRole: "feature",
				setupControls: ["ui_language", "theme"],
			}),
		);
	});

	it("sets layout, purpose and setup controls from the slide options dialog", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		await openSlideMenu();
		await fireEvent.click(screen.getByRole("menuitem", { name: /Purpose/ }));

		const dialog = screen.getByRole("dialog");
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Data disclosure" }),
		);
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Close" }),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
		await waitFor(() => {
			expect(mockUpdateAdminCampaign).toHaveBeenCalled();
		});
		const [, payload] = mockUpdateAdminCampaign.mock.calls[0];
		expect(payload.slides[0].semanticRole).toBe("data_disclosure");
	});

	it("lets a slide clear setup controls it is no longer allowed to carry", async () => {
		// A release campaign whose slide still carries a first-run setup control:
		// the rule blocks publishing, and unchecking has to stay reachable.
		mockFetchAdminCampaigns.mockResolvedValue([
			{
				id: "campaign-1",
				type: "release_update",
				name: "Voice input beta",
				status: "draft",
				slideCount: 1,
			},
		]);
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			type: "release_update",
			name: "Voice input beta",
			releaseVersion: "2.3.0",
			status: "draft",
			slides: [
				{
					id: "slide-1",
					kind: "standard",
					sortOrder: 1,
					semanticRole: "feature",
					setupControls: ["theme"],
					titleEn: "Talk instead of typing",
					titleHu: "Beszélj gépelés helyett",
					bodyEn: "Speech is transcribed.",
					bodyHu: "A beszédet leírjuk.",
				},
			],
		});

		render(SettingsAdminCampaignsPane);
		await waitForEditor("Voice input beta");

		expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

		await openSlideMenu();
		await fireEvent.click(
			screen.getByRole("menuitem", { name: /Setup controls/ }),
		);

		const dialog = screen.getByRole("dialog");
		const theme = within(dialog).getByRole("checkbox", { name: "Theme" });
		expect(theme).toBeChecked();
		// The one that is set can be cleared; the ones that are not stay shut.
		expect(theme).not.toBeDisabled();
		expect(
			within(dialog).getByRole("checkbox", { name: "Interface language" }),
		).toBeDisabled();

		await fireEvent.click(theme);
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Close" }),
		);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Publish" }),
			).not.toBeDisabled();
		});
	});

	it("previews the mobile crop when the device toggle asks for it", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		// The preview <img> follows the toggle, not the browser viewport: the
		// admin column is narrow inside a wide window, which the modal's own
		// `<source media>` cannot see.
		const preview = screen.getByLabelText("Campaign preview and history");
		const image = () =>
			preview.querySelector("img.campaign-image") as HTMLImageElement | null;
		await waitFor(() => {
			expect(image()?.getAttribute("src")).toContain("setup-desktop");
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Phone preview" }),
		);
		await waitFor(() => {
			expect(image()?.getAttribute("src")).toContain("setup-mobile");
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Desktop preview" }),
		);
		await waitFor(() => {
			expect(image()?.getAttribute("src")).toContain("setup-desktop");
		});
	});

	it("offers Seed first-run on an install with no campaigns at all", async () => {
		// The ⋯ menu that normally carries it needs an open campaign, so a fresh
		// install — the one place that wants the template — had no way in.
		mockFetchAdminCampaigns.mockResolvedValue([]);
		const { seedFirstRunCampaign } = await import("$lib/client/api/campaigns");
		const mockSeed = seedFirstRunCampaign as ReturnType<typeof vi.fn>;
		mockSeed.mockResolvedValue({
			created: true,
			campaign: { id: "campaign-seeded" },
		});

		render(SettingsAdminCampaignsPane);

		const seedButton = await screen.findByRole("button", {
			name: /Seed first-run/,
		});
		expect(screen.queryByTestId("campaign-menu")).not.toBeInTheDocument();

		await fireEvent.click(seedButton);
		await waitFor(() => {
			expect(mockSeed).toHaveBeenCalled();
		});
	});

	it("shows the checklist as one line while every check passes", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		const checklist = screen.getByTestId("campaign-checklist");
		expect(within(checklist).getByText(/checks pass/)).toBeInTheDocument();
		expect(within(checklist).getByText("Ready to publish")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled();
	});

	it("opens the checklist on failure, names the slide, and blocks publish", async () => {
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			type: "first_run_onboarding",
			version: 3,
			name: "Welcome tour",
			status: "draft",
			slides: [
				{
					id: "slide-setup",
					kind: "setup",
					sortOrder: 1,
					semanticRole: "feature",
					titleEn: "Set up AlfyAI",
					titleHu: "AlfyAI beállítása",
					bodyEn: "Connect your tools.",
					bodyHu: "Kapcsold össze az eszközeidet.",
					altEn: "",
					altHu: "Beállítás képernyőkép",
					desktopAssetId: "setup-desktop",
				},
				{
					id: "slide-standard",
					kind: "standard",
					sortOrder: 2,
					semanticRole: "data_disclosure",
					titleEn: "Start chatting",
					titleHu: "Kezdj beszélgetni",
					bodyEn: "Ask a question.",
					bodyHu: "Tegyél fel egy kérdést.",
					altEn: "Chat screenshot",
					altHu: "Chat képernyőkép",
					desktopAssetId: "standard-desktop",
					mobileAssetId: "standard-mobile",
				},
			],
		});

		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		const checklist = screen.getByTestId("campaign-checklist");
		expect(within(checklist).getByText("1 check failing")).toBeInTheDocument();
		expect(within(checklist).getByText("English alt text")).toBeInTheDocument();
		expect(within(checklist).getByText("Slide 1")).toBeInTheDocument();

		const publishButton = screen.getByRole("button", { name: "Publish" });
		expect(publishButton).toBeDisabled();
		await fireEvent.click(publishButton);
		expect(mockPublishAdminCampaign).not.toHaveBeenCalled();
	});

	it('says the open slide has no setup controls instead of "— 0"', async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		// Slide 1 is the setup slide and carries two controls.
		await openSlideMenu();
		expect(
			screen.getByRole("menuitem", { name: /Setup controls — 2/ }),
		).toBeInTheDocument();
		await fireEvent.keyDown(window, { key: "Escape" });

		// Slide 2 has none, and the menu says so in words.
		await fireEvent.click(
			screen.getAllByTestId("admin-campaign-slide-thumb")[1],
		);
		await openSlideMenu();
		expect(
			screen.getByRole("menuitem", { name: /Setup controls — none/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: /Setup controls — 0/ }),
		).not.toBeInTheDocument();
	});

	it("falls back to the internal version when a release draft has no version string", async () => {
		mockFetchAdminCampaigns.mockResolvedValue([
			{
				id: "campaign-1",
				type: "release_update",
				version: 4,
				// A release draft created without a version yet: an empty string,
				// which is not nullish, so `??` would have left the row blank.
				releaseVersion: "",
				name: "Unversioned release",
				status: "draft",
				slideCount: 1,
			},
		]);

		render(SettingsAdminCampaignsPane);
		await waitFor(() => {
			expect(screen.getByTestId("admin-campaign-row")).toBeInTheDocument();
		});

		const row = screen.getByTestId("admin-campaign-row");
		// …and "1 slide", not "1 slides".
		expect(within(row).getByText("v4 · 1 slide")).toBeInTheDocument();
	});

	// A tour is a campaign of its own type whose release text is the kind it
	// introduces: the lines above the editor and in the rail say so in words,
	// never as "Release · canvas".
	describe("a tour campaign's meta line", () => {
		function tourSlides() {
			return ["summary", "standard", "standard", "standard"].map(
				(kind, index) => ({
					id: `tour-slide-${index + 1}`,
					kind,
					sortOrder: index + 1,
					semanticRole: "feature",
					titleEn: `Slide ${index + 1}`,
					titleHu: `${index + 1}. dia`,
					// The summary slide is one bare line, the empty state's: the seed
					// leaves its body empty and nothing asks for one.
					bodyEn: kind === "summary" ? "" : "Body.",
					bodyHu: kind === "summary" ? "" : "Szöveg.",
				}),
			);
		}

		function openTour(releaseVersion: string, name = "Canvas tour") {
			const summary = {
				id: "tour-1",
				type: "artifact_tour",
				version: 1,
				name,
				releaseVersion,
				status: "draft",
				slideCount: 4,
				updatedAt: "2026-05-17T08:00:00.000Z",
			};
			mockFetchAdminCampaigns.mockResolvedValue([summary]);
			mockFetchAdminCampaign.mockResolvedValue({
				...summary,
				slides: tourSlides(),
				validationErrors: [],
			});
			render(SettingsAdminCampaignsPane);
		}

		function editorMeta() {
			return document.querySelector(".editor-meta")?.textContent ?? "";
		}

		it("says Tour and the kind's word in the rail and above the editor, counting steps and not slides", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			expect(
				within(screen.getByTestId("admin-campaign-row")).getByText(
					"Tour · Canvas · 3 steps + empty-state line",
				),
			).toBeInTheDocument();
			expect(editorMeta()).toMatch(
				/^\s*Tour · Canvas · 3 steps \+ empty-state line · /,
			);
			expect(document.body.textContent).not.toContain("Release · canvas");
			expect(document.body.textContent).not.toContain("canvas · 4");
			expect(document.body.textContent).not.toContain("4 slides");
		});

		it("names each kind that ships by the word the rest of the interface uses", async () => {
			for (const [release, word] of [
				["document", "Document"],
				["app", "App"],
				["canvas", "Canvas"],
			] as const) {
				cleanup();
				openTour(release, `${word} tour`);
				await waitForEditor(`${word} tour`);
				expect(editorMeta()).toMatch(
					new RegExp(`^\\s*Tour · ${word} · 3 steps \\+ empty-state line`),
				);
			}
		});

		it("says it in Hungarian with the ratified Hungarian kind names", async () => {
			uiLanguage.set("hu");
			try {
				for (const [release, word] of [
					["document", "Dokumentum"],
					["app", "Alkalmazás"],
					["canvas", "Tábla"],
				] as const) {
					cleanup();
					openTour(release, `${word} bemutató`);
					await waitForEditor(`${word} bemutató`);
					expect(editorMeta()).toMatch(
						new RegExp(
							`^\\s*Bemutató · ${word} · 3 lépés \\+ üres állapot sora`,
						),
					);
				}
			} finally {
				uiLanguage.set("en");
			}
		});

		it("shows a release text that names no kind as it is, so the mistake can be read", async () => {
			openTour("2.1.0", "Typo tour");
			await waitForEditor("Typo tour");

			expect(editorMeta()).toMatch(/^\s*Tour · 2\.1\.0 · 3 steps/);
		});

		it("says one step in the singular", async () => {
			const summary = {
				id: "tour-1",
				type: "artifact_tour",
				version: 1,
				name: "Short tour",
				releaseVersion: "app",
				status: "draft",
				slideCount: 2,
			};
			mockFetchAdminCampaigns.mockResolvedValue([summary]);
			mockFetchAdminCampaign.mockResolvedValue({
				...summary,
				slides: tourSlides().slice(0, 2),
				validationErrors: [],
			});
			render(SettingsAdminCampaignsPane);
			await waitForEditor("Short tour");

			expect(editorMeta()).toMatch(
				/^\s*Tour · App · 1 step \+ empty-state line/,
			);
		});

		const SUMMARY_HINT =
			"The title is the line an empty Document, App or Canvas shows. Nothing else on this slide is shown.";

		// RC-T I-2: the summary slide's body is shown nowhere, so the editor does
		// not ask for one; it says what the title is instead.
		it("tells the summary slide what it is and has no body field for it", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			expect(screen.getByText(SUMMARY_HINT)).toBeInTheDocument();
			expect(
				screen.getByRole("heading", { name: "Empty-state line" }),
			).toBeInTheDocument();
			expect(screen.getByLabelText("Title")).toHaveValue("Slide 1");
			expect(screen.queryByLabelText("Body")).not.toBeInTheDocument();
		});

		it("says the same in Hungarian", async () => {
			uiLanguage.set("hu");
			try {
				openTour("canvas");
				await waitForEditor("Canvas tour");

				expect(
					screen.getByText(
						"A cím az a sor, amit egy üres dokumentum, alkalmazás vagy tábla mutat. Ezen a dián más nem jelenik meg.",
					),
				).toBeInTheDocument();
				expect(
					screen.getByRole("heading", { name: "Üres állapot sora" }),
				).toBeInTheDocument();
			} finally {
				uiLanguage.set("en");
			}
		});

		it("gives a step its title and body, numbers it as a reader does, and has no hint there", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			await fireEvent.click(
				screen.getAllByTestId("admin-campaign-slide-thumb")[1],
			);

			expect(
				screen.getByRole("heading", { name: "Step 1" }),
			).toBeInTheDocument();
			expect(screen.getByLabelText("Title")).toHaveValue("Slide 2");
			expect(screen.getByLabelText("Body")).toHaveValue("Body.");
			expect(screen.queryByText(SUMMARY_HINT)).not.toBeInTheDocument();
			// The region is named by what the slide is, as its heading says.
			expect(
				screen.getByRole("region", { name: "Step 1" }),
			).toBeInTheDocument();
		});

		it("offers no screenshot, alt text or button to any slide of a tour", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			const thumbs = screen.getAllByTestId("admin-campaign-slide-thumb");
			expect(thumbs).toHaveLength(4);
			for (const thumb of thumbs) {
				await fireEvent.click(thumb);
				expect(screen.queryByLabelText(/Alt text/)).not.toBeInTheDocument();
				expect(
					screen.queryByLabelText("Action destination"),
				).not.toBeInTheDocument();
				expect(screen.queryByLabelText("Action label")).not.toBeInTheDocument();
				expect(
					screen.queryByText("Desktop screenshot"),
				).not.toBeInTheDocument();
				expect(screen.queryByText("Mobile screenshot")).not.toBeInTheDocument();
			}
		});

		it("reads the rail as a reader meets the tour: the empty-state line, then steps 1 to 3, with no picture slots", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			const thumbs = screen.getAllByTestId("admin-campaign-slide-thumb");
			expect(within(thumbs[0]).getByText("Empty state")).toBeInTheDocument();
			expect(within(thumbs[1]).getByText("1")).toBeInTheDocument();
			expect(within(thumbs[2]).getByText("2")).toBeInTheDocument();
			expect(within(thumbs[3]).getByText("3")).toBeInTheDocument();
			expect(thumbs[0].querySelector(".thumb")).toBeNull();
		});

		it("keeps the first-run purpose and setup controls out of a tour's slide menu", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			await openSlideMenu();
			expect(
				screen.getByRole("menuitem", { name: /^Layout/ }),
			).toBeInTheDocument();
			expect(screen.queryByRole("menuitem", { name: /Purpose/ })).toBeNull();
			expect(
				screen.queryByRole("menuitem", { name: /Setup controls/ }),
			).toBeNull();
		});

		// RC-T Minor 3: the Summary layout means something only to a tour.
		it("offers the Summary layout to a tour, and not the first-run Setup one", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");
			await fireEvent.click(
				screen.getAllByTestId("admin-campaign-slide-thumb")[1],
			);

			await openSlideMenu();
			await fireEvent.click(screen.getByRole("menuitem", { name: /^Layout/ }));

			const dialog = screen.getByRole("dialog");
			expect(
				within(dialog).getByRole("button", { name: "Standard" }),
			).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", { name: "Summary" }),
			).toBeInTheDocument();
			expect(
				within(dialog).queryByRole("button", { name: "Setup" }),
			).toBeNull();
			expect(
				within(dialog).queryByRole("button", { name: "Feature" }),
			).toBeNull();
			expect(within(dialog).queryByText("Setup controls")).toBeNull();
		});

		it("does not offer the Summary layout to a release note or a first-run campaign", async () => {
			// The default fixture is a first-run campaign: setup and standard slides.
			render(SettingsAdminCampaignsPane);
			await waitForEditor();

			await openSlideMenu();
			await fireEvent.click(screen.getByRole("menuitem", { name: /^Layout/ }));

			const dialog = screen.getByRole("dialog");
			expect(
				within(dialog).getByRole("button", { name: "Setup" }),
			).toBeInTheDocument();
			expect(
				within(dialog).queryByRole("button", { name: "Summary" }),
			).toBeNull();
		});

		it("still shows the Summary layout on a release slide that already has it, so the state is never hidden", async () => {
			const summary = {
				id: "release-1",
				type: "release_update",
				version: 1,
				name: "Odd release",
				releaseVersion: "2.0.0",
				status: "draft",
				slideCount: 1,
			};
			mockFetchAdminCampaigns.mockResolvedValue([summary]);
			mockFetchAdminCampaign.mockResolvedValue({
				...summary,
				slides: [tourSlides()[0]],
				validationErrors: [],
			});
			render(SettingsAdminCampaignsPane);
			await waitForEditor("Odd release");

			await openSlideMenu();
			await fireEvent.click(screen.getByRole("menuitem", { name: /^Layout/ }));

			const dialog = screen.getByRole("dialog");
			expect(
				within(dialog).getByRole("button", { name: "Summary" }),
			).toBeInTheDocument();
		});

		// RC-T Minor 4: the preview of a tour is the card a reader meets, not the
		// announcement modal (logo, title, body, "1 / 4") with desktop and mobile.
		it("previews a tour as the reader's card, with no device toggle and no announcement", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			// The summary slide is open: the empty state's line.
			expect(await screen.findByTestId("tour-preview-line")).toHaveTextContent(
				"Slide 1",
			);

			await fireEvent.click(
				screen.getAllByTestId("admin-campaign-slide-thumb")[1],
			);

			expect(await screen.findByTestId("artifact-tour")).toBeInTheDocument();
			expect(screen.getByTestId("artifact-tour-title")).toHaveTextContent(
				"Slide 2",
			);
			expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
				"Step 1 of 3",
			);
			expect(screen.queryByRole("group", { name: "Preview size" })).toBeNull();
			expect(screen.queryByText("1 / 4")).toBeNull();
		});

		it("follows what the admin types into the open step", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");
			await fireEvent.click(
				screen.getAllByTestId("admin-campaign-slide-thumb")[1],
			);
			await screen.findByTestId("artifact-tour");

			await fireEvent.input(screen.getByLabelText("Title"), {
				target: { value: "A new first step" },
			});

			await waitFor(() =>
				expect(screen.getByTestId("artifact-tour-title")).toHaveTextContent(
					"A new first step",
				),
			);
		});

		it("still previews a release note as the announcement, with its device toggle", async () => {
			render(SettingsAdminCampaignsPane);
			await waitForEditor();

			expect(
				screen.getByRole("group", { name: "Preview size" }),
			).toBeInTheDocument();
			expect(screen.queryByTestId("tour-preview")).toBeNull();
		});

		// RC-T Minor 2: a tour's kind is its own; the details dialog said it was a
		// first-run or release campaign and let an admin click either.
		it("shows a tour's type in its details as a tour and lets nothing change it", async () => {
			openTour("canvas");
			await waitForEditor("Canvas tour");

			await fireEvent.click(
				screen.getByRole("button", { name: "Campaign details" }),
			);

			const dialog = screen.getByRole("dialog");
			expect(within(dialog).getByText("Tour · Canvas")).toBeInTheDocument();
			expect(
				within(dialog).queryByRole("button", { name: "First-run" }),
			).toBeNull();
			expect(
				within(dialog).queryByRole("button", { name: "Release" }),
			).toBeNull();
			expect(within(dialog).queryByLabelText("Release")).toBeNull();
			expect(within(dialog).getByLabelText("Name")).toHaveValue("Canvas tour");
		});

		it("saves a renamed tour as the same tour of the same kind", async () => {
			// The server answers with the whole campaign it saved.
			mockUpdateAdminCampaign.mockImplementation(async (id, payload) => ({
				id,
				type: payload.type,
				name: payload.name,
				releaseVersion: payload.releaseVersion,
				status: "draft",
				slides: payload.slides ?? [],
			}));
			openTour("canvas");
			await waitForEditor("Canvas tour");

			await fireEvent.click(
				screen.getByRole("button", { name: "Campaign details" }),
			);
			const dialog = screen.getByRole("dialog");
			await fireEvent.input(within(dialog).getByLabelText("Name"), {
				target: { value: "Canvas tour, second try" },
			});
			await fireEvent.click(
				within(dialog).getByRole("button", { name: "Save details" }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

			await waitFor(() => expect(mockUpdateAdminCampaign).toHaveBeenCalled());
			expect(mockUpdateAdminCampaign.mock.calls[0][1]).toEqual(
				expect.objectContaining({
					name: "Canvas tour, second try",
					type: "artifact_tour",
					releaseVersion: "canvas",
				}),
			);
			expect(editorMeta()).toMatch(/^\s*Tour · Canvas/);
		});

		it("still lets a first-run or release draft pick its type in its details", async () => {
			render(SettingsAdminCampaignsPane);
			await waitForEditor();

			await fireEvent.click(
				screen.getByRole("button", { name: "Campaign details" }),
			);

			const dialog = screen.getByRole("dialog");
			expect(
				within(dialog).getByRole("button", { name: "First-run" }),
			).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", { name: "Release" }),
			).toBeInTheDocument();
		});

		// RC-T Minor 4: a tour records nothing, so there is no performance to show.
		it("shows no performance card for a published tour, and still shows one for a published release note", async () => {
			const published = {
				id: "tour-1",
				type: "artifact_tour",
				version: 1,
				name: "Live tour",
				releaseVersion: "canvas",
				status: "published",
				slideCount: 4,
				analyticsSummary: {
					autoShown: 0,
					completed: 0,
					skipped: 0,
					replayOpened: 0,
				},
			};
			mockFetchAdminCampaigns.mockResolvedValue([published]);
			mockFetchAdminCampaign.mockResolvedValue({
				...published,
				slides: tourSlides(),
				validationErrors: [],
			});
			render(SettingsAdminCampaignsPane);
			await waitForEditor("Live tour");
			expect(screen.queryByTestId("campaign-performance")).toBeNull();

			cleanup();
			mockFetchAdminCampaigns.mockResolvedValue([
				{ ...published, type: "release_update", name: "Live release" },
			]);
			mockFetchAdminCampaign.mockResolvedValue({
				...published,
				type: "release_update",
				name: "Live release",
				releaseVersion: "2.0.0",
				slides: [{ ...tourSlides()[1], kind: "standard" }],
				validationErrors: [],
			});
			render(SettingsAdminCampaignsPane);
			await waitForEditor("Live release");
			expect(screen.getByTestId("campaign-performance")).toBeInTheDocument();
		});
	});

	// RC-T Minor 1: publishing a tour archives the revision it replaces, on the
	// server, so the rail has to be asked again to show what is live.
	describe("publishing a tour", () => {
		function tourSlides() {
			return ["summary", "standard", "standard", "standard"].map(
				(kind, index) => ({
					id: `tour-slide-${index + 1}`,
					kind,
					sortOrder: index + 1,
					semanticRole: "feature",
					titleEn: `Slide ${index + 1}`,
					titleHu: `${index + 1}. dia`,
					bodyEn: kind === "summary" ? "" : "Body.",
					bodyHu: kind === "summary" ? "" : "Szöveg.",
				}),
			);
		}

		it("publishes a tour whose summary slide has no body, and shows the older revision archived", async () => {
			const older = {
				id: "tour-old",
				type: "artifact_tour",
				version: 1,
				name: "Canvas tour",
				releaseVersion: "canvas",
				status: "published",
				slideCount: 4,
			};
			const draftTour = {
				...older,
				id: "tour-new",
				name: "Canvas tour copy",
				status: "draft",
			};
			mockFetchAdminCampaigns
				.mockResolvedValueOnce([draftTour, older])
				.mockResolvedValue([
					{ ...draftTour, status: "published" },
					{ ...older, status: "archived" },
				]);
			mockFetchAdminCampaign.mockResolvedValue({
				...draftTour,
				slides: tourSlides(),
				validationErrors: [],
			});
			mockUpdateAdminCampaign.mockResolvedValue({
				...draftTour,
				slides: tourSlides(),
			});
			mockPublishAdminCampaign.mockResolvedValue({
				...draftTour,
				status: "published",
				slides: tourSlides(),
			});
			render(SettingsAdminCampaignsPane);
			await waitForEditor("Canvas tour copy");

			const publish = screen.getByRole("button", { name: "Publish" });
			expect(publish).toBeEnabled();
			await fireEvent.click(publish);

			await waitFor(() => expect(mockPublishAdminCampaign).toHaveBeenCalled());
			const rows = await screen.findAllByTestId("admin-campaign-row");
			await waitFor(() => {
				expect(
					within(screen.getAllByTestId("admin-campaign-row")[1]).getByText(
						"Archived",
					),
				).toBeInTheDocument();
			});
			expect(rows).toHaveLength(2);
			expect(mockFetchAdminCampaigns).toHaveBeenCalledTimes(2);
		});

		it("does not ask for the list again after publishing a release note", async () => {
			mockPublishAdminCampaign.mockResolvedValue({
				id: "campaign-1",
				type: "release_update",
				status: "published",
				slides: [],
			});
			mockFetchAdminCampaign.mockResolvedValue({
				id: "campaign-1",
				type: "release_update",
				version: 3,
				name: "Release note",
				releaseVersion: "2.0.0",
				status: "draft",
				slides: [
					{
						id: "slide-1",
						kind: "standard",
						sortOrder: 1,
						semanticRole: "feature",
						titleEn: "News",
						titleHu: "Hír",
						bodyEn: "Details.",
						bodyHu: "Részletek.",
					},
				],
				validationErrors: [],
			});
			render(SettingsAdminCampaignsPane);
			await waitForEditor("Release note");

			await fireEvent.click(screen.getByRole("button", { name: "Publish" }));

			await waitFor(() => expect(mockPublishAdminCampaign).toHaveBeenCalled());
			expect(mockFetchAdminCampaigns).toHaveBeenCalledTimes(1);
		});
	});

	// RC-T Minor 8 (c, e): the seed says it makes drafts, and its answer counts
	// what it made in the admin's language, with one and with none.
	describe("seeding the tour drafts", () => {
		async function seedFromTheEmptyPane(result: {
			created: number;
			existing: number;
		}) {
			mockFetchAdminCampaigns.mockResolvedValue([]);
			mockSeedArtifactTours.mockResolvedValue(result);
			render(SettingsAdminCampaignsPane);
			await fireEvent.click(
				await screen.findByRole("button", {
					name:
						get(uiLanguage) === "hu"
							? "Bemutató-piszkozatok létrehozása"
							: "Seed tour drafts",
				}),
			);
		}

		it("says one draft in the singular", async () => {
			await seedFromTheEmptyPane({ created: 1, existing: 2 });
			expect(
				await screen.findByText("Created 1 tour draft."),
			).toBeInTheDocument();
		});

		it("says several drafts in the plural", async () => {
			await seedFromTheEmptyPane({ created: 3, existing: 0 });
			expect(
				await screen.findByText("Created 3 tour drafts."),
			).toBeInTheDocument();
		});

		it("says they already exist when it made none", async () => {
			await seedFromTheEmptyPane({ created: 0, existing: 3 });
			expect(
				await screen.findByText("The tour drafts already exist."),
			).toBeInTheDocument();
		});

		it("says it in Hungarian, on a button that names drafts", async () => {
			uiLanguage.set("hu");
			try {
				await seedFromTheEmptyPane({ created: 3, existing: 0 });
				expect(
					await screen.findByText("3 bemutató-piszkozat létrejött."),
				).toBeInTheDocument();
				cleanup();
				await seedFromTheEmptyPane({ created: 0, existing: 3 });
				expect(
					await screen.findByText("A bemutató-piszkozatok már léteznek."),
				).toBeInTheDocument();
			} finally {
				uiLanguage.set("en");
			}
		});
	});

	it("names the ⋯ menu when a first-run rule that lives there fails", async () => {
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			type: "first_run_onboarding",
			name: "Welcome tour",
			status: "draft",
			slides: [
				{
					id: "slide-setup",
					kind: "setup",
					sortOrder: 1,
					semanticRole: "feature",
					titleEn: "Set up AlfyAI",
					titleHu: "AlfyAI beállítása",
					bodyEn: "Connect your tools.",
					bodyHu: "Kapcsold össze az eszközeidet.",
				},
			],
		});

		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		const checklist = screen.getByTestId("campaign-checklist");
		expect(
			within(checklist).getByText("A data-disclosure slide"),
		).toBeInTheDocument();
		expect(
			within(checklist).getByText("in the slide ⋯ menu"),
		).toBeInTheDocument();

		// …and the menu entry that fixes it carries the attention dot.
		await openSlideMenu();
		const purposeItem = screen.getByRole("menuitem", { name: /Purpose/ });
		expect(purposeItem.querySelector("span[aria-hidden]")).not.toBeNull();
	});

	it("deletes a draft from the campaign menu even when it fails validation", async () => {
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			type: "release_update",
			name: "",
			releaseVersion: "",
			status: "draft",
			slides: [],
		});

		render(SettingsAdminCampaignsPane);
		await waitFor(() => {
			expect(screen.getByTestId("campaign-menu")).toBeInTheDocument();
		});

		expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

		await openCampaignMenu();
		await fireEvent.click(
			screen.getByRole("menuitem", { name: /Delete draft/ }),
		);
		await fireEvent.click(screen.getByTestId("confirm-delete"));

		await waitFor(() => {
			expect(mockDeleteAdminCampaignDraft).toHaveBeenCalledWith("campaign-1");
		});
		expect(mockArchiveAdminCampaign).not.toHaveBeenCalled();
	});

	it("archives a published campaign through a styled confirmation", async () => {
		mockFetchAdminCampaigns.mockResolvedValue([
			{
				id: "campaign-1",
				type: "release_update",
				name: "Voice input beta",
				status: "published",
			},
		]);
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			type: "release_update",
			name: "Voice input beta",
			releaseVersion: "2.3.0",
			status: "published",
			publishedAt: "2026-09-04T08:00:00.000Z",
			slides: [
				{
					id: "slide-1",
					layoutType: "standard",
					sortOrder: 1,
					title: {
						en: "Talk instead of typing",
						hu: "Beszélj gépelés helyett",
					},
					body: { en: "Speech is transcribed.", hu: "A beszédet leírjuk." },
					altText: { en: "Composer", hu: "Szerkesztő" },
				},
			],
		});

		render(SettingsAdminCampaignsPane);
		await waitForEditor("Voice input beta");

		await openCampaignMenu();
		await fireEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
		await fireEvent.click(screen.getByTestId("confirm-delete"));

		await waitFor(() => {
			expect(mockArchiveAdminCampaign).toHaveBeenCalledWith("campaign-1");
		});
	});

	it("keeps published campaigns read-only, says why, and offers a duplicate", async () => {
		mockFetchAdminCampaigns.mockResolvedValue([
			{
				id: "campaign-1",
				type: "first_run_onboarding",
				name: "Welcome tour",
				status: "published",
				updatedAt: "2026-05-17T08:00:00.000Z",
			},
		]);
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-1",
			type: "first_run_onboarding",
			name: "Welcome tour",
			status: "published",
			analyticsSummary: {
				autoShown: 412,
				completed: 293,
				skipped: 119,
				replayOpened: 12,
				completionRate: 0.71,
			},
			slides: [
				{
					id: "slide-setup",
					layoutType: "setup",
					sortOrder: 1,
					title: { en: "Set up AlfyAI", hu: "AlfyAI beállítása" },
					body: {
						en: "Connect your tools.",
						hu: "Kapcsold össze az eszközeidet.",
					},
					altText: { en: "Setup", hu: "Beállítás" },
				},
			],
		});

		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		expect(
			screen.getByText(
				"Published slides can't change. Duplicate as draft to edit.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Save draft" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Duplicate as draft/ }),
		).not.toBeDisabled();
		expect(screen.getByDisplayValue("Set up AlfyAI")).toBeDisabled();

		// Analytics appear once, as the performance card.
		const performance = screen.getByTestId("campaign-performance");
		expect(within(performance).getByText("71%")).toBeInTheDocument();
		expect(within(performance).getByText("412")).toBeInTheDocument();
		expect(within(performance).getByText("293")).toBeInTheDocument();
		expect(within(performance).getByText("119")).toBeInTheDocument();
		expect(within(performance).getByText("12")).toBeInTheDocument();
	});

	it("opens the crop modal immediately while the screenshot source upload is still pending", async () => {
		mockUploadCampaignAssetSource.mockReturnValue(new Promise(() => {}));
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		const mobileBlock = screen.getByTestId("campaign-asset-mobile");
		const uploadInput = mobileBlock.querySelector(
			'input[type="file"]',
		) as HTMLInputElement | null;
		expect(uploadInput).toBeTruthy();
		if (!uploadInput) throw new Error("Expected upload input");

		await fireEvent.change(uploadInput, {
			target: {
				files: [
					new File(["fake image bytes"], "mobile.png", { type: "image/png" }),
				],
			},
		});

		expect(mockUploadCampaignAssetSource).toHaveBeenCalled();
		expect(
			screen.getByRole("dialog", { name: "Crop campaign screenshot" }),
		).toBeInTheDocument();
	});

	it("names the attached screenshot and can detach it", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		const desktopBlock = screen.getByTestId("campaign-asset-desktop");
		await waitFor(() => {
			expect(
				within(desktopBlock).getByText(/welcome-desk\.webp/),
			).toBeInTheDocument();
		});

		await fireEvent.click(
			within(desktopBlock).getByRole("button", { name: "Remove" }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

		await waitFor(() => {
			expect(mockUpdateAdminCampaign).toHaveBeenCalled();
		});
		const [, payload] = mockUpdateAdminCampaign.mock.calls[0];
		expect(payload.slides[0].desktopAssetId).toBeNull();
	});

	it("re-crops an attached screenshot from its original upload", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		const desktopBlock = screen.getByTestId("campaign-asset-desktop");
		const recrop = within(desktopBlock).getByRole("button", {
			name: /Re-crop/,
		});
		await waitFor(() => {
			expect(recrop).not.toBeDisabled();
		});
		await fireEvent.click(recrop);

		// No new upload: the crop dialog reopens on the stored source asset.
		expect(mockUploadCampaignAssetSource).not.toHaveBeenCalled();
		expect(
			screen.getByRole("dialog", { name: "Crop campaign screenshot" }),
		).toBeInTheDocument();
	});

	it("saves current draft edits before publishing the campaign", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		await fireEvent.input(screen.getByDisplayValue("Set up AlfyAI"), {
			target: { value: "Set up your workspace" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		await waitFor(() => {
			expect(mockPublishAdminCampaign).toHaveBeenCalledWith("campaign-1");
		});
		const [, payload] = mockUpdateAdminCampaign.mock.calls[0];
		expect(payload.slides[0].titleEn).toBe("Set up your workspace");
		expect(mockUpdateAdminCampaign.mock.invocationCallOrder[0]).toBeLessThan(
			mockPublishAdminCampaign.mock.invocationCallOrder[0],
		);
	});

	it("shows publish validation field errors returned by the server", async () => {
		mockPublishAdminCampaign.mockRejectedValue(
			new ApiError("Campaign is not ready to publish.", {
				status: 400,
				fieldErrors: {
					"slides.slide-standard.altText.en":
						"Localized EN/HU alt text is required when an image is uploaded.",
				},
			}),
		);
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		await waitFor(() => {
			expect(
				screen.getByText(
					"Localized EN/HU alt text is required when an image is uploaded.",
				),
			).toBeInTheDocument();
		});
		expect(
			screen.getByText("Campaign is not ready to publish."),
		).toBeInTheDocument();
	});

	it("shows the server's own validation issues on a locally valid draft", async () => {
		render(SettingsAdminCampaignsPane);
		await waitForEditor();

		expect(screen.getByText("Action URL is required.")).toBeInTheDocument();
	});

	it("refreshes layout data after publishing a release campaign", async () => {
		mockFetchAdminCampaigns.mockResolvedValue([
			{
				id: "campaign-release",
				type: "release_update",
				version: 1,
				name: "AlfyAI 1.0",
				status: "draft",
				slideCount: 1,
			},
		]);
		mockFetchAdminCampaign.mockResolvedValue({
			id: "campaign-release",
			type: "release_update",
			version: 1,
			name: "AlfyAI 1.0",
			releaseVersion: "1.0.0",
			status: "draft",
			slides: [
				{
					id: "release-slide",
					kind: "standard",
					sortOrder: 1,
					semanticRole: "feature",
					titleEn: "AlfyAI 1.0",
					titleHu: "AlfyAI 1.0",
					bodyEn: "Production release.",
					bodyHu: "Production kiadás.",
					altEn: "Release screenshot",
					altHu: "Kiadási képernyőkép",
					desktopAssetId: "release-desktop",
					mobileAssetId: "release-mobile",
				},
			],
			validationErrors: [],
		});
		mockUpdateAdminCampaign.mockResolvedValue({
			id: "campaign-release",
			type: "release_update",
			status: "draft",
			releaseVersion: "1.0.0",
			slides: [],
		});
		mockPublishAdminCampaign.mockResolvedValue({
			id: "campaign-release",
			type: "release_update",
			status: "published",
			releaseVersion: "1.0.0",
			slides: [],
		});

		render(SettingsAdminCampaignsPane);
		await waitForEditor("AlfyAI 1.0");

		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		await waitFor(() => {
			expect(mockInvalidateAll).toHaveBeenCalledTimes(1);
		});
	});
});
