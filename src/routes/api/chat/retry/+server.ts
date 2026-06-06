import type { RequestHandler } from '@sveltejs/kit';
import { requireAuth } from '$lib/server/auth/hooks';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { messages } from '$lib/server/db/schema';
import { getConversation } from '$lib/server/services/conversations';
import { deleteMessages } from '$lib/server/services/messages';
import { listChildForksBySourceMessages } from '$lib/server/services/conversation-forks';
import { getConfig } from '$lib/server/config-store';
import { cleanupFailedTurn } from '$lib/server/services/chat-turn/retry-cleanup';
import { preflightChatTurn } from '$lib/server/services/chat-turn/preflight';
import { parseChatTurnRequest } from '$lib/server/services/chat-turn/request';
import { createJsonErrorResponse } from '$lib/server/api/responses';
import { createStreamJsonErrorResponse } from '$lib/server/services/chat-turn/stream';
import { runChatStreamOrchestrator } from '$lib/server/services/chat-turn/stream-orchestrator';
import { buildSkillSystemPromptAppendix } from '$lib/server/services/skills/prompt-context';
import { messageOrderAsc } from '$lib/server/services/message-ordering';
import { repairConversationMessageSequences } from '$lib/server/services/message-sequences';

const FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE =
	'forked_source_history_confirmation_required';

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const runtimeConfig = getConfig();

	let body: {
		conversationId?: unknown;
		assistantMessageId?: unknown;
		userMessageId?: unknown;
		userMessage?: unknown;
		activeDocumentArtifactId?: unknown;
		streamId?: unknown;
		model?: unknown;
		reasoningDepth?: unknown;
		personalityProfileId?: unknown;
		confirmForkedSourceHistoryMutation?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse('Invalid JSON body', 400);
	}

	const {
		conversationId,
		assistantMessageId,
		userMessageId,
		userMessage,
		activeDocumentArtifactId,
		streamId,
		model,
		reasoningDepth,
		personalityProfileId,
		confirmForkedSourceHistoryMutation,
	} = body;
	if (typeof conversationId !== 'string' || !conversationId.trim()) {
		return createJsonErrorResponse('conversationId is required', 400);
	}
	if (typeof assistantMessageId !== 'string' || !assistantMessageId.trim()) {
		return createJsonErrorResponse('assistantMessageId is required', 400);
	}
	if (typeof userMessageId !== 'string' || !userMessageId.trim()) {
		return createJsonErrorResponse('userMessageId is required', 400);
	}
	if (typeof userMessage !== 'string' || !userMessage.trim()) {
		return createJsonErrorResponse('userMessage is required', 400);
	}

	const conversation = await getConversation(user.id, conversationId);
	if (!conversation) {
		return createJsonErrorResponse('Conversation not found', 404);
	}

	repairConversationMessageSequences(conversationId);

	const conversationMessages = await db
		.select({
			id: messages.id,
			role: messages.role,
			content: messages.content,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(...messageOrderAsc());

	const assistantIndex = conversationMessages.findIndex((message) => message.id === assistantMessageId);
	const assistantMsg = assistantIndex >= 0 ? conversationMessages[assistantIndex] : null;
	if (!assistantMsg || assistantMsg.role !== 'assistant') {
		return createJsonErrorResponse('Assistant message not found', 404);
	}

	const precedingUserMsg = conversationMessages[assistantIndex - 1];
	if (
		!precedingUserMsg ||
		precedingUserMsg.role !== 'user' ||
		precedingUserMsg.id !== userMessageId
	) {
		return createJsonErrorResponse('Retry target does not match the preceding user message', 409);
	}

	if (precedingUserMsg.content.trim() !== userMessage.trim()) {
		return createJsonErrorResponse('Retry user message text does not match persisted message', 409);
	}

	const trailingMessages = conversationMessages.slice(assistantIndex);
	if (confirmForkedSourceHistoryMutation !== true) {
		const trailingAssistantMessageIds = trailingMessages
			.filter((message) => message.role === 'assistant')
			.map((message) => message.id);
		if (trailingAssistantMessageIds.length > 0) {
			const childForks = await listChildForksBySourceMessages(
				user.id,
				trailingAssistantMessageIds,
			);
			const hasChildForks = Object.values(childForks).some(
				(sourceForks) => (sourceForks.count ?? 0) > 0,
			);
			if (hasChildForks) {
				return new Response(
					JSON.stringify({
						error: 'Forked source history requires confirmation',
						code: FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
						errorKey: 'fork.regenerateWarning',
					}),
					{
						status: 409,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}
		}
	}

	let cleanupResult;
	try {
		cleanupResult = await cleanupFailedTurn({
			userId: user.id,
			conversationId,
			assistantMessageId,
		});
	} catch (error) {
		console.error('[RETRY] Cleanup failed:', error);
		return new Response(
			JSON.stringify({
				error: 'Retry cleanup failed',
				details: error instanceof Error ? error.message : String(error),
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	if (cleanupResult.warnings.length > 0) {
		console.warn('[RETRY] Cleanup warnings:', cleanupResult.warnings);
	}

	const trailingMessageIds = trailingMessages.map((message) => message.id);
	await deleteMessages(trailingMessageIds);

	if (!precedingUserMsg.content.trim()) {
		return createJsonErrorResponse('No user message found to retry', 400);
	}

	const syntheticBody = new Request('https://internal', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			message: precedingUserMsg.content,
			conversationId,
			activeDocumentArtifactId:
				typeof activeDocumentArtifactId === 'string' && activeDocumentArtifactId.trim()
					? activeDocumentArtifactId.trim()
					: undefined,
			streamId:
				typeof streamId === 'string' && streamId.trim()
					? streamId.trim()
					: undefined,
			model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
			reasoningDepth:
				typeof reasoningDepth === 'string' && reasoningDepth.trim()
					? reasoningDepth.trim()
					: undefined,
			personalityProfileId:
				typeof personalityProfileId === 'string' && personalityProfileId.trim()
					? personalityProfileId.trim()
					: undefined,
			skipPersistUserMessage: true,
		}),
	});

	const parsedRequest = await parseChatTurnRequest(syntheticBody, runtimeConfig, 'stream');
	if (!parsedRequest.ok) {
		return createStreamJsonErrorResponse(parsedRequest.error);
	}

	const preflight = await preflightChatTurn({
		userId: user.id,
		request: parsedRequest.value,
	});
	if (!preflight.ok) {
		return createStreamJsonErrorResponse(preflight.error);
	}

	const turn = preflight.value;

	const upstreamMessage = turn.normalizedMessage;
	const regenerationPromptAppendix = 'The user is regenerating their last request. Provide a completely fresh answer without referencing, acknowledging, or building upon your previous response to this same question. Do not mention that you answered this before. Start fresh as if this is the first time you are seeing this query.';
	const skillSystemPromptAppendix = buildSkillSystemPromptAppendix(
		turn.skillPromptContext,
	);
	const systemPromptAppendix = [
		skillSystemPromptAppendix,
		regenerationPromptAppendix,
	]
		.filter((value): value is string => Boolean(value?.trim()))
		.join('\n\n');

	const requestStartTime = Date.now();

	return runChatStreamOrchestrator({
		user: {
			id: user.id,
			displayName: user.displayName,
			email: user.email,
		},
		turn,
		upstreamMessage,
		downstreamAbortSignal: event.request.signal,
		requestStartTime,
		isReconnect: false,
		systemPromptAppendix,
	});
};
