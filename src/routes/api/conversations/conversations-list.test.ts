import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/hooks', () => ({
	requireAuth: vi.fn(),
}));

vi.mock('$lib/server/services/conversations', () => ({
	listConversations: vi.fn(),
	createConversation: vi.fn(),
}));

import { GET } from './+server';
import { requireAuth } from '$lib/server/auth/hooks';
import { listConversations } from '$lib/server/services/conversations';

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockListConversations = listConversations as ReturnType<typeof vi.fn>;

function makeEvent(user = { id: 'user-1' }) {
	return {
		request: new Request('http://localhost/api/conversations'),
		locals: { user },
		params: {},
		url: new URL('http://localhost/api/conversations'),
		route: { id: '/api/conversations' },
	} as any;
}

describe('GET /api/conversations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it('returns minimal fork summaries for sidebar indicators', async () => {
		mockListConversations.mockResolvedValue([
			{
				id: 'fork-conv',
				title: 'Source title (fork 1)',
				updatedAt: 1,
				projectId: null,
				forkSummary: {
					sourceTitle: 'Source title',
					forkSequence: 1,
					sourceConversationId: 'source-conv',
					sourceConversationIdAvailable: true,
				},
			},
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockListConversations).toHaveBeenCalledWith('user-1');
		expect(data.conversations).toEqual([
			{
				id: 'fork-conv',
				title: 'Source title (fork 1)',
				updatedAt: 1,
				projectId: null,
				forkSummary: {
					sourceTitle: 'Source title',
					forkSequence: 1,
					sourceConversationId: 'source-conv',
					sourceConversationIdAvailable: true,
				},
			},
		]);
	});
});
