import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import {
	getConfig,
	type RuntimeConfig,
	refreshConfig,
} from "$lib/server/config-store";
import { db as defaultDb } from "$lib/server/db";
import { adminConfig, announcementCampaigns } from "$lib/server/db/schema";

type AppVersionDb = typeof defaultDb;

interface PackageMetadata {
	version?: string;
}

export interface AppVersionMetadata {
	full: string;
	compact: string;
}

export interface AppVersionMetadataOptions {
	db?: AppVersionDb;
	packageVersion?: string;
	config?: Pick<RuntimeConfig, "appVersionOverride">;
}

function readPackageMetadata(): PackageMetadata {
	return JSON.parse(
		readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
	) as PackageMetadata;
}

function compactVersion(version: string): string {
	const normalized = version.trim().replace(/^v/i, "");
	const separator = normalized.indexOf("-");
	const core = separator === -1 ? normalized : normalized.slice(0, separator);
	const suffix = separator === -1 ? "" : normalized.slice(separator);
	const [major = "0", minor = "0", patch] = core.split(".");
	const places = [major, minor, patch].filter((part) => part !== undefined);
	return `v${places.join(".")}${suffix}`;
}

/**
 * Splits a version into its numeric parts and its pre-release suffix. Release
 * versions are typed by hand into the campaign editor, so anything that is not
 * a number is skipped rather than rejected: "v2.0.1" and "2.0.1" parse the
 * same, and a string with no digits parses as no parts at all.
 */
function parseVersion(version: string): {
	parts: number[];
	prerelease: string;
} {
	const normalized = version.trim().replace(/^v/i, "");
	const separator = normalized.indexOf("-");
	const core = separator === -1 ? normalized : normalized.slice(0, separator);
	const suffix = separator === -1 ? "" : normalized.slice(separator + 1);
	const parts = (core.match(/\d+/g) ?? [])
		.map((part) => Number(part))
		.filter((part) => Number.isFinite(part));
	return { parts, prerelease: suffix.split("+")[0] ?? "" };
}

function compareVersions(left: string, right: string): number {
	const leftVersion = parseVersion(left);
	const rightVersion = parseVersion(right);
	const length = Math.max(leftVersion.parts.length, rightVersion.parts.length);
	for (let index = 0; index < length; index += 1) {
		const diff =
			(leftVersion.parts[index] ?? 0) - (rightVersion.parts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	if (leftVersion.prerelease === rightVersion.prerelease) return 0;
	// Semantic versioning puts a pre-release below the release it leads to, so
	// a published "2.1.0-rc.1" campaign must not outrank package version 2.1.0.
	if (!leftVersion.prerelease) return 1;
	if (!rightVersion.prerelease) return -1;
	return leftVersion.prerelease < rightVersion.prerelease ? -1 : 1;
}

async function clearAppVersionOverride(db: AppVersionDb): Promise<void> {
	db.delete(adminConfig)
		.where(eq(adminConfig.key, "APP_VERSION_OVERRIDE"))
		.run();
	await refreshConfig();
}

export async function getLatestPublishedReleaseVersion(
	options: Pick<AppVersionMetadataOptions, "db"> = {},
): Promise<string | null> {
	const db = options.db ?? defaultDb;
	const rows = db
		.select({ releaseVersion: announcementCampaigns.releaseVersion })
		.from(announcementCampaigns)
		.where(
			and(
				eq(announcementCampaigns.type, "release_update"),
				eq(announcementCampaigns.status, "published"),
			),
		)
		.orderBy(
			desc(announcementCampaigns.publishedAt),
			desc(announcementCampaigns.revision),
		)
		.all();
	let highest: string | null = null;
	for (const row of rows) {
		const releaseVersion = row.releaseVersion?.trim() || "";
		if (!releaseVersion) continue;
		if (!highest || compareVersions(releaseVersion, highest) > 0) {
			highest = releaseVersion;
		}
	}
	return highest;
}

export async function getAppVersionMetadata(
	options: AppVersionMetadataOptions = {},
): Promise<AppVersionMetadata> {
	const db = options.db ?? defaultDb;
	const appVersionOverride =
		options.config === undefined
			? getConfig().appVersionOverride
			: options.config.appVersionOverride;
	const packageVersion =
		options.packageVersion ?? readPackageMetadata().version ?? "0.0.0";
	const trimmedOverride = appVersionOverride?.trim() || "";
	let full = trimmedOverride || packageVersion;
	const latestRelease = await getLatestPublishedReleaseVersion({ db });
	if (latestRelease && compareVersions(latestRelease, full) > 0) {
		full = latestRelease;
		if (trimmedOverride && options.config === undefined) {
			await clearAppVersionOverride(db);
		}
	}
	return {
		full,
		compact: compactVersion(full),
	};
}
