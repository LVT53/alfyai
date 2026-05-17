import { requestJson, type FetchLike } from './http';

export type CampaignAssetVariant = 'desktop' | 'mobile';

export type CampaignAssetCropGeometry = {
	x: number;
	y: number;
	width: number;
	height: number;
	zoom: number;
};

export type CampaignAsset = {
	id: string;
	uploadedByUserId?: string;
	sourceAssetId?: string | null;
	assetKind: 'source' | 'crop';
	variant?: CampaignAssetVariant | null;
	status: 'draft' | 'published';
	originalFilename?: string;
	mimeType: string;
	sizeBytes: number;
	storagePath?: string;
	width?: number | null;
	height?: number | null;
	cropX?: number | null;
	cropY?: number | null;
	cropWidth?: number | null;
	cropHeight?: number | null;
	zoom?: number | null;
	cropMetadataJson?: string | null;
	createdAt?: string | number;
	updatedAt?: string | number;
};

type CampaignAssetResponse = {
	asset: CampaignAsset;
};

export async function uploadCampaignAssetSource(
	input: {
		image: File;
		width?: number;
		height?: number;
	},
	fetchImpl: FetchLike = fetch,
): Promise<CampaignAsset> {
	const formData = new FormData();
	formData.set('image', input.image);
	if (input.width) formData.set('width', String(input.width));
	if (input.height) formData.set('height', String(input.height));

	const response = await requestJson<CampaignAssetResponse>(
		'/api/admin/campaigns/assets/upload',
		{ method: 'POST', body: formData },
		'Failed to upload campaign screenshot',
		fetchImpl,
	);
	return response.asset;
}

export async function saveCampaignAssetCrop(
	input: {
		sourceAssetId: string;
		variant: CampaignAssetVariant;
		image: File;
		width?: number;
		height?: number;
		crop: CampaignAssetCropGeometry;
	},
	fetchImpl: FetchLike = fetch,
): Promise<CampaignAsset> {
	const formData = new FormData();
	formData.set('image', input.image);
	formData.set('variant', input.variant);
	formData.set('crop', JSON.stringify(input.crop));
	if (input.width) formData.set('width', String(input.width));
	if (input.height) formData.set('height', String(input.height));

	const response = await requestJson<CampaignAssetResponse>(
		`/api/admin/campaigns/assets/${encodeURIComponent(input.sourceAssetId)}/crop`,
		{ method: 'POST', body: formData },
		'Failed to save campaign screenshot crop',
		fetchImpl,
	);
	return response.asset;
}
