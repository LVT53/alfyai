import { describe, expect, it, vi } from 'vitest';
import { saveCampaignAssetCrop, uploadCampaignAssetSource } from './campaign-assets';

describe('campaign asset client API', () => {
	it('uploads campaign source screenshots as multipart form data', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ asset: { id: 'source-1' } }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const file = new File(['source'], 'source.png', { type: 'image/png' });
		const asset = await uploadCampaignAssetSource({ image: file, width: 2400, height: 1500 }, fetchImpl);

		expect(asset).toEqual({ id: 'source-1' });
		expect(fetchImpl).toHaveBeenCalledWith(
			'/api/admin/campaigns/assets/upload',
			expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
		);
		const body = fetchImpl.mock.calls[0][1].body as FormData;
		expect(body.get('image')).toBe(file);
		expect(body.get('width')).toBe('2400');
		expect(body.get('height')).toBe('1500');
	});

	it('saves campaign crops as multipart form data', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ asset: { id: 'crop-1' } }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const file = new File(['crop'], 'desktop.webp', { type: 'image/webp' });
		const crop = { x: 10, y: 20, width: 160, height: 100, zoom: 1.2 };
		const asset = await saveCampaignAssetCrop(
			{
				sourceAssetId: 'source-1',
				variant: 'desktop',
				image: file,
				width: 1600,
				height: 1000,
				crop,
			},
			fetchImpl,
		);

		expect(asset).toEqual({ id: 'crop-1' });
		expect(fetchImpl).toHaveBeenCalledWith(
			'/api/admin/campaigns/assets/source-1/crop',
			expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
		);
		const body = fetchImpl.mock.calls[0][1].body as FormData;
		expect(body.get('variant')).toBe('desktop');
		expect(body.get('image')).toBe(file);
		expect(JSON.parse(String(body.get('crop')))).toEqual(crop);
	});
});
