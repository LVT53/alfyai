import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/announcement-campaigns", () => {
	class AnnouncementCampaignValidationError extends Error {
		constructor(
			message: string,
			public readonly fieldErrors: Record<string, string>,
			public readonly status = 400,
		) {
			super(message);
		}
	}
	return {
		AnnouncementCampaignValidationError,
		createCampaignDraft: vi.fn(),
		listCampaigns: vi.fn(),
		publishCampaign: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	AnnouncementCampaignValidationError,
	createCampaignDraft,
	listCampaigns,
	publishCampaign,
} from "$lib/server/services/announcement-campaigns";
import { GET, POST } from "./+server";
import { POST as PUBLISH } from "./[id]/publish/+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockListCampaigns = listCampaigns as ReturnType<typeof vi.fn>;
const mockCreateCampaignDraft = createCampaignDraft as ReturnType<typeof vi.fn>;
const mockPublishCampaign = publishCampaign as ReturnType<typeof vi.fn>;

function makeEvent(body: unknown = {}, params: Record<string, string> = {}) {
	return {
		request: {
			json: vi.fn().mockResolvedValue(body),
			headers: { get: vi.fn().mockReturnValue(null) },
		},
		locals: { user: { id: "admin-user", role: "admin" } },
		params,
		url: new URL("http://localhost/api/admin/campaigns"),
		route: { id: "/api/admin/campaigns" },
	} as unknown as Parameters<typeof POST>[0];
}

describe("admin announcement campaign routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
	});

	it("lists campaigns behind admin authorization", async () => {
		mockListCampaigns.mockResolvedValue([
			{ id: "campaign-1", status: "draft" },
		]);

		const response = await GET(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			campaigns: [{ id: "campaign-1", status: "draft" }],
		});
		expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
	});

	it("creates a system-identified draft campaign for the current admin", async () => {
		mockCreateCampaignDraft.mockResolvedValue({
			id: "campaign-1",
			identityKey: "release_update:0.2.0:r1",
			status: "draft",
		});

		const response = await POST(
			makeEvent({
				type: "release_update",
				releaseVersion: "0.2.0",
				name: "Release update",
				identityKey: "malicious-admin-key",
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.campaign.identityKey).toBe("release_update:0.2.0:r1");
		expect(mockCreateCampaignDraft).toHaveBeenCalledWith({
			type: "release_update",
			releaseVersion: "0.2.0",
			name: "Release update",
			createdByUserId: "admin-user",
		});
	});

	it("maps publish validation errors to field-error JSON", async () => {
		mockPublishCampaign.mockRejectedValue(
			new AnnouncementCampaignValidationError(
				"Campaign is not ready to publish.",
				{
					slides: "At least one slide is required.",
				},
			),
		);

		const response = await PUBLISH(makeEvent({}, { id: "campaign-1" }));
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body).toEqual({
			error: "Campaign is not ready to publish.",
			fieldErrors: { slides: "At least one slide is required." },
		});
		expect(mockPublishCampaign).toHaveBeenCalledWith(
			"campaign-1",
			"admin-user",
		);
	});
});
