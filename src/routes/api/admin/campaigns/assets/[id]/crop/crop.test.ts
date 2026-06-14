import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/campaign-assets", () => ({
	CampaignAssetValidationError: class CampaignAssetValidationError extends Error {
		constructor(
			message: string,
			public readonly fieldErrors: Record<string, string>,
		) {
			super(message);
		}
	},
	saveCampaignCropAsset: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { saveCampaignCropAsset } from "$lib/server/services/campaign-assets";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockSaveCampaignCropAsset = saveCampaignCropAsset as ReturnType<
	typeof vi.fn
>;

function makeCropEvent(formData: FormData, sourceAssetId = "source-1") {
	return {
		request: {
			formData: vi.fn().mockResolvedValue(formData),
			headers: {
				get: vi.fn().mockReturnValue(null),
			},
		},
		locals: { user: { id: "admin-user", role: "admin" } },
		params: { id: sourceAssetId },
		url: new URL(
			`http://localhost/api/admin/campaigns/assets/${sourceAssetId}/crop`,
		),
		route: { id: "/api/admin/campaigns/assets/[id]/crop" },
	} as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/admin/campaigns/assets/[id]/crop", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockSaveCampaignCropAsset.mockResolvedValue({
			id: "crop-1",
			assetKind: "crop",
			variant: "desktop",
			status: "draft",
		});
	});

	it("stores a fixed-ratio crop for an uploaded campaign source asset", async () => {
		const formData = new FormData();
		formData.set(
			"image",
			new File(["crop-bytes"], "desktop.webp", { type: "image/webp" }),
		);
		formData.set("variant", "desktop");
		formData.set("width", "1600");
		formData.set("height", "1000");
		formData.set(
			"crop",
			JSON.stringify({ x: 120, y: 80, width: 960, height: 600, zoom: 1.5 }),
		);

		const response = await POST(makeCropEvent(formData));
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.asset).toMatchObject({
			id: "crop-1",
			assetKind: "crop",
			variant: "desktop",
		});
		expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
		expect(mockSaveCampaignCropAsset).toHaveBeenCalledWith({
			uploadedByUserId: "admin-user",
			sourceAssetId: "source-1",
			variant: "desktop",
			file: {
				filename: "desktop.webp",
				mimeType: "image/webp",
				content: expect.any(Buffer),
			},
			dimensions: { width: 1600, height: 1000 },
			crop: { x: 120, y: 80, width: 960, height: 600, zoom: 1.5 },
		});
	});

	it("returns field errors for missing crop geometry", async () => {
		const formData = new FormData();
		formData.set(
			"image",
			new File(["crop-bytes"], "desktop.webp", { type: "image/webp" }),
		);
		formData.set("variant", "desktop");

		const response = await POST(makeCropEvent(formData));
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.fieldErrors).toEqual({ crop: "Crop geometry is required." });
		expect(mockSaveCampaignCropAsset).not.toHaveBeenCalled();
	});
});
