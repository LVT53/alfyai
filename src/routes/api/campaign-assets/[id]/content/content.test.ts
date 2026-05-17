import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/hooks', () => ({
	requireAuth: vi.fn(),
}));

vi.mock('$lib/server/services/campaign-assets', () => ({
	getCampaignAssetForServing: vi.fn(),
}));

import { GET } from './+server';
import { requireAuth } from '$lib/server/auth/hooks';
import { getCampaignAssetForServing } from '$lib/server/services/campaign-assets';

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetCampaignAssetForServing = getCampaignAssetForServing as ReturnType<typeof vi.fn>;

function makeEvent(user = { id: 'viewer-user', role: 'user' }, assetId = 'asset-1') {
	return {
		request: new Request(`http://localhost/api/campaign-assets/${assetId}/content`),
		locals: { user },
		params: { id: assetId },
		url: new URL(`http://localhost/api/campaign-assets/${assetId}/content`),
		route: { id: '/api/campaign-assets/[id]/content' },
	} as any;
}

describe('GET /api/campaign-assets/[id]/content', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it('serves an authenticated campaign asset with private caching', async () => {
		mockGetCampaignAssetForServing.mockResolvedValue({
			ok: true,
			asset: {
				id: 'asset-1',
				mimeType: 'image/webp',
				sizeBytes: 10,
				originalFilename: 'desktop.webp',
				status: 'published',
			},
			content: Buffer.from('asset-data'),
		});

		const response = await GET(makeEvent());

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/webp');
		expect(response.headers.get('Content-Length')).toBe('10');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
		expect(await response.text()).toBe('asset-data');
		expect(mockGetCampaignAssetForServing).toHaveBeenCalledWith('asset-1', {
			id: 'viewer-user',
			role: 'user',
		});
	});

	it('returns the service access status for draft or missing assets', async () => {
		mockGetCampaignAssetForServing.mockResolvedValue({
			ok: false,
			status: 403,
			error: 'Campaign asset is not published',
		});

		const response = await GET(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(403);
		expect(body.error).toBe('Campaign asset is not published');
	});
});
