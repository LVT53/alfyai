import { describe, expect, it, vi } from "vitest";
import {
	advanceDeepResearchWorkflow,
	approveDeepResearchPlan,
	discussDeepResearchReport,
	editDeepResearchPlan,
	researchFurtherFromDeepResearchReport,
	startDeepResearchChatJob,
} from "./deep-research";

describe("deep-research client API", () => {
	it("posts composer Deep Research sends to the non-streaming job-start path", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						response: null,
						conversationId: "conv-1",
						deepResearchJob: {
							id: "job-1",
							conversationId: "conv-1",
							triggerMessageId: "message-1",
							depth: "focused",
							status: "awaiting_approval",
							stage: "plan_drafted",
							title: "Research battery recycling",
							createdAt: 1,
							updatedAt: 2,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			startDeepResearchChatJob(
				{
					conversationId: "conv-1",
					message: "Research battery recycling",
					depth: "focused",
					modelId: "model1",
					attachmentIds: ["artifact-1"],
					activeDocumentArtifactId: "artifact-active-1",
					personalityProfileId: "personality-1",
				},
				fetchMock,
			),
		).resolves.toMatchObject({
			id: "job-1",
			conversationId: "conv-1",
			triggerMessageId: "message-1",
			depth: "focused",
		});
		expect(fetchMock).toHaveBeenCalledWith("/api/chat/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				conversationId: "conv-1",
				message: "Research battery recycling",
				model: "model1",
				attachmentIds: ["artifact-1"],
				deepResearch: { depth: "focused" },
				activeDocumentArtifactId: "artifact-active-1",
				personalityProfileId: "personality-1",
			}),
		});
	});

	it("posts a manual workflow advance request and returns the updated job", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						advanced: true,
						outcome: "discovery_completed",
						status: "running",
						stage: "source_review",
						job: {
							id: "job-1",
							conversationId: "conv-1",
							triggerMessageId: "message-1",
							depth: "standard",
							status: "running",
							stage: "source_review",
							title: "Research battery recycling policy",
							createdAt: 1,
							updatedAt: 2,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			advanceDeepResearchWorkflow("job-1", fetchMock),
		).resolves.toMatchObject({
			advanced: true,
			outcome: "discovery_completed",
			job: {
				id: "job-1",
				status: "running",
				stage: "source_review",
			},
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/deep-research/jobs/job-1/workflow/advance",
			{
				method: "POST",
			},
		);
	});

	it("posts Plan Edit instructions and returns the updated job", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						job: {
							id: "job-1",
							conversationId: "conv-1",
							triggerMessageId: "message-1",
							depth: "standard",
							status: "awaiting_approval",
							stage: "plan_drafted",
							title: "Research battery recycling policy",
							plan: {
								version: 2,
								renderedPlan: "Revised Research Plan",
								contextDisclosure: null,
								effortEstimate: {
									selectedDepth: "standard",
									expectedTimeBand: "30-60 minutes",
									sourceReviewCeiling: 40,
									relativeCostWarning: "Moderate relative cost.",
								},
							},
							createdAt: 1,
							updatedAt: 2,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			editDeepResearchPlan("job-1", "Focus on recent enforcement.", fetchMock),
		).resolves.toMatchObject({
			id: "job-1",
			plan: { version: 2, renderedPlan: "Revised Research Plan" },
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/deep-research/jobs/job-1/plan/edit",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					editInstruction: "Focus on recent enforcement.",
				}),
			},
		);
	});

	it("posts Report Intent revisions with Plan Edit requests", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						job: {
							id: "job-1",
							conversationId: "conv-1",
							triggerMessageId: "message-1",
							depth: "standard",
							status: "awaiting_approval",
							stage: "plan_revised",
							title: "Research battery recycling policy",
							createdAt: 1,
							updatedAt: 2,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await editDeepResearchPlan("job-1", "", "recommendation", fetchMock);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/deep-research/jobs/job-1/plan/edit",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					editInstruction: "",
					reportIntent: "recommendation",
				}),
			},
		);
	});

	it("posts plan approval and returns the updated job", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						job: {
							id: "job-1",
							conversationId: "conv-1",
							triggerMessageId: "message-1",
							depth: "standard",
							status: "approved",
							stage: "plan_approved",
							title: "Research battery recycling policy",
							plan: null,
							createdAt: 1,
							updatedAt: 2,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			approveDeepResearchPlan("job-1", fetchMock),
		).resolves.toMatchObject({
			id: "job-1",
			status: "approved",
			stage: "plan_approved",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/deep-research/jobs/job-1/plan/approve",
			{
				method: "POST",
			},
		);
	});

	it("posts Discuss Report and returns the new conversation target", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						sourceJobId: "job-1",
						reportArtifactId: "artifact-1",
						conversation: {
							id: "conv-discuss-1",
							title: "Discuss: Research battery recycling policy",
							projectId: null,
							createdAt: 1,
							updatedAt: 2,
						},
						messageId: "message-discuss-1",
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			discussDeepResearchReport("job-1", fetchMock),
		).resolves.toMatchObject({
			conversation: { id: "conv-discuss-1" },
			messageId: "message-discuss-1",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/deep-research/jobs/job-1/report-actions/discuss",
			{
				method: "POST",
			},
		);
	});

	it("posts Research Further and returns the new conversation and pending job", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						sourceJobId: "job-1",
						reportArtifactId: "artifact-1",
						conversation: {
							id: "conv-further-1",
							title: "Research further: Research battery recycling policy",
							projectId: null,
							createdAt: 1,
							updatedAt: 2,
						},
						messageId: "message-further-1",
						job: {
							id: "job-2",
							conversationId: "conv-further-1",
							triggerMessageId: "message-further-1",
							depth: "standard",
							status: "awaiting_approval",
							stage: "plan_drafted",
							title: "Research further from this Research Report",
							createdAt: 1,
							updatedAt: 2,
						},
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			researchFurtherFromDeepResearchReport("job-1", fetchMock),
		).resolves.toMatchObject({
			conversation: { id: "conv-further-1" },
			job: { id: "job-2", status: "awaiting_approval" },
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/deep-research/jobs/job-1/report-actions/research-further",
			{
				method: "POST",
			},
		);
	});

	it("posts Research Further with an explicit depth override", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						sourceJobId: "job-1",
						reportArtifactId: "artifact-1",
						conversation: {
							id: "conv-further-1",
							title: "Research further: Research battery recycling policy",
							projectId: null,
							createdAt: 1,
							updatedAt: 2,
						},
						messageId: "message-further-1",
						job: {
							id: "job-2",
							conversationId: "conv-further-1",
							triggerMessageId: "message-further-1",
							depth: "max",
							status: "awaiting_approval",
							stage: "plan_drafted",
							title: "Research further from this Evidence Limitation Memo",
							createdAt: 1,
							updatedAt: 2,
						},
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			researchFurtherFromDeepResearchReport("job-1", {
				depth: "max",
				fetchImpl: fetchMock,
			}),
		).resolves.toMatchObject({
			conversation: { id: "conv-further-1" },
			job: { id: "job-2", depth: "max" },
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/deep-research/jobs/job-1/report-actions/research-further",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ depth: "max" }),
			},
		);
	});
});
