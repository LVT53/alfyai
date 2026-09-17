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
import { createInMemoryDatabase } from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { publishCampaign } from "$lib/server/services/announcement-campaigns";
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

function options(overrides: Partial<CliOptions> = {}): CliOptions {
	return {
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
