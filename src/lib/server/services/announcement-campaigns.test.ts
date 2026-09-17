import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedActionDestination } from "$lib/campaign-action-destinations";
import * as schema from "$lib/server/db/schema";
import { evaluateCampaignChecklist } from "../../../routes/(app)/settings/_components/campaigns/campaign-checklist";
import {
	archiveCampaign,
	completeCampaignForUser,
	createCampaignDraft,
	deleteCampaignDraft,
	duplicateCampaignAsDraft,
	getCampaignAnalyticsSummary,
	getCampaignById,
	getEligibleCampaignForUser,
	getLatestPublishedCampaign,
	publishCampaign,
	recordCampaignEvent,
	seedFirstRunOnboardingTemplate,
	updateCampaignDraft,
} from "./announcement-campaigns";
import {
	buildFirstRunOnboardingImageFreeSlides,
	buildFirstRunOnboardingSlides,
	createFirstRunOnboardingDraft,
	insertRequiredCampaignCrops,
	publishFirstRunOnboardingCampaign,
} from "./announcement-campaigns.test-helpers";

describe("announcement campaign service", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		db.insert(schema.users)
			.values([
				{
					id: "admin-user",
					email: "admin@example.com",
					passwordHash: "hash",
					role: "admin",
				},
				{
					id: "viewer-user",
					email: "viewer@example.com",
					passwordHash: "hash",
					role: "user",
				},
			])
			.run();
	});

	afterEach(() => {
		sqlite.close();
	});

	it("creates editable draft campaigns with system-generated identity and localized slides", async () => {
		const draft = await createFirstRunOnboardingDraft(db, {
			campaignId: "campaign-1",
			name: "First-run onboarding",
			slides: buildFirstRunOnboardingImageFreeSlides({
				setup: {
					id: "slide-setup",
					sortOrder: 10,
					title: { en: "Set up AlfyAI", hu: "AlfyAI beállítása" },
					body: {
						en: "Choose your starting defaults.",
						hu: "Válaszd ki a kezdő beállításokat.",
					},
					altText: { en: "Settings preview", hu: "Beállítások előnézete" },
				},
			}),
		});

		expect(draft).toMatchObject({
			id: "campaign-1",
			type: "first_run_onboarding",
			status: "draft",
			identityKey: "first_run_onboarding:v1:r1",
			campaignVersion: "v1",
			revision: 1,
			name: "First-run onboarding",
			releaseVersion: null,
		});
		expect(draft.slides).toHaveLength(2);
		expect(draft.slides.map((slide) => slide.sortOrder)).toEqual([2, 10]);

		const updated = await updateCampaignDraft(
			"campaign-1",
			{
				name: "Edited onboarding",
				slides: [
					{
						id: "slide-setup",
						layoutType: "setup",
						sortOrder: 10,
						title: { en: "Set up AlfyAI", hu: "AlfyAI beállítása" },
						body: {
							en: "Choose your starting defaults.",
							hu: "Válaszd ki a kezdő beállításokat.",
						},
						altText: { en: "Settings preview", hu: "Beállítások előnézete" },
					},
				],
			},
			{ db },
		);

		expect(updated.name).toBe("Edited onboarding");
		expect(updated.identityKey).toBe("first_run_onboarding:v1:r1");
		expect(updated.slides).toHaveLength(1);
		expect(updated.slides[0]).toMatchObject({
			id: "slide-setup",
			layoutType: "setup",
			sortOrder: 10,
			title: { en: "Set up AlfyAI", hu: "AlfyAI beállítása" },
			body: {
				en: "Choose your starting defaults.",
				hu: "Válaszd ki a kezdő beállításokat.",
			},
			altText: { en: "Settings preview", hu: "Beállítások előnézete" },
		});
	});

	it("publishes a valid first-run draft into immutable snapshot content and publishes crop assets", async () => {
		const published = await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-1",
			snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
			name: "Onboarding",
			slides: buildFirstRunOnboardingSlides({
				setup: {
					setupControls: ["ui_language", "theme", "model_default", "ai_style"],
				},
				disclosure: {
					body: {
						en: "Messages and files may use configured providers.",
						hu: "Az üzenetek és fájlok konfigurált szolgáltatókat használhatnak.",
					},
					altText: {
						en: "Data disclosure screenshot",
						hu: "Adatkezelési képernyőkép",
					},
				},
			}),
			assetPrefixes: ["setup", "disclosure"],
		});
		expect(published.status).toBe("published");
		expect(published.snapshot?.slides.map((slide) => slide.title.en)).toEqual([
			"Set up",
			"Data use",
		]);

		await expect(
			updateCampaignDraft(
				"campaign-1",
				{
					name: "Edited after publish",
					slides: [
						{
							id: "slide-setup",
							layoutType: "setup",
							sortOrder: 1,
							title: { en: "Changed", hu: "Módosítva" },
							body: { en: "Changed body.", hu: "Módosított törzs." },
							altText: { en: "Changed alt", hu: "Módosított alt" },
							desktopCropAssetId: "setup-desktop",
							mobileCropAssetId: "setup-mobile",
						},
					],
				},
				{ db },
			),
		).rejects.toMatchObject({
			fieldErrors: { status: "Only draft campaigns can be edited." },
		});

		const latest = await getLatestPublishedCampaign({ db });
		expect(latest?.slides.map((slide) => slide.title.en)).toEqual([
			"Set up",
			"Data use",
		]);

		const assets = db
			.select({
				id: schema.campaignAssets.id,
				status: schema.campaignAssets.status,
			})
			.from(schema.campaignAssets)
			.all();
		expect(assets).toEqual(
			expect.arrayContaining([
				{ id: "setup-desktop", status: "published" },
				{ id: "setup-mobile", status: "published" },
				{ id: "disclosure-desktop", status: "published" },
				{ id: "disclosure-mobile", status: "published" },
			]),
		);
	});

	it("returns publish validation errors for incomplete campaigns and type-specific requirements", async () => {
		await createCampaignDraft(
			{
				type: "release_update",
				name: "Release notes",
				createdByUserId: "admin-user",
			},
			{ db, ids: ["campaign-1"] },
		);

		await expect(
			publishCampaign("campaign-1", "admin-user", { db }),
		).rejects.toMatchObject({
			fieldErrors: expect.objectContaining({
				releaseVersion:
					"Release/update campaigns require a linked app version.",
				slides: "At least one slide is required.",
			}),
		});
	});

	it("rejects publish attempts with invalid slide interactions and unsupported setup controls", async () => {
		const slides = buildFirstRunOnboardingSlides({
			setup: {
				setupControls: ["ui_language", "unsupported_preference"],
			},
		});
		slides[0] = {
			...slides[0],
			actionDestination: "/external",
		};

		await expect(
			publishFirstRunOnboardingCampaign(db, {
				campaignId: "campaign-1",
				snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
				name: "Onboarding",
				slides,
				assetPrefixes: ["setup", "disclosure"],
			}),
		).rejects.toMatchObject({
			fieldErrors: expect.objectContaining({
				"slides.slide-setup.actionDestination":
					"Action destination must be an allowlisted internal route.",
				"slides.slide-setup.setupControls":
					"Setup controls include an unsupported preference control.",
			}),
		});
	});

	it("publishes slides without uploaded images and leaves snapshot crop ids empty", async () => {
		const published = await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-optional-images",
			snapshotIds: [
				"snapshot-no-images",
				"snapshot-slide-1",
				"snapshot-slide-2",
			],
			name: "Image-free onboarding",
			slides: buildFirstRunOnboardingImageFreeSlides({
				setup: {
					id: "setup-slide",
					setupControls: ["ui_language"],
				},
				disclosure: {
					id: "disclosure-slide",
					body: {
						en: "Review data use.",
						hu: "Tekintsd át az adathasználatot.",
					},
				},
			}),
		});

		expect(published.status).toBe("published");
		expect(
			published.snapshot?.slides.map((slide) => slide.desktopCropAssetId),
		).toEqual([null, null]);
		expect(
			published.snapshot?.slides.map((slide) => slide.mobileCropAssetId),
		).toEqual([null, null]);
	});

	it("deletes draft campaigns but refuses to delete published history", async () => {
		await createCampaignDraft(
			{
				type: "release_update",
				name: "Draft release",
				releaseVersion: "0.2.0",
				createdByUserId: "admin-user",
			},
			{ db, ids: ["draft-campaign"] },
		);
		await expect(deleteCampaignDraft("draft-campaign", { db })).resolves.toBe(
			true,
		);
		expect(await getCampaignById("draft-campaign", { db })).toBeNull();

		await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-1",
			snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
			name: "Onboarding",
			slides: buildFirstRunOnboardingSlides(),
			assetPrefixes: ["setup", "disclosure"],
		});

		await expect(
			deleteCampaignDraft("campaign-1", { db }),
		).rejects.toMatchObject({
			fieldErrors: { status: "Only draft campaigns can be deleted." },
		});
		expect(await getCampaignById("campaign-1", { db })).toMatchObject({
			status: "published",
		});
	});

	it("archives published campaigns and duplicates published history as a new draft revision", async () => {
		await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-1",
			snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
			name: "Onboarding",
			slides: buildFirstRunOnboardingSlides(),
			assetPrefixes: ["setup", "disclosure"],
		});

		const archived = await archiveCampaign("campaign-1", { db });
		expect(archived.status).toBe("archived");

		const duplicate = await duplicateCampaignAsDraft(
			"campaign-1",
			"admin-user",
			{
				db,
				ids: ["campaign-2", "slide-copy-1", "slide-copy-2"],
			},
		);
		expect(duplicate).toMatchObject({
			id: "campaign-2",
			status: "draft",
			identityKey: "first_run_onboarding:v1:r2",
			revision: 2,
			slides: expect.arrayContaining([
				expect.objectContaining({
					id: "slide-copy-1",
					title: { en: "Set up", hu: "Beállítás" },
				}),
			]),
		});
	});

	it("selects first-run campaigns before release campaigns and records completion state", async () => {
		insertRequiredCampaignCrops(db, "release");

		await seedFirstRunOnboardingTemplate("admin-user", {
			db,
			ids: [
				"template-campaign",
				"template-slide-1",
				"template-slide-2",
				"template-slide-3",
				"template-slide-4",
			],
		});
		expect(await getEligibleCampaignForUser("viewer-user", { db })).toBeNull();

		const onboarding = await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-1",
			snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
			name: "Onboarding",
			slides: buildFirstRunOnboardingSlides(),
			assetPrefixes: ["setup", "disclosure"],
		});

		await createCampaignDraft(
			{
				type: "release_update",
				name: "Release update",
				releaseVersion: "0.2.0",
				createdByUserId: "admin-user",
			},
			{ db, ids: ["campaign-2"] },
		);
		await updateCampaignDraft(
			"campaign-2",
			{
				slides: [
					{
						id: "release-slide",
						layoutType: "standard",
						sortOrder: 1,
						title: { en: "New release", hu: "Új kiadás" },
						body: { en: "Version details.", hu: "Verzió részletei." },
						altText: { en: "Release screenshot", hu: "Kiadási képernyőkép" },
						desktopCropAssetId: "release-desktop",
						mobileCropAssetId: "release-mobile",
					},
				],
			},
			{ db },
		);
		await publishCampaign("campaign-2", "admin-user", {
			db,
			ids: ["snapshot-2", "snap-slide-3"],
		});

		expect((await getEligibleCampaignForUser("viewer-user", { db }))?.id).toBe(
			onboarding.id,
		);

		await completeCampaignForUser(onboarding.id, "viewer-user", "completed", {
			db,
		});
		const eligible = await getEligibleCampaignForUser("viewer-user", { db });
		expect(eligible?.type).toBe("release_update");
	});

	it("records minimal analytics events and summarizes engagement without duplicate slide-view spam", async () => {
		const campaign = await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-1",
			snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
			name: "Onboarding",
			slides: buildFirstRunOnboardingSlides(),
			assetPrefixes: ["setup", "disclosure"],
		});

		await recordCampaignEvent(
			{
				campaignId: campaign.id,
				userId: "viewer-user",
				eventType: "auto_shown",
			},
			{ db, ids: ["event-1"] },
		);
		await recordCampaignEvent(
			{
				campaignId: campaign.id,
				userId: "viewer-user",
				eventType: "slide_viewed",
				slideId: "snap-slide-1",
			},
			{ db, ids: ["event-2"] },
		);
		await recordCampaignEvent(
			{
				campaignId: campaign.id,
				userId: "viewer-user",
				eventType: "slide_viewed",
				slideId: "snap-slide-1",
			},
			{ db, ids: ["event-duplicate"] },
		);
		await recordCampaignEvent(
			{
				campaignId: campaign.id,
				userId: "viewer-user",
				eventType: "setup_preference_changed",
				slideId: "snap-slide-1",
				metadata: { preference: "theme", value: "dark", ignored: "free text" },
			},
			{ db, ids: ["event-3"] },
		);
		await completeCampaignForUser(campaign.id, "viewer-user", "skipped", {
			db,
			ids: ["state-1", "event-4"],
		});

		const summary = await getCampaignAnalyticsSummary(campaign.id, { db });
		expect(summary).toMatchObject({
			autoShown: 1,
			completed: 0,
			skipped: 1,
			replayOpened: 0,
			completionRate: 0,
			slideViews: [{ slideId: "snap-slide-1", sortOrder: 1, views: 1 }],
		});

		const rows = db.select().from(schema.announcementCampaignEvents).all();
		expect(rows).toHaveLength(4);
		expect(
			JSON.parse(
				rows.find((row) => row.eventType === "setup_preference_changed")
					?.metadataJson ?? "{}",
			),
		).toEqual({
			preference: "theme",
			value: "dark",
		});
	});

	it("counts terminal completion analytics once per user even if completion is submitted twice", async () => {
		const campaign = await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-1",
			snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
			name: "Onboarding",
			slides: buildFirstRunOnboardingSlides(),
			assetPrefixes: ["setup", "disclosure"],
		});

		await completeCampaignForUser(campaign.id, "viewer-user", "completed", {
			db,
			ids: ["state-1", "event-1"],
		});
		await completeCampaignForUser(campaign.id, "viewer-user", "completed", {
			db,
			ids: ["state-ignored", "event-ignored"],
		});

		await expect(
			getCampaignAnalyticsSummary(campaign.id, { db }),
		).resolves.toMatchObject({
			completed: 1,
			skipped: 0,
			completionRate: 1,
		});
	});

	it("rejects event slide ids that are not part of the active published snapshot", async () => {
		const campaign = await publishFirstRunOnboardingCampaign(db, {
			campaignId: "campaign-1",
			snapshotIds: ["snapshot-1", "snap-slide-1", "snap-slide-2"],
			name: "Onboarding",
			slides: buildFirstRunOnboardingSlides(),
			assetPrefixes: ["setup", "disclosure"],
		});

		await expect(
			recordCampaignEvent(
				{
					campaignId: campaign.id,
					userId: "viewer-user",
					eventType: "slide_viewed",
					slideId: "draft-slide-id",
				},
				{ db },
			),
		).rejects.toMatchObject({
			fieldErrors: {
				slideId: "Slide does not belong to the active campaign snapshot.",
			},
		});
	});

	it("seeds the first-run onboarding template idempotently as an unpublished draft", async () => {
		const first = await seedFirstRunOnboardingTemplate("admin-user", {
			db,
			ids: [
				"campaign-template",
				"template-slide-setup",
				"template-slide-import",
				"template-slide-feature",
				"template-slide-disclosure",
			],
		});
		const second = await seedFirstRunOnboardingTemplate("admin-user", { db });

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(first.campaign.status).toBe("draft");
		expect(first.campaign.slides.map((slide) => slide.layoutType)).toEqual([
			"setup",
			"standard",
			"standard",
			"standard",
		]);
		expect(
			first.campaign.slides.some(
				(slide) => slide.semanticRole === "data_disclosure",
			),
		).toBe(true);
		expect(await getEligibleCampaignForUser("viewer-user", { db })).toBeNull();
	});

	it("includes an import ChatGPT slide in the seeded onboarding template", async () => {
		const seeded = await seedFirstRunOnboardingTemplate("admin-user", {
			db,
			ids: ["campaign-template", "t-s-1", "t-s-2", "t-s-3", "t-s-4"],
		});

		expect(seeded.created).toBe(true);
		const slides = seeded.campaign.slides;
		expect(slides).toHaveLength(4);

		const importSlide = slides[1];
		expect(importSlide.layoutType).toBe("standard");
		expect(importSlide.sortOrder).toBe(2);
		expect(importSlide.title.en).toBe("Bring Your ChatGPT History");
		expect(importSlide.title.hu).toBe("Hozd át a ChatGPT előzményeidet");
		expect(importSlide.body.en).toContain(
			"Import your conversations from ChatGPT",
		);
		expect(importSlide.body.hu).toContain(
			"Importáld a ChatGPT beszélgetéseidet",
		);
		expect(importSlide.actionLabel.en).toBe("Import from ChatGPT");
		expect(importSlide.actionLabel.hu).toBe("Importálás ChatGPT-ből");
		expect(importSlide.actionDestination).toBe("internal:chatgpt-import");
	});

	it("keeps a saved seeded first-run campaign publishable with setup controls and data disclosure role", async () => {
		insertRequiredCampaignCrops(db, "setup");
		insertRequiredCampaignCrops(db, "import");
		insertRequiredCampaignCrops(db, "feature");
		insertRequiredCampaignCrops(db, "disclosure");
		const seeded = await seedFirstRunOnboardingTemplate("admin-user", {
			db,
			ids: [
				"campaign-template",
				"template-slide-setup",
				"template-slide-import",
				"template-slide-feature",
				"template-slide-disclosure",
			],
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
					desktopCropAssetId:
						index === 0
							? "setup-desktop"
							: index === 1
								? "import-desktop"
								: index === 2
									? "feature-desktop"
									: "disclosure-desktop",
					mobileCropAssetId:
						index === 0
							? "setup-mobile"
							: index === 1
								? "import-mobile"
								: index === 2
									? "feature-mobile"
									: "disclosure-mobile",
				})),
			},
			{ db },
		);

		expect(saved.slides[0]?.setupControls).toEqual([
			"ui_language",
			"theme",
			"model_default",
			"ai_style",
		]);
		expect(saved.slides[3]?.semanticRole).toBe("data_disclosure");

		await expect(
			publishCampaign(saved.id, "admin-user", {
				db,
				ids: [
					"snapshot-1",
					"snap-slide-1",
					"snap-slide-2",
					"snap-slide-3",
					"snap-slide-4",
				],
			}),
		).resolves.toMatchObject({ status: "published" });
	});

	it("publishes the shipped first-run template with its action destination intact, and the admin checklist agrees", async () => {
		for (const prefix of ["setup", "import", "feature", "disclosure"]) {
			insertRequiredCampaignCrops(db, prefix);
		}
		const cropIds = [
			"setup",
			"import",
			"feature",
			"disclosure",
		] as const satisfies readonly string[];
		const seeded = await seedFirstRunOnboardingTemplate("admin-user", {
			db,
			ids: [
				"campaign-template",
				"template-slide-setup",
				"template-slide-import",
				"template-slide-feature",
				"template-slide-disclosure",
			],
		});

		// Unlike the older round-trip test, this one keeps actionLabel and
		// actionDestination, so the template's "internal:chatgpt-import" slide
		// actually reaches publish validation.
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
					actionLabel: slide.actionLabel,
					actionDestination: slide.actionDestination,
					setupControls: slide.setupControls,
					desktopCropAssetId: `${cropIds[index]}-desktop`,
					mobileCropAssetId: `${cropIds[index]}-mobile`,
				})),
			},
			{ db },
		);

		expect(saved.slides[1]?.actionDestination).toBe("internal:chatgpt-import");

		const published = await publishCampaign(saved.id, "admin-user", {
			db,
			ids: [
				"snapshot-1",
				"snap-slide-1",
				"snap-slide-2",
				"snap-slide-3",
				"snap-slide-4",
			],
		});
		expect(published.status).toBe("published");

		const checklist = evaluateCampaignChecklist({
			type: saved.type,
			name: saved.name,
			releaseVersion: saved.releaseVersion ?? "",
			slides: saved.slides.map((slide, index) => ({
				localId: slide.id,
				id: slide.id,
				kind: slide.layoutType,
				semanticRole: slide.semanticRole,
				sortOrder: index + 1,
				titleEn: slide.title.en,
				titleHu: slide.title.hu,
				bodyEn: slide.body.en,
				bodyHu: slide.body.hu,
				altEn: slide.altText.en,
				altHu: slide.altText.hu,
				actionLabelEn: slide.actionLabel.en,
				actionLabelHu: slide.actionLabel.hu,
				actionUrl: slide.actionDestination,
				desktopAssetId: `${cropIds[index]}-desktop`,
				mobileAssetId: `${cropIds[index]}-mobile`,
				setupControls: slide.setupControls ?? [],
			})),
		});
		expect(checklist.failures).toEqual([]);
		expect(checklist.ready).toBe(true);
	});

	it("publishes a release campaign whose slides point at allow-listed routes", async () => {
		insertRequiredCampaignCrops(db, "settings");
		insertRequiredCampaignCrops(db, "documents");
		await createCampaignDraft(
			{
				type: "release_update",
				name: "2.0 release notes",
				createdByUserId: "admin-user",
			},
			{ db, ids: ["campaign-release"] },
		);
		await updateCampaignDraft(
			"campaign-release",
			{
				releaseVersion: "2.0.0",
				slides: [
					{
						id: "release-slide-settings",
						layoutType: "standard",
						semanticRole: "feature",
						sortOrder: 1,
						title: { en: "Settings", hu: "Beállítások" },
						body: { en: "A new settings page.", hu: "Új beállítások oldal." },
						altText: { en: "Settings screenshot", hu: "Beállítások kép" },
						actionLabel: { en: "Open settings", hu: "Beállítások" },
						actionDestination: "/settings",
						desktopCropAssetId: "settings-desktop",
						mobileCropAssetId: "settings-mobile",
					},
					{
						id: "release-slide-documents",
						layoutType: "standard",
						semanticRole: "data_disclosure",
						sortOrder: 2,
						title: { en: "Documents", hu: "Dokumentumok" },
						body: { en: "Your files, searchable.", hu: "Kereshető fájlok." },
						altText: { en: "Documents screenshot", hu: "Dokumentumok kép" },
						actionLabel: { en: "Open documents", hu: "Dokumentumok" },
						actionDestination: "/knowledge?tab=documents",
						desktopCropAssetId: "documents-desktop",
						mobileCropAssetId: "documents-mobile",
					},
				],
			},
			{ db },
		);

		await expect(
			publishCampaign("campaign-release", "admin-user", {
				db,
				ids: ["snapshot-release", "snap-release-1", "snap-release-2"],
			}),
		).resolves.toMatchObject({ status: "published" });
	});

	it("rejects action destinations that leave the app or name an unknown internal action", async () => {
		const hostile = [
			"https://evil.example.com",
			"//evil.example.com",
			"javascript:alert(1)",
			"internal:chatgpt-import?next=https://evil.example.com",
			"internal:open-admin",
			"internal:",
			"/settings/../../etc/passwd",
		];

		insertRequiredCampaignCrops(db, "setup");
		insertRequiredCampaignCrops(db, "disclosure");

		for (const [index, actionDestination] of hostile.entries()) {
			// Slide ids are globally unique, so each case needs its own.
			const setupSlideId = `slide-setup-${index}`;
			const slides = buildFirstRunOnboardingSlides({
				setup: { id: setupSlideId },
				disclosure: { id: `slide-disclosure-${index}` },
			});
			slides[0] = {
				...slides[0],
				actionLabel: { en: "Go", hu: "Menj" },
				actionDestination,
			};

			await expect(
				publishFirstRunOnboardingCampaign(db, {
					campaignId: `campaign-hostile-${index}`,
					snapshotIds: [
						`snapshot-hostile-${index}`,
						`snap-hostile-${index}-1`,
						`snap-hostile-${index}-2`,
					],
					name: `Hostile ${index}`,
					slides,
				}),
			).rejects.toMatchObject({
				fieldErrors: expect.objectContaining({
					[`slides.${setupSlideId}.actionDestination`]:
						"Action destination must be an allowlisted internal route.",
				}),
			});

			expect(isAllowedActionDestination(actionDestination)).toBe(false);
		}
	});
});
