import { and, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { atlasJobs } from "$lib/server/db/schema";
import type {
	AtlasAction,
	AtlasJobCard,
	AtlasJobProgressDetails,
	AtlasJobStatus,
	AtlasProfile,
} from "./types";

const MAX_PROGRESS_ITEMS = 8;
const MAX_PROGRESS_TEXT_LENGTH = 140;

function timestampMs(value: Date | null): number | null {
	return value ? value.getTime() : null;
}

function sanitizeProgressText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return null;
	if (
		/fetched\s+page\s+excerpt\s*:/i.test(normalized) ||
		/evidence\s+pack/i.test(normalized) ||
		/source\s+excerpt/i.test(normalized)
	) {
		return null;
	}
	return normalized.slice(0, MAX_PROGRESS_TEXT_LENGTH).trim();
}

function parseProgressTextList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(sanitizeProgressText)
		.filter((item): item is string => Boolean(item))
		.slice(0, MAX_PROGRESS_ITEMS);
}

export function sanitizeAtlasJobProgressDetails(
	value: unknown,
): AtlasJobProgressDetails {
	if (!value || typeof value !== "object") return { queries: [] };
	const record = value as {
		queries?: unknown;
		roundKind?: unknown;
		focus?: unknown;
		gapFillFocus?: unknown;
	};
	const queries = parseProgressTextList(record.queries);
	const focus = parseProgressTextList(record.focus ?? record.gapFillFocus);
	const roundKind =
		record.roundKind === "gap-fill" || record.roundKind === "initial"
			? record.roundKind
			: undefined;
	return {
		queries,
		...(roundKind ? { roundKind } : {}),
		...(focus.length > 0 ? { focus } : {}),
	};
}

function parseProgressDetails(value: string | null): AtlasJobProgressDetails {
	if (!value) return { queries: [] };
	try {
		const parsed = JSON.parse(value) as unknown;
		return sanitizeAtlasJobProgressDetails(parsed);
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
