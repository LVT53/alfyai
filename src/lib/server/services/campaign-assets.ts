import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '$lib/server/db';
import { campaignAssets } from '$lib/server/db/schema';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/avif',
	'image/heic',
	'image/heif',
	'image/tiff',
	'image/bmp',
]);

const MIME_EXTENSIONS: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
	'image/heic': 'heic',
	'image/heif': 'heif',
	'image/tiff': 'tiff',
	'image/bmp': 'bmp',
};

type CampaignAssetDb = typeof defaultDb;

export type CampaignAssetVariant = 'desktop' | 'mobile';
export type CampaignAssetStatus = 'draft' | 'published';

export type CampaignImageInput = {
	filename: string;
	mimeType: string;
	content: Uint8Array;
};

export type CampaignImageDimensions = {
	width: number;
	height: number;
};

export type CampaignCropGeometry = {
	x: number;
	y: number;
	width: number;
	height: number;
	zoom: number;
};

export type CampaignAssetServiceOptions = {
	db?: CampaignAssetDb;
	storageRoot?: string;
	id?: string;
};

export class CampaignAssetValidationError extends Error {
	constructor(
		message: string,
		public readonly fieldErrors: Record<string, string>,
	) {
		super(message);
		this.name = 'CampaignAssetValidationError';
	}
}

export type CampaignAssetRecord = typeof campaignAssets.$inferSelect;

export type CampaignAssetReadResult =
	| { ok: true; asset: CampaignAssetRecord; content: Buffer }
	| { ok: false; status: 403 | 404; error: string };

function campaignAssetsRoot() {
	return join(process.cwd(), 'data', 'campaign-assets');
}

function getStorageRoot(options: CampaignAssetServiceOptions) {
	return options.storageRoot ?? campaignAssetsRoot();
}

function validateImageFile(file: CampaignImageInput): void {
	const fieldErrors: Record<string, string> = {};
	if (!file.filename.trim()) {
		fieldErrors.image = 'Image filename is required.';
	}
	if (!ALLOWED_IMAGE_TYPES.has(file.mimeType)) {
		fieldErrors.image = 'Unsupported campaign image type.';
	}
	if (file.content.byteLength === 0) {
		fieldErrors.image = 'Campaign image cannot be empty.';
	}
	if (file.content.byteLength > MAX_IMAGE_BYTES) {
		fieldErrors.image = 'Campaign image is too large.';
	}
	if (Object.keys(fieldErrors).length > 0) {
		throw new CampaignAssetValidationError('Invalid campaign image.', fieldErrors);
	}
}

function validateDimensions(dimensions?: CampaignImageDimensions): void {
	if (!dimensions) return;
	const fieldErrors: Record<string, string> = {};
	if (!Number.isInteger(dimensions.width) || dimensions.width <= 0) {
		fieldErrors.width = 'Image width must be a positive integer.';
	}
	if (!Number.isInteger(dimensions.height) || dimensions.height <= 0) {
		fieldErrors.height = 'Image height must be a positive integer.';
	}
	if (Object.keys(fieldErrors).length > 0) {
		throw new CampaignAssetValidationError('Invalid campaign image dimensions.', fieldErrors);
	}
}

function expectedRatioForVariant(variant: CampaignAssetVariant): number {
	return variant === 'desktop' ? 16 / 10 : 9 / 16;
}

function validateCropGeometry(variant: CampaignAssetVariant, crop: CampaignCropGeometry): void {
	const fieldErrors: Record<string, string> = {};
	for (const [field, value] of Object.entries(crop)) {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			fieldErrors[field] = `${field} must be a finite number.`;
		}
	}
	if (crop.x < 0) fieldErrors.x = 'Crop x must be zero or greater.';
	if (crop.y < 0) fieldErrors.y = 'Crop y must be zero or greater.';
	if (crop.width <= 0) fieldErrors.width = 'Crop width must be greater than zero.';
	if (crop.height <= 0) fieldErrors.height = 'Crop height must be greater than zero.';
	if (crop.zoom <= 0) fieldErrors.zoom = 'Crop zoom must be greater than zero.';

	const expected = expectedRatioForVariant(variant);
	const actual = crop.width / crop.height;
	if (Number.isFinite(actual) && Math.abs(actual - expected) > 0.01) {
		fieldErrors.crop = `Crop must use the ${variant === 'desktop' ? '16:10' : '9:16'} ratio.`;
	}

	if (Object.keys(fieldErrors).length > 0) {
		throw new CampaignAssetValidationError('Invalid campaign crop.', fieldErrors);
	}
}

function extensionForMime(mimeType: string): string {
	return MIME_EXTENSIONS[mimeType] ?? 'bin';
}

function scopedStoragePath(folder: 'sources' | 'crops', id: string, mimeType: string): string {
	return `${folder}/${id}.${extensionForMime(mimeType)}`;
}

async function writeAssetContent(
	storageRoot: string,
	storagePath: string,
	content: Uint8Array,
): Promise<void> {
	const filePath = join(storageRoot, storagePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content);
}

function safeAssetPath(storageRoot: string, storagePath: string): string | null {
	const normalizedPath = normalize(storagePath);
	if (normalizedPath.startsWith('..')) return null;
	return join(storageRoot, normalizedPath);
}

export async function storeCampaignSourceAsset(
	input: {
		uploadedByUserId: string;
		file: CampaignImageInput;
		dimensions?: CampaignImageDimensions;
	},
	options: CampaignAssetServiceOptions = {},
): Promise<CampaignAssetRecord> {
	validateImageFile(input.file);
	validateDimensions(input.dimensions);

	const database = options.db ?? defaultDb;
	const id = options.id ?? randomUUID();
	const storagePath = scopedStoragePath('sources', id, input.file.mimeType);
	await writeAssetContent(getStorageRoot(options), storagePath, input.file.content);

	const [row] = await database
		.insert(campaignAssets)
		.values({
			id,
			uploadedByUserId: input.uploadedByUserId,
			assetKind: 'source',
			status: 'draft',
			originalFilename: input.file.filename,
			mimeType: input.file.mimeType,
			sizeBytes: input.file.content.byteLength,
			storagePath,
			width: input.dimensions?.width ?? null,
			height: input.dimensions?.height ?? null,
		})
		.returning();

	return row;
}

export async function saveCampaignCropAsset(
	input: {
		uploadedByUserId: string;
		sourceAssetId: string;
		variant: CampaignAssetVariant;
		file: CampaignImageInput;
		dimensions?: CampaignImageDimensions;
		crop: CampaignCropGeometry;
	},
	options: CampaignAssetServiceOptions = {},
): Promise<CampaignAssetRecord> {
	validateImageFile(input.file);
	validateDimensions(input.dimensions);
	validateCropGeometry(input.variant, input.crop);

	const database = options.db ?? defaultDb;
	const sourceAsset = await getDraftSourceAssetForAdmin(input.sourceAssetId, options);
	if (!sourceAsset) {
		throw new CampaignAssetValidationError('Invalid campaign crop source.', {
			sourceAssetId: 'Source asset was not found.',
		});
	}

	const id = options.id ?? randomUUID();
	const storagePath = scopedStoragePath('crops', id, input.file.mimeType);
	await writeAssetContent(getStorageRoot(options), storagePath, input.file.content);

	const cropMetadata = {
		ratio: expectedRatioForVariant(input.variant),
		sourceAssetId: sourceAsset.id,
		sourceWidth: sourceAsset.width,
		sourceHeight: sourceAsset.height,
		x: input.crop.x,
		y: input.crop.y,
		width: input.crop.width,
		height: input.crop.height,
		zoom: input.crop.zoom,
	};

	const [row] = await database
		.insert(campaignAssets)
		.values({
			id,
			uploadedByUserId: input.uploadedByUserId,
			sourceAssetId: sourceAsset.id,
			assetKind: 'crop',
			variant: input.variant,
			status: 'draft',
			originalFilename: input.file.filename,
			mimeType: input.file.mimeType,
			sizeBytes: input.file.content.byteLength,
			storagePath,
			width: input.dimensions?.width ?? null,
			height: input.dimensions?.height ?? null,
			cropX: input.crop.x,
			cropY: input.crop.y,
			cropWidth: input.crop.width,
			cropHeight: input.crop.height,
			zoom: input.crop.zoom,
			cropMetadataJson: JSON.stringify(cropMetadata),
		})
		.returning();

	return row;
}

export async function getCampaignAssetForServing(
	assetId: string,
	user: { id: string; role?: string },
	options: CampaignAssetServiceOptions = {},
): Promise<CampaignAssetReadResult> {
	const database = options.db ?? defaultDb;
	const asset = await database
		.select()
		.from(campaignAssets)
		.where(eq(campaignAssets.id, assetId))
		.get();
	if (!asset) {
		return { ok: false, status: 404, error: 'Campaign asset not found' };
	}

	const isAdmin = user.role === 'admin';
	if (!isAdmin && asset.status !== 'published') {
		return { ok: false, status: 403, error: 'Campaign asset is not published' };
	}

	const filePath = safeAssetPath(getStorageRoot(options), asset.storagePath);
	if (!filePath) {
		return { ok: false, status: 404, error: 'Campaign asset not found' };
	}

	try {
		return { ok: true, asset, content: await readFile(filePath) };
	} catch {
		return { ok: false, status: 404, error: 'Campaign asset not found' };
	}
}

export async function getDraftSourceAssetForAdmin(
	assetId: string,
	options: CampaignAssetServiceOptions = {},
): Promise<CampaignAssetRecord | null> {
	const database = options.db ?? defaultDb;
	const asset = await database
		.select()
		.from(campaignAssets)
		.where(
			and(
				eq(campaignAssets.id, assetId),
				eq(campaignAssets.assetKind, 'source'),
				eq(campaignAssets.status, 'draft'),
			),
		)
		.get();

	return asset ?? null;
}

export function markCampaignAssetsPublished(
	assetIds: string[],
	options: CampaignAssetServiceOptions = {},
): void {
	const uniqueIds = [...new Set(assetIds.filter((id) => id.trim().length > 0))];
	if (uniqueIds.length === 0) return;

	const database = options.db ?? defaultDb;
	database
		.update(campaignAssets)
		.set({ status: 'published', updatedAt: new Date() })
		.where(inArray(campaignAssets.id, uniqueIds))
		.run();
}
