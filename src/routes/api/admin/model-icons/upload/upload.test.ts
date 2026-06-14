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
	storeModelIconAsset: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { storeModelIconAsset } from "$lib/server/services/campaign-assets";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockStoreModelIconAsset = storeModelIconAsset as ReturnType<typeof vi.fn>;
type ModelIconUploadEvent = Parameters<typeof POST>[0];

function makeUploadEvent(
	formData: FormData,
	user = { id: "admin-user", role: "admin" },
): ModelIconUploadEvent {
	return {
		request: {
			formData: vi.fn().mockResolvedValue(formData),
			headers: {
				get: vi.fn().mockReturnValue(null),
			},
		},
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/admin/model-icons/upload"),
		route: { id: "/api/admin/model-icons/upload" },
	} as ModelIconUploadEvent;
}

describe("POST /api/admin/model-icons/upload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockStoreModelIconAsset.mockResolvedValue({
			id: "icon-1",
			assetKind: "model_icon",
			status: "published",
			storagePath: "model-icons/icon-1.png",
			mimeType: "image/png",
			sizeBytes: 9,
		});
	});

	it("requires admin access and stores an uploaded model icon", async () => {
		const formData = new FormData();
		formData.set(
			"image",
			new File([Buffer.from("png-bytes")], "icon.png", { type: "image/png" }),
		);
		formData.set("width", "512");
		formData.set("height", "512");

		const response = await POST(makeUploadEvent(formData));
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.asset).toMatchObject({
			id: "icon-1",
			assetKind: "model_icon",
			status: "published",
		});
		expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
		expect(mockStoreModelIconAsset).toHaveBeenCalledWith({
			uploadedByUserId: "admin-user",
			file: {
				filename: "icon.png",
				mimeType: "image/png",
				content: expect.any(Buffer),
			},
			dimensions: { width: 512, height: 512 },
		});
	});

	it("accepts SVG model icons without raster dimensions", async () => {
		const formData = new FormData();
		formData.set(
			"image",
			new File([Buffer.from("<svg></svg>")], "icon.svg", {
				type: "image/svg+xml",
			}),
		);

		const response = await POST(makeUploadEvent(formData));

		expect(response.status).toBe(201);
		expect(mockStoreModelIconAsset).toHaveBeenCalledWith({
			uploadedByUserId: "admin-user",
			file: {
				filename: "icon.svg",
				mimeType: "image/svg+xml",
				content: expect.any(Buffer),
			},
			dimensions: undefined,
		});
	});

	it("returns field errors when the image field is missing", async () => {
		const response = await POST(makeUploadEvent(new FormData()));
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.fieldErrors).toEqual({
			image: "Model icon image is required.",
		});
		expect(mockStoreModelIconAsset).not.toHaveBeenCalled();
	});
});
