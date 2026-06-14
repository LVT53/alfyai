import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	CampaignAssetValidationError,
	getCampaignAssetForServing,
	saveCampaignCropAsset,
	saveModelIconAsset,
	storeCampaignSourceAsset,
	storeModelIconAsset,
} from "./campaign-assets";

describe("campaign asset service", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;
	let storageRoot: string;

	beforeEach(async () => {
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		storageRoot = await mkdtemp(join(tmpdir(), "alfyai-campaign-assets-"));

		db.insert(schema.users)
			.values({
				id: "admin-user",
				email: "admin@example.com",
				passwordHash: "hash",
				role: "admin",
				preferredModel: "model1",
			})
			.run();
		db.insert(schema.users)
			.values({
				id: "viewer-user",
				email: "viewer@example.com",
				passwordHash: "hash",
				role: "user",
				preferredModel: "model1",
			})
			.run();
	});

	afterEach(async () => {
		sqlite.close();
		await rm(storageRoot, { recursive: true, force: true });
	});

	it("stores uploaded screenshot sources as app-owned campaign assets", async () => {
		const result = await storeCampaignSourceAsset(
			{
				uploadedByUserId: "admin-user",
				file: {
					filename: "desktop capture.png",
					mimeType: "image/png",
					content: Buffer.from("png-bytes"),
				},
				dimensions: { width: 2400, height: 1500 },
			},
			{ db, storageRoot, id: "source-asset-1" },
		);

		expect(result).toMatchObject({
			id: "source-asset-1",
			uploadedByUserId: "admin-user",
			assetKind: "source",
			status: "draft",
			originalFilename: "desktop capture.png",
			mimeType: "image/png",
			sizeBytes: 9,
			width: 2400,
			height: 1500,
		});
		expect(result.storagePath).toBe("sources/source-asset-1.png");

		const stored = db
			.select()
			.from(schema.campaignAssets)
			.where(eq(schema.campaignAssets.id, "source-asset-1"))
			.get();
		expect(stored?.storagePath).toBe("sources/source-asset-1.png");
		await expect(
			readFile(join(storageRoot, result.storagePath), "utf8"),
		).resolves.toBe("png-bytes");
	});

	it("rejects unsupported or oversized screenshot uploads with field-level errors", async () => {
		await expect(
			storeCampaignSourceAsset(
				{
					uploadedByUserId: "admin-user",
					file: {
						filename: "notes.txt",
						mimeType: "text/plain",
						content: Buffer.from("not an image"),
					},
				},
				{ db, storageRoot, id: "bad-source" },
			),
		).rejects.toMatchObject({
			fieldErrors: { image: "Unsupported campaign image type." },
		});

		const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
		await expect(
			storeCampaignSourceAsset(
				{
					uploadedByUserId: "admin-user",
					file: {
						filename: "too-large.png",
						mimeType: "image/png",
						content: oversized,
					},
				},
				{ db, storageRoot, id: "large-source" },
			),
		).rejects.toBeInstanceOf(CampaignAssetValidationError);

		const rows = db.select().from(schema.campaignAssets).all();
		expect(rows).toHaveLength(0);
	});

	it("saves fixed-ratio crop content and geometry for an owned source asset", async () => {
		await storeCampaignSourceAsset(
			{
				uploadedByUserId: "admin-user",
				file: {
					filename: "source.png",
					mimeType: "image/png",
					content: Buffer.from("source-image"),
				},
				dimensions: { width: 2400, height: 1500 },
			},
			{ db, storageRoot, id: "source-asset-1" },
		);

		const crop = await saveCampaignCropAsset(
			{
				uploadedByUserId: "admin-user",
				sourceAssetId: "source-asset-1",
				variant: "desktop",
				file: {
					filename: "desktop-crop.webp",
					mimeType: "image/webp",
					content: Buffer.from("desktop-crop"),
				},
				dimensions: { width: 1600, height: 1000 },
				crop: { x: 120, y: 80, width: 960, height: 600, zoom: 1.5 },
			},
			{ db, storageRoot, id: "desktop-crop-1" },
		);

		expect(crop).toMatchObject({
			id: "desktop-crop-1",
			uploadedByUserId: "admin-user",
			sourceAssetId: "source-asset-1",
			assetKind: "crop",
			variant: "desktop",
			status: "draft",
			width: 1600,
			height: 1000,
			cropX: 120,
			cropY: 80,
			cropWidth: 960,
			cropHeight: 600,
			zoom: 1.5,
		});
		expect(JSON.parse(crop.cropMetadataJson ?? "{}")).toMatchObject({
			ratio: 1.6,
			sourceWidth: 2400,
			sourceHeight: 1500,
		});
		await expect(
			readFile(join(storageRoot, crop.storagePath), "utf8"),
		).resolves.toBe("desktop-crop");
	});

	it("stores model icons as published square campaign assets", async () => {
		const icon = await storeModelIconAsset(
			{
				uploadedByUserId: "admin-user",
				file: {
					filename: "model-icon.png",
					mimeType: "image/png",
					content: Buffer.from("icon-bytes"),
				},
				dimensions: { width: 512, height: 512 },
			},
			{ db, storageRoot, id: "model-icon-1" },
		);

		expect(icon).toMatchObject({
			id: "model-icon-1",
			assetKind: "model_icon",
			status: "published",
			width: 512,
			height: 512,
		});
		expect(icon.storagePath).toBe("model-icons/model-icon-1.png");
		await expect(
			readFile(join(storageRoot, icon.storagePath), "utf8"),
		).resolves.toBe("icon-bytes");
	});

	it("stores SVG model icons directly without raster dimensions", async () => {
		const icon = await storeModelIconAsset(
			{
				uploadedByUserId: "admin-user",
				file: {
					filename: "model-icon.svg",
					mimeType: "image/svg+xml",
					content: Buffer.from('<svg viewBox="0 0 24 24"></svg>'),
				},
			},
			{ db, storageRoot, id: "model-icon-svg" },
		);

		expect(icon).toMatchObject({
			id: "model-icon-svg",
			assetKind: "model_icon",
			status: "published",
			mimeType: "image/svg+xml",
			width: null,
			height: null,
		});
		expect(icon.storagePath).toBe("model-icons/model-icon-svg.svg");
		await expect(
			readFile(join(storageRoot, icon.storagePath), "utf8"),
		).resolves.toBe('<svg viewBox="0 0 24 24"></svg>');
	});

	it("rejects direct raster model icons that are not square", async () => {
		await expect(
			storeModelIconAsset(
				{
					uploadedByUserId: "admin-user",
					file: {
						filename: "wide-icon.png",
						mimeType: "image/png",
						content: Buffer.from("icon-bytes"),
					},
					dimensions: { width: 512, height: 256 },
				},
				{ db, storageRoot, id: "wide-icon" },
			),
		).rejects.toMatchObject({
			fieldErrors: { image: "Model icon must use a 1:1 image ratio." },
		});
	});

	it("saves square model icon crops from non-square source uploads", async () => {
		await storeCampaignSourceAsset(
			{
				uploadedByUserId: "admin-user",
				file: {
					filename: "wide-source.png",
					mimeType: "image/png",
					content: Buffer.from("wide-source"),
				},
				dimensions: { width: 1200, height: 600 },
			},
			{ db, storageRoot, id: "model-icon-source" },
		);

		const icon = await saveModelIconAsset(
			{
				uploadedByUserId: "admin-user",
				sourceAssetId: "model-icon-source",
				file: {
					filename: "model-icon.webp",
					mimeType: "image/webp",
					content: Buffer.from("square-crop"),
				},
				dimensions: { width: 512, height: 512 },
				crop: { x: 300, y: 0, width: 600, height: 600, zoom: 1 },
			},
			{ db, storageRoot, id: "cropped-model-icon" },
		);

		expect(icon).toMatchObject({
			id: "cropped-model-icon",
			assetKind: "model_icon",
			status: "published",
			sourceAssetId: "model-icon-source",
			width: 512,
			height: 512,
			cropX: 300,
			cropY: 0,
			cropWidth: 600,
			cropHeight: 600,
			zoom: 1,
		});
		expect(JSON.parse(icon.cropMetadataJson ?? "{}")).toMatchObject({
			ratio: 1,
			sourceWidth: 1200,
			sourceHeight: 600,
		});
		await expect(
			readFile(join(storageRoot, icon.storagePath), "utf8"),
		).resolves.toBe("square-crop");
	});

	it("serves draft assets only to admins and published assets to authenticated viewers", async () => {
		await storeCampaignSourceAsset(
			{
				uploadedByUserId: "admin-user",
				file: {
					filename: "source.png",
					mimeType: "image/png",
					content: Buffer.from("source-image"),
				},
			},
			{ db, storageRoot, id: "source-asset-1" },
		);

		const adminDraft = await getCampaignAssetForServing(
			"source-asset-1",
			{ id: "admin-user", role: "admin" },
			{ db, storageRoot },
		);
		expect(adminDraft).toMatchObject({ ok: true });
		if (adminDraft.ok) {
			expect(adminDraft.content.toString()).toBe("source-image");
		}

		await expect(
			getCampaignAssetForServing(
				"source-asset-1",
				{ id: "viewer-user", role: "user" },
				{ db, storageRoot },
			),
		).resolves.toEqual({
			ok: false,
			status: 403,
			error: "Campaign asset is not published",
		});

		db.update(schema.campaignAssets)
			.set({ status: "published" })
			.where(eq(schema.campaignAssets.id, "source-asset-1"))
			.run();

		const published = await getCampaignAssetForServing(
			"source-asset-1",
			{ id: "viewer-user", role: "user" },
			{ db, storageRoot },
		);
		expect(published).toMatchObject({ ok: true });
		if (published.ok) {
			expect(published.asset.status).toBe("published");
			expect(published.content.toString()).toBe("source-image");
		}
	});
});
