import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config-store', () => ({
	getConfig: vi.fn(),
}));

vi.mock('$lib/server/services/linked-context-sources', () => ({
	addConversationLinkedContextSources: vi.fn(),
	isLinkedContextSourceError: (error: unknown) =>
		Boolean(error && typeof error === 'object' && 'code' in error && 'status' in error),
}));

import { getConfig } from '$lib/server/config-store';
import { addConversationLinkedContextSources } from '$lib/server/services/linked-context-sources';
import { POST } from './+server';

const mockGetConfig = vi.mocked(getConfig);
const mockAddSources = vi.mocked(addConversationLinkedContextSources);

function makeEvent(body: unknown) {
	return {
		locals: { user: { id: 'user-1', role: 'user' } },
		params: { id: 'conv-1' },
		request: new Request('http://localhost/api/conversations/conv-1/linked-sources', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
		url: new URL('http://localhost/api/conversations/conv-1/linked-sources'),
		route: { id: '/api/conversations/[id]/linked-sources' },
	} as Parameters<typeof POST>[0];
}

describe('POST /api/conversations/[id]/linked-sources', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true } as ReturnType<
			typeof getConfig
		>);
		mockAddSources.mockResolvedValue([]);
	});

	it('is unavailable when the Composer Command Registry is disabled', async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false } as ReturnType<
			typeof getConfig
		>);

		const response = await POST(makeEvent({ linkedSources: [] }));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe('composerCommandRegistry.disabled');
		expect(mockAddSources).not.toHaveBeenCalled();
	});

	it('persists validated linked context sources for the authenticated conversation', async () => {
		mockAddSources.mockResolvedValue([
			{
				displayArtifactId: 'display-1',
				promptArtifactId: 'prompt-1',
				familyArtifactIds: ['display-1', 'prompt-1'],
				name: 'Report.pdf',
				type: 'document',
			},
		]);

		const response = await POST(
			makeEvent({
				linkedSources: [
					{
						displayArtifactId: 'display-1',
						promptArtifactId: 'prompt-1',
						familyArtifactIds: ['display-1', 'prompt-1'],
						name: 'Report.pdf',
						type: 'document',
					},
				],
				attachmentIds: ['attachment-1'],
			})
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.linkedSources).toEqual([
			expect.objectContaining({ displayArtifactId: 'display-1', promptArtifactId: 'prompt-1' }),
		]);
		expect(mockAddSources).toHaveBeenCalledWith({
			userId: 'user-1',
			conversationId: 'conv-1',
			linkedSources: [
				expect.objectContaining({ displayArtifactId: 'display-1', type: 'document' }),
			],
			attachmentIds: ['attachment-1'],
		});
	});
});
