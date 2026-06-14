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
	const [major = "0", minor = "0", patch] = normalized.split(".");
	return `v${[major, minor, patch].filter((part) => part !== undefined).join(".")}`;
}

function versionParts(version: string): number[] {
	const parts = version.match(/\d+/g)?.map((part) => Number(part)) ?? [];
	return parts.filter((part) => Number.isFinite(part));
}

function compareVersions(left: string, right: string): number {
	const leftParts = versionParts(left);
	const rightParts = versionParts(right);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
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
