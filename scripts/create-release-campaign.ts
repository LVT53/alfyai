#!/usr/bin/env tsx

/**
 * Create an in-app announcement campaign (a release update, or the first-run
 * onboarding) from a prepared deck directory, through the app's own service
 * layer rather than the admin UI.
 *
 * Usage:
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/create-release-campaign.ts \
 *     --deck ./alfyai-release-campaign-2 \
 *     --name "AlfyAI 2.0" --version 2.0.0 --admin-email admin@example.com \
 *     [--png-dir <dir>] [--publish] [--dry-run] [--replace-draft]
 *
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/create-release-campaign.ts \
 *     --type onboarding --deck ./alfyai-onboarding \
 *     --name "AlfyAI 2.2 welcome" --admin-email admin@example.com
 *
 * A first-run onboarding has no release version (the system names it
 * `first_run_onboarding:v1:r<n>`), so `--version` is refused with
 * `--type onboarding`. Its deck marks one slide `"layoutType": "setup"` (with
 * `setupControls`) and at least one `"semanticRole": "data_disclosure"`, the two
 * things the service's publish validation asks of a first-run onboarding.
 *
 * WHY A SCRIPT AND NOT RAW SQL
 * ----------------------------
 * Everything below goes through `announcement-campaigns.ts` and
 * `campaign-assets.ts` — the same functions `/api/admin/campaigns*` calls. So
 * the draft this writes is byte-for-byte the shape the admin UI would have
 * written: the same identity key and revision arithmetic, the same crop-asset
 * rows with their `crop_metadata_json`, the same files under
 * `data/campaign-assets/`, and on `--publish` the same publish validation that
 * the Publish button runs. Nothing here knows the table names.
 *
 * ON SVG
 * ------
 * `campaign-assets.ts` accepts `image/svg+xml` (ALLOWED_IMAGE_TYPES), and
 * `/api/campaign-assets/[id]/content` serves it with a CSP that allows
 * `img-src data:` precisely so an SVG carrying embedded base64 screenshots
 * renders. Nothing in the pipeline re-encodes or crops server-side — the crop
 * is client-side geometry plus the bytes you hand it — so the deck's SVGs go in
 * untouched and stay sharp at every density. `--png-dir` uploads pre-rendered
 * PNGs of the same slides instead, for a deployment that would rather ship
 * raster. No rasterizer is added to the repo either way.
 *
 * ON WHERE THINGS LAND
 * --------------------
 * The database comes from `DATABASE_PATH` exactly as the server resolves it
 * (`getDatabasePath()`); the asset files land under `<cwd>/data/campaign-assets`
 * exactly as the server writes them (`campaignAssetsRoot()`). Both are relative
 * to the process working directory, so this must run from the release
 * directory, where `data` is the symlink to `shared/data`. The script checks
 * that the two agree and refuses rather than scattering assets the server will
 * never find.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { config as dotenvConfig } from "dotenv";

// Loaded before anything opens the database. Every module that reads
// DATABASE_PATH is imported dynamically below, after this runs, because ESM
// evaluates static imports before the first statement of this file.
dotenvConfig();
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

// ---------------------------------------------------------------------------
// Target geometry
// ---------------------------------------------------------------------------

/** 16:10, the ratio `campaign-assets.ts` enforces for a desktop crop. */
export const DESKTOP_TARGET = { width: 1600, height: 1000 } as const;
/** 9:16, the ratio `campaign-assets.ts` enforces for a mobile crop. */
export const MOBILE_TARGET = { width: 1080, height: 1920 } as const;

const VARIANTS = ["desktop", "mobile"] as const;
export type Variant = (typeof VARIANTS)[number];

function targetFor(variant: Variant) {
	return variant === "desktop" ? DESKTOP_TARGET : MOBILE_TARGET;
}

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

/** What the script makes: a release update (the default) or the first-run onboarding. */
export type CampaignKind = "release" | "onboarding";

export type CliOptions = {
	type: CampaignKind;
	deck: string;
	name: string;
	/** The release version; `null` for an onboarding, which has none. */
	version: string | null;
	adminEmail: string;
	pngDir: string | null;
	publish: boolean;
	dryRun: boolean;
	replaceDraft: boolean;
};

export class CliUsageError extends Error {}

const FLAGS_WITH_VALUES = new Set([
	"--type",
	"--deck",
	"--name",
	"--version",
	"--admin-email",
	"--png-dir",
]);
const BOOLEAN_FLAGS = new Set(["--publish", "--dry-run", "--replace-draft"]);

export const USAGE = `Usage:
  DATABASE_PATH=<path> npx tsx scripts/create-release-campaign.ts \\
    --deck <dir> --name "AlfyAI 2.0" --version 2.0.0 --admin-email <email> \\
    [--png-dir <dir>] [--publish] [--dry-run] [--replace-draft]
  DATABASE_PATH=<path> npx tsx scripts/create-release-campaign.ts \\
    --type onboarding --deck <dir> --name "AlfyAI 2.2 welcome" --admin-email <email> \\
    [--png-dir <dir>] [--publish] [--dry-run] [--replace-draft]

  --type <kind>         release (default) or onboarding (the first-run welcome).
  --deck <dir>          Deck directory holding slides.json and slides/*.svg.
  --name <string>       Internal campaign name shown in the admin list.
  --version <string>    Release version the campaign is linked to (e.g. 2.0.0).
                        Required for a release; refused for an onboarding.
  --admin-email <email> Existing user with role=admin; becomes the author.
  --png-dir <dir>       Upload pre-rendered PNGs from here instead of the SVGs.
  --publish             Also publish, running the real publish validation.
  --dry-run             Validate and print the plan; write nothing.
  --replace-draft       Replace an existing DRAFT of the same name+version.
                        Never touches a published or archived campaign.`;

export function parseArgs(argv: string[]): CliOptions {
	const values = new Map<string, string>();
	const flags = new Set<string>();

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		// Accept both `--flag value` and `--flag=value`; an operator will type
		// whichever they are used to and neither should be a silent no-op.
		const equals = token.indexOf("=");
		const name = equals === -1 ? token : token.slice(0, equals);

		if (BOOLEAN_FLAGS.has(name)) {
			if (equals !== -1) {
				throw new CliUsageError(`${name} does not take a value.`);
			}
			flags.add(name);
			continue;
		}
		if (!FLAGS_WITH_VALUES.has(name)) {
			throw new CliUsageError(`Unknown option: ${token}`);
		}
		const value = equals === -1 ? argv[++index] : token.slice(equals + 1);
		if (value === undefined || value.startsWith("--")) {
			throw new CliUsageError(`${name} requires a value.`);
		}
		values.set(name, value);
	}

	const required = (flag: string): string => {
		const value = values.get(flag)?.trim();
		if (!value) throw new CliUsageError(`${flag} is required.`);
		return value;
	};

	const kind = values.get("--type")?.trim() || "release";
	if (kind !== "release" && kind !== "onboarding") {
		throw new CliUsageError(
			`--type must be release or onboarding, not "${kind}".`,
		);
	}
	// A first-run onboarding's version is the system's (`v1`, then a revision), so a
	// --version given with it would be a value that silently did nothing.
	if (kind === "onboarding" && values.has("--version")) {
		throw new CliUsageError(
			"--version does not apply to --type onboarding: the system names it first_run_onboarding:v1:r<n>.",
		);
	}

	return {
		type: kind,
		deck: required("--deck"),
		name: required("--name"),
		version: kind === "release" ? required("--version") : null,
		adminEmail: required("--admin-email"),
		pngDir: values.get("--png-dir")?.trim() || null,
		publish: flags.has("--publish"),
		dryRun: flags.has("--dry-run"),
		replaceDraft: flags.has("--replace-draft"),
	};
}

// ---------------------------------------------------------------------------
// Image dimensions, without a decoder dependency
// ---------------------------------------------------------------------------

export type ImageInfo = {
	path: string;
	mimeType: "image/svg+xml" | "image/png";
	width: number;
	height: number;
	bytes: Buffer;
};

function readSvgDimensions(source: string): { width: number; height: number } {
	const root = source.match(/<svg\b[^>]*>/i)?.[0];
	if (!root) throw new Error("No <svg> root element.");

	// Prefer the explicit width/height the deck sets; fall back to the viewBox,
	// which is what a renderer falls back to as well.
	const attribute = (name: string) =>
		root.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
	const numeric = (raw: string | undefined) => {
		if (!raw) return Number.NaN;
		// "1600", "1600px" — a percentage or an em is not a pixel size we can use.
		const match = raw.trim().match(/^([0-9]*\.?[0-9]+)(px)?$/i);
		return match ? Number(match[1]) : Number.NaN;
	};

	let width = numeric(attribute("width"));
	let height = numeric(attribute("height"));
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		const viewBox = attribute("viewBox")
			?.trim()
			.split(/[\s,]+/);
		if (viewBox?.length === 4) {
			width = Number(viewBox[2]);
			height = Number(viewBox[3]);
		}
	}
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		throw new Error("Could not read width/height from the <svg> root.");
	}
	return { width, height };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngDimensions(bytes: Buffer): { width: number; height: number } {
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error("Not a PNG file (bad signature).");
	}
	if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
		throw new Error("Not a PNG file (no IHDR chunk).");
	}
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function readImageInfo(path: string): ImageInfo {
	const bytes = readFileSync(path);
	if (path.toLowerCase().endsWith(".svg")) {
		const { width, height } = readSvgDimensions(bytes.toString("utf8"));
		return { path, mimeType: "image/svg+xml", width, height, bytes };
	}
	if (path.toLowerCase().endsWith(".png")) {
		const { width, height } = readPngDimensions(bytes);
		return { path, mimeType: "image/png", width, height, bytes };
	}
	throw new Error(`Unsupported image type (expected .svg or .png): ${path}`);
}

// ---------------------------------------------------------------------------
// Deck loading and validation
// ---------------------------------------------------------------------------

export const MIN_SLIDES = 4;

/**
 * The preferences an onboarding's setup slide may offer: the service's own list
 * (`SETUP_CONTROLS` in `announcement-campaigns.ts`), checked here so a typo is a
 * deck problem and not a publish failure. The test publishes an onboarding
 * deck, so a control the service stops accepting fails there.
 */
const ONBOARDING_SETUP_CONTROLS = [
	"ui_language",
	"theme",
	"model_default",
	"ai_style",
] as const;

export type DeckSlide = {
	index: number;
	titleEn: string;
	titleHu: string;
	bodyEn: string;
	bodyHu: string;
	altTextEn: string;
	altTextHu: string;
	actionLabelEn: string | null;
	actionLabelHu: string | null;
	actionDestination: string | null;
	/** `setup` is the one slide of a first-run onboarding that offers preference controls. */
	layoutType: "standard" | "setup";
	/** `data_disclosure` marks the standard slide a first-run onboarding must carry. */
	semanticRole: "feature" | "data_disclosure";
	setupControls: string[];
	images: Record<Variant, ImageInfo>;
};

export type Deck = {
	dir: string;
	slides: DeckSlide[];
};

export class DeckValidationError extends Error {
	constructor(
		message: string,
		public readonly problems: string[],
	) {
		super(`${message}\n  - ${problems.join("\n  - ")}`);
		this.name = "DeckValidationError";
	}
}

function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve a deck-relative file reference, refusing to escape the deck.
 * slides.json is operator-supplied data, not code, so `../../etc/passwd` is a
 * path it may contain and must not be a path this reads.
 */
function resolveInsideDeck(deckDir: string, reference: string): string | null {
	if (isAbsolute(reference)) return null;
	const resolved = resolve(deckDir, reference);
	const rel = relative(deckDir, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return resolved;
}

/**
 * The PNG that stands in for a slide's SVG when `--png-dir` is used. The
 * proof renders in the deck's `.work/png/` share the SVGs' basenames, so the
 * mapping is basename + `.png` and a missing file is reported per slide rather
 * than silently falling back to the vector.
 */
export function pngCounterpart(pngDir: string, svgReference: string): string {
	return join(pngDir, `${basename(svgReference).replace(/\.svg$/i, "")}.png`);
}

export function loadDeck(
	deckDir: string,
	options: {
		pngDir?: string | null;
		isAllowedActionDestination: (value: string | null) => boolean;
		/** What the deck becomes; decides the slide keys it may carry. A release unless said otherwise. */
		type?: CampaignKind;
	},
): Deck {
	const kind = options.type ?? "release";
	const dir = resolve(deckDir);
	const problems: string[] = [];

	const manifestPath = join(dir, "slides.json");
	if (!existsSync(manifestPath)) {
		throw new DeckValidationError("Deck is not usable.", [
			`No slides.json at ${manifestPath}`,
		]);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new DeckValidationError("Deck is not usable.", [
			`slides.json is not valid JSON: ${(error as Error).message}`,
		]);
	}
	if (!Array.isArray(parsed)) {
		throw new DeckValidationError("Deck is not usable.", [
			"slides.json must be an array of slide objects.",
		]);
	}
	if (parsed.length < MIN_SLIDES) {
		problems.push(
			`slides.json has ${parsed.length} slide(s); at least ${MIN_SLIDES} are required.`,
		);
	}

	const slides: DeckSlide[] = [];
	parsed.forEach((raw, position) => {
		const label = `slide ${position + 1}`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			problems.push(`${label}: not an object.`);
			return;
		}
		const record = raw as Record<string, unknown>;

		const titleEn = readString(record, "titleEn");
		const titleHu = readString(record, "titleHu");
		const bodyEn = readString(record, "bodyEn");
		const bodyHu = readString(record, "bodyHu");
		const altTextEn = readString(record, "altTextEn");
		const altTextHu = readString(record, "altTextHu");
		for (const [field, value] of [
			["titleEn", titleEn],
			["titleHu", titleHu],
			["bodyEn", bodyEn],
			["bodyHu", bodyHu],
			// Alt text is required because every slide here ships images, and the
			// publish validation requires localized alt text whenever a slide has
			// a crop attached. Catching it now beats catching it at --publish.
			["altTextEn", altTextEn],
			["altTextHu", altTextHu],
		] as const) {
			if (!value) problems.push(`${label}: ${field} is empty or missing.`);
		}

		// What kind of slide it is. A release deck is all standard feature slides; an
		// onboarding deck says which slide is the setup slide and which is the data
		// disclosure, the two things the publish validation asks of a first-run onboarding.
		const layoutType = readString(record, "layoutType") || "standard";
		const semanticRole = readString(record, "semanticRole") || "feature";
		const rawControls = record.setupControls;
		const setupControls: string[] = [];
		if (layoutType !== "standard" && layoutType !== "setup") {
			problems.push(
				`${label}: layoutType "${layoutType}" must be standard or setup.`,
			);
		}
		if (semanticRole !== "feature" && semanticRole !== "data_disclosure") {
			problems.push(
				`${label}: semanticRole "${semanticRole}" must be feature or data_disclosure.`,
			);
		}
		if (rawControls !== undefined) {
			if (
				!Array.isArray(rawControls) ||
				rawControls.some((control) => typeof control !== "string")
			) {
				problems.push(`${label}: setupControls must be an array of strings.`);
			} else {
				setupControls.push(...(rawControls as string[]));
			}
		}
		if (kind === "release") {
			if (
				layoutType !== "standard" ||
				semanticRole !== "feature" ||
				rawControls !== undefined
			) {
				problems.push(
					`${label}: layoutType, semanticRole and setupControls belong to an onboarding deck (--type onboarding).`,
				);
			}
		} else {
			if (layoutType === "setup") {
				if (setupControls.length === 0) {
					problems.push(
						`${label}: a setup slide needs setupControls (${ONBOARDING_SETUP_CONTROLS.join(", ")}).`,
					);
				}
				if (semanticRole === "data_disclosure") {
					problems.push(
						`${label}: the setup slide cannot also be the data disclosure.`,
					);
				}
			} else if (setupControls.length > 0) {
				problems.push(
					`${label}: setupControls are only allowed on the setup slide.`,
				);
			}
			for (const control of setupControls) {
				if (
					!(ONBOARDING_SETUP_CONTROLS as readonly string[]).includes(control)
				) {
					problems.push(
						`${label}: setup control "${control}" is not one of ${ONBOARDING_SETUP_CONTROLS.join(", ")}.`,
					);
				}
			}
		}

		const actionLabelEn = readString(record, "actionLabelEn") || null;
		const actionLabelHu = readString(record, "actionLabelHu") || null;
		const actionDestination = readString(record, "actionDestination") || null;
		if (actionDestination || actionLabelEn || actionLabelHu) {
			if (!actionDestination) {
				problems.push(
					`${label}: actionDestination is required with an action label.`,
				);
			} else if (!options.isAllowedActionDestination(actionDestination)) {
				problems.push(
					`${label}: actionDestination "${actionDestination}" is not on the allowlist.`,
				);
			}
			if (!actionLabelEn || !actionLabelHu) {
				problems.push(
					`${label}: actionLabelEn and actionLabelHu are both required when an action is set.`,
				);
			}
		}

		const images = {} as Record<Variant, ImageInfo>;
		for (const variant of VARIANTS) {
			const field = variant === "desktop" ? "desktopFile" : "mobileFile";
			const reference = readString(record, field);
			if (!reference) {
				problems.push(`${label}: ${field} is empty or missing.`);
				continue;
			}
			const svgPath = resolveInsideDeck(dir, reference);
			if (!svgPath) {
				problems.push(
					`${label}: ${field} "${reference}" escapes the deck directory.`,
				);
				continue;
			}
			const path = options.pngDir
				? pngCounterpart(resolve(options.pngDir), reference)
				: svgPath;
			if (!existsSync(path)) {
				problems.push(`${label}: ${field} not found at ${path}`);
				continue;
			}

			let info: ImageInfo;
			try {
				info = readImageInfo(path);
			} catch (error) {
				problems.push(`${label}: ${field} — ${(error as Error).message}`);
				continue;
			}

			const target = targetFor(variant);
			const expectedRatio = target.width / target.height;
			const actualRatio = info.width / info.height;
			if (Math.abs(actualRatio - expectedRatio) > 0.001) {
				problems.push(
					`${label}: ${field} is ${info.width}x${info.height}; the ${variant} crop must use the ` +
						`${variant === "desktop" ? "16:10" : "9:16"} ratio (e.g. ${target.width}x${target.height}).`,
				);
				continue;
			}
			if (info.width < target.width || info.height < target.height) {
				problems.push(
					`${label}: ${field} is ${info.width}x${info.height}, smaller than the ` +
						`${target.width}x${target.height} target.`,
				);
				continue;
			}
			images[variant] = info;
		}

		if (images.desktop && images.mobile) {
			slides.push({
				index: position + 1,
				titleEn,
				titleHu,
				bodyEn,
				bodyHu,
				altTextEn,
				altTextHu,
				actionLabelEn,
				actionLabelHu,
				actionDestination,
				layoutType: layoutType === "setup" ? "setup" : "standard",
				semanticRole:
					semanticRole === "data_disclosure" ? "data_disclosure" : "feature",
				setupControls,
				images,
			});
		}
	});

	if (kind === "onboarding" && Array.isArray(parsed)) {
		// The service wants exactly one setup slide and at least one data disclosure.
		const records = parsed.filter(
			(raw): raw is Record<string, unknown> =>
				Boolean(raw) && typeof raw === "object" && !Array.isArray(raw),
		);
		const setupSlides = records.filter(
			(record) => readString(record, "layoutType") === "setup",
		).length;
		const disclosures = records.filter(
			(record) => readString(record, "semanticRole") === "data_disclosure",
		).length;
		if (setupSlides !== 1) {
			problems.push(
				`an onboarding deck needs exactly one setup slide ("layoutType": "setup"); it has ${setupSlides}.`,
			);
		}
		if (disclosures < 1) {
			problems.push(
				`an onboarding deck needs a data disclosure slide ("semanticRole": "data_disclosure").`,
			);
		}
	}

	if (problems.length > 0) {
		throw new DeckValidationError(`Deck at ${dir} is not usable.`, problems);
	}
	return { dir, slides };
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

export type CampaignRunContext = {
	/** A drizzle instance; the CLI passes the app's own singleton. */
	// biome-ignore lint/suspicious/noExplicitAny: the drizzle instance type lives behind the dynamic import.
	db: any;
	/** Where crop/source files are written. The CLI passes `<cwd>/data/campaign-assets`. */
	storageRoot: string;
};

export type CampaignRunResult = {
	dryRun: boolean;
	campaignId: string | null;
	status: string;
	name: string;
	/** The service's campaign type: `release_update` or `first_run_onboarding`. */
	type: "release_update" | "first_run_onboarding";
	/** `null` for an onboarding, which has no release version. */
	releaseVersion: string | null;
	identityKey: string | null;
	revision: number | null;
	slideCount: number;
	assetCount: number;
	replacedDraftId: string | null;
	adminUserId: string;
	adminUrl: string;
	storageRoot: string;
	warnings: string[];
};

export class CampaignRunError extends Error {}

/**
 * Where to go to review it. The Administration tab's sub-pane is local state
 * (`SettingsAdministrationTab.svelte` never reads the URL), so there is no
 * query parameter for the Campaigns pane and no per-campaign deep link —
 * printing an invented one would send the operator somewhere that ignores it.
 */
export const ADMIN_CAMPAIGNS_PATH = "/settings";
export const ADMIN_CAMPAIGNS_HINT =
	"open the Administration tab, then the Campaigns sub-tab";

async function resolveAdminUser(
	// biome-ignore lint/suspicious/noExplicitAny: see CampaignRunContext.db.
	db: any,
	email: string,
): Promise<{ id: string; email: string }> {
	const { eq, sql } = await import("drizzle-orm");
	const schema = await import("$lib/server/db/schema");

	const normalized = email.trim();
	const row =
		db
			.select({
				id: schema.users.id,
				email: schema.users.email,
				role: schema.users.role,
			})
			.from(schema.users)
			.where(eq(schema.users.email, normalized))
			.get() ??
		// Emails are stored as typed; an operator typing the address back in a
		// different case should get the user, not a confusing "no such user".
		db
			.select({
				id: schema.users.id,
				email: schema.users.email,
				role: schema.users.role,
			})
			.from(schema.users)
			.where(sql`lower(${schema.users.email}) = lower(${normalized})`)
			.get();

	if (!row) {
		throw new CampaignRunError(
			`No user with email ${normalized}. The campaign author must be an existing admin account.`,
		);
	}
	if (row.role !== "admin") {
		throw new CampaignRunError(
			`User ${row.email} has role "${row.role}", not "admin". Only an admin can author a campaign.`,
		);
	}
	return { id: row.id, email: row.email };
}

/**
 * Same type + same name (+ same release version, for a release) = the same
 * campaign, whatever revision the service would hand it. `createCampaignDraft`
 * happily makes revision 2, which is exactly the duplicate an operator
 * re-running this by mistake does not want. A draft is preferred when several
 * rows match, so that "a draft exists" is what `--replace-draft` answers.
 */
async function findExistingCampaign(
	// biome-ignore lint/suspicious/noExplicitAny: see CampaignRunContext.db.
	db: any,
	campaignType: "release_update" | "first_run_onboarding",
	name: string,
	releaseVersion: string | null,
) {
	const { and, eq, isNull } = await import("drizzle-orm");
	const schema = await import("$lib/server/db/schema");
	const rows = db
		.select({
			id: schema.announcementCampaigns.id,
			status: schema.announcementCampaigns.status,
			name: schema.announcementCampaigns.name,
			releaseVersion: schema.announcementCampaigns.releaseVersion,
		})
		.from(schema.announcementCampaigns)
		.where(
			and(
				eq(schema.announcementCampaigns.type, campaignType),
				eq(schema.announcementCampaigns.name, name),
				releaseVersion === null
					? isNull(schema.announcementCampaigns.releaseVersion)
					: eq(schema.announcementCampaigns.releaseVersion, releaseVersion),
			),
		)
		.all() as Array<{ id: string; status: string }>;
	return rows.find((row) => row.status === "draft") ?? rows[0];
}

/**
 * What publishing an onboarding does that a release does not. Eligibility is
 * per user and per snapshot (`getEligibleCampaignForUser`), and a new
 * onboarding revision is a new snapshot: nobody has finished it yet, existing
 * accounts included, and it shows before any release announcement.
 */
const ONBOARDING_REACH_NOTE =
	"A published onboarding is shown once to every account that has not finished THIS revision, " +
	"existing accounts included, and before any release announcement. Publish it before the release " +
	"campaign if the sidebar badge should replay the release (the badge opens the newest published " +
	"announcement).";

/**
 * The badge in the sidebar takes the higher of the package version and the
 * newest published release campaign — unless an APP_VERSION_OVERRIDE row wins,
 * and that row is read from a per-process cache the running server only
 * refreshes on startup or on an admin-config save. Publishing from out here
 * cannot poke that cache, so say so rather than let the badge look broken.
 */
async function appVersionOverrideWarning(
	// biome-ignore lint/suspicious/noExplicitAny: see CampaignRunContext.db.
	db: any,
	releaseVersion: string,
): Promise<string | null> {
	const { eq } = await import("drizzle-orm");
	const schema = await import("$lib/server/db/schema");
	const row = db
		.select({ value: schema.adminConfig.value })
		.from(schema.adminConfig)
		.where(eq(schema.adminConfig.key, "APP_VERSION_OVERRIDE"))
		.get();
	const override = row?.value?.trim();
	if (!override) return null;
	return (
		`admin_config has APP_VERSION_OVERRIDE="${override}". The sidebar version badge shows the ` +
		`higher of that and the newest published release campaign (${releaseVersion}), and the override ` +
		`is read from an in-process cache. If the badge still reads "${override}", save any admin ` +
		`setting in Administration -> System (or restart the service) to refresh it.`
	);
}

export async function runCreateReleaseCampaign(
	options: CliOptions,
	context: CampaignRunContext,
): Promise<CampaignRunResult> {
	const { db, storageRoot } = context;
	const { isAllowedActionDestination } = await import(
		"$lib/campaign-action-destinations"
	);

	const isOnboarding = options.type === "onboarding";
	const campaignType = isOnboarding ? "first_run_onboarding" : "release_update";
	const releaseVersion = isOnboarding ? null : options.version;
	if (!isOnboarding && !releaseVersion) {
		throw new CampaignRunError("A release campaign needs a --version.");
	}

	const deck = loadDeck(options.deck, {
		pngDir: options.pngDir,
		isAllowedActionDestination,
		type: options.type,
	});
	const admin = await resolveAdminUser(db, options.adminEmail);
	const warnings: string[] = [];

	const existing = await findExistingCampaign(
		db,
		campaignType,
		options.name,
		releaseVersion,
	);
	// "named X for version V" (a release) or just "named X" (an onboarding has no version).
	const forVersion = releaseVersion ? ` for version ${releaseVersion}` : "";
	if (existing) {
		if (existing.status !== "draft") {
			throw new CampaignRunError(
				`A ${existing.status} ${isOnboarding ? "onboarding" : "campaign"} named "${options.name}" already exists${forVersion} ` +
					`(id ${existing.id}). Published campaigns are immutable — ${
						isOnboarding
							? "give the new one another --name (it becomes the next revision)"
							: "publish a new version or revision instead"
					}. --replace-draft only ever replaces a DRAFT.`,
			);
		}
		if (!options.replaceDraft) {
			throw new CampaignRunError(
				`A draft ${isOnboarding ? "onboarding" : "campaign"} named "${options.name}" already exists${forVersion} ` +
					`(id ${existing.id}). Re-run with --replace-draft to delete and recreate it.`,
			);
		}
	}

	const assetCount = deck.slides.length * VARIANTS.length;

	if (options.dryRun) {
		return {
			dryRun: true,
			campaignId: null,
			status: options.publish ? "would publish" : "would create draft",
			name: options.name,
			type: campaignType,
			releaseVersion,
			identityKey: null,
			revision: null,
			slideCount: deck.slides.length,
			assetCount,
			replacedDraftId: existing?.id ?? null,
			adminUserId: admin.id,
			adminUrl: ADMIN_CAMPAIGNS_PATH,
			storageRoot,
			warnings,
		};
	}

	const campaigns = await import("$lib/server/services/announcement-campaigns");
	const assets = await import("$lib/server/services/campaign-assets");

	let replacedDraftId: string | null = null;
	if (existing) {
		// deleteCampaignDraft refuses anything but a draft, so this cannot reach a
		// published campaign even if the check above were ever loosened.
		await campaigns.deleteCampaignDraft(existing.id, { db });
		replacedDraftId = existing.id;
	}

	const campaign = await campaigns.createCampaignDraft(
		{
			type: campaignType,
			name: options.name,
			releaseVersion,
			createdByUserId: admin.id,
		},
		{ db },
	);

	const slideInputs = [];
	for (const slide of deck.slides) {
		const cropIds: Partial<Record<Variant, string>> = {};
		for (const variant of VARIANTS) {
			const image = slide.images[variant];
			const filename = basename(image.path);
			const file = {
				filename,
				mimeType: image.mimeType,
				content: image.bytes,
			};
			const dimensions = { width: image.width, height: image.height };

			// The admin UI uploads a source, then saves a crop of it. Both rows
			// exist here for the same reason they exist there: Re-crop in the slide
			// editor needs the crop's sourceAssetId to reopen the original.
			const source = await assets.storeCampaignSourceAsset(
				{ uploadedByUserId: admin.id, file, dimensions },
				{ db, storageRoot },
			);
			const crop = await assets.saveCampaignCropAsset(
				{
					uploadedByUserId: admin.id,
					sourceAssetId: source.id,
					variant,
					file,
					dimensions,
					// The deck is authored at the exact target geometry, so the crop is
					// the whole frame at 1:1 — the "accept the full frame" the deck's
					// README tells a human to click in the crop modal.
					crop: {
						x: 0,
						y: 0,
						width: image.width,
						height: image.height,
						zoom: 1,
					},
				},
				{ db, storageRoot },
			);
			cropIds[variant] = crop.id;
		}

		slideInputs.push({
			layoutType: slide.layoutType,
			semanticRole: slide.semanticRole,
			setupControls: slide.setupControls,
			sortOrder: slide.index,
			title: { en: slide.titleEn, hu: slide.titleHu },
			body: { en: slide.bodyEn, hu: slide.bodyHu },
			altText: { en: slide.altTextEn, hu: slide.altTextHu },
			actionLabel: {
				en: slide.actionLabelEn ?? "",
				hu: slide.actionLabelHu ?? "",
			},
			actionDestination: slide.actionDestination,
			desktopCropAssetId: cropIds.desktop,
			mobileCropAssetId: cropIds.mobile,
		});
	}

	let saved = await campaigns.updateCampaignDraft(
		campaign.id,
		{ slides: slideInputs },
		{ db },
	);

	if (options.publish) {
		saved = await campaigns.publishCampaign(campaign.id, admin.id, { db });
		if (isOnboarding) {
			warnings.push(ONBOARDING_REACH_NOTE);
		} else if (releaseVersion) {
			const warning = await appVersionOverrideWarning(db, releaseVersion);
			if (warning) warnings.push(warning);
		}
	}

	return {
		dryRun: false,
		campaignId: saved.id,
		status: saved.status,
		name: saved.name,
		type: campaignType,
		releaseVersion: saved.releaseVersion ?? releaseVersion,
		identityKey: saved.identityKey,
		revision: saved.revision,
		slideCount: saved.slides.length,
		assetCount,
		replacedDraftId,
		adminUserId: admin.id,
		adminUrl: ADMIN_CAMPAIGNS_PATH,
		storageRoot,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

/**
 * The database file and the asset directory have to be the same deployment's.
 * `campaign-assets.ts` always writes to `<cwd>/data/campaign-assets` while the
 * database comes from DATABASE_PATH, so running from the wrong directory
 * writes rows pointing at files the server will never find — a campaign whose
 * every image 404s, discovered by users rather than by this script.
 */
export function checkDataLocations(
	cwd: string,
	databasePath: string,
): { storageRoot: string; problems: string[] } {
	const problems: string[] = [];
	const dataDir = join(cwd, "data");
	const storageRoot = join(dataDir, "campaign-assets");

	if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
		problems.push(
			`No data directory at ${dataDir}. Campaign assets are always written to <cwd>/data/campaign-assets, ` +
				`so run this from the release directory where "data" links to shared/data.`,
		);
		return { storageRoot, problems };
	}

	// Compare the real paths of the two DIRECTORIES, not of the database file,
	// which need not exist yet. Comparing a resolved path against a realpath
	// would report a difference for every symlink on the way — /var vs
	// /private/var on macOS, releases/<sha>/data vs shared/data on the server —
	// which is exactly the case this check has to call identical.
	const databaseDir = dirname(resolve(databasePath));
	const resolvedDbDir = existsSync(databaseDir)
		? realpathSync(databaseDir)
		: databaseDir;
	const resolvedDataDir = realpathSync(dataDir);
	if (resolvedDbDir !== resolvedDataDir) {
		problems.push(
			`DATABASE_PATH resolves into ${resolvedDbDir} but campaign assets would be written under ` +
				`${resolvedDataDir}. Those are different deployments' data directories; the campaign rows and ` +
				`their image files would end up apart. Run from the release directory and leave DATABASE_PATH ` +
				`pointing at that release's data.`,
		);
	}
	return { storageRoot, problems };
}

function printResult(result: CampaignRunResult, options: CliOptions): void {
	const lines: string[] = [];
	if (result.dryRun) {
		lines.push("");
		lines.push("DRY RUN — nothing was written.");
	}
	lines.push("");
	lines.push(`  Campaign        ${result.name}  (${result.type})`);
	if (result.releaseVersion) {
		lines.push(`  Release version ${result.releaseVersion}`);
	}
	lines.push(`  Status          ${result.status}`);
	if (result.campaignId) lines.push(`  Campaign id     ${result.campaignId}`);
	if (result.identityKey) lines.push(`  Identity key    ${result.identityKey}`);
	if (result.revision !== null)
		lines.push(`  Revision        ${result.revision}`);
	lines.push(`  Slides          ${result.slideCount}`);
	lines.push(
		`  Assets          ${result.assetCount} crops (+${result.assetCount} sources) under ${result.storageRoot}`,
	);
	lines.push(`  Author          ${options.adminEmail} (${result.adminUserId})`);
	if (result.replacedDraftId) {
		lines.push(
			`  Replaced draft  ${result.replacedDraftId}${result.dryRun ? " (would be deleted)" : ""}`,
		);
	}
	lines.push("");
	lines.push(`  Review it at    ${result.adminUrl} — ${ADMIN_CAMPAIGNS_HINT}`);
	lines.push("");
	for (const warning of result.warnings) {
		lines.push(`  WARNING: ${warning}`);
		lines.push("");
	}
	console.log(lines.join("\n"));
}

async function main(): Promise<number> {
	let options: CliOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`${(error as Error).message}\n\n${USAGE}`);
		return 2;
	}

	const databasePath = process.env.DATABASE_PATH ?? "./data/chat.db";
	const { storageRoot, problems } = checkDataLocations(
		process.cwd(),
		databasePath,
	);
	if (problems.length > 0) {
		console.error(`Refusing to run:\n  - ${problems.join("\n  - ")}`);
		return 1;
	}

	// Imported here, not at the top: the module opens the database as a side
	// effect of being imported, and DATABASE_PATH is only settled once dotenv
	// has run at the top of this file.
	const { db, sqlite } = await import("$lib/server/db/index");
	try {
		const result = await runCreateReleaseCampaign(options, { db, storageRoot });
		printResult(result, options);
		return 0;
	} catch (error) {
		if (
			error instanceof DeckValidationError ||
			error instanceof CampaignRunError
		) {
			console.error(error.message);
			return 1;
		}
		// The service's own validation errors carry a field map that is far more
		// useful than the message alone — this is what the admin checklist shows.
		const fieldErrors = (error as { fieldErrors?: Record<string, string> })
			?.fieldErrors;
		if (fieldErrors) {
			console.error((error as Error).message);
			for (const [field, message] of Object.entries(fieldErrors)) {
				console.error(`  - ${field}: ${message}`);
			}
			return 1;
		}
		console.error(error);
		return 1;
	} finally {
		sqlite.close();
	}
}

// `npx tsx scripts/create-release-campaign.ts` runs it; a test importing it
// gets the functions and no database.
const invokedDirectly =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
	process.exitCode = await main();
}
