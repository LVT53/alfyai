import { describe, expect, it, vi } from "vitest";
import type {
	DeepResearchEvidenceNote,
	DeepResearchSynthesisClaim,
} from "$lib/types";

vi.mock("./model-runner", () => ({
	tryRunAndRecordDeepResearchModel: vi.fn(),
}));

import { buildClaimGraphCitationReviewerWithLlm } from "./llm-steps";
import { tryRunAndRecordDeepResearchModel } from "./model-runner";

const modelRunResult = (content: string) => ({
	content,
	modelId: "model1",
	modelDisplayName: "Model 1",
	providerId: null,
	providerDisplayName: null,
	providerModelName: null,
	runtimeMs: 42,
	usage: null,
});

function buildClaim(): DeepResearchSynthesisClaim {
	return {
		id: "claim-1",
		jobId: "job-1",
		conversationId: "conv-1",
		passCheckpointId: "checkpoint-1",
		synthesisPass: "synthesis-pass-1",
		planQuestion: "What are the official specs?",
		reportSection: "Specs",
		statement: "Model X officially includes 16 GB memory.",
		claimType: "official_specification",
		central: true,
		status: "accepted",
		statusReason: null,
		competingClaimGroupId: null,
		evidenceLinks: [
			{
				evidenceNoteId: "note-1",
				relation: "support",
				material: true,
			},
		],
		createdAt: "2026-05-05T10:00:00.000Z",
		updatedAt: "2026-05-05T10:00:00.000Z",
	};
}

function buildEvidenceNote(): DeepResearchEvidenceNote {
	return {
		id: "note-1",
		jobId: "job-1",
		conversationId: "conv-1",
		passCheckpointId: "checkpoint-1",
		passNumber: 1,
		sourceId: "source-1",
		taskId: null,
		supportedKeyQuestion: "What are the official specs?",
		comparedEntity: "Model X",
		comparisonAxis: "memory",
		findingText: "Model X officially includes 16 GB memory.",
		sourceSupport: {
			sourceId: "source-1",
			reviewedSourceId: "source-1",
			title: "Model X official page",
		},
		sourceQualitySignals: {
			sourceType: "official_vendor",
			independence: "primary",
			freshness: "current",
			directness: "direct",
			extractionConfidence: "high",
			claimFit: "strong",
		},
		sourceAuthoritySummary: null,
		createdAt: "2026-05-05T10:00:00.000Z",
		updatedAt: "2026-05-05T10:00:00.000Z",
	};
}

describe("buildClaimGraphCitationReviewerWithLlm", () => {
	it("accepts claim-array reviewer output that uses id and evidenceNotes object ids", async () => {
		vi.mocked(tryRunAndRecordDeepResearchModel).mockResolvedValueOnce(
			modelRunResult(
				JSON.stringify({
					claims: [
						{
							id: "claim-1",
							status: "supported",
							evidenceNotes: [{ id: "note-1" }],
							explanation:
								"The linked official evidence directly supports the claim.",
						},
					],
				}),
			),
		);
		const claim = buildClaim();
		const evidenceNote = buildEvidenceNote();

		const reviewer = await buildClaimGraphCitationReviewerWithLlm({
			context: {
				jobId: "job-1",
				conversationId: "conv-1",
				userId: "user-1",
			},
			claims: [claim],
			evidenceNotes: [evidenceNote],
			concurrency: 1,
		});

		expect(reviewer?.({ claim, linkedEvidenceNotes: [evidenceNote] })).toEqual({
			claimId: "claim-1",
			verdict: "supported",
			evidenceNoteIds: ["note-1"],
			reason: "The linked official evidence directly supports the claim.",
		});
	});

	it("accepts top-level reviewer arrays and alternate evidence id fields", async () => {
		vi.mocked(tryRunAndRecordDeepResearchModel).mockResolvedValueOnce(
			modelRunResult(
				JSON.stringify([
					{
						synthesisClaimId: "claim-1",
						auditVerdict: "partially_supported",
						citations: [{ evidenceNoteId: "note-1" }],
						rationale: "The linked note supports the core claim with a caveat.",
					},
				]),
			),
		);
		const claim = buildClaim();
		const evidenceNote = buildEvidenceNote();

		const reviewer = await buildClaimGraphCitationReviewerWithLlm({
			context: {
				jobId: "job-1",
				conversationId: "conv-1",
				userId: "user-1",
			},
			claims: [claim],
			evidenceNotes: [evidenceNote],
			concurrency: 1,
		});

		expect(reviewer?.({ claim, linkedEvidenceNotes: [evidenceNote] })).toEqual({
			claimId: "claim-1",
			verdict: "partially_supported",
			evidenceNoteIds: ["note-1"],
			reason: "The linked note supports the core claim with a caveat.",
		});
	});
});
