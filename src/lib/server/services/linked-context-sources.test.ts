import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDocumentItem, LinkedContextSource } from '$lib/types';

vi.mock('$lib/server/services/conversations', () => ({
	getConversation: vi.fn(),
}));

vi.mock('$lib/server/services/knowledge', () => ({
	listKnowledgeArtifacts: vi.fn(),
}));

import { getConversation } from '$lib/server/services/conversations';
import { listKnowledgeArtifacts } from '$lib/server/services/knowledge';
import { resolveLinkedContextSourcesForConversation } from './linked-context-sources';

const mockGetConversation = vi.mocked(getConversation);
const mockListKnowledgeArtifacts = vi.mocked(listKnowledgeArtifacts);

function makeDocument(overrides: Partial<KnowledgeDocumentItem> = {}): KnowledgeDocumentItem {
	return {
		id: overrides.id ?? 'display-1',
		displayArtifactId: overrides.displayArtifactId ?? 'display-1',
		promptArtifactId: overrides.promptArtifactId ?? 'prompt-1',
		familyArtifactIds: overrides.familyArtifactIds ?? ['display-1', 'prompt-1'],
		name: overrides.name ?? 'Report.pdf',
		mimeType: overrides.mimeType ?? 'application/pdf',
		sizeBytes: overrides.sizeBytes ?? 12,
		conversationId: overrides.conversationId ?? null,
		summary: overrides.summary ?? null,
		normalizedAvailable: overrides.normalizedAvailable ?? true,
		documentOrigin: overrides.documentOrigin ?? 'uploaded',
		createdAt: overrides.createdAt ?? 1,
		updatedAt: overrides.updatedAt ?? 2,
	};
}

function makeSource(overrides: Partial<LinkedContextSource> = {}): LinkedContextSource {
	return {
		displayArtifactId: overrides.displayArtifactId ?? 'display-1',
		promptArtifactId: overrides.promptArtifactId ?? 'prompt-1',
		familyArtifactIds: overrides.familyArtifactIds ?? ['display-1', 'prompt-1'],
		name: overrides.name ?? 'Client supplied name.pdf',
		type: 'document',
	};
}

describe('linked context sources', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConversation.mockResolvedValue({
			id: 'conv-1',
			userId: 'user-1',
			title: 'Conversation',
		} as Awaited<ReturnType<typeof getConversation>>);
		mockListKnowledgeArtifacts.mockResolvedValue({
			documents: [makeDocument()],
			results: [],
			workflows: [],
		});
	});

	it('rejects a conversation-scoped source write for a conversation outside the user scope', async () => {
		mockGetConversation.mockResolvedValue(null);

		await expect(
			resolveLinkedContextSourcesForConversation({
				userId: 'user-1',
				conversationId: 'conv-1',
				linkedSources: [makeSource()],
				attachmentIds: [],
			})
		).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
	});

	it('canonicalizes logical documents and lets upload attachments win dedupe conflicts', async () => {
		const resolved = await resolveLinkedContextSourcesForConversation({
			userId: 'user-1',
			conversationId: 'conv-1',
			linkedSources: [
				makeSource({ name: 'stale client title.pdf' }),
				makeSource({ displayArtifactId: 'prompt-1', promptArtifactId: 'prompt-1' }),
			],
			attachmentIds: ['prompt-1'],
		});

		expect(resolved).toEqual([]);
		expect(mockListKnowledgeArtifacts).toHaveBeenCalledWith('user-1');
	});

	it('rejects linked documents that are not ready for prompt context', async () => {
		mockListKnowledgeArtifacts.mockResolvedValue({
			documents: [
				makeDocument({
					promptArtifactId: null,
					familyArtifactIds: ['display-1'],
					normalizedAvailable: false,
				}),
			],
			results: [],
			workflows: [],
		});

		await expect(
			resolveLinkedContextSourcesForConversation({
				userId: 'user-1',
				conversationId: 'conv-1',
				linkedSources: [
					makeSource({
						promptArtifactId: null,
						familyArtifactIds: ['display-1'],
					}),
				],
				attachmentIds: [],
			})
		).rejects.toMatchObject({
			code: 'linked_source_not_prompt_ready',
			status: 409,
		});
	});
});
