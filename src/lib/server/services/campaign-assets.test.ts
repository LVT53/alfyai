import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import {
	CampaignAssetValidationError,
	getCampaignAssetForServing,
	saveCampaignCropAsset,
	storeCampaignSourceAsset,
} from './campaign-assets';

describe('campaign asset service', () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;
	let storageRoot: string;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: './drizzle' });
		storageRoot = await mkdtemp(join(tmpdir(), 'alfyai-campaign-assets-'));

		db.insert(schema.users)
			.values({
				id: 'admin-user',
				email: 'admin@example.com',
				passwordHash: 'hash',
				role: 'admin',
				preferredModel: 'model1',
			})
			.run();
		db.insert(schema.users)
			.values({
				id: 'viewer-user',
				email: 'viewer@example.com',
				passwordHash: 'hash',
				role: 'user',
				preferredModel: 'model1',
			})
			.run();
	});

	afterEach(async () => {
		sqlite.close();
		await rm(storageRoot, { recursive: true, force: true });
	});

	it('stores uploaded screenshot sources as app-owned campaign assets', async () => {
		const result = await storeCampaignSourceAsset(
			{
				uploadedByUserId: 'admin-user',
				file: {
					filename: 'desktop capture.png',
					mimeType: 'image/png',
					content: Buffer.from('png-bytes'),
				},
				dimensions: { width: 2400, height: 1500 },
			},
			{ db, storageRoot, id: 'source-asset-1' },
		);

		expect(result).toMatchObject({
			id: 'source-asset-1',
			uploadedByUserId: 'admin-user',
			assetKind: 'source',
			status: 'draft',
			originalFilename: 'desktop capture.png',
			mimeType: 'image/png',
			sizeBytes: 9,
			width: 2400,
			height: 1500,
		});
		expect(result.storagePath).toBe('sources/source-asset-1.png');

		const stored = db
			.select()
			.from(schema.campaignAssets)
			.where(eq(schema.campaignAssets.id, 'source-asset-1'))
			.get();
		expect(stored?.storagePath).toBe('sources/source-asset-1.png');
		await expect(readFile(join(storageRoot, result.storagePath), 'utf8')).resolves.toBe('png-bytes');
	});

	it('rejects unsupported or oversized screenshot uploads with field-level errors', async () => {
		await expect(
			storeCampaignSourceAsset(
				{
					uploadedByUserId: 'admin-user',
					file: {
						filename: 'notes.txt',
						mimeType: 'text/plain',
						content: Buffer.from('not an image'),
					},
				},
				{ db, storageRoot, id: 'bad-source' },
			),
		).rejects.toMatchObject({
			fieldErrors: { image: 'Unsupported campaign image type.' },
		});

		const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
		await expect(
			storeCampaignSourceAsset(
				{
					uploadedByUserId: 'admin-user',
					file: {
						filename: 'too-large.png',
						mimeType: 'image/png',
						content: oversized,
					},
				},
				{ db, storageRoot, id: 'large-source' },
			),
		).rejects.toBeInstanceOf(CampaignAssetValidationError);

		const rows = db.select().from(schema.campaignAssets).all();
		expect(rows).toHaveLength(0);
	});

	it('saves fixed-ratio crop content and geometry for an owned source asset', async () => {
		await storeCampaignSourceAsset(
			{
				uploadedByUserId: 'admin-user',
				file: {
					filename: 'source.png',
					mimeType: 'image/png',
					content: Buffer.from('source-image'),
				},
				dimensions: { width: 2400, height: 1500 },
			},
			{ db, storageRoot, id: 'source-asset-1' },
		);

		const crop = await saveCampaignCropAsset(
			{
				uploadedByUserId: 'admin-user',
				sourceAssetId: 'source-asset-1',
				variant: 'desktop',
				file: {
					filename: 'desktop-crop.webp',
					mimeType: 'image/webp',
					content: Buffer.from('desktop-crop'),
				},
				dimensions: { width: 1600, height: 1000 },
				crop: { x: 120, y: 80, width: 960, height: 600, zoom: 1.5 },
			},
			{ db, storageRoot, id: 'desktop-crop-1' },
		);

		expect(crop).toMatchObject({
			id: 'desktop-crop-1',
			uploadedByUserId: 'admin-user',
			sourceAssetId: 'source-asset-1',
			assetKind: 'crop',
			variant: 'desktop',
			status: 'draft',
			width: 1600,
			height: 1000,
			cropX: 120,
			cropY: 80,
			cropWidth: 960,
			cropHeight: 600,
			zoom: 1.5,
		});
		expect(JSON.parse(crop.cropMetadataJson ?? '{}')).toMatchObject({
			ratio: 1.6,
			sourceWidth: 2400,
			sourceHeight: 1500,
		});
		await expect(readFile(join(storageRoot, crop.storagePath), 'utf8')).resolves.toBe('desktop-crop');
	});

	it('serves draft assets only to admins and published assets to authenticated viewers', async () => {
		await storeCampaignSourceAsset(
			{
				uploadedByUserId: 'admin-user',
				file: {
					filename: 'source.png',
					mimeType: 'image/png',
					content: Buffer.from('source-image'),
				},
			},
			{ db, storageRoot, id: 'source-asset-1' },
		);

		const adminDraft = await getCampaignAssetForServing(
			'source-asset-1',
			{ id: 'admin-user', role: 'admin' },
			{ db, storageRoot },
		);
		expect(adminDraft).toMatchObject({ ok: true });
		if (adminDraft.ok) {
			expect(adminDraft.content.toString()).toBe('source-image');
		}

		await expect(
			getCampaignAssetForServing(
				'source-asset-1',
				{ id: 'viewer-user', role: 'user' },
				{ db, storageRoot },
			),
		).resolves.toEqual({
			ok: false,
			status: 403,
			error: 'Campaign asset is not published',
		});

		db.update(schema.campaignAssets)
			.set({ status: 'published' })
			.where(eq(schema.campaignAssets.id, 'source-asset-1'))
			.run();

		const published = await getCampaignAssetForServing(
			'source-asset-1',
			{ id: 'viewer-user', role: 'user' },
			{ db, storageRoot },
		);
		expect(published).toMatchObject({ ok: true });
		if (published.ok) {
			expect(published.asset.status).toBe('published');
			expect(published.content.toString()).toBe('source-image');
		}
	});
});
