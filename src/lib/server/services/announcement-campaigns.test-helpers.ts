import type { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "$lib/server/db/schema";
import {
	type CampaignSlideInput,
	createCampaignDraft,
	publishCampaign,
	updateCampaignDraft,
} from "./announcement-campaigns";

type CampaignTestDb = ReturnType<typeof drizzle<typeof schema>>;

type LocalizedText = {
	en: string;
	hu: string;
};

type FirstRunOnboardingSlideOverrides = Partial<{
	id: string;
	layoutType: "setup" | "standard";
	semanticRole: "feature" | "data_disclosure";
	sortOrder: number;
	title: LocalizedText;
	body: LocalizedText;
	altText: LocalizedText;
	desktopCropAssetId: string | null;
	mobileCropAssetId: string | null;
	setupControls: string[];
}>;

type BuildFirstRunOnboardingSlidesOptions = {
	setup?: FirstRunOnboardingSlideOverrides;
	disclosure?: FirstRunOnboardingSlideOverrides;
};

const defaultSetupSlide = {
	id: "slide-setup",
	layoutType: "setup" as const,
	sortOrder: 1,
	semanticRole: "feature" as const,
	title: { en: "Set up", hu: "Beállítás" },
	body: { en: "Choose defaults.", hu: "Válassz alapokat." },
	altText: { en: "Setup screenshot", hu: "Beállítás képernyőkép" },
	desktopCropAssetId: "setup-desktop",
	mobileCropAssetId: "setup-mobile",
	setupControls: ["ui_language", "theme", "model_default", "ai_style"],
};

const defaultDisclosureSlide = {
	id: "slide-disclosure",
	layoutType: "standard" as const,
	semanticRole: "data_disclosure" as const,
	sortOrder: 2,
	title: { en: "Data use", hu: "Adathasználat" },
	body: {
		en: "Messages may use providers.",
		hu: "Az üzenetek szolgáltatókat használhatnak.",
	},
	altText: { en: "Disclosure screenshot", hu: "Tájékoztató képernyőkép" },
	desktopCropAssetId: "disclosure-desktop",
	mobileCropAssetId: "disclosure-mobile",
};

function mergeSlide(
	base: typeof defaultSetupSlide | typeof defaultDisclosureSlide,
	overrides: FirstRunOnboardingSlideOverrides | undefined,
): CampaignSlideInput {
	return {
		...base,
		...overrides,
		title: { ...base.title, ...overrides?.title },
		body: { ...base.body, ...overrides?.body },
		altText: { ...base.altText, ...overrides?.altText },
		setupControls:
			overrides?.setupControls ??
			("setupControls" in base ? base.setupControls : undefined),
	};
}

export function insertCampaignCrop(
	db: CampaignTestDb,
	id: string,
	variant: "desktop" | "mobile",
) {
	db.insert(schema.campaignAssets)
		.values({
			id,
			uploadedByUserId: "admin-user",
			assetKind: "crop",
			variant,
			status: "draft",
			originalFilename: `${id}.png`,
			mimeType: "image/png",
			sizeBytes: 12,
			storagePath: `crops/${id}.png`,
		})
		.run();
}

export function insertRequiredCampaignCrops(
	db: CampaignTestDb,
	prefix: string,
) {
	insertCampaignCrop(db, `${prefix}-desktop`, "desktop");
	insertCampaignCrop(db, `${prefix}-mobile`, "mobile");
}

export function buildFirstRunOnboardingSlides(
	options: BuildFirstRunOnboardingSlidesOptions = {},
): [CampaignSlideInput, CampaignSlideInput] {
	return [
		mergeSlide(defaultSetupSlide, options.setup),
		mergeSlide(defaultDisclosureSlide, options.disclosure),
	];
}

export function buildFirstRunOnboardingImageFreeSlides(
	options: BuildFirstRunOnboardingSlidesOptions = {},
): [CampaignSlideInput, CampaignSlideInput] {
	return buildFirstRunOnboardingSlides({
		setup: {
			desktopCropAssetId: null,
			mobileCropAssetId: null,
			altText: { en: "", hu: "" },
			...options.setup,
		},
		disclosure: {
			desktopCropAssetId: null,
			mobileCropAssetId: null,
			altText: { en: "", hu: "" },
			...options.disclosure,
		},
	});
}

export async function createFirstRunOnboardingDraft(
	db: CampaignTestDb,
	input: {
		campaignId: string;
		name: string;
		slides: CampaignSlideInput[];
	},
) {
	await createCampaignDraft(
		{
			type: "first_run_onboarding",
			name: input.name,
			createdByUserId: "admin-user",
		},
		{ db, ids: [input.campaignId] },
	);

	return updateCampaignDraft(
		input.campaignId,
		{
			slides: input.slides,
		},
		{ db },
	);
}

export async function publishFirstRunOnboardingCampaign(
	db: CampaignTestDb,
	input: {
		campaignId: string;
		snapshotIds: [string, string, string];
		name: string;
		slides: CampaignSlideInput[];
		assetPrefixes?: string[];
	},
) {
	for (const prefix of input.assetPrefixes ?? []) {
		insertRequiredCampaignCrops(db, prefix);
	}

	await createFirstRunOnboardingDraft(db, {
		campaignId: input.campaignId,
		name: input.name,
		slides: input.slides,
	});

	return publishCampaign(input.campaignId, "admin-user", {
		db,
		ids: input.snapshotIds,
	});
}

/**
 * A published release update with one image-free slide. The slide and snapshot
 * ids are made from `campaignId`, so any number of releases can sit in one
 * database.
 */
export async function publishReleaseUpdateCampaign(
	db: CampaignTestDb,
	input: {
		campaignId: string;
		name: string;
		releaseVersion: string;
	},
) {
	await createCampaignDraft(
		{
			type: "release_update",
			name: input.name,
			releaseVersion: input.releaseVersion,
			createdByUserId: "admin-user",
		},
		{ db, ids: [input.campaignId] },
	);
	await updateCampaignDraft(
		input.campaignId,
		{
			slides: [
				{
					id: `${input.campaignId}-slide`,
					layoutType: "standard",
					sortOrder: 1,
					title: { en: `${input.name}: news`, hu: `${input.name}: hírek` },
					body: { en: "What changed.", hu: "Ami változott." },
				},
			],
		},
		{ db },
	);
	return publishCampaign(input.campaignId, "admin-user", {
		db,
		ids: [`${input.campaignId}-snapshot`, `${input.campaignId}-snap-slide`],
	});
}
