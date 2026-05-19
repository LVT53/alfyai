import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { announcementCampaigns } from "$lib/server/db/schema";

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

export async function getLatestPublishedReleaseVersion(
	options: Pick<AppVersionMetadataOptions, "db"> = {},
): Promise<string | null> {
	const db = options.db ?? defaultDb;
	const row = db
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
		.get();
	return row?.releaseVersion?.trim() || null;
}

export async function getAppVersionMetadata(
	options: AppVersionMetadataOptions = {},
): Promise<AppVersionMetadata> {
	const releaseVersion = await getLatestPublishedReleaseVersion(options);
	const full =
		releaseVersion ??
		options.packageVersion ??
		readPackageMetadata().version ??
		"0.0.0";
	return {
		full,
		compact: compactVersion(full),
	};
}
