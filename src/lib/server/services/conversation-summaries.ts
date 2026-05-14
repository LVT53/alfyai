import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { conversationSummaries } from '$lib/server/db/schema';
import {
	canUseContextSummarizer,
	requestContextSummarizer,
} from '$lib/server/services/task-state/control-model';
import { clipNullableText, normalizeWhitespace } from '$lib/server/utils/text';

const SUMMARY_MAX_CHARS = 700;
const MEANINGFUL_TURN_MIN_CHARS = 40;

export type ConversationSummary = {
	conversationId: string;
	userId: string;
	summary: string;
	source: 'model' | 'deterministic';
	createdAt: number;
	updatedAt: number;
};

export type RefreshConversationSummaryParams = {
	userId: string;
	conversationId: string;
	userMessage: string;
	assistantResponse: string;
};

function timestampToMs(value: Date | number | null | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	return 0;
}

function mapConversationSummary(
	row: typeof conversationSummaries.$inferSelect,
): ConversationSummary {
	return {
		conversationId: row.conversationId,
		userId: row.userId,
		summary: row.summary,
		source: row.source === 'model' ? 'model' : 'deterministic',
		createdAt: timestampToMs(row.createdAt),
		updatedAt: timestampToMs(row.updatedAt),
	};
}

function compactText(value: string | null | undefined, maxLength = SUMMARY_MAX_CHARS): string {
	return clipNullableText(normalizeWhitespace(value ?? ''), maxLength) ?? '';
}

function buildDeterministicSummary(params: {
	previousSummary?: string | null;
	userMessage: string;
	assistantResponse: string;
}): string {
	const previous = compactText(params.previousSummary, 260);
	const user = compactText(params.userMessage, 220);
	const assistant = compactText(params.assistantResponse, 420);
	const next = [
		previous ? `Prior summary: ${previous}` : null,
		user ? `Latest user request: ${user}` : null,
		assistant ? `Latest assistant response: ${assistant}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join(' ');
	return compactText(next);
}

async function buildModelSummary(params: {
	previousSummary?: string | null;
	userMessage: string;
	assistantResponse: string;
}): Promise<string | null> {
	if (!canUseContextSummarizer()) return null;
	try {
		const summary = await requestContextSummarizer({
			system:
				'Write a compact durable conversation summary in 50-100 words. Preserve concrete user goals, decisions, constraints, and next steps. Do not mention that you are summarizing.',
			user: [
				params.previousSummary
					? `Existing durable summary:\n${params.previousSummary}`
					: null,
				`Latest user message:\n${params.userMessage}`,
				`Latest assistant response:\n${params.assistantResponse}`,
			]
				.filter((value): value is string => Boolean(value))
				.join('\n\n'),
			maxTokens: 140,
			temperature: 0.1,
		});
		return summary ? compactText(summary) : null;
	} catch (error) {
		console.error('[CONVERSATION_SUMMARIES] Model summary refresh failed:', error);
		return null;
	}
}

export async function getConversationSummary(params: {
	userId: string;
	conversationId: string;
}): Promise<ConversationSummary | null> {
	const [row] = await db
		.select()
		.from(conversationSummaries)
		.where(
			and(
				eq(conversationSummaries.userId, params.userId),
				eq(conversationSummaries.conversationId, params.conversationId),
			),
		)
		.limit(1);

	return row ? mapConversationSummary(row) : null;
}

export async function refreshConversationSummary(
	params: RefreshConversationSummaryParams,
): Promise<ConversationSummary | null> {
	const userMessage = compactText(params.userMessage);
	const assistantResponse = compactText(params.assistantResponse);
	if ((userMessage + assistantResponse).length < MEANINGFUL_TURN_MIN_CHARS) {
		return getConversationSummary({
			userId: params.userId,
			conversationId: params.conversationId,
		});
	}

	const previous = await getConversationSummary({
		userId: params.userId,
		conversationId: params.conversationId,
	});
	const modelSummary = await buildModelSummary({
		previousSummary: previous?.summary ?? null,
		userMessage,
		assistantResponse,
	});
	const source: ConversationSummary['source'] = modelSummary ? 'model' : 'deterministic';
	const summary =
		modelSummary ??
		buildDeterministicSummary({
			previousSummary: previous?.summary ?? null,
			userMessage,
			assistantResponse,
		});

	await db
		.insert(conversationSummaries)
		.values({
			conversationId: params.conversationId,
			userId: params.userId,
			summary,
			source,
		})
		.onConflictDoUpdate({
			target: conversationSummaries.conversationId,
			set: {
				userId: params.userId,
				summary,
				source,
				updatedAt: sql`(unixepoch())`,
			},
		});

	return getConversationSummary({
		userId: params.userId,
		conversationId: params.conversationId,
	});
}
