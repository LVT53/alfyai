import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
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
	uploadCampaignAssetSource: vi.fn(),
	saveCampaignAssetCrop: vi.fn(),
}));

import { invalidateAll } from "$app/navigation";
import { uploadCampaignAssetSource } from "$lib/client/api/campaign-assets";
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
const mockInvalidateAll = invalidateAll as ReturnType<typeof vi.fn>;

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
		mockInvalidateAll.mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);
	});

	it("lets admins reorder localized campaign slides and save the draft payload", async () => {
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

		await fireEvent.click(
			screen.getByRole("button", { name: /Move Set up AlfyAI down/ }),
		);
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
				titleEn: "Set up AlfyAI",
				titleHu: "AlfyAI beállítása",
			}),
		);
		expect(screen.getByText("Action URL is required.")).toBeInTheDocument();
	});

	it("deletes draft campaigns through the draft DELETE route instead of archiving them", async () => {
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));

		await waitFor(() => {
			expect(mockDeleteAdminCampaignDraft).toHaveBeenCalledWith("campaign-1");
		});
		expect(mockArchiveAdminCampaign).not.toHaveBeenCalled();
	});

	it("renders campaign analytics from the service summary fields", async () => {
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

		expect(screen.getByText("7 / 3 / 1 / 2")).toBeInTheDocument();
	});

	it("keeps published campaign snapshots read-only and disables save/publish controls", async () => {
		mockFetchAdminCampaigns.mockResolvedValueOnce([
			{
				id: "campaign-1",
				type: "first_run_onboarding",
				name: "Welcome tour",
				status: "published",
				updatedAt: "2026-05-17T08:00:00.000Z",
			},
		]);
		mockFetchAdminCampaign.mockResolvedValueOnce({
			id: "campaign-1",
			type: "first_run_onboarding",
			name: "Welcome tour",
			status: "published",
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

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

		expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
		expect(screen.getByLabelText("Name")).toBeDisabled();

		await fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
		expect(mockUpdateAdminCampaign).not.toHaveBeenCalled();
	});

	it("opens the crop modal immediately while the screenshot source upload is still pending", async () => {
		mockUploadCampaignAssetSource.mockReturnValue(new Promise(() => {}));
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

		const uploadLabel = screen
			.getAllByText("Upload mobile crop")[0]
			.closest("label");
		const uploadInput = uploadLabel?.querySelector(
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

	it("saves current draft edits before publishing the campaign", async () => {
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

		await fireEvent.input(screen.getByLabelText("Name"), {
			target: { value: "Updated welcome tour" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		await waitFor(() => {
			expect(mockPublishAdminCampaign).toHaveBeenCalledWith("campaign-1");
		});
		expect(mockUpdateAdminCampaign).toHaveBeenCalledWith(
			"campaign-1",
			expect.objectContaining({ name: "Updated welcome tour" }),
		);
		expect(mockUpdateAdminCampaign.mock.invocationCallOrder[0]).toBeLessThan(
			mockPublishAdminCampaign.mock.invocationCallOrder[0],
		);
	});

	it("shows publish validation field errors in the checklist", async () => {
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

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

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

	it("blocks publish locally when uploaded images are missing alt text", async () => {
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
					setupControls: ["ui_language", "theme"],
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

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Welcome tour/ }),
			).toBeInTheDocument();
		});

		const publishButton = screen.getByRole("button", { name: "Publish" });
		expect(publishButton).toBeDisabled();
		expect(
			screen.getByText(
				"Localized EN/HU alt text is required when an image is uploaded.",
			),
		).toBeInTheDocument();

		await fireEvent.click(publishButton);
		expect(mockPublishAdminCampaign).not.toHaveBeenCalled();
	});

	it("refreshes layout data after publishing a release campaign so the sidebar version can update", async () => {
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
		});
		mockPublishAdminCampaign.mockResolvedValue({
			id: "campaign-release",
			type: "release_update",
			status: "published",
			releaseVersion: "1.0.0",
			slides: [],
		});

		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(screen.getAllByText("AlfyAI 1.0").length).toBeGreaterThan(0);
		});

		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		await waitFor(() => {
			expect(mockInvalidateAll).toHaveBeenCalledTimes(1);
		});
	});
});
