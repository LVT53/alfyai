import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/deep-research/worker", () => ({
	triggerDeepResearchWorkflowWorkerForJob: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		deepResearchWorkerGlobalConcurrency: 2,
		deepResearchWorkerUserConcurrency: 2,
	})),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { triggerDeepResearchWorkflowWorkerForJob } from "$lib/server/services/deep-research/worker";
import { POST } from "./+server";

type AdvanceRouteEvent = Parameters<typeof POST>[0];

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockTriggerDeepResearchWorkflowWorkerForJob =
	triggerDeepResearchWorkflowWorkerForJob as ReturnType<typeof vi.fn>;

function makeEvent(
	jobId = "research-job-1",
	user = { id: "user-1", email: "test@example.com" },
) {
	return {
		request: new Request(
			`http://localhost/api/deep-research/jobs/${jobId}/worker/advance`,
			{
				method: "POST",
			},
		),
		locals: { user },
		params: { id: jobId },
		url: new URL(
			`http://localhost/api/deep-research/jobs/${jobId}/worker/advance`,
		),
		route: { id: "/api/deep-research/jobs/[id]/worker/advance" },
	} as AdvanceRouteEvent;
}

describe("POST /api/deep-research/jobs/[id]/worker/advance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockTriggerDeepResearchWorkflowWorkerForJob.mockResolvedValue({
			job: {
				id: "research-job-1",
				conversationId: "conv-1",
				triggerMessageId: "user-msg-1",
				depth: "standard",
				status: "running",
				stage: "source_review",
				title: "Research AI copyright rules",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			advanced: true,
			outcome: "discovery_completed",
			workerRunId: "manual-dev-run-1",
		});
	});

	it("triggers one real workflow worker step for the signed-in user without an open chat stream", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toMatchObject({
			advanced: true,
			outcome: "discovery_completed",
			workerRunId: "manual-dev-run-1",
			job: {
				id: "research-job-1",
				status: "running",
				stage: "source_review",
			},
		});
		expect(mockTriggerDeepResearchWorkflowWorkerForJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "research-job-1",
			controls: {
				globalConcurrencyLimit: 2,
				userConcurrencyLimit: 2,
			},
		});
	});

	it("preserves a not-found response for missing or unauthorized jobs", async () => {
		mockTriggerDeepResearchWorkflowWorkerForJob.mockResolvedValue(null);

		const response = await POST(makeEvent("other-user-job"));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data).toEqual({ error: "Deep Research job not found" });
		expect(mockTriggerDeepResearchWorkflowWorkerForJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "other-user-job",
			controls: {
				globalConcurrencyLimit: 2,
				userConcurrencyLimit: 2,
			},
		});
	});

	it("requires an authenticated user before triggering the workflow worker", async () => {
		const response = await POST(makeEvent("research-job-1", null));
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data).toEqual({ error: "Unauthorized" });
		expect(mockTriggerDeepResearchWorkflowWorkerForJob).not.toHaveBeenCalled();
	});
});
