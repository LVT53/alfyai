import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/deep-research", () => ({
	researchFurtherFromDeepResearchReport: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { researchFurtherFromDeepResearchReport } from "$lib/server/services/deep-research";
import { POST } from "./+server";

type ResearchFurtherRouteEvent = Parameters<typeof POST>[0];

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockResearchFurtherFromDeepResearchReport =
	researchFurtherFromDeepResearchReport as ReturnType<typeof vi.fn>;

function makeEvent(
	body: unknown = { depth: "focused" },
	jobId = "research-job-1",
	user = { id: "user-1", email: "test@example.com" },
) {
	return {
		request: new Request(
			`http://localhost/api/deep-research/jobs/${jobId}/report-actions/research-further`,
			{
				method: "POST",
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
			},
		),
		locals: { user },
		params: { id: jobId },
		url: new URL(
			`http://localhost/api/deep-research/jobs/${jobId}/report-actions/research-further`,
		),
		route: {
			id: "/api/deep-research/jobs/[id]/report-actions/research-further",
		},
	} as ResearchFurtherRouteEvent;
}

describe("POST /api/deep-research/jobs/[id]/report-actions/research-further", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockResearchFurtherFromDeepResearchReport.mockResolvedValue({
			sourceJobId: "research-job-1",
			reportArtifactId: "artifact-report-1",
			conversation: {
				id: "conv-further-1",
				title: "Research further: Research AI copyright rules",
				projectId: null,
				createdAt: 1,
				updatedAt: 1,
			},
			messageId: "message-further-1",
			job: {
				id: "research-job-2",
				conversationId: "conv-further-1",
				triggerMessageId: "message-further-1",
				depth: "focused",
				status: "awaiting_approval",
				stage: "plan_drafted",
				title: "Research further from this Research Report",
				plan: {
					version: 1,
					status: "awaiting_approval",
					renderedPlan: "# Research Plan",
					contextDisclosure: "Context considered: 1 report item.",
					effortEstimate: {
						selectedDepth: "focused",
						expectedTimeBand: "10-20 minutes",
						sourceReviewCeiling: 12,
						relativeCostWarning: "Lowest relative cost.",
					},
				},
				createdAt: 1,
				updatedAt: 1,
			},
		});
	});

	it("starts a new Deep Research Job from the completed report context", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data).toMatchObject({
			sourceJobId: "research-job-1",
			reportArtifactId: "artifact-report-1",
			conversation: { id: "conv-further-1" },
			messageId: "message-further-1",
			job: {
				id: "research-job-2",
				conversationId: "conv-further-1",
				status: "awaiting_approval",
				stage: "plan_drafted",
				plan: { contextDisclosure: "Context considered: 1 report item." },
			},
		});
		expect(mockResearchFurtherFromDeepResearchReport).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "research-job-1",
			depth: "focused",
		});
	});

	it("rejects unsupported depth values", async () => {
		const response = await POST(makeEvent({ depth: "exhaustive" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toEqual({ error: "Invalid Deep Research depth" });
		expect(mockResearchFurtherFromDeepResearchReport).not.toHaveBeenCalled();
	});
});
