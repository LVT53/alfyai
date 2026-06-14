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
	saveModelIconAsset: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { saveModelIconAsset } from "$lib/server/services/campaign-assets";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockSaveModelIconAsset = saveModelIconAsset as ReturnType<typeof vi.fn>;
type ModelIconCropEvent = Parameters<typeof POST>[0];

function makeCropEvent(
	formData: FormData,
	sourceAssetId = "source-1",
	user = { id: "admin-user", role: "admin" },
): ModelIconCropEvent {
	return {
		request: {
			formData: vi.fn().mockResolvedValue(formData),
			headers: {
				get: vi.fn().mockReturnValue(null),
			},
		},
		locals: { user },
		params: { id: sourceAssetId },
		url: new URL(
			`http://localhost/api/admin/model-icons/${sourceAssetId}/crop`,
		),
		route: { id: "/api/admin/model-icons/[id]/crop" },
	} as ModelIconCropEvent;
}

describe("POST /api/admin/model-icons/[id]/crop", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockSaveModelIconAsset.mockResolvedValue({
			id: "icon-1",
			assetKind: "model_icon",
			status: "published",
			storagePath: "model-icons/icon-1.webp",
			mimeType: "image/webp",
			sizeBytes: 9,
		});
	});

	it("stores a square model icon crop from an uploaded source asset", async () => {
		const formData = new FormData();
		formData.set(
			"image",
			new File(["crop-bytes"], "model-icon.webp", { type: "image/webp" }),
		);
		formData.set("width", "512");
		formData.set("height", "512");
		formData.set(
			"crop",
			JSON.stringify({ x: 120, y: 0, width: 600, height: 600, zoom: 1.4 }),
		);

		const response = await POST(makeCropEvent(formData));
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.asset).toMatchObject({
			id: "icon-1",
			assetKind: "model_icon",
			status: "published",
		});
		expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
		expect(mockSaveModelIconAsset).toHaveBeenCalledWith({
			uploadedByUserId: "admin-user",
			sourceAssetId: "source-1",
			file: {
				filename: "model-icon.webp",
				mimeType: "image/webp",
				content: expect.any(Buffer),
			},
			dimensions: { width: 512, height: 512 },
			crop: { x: 120, y: 0, width: 600, height: 600, zoom: 1.4 },
		});
	});

	it("returns field errors for missing crop geometry", async () => {
		const formData = new FormData();
		formData.set(
			"image",
			new File(["crop-bytes"], "model-icon.webp", { type: "image/webp" }),
		);

		const response = await POST(makeCropEvent(formData));
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.fieldErrors).toEqual({ crop: "Crop geometry is required." });
		expect(mockSaveModelIconAsset).not.toHaveBeenCalled();
	});
});
