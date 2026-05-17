import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '$lib/server/db/schema';
import {
	archiveCampaign,
	completeCampaignForUser,
	createCampaignDraft,
	deleteCampaignDraft,
	duplicateCampaignAsDraft,
	getEligibleCampaignForUser,
	getCampaignById,
	getLatestPublishedCampaign,
	getCampaignAnalyticsSummary,
	publishCampaign,
	recordCampaignEvent,
	seedFirstRunOnboardingTemplate,
	updateCampaignDraft,
} from './announcement-campaigns';

describe('announcement campaign service', () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: './drizzle' });

		db.insert(schema.users)
			.values([
				{
					id: 'admin-user',
					email: 'admin@example.com',
					passwordHash: 'hash',
					role: 'admin',
				},
				{
					id: 'viewer-user',
					email: 'viewer@example.com',
					passwordHash: 'hash',
					role: 'user',
				},
			])
			.run();
	});

	afterEach(() => {
		sqlite.close();
	});

	function insertCrop(id: string, variant: 'desktop' | 'mobile') {
		db.insert(schema.campaignAssets)
			.values({
				id,
				uploadedByUserId: 'admin-user',
				assetKind: 'crop',
				variant,
				status: 'draft',
				originalFilename: `${id}.png`,
				mimeType: 'image/png',
				sizeBytes: 12,
				storagePath: `crops/${id}.png`,
			})
			.run();
	}

	function insertRequiredCrops(prefix: string) {
		insertCrop(`${prefix}-desktop`, 'desktop');
		insertCrop(`${prefix}-mobile`, 'mobile');
	}

	it('creates editable draft campaigns with system-generated identity and localized slides', async () => {
		const draft = await createCampaignDraft(
			{
				type: 'first_run_onboarding',
				name: 'First-run onboarding',
				createdByUserId: 'admin-user',
			},
			{ db, ids: ['campaign-1'] },
		);

		expect(draft).toMatchObject({
			id: 'campaign-1',
			type: 'first_run_onboarding',
			status: 'draft',
			identityKey: 'first_run_onboarding:v1:r1',
			campaignVersion: 'v1',
			revision: 1,
			name: 'First-run onboarding',
			releaseVersion: null,
			slides: [],
		});

		const updated = await updateCampaignDraft(
			'campaign-1',
			{
				name: 'Edited onboarding',
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 10,
						title: { en: 'Set up AlfyAI', hu: 'AlfyAI beállítása' },
						body: { en: 'Choose your starting defaults.', hu: 'Válaszd ki a kezdő beállításokat.' },
						altText: { en: 'Settings preview', hu: 'Beállítások előnézete' },
					},
				],
			},
			{ db },
		);

		expect(updated.name).toBe('Edited onboarding');
		expect(updated.identityKey).toBe('first_run_onboarding:v1:r1');
		expect(updated.slides).toHaveLength(1);
		expect(updated.slides[0]).toMatchObject({
			id: 'slide-setup',
			layoutType: 'setup',
			sortOrder: 10,
			title: { en: 'Set up AlfyAI', hu: 'AlfyAI beállítása' },
			body: { en: 'Choose your starting defaults.', hu: 'Válaszd ki a kezdő beállításokat.' },
			altText: { en: 'Settings preview', hu: 'Beállítások előnézete' },
		});
	});

	it('publishes a valid first-run draft into immutable snapshot content and publishes crop assets', async () => {
		insertRequiredCrops('setup');
		insertRequiredCrops('disclosure');

		await createCampaignDraft(
			{ type: 'first_run_onboarding', name: 'Onboarding', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);
		await updateCampaignDraft(
			'campaign-1',
			{
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 1,
						title: { en: 'Set up', hu: 'Beállítás' },
						body: { en: 'Choose defaults.', hu: 'Válassz alapokat.' },
						altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
						desktopCropAssetId: 'setup-desktop',
						mobileCropAssetId: 'setup-mobile',
						setupControls: ['ui_language', 'theme', 'model_default', 'ai_style'],
					},
					{
						id: 'slide-disclosure',
						layoutType: 'standard',
						semanticRole: 'data_disclosure',
						sortOrder: 2,
						title: { en: 'Data use', hu: 'Adathasználat' },
						body: { en: 'Messages and files may use configured providers.', hu: 'Az üzenetek és fájlok konfigurált szolgáltatókat használhatnak.' },
						altText: { en: 'Data disclosure screenshot', hu: 'Adatkezelési képernyőkép' },
						desktopCropAssetId: 'disclosure-desktop',
						mobileCropAssetId: 'disclosure-mobile',
					},
				],
			},
			{ db },
		);

		const published = await publishCampaign('campaign-1', 'admin-user', { db, ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2'] });
		expect(published.status).toBe('published');
		expect(published.snapshot?.slides.map((slide) => slide.title.en)).toEqual(['Set up', 'Data use']);

		await expect(
			updateCampaignDraft(
				'campaign-1',
				{
					name: 'Edited after publish',
					slides: [
						{
							id: 'slide-setup',
							layoutType: 'setup',
							sortOrder: 1,
							title: { en: 'Changed', hu: 'Módosítva' },
							body: { en: 'Changed body.', hu: 'Módosított törzs.' },
							altText: { en: 'Changed alt', hu: 'Módosított alt' },
							desktopCropAssetId: 'setup-desktop',
							mobileCropAssetId: 'setup-mobile',
						},
					],
				},
				{ db },
			),
		).rejects.toMatchObject({
			fieldErrors: { status: 'Only draft campaigns can be edited.' },
		});

		const latest = await getLatestPublishedCampaign({ db });
		expect(latest?.slides.map((slide) => slide.title.en)).toEqual(['Set up', 'Data use']);

		const assets = db
			.select({ id: schema.campaignAssets.id, status: schema.campaignAssets.status })
			.from(schema.campaignAssets)
			.all();
		expect(assets).toEqual(
			expect.arrayContaining([
				{ id: 'setup-desktop', status: 'published' },
				{ id: 'setup-mobile', status: 'published' },
				{ id: 'disclosure-desktop', status: 'published' },
				{ id: 'disclosure-mobile', status: 'published' },
			]),
		);
	});

	it('returns publish validation errors for incomplete campaigns and type-specific requirements', async () => {
		await createCampaignDraft(
			{ type: 'release_update', name: 'Release notes', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);

		await expect(publishCampaign('campaign-1', 'admin-user', { db })).rejects.toMatchObject({
			fieldErrors: expect.objectContaining({
				releaseVersion: 'Release/update campaigns require a linked app version.',
				slides: 'At least one slide is required.',
			}),
		});
	});

	it('deletes draft campaigns but refuses to delete published history', async () => {
		await createCampaignDraft(
			{ type: 'release_update', name: 'Draft release', releaseVersion: '0.2.0', createdByUserId: 'admin-user' },
			{ db, ids: ['draft-campaign'] },
		);
		await expect(deleteCampaignDraft('draft-campaign', { db })).resolves.toBe(true);
		expect(await getCampaignById('draft-campaign', { db })).toBeNull();

		insertRequiredCrops('setup');
		insertRequiredCrops('disclosure');
		await createCampaignDraft(
			{ type: 'first_run_onboarding', name: 'Onboarding', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);
		await updateCampaignDraft(
			'campaign-1',
			{
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 1,
						title: { en: 'Set up', hu: 'Beállítás' },
						body: { en: 'Choose defaults.', hu: 'Válassz alapokat.' },
						altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
						desktopCropAssetId: 'setup-desktop',
						mobileCropAssetId: 'setup-mobile',
					},
					{
						id: 'slide-disclosure',
						layoutType: 'standard',
						semanticRole: 'data_disclosure',
						sortOrder: 2,
						title: { en: 'Data use', hu: 'Adathasználat' },
						body: { en: 'Messages may use providers.', hu: 'Az üzenetek szolgáltatókat használhatnak.' },
						altText: { en: 'Disclosure screenshot', hu: 'Tájékoztató képernyőkép' },
						desktopCropAssetId: 'disclosure-desktop',
						mobileCropAssetId: 'disclosure-mobile',
					},
				],
			},
			{ db },
		);
		await publishCampaign('campaign-1', 'admin-user', { db, ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2'] });

		await expect(deleteCampaignDraft('campaign-1', { db })).rejects.toMatchObject({
			fieldErrors: { status: 'Only draft campaigns can be deleted.' },
		});
		expect(await getCampaignById('campaign-1', { db })).toMatchObject({ status: 'published' });
	});

	it('archives published campaigns and duplicates published history as a new draft revision', async () => {
		insertRequiredCrops('setup');
		insertRequiredCrops('disclosure');
		await createCampaignDraft(
			{ type: 'first_run_onboarding', name: 'Onboarding', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);
		await updateCampaignDraft(
			'campaign-1',
			{
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 1,
						title: { en: 'Set up', hu: 'Beállítás' },
						body: { en: 'Choose defaults.', hu: 'Válassz alapokat.' },
						altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
						desktopCropAssetId: 'setup-desktop',
						mobileCropAssetId: 'setup-mobile',
					},
					{
						id: 'slide-disclosure',
						layoutType: 'standard',
						semanticRole: 'data_disclosure',
						sortOrder: 2,
						title: { en: 'Data use', hu: 'Adathasználat' },
						body: { en: 'Messages may use providers.', hu: 'Az üzenetek szolgáltatókat használhatnak.' },
						altText: { en: 'Disclosure screenshot', hu: 'Tájékoztató képernyőkép' },
						desktopCropAssetId: 'disclosure-desktop',
						mobileCropAssetId: 'disclosure-mobile',
					},
				],
			},
			{ db },
		);
		await publishCampaign('campaign-1', 'admin-user', { db, ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2'] });

		const archived = await archiveCampaign('campaign-1', { db });
		expect(archived.status).toBe('archived');

		const duplicate = await duplicateCampaignAsDraft('campaign-1', 'admin-user', {
			db,
			ids: ['campaign-2', 'slide-copy-1', 'slide-copy-2'],
		});
		expect(duplicate).toMatchObject({
			id: 'campaign-2',
			status: 'draft',
			identityKey: 'first_run_onboarding:v1:r2',
			revision: 2,
			slides: expect.arrayContaining([
				expect.objectContaining({ id: 'slide-copy-1', title: { en: 'Set up', hu: 'Beállítás' } }),
			]),
		});
	});

	it('selects first-run campaigns before release campaigns and records completion state', async () => {
		insertRequiredCrops('setup');
		insertRequiredCrops('disclosure');
		insertRequiredCrops('release');

		await seedFirstRunOnboardingTemplate('admin-user', { db, ids: ['template-campaign', 'template-slide-1', 'template-slide-2', 'template-slide-3'] });
		expect(await getEligibleCampaignForUser('viewer-user', { db })).toBeNull();

		await createCampaignDraft(
			{ type: 'first_run_onboarding', name: 'Onboarding', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);
		await updateCampaignDraft(
			'campaign-1',
			{
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 1,
						title: { en: 'Set up', hu: 'Beállítás' },
						body: { en: 'Choose defaults.', hu: 'Válassz alapokat.' },
						altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
						desktopCropAssetId: 'setup-desktop',
						mobileCropAssetId: 'setup-mobile',
					},
					{
						id: 'slide-disclosure',
						layoutType: 'standard',
						semanticRole: 'data_disclosure',
						sortOrder: 2,
						title: { en: 'Data use', hu: 'Adathasználat' },
						body: { en: 'Messages may use providers.', hu: 'Az üzenetek szolgáltatókat használhatnak.' },
						altText: { en: 'Disclosure screenshot', hu: 'Tájékoztató képernyőkép' },
						desktopCropAssetId: 'disclosure-desktop',
						mobileCropAssetId: 'disclosure-mobile',
					},
				],
			},
			{ db },
		);
		const onboarding = await publishCampaign('campaign-1', 'admin-user', { db, ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2'] });

		await createCampaignDraft(
			{
				type: 'release_update',
				name: 'Release update',
				releaseVersion: '0.2.0',
				createdByUserId: 'admin-user',
			},
			{ db, ids: ['campaign-2'] },
		);
		await updateCampaignDraft(
			'campaign-2',
			{
				slides: [
					{
						id: 'release-slide',
						layoutType: 'standard',
						sortOrder: 1,
						title: { en: 'New release', hu: 'Új kiadás' },
						body: { en: 'Version details.', hu: 'Verzió részletei.' },
						altText: { en: 'Release screenshot', hu: 'Kiadási képernyőkép' },
						desktopCropAssetId: 'release-desktop',
						mobileCropAssetId: 'release-mobile',
					},
				],
			},
			{ db },
		);
		await publishCampaign('campaign-2', 'admin-user', { db, ids: ['snapshot-2', 'snap-slide-3'] });

		expect((await getEligibleCampaignForUser('viewer-user', { db }))?.id).toBe(onboarding.id);

		await completeCampaignForUser(onboarding.id, 'viewer-user', 'completed', { db });
		const eligible = await getEligibleCampaignForUser('viewer-user', { db });
		expect(eligible?.type).toBe('release_update');
	});

	it('records minimal analytics events and summarizes engagement without duplicate slide-view spam', async () => {
		insertRequiredCrops('setup');
		insertRequiredCrops('disclosure');
		await createCampaignDraft(
			{ type: 'first_run_onboarding', name: 'Onboarding', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);
		await updateCampaignDraft(
			'campaign-1',
			{
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 1,
						title: { en: 'Set up', hu: 'Beállítás' },
						body: { en: 'Choose defaults.', hu: 'Válassz alapokat.' },
						altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
						desktopCropAssetId: 'setup-desktop',
						mobileCropAssetId: 'setup-mobile',
					},
					{
						id: 'slide-disclosure',
						layoutType: 'standard',
						semanticRole: 'data_disclosure',
						sortOrder: 2,
						title: { en: 'Data use', hu: 'Adathasználat' },
						body: { en: 'Messages may use providers.', hu: 'Az üzenetek szolgáltatókat használhatnak.' },
						altText: { en: 'Disclosure screenshot', hu: 'Tájékoztató képernyőkép' },
						desktopCropAssetId: 'disclosure-desktop',
						mobileCropAssetId: 'disclosure-mobile',
					},
				],
			},
			{ db },
		);
		const campaign = await publishCampaign('campaign-1', 'admin-user', { db, ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2'] });

		await recordCampaignEvent({ campaignId: campaign.id, userId: 'viewer-user', eventType: 'auto_shown' }, { db, ids: ['event-1'] });
		await recordCampaignEvent({ campaignId: campaign.id, userId: 'viewer-user', eventType: 'slide_viewed', slideId: 'snap-slide-1' }, { db, ids: ['event-2'] });
		await recordCampaignEvent({ campaignId: campaign.id, userId: 'viewer-user', eventType: 'slide_viewed', slideId: 'snap-slide-1' }, { db, ids: ['event-duplicate'] });
		await recordCampaignEvent({ campaignId: campaign.id, userId: 'viewer-user', eventType: 'setup_preference_changed', slideId: 'snap-slide-1', metadata: { preference: 'theme', value: 'dark', ignored: 'free text' } }, { db, ids: ['event-3'] });
		await completeCampaignForUser(campaign.id, 'viewer-user', 'skipped', { db, ids: ['state-1', 'event-4'] });

		const summary = await getCampaignAnalyticsSummary(campaign.id, { db });
		expect(summary).toMatchObject({
			autoShown: 1,
			completed: 0,
			skipped: 1,
			replayOpened: 0,
			completionRate: 0,
			slideViews: [{ slideId: 'snap-slide-1', sortOrder: 1, views: 1 }],
		});

		const rows = db.select().from(schema.announcementCampaignEvents).all();
		expect(rows).toHaveLength(4);
		expect(JSON.parse(rows.find((row) => row.eventType === 'setup_preference_changed')?.metadataJson ?? '{}')).toEqual({
			preference: 'theme',
			value: 'dark',
		});
	});

	it('counts terminal completion analytics once per user even if completion is submitted twice', async () => {
		insertRequiredCrops('setup');
		insertRequiredCrops('disclosure');
		await createCampaignDraft(
			{ type: 'first_run_onboarding', name: 'Onboarding', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);
		await updateCampaignDraft(
			'campaign-1',
			{
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 1,
						title: { en: 'Set up', hu: 'Beállítás' },
						body: { en: 'Choose defaults.', hu: 'Válassz alapokat.' },
						altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
						desktopCropAssetId: 'setup-desktop',
						mobileCropAssetId: 'setup-mobile',
					},
					{
						id: 'slide-disclosure',
						layoutType: 'standard',
						semanticRole: 'data_disclosure',
						sortOrder: 2,
						title: { en: 'Data use', hu: 'Adathasználat' },
						body: { en: 'Messages may use providers.', hu: 'Az üzenetek szolgáltatókat használhatnak.' },
						altText: { en: 'Disclosure screenshot', hu: 'Tájékoztató képernyőkép' },
						desktopCropAssetId: 'disclosure-desktop',
						mobileCropAssetId: 'disclosure-mobile',
					},
				],
			},
			{ db },
		);
		const campaign = await publishCampaign('campaign-1', 'admin-user', { db, ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2'] });

		await completeCampaignForUser(campaign.id, 'viewer-user', 'completed', { db, ids: ['state-1', 'event-1'] });
		await completeCampaignForUser(campaign.id, 'viewer-user', 'completed', { db, ids: ['state-ignored', 'event-ignored'] });

		await expect(getCampaignAnalyticsSummary(campaign.id, { db })).resolves.toMatchObject({
			completed: 1,
			skipped: 0,
			completionRate: 1,
		});
	});

	it('rejects event slide ids that are not part of the active published snapshot', async () => {
		insertRequiredCrops('setup');
		insertRequiredCrops('disclosure');
		await createCampaignDraft(
			{ type: 'first_run_onboarding', name: 'Onboarding', createdByUserId: 'admin-user' },
			{ db, ids: ['campaign-1'] },
		);
		await updateCampaignDraft(
			'campaign-1',
			{
				slides: [
					{
						id: 'slide-setup',
						layoutType: 'setup',
						sortOrder: 1,
						title: { en: 'Set up', hu: 'Beállítás' },
						body: { en: 'Choose defaults.', hu: 'Válassz alapokat.' },
						altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
						desktopCropAssetId: 'setup-desktop',
						mobileCropAssetId: 'setup-mobile',
					},
					{
						id: 'slide-disclosure',
						layoutType: 'standard',
						semanticRole: 'data_disclosure',
						sortOrder: 2,
						title: { en: 'Data use', hu: 'Adathasználat' },
						body: { en: 'Messages may use providers.', hu: 'Az üzenetek szolgáltatókat használhatnak.' },
						altText: { en: 'Disclosure screenshot', hu: 'Tájékoztató képernyőkép' },
						desktopCropAssetId: 'disclosure-desktop',
						mobileCropAssetId: 'disclosure-mobile',
					},
				],
			},
			{ db },
		);
		const campaign = await publishCampaign('campaign-1', 'admin-user', { db, ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2'] });

		await expect(
			recordCampaignEvent({
				campaignId: campaign.id,
				userId: 'viewer-user',
				eventType: 'slide_viewed',
				slideId: 'draft-slide-id',
			}, { db }),
		).rejects.toMatchObject({
			fieldErrors: { slideId: 'Slide does not belong to the active campaign snapshot.' },
		});
	});

	it('seeds the first-run onboarding template idempotently as an unpublished draft', async () => {
		const first = await seedFirstRunOnboardingTemplate('admin-user', {
			db,
			ids: ['campaign-template', 'template-slide-setup', 'template-slide-feature', 'template-slide-disclosure'],
		});
		const second = await seedFirstRunOnboardingTemplate('admin-user', { db });

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(first.campaign.status).toBe('draft');
		expect(first.campaign.slides.map((slide) => slide.layoutType)).toEqual(['setup', 'standard', 'standard']);
		expect(first.campaign.slides.some((slide) => slide.semanticRole === 'data_disclosure')).toBe(true);
		expect(await getEligibleCampaignForUser('viewer-user', { db })).toBeNull();
	});

	it('keeps a saved seeded first-run campaign publishable with setup controls and data disclosure role', async () => {
		insertRequiredCrops('setup');
		insertRequiredCrops('feature');
		insertRequiredCrops('disclosure');
		const seeded = await seedFirstRunOnboardingTemplate('admin-user', {
			db,
			ids: ['campaign-template', 'template-slide-setup', 'template-slide-feature', 'template-slide-disclosure'],
		});

		const saved = await updateCampaignDraft(
			seeded.campaign.id,
			{
				slides: seeded.campaign.slides.map((slide, index) => ({
					id: slide.id,
					layoutType: slide.layoutType,
					semanticRole: slide.semanticRole,
					sortOrder: index + 1,
					title: slide.title,
					body: slide.body,
					altText: slide.altText,
					setupControls: slide.setupControls,
					desktopCropAssetId: index === 0 ? 'setup-desktop' : index === 1 ? 'feature-desktop' : 'disclosure-desktop',
					mobileCropAssetId: index === 0 ? 'setup-mobile' : index === 1 ? 'feature-mobile' : 'disclosure-mobile',
				})),
			},
			{ db },
		);

		expect(saved.slides[0]?.setupControls).toEqual(['ui_language', 'theme', 'model_default', 'ai_style']);
		expect(saved.slides[2]?.semanticRole).toBe('data_disclosure');

		await expect(
			publishCampaign(saved.id, 'admin-user', {
				db,
				ids: ['snapshot-1', 'snap-slide-1', 'snap-slide-2', 'snap-slide-3'],
			}),
		).resolves.toMatchObject({ status: 'published' });
	});
});
