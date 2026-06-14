import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/deep-research", () => ({
	approveDeepResearchPlan: vi.fn(),
	isDeepResearchPlanActionError: vi.fn((error) => Boolean(error?.status)),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { approveDeepResearchPlan } from "$lib/server/services/deep-research";
import { POST } from "./+server";

type ApproveRouteEvent = Parameters<typeof POST>[0];

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockApproveDeepResearchPlan = approveDeepResearchPlan as ReturnType<
	typeof vi.fn
>;

function makeEvent(
	jobId = "research-job-1",
	user = { id: "user-1", email: "test@example.com" },
) {
	return {
		request: new Request(
			`http://localhost/api/deep-research/jobs/${jobId}/plan/approve`,
			{
				method: "POST",
			},
		),
		locals: { user },
		params: { id: jobId },
		url: new URL(
			`http://localhost/api/deep-research/jobs/${jobId}/plan/approve`,
		),
		route: { id: "/api/deep-research/jobs/[id]/plan/approve" },
	} as ApproveRouteEvent;
}

describe("POST /api/deep-research/jobs/[id]/plan/approve", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockApproveDeepResearchPlan.mockResolvedValue({
			id: "research-job-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			depth: "standard",
			status: "approved",
			stage: "plan_approved",
			title: "Research AI copyright rules",
			currentPlan: {
				version: 2,
				status: "approved",
				renderedPlan: "# Research Plan",
				effortEstimate: {
					selectedDepth: "standard",
					expectedTimeBand: "30-60 minutes",
					sourceReviewCeiling: 40,
					relativeCostWarning: "Moderate relative cost.",
				},
			},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});

	it("approves the current Research Plan for the signed-in user", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.job).toMatchObject({
			id: "research-job-1",
			status: "approved",
			stage: "plan_approved",
			currentPlan: { version: 2, status: "approved" },
		});
		expect(mockApproveDeepResearchPlan).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "research-job-1",
		});
	});
});
