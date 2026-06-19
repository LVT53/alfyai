import { and, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { atlasJobs } from "$lib/server/db/schema";
import type {
	AtlasAction,
	AtlasJobCard,
	AtlasJobStatus,
	AtlasProfile,
} from "./types";

function timestampMs(value: Date | null): number | null {
	return value ? value.getTime() : null;
}

function parseProgressDetails(value: string | null): { queries: string[] } {
	if (!value) return { queries: [] };
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object") return { queries: [] };
		const queries = Array.isArray((parsed as { queries?: unknown }).queries)
			? (parsed as { queries: unknown[] }).queries
					.map((query) =>
						typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "",
					)
					.filter(Boolean)
					.slice(0, 8)
			: [];
		return { queries };
	} catch {
		return { queries: [] };
	}
}

export function mapAtlasJobRowToCard(
	job: typeof atlasJobs.$inferSelect,
): AtlasJobCard {
	return {
		id: job.id,
		conversationId: job.conversationId,
		assistantMessageId: job.assistantMessageId ?? null,
		action: job.action as AtlasAction,
		parentAtlasJobId: job.parentAtlasJobId ?? null,
		profile: job.profile as AtlasProfile,
		title: job.title,
		status: job.status as AtlasJobStatus,
		stage: job.stage,
		progress: {
			percent: job.progressPercent,
			stage: job.stage,
			details: parseProgressDetails(job.progressDetailsJson),
		},
		sourceCounts: {
			local: job.localSourceCount,
			web: job.webSourceCount,
			accepted: job.acceptedSourceCount,
			rejected: job.rejectedSourceCount,
		},
		usage: {
			inputTokens: job.inputTokens,
			outputTokens: job.outputTokens,
			totalTokens: job.totalTokens,
			costUsdMicros: job.costUsdMicros,
		},
		outputs: {
			fileProductionJobId: job.fileProductionJobId ?? null,
			htmlChatGeneratedFileId: job.htmlChatGeneratedFileId ?? null,
			pdfChatGeneratedFileId: job.pdfChatGeneratedFileId ?? null,
			markdownChatGeneratedFileId: job.markdownChatGeneratedFileId ?? null,
		},
		error:
			job.errorCode && job.errorMessage
				? {
						code: job.errorCode,
						message: job.errorMessage,
						retryable: job.errorRetryable,
					}
				: null,
		createdAt: job.createdAt.getTime(),
		updatedAt: job.updatedAt.getTime(),
		completedAt: timestampMs(job.completedAt),
	};
}

export async function listConversationAtlasJobs(
	userId: string,
	conversationId: string,
): Promise<AtlasJobCard[]> {
	const jobs = await db
		.select()
		.from(atlasJobs)
		.where(
			and(
				eq(atlasJobs.userId, userId),
				eq(atlasJobs.conversationId, conversationId),
			),
		)
		.orderBy(desc(atlasJobs.createdAt));

	return jobs.map(mapAtlasJobRowToCard);
}
