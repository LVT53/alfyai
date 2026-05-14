import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/services/conversation-drafts', () => ({
	clearConversationDraft: vi.fn(),
	upsertConversationDraft: vi.fn(),
}));

vi.mock('$lib/server/services/conversations', () => ({
	getConversation: vi.fn(),
}));

vi.mock('$lib/server/config-store', () => ({
	getConfig: vi.fn(),
}));

import { upsertConversationDraft } from '$lib/server/services/conversation-drafts';
import { getConversation } from '$lib/server/services/conversations';
import { getConfig } from '$lib/server/config-store';
import { PUT } from './+server';

const mockUpsert = vi.mocked(upsertConversationDraft);
const mockGetConversation = vi.mocked(getConversation);
const mockGetConfig = vi.mocked(getConfig);

function makeEvent(body: unknown) {
	return {
		locals: { user: { id: 'user-1', role: 'user' } },
		params: { id: 'conv-1' },
		request: new Request('http://localhost/api/conversations/conv-1/draft', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
		url: new URL('http://localhost/api/conversations/conv-1/draft'),
		route: { id: '/api/conversations/[id]/draft' },
	} as Parameters<typeof PUT>[0];
}

describe('PUT /api/conversations/[id]/draft', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConversation.mockResolvedValue({
			id: 'conv-1',
			userId: 'user-1',
			title: 'Conversation',
		} as Awaited<ReturnType<typeof getConversation>>);
		mockUpsert.mockResolvedValue(null);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true } as ReturnType<typeof getConfig>);
	});

	it('persists linked source draft state with text and selected attachments', async () => {
		const response = await PUT(
			makeEvent({
				draftText: 'Use this source later',
				selectedAttachmentIds: ['attachment-1'],
				selectedLinkedSources: [
					{
						displayArtifactId: 'display-1',
						promptArtifactId: 'prompt-1',
						familyArtifactIds: ['display-1', 'prompt-1'],
						name: 'Report.pdf',
						type: 'document',
					},
				],
				pendingSkill: {
					id: 'skill-1',
					ownership: 'user',
					displayName: 'Interview coach',
				},
			})
		);

		expect(response.status).toBe(200);
		expect(mockUpsert).toHaveBeenCalledWith({
			userId: 'user-1',
			conversationId: 'conv-1',
			draftText: 'Use this source later',
			selectedAttachmentIds: ['attachment-1'],
			selectedLinkedSources: [
				expect.objectContaining({
					displayArtifactId: 'display-1',
					promptArtifactId: 'prompt-1',
					type: 'document',
				}),
			],
			pendingSkill: {
				id: 'skill-1',
				ownership: 'user',
				displayName: 'Interview coach',
			},
		});
	});

	it('rejects pending skill draft state when Composer Command Registry is disabled', async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false } as ReturnType<typeof getConfig>);

		const response = await PUT(
			makeEvent({
				draftText: 'Use this later',
				selectedAttachmentIds: [],
				selectedLinkedSources: [],
				pendingSkill: {
					id: 'skill-1',
					ownership: 'user',
					displayName: 'Interview coach',
				},
			})
		);
		const data = await response.json();

		expect(response.status).toBe(403);
		expect(data.code).toBe('composer_commands_disabled');
		expect(mockUpsert).not.toHaveBeenCalled();
	});
});
