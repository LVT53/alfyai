import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
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
		completeCampaignForUser: vi.fn(),
		getEligibleCampaignForUser: vi.fn(),
		getLatestPublishedCampaign: vi.fn(),
		recordCampaignEvent: vi.fn(),
	};
});

import { requireAuth } from "$lib/server/auth/hooks";
import {
	completeCampaignForUser,
	getEligibleCampaignForUser,
	getLatestPublishedCampaign,
	recordCampaignEvent,
} from "$lib/server/services/announcement-campaigns";
import { POST as COMPLETE } from "./[id]/complete/+server";
import { POST as EVENT } from "./[id]/events/+server";
import { GET as ELIGIBLE } from "./eligible/+server";
import { GET as LATEST } from "./latest/+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetEligibleCampaignForUser = getEligibleCampaignForUser as ReturnType<
	typeof vi.fn
>;
const mockGetLatestPublishedCampaign = getLatestPublishedCampaign as ReturnType<
	typeof vi.fn
>;
const mockRecordCampaignEvent = recordCampaignEvent as ReturnType<typeof vi.fn>;
const mockCompleteCampaignForUser = completeCampaignForUser as ReturnType<
	typeof vi.fn
>;

function makeEvent(body: unknown = {}, params: Record<string, string> = {}) {
	return {
		request: {
			json: vi.fn().mockResolvedValue(body),
			headers: { get: vi.fn().mockReturnValue(null) },
		},
		locals: { user: { id: "viewer-user", role: "user" } },
		params,
		url: new URL("http://localhost/api/campaigns"),
		route: { id: "/api/campaigns" },
	} as unknown as Parameters<typeof ELIGIBLE>[0];
}

describe("user announcement campaign routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns the single eligible campaign for the current user", async () => {
		mockGetEligibleCampaignForUser.mockResolvedValue({
			id: "campaign-1",
			type: "first_run_onboarding",
		});

		const response = await ELIGIBLE(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			campaign: { id: "campaign-1", type: "first_run_onboarding" },
		});
		expect(mockGetEligibleCampaignForUser).toHaveBeenCalledWith("viewer-user");
	});

	it("returns the latest published campaign for replay without checking completion state", async () => {
		mockGetLatestPublishedCampaign.mockResolvedValue({
			id: "campaign-2",
			type: "release_update",
		});

		const response = await LATEST(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			campaign: { id: "campaign-2", type: "release_update" },
		});
		expect(mockGetLatestPublishedCampaign).toHaveBeenCalledTimes(1);
	});

	it("records campaign events for the current user", async () => {
		mockRecordCampaignEvent.mockResolvedValue({
			id: "event-1",
			eventType: "slide_viewed",
		});

		const response = await EVENT(
			makeEvent(
				{
					eventType: "slide_viewed",
					slideId: "slide-1",
					metadata: { preference: "theme" },
				},
				{ id: "campaign-1" },
			),
		);
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.event).toEqual({ id: "event-1", eventType: "slide_viewed" });
		expect(mockRecordCampaignEvent).toHaveBeenCalledWith({
			campaignId: "campaign-1",
			userId: "viewer-user",
			eventType: "slide_viewed",
			slideId: "slide-1",
			metadata: { preference: "theme" },
		});
	});

	it("marks a campaign completed or skipped and rejects invalid reasons", async () => {
		mockCompleteCampaignForUser.mockResolvedValue({
			id: "state-1",
			status: "completed",
		});

		const response = await COMPLETE(
			makeEvent({ reason: "completed" }, { id: "campaign-1" }),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.state).toEqual({ id: "state-1", status: "completed" });
		expect(mockCompleteCampaignForUser).toHaveBeenCalledWith(
			"campaign-1",
			"viewer-user",
			"completed",
		);

		const invalid = await COMPLETE(
			makeEvent({ reason: "later" }, { id: "campaign-1" }),
		);
		expect(invalid.status).toBe(400);
	});
});
