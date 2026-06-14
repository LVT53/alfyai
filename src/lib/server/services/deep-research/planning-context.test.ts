import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "$lib/types";
import { buildDeepResearchPlanningContext } from "./planning-context";

function artifact(
	overrides: Partial<Artifact> & { id: string; name: string },
): Artifact {
	return {
		id: overrides.id,
		userId: overrides.userId ?? "user-1",
		type: overrides.type ?? "normalized_document",
		retrievalClass: overrides.retrievalClass ?? "document",
		name: overrides.name,
		mimeType: overrides.mimeType ?? "text/plain",
		sizeBytes: overrides.sizeBytes ?? 100,
		conversationId: overrides.conversationId ?? "conv-1",
		summary: overrides.summary ?? null,
		createdAt: overrides.createdAt ?? 1,
		updatedAt: overrides.updatedAt ?? 1,
		extension: overrides.extension ?? ".txt",
		storagePath: overrides.storagePath ?? null,
		contentText: overrides.contentText ?? null,
		metadata: overrides.metadata ?? null,
	};
}

describe("buildDeepResearchPlanningContext", () => {
	it("includes prompt-ready attachments as research-source planning context", async () => {
		const resolvePromptAttachmentArtifacts = vi.fn(async () => ({
			displayArtifacts: [],
			promptArtifacts: [],
			items: [
				{
					requestedArtifactId: "attachment-1",
					displayArtifact: artifact({
						id: "source-1",
						name: "Market brief.pdf",
						summary: "User supplied PDF",
					}),
					promptArtifact: artifact({
						id: "attachment-1",
						name: "Market brief.pdf",
						summary: "Normalized PDF summary",
						contentText: "Attachment extracted text ".repeat(80),
					}),
					promptReady: true,
					readinessError: null,
					contentLength: 4000,
					contentPreview: null,
					contentHash: "hash-1",
					chunkCount: 3,
				},
			],
			unresolvedItems: [],
		}));

		const context = await buildDeepResearchPlanningContext(
			{
				userId: "user-1",
				conversationId: "conv-1",
				userRequest: "Research the home battery market.",
				attachmentIds: ["source-1"],
			},
			{
				resolvePromptAttachmentArtifacts,
				selectWorkingSetArtifactsForPrompt: vi.fn(async () => []),
				findRelevantKnowledgeArtifacts: vi.fn(async () => []),
			},
		);

		expect(context).toEqual([
			expect.objectContaining({
				type: "attachment",
				artifactId: "attachment-1",
				title: "Market brief.pdf",
				includeAsResearchSource: true,
			}),
		]);
		expect(context[0]?.summary.length).toBeLessThanOrEqual(900);
		expect(resolvePromptAttachmentArtifacts).toHaveBeenCalledWith("user-1", [
			"source-1",
		]);
	});

	it("adds bounded knowledge context without promoting it to research sources", async () => {
		const selectWorkingSetArtifactsForPrompt = vi.fn(async () => [
			artifact({
				id: "attachment-1",
				name: "Market brief duplicate",
				summary: "This duplicate should lose to the attachment.",
			}),
			artifact({
				id: "knowledge-1",
				name: "Internal buying criteria",
				summary:
					"Prefer practical buying criteria over broad market narrative.",
			}),
		]);
		const findRelevantKnowledgeArtifacts = vi.fn(async () => [
			artifact({
				id: "knowledge-2",
				name: "Prior vendor comparison",
				contentText: "Long prior comparison ".repeat(120),
			}),
		]);

		const context = await buildDeepResearchPlanningContext(
			{
				userId: "user-1",
				conversationId: "conv-1",
				userRequest: "Research the home battery market.",
				attachmentIds: ["source-1"],
				activeDocumentArtifactId: "active-doc-1",
				maxSummaryLength: 120,
			},
			{
				resolvePromptAttachmentArtifacts: vi.fn(async () => ({
					displayArtifacts: [],
					promptArtifacts: [],
					items: [
						{
							requestedArtifactId: "source-1",
							displayArtifact: null,
							promptArtifact: artifact({
								id: "attachment-1",
								name: "Market brief.pdf",
								summary: "User supplied source.",
							}),
							promptReady: true,
							readinessError: null,
							contentLength: 100,
							contentPreview: null,
							contentHash: "hash-1",
							chunkCount: 1,
						},
					],
					unresolvedItems: [],
				})),
				selectWorkingSetArtifactsForPrompt,
				findRelevantKnowledgeArtifacts,
			},
		);

		expect(context.map((item) => item.artifactId)).toEqual([
			"attachment-1",
			"knowledge-1",
			"knowledge-2",
		]);
		expect(context[0]).toMatchObject({
			type: "attachment",
			includeAsResearchSource: true,
		});
		expect(context.slice(1)).toEqual([
			expect.objectContaining({
				type: "knowledge",
				includeAsResearchSource: false,
			}),
			expect.objectContaining({
				type: "knowledge",
				includeAsResearchSource: false,
			}),
		]);
		expect(context[2]?.summary.length).toBeLessThanOrEqual(120);
		expect(selectWorkingSetArtifactsForPrompt).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"Research the home battery market.",
			["source-1"],
			"active-doc-1",
		);
		expect(findRelevantKnowledgeArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				query: "Research the home battery market.",
				excludeConversationId: "conv-1",
				currentConversationId: "conv-1",
				preferredArtifactId: "active-doc-1",
			}),
		);
	});

	it("caps the total context count and ignores unresolved attachments", async () => {
		const selectWorkingSetArtifactsForPrompt = vi.fn(async () => [
			artifact({ id: "knowledge-1", name: "Knowledge one" }),
		]);
		const findRelevantKnowledgeArtifacts = vi.fn(async () => [
			artifact({ id: "knowledge-2", name: "Knowledge two" }),
		]);

		const context = await buildDeepResearchPlanningContext(
			{
				userId: "user-1",
				conversationId: "conv-1",
				userRequest: "Research the home battery market.",
				attachmentIds: ["source-1", "missing-source"],
				maxItems: 1,
			},
			{
				resolvePromptAttachmentArtifacts: vi.fn(async () => ({
					displayArtifacts: [],
					promptArtifacts: [],
					items: [
						{
							requestedArtifactId: "source-1",
							displayArtifact: null,
							promptArtifact: artifact({
								id: "attachment-1",
								name: "Market brief.pdf",
							}),
							promptReady: true,
							readinessError: null,
							contentLength: 100,
							contentPreview: null,
							contentHash: "hash-1",
							chunkCount: 1,
						},
						{
							requestedArtifactId: "missing-source",
							displayArtifact: null,
							promptArtifact: null,
							promptReady: false,
							readinessError: "Attached file is no longer available.",
							contentLength: 0,
							contentPreview: null,
							contentHash: null,
							chunkCount: 0,
						},
					],
					unresolvedItems: [],
				})),
				selectWorkingSetArtifactsForPrompt,
				findRelevantKnowledgeArtifacts,
			},
		);

		expect(context).toEqual([
			expect.objectContaining({
				artifactId: "attachment-1",
				type: "attachment",
			}),
		]);
		expect(selectWorkingSetArtifactsForPrompt).not.toHaveBeenCalled();
		expect(findRelevantKnowledgeArtifacts).not.toHaveBeenCalled();
	});
});
