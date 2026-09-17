import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	getAppVersionMetadata,
	getLatestPublishedReleaseVersion,
} from "./app-version";

const configStoreMock = vi.hoisted(() => ({
	appVersionOverride: null as string | null,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({
		appVersionOverride: configStoreMock.appVersionOverride,
	}),
	refreshConfig: vi.fn(),
}));

describe("app version metadata", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		configStoreMock.appVersionOverride = null;
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
	});

	afterEach(() => {
		sqlite.close();
	});

	function insertReleaseCampaign(
		releaseVersion: string,
		overrides: { id?: string; publishedAt?: Date } = {},
	) {
		const id = overrides.id ?? `release-${releaseVersion}`;
		db.insert(schema.announcementCampaigns)
			.values({
				id,
				type: "release_update",
				status: "published",
				identityKey: `release_update:${releaseVersion}:r1`,
				name: `AlfyAI ${releaseVersion}`,
				campaignVersion: releaseVersion,
				revision: 1,
				releaseVersion,
				publishedAt: overrides.publishedAt ?? new Date("2026-09-17T10:00:00Z"),
			})
			.run();
	}

	it("uses the highest published release campaign version when it is newer than package metadata", async () => {
		db.insert(schema.announcementCampaigns)
			.values([
				{
					id: "release-1",
					type: "release_update",
					status: "published",
					identityKey: "release_update:0.9.0:r1",
					name: "AlfyAI 0.9",
					campaignVersion: "0.9.0",
					revision: 1,
					releaseVersion: "0.9.0",
					publishedAt: new Date("2026-05-16T10:00:00.000Z"),
				},
				{
					id: "release-2",
					type: "release_update",
					status: "published",
					identityKey: "release_update:1.0.1:r1",
					name: "AlfyAI 1.0",
					campaignVersion: "1.0.1",
					revision: 1,
					releaseVersion: "1.0.1",
					publishedAt: new Date("2026-05-17T10:00:00.000Z"),
				},
				{
					id: "release-newer-lower",
					type: "release_update",
					status: "published",
					identityKey: "release_update:1.0.0:r2",
					name: "AlfyAI 1.0 patch",
					campaignVersion: "1.0.0",
					revision: 2,
					releaseVersion: "1.0.0",
					publishedAt: new Date("2026-05-18T10:00:00.000Z"),
				},
				{
					id: "onboarding-latest",
					type: "first_run_onboarding",
					status: "published",
					identityKey: "first_run_onboarding:v1:r3",
					name: "New onboarding",
					campaignVersion: "v1",
					revision: 3,
					releaseVersion: null,
					publishedAt: new Date("2026-05-18T10:00:00.000Z"),
				},
			])
			.run();

		await expect(getLatestPublishedReleaseVersion({ db })).resolves.toBe(
			"1.0.1",
		);
		await expect(
			getAppVersionMetadata({ db, packageVersion: "0.1.0" }),
		).resolves.toEqual({
			full: "1.0.1",
			compact: "v1.0.1",
		});
	});

	it("uses the admin app version override for the sidebar badge before package metadata", async () => {
		await expect(
			getAppVersionMetadata({
				db,
				packageVersion: "0.1.0",
				config: { appVersionOverride: "2026.05-admin" },
			}),
		).resolves.toEqual({
			full: "2026.05-admin",
			compact: "v2026.05-admin",
		});
	});

	it("uses the ambient admin app version override when no config is injected", async () => {
		configStoreMock.appVersionOverride = "2026.05-admin";

		await expect(
			getAppVersionMetadata({ db, packageVersion: "0.1.0" }),
		).resolves.toEqual({
			full: "2026.05-admin",
			compact: "v2026.05-admin",
		});
	});

	it("uses a newer release campaign over an ambient admin override and clears the override", async () => {
		configStoreMock.appVersionOverride = "1.0.0";
		db.insert(schema.adminConfig)
			.values({
				key: "APP_VERSION_OVERRIDE",
				value: "1.0.0",
				updatedBy: "admin-user",
			})
			.run();
		db.insert(schema.announcementCampaigns)
			.values({
				id: "release-2",
				type: "release_update",
				status: "published",
				identityKey: "release_update:1.2.0:r1",
				name: "AlfyAI 1.2",
				campaignVersion: "1.2.0",
				revision: 1,
				releaseVersion: "1.2.0",
				publishedAt: new Date("2026-05-17T10:00:00.000Z"),
			})
			.run();

		await expect(
			getAppVersionMetadata({ db, packageVersion: "0.1.0" }),
		).resolves.toEqual({
			full: "1.2.0",
			compact: "v1.2.0",
		});
		expect(
			db
				.select()
				.from(schema.adminConfig)
				.all()
				.some((row) => row.key === "APP_VERSION_OVERRIDE"),
		).toBe(false);
	});

	it("treats an injected null app version override as authoritative", async () => {
		configStoreMock.appVersionOverride = "2026.05-admin";

		await expect(
			getAppVersionMetadata({
				db,
				packageVersion: "0.1.0",
				config: { appVersionOverride: null },
			}),
		).resolves.toEqual({
			full: "0.1.0",
			compact: "v0.1.0",
		});
	});

	it("falls back to package metadata when no release campaign has been published", async () => {
		await expect(
			getAppVersionMetadata({ db, packageVersion: "0.1.0" }),
		).resolves.toEqual({
			full: "0.1.0",
			compact: "v0.1.0",
		});
	});

	it("falls back to package metadata when the admin app version override is empty", async () => {
		await expect(
			getAppVersionMetadata({
				db,
				packageVersion: "0.1.0",
				config: { appVersionOverride: "   " },
			}),
		).resolves.toEqual({
			full: "0.1.0",
			compact: "v0.1.0",
		});
	});

	it("compares a 2.0.0 release campaign against the package version", async () => {
		insertReleaseCampaign("2.0.0");

		await expect(getLatestPublishedReleaseVersion({ db })).resolves.toBe(
			"2.0.0",
		);
		// Newer than the pre-2.0 package version: the campaign wins.
		await expect(
			getAppVersionMetadata({ db, packageVersion: "0.1.0" }),
		).resolves.toEqual({ full: "2.0.0", compact: "v2.0.0" });
		// Equal to the package version: nothing changes, and no leading "v" or
		// zero-padding creeps in.
		await expect(
			getAppVersionMetadata({ db, packageVersion: "2.0.0" }),
		).resolves.toEqual({ full: "2.0.0", compact: "v2.0.0" });
		// Older than the package version: the package version wins.
		await expect(
			getAppVersionMetadata({ db, packageVersion: "2.1.0" }),
		).resolves.toEqual({ full: "2.1.0", compact: "v2.1.0" });
	});

	it("compares version components numerically, not as strings", async () => {
		insertReleaseCampaign("2.10.0");

		// String comparison would put "2.10.0" below "2.9.0".
		await expect(
			getAppVersionMetadata({ db, packageVersion: "2.9.0" }),
		).resolves.toEqual({ full: "2.10.0", compact: "v2.10.0" });
		await expect(
			getAppVersionMetadata({ db, packageVersion: "2.11.0" }),
		).resolves.toEqual({ full: "2.11.0", compact: "v2.11.0" });
	});

	it("picks the highest release version even when a lower one was published later", async () => {
		insertReleaseCampaign("2.10.0", {
			id: "release-high",
			publishedAt: new Date("2026-09-01T10:00:00.000Z"),
		});
		insertReleaseCampaign("2.9.0", {
			id: "release-low-but-later",
			publishedAt: new Date("2026-09-17T10:00:00.000Z"),
		});

		await expect(getLatestPublishedReleaseVersion({ db })).resolves.toBe(
			"2.10.0",
		);
	});

	it("caps the compact sidebar badge version at three numeric places", async () => {
		await expect(
			getAppVersionMetadata({ db, packageVersion: "1.2.3.4" }),
		).resolves.toEqual({
			full: "1.2.3.4",
			compact: "v1.2.3",
		});
	});

	it("reads package.json through a symlinked working directory (ADR-0054 releases/current layout)", async () => {
		// Mirrors the atomic-release layout: WorkingDirectory is a symlink
		// (`current`) pointing at the real release dir (`releases/<sha>`).
		// process.cwd() resolves the symlink to its physical path, so
		// readPackageMetadata's resolve(process.cwd(), "package.json") must
		// still find the release's package.json.
		const releaseDir = mkdtempSync(
			join(tmpdir(), "alfyai-app-version-release-"),
		);
		const appRootDir = mkdtempSync(join(tmpdir(), "alfyai-app-version-root-"));
		const currentSymlink = join(appRootDir, "current");
		writeFileSync(
			join(releaseDir, "package.json"),
			JSON.stringify({ version: "9.9.9" }),
		);
		symlinkSync(releaseDir, currentSymlink, "dir");
		const previousCwd = process.cwd();

		try {
			process.chdir(currentSymlink);
			await expect(getAppVersionMetadata({ db })).resolves.toEqual({
				full: "9.9.9",
				compact: "v9.9.9",
			});
		} finally {
			process.chdir(previousCwd);
			rmSync(appRootDir, { recursive: true, force: true });
			rmSync(releaseDir, { recursive: true, force: true });
		}
	});
});
