import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConversationMessages, capturedSyntheticBodies } = vi.hoisted(() => ({
	mockConversationMessages: [] as Array<{ id: string; role: string; content: string }>,
	capturedSyntheticBodies: [] as Array<Record<string, unknown>>,
}));

vi.mock('$lib/server/auth/hooks', () => ({
	requireAuth: vi.fn(),
}));

vi.mock('$lib/server/services/conversations', () => ({
	getConversation: vi.fn(async () => ({ id: 'conv-1' })),
}));

vi.mock('$lib/server/db', () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					orderBy: vi.fn(async () => mockConversationMessages),
				})),
			})),
		})),
	},
}));

vi.mock('$lib/server/services/messages', () => ({
	deleteMessages: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/config-store', () => ({
	getConfig: vi.fn(() => ({
		maxMessageLength: 10000,
		model1MaxMessageLength: 10000,
		model2MaxMessageLength: 10000,
		model1: { displayName: 'Model 1' },
		model2: { displayName: 'Model 2' },
	})),
}));

vi.mock('$lib/server/services/chat-turn/retry-cleanup', () => ({
	cleanupFailedTurn: vi.fn(async () => ({ steps: [], warnings: [] })),
}));

vi.mock('$lib/server/services/chat-turn/request', () => ({
	parseChatTurnRequest: vi.fn(async (request: Request) => {
		const body = await request.json();
		capturedSyntheticBodies.push(body);
		return {
			ok: true,
			value: {
				conversationId: body.conversationId,
				normalizedMessage: body.message,
				modelDisplayName: 'Model 1',
				modelId: 'model1',
				attachmentIds: [],
				skipPersistUserMessage: true,
			},
		};
	}),
}));

vi.mock('$lib/server/services/chat-turn/preflight', () => ({
	preflightChatTurn: vi.fn(async ({ request }) => ({
		ok: true,
		value: request,
	})),
}));

vi.mock('$lib/server/services/chat-turn/stream-orchestrator', () => ({
	runChatStreamOrchestrator: vi.fn(async () => new Response('retry stream')),
}));

import { POST } from './+server';
import { cleanupFailedTurn } from '$lib/server/services/chat-turn/retry-cleanup';
import { preflightChatTurn } from '$lib/server/services/chat-turn/preflight';
import { runChatStreamOrchestrator } from '$lib/server/services/chat-turn/stream-orchestrator';
import { deleteMessages } from '$lib/server/services/messages';

function makeEvent(body: Record<string, unknown>) {
	return {
		request: new Request('http://localhost/api/chat/retry', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
		locals: {
			user: {
				id: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
		},
		params: {},
	} as never;
}

describe('POST /api/chat/retry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedSyntheticBodies.length = 0;
		mockConversationMessages.splice(
			0,
			mockConversationMessages.length,
			{ id: 'user-1', role: 'user', content: 'first prompt' },
			{ id: 'assistant-1', role: 'assistant', content: 'first answer' },
			{ id: 'user-2', role: 'user', content: 'historical prompt' },
			{ id: 'assistant-2', role: 'assistant', content: 'historical answer' },
			{ id: 'user-3', role: 'user', content: 'latest prompt' },
			{ id: 'assistant-3', role: 'assistant', content: 'latest answer' },
		);
	});

	it('regenerates a historical assistant turn using its preceding user message', async () => {
		const response = await POST(
			makeEvent({
				conversationId: 'conv-1',
				assistantMessageId: 'assistant-2',
				userMessageId: 'user-2',
				userMessage: 'historical prompt',
			}),
		);

		expect(response.status).toBe(200);
		expect(cleanupFailedTurn).toHaveBeenCalledWith({
			userId: 'user-1',
			conversationId: 'conv-1',
			assistantMessageId: 'assistant-2',
		});
		expect(deleteMessages).toHaveBeenCalledWith(['assistant-2', 'user-3', 'assistant-3']);
		expect(capturedSyntheticBodies[0]?.message).toBe('historical prompt');
	});

	it('regenerates the latest assistant turn without selecting an older user message', async () => {
		const response = await POST(
			makeEvent({
				conversationId: 'conv-1',
				assistantMessageId: 'assistant-3',
				userMessageId: 'user-3',
				userMessage: 'latest prompt',
			}),
		);

		expect(response.status).toBe(200);
		expect(deleteMessages).toHaveBeenCalledWith(['assistant-3']);
		expect(capturedSyntheticBodies[0]?.message).toBe('latest prompt');
	});

	it('keeps active Skill prompt context when regenerating a response', async () => {
		(preflightChatTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			value: {
				conversationId: 'conv-1',
				normalizedMessage: 'latest prompt',
				modelDisplayName: 'Model 1',
				modelId: 'model1',
				attachmentIds: [],
				linkedSources: [],
				thinkingMode: 'auto',
				skipPersistUserMessage: true,
				skillPromptContext: {
					source: 'active_session',
					sessionId: 'session-1',
					sessionStatus: 'active',
					skillId: 'skill-1',
					skillOwnership: 'user',
					skillDisplayName: 'Meeting critic',
					skillDescription: 'Reviews notes',
					skillInstructions: 'Capture decisions before answering.',
					durationPolicy: 'session',
					questionPolicy: 'none',
					notesPolicy: 'create_private_notes',
					sourceScope: 'selected_sources_only',
					skillVersion: 1,
					linkedSources: [],
				},
			},
		});

		const response = await POST(
			makeEvent({
				conversationId: 'conv-1',
				assistantMessageId: 'assistant-3',
				userMessageId: 'user-3',
				userMessage: 'latest prompt',
			}),
		);

		expect(response.status).toBe(200);
		const options = (runChatStreamOrchestrator as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
		expect(options.systemPromptAppendix).toContain('Active Skill Context');
		expect(options.systemPromptAppendix).toContain('Capture decisions before answering.');
		expect(options.systemPromptAppendix).toContain('regenerating their last request');
	});

	it('rejects a mismatched user/assistant retry target', async () => {
		const response = await POST(
			makeEvent({
				conversationId: 'conv-1',
				assistantMessageId: 'assistant-2',
				userMessageId: 'user-3',
				userMessage: 'latest prompt',
			}),
		);

		expect(response.status).toBe(409);
		expect(cleanupFailedTurn).not.toHaveBeenCalled();
		expect(deleteMessages).not.toHaveBeenCalled();
	});
});
