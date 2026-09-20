import { describe, expect, it, vi } from "vitest";
import type { AtlasJobCard } from "$lib/server/services/atlas/public-types";
import { toFriendlySendError } from "../../../routes/(app)/chat/[conversationId]/_helpers";
import { cancelAtlasJob, submitAtlasTurn } from "./atlas";
import { ApiError, type FetchLike } from "./http";

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

	// F15. Atlas mode does not stream, so its send-gate refusal comes back
	// through `requestJson`. The rows the 422 carries used to be dropped by
	// `readErrorPayload`, so an Atlas user got the server's English sentence
	// where a streaming user got the translated per-file one.
	it("carries the send gate's per-attachment rows onto the thrown ApiError", async () => {
		const attachmentExtraction = [
			{
				artifactId: "artifact-1",
				name: "scan.pdf",
				status: "parsing",
				errorCode: null,
				retryable: false,
			},
		];
		const fetchImpl = vi.fn<FetchLike>(
			async () =>
				new Response(
					JSON.stringify({
						error:
							"One or more attached files are still being prepared for chat.",
						code: "attachment_extraction_pending",
						attachmentIds: ["artifact-1"],
						attachmentExtraction,
					}),
					{ status: 422, headers: { "Content-Type": "application/json" } },
				),
		);

		const error = await submitAtlasTurn(
			{
				conversationId: "conv-1",
				message: "Summarize this",
				attachmentIds: ["artifact-1"],
				profile: "overview",
				action: "create",
				clientAtlasTurnId: "client-atlas-1",
			},
			fetchImpl,
		).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe("attachment_extraction_pending");
		expect((error as ApiError).attachmentExtraction).toEqual(
			attachmentExtraction,
		);

		// And the composer's one renderer turns them into the translated
		// sentence, exactly as it does for the streaming path's error.
		expect(
			toFriendlySendError(error as Error, (key) => `translated:${key}`),
		).toBe("scan.pdf: translated:chat.extraction.parsing");
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
