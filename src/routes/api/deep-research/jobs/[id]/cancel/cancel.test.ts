import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/deep-research", () => ({
	cancelPrePlanDeepResearchJob: vi.fn(),
}));

vi.mock("$lib/server/services/deep-research/worker", () => ({
	requestDeepResearchWorkerCancellation: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { cancelPrePlanDeepResearchJob } from "$lib/server/services/deep-research";
import { requestDeepResearchWorkerCancellation } from "$lib/server/services/deep-research/worker";
import { POST } from "./+server";

type CancelRouteEvent = Parameters<typeof POST>[0];

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCancelPrePlanDeepResearchJob =
	cancelPrePlanDeepResearchJob as ReturnType<typeof vi.fn>;
const mockRequestDeepResearchWorkerCancellation =
	requestDeepResearchWorkerCancellation as ReturnType<typeof vi.fn>;

function makeEvent(
	jobId = "research-job-1",
	user = { id: "user-1", email: "test@example.com" },
) {
	return {
		request: new Request(
			`http://localhost/api/deep-research/jobs/${jobId}/cancel`,
			{
				method: "POST",
			},
		),
		locals: { user },
		params: { id: jobId },
		url: new URL(`http://localhost/api/deep-research/jobs/${jobId}/cancel`),
		route: { id: "/api/deep-research/jobs/[id]/cancel" },
	} as CancelRouteEvent;
}

describe("POST /api/deep-research/jobs/[id]/cancel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockCancelPrePlanDeepResearchJob.mockResolvedValue({
			id: "research-job-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			depth: "standard",
			status: "cancelled",
			stage: "cancelled_before_approval",
			title: "Research AI copyright rules",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cancelledAt: Date.now(),
		});
		mockRequestDeepResearchWorkerCancellation.mockResolvedValue(null);
	});

	it("cancels a pre-approval Deep Research job for the signed-in user", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.job).toMatchObject({
			id: "research-job-1",
			status: "cancelled",
			stage: "cancelled_before_approval",
		});
		expect(mockCancelPrePlanDeepResearchJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "research-job-1",
		});
		expect(mockRequestDeepResearchWorkerCancellation).not.toHaveBeenCalled();
	});

	it("cancels an approved or running Deep Research job through the worker cancellation path", async () => {
		mockCancelPrePlanDeepResearchJob.mockResolvedValue(null);
		mockRequestDeepResearchWorkerCancellation.mockResolvedValue({
			id: "running-job-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			depth: "standard",
			status: "cancelled",
			stage: "cancelled_by_request",
			title: "Research AI copyright rules",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cancelledAt: Date.now(),
		});

		const response = await POST(makeEvent("running-job-1"));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.job).toMatchObject({
			id: "running-job-1",
			status: "cancelled",
			stage: "cancelled_by_request",
		});
		expect(mockRequestDeepResearchWorkerCancellation).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "running-job-1",
		});
	});

	it("returns 404 when the Deep Research job cannot be cancelled", async () => {
		mockCancelPrePlanDeepResearchJob.mockResolvedValue(null);
		mockRequestDeepResearchWorkerCancellation.mockResolvedValue(null);

		const response = await POST(makeEvent("running-job-1"));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toMatch(/not found or not cancellable/i);
		expect(mockCancelPrePlanDeepResearchJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "running-job-1",
		});
		expect(mockRequestDeepResearchWorkerCancellation).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "running-job-1",
		});
	});
});
