import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/hooks', () => ({
	requireAdmin: vi.fn(),
}));

vi.mock('$lib/server/services/campaign-assets', () => ({
	CampaignAssetValidationError: class CampaignAssetValidationError extends Error {
		constructor(
			message: string,
			public readonly fieldErrors: Record<string, string>,
		) {
			super(message);
		}
	},
	storeCampaignSourceAsset: vi.fn(),
}));

import { POST } from './+server';
import { requireAdmin } from '$lib/server/auth/hooks';
import { storeCampaignSourceAsset } from '$lib/server/services/campaign-assets';

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockStoreCampaignSourceAsset = storeCampaignSourceAsset as ReturnType<typeof vi.fn>;

function makeUploadEvent(formData: FormData, user = { id: 'admin-user', role: 'admin' }) {
	return {
		request: {
			formData: vi.fn().mockResolvedValue(formData),
			headers: {
				get: vi.fn().mockReturnValue(null),
			},
		},
		locals: { user },
		params: {},
		url: new URL('http://localhost/api/admin/campaigns/assets/upload'),
		route: { id: '/api/admin/campaigns/assets/upload' },
	} as any;
}

describe('POST /api/admin/campaigns/assets/upload', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockStoreCampaignSourceAsset.mockResolvedValue({
			id: 'source-1',
			assetKind: 'source',
			status: 'draft',
			storagePath: 'sources/source-1.png',
			mimeType: 'image/png',
			sizeBytes: 9,
		});
	});

	it('requires admin access and stores an uploaded campaign screenshot source', async () => {
		const formData = new FormData();
		formData.set('image', new File([Buffer.from('png-bytes')], 'source.png', { type: 'image/png' }));
		formData.set('width', '2400');
		formData.set('height', '1500');

		const response = await POST(makeUploadEvent(formData));
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.asset).toMatchObject({ id: 'source-1', assetKind: 'source', status: 'draft' });
		expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
		expect(mockStoreCampaignSourceAsset).toHaveBeenCalledWith({
			uploadedByUserId: 'admin-user',
			file: {
				filename: 'source.png',
				mimeType: 'image/png',
				content: expect.any(Buffer),
			},
			dimensions: { width: 2400, height: 1500 },
		});
	});

	it('returns field errors when the image field is missing', async () => {
		const response = await POST(makeUploadEvent(new FormData()));
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.fieldErrors).toEqual({ image: 'Campaign screenshot image is required.' });
		expect(mockStoreCampaignSourceAsset).not.toHaveBeenCalled();
	});
});
