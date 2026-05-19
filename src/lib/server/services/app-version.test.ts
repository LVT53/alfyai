import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	getAppVersionMetadata,
	getLatestPublishedReleaseVersion,
} from "./app-version";

describe("app version metadata", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
	});

	afterEach(() => {
		sqlite.close();
	});

	it("uses the latest published release campaign version for the sidebar badge", async () => {
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

	it("falls back to package metadata when no release campaign has been published", async () => {
		await expect(
			getAppVersionMetadata({ db, packageVersion: "0.1.0" }),
		).resolves.toEqual({
			full: "0.1.0",
			compact: "v0.1.0",
		});
	});

	it("caps the compact sidebar badge version at three numeric places", async () => {
		await expect(
			getAppVersionMetadata({ db, packageVersion: "1.2.3.4" }),
		).resolves.toEqual({
			full: "1.2.3.4",
			compact: "v1.2.3",
		});
	});
});
