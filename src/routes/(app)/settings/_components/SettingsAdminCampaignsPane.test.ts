import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
