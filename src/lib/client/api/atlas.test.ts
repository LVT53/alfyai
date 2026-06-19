import { describe, expect, it, vi } from "vitest";
import type { AtlasJobCard } from "$lib/types";
import { cancelAtlasJob, submitAtlasTurn } from "./atlas";
import type { FetchLike } from "./http";

function atlasJobFixture(overrides: Partial<AtlasJobCard> = {}): AtlasJobCard {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		title: "Atlas research",
		status: "queued",
		stage: "queued",
		progress: { percent: 0, stage: "queued", details: { queries: [] } },
		sourceCounts: { local: 0, web: 0, accepted: 0, rejected: 0 },
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsdMicros: 0,
		},
		outputs: {
			fileProductionJobId: null,
			htmlChatGeneratedFileId: null,
			pdfChatGeneratedFileId: null,
			markdownChatGeneratedFileId: null,
		},
		error: null,
		createdAt: 1,
		updatedAt: 1,
		completedAt: null,
		...overrides,
	};
}

describe("Atlas client API", () => {
	it("submits Atlas turns through the Normal Chat send route shape", async () => {
		const atlasJob = atlasJobFixture();
		const fetchImpl = vi.fn<FetchLike>(async () => {
			return new Response(
				JSON.stringify({
					message: "Atlas is queued.",
					atlasJob,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		const result = await submitAtlasTurn(
			{
				conversationId: "conv-1",
				message: "Research durable UI state",
				attachmentIds: ["artifact-1"],
				linkedSources: [
					{
						displayArtifactId: "artifact-1",
						promptArtifactId: "artifact-1",
						familyArtifactIds: ["artifact-1"],
						name: "Product brief",
						type: "document",
						mimeType: "application/pdf",
					},
				],
				profile: "in-depth",
				action: "continue",
				parentAtlasJobId: "atlas-parent-1",
				clientAtlasTurnId: "client-atlas-1",
			},
			fetchImpl,
		);

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/chat/send",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
			}),
		);
		const requestInit = (
			fetchImpl.mock.calls as Array<Parameters<FetchLike>>
		)[0][1] as RequestInit;
		expect(JSON.parse(String(requestInit.body))).toEqual({
			conversationId: "conv-1",
			message: "Research durable UI state",
			attachmentIds: ["artifact-1"],
			linkedSources: [
				{
					displayArtifactId: "artifact-1",
					promptArtifactId: "artifact-1",
					familyArtifactIds: ["artifact-1"],
					name: "Product brief",
					type: "document",
					mimeType: "application/pdf",
				},
			],
			atlasMode: true,
			atlasProfile: "in-depth",
			atlasAction: "continue",
			parentAtlasId: "atlas-parent-1",
			clientAtlasTurnId: "client-atlas-1",
		});
		expect(result).toEqual({
			message: "Atlas is queued.",
			atlasJob,
		});
	});

	it("cancels Atlas jobs through the owned Atlas endpoint", async () => {
		const atlasJob = atlasJobFixture({
			status: "cancelled",
			stage: "cancelled",
		});
		const fetchImpl = vi.fn<FetchLike>(async () => {
			return new Response(JSON.stringify({ job: atlasJob }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await cancelAtlasJob("atlas-job-1", fetchImpl);

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/atlas/jobs/atlas-job-1/cancel",
			expect.objectContaining({ method: "POST" }),
		);
		expect(result).toEqual(atlasJob);
	});
});
