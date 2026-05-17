import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { db as defaultDb } from '$lib/server/db';
import {
	announcementCampaignEvents,
	announcementCampaignSlides,
	announcementCampaignSnapshotSlides,
	announcementCampaignSnapshots,
	announcementCampaigns,
	announcementCampaignUserStates,
	campaignAssets,
} from '$lib/server/db/schema';

type CampaignDb = typeof defaultDb;

export type AnnouncementCampaignType = 'first_run_onboarding' | 'release_update';
export type AnnouncementCampaignStatus = 'draft' | 'published' | 'archived';
export type AnnouncementCampaignSlideLayout = 'setup' | 'standard';
export type AnnouncementCampaignSlideRole = 'feature' | 'data_disclosure';
export type CampaignCompletionReason = 'completed' | 'skipped';
export type CampaignEventType =
	| 'auto_shown'
	| 'slide_viewed'
	| 'completed'
	| 'skipped'
	| 'replay_opened'
	| 'setup_preference_changed';

type LocalizedInput = {
	en?: unknown;
	hu?: unknown;
};

export type CampaignSlideInput = {
	id?: string;
	layoutType?: unknown;
	semanticRole?: unknown;
	sortOrder?: unknown;
	title?: LocalizedInput;
	body?: LocalizedInput;
	actionLabel?: LocalizedInput | null;
	altText?: LocalizedInput;
	titleEn?: unknown;
	titleHu?: unknown;
	bodyEn?: unknown;
	bodyHu?: unknown;
	actionLabelEn?: unknown;
	actionLabelHu?: unknown;
	altTextEn?: unknown;
	altTextHu?: unknown;
	desktopCropAssetId?: unknown;
	mobileCropAssetId?: unknown;
	actionDestination?: unknown;
	setupControls?: unknown;
};

export type CampaignUpdateInput = {
	name?: unknown;
	releaseVersion?: unknown;
	slides?: CampaignSlideInput[];
};

export type CampaignServiceOptions = {
	db?: CampaignDb;
	ids?: string[];
};

export class AnnouncementCampaignValidationError extends Error {
	constructor(
		message: string,
		public readonly fieldErrors: Record<string, string>,
		public readonly status = 400,
	) {
		super(message);
		this.name = 'AnnouncementCampaignValidationError';
	}
}

type DraftRow = typeof announcementCampaigns.$inferSelect;
type DraftSlideRow = typeof announcementCampaignSlides.$inferSelect;
type SnapshotRow = typeof announcementCampaignSnapshots.$inferSelect;
type SnapshotSlideRow = typeof announcementCampaignSnapshotSlides.$inferSelect;

const CAMPAIGN_TYPES = new Set<AnnouncementCampaignType>([
	'first_run_onboarding',
	'release_update',
]);
const LAYOUT_TYPES = new Set<AnnouncementCampaignSlideLayout>(['setup', 'standard']);
const SEMANTIC_ROLES = new Set<AnnouncementCampaignSlideRole>(['feature', 'data_disclosure']);
const EVENT_TYPES = new Set<CampaignEventType>([
	'auto_shown',
	'slide_viewed',
	'completed',
	'skipped',
	'replay_opened',
	'setup_preference_changed',
]);
const SETUP_CONTROLS = new Set(['ui_language', 'theme', 'model_default', 'ai_style']);
const ACTION_DESTINATION_ALLOWLIST = new Set([
	'/',
	'/chat',
	'/knowledge',
	'/settings',
	'/settings/profile',
	'/settings/admin',
]);

function database(options: CampaignServiceOptions = {}) {
	return options.db ?? defaultDb;
}

function idFactory(options: CampaignServiceOptions = {}) {
	const ids = [...(options.ids ?? [])];
	return () => ids.shift() ?? randomUUID();
}

function trimString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function nullableTrimString(value: unknown): string | null {
	const trimmed = trimString(value);
	return trimmed.length > 0 ? trimmed : null;
}

function readLocalized(input: CampaignSlideInput, key: 'title' | 'body' | 'actionLabel' | 'altText') {
	const localized = input[key];
	const enField = `${key}En` as keyof CampaignSlideInput;
	const huField = `${key}Hu` as keyof CampaignSlideInput;
	return {
		en: trimString((localized && typeof localized === 'object' ? localized.en : undefined) ?? input[enField]),
		hu: trimString((localized && typeof localized === 'object' ? localized.hu : undefined) ?? input[huField]),
	};
}

function parseSetupControls(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === 'string'))];
}

function parseSetupControlsJson(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return parseSetupControls(parsed);
	} catch {
		return [];
	}
}

function identityFor(type: AnnouncementCampaignType, version: string, revision: number): string {
	return `${type}:${version}:r${revision}`;
}

function defaultVersionFor(type: AnnouncementCampaignType, releaseVersion?: string | null): string {
	if (type === 'release_update') {
		return releaseVersion?.trim() || 'unversioned';
	}
	return 'v1';
}

function assertType(value: unknown): AnnouncementCampaignType {
	if (typeof value === 'string' && CAMPAIGN_TYPES.has(value as AnnouncementCampaignType)) {
		return value as AnnouncementCampaignType;
	}
	throw new AnnouncementCampaignValidationError('Invalid campaign type.', {
		type: 'Campaign type must be first_run_onboarding or release_update.',
	});
}

function mapDraftSlide(row: DraftSlideRow) {
	return {
		id: row.id,
		campaignId: row.campaignId,
		layoutType: row.layoutType as AnnouncementCampaignSlideLayout,
		semanticRole: row.semanticRole as AnnouncementCampaignSlideRole,
		sortOrder: row.sortOrder,
		title: { en: row.titleEn, hu: row.titleHu },
		body: { en: row.bodyEn, hu: row.bodyHu },
		actionLabel: {
			en: row.actionLabelEn ?? '',
			hu: row.actionLabelHu ?? '',
		},
		altText: { en: row.altTextEn, hu: row.altTextHu },
		desktopCropAssetId: row.desktopCropAssetId,
		mobileCropAssetId: row.mobileCropAssetId,
		actionDestination: row.actionDestination,
		setupControls: parseSetupControlsJson(row.setupControlsJson),
	};
}

function mapSnapshotSlide(row: SnapshotSlideRow) {
	return {
		id: row.id,
		snapshotId: row.snapshotId,
		campaignId: row.campaignId,
		draftSlideId: row.draftSlideId,
		layoutType: row.layoutType as AnnouncementCampaignSlideLayout,
		semanticRole: row.semanticRole as AnnouncementCampaignSlideRole,
		sortOrder: row.sortOrder,
		title: { en: row.titleEn, hu: row.titleHu },
		body: { en: row.bodyEn, hu: row.bodyHu },
		actionLabel: {
			en: row.actionLabelEn ?? '',
			hu: row.actionLabelHu ?? '',
		},
		altText: { en: row.altTextEn, hu: row.altTextHu },
		desktopCropAssetId: row.desktopCropAssetId,
		mobileCropAssetId: row.mobileCropAssetId,
		actionDestination: row.actionDestination,
		setupControls: parseSetupControlsJson(row.setupControlsJson),
	};
}

function mapSnapshot(row: SnapshotRow, slides: SnapshotSlideRow[]) {
	return {
		id: row.id,
		campaignId: row.campaignId,
		identityKey: row.identityKey,
		type: row.type as AnnouncementCampaignType,
		name: row.name,
		campaignVersion: row.campaignVersion,
		revision: row.revision,
		releaseVersion: row.releaseVersion,
		audience: row.audience,
		publishedAt: row.publishedAt,
		archivedAt: row.archivedAt,
		slides: slides.map(mapSnapshotSlide),
	};
}

function mapCampaign(row: DraftRow, slides: DraftSlideRow[], snapshot?: ReturnType<typeof mapSnapshot> | null) {
	return {
		id: row.id,
		type: row.type as AnnouncementCampaignType,
		status: row.status as AnnouncementCampaignStatus,
		identityKey: row.identityKey,
		name: row.name,
		campaignVersion: row.campaignVersion,
		revision: row.revision,
		releaseVersion: row.releaseVersion,
		audience: row.audience,
		createdByUserId: row.createdByUserId,
		publishedByUserId: row.publishedByUserId,
		publishedSnapshotId: row.publishedSnapshotId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		archivedAt: row.archivedAt,
		slides: slides.map(mapDraftSlide),
		snapshot: snapshot ?? null,
	};
}

async function getSnapshotForCampaign(campaignId: string, db: CampaignDb) {
	const snapshot = db
		.select()
		.from(announcementCampaignSnapshots)
		.where(eq(announcementCampaignSnapshots.campaignId, campaignId))
		.orderBy(desc(announcementCampaignSnapshots.publishedAt))
		.get();
	if (!snapshot) return null;
	const slides = db
		.select()
		.from(announcementCampaignSnapshotSlides)
		.where(eq(announcementCampaignSnapshotSlides.snapshotId, snapshot.id))
		.orderBy(asc(announcementCampaignSnapshotSlides.sortOrder))
		.all();
	return mapSnapshot(snapshot, slides);
}

export async function getCampaignById(campaignId: string, options: CampaignServiceOptions = {}) {
	const db = database(options);
	const campaign = db
		.select()
		.from(announcementCampaigns)
		.where(eq(announcementCampaigns.id, campaignId))
		.get();
	if (!campaign) return null;
	const slides = db
		.select()
		.from(announcementCampaignSlides)
		.where(eq(announcementCampaignSlides.campaignId, campaignId))
		.orderBy(asc(announcementCampaignSlides.sortOrder))
		.all();
	return mapCampaign(campaign, slides, await getSnapshotForCampaign(campaignId, db));
}

export async function listCampaigns(options: CampaignServiceOptions = {}) {
	const db = database(options);
	const rows = db
		.select()
		.from(announcementCampaigns)
		.orderBy(desc(announcementCampaigns.updatedAt))
		.all();
	return Promise.all(
		rows.map(async (row) => {
			const slides = db
				.select()
				.from(announcementCampaignSlides)
				.where(eq(announcementCampaignSlides.campaignId, row.id))
				.orderBy(asc(announcementCampaignSlides.sortOrder))
				.all();
			return mapCampaign(row, slides, await getSnapshotForCampaign(row.id, db));
		}),
	);
}

function nextRevision(
	db: CampaignDb,
	type: AnnouncementCampaignType,
	campaignVersion: string,
	excludeCampaignId?: string,
): number {
	const filters = [
		eq(announcementCampaigns.type, type),
		eq(announcementCampaigns.campaignVersion, campaignVersion),
	];
	if (excludeCampaignId) {
		filters.push(ne(announcementCampaigns.id, excludeCampaignId));
	}
	const rows = db
		.select({ revision: announcementCampaigns.revision })
		.from(announcementCampaigns)
		.where(and(...filters))
		.all();
	return Math.max(0, ...rows.map((row) => row.revision)) + 1;
}

export async function createCampaignDraft(
	input: {
		type: unknown;
		releaseVersion?: unknown;
		name?: unknown;
		createdByUserId: string;
	},
	options: CampaignServiceOptions = {},
) {
	const db = database(options);
	const nextId = idFactory(options);
	const type = assertType(input.type);
	const releaseVersion = nullableTrimString(input.releaseVersion);
	const campaignVersion = defaultVersionFor(type, releaseVersion);
	const revision = nextRevision(db, type, campaignVersion);
	const id = nextId();
	const identityKey = identityFor(type, campaignVersion, revision);
	const name = trimString(input.name) || (type === 'first_run_onboarding' ? 'First-run onboarding' : `Release ${releaseVersion ?? ''}`.trim());

	db.insert(announcementCampaigns)
		.values({
			id,
			type,
			status: 'draft',
			identityKey,
			name,
			campaignVersion,
			revision,
			releaseVersion,
			createdByUserId: input.createdByUserId,
		})
		.run();

	const campaign = await getCampaignById(id, { db });
	if (!campaign) throw new Error('Failed to create campaign draft.');
	return campaign;
}

function normalizeSlide(input: CampaignSlideInput, nextId: () => string) {
	const layoutType = typeof input.layoutType === 'string' ? input.layoutType : '';
	const semanticRole = typeof input.semanticRole === 'string' ? input.semanticRole : 'feature';
	const sortOrder = Number(input.sortOrder);
	const title = readLocalized(input, 'title');
	const body = readLocalized(input, 'body');
	const actionLabel = readLocalized(input, 'actionLabel');
	const altText = readLocalized(input, 'altText');
	return {
		id: trimString(input.id) || nextId(),
		layoutType,
		semanticRole,
		sortOrder,
		title,
		body,
		actionLabel,
		altText,
		desktopCropAssetId: nullableTrimString(input.desktopCropAssetId),
		mobileCropAssetId: nullableTrimString(input.mobileCropAssetId),
		actionDestination: nullableTrimString(input.actionDestination),
		setupControls: parseSetupControls(input.setupControls),
	};
}

export async function updateCampaignDraft(
	campaignId: string,
	input: CampaignUpdateInput,
	options: CampaignServiceOptions = {},
) {
	const db = database(options);
	const nextId = idFactory(options);
	const campaign = db
		.select()
		.from(announcementCampaigns)
		.where(eq(announcementCampaigns.id, campaignId))
		.get();
	if (!campaign) {
		throw new AnnouncementCampaignValidationError('Campaign not found.', { campaign: 'Campaign not found.' }, 404);
	}
	if (campaign.status !== 'draft') {
		throw new AnnouncementCampaignValidationError('Published campaigns are read-only.', {
			status: 'Only draft campaigns can be edited.',
		});
	}

	const updates: Partial<typeof announcementCampaigns.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (input.name !== undefined) {
		const name = trimString(input.name);
		if (name) updates.name = name;
	}
	if (input.releaseVersion !== undefined && campaign.type === 'release_update') {
		const releaseVersion = nullableTrimString(input.releaseVersion);
		const campaignVersion = defaultVersionFor('release_update', releaseVersion);
		const revision = nextRevision(db, 'release_update', campaignVersion, campaignId);
		updates.releaseVersion = releaseVersion;
		updates.campaignVersion = campaignVersion;
		updates.revision = revision;
		updates.identityKey = identityFor('release_update', campaignVersion, revision);
	}

	db.transaction((tx) => {
		tx.update(announcementCampaigns)
			.set(updates)
			.where(eq(announcementCampaigns.id, campaignId))
			.run();

		if (Array.isArray(input.slides)) {
			tx.delete(announcementCampaignSlides)
				.where(eq(announcementCampaignSlides.campaignId, campaignId))
				.run();
			for (const slide of input.slides.map((item) => normalizeSlide(item, nextId))) {
				tx.insert(announcementCampaignSlides)
					.values({
						id: slide.id,
						campaignId,
						layoutType: slide.layoutType || 'standard',
						semanticRole: slide.semanticRole || 'feature',
						sortOrder: Number.isInteger(slide.sortOrder) ? slide.sortOrder : 0,
						titleEn: slide.title.en,
						titleHu: slide.title.hu,
						bodyEn: slide.body.en,
						bodyHu: slide.body.hu,
						actionLabelEn: slide.actionLabel.en || null,
						actionLabelHu: slide.actionLabel.hu || null,
						altTextEn: slide.altText.en,
						altTextHu: slide.altText.hu,
						desktopCropAssetId: slide.desktopCropAssetId,
						mobileCropAssetId: slide.mobileCropAssetId,
						actionDestination: slide.actionDestination,
						setupControlsJson: slide.setupControls.length > 0 ? JSON.stringify(slide.setupControls) : null,
						updatedAt: new Date(),
					})
					.run();
			}
		}
	});

	const updated = await getCampaignById(campaignId, { db });
	if (!updated) throw new Error('Failed to update campaign draft.');
	return updated;
}

export async function deleteCampaignDraft(campaignId: string, options: CampaignServiceOptions = {}) {
	const db = database(options);
	const campaign = db
		.select()
		.from(announcementCampaigns)
		.where(eq(announcementCampaigns.id, campaignId))
		.get();
	if (!campaign) {
		throw new AnnouncementCampaignValidationError('Campaign not found.', { campaign: 'Campaign not found.' }, 404);
	}
	if (campaign.status !== 'draft') {
		throw new AnnouncementCampaignValidationError('Published campaign history cannot be deleted.', {
			status: 'Only draft campaigns can be deleted.',
		});
	}
	db.delete(announcementCampaigns)
		.where(eq(announcementCampaigns.id, campaignId))
		.run();
	return true;
}

function addFieldError(errors: Record<string, string>, key: string, message: string) {
	if (!errors[key]) errors[key] = message;
}

function validateActionDestination(value: string | null): boolean {
	if (!value) return true;
	if (!value.startsWith('/') || value.startsWith('//')) return false;
	return ACTION_DESTINATION_ALLOWLIST.has(value.split('?')[0]);
}

function validatePublishInput(
	campaign: DraftRow,
	slides: DraftSlideRow[],
	assetRows: Array<{ id: string; assetKind: string; variant: string | null }>,
) {
	const errors: Record<string, string> = {};
	if (!trimString(campaign.name)) {
		errors.name = 'Campaign name is required.';
	}
	if (!CAMPAIGN_TYPES.has(campaign.type as AnnouncementCampaignType)) {
		errors.type = 'Campaign type must be first_run_onboarding or release_update.';
	}
	if (!trimString(campaign.campaignVersion) || campaign.campaignVersion === 'unversioned') {
		errors.campaignVersion = 'Campaign version is required.';
	}
	if (campaign.type === 'release_update' && !trimString(campaign.releaseVersion)) {
		errors.releaseVersion = 'Release/update campaigns require a linked app version.';
	}
	if (slides.length === 0) {
		errors.slides = 'At least one slide is required.';
	}

	const orderSet = new Set<number>();
	const assetMap = new Map(assetRows.map((row) => [row.id, row]));
	let setupCount = 0;
	let dataDisclosureCount = 0;

	for (const slide of slides) {
		const prefix = `slides.${slide.id}`;
		if (!LAYOUT_TYPES.has(slide.layoutType as AnnouncementCampaignSlideLayout)) {
			addFieldError(errors, `${prefix}.layoutType`, 'Slide layout must be setup or standard.');
		}
		if (!SEMANTIC_ROLES.has(slide.semanticRole as AnnouncementCampaignSlideRole)) {
			addFieldError(errors, `${prefix}.semanticRole`, 'Slide semantic role is invalid.');
		}
		if (!Number.isInteger(slide.sortOrder) || slide.sortOrder <= 0 || orderSet.has(slide.sortOrder)) {
			addFieldError(errors, `${prefix}.sortOrder`, 'Slide order must use unique positive integers.');
		}
		orderSet.add(slide.sortOrder);

		for (const [field, value] of [
			['title.en', slide.titleEn],
			['title.hu', slide.titleHu],
			['body.en', slide.bodyEn],
			['body.hu', slide.bodyHu],
			['altText.en', slide.altTextEn],
			['altText.hu', slide.altTextHu],
		]) {
			if (!value.trim()) {
				addFieldError(errors, `${prefix}.${field}`, 'Localized EN/HU title, body, and alt text are required.');
			}
		}

		if (!slide.desktopCropAssetId) {
			addFieldError(errors, `${prefix}.desktopCropAssetId`, 'Desktop crop asset is required.');
		} else {
			const asset = assetMap.get(slide.desktopCropAssetId);
			if (!asset || asset.assetKind !== 'crop' || asset.variant !== 'desktop') {
				addFieldError(errors, `${prefix}.desktopCropAssetId`, 'Desktop crop asset must be a campaign desktop crop.');
			}
		}
		if (!slide.mobileCropAssetId) {
			addFieldError(errors, `${prefix}.mobileCropAssetId`, 'Mobile crop asset is required.');
		} else {
			const asset = assetMap.get(slide.mobileCropAssetId);
			if (!asset || asset.assetKind !== 'crop' || asset.variant !== 'mobile') {
				addFieldError(errors, `${prefix}.mobileCropAssetId`, 'Mobile crop asset must be a campaign mobile crop.');
			}
		}

		if (!validateActionDestination(slide.actionDestination)) {
			addFieldError(errors, `${prefix}.actionDestination`, 'Action destination must be an allowlisted internal route.');
		}
		if (slide.actionDestination && (!slide.actionLabelEn?.trim() || !slide.actionLabelHu?.trim())) {
			addFieldError(errors, `${prefix}.actionLabel`, 'Action labels are required in English and Hungarian when an action is configured.');
		}

		const setupControls = parseSetupControlsJson(slide.setupControlsJson);
		if (slide.layoutType === 'setup') setupCount += 1;
		if (slide.layoutType === 'standard' && slide.semanticRole === 'data_disclosure') {
			dataDisclosureCount += 1;
		}
		if (setupControls.length > 0 && (campaign.type !== 'first_run_onboarding' || slide.layoutType !== 'setup')) {
			addFieldError(errors, `${prefix}.setupControls`, 'Setup controls are only allowed on first-run setup slides.');
		}
		for (const control of setupControls) {
			if (!SETUP_CONTROLS.has(control)) {
				addFieldError(errors, `${prefix}.setupControls`, 'Setup controls include an unsupported preference control.');
			}
		}
	}

	if (campaign.type === 'first_run_onboarding') {
		if (setupCount !== 1) {
			errors.setupSlide = 'First-run onboarding requires exactly one setup slide.';
		}
		if (dataDisclosureCount < 1) {
			errors.dataDisclosure = 'First-run onboarding requires at least one data-disclosure standard slide.';
		}
	}

	if (Object.keys(errors).length > 0) {
		throw new AnnouncementCampaignValidationError('Campaign is not ready to publish.', errors);
	}
}

export async function publishCampaign(
	campaignId: string,
	publishedByUserId: string,
	options: CampaignServiceOptions = {},
) {
	const db = database(options);
	const nextId = idFactory(options);
	const campaign = db
		.select()
		.from(announcementCampaigns)
		.where(eq(announcementCampaigns.id, campaignId))
		.get();
	if (!campaign) {
		throw new AnnouncementCampaignValidationError('Campaign not found.', { campaign: 'Campaign not found.' }, 404);
	}
	if (campaign.status !== 'draft') {
		throw new AnnouncementCampaignValidationError('Only draft campaigns can be published.', {
			status: 'Only draft campaigns can be published.',
		});
	}
	const slides = db
		.select()
		.from(announcementCampaignSlides)
		.where(eq(announcementCampaignSlides.campaignId, campaignId))
		.orderBy(asc(announcementCampaignSlides.sortOrder))
		.all();
	const assetIds = [
		...new Set(
			slides.flatMap((slide) => [slide.desktopCropAssetId, slide.mobileCropAssetId]).filter((id): id is string => Boolean(id)),
		),
	];
	const assetRows = assetIds.length
		? db
				.select({ id: campaignAssets.id, assetKind: campaignAssets.assetKind, variant: campaignAssets.variant })
				.from(campaignAssets)
				.where(inArray(campaignAssets.id, assetIds))
				.all()
		: [];
	validatePublishInput(campaign, slides, assetRows);

	const snapshotId = nextId();
	const now = new Date();
	db.transaction((tx) => {
		tx.insert(announcementCampaignSnapshots)
			.values({
				id: snapshotId,
				campaignId,
				identityKey: campaign.identityKey,
				type: campaign.type,
				name: campaign.name,
				campaignVersion: campaign.campaignVersion,
				revision: campaign.revision,
				releaseVersion: campaign.releaseVersion,
				audience: campaign.audience,
				publishedByUserId,
				publishedAt: now,
			})
			.run();
		for (const slide of slides) {
			tx.insert(announcementCampaignSnapshotSlides)
				.values({
					id: nextId(),
					snapshotId,
					campaignId,
					draftSlideId: slide.id,
					layoutType: slide.layoutType,
					semanticRole: slide.semanticRole,
					sortOrder: slide.sortOrder,
					titleEn: slide.titleEn,
					titleHu: slide.titleHu,
					bodyEn: slide.bodyEn,
					bodyHu: slide.bodyHu,
					actionLabelEn: slide.actionLabelEn,
					actionLabelHu: slide.actionLabelHu,
					altTextEn: slide.altTextEn,
					altTextHu: slide.altTextHu,
					desktopCropAssetId: slide.desktopCropAssetId!,
					mobileCropAssetId: slide.mobileCropAssetId!,
					actionDestination: slide.actionDestination,
					setupControlsJson: slide.setupControlsJson,
				})
				.run();
		}
		tx.update(announcementCampaigns)
			.set({
				status: 'published',
				publishedByUserId,
				publishedSnapshotId: snapshotId,
				publishedAt: now,
				updatedAt: now,
			})
			.where(eq(announcementCampaigns.id, campaignId))
			.run();
		tx.update(campaignAssets)
			.set({ status: 'published', updatedAt: now })
			.where(inArray(campaignAssets.id, assetIds))
			.run();
	});

	const published = await getCampaignById(campaignId, { db });
	if (!published) throw new Error('Failed to publish campaign.');
	return published;
}

export async function archiveCampaign(campaignId: string, options: CampaignServiceOptions = {}) {
	const db = database(options);
	const campaign = db
		.select()
		.from(announcementCampaigns)
		.where(eq(announcementCampaigns.id, campaignId))
		.get();
	if (!campaign) {
		throw new AnnouncementCampaignValidationError('Campaign not found.', { campaign: 'Campaign not found.' }, 404);
	}
	if (campaign.status !== 'published') {
		throw new AnnouncementCampaignValidationError('Only published campaigns can be archived.', {
			status: 'Only published campaigns can be archived.',
		});
	}
	const now = new Date();
	db.transaction((tx) => {
		tx.update(announcementCampaigns)
			.set({ status: 'archived', archivedAt: now, updatedAt: now })
			.where(eq(announcementCampaigns.id, campaignId))
			.run();
		if (campaign.publishedSnapshotId) {
			tx.update(announcementCampaignSnapshots)
				.set({ archivedAt: now })
				.where(eq(announcementCampaignSnapshots.id, campaign.publishedSnapshotId))
				.run();
		}
	});
	const archived = await getCampaignById(campaignId, { db });
	if (!archived) throw new Error('Failed to archive campaign.');
	return archived;
}

export async function duplicateCampaignAsDraft(
	campaignId: string,
	createdByUserId: string,
	options: CampaignServiceOptions = {},
) {
	const db = database(options);
	const nextId = idFactory(options);
	const source = await getCampaignById(campaignId, { db });
	if (!source) {
		throw new AnnouncementCampaignValidationError('Campaign not found.', { campaign: 'Campaign not found.' }, 404);
	}
	if (source.status !== 'published' && source.status !== 'archived') {
		throw new AnnouncementCampaignValidationError('Only published or archived campaigns can be duplicated.', {
			status: 'Only published or archived campaigns can be duplicated.',
		});
	}
	const campaignVersion = source.campaignVersion;
	const revision = nextRevision(db, source.type, campaignVersion);
	const newCampaignId = nextId();
	const slideSource = source.snapshot?.slides ?? source.slides;

	db.transaction((tx) => {
		tx.insert(announcementCampaigns)
			.values({
				id: newCampaignId,
				type: source.type,
				status: 'draft',
				identityKey: identityFor(source.type, campaignVersion, revision),
				name: `${source.name} copy`,
				campaignVersion,
				revision,
				releaseVersion: source.releaseVersion,
				audience: source.audience,
				createdByUserId,
			})
			.run();
		for (const slide of slideSource) {
			tx.insert(announcementCampaignSlides)
				.values({
					id: nextId(),
					campaignId: newCampaignId,
					layoutType: slide.layoutType,
					semanticRole: slide.semanticRole,
					sortOrder: slide.sortOrder,
					titleEn: slide.title.en,
					titleHu: slide.title.hu,
					bodyEn: slide.body.en,
					bodyHu: slide.body.hu,
					actionLabelEn: slide.actionLabel.en || null,
					actionLabelHu: slide.actionLabel.hu || null,
					altTextEn: slide.altText.en,
					altTextHu: slide.altText.hu,
					desktopCropAssetId: slide.desktopCropAssetId,
					mobileCropAssetId: slide.mobileCropAssetId,
					actionDestination: slide.actionDestination,
					setupControlsJson: slide.setupControls.length > 0 ? JSON.stringify(slide.setupControls) : null,
				})
				.run();
		}
	});

	const duplicate = await getCampaignById(newCampaignId, { db });
	if (!duplicate) throw new Error('Failed to duplicate campaign.');
	return duplicate;
}

async function getPublishedCampaignFromRow(campaign: DraftRow, db: CampaignDb) {
	const snapshot = await getSnapshotForCampaign(campaign.id, db);
	if (!snapshot) return null;
	return {
		id: campaign.id,
		type: campaign.type as AnnouncementCampaignType,
		identityKey: campaign.identityKey,
		name: campaign.name,
		campaignVersion: campaign.campaignVersion,
		revision: campaign.revision,
		releaseVersion: campaign.releaseVersion,
		publishedAt: campaign.publishedAt,
		snapshotId: snapshot.id,
		slides: snapshot.slides,
	};
}

async function latestPublishedByType(type: AnnouncementCampaignType, db: CampaignDb) {
	const campaign = db
		.select()
		.from(announcementCampaigns)
		.where(and(eq(announcementCampaigns.type, type), eq(announcementCampaigns.status, 'published')))
		.orderBy(desc(announcementCampaigns.publishedAt), desc(announcementCampaigns.revision))
		.get();
	return campaign ? getPublishedCampaignFromRow(campaign, db) : null;
}

async function userHasFinishedSnapshot(userId: string, snapshotId: string, db: CampaignDb) {
	const row = db
		.select({ id: announcementCampaignUserStates.id })
		.from(announcementCampaignUserStates)
		.where(
			and(
				eq(announcementCampaignUserStates.userId, userId),
				eq(announcementCampaignUserStates.snapshotId, snapshotId),
			),
		)
		.get();
	return Boolean(row);
}

export async function getEligibleCampaignForUser(userId: string, options: CampaignServiceOptions = {}) {
	const db = database(options);
	const onboarding = await latestPublishedByType('first_run_onboarding', db);
	if (onboarding && !(await userHasFinishedSnapshot(userId, onboarding.snapshotId, db))) {
		return onboarding;
	}
	const release = await latestPublishedByType('release_update', db);
	if (release && !(await userHasFinishedSnapshot(userId, release.snapshotId, db))) {
		return release;
	}
	return null;
}

export async function getLatestPublishedCampaign(options: CampaignServiceOptions = {}) {
	const db = database(options);
	const row = db
		.select()
		.from(announcementCampaigns)
		.where(eq(announcementCampaigns.status, 'published'))
		.orderBy(desc(announcementCampaigns.publishedAt), desc(announcementCampaigns.revision))
		.get();
	return row ? getPublishedCampaignFromRow(row, db) : null;
}

function eventTypeForCompletion(reason: CampaignCompletionReason): CampaignEventType {
	return reason === 'completed' ? 'completed' : 'skipped';
}

export async function completeCampaignForUser(
	campaignId: string,
	userId: string,
	reason: CampaignCompletionReason,
	options: CampaignServiceOptions = {},
) {
	const db = database(options);
	const nextId = idFactory(options);
	const campaign = await getCampaignById(campaignId, { db });
	if (!campaign?.snapshot) {
		throw new AnnouncementCampaignValidationError('Published campaign not found.', {
			campaign: 'Published campaign not found.',
		}, 404);
	}
	const existing = db
		.select()
		.from(announcementCampaignUserStates)
		.where(
			and(
				eq(announcementCampaignUserStates.userId, userId),
				eq(announcementCampaignUserStates.snapshotId, campaign.snapshot.id),
			),
		)
		.get();
	const now = new Date();
	const state = {
		status: reason === 'completed' ? 'completed' : 'dismissed',
		reason,
		completedAt: reason === 'completed' ? now : null,
		dismissedAt: reason === 'skipped' ? now : null,
		updatedAt: now,
	};
	if (existing) {
		return existing;
	}
	db.transaction((tx) => {
		tx.insert(announcementCampaignUserStates)
			.values({
				id: nextId(),
				userId,
				campaignId,
				snapshotId: campaign.snapshot!.id,
				...state,
				createdAt: now,
			})
			.run();
		tx.insert(announcementCampaignEvents)
			.values({
				id: nextId(),
				userId,
				campaignId,
				snapshotId: campaign.snapshot!.id,
				eventType: eventTypeForCompletion(reason),
				createdAt: now,
			})
			.run();
	});

	return db
		.select()
		.from(announcementCampaignUserStates)
		.where(
			and(
				eq(announcementCampaignUserStates.userId, userId),
				eq(announcementCampaignUserStates.snapshotId, campaign.snapshot.id),
			),
		)
		.get();
}

function sanitizeMetadata(eventType: CampaignEventType, metadata: unknown): string | null {
	if (eventType !== 'setup_preference_changed') return null;
	if (!metadata || typeof metadata !== 'object') return null;
	const record = metadata as Record<string, unknown>;
	const allowed: Record<string, string> = {};
	for (const key of ['preference', 'value']) {
		if (typeof record[key] === 'string' && record[key].trim().length > 0) {
			allowed[key] = record[key].trim();
		}
	}
	return Object.keys(allowed).length > 0 ? JSON.stringify(allowed) : null;
}

export async function recordCampaignEvent(
	input: {
		campaignId: string;
		userId: string;
		eventType: CampaignEventType;
		slideId?: string | null;
		metadata?: unknown;
	},
	options: CampaignServiceOptions = {},
) {
	const db = database(options);
	const nextId = idFactory(options);
	if (!EVENT_TYPES.has(input.eventType)) {
		throw new AnnouncementCampaignValidationError('Invalid campaign event type.', {
			eventType: 'Campaign event type is invalid.',
		});
	}
	const campaign = await getCampaignById(input.campaignId, { db });
	if (!campaign?.snapshot) {
		throw new AnnouncementCampaignValidationError('Published campaign not found.', {
			campaign: 'Published campaign not found.',
		}, 404);
	}
	const slideId = nullableTrimString(input.slideId);
	if (slideId && !campaign.snapshot.slides.some((slide) => slide.id === slideId)) {
		throw new AnnouncementCampaignValidationError('Campaign event slide is invalid.', {
			slideId: 'Slide does not belong to the active campaign snapshot.',
		});
	}
	if (input.eventType === 'slide_viewed' && slideId) {
		const existing = db
			.select()
			.from(announcementCampaignEvents)
			.where(
				and(
					eq(announcementCampaignEvents.userId, input.userId),
					eq(announcementCampaignEvents.snapshotId, campaign.snapshot.id),
					eq(announcementCampaignEvents.eventType, 'slide_viewed'),
					eq(announcementCampaignEvents.slideId, slideId),
				),
			)
			.get();
		if (existing) return existing;
	}

	const [row] = await db
		.insert(announcementCampaignEvents)
		.values({
			id: nextId(),
			userId: input.userId,
			campaignId: input.campaignId,
			snapshotId: campaign.snapshot.id,
			eventType: input.eventType,
			slideId,
			metadataJson: sanitizeMetadata(input.eventType, input.metadata),
		})
		.returning();
	return row;
}

export async function getCampaignAnalyticsSummary(campaignId: string, options: CampaignServiceOptions = {}) {
	const db = database(options);
	const campaign = await getCampaignById(campaignId, { db });
	if (!campaign?.snapshot) {
		return {
			autoShown: 0,
			completed: 0,
			skipped: 0,
			replayOpened: 0,
			completionRate: 0,
			slideViews: [],
		};
	}
	const events = db
		.select()
		.from(announcementCampaignEvents)
		.where(eq(announcementCampaignEvents.snapshotId, campaign.snapshot.id))
		.all();
	const terminalStates = db
		.select()
		.from(announcementCampaignUserStates)
		.where(eq(announcementCampaignUserStates.snapshotId, campaign.snapshot.id))
		.all();
	const countType = (type: CampaignEventType) => events.filter((event) => event.eventType === type).length;
	const completed = terminalStates.filter((state) => state.reason === 'completed').length;
	const skipped = terminalStates.filter((state) => state.reason === 'skipped').length;
	const terminal = completed + skipped;
	const slideViewCounts = new Map<string, number>();
	for (const event of events) {
		if (event.eventType === 'slide_viewed' && event.slideId) {
			slideViewCounts.set(event.slideId, (slideViewCounts.get(event.slideId) ?? 0) + 1);
		}
	}
	const slideViews = campaign.snapshot.slides
		.map((slide) => ({
			slideId: slide.id,
			sortOrder: slide.sortOrder,
			views: slideViewCounts.get(slide.id) ?? 0,
		}))
		.filter((slide) => slide.views > 0);
	return {
		autoShown: countType('auto_shown'),
		completed,
		skipped,
		replayOpened: countType('replay_opened'),
		completionRate: terminal > 0 ? completed / terminal : 0,
		slideViews,
	};
}

export async function seedFirstRunOnboardingTemplate(
	createdByUserId: string,
	options: CampaignServiceOptions = {},
) {
	const db = database(options);
	const existing = db
		.select()
		.from(announcementCampaigns)
		.where(
			and(
				eq(announcementCampaigns.type, 'first_run_onboarding'),
				inArray(announcementCampaigns.status, ['draft', 'published']),
			),
		)
		.orderBy(desc(announcementCampaigns.updatedAt))
		.get();
	if (existing) {
		const campaign = await getCampaignById(existing.id, { db });
		if (!campaign) throw new Error('Failed to load existing onboarding campaign.');
		return { campaign, created: false };
	}

	const nextId = idFactory(options);
	const campaign = await createCampaignDraft(
		{
			type: 'first_run_onboarding',
			name: 'First-run onboarding template',
			createdByUserId,
		},
		{ db, ids: [nextId()] },
	);
	const updated = await updateCampaignDraft(
		campaign.id,
		{
			slides: [
				{
					id: nextId(),
					layoutType: 'setup',
					sortOrder: 1,
					title: { en: 'Set up AlfyAI', hu: 'AlfyAI beállítása' },
					body: { en: 'Choose the defaults to review before publishing.', hu: 'Válaszd ki a közzététel előtt ellenőrizendő alapokat.' },
					altText: { en: 'Setup slide screenshot placeholder', hu: 'Beállító dia képernyőkép helyőrző' },
					setupControls: ['ui_language', 'theme', 'model_default', 'ai_style'],
				},
				{
					id: nextId(),
					layoutType: 'standard',
					sortOrder: 2,
					title: { en: 'Introduce a released feature', hu: 'Mutass be egy kiadott funkciót' },
					body: { en: 'Replace this draft copy with admin-authored campaign content.', hu: 'Cseréld ezt a vázlatot admin által írt kampányszövegre.' },
					altText: { en: 'Feature screenshot placeholder', hu: 'Funkció képernyőkép helyőrző' },
				},
				{
					id: nextId(),
					layoutType: 'standard',
					semanticRole: 'data_disclosure',
					sortOrder: 3,
					title: { en: 'Data processing disclosure', hu: 'Adatkezelési tájékoztató' },
					body: { en: 'Review and complete the disclosure before publishing.', hu: 'Ellenőrizd és egészítsd ki a tájékoztatót közzététel előtt.' },
					altText: { en: 'Disclosure screenshot placeholder', hu: 'Tájékoztató képernyőkép helyőrző' },
				},
			],
		},
		{ db },
	);
	return { campaign: updated, created: true };
}
