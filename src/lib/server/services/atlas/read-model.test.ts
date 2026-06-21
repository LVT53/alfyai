import { describe, expect, it } from "vitest";
import type { atlasJobs } from "$lib/server/db/schema";
import { mapAtlasJobRowToCard } from "./read-model";

function atlasJobRow(
	overrides: Partial<typeof atlasJobs.$inferSelect> = {},
): typeof atlasJobs.$inferSelect {
	const now = new Date("2026-06-21T10:00:00.000Z");
	return {
		id: "atlas-job-1",
		userId: "user-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		normalizedQueryHash: "hash",
		clientAtlasTurnId: "client-turn-1",
		idempotencyKey: "atlas:v1:user-1:conv-1:create:root:in-depth:hash",
		title: "Generated Atlas title",
		status: "running",
		stage: "search",
		progressPercent: 58,
		progressDetailsJson: "{}",
		workerId: "worker-1",
		heartbeatAt: now,
		startedAt: now,
		completedAt: null,
		cancelRequestedAt: null,
		inputTokens: 1200,
		outputTokens: 800,
		totalTokens: 2000,
		costUsdMicros: 250000,
		localSourceCount: 1,
		webSourceCount: 4,
		acceptedSourceCount: 3,
		rejectedSourceCount: 2,
		fileProductionJobId: "file-job-1",
		htmlChatGeneratedFileId: "html-file-1",
		pdfChatGeneratedFileId: "pdf-file-1",
		markdownChatGeneratedFileId: "md-file-1",
		errorCode: null,
		errorMessage: null,
		errorRetryable: false,
		failureMetadataJson: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("Atlas read model", () => {
	it("sanitizes bounded gap-fill progress details for the card", () => {
		const card = mapAtlasJobRowToCard(
			atlasJobRow({
				progressDetailsJson: JSON.stringify({
					queries: [
						"  2026 enterprise RAG cost benchmark official report  ",
						"Fetched page excerpt: raw page text should not leak",
					],
					roundKind: "gap-fill",
					focus: [
						" current cost evidence for enterprise RAG ",
						"Fetched page excerpt: raw evidence pack text",
					],
					evidencePacks: [{ excerpt: "raw source excerpt" }],
				}),
			}),
		);
		const details = card.progress.details as {
			queries: string[];
			roundKind?: string;
			focus?: string[];
			evidencePacks?: unknown;
		};

		expect(details).toEqual({
			queries: ["2026 enterprise RAG cost benchmark official report"],
			roundKind: "gap-fill",
			focus: ["current cost evidence for enterprise RAG"],
		});
		expect(JSON.stringify(details)).not.toContain("Fetched page excerpt");
		expect(details.evidencePacks).toBeUndefined();
	});
});
