import { type FetchLike, requestJson } from "./http";

export type CampaignAssetVariant = "desktop" | "mobile";

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
	assetKind: "source" | "crop" | "model_icon";
	variant?: CampaignAssetVariant | null;
	status: "draft" | "published";
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

type CampaignAssetImageFormInput = {
	image: File;
	width?: number;
	height?: number;
};

type CampaignAssetCropFormInput = CampaignAssetImageFormInput & {
	crop: CampaignAssetCropGeometry;
};

function appendOptionalImageDimensions(
	formData: FormData,
	input: Pick<CampaignAssetImageFormInput, "width" | "height">,
): void {
	if (input.width) formData.set("width", String(input.width));
	if (input.height) formData.set("height", String(input.height));
}

function createCampaignAssetUploadFormData(
	input: CampaignAssetImageFormInput,
): FormData {
	const formData = new FormData();
	formData.set("image", input.image);
	appendOptionalImageDimensions(formData, input);
	return formData;
}

function createCampaignAssetCropFormData(
	input: CampaignAssetCropFormInput,
	options: { variant?: CampaignAssetVariant } = {},
): FormData {
	const formData = new FormData();
	formData.set("image", input.image);
	if (options.variant) formData.set("variant", options.variant);
	formData.set("crop", JSON.stringify(input.crop));
	appendOptionalImageDimensions(formData, input);
	return formData;
}

export type CampaignAssetMetadata = {
	id: string;
	assetKind: "source" | "crop" | "model_icon";
	variant?: CampaignAssetVariant | null;
	status: "draft" | "published";
	sourceAssetId?: string | null;
	originalFilename: string;
	mimeType: string;
	sizeBytes: number;
	width?: number | null;
	height?: number | null;
};

/**
 * Metadata for an attached campaign asset, so the slide editor can name the
 * screenshot and offer Re-crop (which needs the crop's source asset).
 */
export async function fetchAdminCampaignAsset(
	assetId: string,
	fetchImpl: FetchLike = fetch,
): Promise<CampaignAssetMetadata> {
	const response = await requestJson<{ asset: CampaignAssetMetadata }>(
		`/api/admin/campaigns/assets/${encodeURIComponent(assetId)}`,
		undefined,
		"Failed to load campaign screenshot details",
		fetchImpl,
	);
	return response.asset;
}

export async function uploadCampaignAssetSource(
	input: {
		image: File;
		width?: number;
		height?: number;
	},
	fetchImpl: FetchLike = fetch,
): Promise<CampaignAsset> {
	const formData = createCampaignAssetUploadFormData(input);

	const response = await requestJson<CampaignAssetResponse>(
		"/api/admin/campaigns/assets/upload",
		{ method: "POST", body: formData },
		"Failed to upload campaign screenshot",
		fetchImpl,
	);
	return response.asset;
}

export async function uploadModelIconAsset(
	input: {
		image: File;
		width?: number;
		height?: number;
	},
	fetchImpl: FetchLike = fetch,
): Promise<CampaignAsset> {
	const formData = createCampaignAssetUploadFormData(input);

	const response = await requestJson<CampaignAssetResponse>(
		"/api/admin/model-icons/upload",
		{ method: "POST", body: formData },
		"Failed to upload model icon",
		fetchImpl,
	);
	return response.asset;
}

export async function saveModelIconAssetCrop(
	input: {
		sourceAssetId: string;
		image: File;
		width?: number;
		height?: number;
		crop: CampaignAssetCropGeometry;
	},
	fetchImpl: FetchLike = fetch,
): Promise<CampaignAsset> {
	const formData = createCampaignAssetCropFormData(input);

	const response = await requestJson<CampaignAssetResponse>(
		`/api/admin/model-icons/${encodeURIComponent(input.sourceAssetId)}/crop`,
		{ method: "POST", body: formData },
		"Failed to save model icon crop",
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
	const formData = createCampaignAssetCropFormData(input, {
		variant: input.variant,
	});

	const response = await requestJson<CampaignAssetResponse>(
		`/api/admin/campaigns/assets/${encodeURIComponent(input.sourceAssetId)}/crop`,
		{ method: "POST", body: formData },
		"Failed to save campaign screenshot crop",
		fetchImpl,
	);
	return response.asset;
}
