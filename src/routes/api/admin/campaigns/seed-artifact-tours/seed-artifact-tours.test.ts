import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/artifact-tours", () => ({
	seedArtifactTourDrafts: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { AnnouncementCampaignValidationError } from "$lib/server/services/announcement-campaigns";
import { seedArtifactTourDrafts } from "$lib/server/services/artifact-tours";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockSeedArtifactTourDrafts = seedArtifactTourDrafts as ReturnType<
	typeof vi.fn
>;

function makeEvent(uiLanguage: "en" | "hu" = "en") {
	return {
		locals: { user: { id: "admin-user", role: "admin", uiLanguage } },
	} as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/admin/campaigns/seed-artifact-tours", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
	});

	it("seeds the three tour drafts and reports the counts", async () => {
		mockSeedArtifactTourDrafts.mockResolvedValue({ created: 3, existing: 0 });

		const response = await POST(makeEvent());

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ created: 3, existing: 0 });
		expect(mockSeedArtifactTourDrafts).toHaveBeenCalledWith("admin-user", {
			language: "en",
		});
	});

	it("names the drafts in the language of the admin who seeds them", async () => {
		mockSeedArtifactTourDrafts.mockResolvedValue({ created: 3, existing: 0 });

		await POST(makeEvent("hu"));

		expect(mockSeedArtifactTourDrafts).toHaveBeenCalledWith("admin-user", {
			language: "hu",
		});
	});

	it("is a no-op with 200 on a second run", async () => {
		mockSeedArtifactTourDrafts.mockResolvedValue({ created: 0, existing: 3 });

		const response = await POST(makeEvent());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ created: 0, existing: 3 });
	});

	it("maps a validation failure to the campaign error response shape", async () => {
		mockSeedArtifactTourDrafts.mockRejectedValue(
			new AnnouncementCampaignValidationError(
				"Campaign is not ready to publish.",
				{
					tourSlideShape: "bad shape",
				},
			),
		);

		const response = await POST(makeEvent());

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Campaign is not ready to publish.",
			fieldErrors: { tourSlideShape: "bad shape" },
		});
	});

	it("answers 500 with a non-artifact-worded fallback on an unexpected failure", async () => {
		mockSeedArtifactTourDrafts.mockRejectedValue(new Error("boom"));

		const response = await POST(makeEvent());

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body.error).toBe("Failed to seed the tour drafts.");
	});
});
