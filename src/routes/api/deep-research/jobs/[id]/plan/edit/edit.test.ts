import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/deep-research", () => ({
	editDeepResearchPlan: vi.fn(),
	isDeepResearchPlanActionError: vi.fn((error) => Boolean(error?.status)),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	editDeepResearchPlan,
	isDeepResearchPlanActionError,
} from "$lib/server/services/deep-research";
import { POST } from "./+server";

type EditRouteEvent = Parameters<typeof POST>[0];

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockEditDeepResearchPlan = editDeepResearchPlan as ReturnType<
	typeof vi.fn
>;
const mockIsDeepResearchPlanActionError =
	isDeepResearchPlanActionError as ReturnType<typeof vi.fn>;

function makeEvent(
	body: unknown = {
		editInstruction: "Focus more on startup compliance risks.",
	},
	jobId = "research-job-1",
	user = { id: "user-1", email: "test@example.com" },
) {
	return {
		request: new Request(
			`http://localhost/api/deep-research/jobs/${jobId}/plan/edit`,
			{
				method: "POST",
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
			},
		),
		locals: { user },
		params: { id: jobId },
		url: new URL(`http://localhost/api/deep-research/jobs/${jobId}/plan/edit`),
		route: { id: "/api/deep-research/jobs/[id]/plan/edit" },
	} as EditRouteEvent;
}

describe("POST /api/deep-research/jobs/[id]/plan/edit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockEditDeepResearchPlan.mockResolvedValue({
			id: "research-job-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			depth: "standard",
			status: "awaiting_approval",
			stage: "plan_revised",
			title: "Research AI copyright rules",
			currentPlan: {
				version: 2,
				status: "awaiting_approval",
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

	it("applies a freeform Plan Edit for the signed-in user", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.job).toMatchObject({
			id: "research-job-1",
			status: "awaiting_approval",
			stage: "plan_revised",
			currentPlan: { version: 2 },
		});
		expect(mockEditDeepResearchPlan).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "research-job-1",
			editInstruction: "Focus more on startup compliance risks.",
		});
	});

	it("accepts a Report Intent-only Plan Edit before approval", async () => {
		const response = await POST(makeEvent({ reportIntent: "market_scan" }));

		expect(response.status).toBe(200);
		expect(mockEditDeepResearchPlan).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "research-job-1",
			editInstruction: "",
			reportIntent: "market_scan",
		});
	});

	it("returns a conflict when the Research Plan can no longer be edited", async () => {
		const error = Object.assign(
			new Error("Approved Research Plans cannot be edited"),
			{
				code: "plan_already_approved",
				status: 409,
			},
		);
		mockEditDeepResearchPlan.mockRejectedValue(error);
		mockIsDeepResearchPlanActionError.mockReturnValue(true);

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toEqual({
			error: "Approved Research Plans cannot be edited",
			code: "plan_already_approved",
		});
	});
});
