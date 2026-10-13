import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedActionDestination } from "$lib/campaign-action-destinations";
import artifactsDict from "$lib/i18n/artifacts";
import chatDict from "$lib/i18n/chat";
import commonDict from "$lib/i18n/common";
import knowledgeDict from "$lib/i18n/knowledge";
import projectsDict from "$lib/i18n/projects";
import settingsDict from "$lib/i18n/settings";
import { createInMemoryDatabase } from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	completeCampaignForUser,
	getEligibleCampaignForUser,
	publishCampaign,
} from "$lib/server/services/announcement-campaigns";
import {
	ADMIN_CAMPAIGNS_PATH,
	CampaignRunError,
	type CliOptions,
	CliUsageError,
	checkDataLocations,
	DeckValidationError,
	loadDeck,
	parseArgs,
	pngCounterpart,
	readImageInfo,
	runCreateReleaseCampaign,
} from "./create-release-campaign";

// ---------------------------------------------------------------------------
// A deck fixture shaped exactly like the real 2.0 deck: four slides, localized
// everywhere, two of them carrying the real action destinations.
// ---------------------------------------------------------------------------

function svg(width: number, height: number): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
		`width="${width}" height="${height}"><rect width="100%" height="100%" fill="#F7F3EC"/></svg>`
	);
}

/** A 1x1 PNG, resized in its IHDR so the header reports the target geometry. */
function png(width: number, height: number): Buffer {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write("IHDR", 4, "ascii");
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	ihdr.writeUInt8(8, 16);
	ihdr.writeUInt8(6, 17);
	return Buffer.concat([signature, ihdr]);
}

const SLIDE_SPECS = [
	{ slug: "01-redesigned-ui", action: null },
	{ slug: "02-chat-tools-and-rows", action: "/settings" },
	{ slug: "03-atlas-research", action: "/knowledge?tab=documents" },
	{ slug: "04-maps-and-transit", action: null },
] as const;

type DeckOverrides = {
	slides?: (manifest: Record<string, unknown>[]) => Record<string, unknown>[];
	desktopSize?: { width: number; height: number };
	withPngDir?: boolean;
};

function writeDeck(root: string, overrides: DeckOverrides = {}): string {
	const dir = join(root, "deck");
	mkdirSync(join(dir, "slides"), { recursive: true });
	const desktop = overrides.desktopSize ?? { width: 1600, height: 1000 };

	let manifest: Record<string, unknown>[] = SLIDE_SPECS.map((spec, index) => {
		const entry: Record<string, unknown> = {
			titleEn: `Title ${index + 1}`,
			titleHu: `Cím ${index + 1}`,
			bodyEn: `Body ${index + 1}`,
			bodyHu: `Törzsszöveg ${index + 1}`,
			altTextEn: `Alt ${index + 1}`,
			altTextHu: `Helyettesítő szöveg ${index + 1}`,
			desktopFile: `slides/${spec.slug}-desktop.svg`,
			mobileFile: `slides/${spec.slug}-mobile.svg`,
		};
		if (spec.action) {
			entry.actionLabelEn = `Action ${index + 1}`;
			entry.actionLabelHu = `Művelet ${index + 1}`;
			entry.actionDestination = spec.action;
		}
		return entry;
	});

	for (const spec of SLIDE_SPECS) {
		writeFileSync(
			join(dir, "slides", `${spec.slug}-desktop.svg`),
			svg(desktop.width, desktop.height),
		);
		writeFileSync(
			join(dir, "slides", `${spec.slug}-mobile.svg`),
			svg(1080, 1920),
		);
	}

	if (overrides.withPngDir) {
		mkdirSync(join(dir, ".work", "png"), { recursive: true });
		for (const spec of SLIDE_SPECS) {
			writeFileSync(
				join(dir, ".work", "png", `${spec.slug}-desktop.png`),
				png(1600, 1000),
			);
			writeFileSync(
				join(dir, ".work", "png", `${spec.slug}-mobile.png`),
				png(1080, 1920),
			);
		}
	}

	if (overrides.slides) manifest = overrides.slides(manifest);
	writeFileSync(join(dir, "slides.json"), JSON.stringify(manifest, null, 2));
	return dir;
}

/**
 * A deck shaped like a first-run onboarding: a setup slide first, two feature
 * slides, and the data disclosure last (the two things the service's publish
 * validation asks of one).
 */
function writeOnboardingDeck(
	root: string,
	overrides: {
		slides?: (manifest: Record<string, unknown>[]) => Record<string, unknown>[];
	} = {},
): string {
	const dir = join(root, "onboarding-deck");
	mkdirSync(join(dir, "slides"), { recursive: true });
	const specs = [
		{ slug: "01-welcome", layoutType: "setup" },
		{ slug: "02-ask", layoutType: "standard" },
		{ slug: "03-makes", layoutType: "standard" },
		{ slug: "04-data", layoutType: "standard", role: "data_disclosure" },
	] as const;
	let manifest: Record<string, unknown>[] = specs.map((spec, index) => {
		const entry: Record<string, unknown> = {
			titleEn: `Title ${index + 1}`,
			titleHu: `Cím ${index + 1}`,
			bodyEn: `Body ${index + 1}`,
			bodyHu: `Törzsszöveg ${index + 1}`,
			altTextEn: `Alt ${index + 1}`,
			altTextHu: `Helyettesítő szöveg ${index + 1}`,
			desktopFile: `slides/${spec.slug}-desktop.svg`,
			mobileFile: `slides/${spec.slug}-mobile.svg`,
		};
		if (spec.layoutType === "setup") {
			entry.layoutType = "setup";
			entry.setupControls = [
				"ui_language",
				"theme",
				"model_default",
				"ai_style",
			];
		}
		if ("role" in spec) entry.semanticRole = spec.role;
		return entry;
	});
	for (const spec of specs) {
		writeFileSync(
			join(dir, "slides", `${spec.slug}-desktop.svg`),
			svg(1600, 1000),
		);
		writeFileSync(
			join(dir, "slides", `${spec.slug}-mobile.svg`),
			svg(1080, 1920),
		);
	}
	if (overrides.slides) manifest = overrides.slides(manifest);
	writeFileSync(join(dir, "slides.json"), JSON.stringify(manifest, null, 2));
	return dir;
}

function options(overrides: Partial<CliOptions> = {}): CliOptions {
	return {
		type: "release",
		deck: "",
		name: "AlfyAI 2.0",
		version: "2.0.0",
		adminEmail: "admin@example.com",
		pngDir: null,
		publish: false,
		dryRun: false,
		replaceDraft: false,
		...overrides,
	};
}

describe("create-release-campaign", () => {
	let memory: ReturnType<typeof createInMemoryDatabase>;
	let db: ReturnType<typeof createInMemoryDatabase>["db"];
	let root: string;
	let storageRoot: string;
	let deckDir: string;

	beforeEach(() => {
		memory = createInMemoryDatabase();
		db = memory.db;
		root = mkdtempSync(join(tmpdir(), "alfyai-release-campaign-"));
		storageRoot = join(root, "data", "campaign-assets");
		deckDir = writeDeck(root, { withPngDir: true });

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
					// An account that was here before any campaign below is published: a
					// release update is for those (announcement-campaigns.audience.test.ts).
					createdAt: new Date(Date.now() - 30 * 86_400_000),
				},
			])
			.run();
	});

	afterEach(() => {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Argument parsing
	// -----------------------------------------------------------------------

	describe("parseArgs", () => {
		it("reads both --flag value and --flag=value forms", () => {
			const parsed = parseArgs([
				"--deck",
				"./deck",
				"--name=AlfyAI 2.0",
				"--version",
				"2.0.0",
				"--admin-email=admin@example.com",
				"--publish",
				"--replace-draft",
			]);
			expect(parsed).toMatchObject({
				deck: "./deck",
				name: "AlfyAI 2.0",
				version: "2.0.0",
				adminEmail: "admin@example.com",
				publish: true,
				replaceDraft: true,
				dryRun: false,
				pngDir: null,
			});
		});

		it("refuses a missing required flag, an unknown flag, and a value-less flag", () => {
			expect(() => parseArgs(["--name", "x"])).toThrow(CliUsageError);
			expect(() => parseArgs(["--nope", "x"])).toThrow(/Unknown option/);
			expect(() =>
				parseArgs([
					"--deck",
					"--name",
					"x",
					"--version",
					"1",
					"--admin-email",
					"a@b",
				]),
			).toThrow(/--deck requires a value/);
		});

		it("refuses a value pinned onto a boolean flag rather than silently ignoring it", () => {
			expect(() =>
				parseArgs([
					"--deck=d",
					"--name=n",
					"--version=1",
					"--admin-email=a@b",
					"--dry-run=false",
				]),
			).toThrow(/--dry-run does not take a value/);
		});

		it("makes a release of it unless --type onboarding is given, and then wants no --version", () => {
			const release = parseArgs([
				"--deck=d",
				"--name=n",
				"--version=2.0.0",
				"--admin-email=a@b",
			]);
			expect(release).toMatchObject({ type: "release", version: "2.0.0" });

			const onboarding = parseArgs([
				"--type",
				"onboarding",
				"--deck=d",
				"--name=n",
				"--admin-email=a@b",
			]);
			expect(onboarding).toMatchObject({ type: "onboarding", version: null });

			// A release needs its version; an onboarding has none to give.
			expect(() =>
				parseArgs(["--deck=d", "--name=n", "--admin-email=a@b"]),
			).toThrow(/--version is required/);
			expect(() =>
				parseArgs([
					"--type=onboarding",
					"--deck=d",
					"--name=n",
					"--version=2.2.0",
					"--admin-email=a@b",
				]),
			).toThrow(/--version does not apply to --type onboarding/);
			expect(() =>
				parseArgs(["--type=tour", "--deck=d", "--name=n", "--admin-email=a@b"]),
			).toThrow(/--type must be release or onboarding/);
		});
	});

	// -----------------------------------------------------------------------
	// Deck validation
	// -----------------------------------------------------------------------

	describe("loadDeck", () => {
		it("accepts the four-slide deck and keeps slide order", () => {
			const deck = loadDeck(deckDir, { isAllowedActionDestination });
			expect(deck.slides).toHaveLength(4);
			expect(deck.slides.map((slide) => slide.index)).toEqual([1, 2, 3, 4]);
			expect(deck.slides[1].actionDestination).toBe("/settings");
			expect(deck.slides[2].actionDestination).toBe("/knowledge?tab=documents");
			expect(deck.slides[0].images.desktop).toMatchObject({
				mimeType: "image/svg+xml",
				width: 1600,
				height: 1000,
			});
			expect(deck.slides[0].images.mobile).toMatchObject({
				mimeType: "image/svg+xml",
				width: 1080,
				height: 1920,
			});
		});

		it("rejects a deck with fewer than four slides", () => {
			const dir = writeDeck(mkdtempSync(join(tmpdir(), "short-deck-")), {
				slides: (manifest) => manifest.slice(0, 3),
			});
			expect(() => loadDeck(dir, { isAllowedActionDestination })).toThrow(
				/at least 4 are required/,
			);
		});

		it("names every missing localized field instead of failing on the first", () => {
			const dir = writeDeck(mkdtempSync(join(tmpdir(), "bad-deck-")), {
				slides: (manifest) => {
					manifest[0].titleHu = "  ";
					manifest[1].bodyEn = "";
					delete manifest[2].altTextHu;
					return manifest;
				},
			});
			let problems: string[] = [];
			try {
				loadDeck(dir, { isAllowedActionDestination });
			} catch (error) {
				problems = (error as DeckValidationError).problems;
			}
			expect(problems).toEqual(
				expect.arrayContaining([
					expect.stringContaining("slide 1: titleHu"),
					expect.stringContaining("slide 2: bodyEn"),
					expect.stringContaining("slide 3: altTextHu"),
				]),
			);
		});

		it("rejects an off-ratio image before the asset service would", () => {
			const dir = writeDeck(mkdtempSync(join(tmpdir(), "ratio-deck-")), {
				desktopSize: { width: 1600, height: 900 },
			});
			expect(() => loadDeck(dir, { isAllowedActionDestination })).toThrow(
				/1600x900.*16:10 ratio/s,
			);
		});

		it("rejects an action destination that is not on the allowlist", () => {
			const dir = writeDeck(mkdtempSync(join(tmpdir(), "dest-deck-")), {
				slides: (manifest) => {
					manifest[1].actionDestination = "https://evil.example/phish";
					return manifest;
				},
			});
			expect(() => loadDeck(dir, { isAllowedActionDestination })).toThrow(
				/is not on the allowlist/,
			);
		});

		it("refuses a slide file reference that escapes the deck directory", () => {
			const dir = writeDeck(mkdtempSync(join(tmpdir(), "escape-deck-")), {
				slides: (manifest) => {
					manifest[0].desktopFile = "../../../etc/passwd";
					return manifest;
				},
			});
			expect(() => loadDeck(dir, { isAllowedActionDestination })).toThrow(
				/escapes the deck directory/,
			);
		});

		it("reads the PNG counterparts when --png-dir is given", () => {
			const deck = loadDeck(deckDir, {
				pngDir: join(deckDir, ".work", "png"),
				isAllowedActionDestination,
			});
			expect(deck.slides).toHaveLength(4);
			for (const slide of deck.slides) {
				expect(slide.images.desktop.mimeType).toBe("image/png");
				expect(slide.images.mobile.mimeType).toBe("image/png");
			}
			expect(
				pngCounterpart("/png", "slides/01-redesigned-ui-desktop.svg"),
			).toBe("/png/01-redesigned-ui-desktop.png");
		});
	});

	describe("readImageInfo", () => {
		it("falls back to the viewBox when the root carries no width/height", () => {
			const path = join(root, "viewbox.svg");
			writeFileSync(
				path,
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000"></svg>',
			);
			expect(readImageInfo(path)).toMatchObject({ width: 1600, height: 1000 });
		});

		it("refuses a file that is not really a PNG", () => {
			const path = join(root, "fake.png");
			writeFileSync(path, "not a png");
			expect(() => readImageInfo(path)).toThrow(/bad signature/);
		});
	});

	// -----------------------------------------------------------------------
	// checkDataLocations
	// -----------------------------------------------------------------------

	describe("checkDataLocations", () => {
		it("refuses to run where there is no data directory", () => {
			const { problems } = checkDataLocations(
				root,
				join(root, "data", "chat.db"),
			);
			expect(problems[0]).toMatch(/No data directory/);
		});

		it("refuses when the database and the asset directory belong to different deployments", () => {
			mkdirSync(join(root, "data"), { recursive: true });
			mkdirSync(join(root, "other"), { recursive: true });
			const { problems } = checkDataLocations(
				root,
				join(root, "other", "chat.db"),
			);
			expect(problems[0]).toMatch(/different deployments/);
		});

		it("passes when the database sits in the release's own data directory", () => {
			mkdirSync(join(root, "data"), { recursive: true });
			const { problems, storageRoot: resolved } = checkDataLocations(
				root,
				join(root, "data", "chat.db"),
			);
			expect(problems).toEqual([]);
			expect(resolved).toBe(join(root, "data", "campaign-assets"));
		});
	});

	// -----------------------------------------------------------------------
	// The run
	// -----------------------------------------------------------------------

	it("creates a draft with four slides, both breakpoints, and files on disk", async () => {
		const result = await runCreateReleaseCampaign(options({ deck: deckDir }), {
			db,
			storageRoot,
		});

		expect(result).toMatchObject({
			dryRun: false,
			status: "draft",
			name: "AlfyAI 2.0",
			releaseVersion: "2.0.0",
			slideCount: 4,
			assetCount: 8,
			adminUserId: "admin-user",
			adminUrl: ADMIN_CAMPAIGNS_PATH,
			replacedDraftId: null,
		});
		expect(result.identityKey).toBe("release_update:2.0.0:r1");

		const slides = db
			.select()
			.from(schema.announcementCampaignSlides)
			.where(
				eq(
					schema.announcementCampaignSlides.campaignId,
					result.campaignId as string,
				),
			)
			.all()
			.sort((a, b) => a.sortOrder - b.sortOrder);

		expect(slides).toHaveLength(4);
		expect(slides.map((slide) => slide.sortOrder)).toEqual([1, 2, 3, 4]);
		for (const slide of slides) {
			expect(slide.layoutType).toBe("standard");
			expect(slide.semanticRole).toBe("feature");
			expect(slide.desktopCropAssetId).toBeTruthy();
			expect(slide.mobileCropAssetId).toBeTruthy();
			expect(slide.titleEn).toBeTruthy();
			expect(slide.titleHu).toBeTruthy();
			expect(slide.altTextEn).toBeTruthy();
			expect(slide.altTextHu).toBeTruthy();
		}
		expect(slides[1].actionDestination).toBe("/settings");
		expect(slides[1].actionLabelHu).toBe("Művelet 2");
		expect(slides[2].actionDestination).toBe("/knowledge?tab=documents");
		// A slide with no action keeps a null destination and null labels, which is
		// what the publish validation reads as "no action button".
		expect(slides[0].actionDestination).toBeNull();
		expect(slides[0].actionLabelEn).toBeNull();

		// Four sources plus four crops per breakpoint, written where the server
		// serves them from.
		const assets = db.select().from(schema.campaignAssets).all();
		expect(assets.filter((asset) => asset.assetKind === "source")).toHaveLength(
			8,
		);
		const crops = assets.filter((asset) => asset.assetKind === "crop");
		expect(crops).toHaveLength(8);
		expect(crops.filter((asset) => asset.variant === "desktop")).toHaveLength(
			4,
		);
		expect(crops.filter((asset) => asset.variant === "mobile")).toHaveLength(4);
		for (const crop of crops) {
			expect(crop.mimeType).toBe("image/svg+xml");
			expect(crop.status).toBe("draft");
			expect(crop.sourceAssetId).toBeTruthy();
			expect(crop.zoom).toBe(1);
			const ratio = (crop.cropWidth as number) / (crop.cropHeight as number);
			expect(ratio).toBeCloseTo(
				crop.variant === "desktop" ? 16 / 10 : 9 / 16,
				5,
			);
		}

		expect(readdirSync(join(storageRoot, "sources"))).toHaveLength(8);
		expect(readdirSync(join(storageRoot, "crops"))).toHaveLength(8);
	});

	it("publishes with the real deck's action destinations, passing the service's own validation", async () => {
		const result = await runCreateReleaseCampaign(
			options({ deck: deckDir, publish: true }),
			{ db, storageRoot },
		);

		expect(result.status).toBe("published");

		const snapshotSlides = db
			.select()
			.from(schema.announcementCampaignSnapshotSlides)
			.all()
			.sort((a, b) => a.sortOrder - b.sortOrder);
		expect(snapshotSlides).toHaveLength(4);
		expect(snapshotSlides.map((slide) => slide.actionDestination)).toEqual([
			null,
			"/settings",
			"/knowledge?tab=documents",
			null,
		]);

		// Publishing flips the referenced crops to published so a non-admin viewer
		// may be served them; the sources stay draft and admin-only.
		const assets = db.select().from(schema.campaignAssets).all();
		expect(
			assets
				.filter((a) => a.assetKind === "crop")
				.every((a) => a.status === "published"),
		).toBe(true);
		expect(
			assets
				.filter((a) => a.assetKind === "source")
				.every((a) => a.status === "draft"),
		).toBe(true);
	});

	// -----------------------------------------------------------------------
	// The first-run onboarding (--type onboarding)
	// -----------------------------------------------------------------------

	describe("a first-run onboarding deck", () => {
		let onboardingDir: string;

		beforeEach(() => {
			onboardingDir = writeOnboardingDeck(root);
		});

		it("reads the setup slide, its controls and the data disclosure", () => {
			const deck = loadDeck(onboardingDir, {
				isAllowedActionDestination,
				type: "onboarding",
			});

			expect(deck.slides.map((slide) => slide.layoutType)).toEqual([
				"setup",
				"standard",
				"standard",
				"standard",
			]);
			expect(deck.slides[0].setupControls).toEqual([
				"ui_language",
				"theme",
				"model_default",
				"ai_style",
			]);
			expect(deck.slides.map((slide) => slide.semanticRole)).toEqual([
				"feature",
				"feature",
				"feature",
				"data_disclosure",
			]);
		});

		it("asks for exactly one setup slide and at least one data disclosure", () => {
			const noSetup = writeOnboardingDeck(
				mkdtempSync(join(tmpdir(), "no-setup-")),
				{
					slides: (manifest) => {
						delete manifest[0].layoutType;
						delete manifest[0].setupControls;
						return manifest;
					},
				},
			);
			expect(() =>
				loadDeck(noSetup, { isAllowedActionDestination, type: "onboarding" }),
			).toThrow(/exactly one setup slide.*it has 0/s);

			const twoSetups = writeOnboardingDeck(
				mkdtempSync(join(tmpdir(), "two-setups-")),
				{
					slides: (manifest) => {
						manifest[1].layoutType = "setup";
						manifest[1].setupControls = ["theme"];
						return manifest;
					},
				},
			);
			expect(() =>
				loadDeck(twoSetups, { isAllowedActionDestination, type: "onboarding" }),
			).toThrow(/exactly one setup slide.*it has 2/s);

			const noDisclosure = writeOnboardingDeck(
				mkdtempSync(join(tmpdir(), "no-disclosure-")),
				{
					slides: (manifest) => {
						delete manifest[3].semanticRole;
						return manifest;
					},
				},
			);
			expect(() =>
				loadDeck(noDisclosure, {
					isAllowedActionDestination,
					type: "onboarding",
				}),
			).toThrow(/needs a data disclosure slide/);
		});

		it("refuses setup controls that are unknown or sit on a slide that is not the setup slide", () => {
			const dir = writeOnboardingDeck(
				mkdtempSync(join(tmpdir(), "controls-")),
				{
					slides: (manifest) => {
						manifest[0].setupControls = ["theme", "font_size"];
						manifest[1].setupControls = ["theme"];
						return manifest;
					},
				},
			);
			let problems: string[] = [];
			try {
				loadDeck(dir, { isAllowedActionDestination, type: "onboarding" });
			} catch (error) {
				problems = (error as DeckValidationError).problems;
			}
			expect(problems).toEqual(
				expect.arrayContaining([
					expect.stringContaining('slide 1: setup control "font_size"'),
					expect.stringContaining(
						"slide 2: setupControls are only allowed on the setup slide",
					),
				]),
			);
		});

		it("keeps those keys out of a release deck", () => {
			expect(() =>
				loadDeck(onboardingDir, { isAllowedActionDestination }),
			).toThrow(/belong to an onboarding deck/);
		});

		it("creates a first-run onboarding draft, with its setup controls, and publishes it through the service's own validation", async () => {
			const result = await runCreateReleaseCampaign(
				options({
					type: "onboarding",
					version: null,
					name: "AlfyAI 2.2 welcome",
					deck: onboardingDir,
					publish: true,
				}),
				{ db, storageRoot },
			);

			expect(result).toMatchObject({
				status: "published",
				type: "first_run_onboarding",
				releaseVersion: null,
				identityKey: "first_run_onboarding:v1:r1",
				slideCount: 4,
			});
			// Publishing one is not like publishing a release: say who it reaches.
			expect(result.warnings.join("\n")).toMatch(
				/only to an account that has never finished or skipped a welcome/,
			);
			const slides = db
				.select()
				.from(schema.announcementCampaignSlides)
				.all()
				.sort((a, b) => a.sortOrder - b.sortOrder);
			expect(slides.map((slide) => slide.layoutType)).toEqual([
				"setup",
				"standard",
				"standard",
				"standard",
			]);
			expect(JSON.parse(slides[0].setupControlsJson as string)).toEqual([
				"ui_language",
				"theme",
				"model_default",
				"ai_style",
			]);
			expect(slides[3].semanticRole).toBe("data_disclosure");
		});

		it("makes the next revision beside an onboarding that is already published", async () => {
			const first = await runCreateReleaseCampaign(
				options({
					type: "onboarding",
					version: null,
					name: "Welcome 2.0",
					deck: onboardingDir,
					publish: true,
				}),
				{ db, storageRoot },
			);
			const second = await runCreateReleaseCampaign(
				options({
					type: "onboarding",
					version: null,
					name: "Welcome 2.2",
					deck: onboardingDir,
				}),
				{ db, storageRoot },
			);

			expect(first.identityKey).toBe("first_run_onboarding:v1:r1");
			expect(second.identityKey).toBe("first_run_onboarding:v1:r2");
			// The published one is untouched, and the new one is a draft nobody sees yet.
			const states = db
				.select({
					name: schema.announcementCampaigns.name,
					status: schema.announcementCampaigns.status,
				})
				.from(schema.announcementCampaigns)
				.all();
			expect(states).toEqual(
				expect.arrayContaining([
					{ name: "Welcome 2.0", status: "published" },
					{ name: "Welcome 2.2", status: "draft" },
				]),
			);
		});

		it("refuses the same name twice, replaces only a draft, and writes nothing on a dry run", async () => {
			const onboarding = (overrides: Partial<CliOptions> = {}) =>
				options({
					type: "onboarding",
					version: null,
					name: "AlfyAI 2.2 welcome",
					deck: onboardingDir,
					...overrides,
				});
			const dry = await runCreateReleaseCampaign(onboarding({ dryRun: true }), {
				db,
				storageRoot,
			});
			expect(dry).toMatchObject({
				dryRun: true,
				type: "first_run_onboarding",
				releaseVersion: null,
				slideCount: 4,
			});
			expect(db.select().from(schema.announcementCampaigns).all()).toEqual([]);

			const first = await runCreateReleaseCampaign(onboarding(), {
				db,
				storageRoot,
			});
			await expect(
				runCreateReleaseCampaign(onboarding(), { db, storageRoot }),
			).rejects.toThrow(/draft onboarding named.*--replace-draft/s);

			const replaced = await runCreateReleaseCampaign(
				onboarding({ replaceDraft: true }),
				{ db, storageRoot },
			);
			expect(replaced.replacedDraftId).toBe(first.campaignId);

			await publishCampaign(replaced.campaignId as string, "admin-user", {
				db,
			});
			await expect(
				runCreateReleaseCampaign(onboarding({ replaceDraft: true }), {
					db,
					storageRoot,
				}),
			).rejects.toThrow(
				/published onboarding named "AlfyAI 2\.2 welcome" already exists.*another --name/s,
			);
		});

		it("keeps a release and an onboarding with the same name apart", async () => {
			await runCreateReleaseCampaign(
				options({ name: "Same name", deck: deckDir }),
				{ db, storageRoot },
			);
			const result = await runCreateReleaseCampaign(
				options({
					type: "onboarding",
					version: null,
					name: "Same name",
					deck: onboardingDir,
				}),
				{ db, storageRoot },
			);

			expect(result.type).toBe("first_run_onboarding");
			expect(db.select().from(schema.announcementCampaigns).all()).toHaveLength(
				2,
			);
		});
	});

	// -----------------------------------------------------------------------
	// The AlfyAI 2.2 first-run onboarding: the welcome a person who has never used AlfyAI sees
	// -----------------------------------------------------------------------

	describe("the AlfyAI 2.2 first-run onboarding (docs/plans/onboarding-2.2)", () => {
		const welcome = join(process.cwd(), "docs/plans/onboarding-2.2/deck");
		const welcomeEn = join(process.cwd(), "docs/plans/onboarding-2.2/deck-en");
		const release22 = join(process.cwd(), "docs/plans/campaign-2.2/deck");
		const load = (dir = welcome) =>
			loadDeck(dir, { isAllowedActionDestination, type: "onboarding" });

		it("is a valid onboarding deck: ten slides, the setup slide first and the data disclosure last", () => {
			const { slides } = load();

			expect(slides).toHaveLength(10);
			for (const slide of slides) {
				expect(slide.images.desktop).toMatchObject({
					width: 1600,
					height: 1000,
					mimeType: "image/png",
				});
				expect(slide.images.mobile).toMatchObject({
					width: 1080,
					height: 1920,
					mimeType: "image/png",
				});
			}
			expect(slides.map((slide) => slide.layoutType)).toEqual([
				"setup",
				...Array(9).fill("standard"),
			]);
			expect(slides[0].setupControls).toEqual([
				"ui_language",
				"theme",
				"model_default",
				"ai_style",
			]);
			expect(slides.map((slide) => slide.semanticRole)).toEqual([
				...Array(9).fill("feature"),
				"data_disclosure",
			]);
			// One button: the import, on the slide that says "bring what you have".
			expect(slides.map((slide) => slide.actionDestination)).toEqual([
				...Array(8).fill(null),
				"internal:chatgpt-import",
				null,
			]);
			expect(slides[8].actionLabelHu).toBe("Importálás ChatGPT-ből");
			expect(slides[8].actionLabelEn).toBe("Import from ChatGPT");
		});

		it("tells every slide's reader where to find the thing, in both languages, in a body a phone shows whole", () => {
			const { slides } = load();

			slides.forEach((slide, index) => {
				// The last paragraph of a body is its "where to find it" line.
				expect(slide.bodyHu.split("\n\n").at(-1)).toMatch(/^Hol találod: /);
				expect(slide.bodyEn.split("\n\n").at(-1)).toMatch(
					/^Where to find it: /,
				);
				// Measured in the reader's card on a 390x844 phone (scripts/campaign-previews-2-2.ts): past
				// this the card scrolls. The setup slide carries four controls under its words, so it
				// scrolls on a phone whatever they say (and on a laptop-height window); a slide with a button
				// has the button to fit as well.
				const limit = index === 0 ? 270 : slide.actionDestination ? 310 : 380;
				expect(
					slide.bodyHu.length,
					`slide ${index + 1} (HU)`,
				).toBeLessThanOrEqual(limit);
				expect(
					slide.bodyEn.length,
					`slide ${index + 1} (EN)`,
				).toBeLessThanOrEqual(limit);
				// Slides is shelved (ruling 69): no slide may name it.
				for (const text of [
					slide.titleHu,
					slide.titleEn,
					slide.bodyHu,
					slide.bodyEn,
				]) {
					expect(text).not.toMatch(/diasor|slides/i);
				}
			});
		});

		it("quotes the labels the app draws, word for word in both languages", () => {
			const dictionaries = [
				artifactsDict,
				chatDict,
				commonDict,
				knowledgeDict,
				projectsDict,
				settingsDict,
			];
			const label = (key: string, language: "en" | "hu"): string => {
				for (const dictionary of dictionaries) {
					const value = (
						dictionary[language] as Record<string, string | undefined>
					)[key];
					if (value !== undefined) return value;
				}
				throw new Error(`No dictionary has ${key}`);
			};
			const { slides } = load();
			// slide number (1-based) -> the dictionary keys whose labels its body quotes
			const quoted: Array<[number, string[]]> = [
				[
					1,
					[
						"sidebar.settings",
						"settingsProfile",
						"settings_sectionPreferences",
					],
				],
				[2, ["sidebar.search", "sidebar.knowledgeBase"]],
				[
					5,
					[
						"artifacts.document.change.keep",
						"artifacts.document.change.undo",
						"artifacts.history.title",
					],
				],
				[
					6,
					[
						"sidebar.projects",
						"sidebar.settings",
						"settingsProfile",
						"profileTab.assistantTitle",
					],
				],
				[7, ["sidebar.knowledgeBase", "knowledge.documents", "sidebar.search"]],
				[8, ["memory.title"]],
				[
					9,
					[
						"sidebar.settings",
						"settingsConnections",
						"settingsProfile",
						"settings_sectionDataPrivacy",
					],
				],
				[10, ["settingsProfile", "settings_sectionDataPrivacy"]],
			];
			for (const [number, keys] of quoted) {
				const slide = slides[number - 1];
				for (const key of keys) {
					expect(slide.bodyHu, `slide ${number}, ${key}`).toContain(
						label(key, "hu"),
					);
					expect(slide.bodyEn, `slide ${number}, ${key}`).toContain(
						label(key, "en"),
					);
				}
			}
			// The button is the Settings page's own import button.
			expect(slides[8].actionLabelHu).toBe(
				label("chatgptImport.settingsButton", "hu"),
			);
			expect(slides[8].actionLabelEn).toBe(
				label("chatgptImport.settingsButton", "en"),
			);
		});

		it("does not repeat the 2.2 release card, which the same person sees on a later load", () => {
			const words = (text: string) =>
				text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
			/** The longest run of words two texts share. */
			const longestSharedRun = (a: string[], b: string[]) => {
				let best = 0;
				let previous = new Array<number>(b.length + 1).fill(0);
				for (let i = 1; i <= a.length; i += 1) {
					const row = new Array<number>(b.length + 1).fill(0);
					for (let j = 1; j <= b.length; j += 1) {
						if (a[i - 1] === b[j - 1]) {
							row[j] = previous[j - 1] + 1;
							best = Math.max(best, row[j]);
						}
					}
					previous = row;
				}
				return best;
			};
			// The first paragraph is the words; the last is the "where" line, which names the same labels.
			const first = (body: string) => body.split("\n\n")[0];
			const mine = load().slides;
			const theirs = loadDeck(release22, { isAllowedActionDestination }).slides;
			for (const [index, slide] of mine.entries()) {
				for (const [other, card] of theirs.entries()) {
					for (const language of ["Hu", "En"] as const) {
						const run = longestSharedRun(
							words(first(slide[`body${language}`])),
							words(first(card[`body${language}`])),
						);
						expect(
							run,
							`welcome slide ${index + 1} and release slide ${other + 1} (${language})`,
						).toBeLessThan(5);
					}
				}
			}
		});

		it("has an English-interface alternate with the very same words", () => {
			const alternate = load(welcomeEn);
			const main = load();

			expect(
				alternate.slides.map(({ images: _images, ...copy }) => copy),
			).toEqual(main.slides.map(({ images: _images, ...copy }) => copy));
		});

		it("creates and publishes through the service's own validation, as the next first-run onboarding", async () => {
			const result = await runCreateReleaseCampaign(
				options({
					type: "onboarding",
					version: null,
					name: "AlfyAI 2.2 üdvözlő",
					deck: welcome,
					publish: true,
				}),
				{ db, storageRoot },
			);

			expect(result).toMatchObject({
				status: "published",
				type: "first_run_onboarding",
				releaseVersion: null,
				identityKey: "first_run_onboarding:v1:r1",
				slideCount: 10,
			});
		});

		it("is not shown again to an account that finished the last onboarding: the release card is what it gets", async () => {
			const publish = async (name: string) => {
				const created = await runCreateReleaseCampaign(
					options({
						type: "onboarding",
						version: null,
						name,
						deck: welcome,
					}),
					{ db, storageRoot },
				);
				await publishCampaign(created.campaignId as string, "admin-user", {
					db,
				});
				return created;
			};

			const old = await publish("Welcome 2.0");
			await completeCampaignForUser(
				old.campaignId as string,
				"viewer-user",
				"completed",
				{ db },
			);
			expect(
				await getEligibleCampaignForUser("viewer-user", { db }),
			).toBeNull();

			// 2.2 is published: a release card waits for an account that was here.
			const release = await runCreateReleaseCampaign(
				options({ name: "AlfyAI 2.2", version: "2.2.0", deck: deckDir }),
				{ db, storageRoot },
			);
			await publishCampaign(release.campaignId as string, "admin-user", { db });
			expect(
				(await getEligibleCampaignForUser("viewer-user", { db }))?.type,
			).toBe("release_update");

			// The next welcome revision is a new snapshot, and still not for this
			// account: it has been through a welcome, so the release stays next.
			const next = await publish("AlfyAI 2.2 üdvözlő");
			expect(next.identityKey).toBe("first_run_onboarding:v1:r2");
			const shown = await getEligibleCampaignForUser("viewer-user", { db });
			expect(shown).toMatchObject({ type: "release_update" });
			expect(shown?.id).toBe(release.campaignId);

			// An account that has not been through one is shown the new revision.
			db.insert(schema.users)
				.values({
					id: "newcomer-user",
					email: "newcomer@example.com",
					passwordHash: "hash",
					role: "user",
				})
				.run();
			expect(
				await getEligibleCampaignForUser("newcomer-user", { db }),
			).toMatchObject({
				type: "first_run_onboarding",
				identityKey: "first_run_onboarding:v1:r2",
			});
			expect(
				(await getEligibleCampaignForUser("newcomer-user", { db }))?.id,
			).toBe(next.campaignId);

			// Finishing the release is the end of it for the viewer.
			await completeCampaignForUser(
				release.campaignId as string,
				"viewer-user",
				"completed",
				{ db },
			);
			expect(
				await getEligibleCampaignForUser("viewer-user", { db }),
			).toBeNull();
		});
	});

	describe("the AlfyAI 2.2 deck (docs/plans/campaign-2.2)", () => {
		// Vitest runs from the repository root.
		const deck22 = join(process.cwd(), "docs/plans/campaign-2.2/deck");
		const deck22En = join(process.cwd(), "docs/plans/campaign-2.2/deck-en");

		it("is a valid deck: ten slides, both languages and both devices, on the allowlist", () => {
			const loaded = loadDeck(deck22, { isAllowedActionDestination });

			expect(loaded.slides).toHaveLength(10);
			for (const slide of loaded.slides) {
				expect(slide.images.desktop).toMatchObject({
					width: 1600,
					height: 1000,
					mimeType: "image/png",
				});
				expect(slide.images.mobile).toMatchObject({
					width: 1080,
					height: 1920,
					mimeType: "image/png",
				});
			}
			// The two buttons: Open settings (Instructions, slide 7) and Open Knowledge base (slide 8).
			expect(loaded.slides.map((slide) => slide.actionDestination)).toEqual([
				null,
				null,
				null,
				null,
				null,
				null,
				"/settings",
				"/knowledge",
				null,
				null,
			]);
		});

		it("tells every slide's reader where to find the thing, in both languages, in a body a phone shows whole", () => {
			const { slides } = loadDeck(deck22, { isAllowedActionDestination });

			for (const slide of slides) {
				// The last paragraph of a body is its "where to find it" line.
				expect(slide.bodyHu.split("\n\n").at(-1)).toMatch(/^Hol találod: /);
				expect(slide.bodyEn.split("\n\n").at(-1)).toMatch(
					/^Where to find it: /,
				);
				// Measured in the reader's card on a 390x844 phone: past this the card scrolls.
				expect(slide.bodyHu.length).toBeLessThanOrEqual(360);
				expect(slide.bodyEn.length).toBeLessThanOrEqual(360);
				// Slides is shelved (ruling 69): no slide may name it.
				for (const text of [
					slide.titleHu,
					slide.titleEn,
					slide.bodyHu,
					slide.bodyEn,
				]) {
					expect(text).not.toMatch(/diasor|slides/i);
				}
			}
		});

		it("quotes the labels the app draws, word for word in both languages", () => {
			const dictionaries = [
				artifactsDict,
				chatDict,
				commonDict,
				knowledgeDict,
				projectsDict,
				settingsDict,
			];
			const label = (key: string, language: "en" | "hu"): string => {
				for (const dictionary of dictionaries) {
					const value = (
						dictionary[language] as Record<string, string | undefined>
					)[key];
					if (value !== undefined) return value;
				}
				throw new Error(`No dictionary has ${key}`);
			};
			const { slides } = loadDeck(deck22, { isAllowedActionDestination });
			const wording = (index: number) => ({
				hu: slides[index].bodyHu,
				en: slides[index].bodyEn,
			});
			// slide number (1-based) -> the dictionary keys whose labels its body quotes
			const quoted: Array<[number, string[]]> = [
				[1, ["chat.artifacts.keepAsDocument"]],
				[2, ["artifacts.app.action.regenerate"]],
				[3, ["artifacts.canvas.insert", "artifacts.canvas.ask"]],
				[
					4,
					[
						"artifacts.document.change.keep",
						"artifacts.document.change.undo",
						"artifacts.document.comment.add",
						"artifacts.document.comment.ask",
					],
				],
				[6, ["projects.filesTitle", "home.projectsHeading"]],
				[
					7,
					["sidebar.settings", "settingsProfile", "profileTab.assistantTitle"],
				],
				[8, ["sidebar.knowledgeBase", "knowledge.documents"]],
			];
			for (const [number, keys] of quoted) {
				const { hu, en } = wording(number - 1);
				for (const key of keys) {
					// A label that ends in an ellipsis is quoted whole; the dictionary's own words, not a paraphrase.
					expect(hu, `slide ${number}, ${key}`).toContain(label(key, "hu"));
					expect(en, `slide ${number}, ${key}`).toContain(label(key, "en"));
				}
			}
		});

		it("has an English-interface alternate with the very same words", () => {
			const alternate = loadDeck(deck22En, { isAllowedActionDestination });
			const main = loadDeck(deck22, { isAllowedActionDestination });

			expect(
				alternate.slides.map(({ images: _images, ...copy }) => copy),
			).toEqual(main.slides.map(({ images: _images, ...copy }) => copy));
		});

		it("creates and publishes through the service's own validation, as release 2.2.0", async () => {
			const result = await runCreateReleaseCampaign(
				options({
					deck: deck22,
					name: "AlfyAI 2.2",
					version: "2.2.0",
					publish: true,
				}),
				{ db, storageRoot },
			);

			expect(result.status).toBe("published");
			expect(result.releaseVersion).toBe("2.2.0");
			expect(result.identityKey).toBe("release_update:2.2.0:r1");
			expect(result.slideCount).toBe(10);
		});
	});

	it("warns after publishing when an APP_VERSION_OVERRIDE would hide the new version", async () => {
		db.insert(schema.adminConfig)
			.values({
				key: "APP_VERSION_OVERRIDE",
				value: "9.9.9",
				updatedBy: "admin-user",
			})
			.run();

		const result = await runCreateReleaseCampaign(
			options({ deck: deckDir, publish: true }),
			{ db, storageRoot },
		);
		expect(result.warnings.join("\n")).toMatch(
			/APP_VERSION_OVERRIDE="9\.9\.9"/,
		);
	});

	it("refuses a second campaign with the same name and version", async () => {
		await runCreateReleaseCampaign(options({ deck: deckDir }), {
			db,
			storageRoot,
		});
		await expect(
			runCreateReleaseCampaign(options({ deck: deckDir }), { db, storageRoot }),
		).rejects.toThrow(/already exists.*--replace-draft/s);

		expect(db.select().from(schema.announcementCampaigns).all()).toHaveLength(
			1,
		);
	});

	it("replaces an existing draft only when asked, and leaves nothing behind", async () => {
		const first = await runCreateReleaseCampaign(options({ deck: deckDir }), {
			db,
			storageRoot,
		});
		const second = await runCreateReleaseCampaign(
			options({ deck: deckDir, replaceDraft: true }),
			{ db, storageRoot },
		);

		expect(second.replacedDraftId).toBe(first.campaignId);
		expect(second.campaignId).not.toBe(first.campaignId);
		const campaigns = db.select().from(schema.announcementCampaigns).all();
		expect(campaigns).toHaveLength(1);
		expect(campaigns[0].id).toBe(second.campaignId);
		expect(
			db.select().from(schema.announcementCampaignSlides).all(),
		).toHaveLength(4);
	});

	it("never replaces a published campaign, even with --replace-draft", async () => {
		const created = await runCreateReleaseCampaign(options({ deck: deckDir }), {
			db,
			storageRoot,
		});
		await publishCampaign(created.campaignId as string, "admin-user", { db });

		await expect(
			runCreateReleaseCampaign(options({ deck: deckDir, replaceDraft: true }), {
				db,
				storageRoot,
			}),
		).rejects.toThrow(
			/A published campaign named "AlfyAI 2\.0" already exists/,
		);

		const campaigns = db.select().from(schema.announcementCampaigns).all();
		expect(campaigns).toHaveLength(1);
		expect(campaigns[0].id).toBe(created.campaignId);
		expect(campaigns[0].status).toBe("published");
	});

	it("refuses an email that is not an admin, and one that is no user at all", async () => {
		await expect(
			runCreateReleaseCampaign(
				options({ deck: deckDir, adminEmail: "viewer@example.com" }),
				{ db, storageRoot },
			),
		).rejects.toThrow(/has role "user", not "admin"/);

		await expect(
			runCreateReleaseCampaign(
				options({ deck: deckDir, adminEmail: "nobody@example.com" }),
				{ db, storageRoot },
			),
		).rejects.toThrow(CampaignRunError);

		expect(db.select().from(schema.announcementCampaigns).all()).toEqual([]);
		expect(db.select().from(schema.campaignAssets).all()).toEqual([]);
	});

	it("matches an admin email that differs only in case", async () => {
		const result = await runCreateReleaseCampaign(
			options({ deck: deckDir, adminEmail: "Admin@Example.COM" }),
			{ db, storageRoot },
		);
		expect(result.adminUserId).toBe("admin-user");
	});

	it("writes nothing on a dry run", async () => {
		const result = await runCreateReleaseCampaign(
			options({ deck: deckDir, dryRun: true, publish: true }),
			{ db, storageRoot },
		);

		expect(result).toMatchObject({
			dryRun: true,
			campaignId: null,
			slideCount: 4,
			assetCount: 8,
		});
		expect(db.select().from(schema.announcementCampaigns).all()).toEqual([]);
		expect(db.select().from(schema.campaignAssets).all()).toEqual([]);
		expect(() => readdirSync(storageRoot)).toThrow();
	});

	it("reports on a dry run that an existing draft would be replaced, without deleting it", async () => {
		const first = await runCreateReleaseCampaign(options({ deck: deckDir }), {
			db,
			storageRoot,
		});
		const result = await runCreateReleaseCampaign(
			options({ deck: deckDir, dryRun: true, replaceDraft: true }),
			{ db, storageRoot },
		);

		expect(result.replacedDraftId).toBe(first.campaignId);
		expect(db.select().from(schema.announcementCampaigns).all()).toHaveLength(
			1,
		);
	});

	it("validates the deck before touching the database, even without --dry-run", async () => {
		const dir = writeDeck(mkdtempSync(join(tmpdir(), "invalid-deck-")), {
			slides: (manifest) => {
				manifest[0].bodyHu = "";
				return manifest;
			},
		});
		await expect(
			runCreateReleaseCampaign(options({ deck: dir }), { db, storageRoot }),
		).rejects.toThrow(DeckValidationError);
		expect(db.select().from(schema.announcementCampaigns).all()).toEqual([]);
	});
});
