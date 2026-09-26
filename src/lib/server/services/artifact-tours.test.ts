import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_TOUR_CONTENT_VERSION } from "$lib/server/artifact-tour-defaults";
import * as schema from "$lib/server/db/schema";
import type { ArtifactTourType } from "$lib/shared/artifacts/tours";
import { getArtifactTour } from "./artifact-tours";

describe("artifact tours service", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		db.insert(schema.users)
			.values([
				{ id: "user-1", email: "user1@example.com", passwordHash: "hash" },
				{ id: "user-2", email: "user2@example.com", passwordHash: "hash" },
			])
			.run();
	});

	afterEach(() => {
		sqlite.close();
	});

	/**
	 * Seeds a campaign + (for published/archived) its snapshot directly
	 * through the schema tables, bypassing `createCampaignDraft`/
	 * `publishCampaign`'s own type/layout validation. The resolver only
	 * reads what is in the tables, so its tests should not depend on the
	 * admin-side `artifact_tour` type/layout support landing first (Task T5).
	 */
	function insertTourCampaign(params: {
		campaignId: string;
		snapshotId: string;
		kind: ArtifactTourType;
		status: "draft" | "published" | "archived";
		revision?: number;
		summary?: { en: string; hu: string };
	}) {
		const revision = params.revision ?? 1;
		const identityKey = `artifact_tour:${params.kind}:r${revision}`;
		db.insert(schema.announcementCampaigns)
			.values({
				id: params.campaignId,
				type: "artifact_tour",
				status: params.status,
				identityKey,
				name: `${params.kind} tour`,
				campaignVersion: params.kind,
				revision,
				releaseVersion: params.kind,
				publishedSnapshotId:
					params.status === "draft" ? null : params.snapshotId,
				createdByUserId: "user-1",
				publishedByUserId: params.status === "draft" ? null : "user-1",
				publishedAt:
					params.status === "draft" ? null : new Date("2026-01-01T00:00:00Z"),
				archivedAt:
					params.status === "archived"
						? new Date("2026-01-02T00:00:00Z")
						: null,
			})
			.run();
		if (params.status === "draft") return;

		const summary = params.summary ?? {
			en: `Published ${params.kind} summary`,
			hu: `Publikált ${params.kind} összegzés`,
		};
		db.insert(schema.announcementCampaignSnapshots)
			.values({
				id: params.snapshotId,
				campaignId: params.campaignId,
				identityKey,
				type: "artifact_tour",
				name: `${params.kind} tour`,
				campaignVersion: params.kind,
				revision,
				releaseVersion: params.kind,
				publishedByUserId: "user-1",
				publishedAt: new Date("2026-01-01T00:00:00Z"),
			})
			.run();
		db.insert(schema.announcementCampaignSnapshotSlides)
			.values([
				{
					id: `${params.snapshotId}-summary`,
					snapshotId: params.snapshotId,
					campaignId: params.campaignId,
					layoutType: "summary",
					sortOrder: 1,
					titleEn: summary.en,
					titleHu: summary.hu,
					bodyEn: "Second line.",
					bodyHu: "Második sor.",
					altTextEn: "",
					altTextHu: "",
				},
				{
					id: `${params.snapshotId}-1`,
					snapshotId: params.snapshotId,
					campaignId: params.campaignId,
					layoutType: "standard",
					sortOrder: 2,
					titleEn: "Slide one",
					titleHu: "Első dia",
					bodyEn: "Body one.",
					bodyHu: "Első törzs.",
					altTextEn: "",
					altTextHu: "",
				},
				{
					id: `${params.snapshotId}-2`,
					snapshotId: params.snapshotId,
					campaignId: params.campaignId,
					layoutType: "standard",
					sortOrder: 3,
					titleEn: "Slide two",
					titleHu: "Második dia",
					bodyEn: "Body two.",
					bodyHu: "Második törzs.",
					altTextEn: "",
					altTextHu: "",
				},
				{
					id: `${params.snapshotId}-3`,
					snapshotId: params.snapshotId,
					campaignId: params.campaignId,
					layoutType: "standard",
					sortOrder: 4,
					titleEn: "Slide three",
					titleHu: "Harmadik dia",
					bodyEn: "Body three.",
					bodyHu: "Harmadik törzs.",
					altTextEn: "",
					altTextHu: "",
				},
			])
			.run();
	}

	it("prefers a published campaign snapshot over the default", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "canvas",
			status: "published",
		});

		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "canvas",
			options: { db },
		});

		expect(result?.tour.source).toBe("published");
		expect(result?.tour.contentKey).toBe("snapshot:s1");
		expect(result?.tour.summary.en).toBe("Published canvas summary");
		expect(result?.tour.slides).toHaveLength(3);
		expect(result?.tour.slides[0]?.title.en).toBe("Slide one");
	});

	it("ignores a draft campaign", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "canvas",
			status: "draft",
		});

		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "canvas",
			options: { db },
		});

		expect(result?.tour.source).toBe("default");
		expect(result?.tour.contentKey).toBe(
			`default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
		);
	});

	it("ignores an archived campaign and does not fall back to the default", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "canvas",
			status: "archived",
		});

		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "canvas",
			options: { db },
		});

		expect(result).toBeNull();
	});

	it("keys a published tour as snapshot:<id> and a default as default:<version>", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "canvas",
			status: "published",
		});

		const published = await getArtifactTour({
			userId: "user-1",
			artifactType: "canvas",
			options: { db },
		});
		expect(published?.tour.contentKey).toBe("snapshot:s1");

		const defaulted = await getArtifactTour({
			userId: "user-1",
			artifactType: "document",
			options: { db },
		});
		expect(defaulted?.tour.contentKey).toBe(
			`default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
		);
	});

	it("returns null for a kind with neither, without throwing", async () => {
		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "bogus" as ArtifactTourType,
			options: { db },
		});

		expect(result).toBeNull();
	});

	it("returns the default when the campaign read throws", async () => {
		// A broken/missing campaign table must not break the panel — only the
		// campaign read fails, the seen-state table is untouched and healthy.
		sqlite.exec("DROP TABLE announcement_campaigns");

		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "canvas",
			options: { db },
		});

		expect(result?.tour.source).toBe("default");
		expect(result?.seen).toBe(false);
	});

	it("reports the seen state and the last slide for this user", async () => {
		db.insert(schema.artifactTourStates)
			.values({
				id: "state-1",
				userId: "user-1",
				artifactType: "document",
				contentKey: `default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
				status: "completed",
				slideCount: 3,
				lastSlide: 2,
				completedAt: new Date(),
			})
			.run();

		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "document",
			options: { db },
		});

		expect(result?.seen).toBe(true);
		expect(result?.lastSlide).toBe(2);
	});

	it("reports seen: false for a different user", async () => {
		db.insert(schema.artifactTourStates)
			.values({
				id: "state-1",
				userId: "user-1",
				artifactType: "document",
				contentKey: `default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
				status: "completed",
				slideCount: 3,
				lastSlide: 2,
				completedAt: new Date(),
			})
			.run();

		const result = await getArtifactTour({
			userId: "user-2",
			artifactType: "document",
			options: { db },
		});

		expect(result?.seen).toBe(false);
		expect(result?.lastSlide).toBe(0);
	});

	it("is unaffected by another kind's seen state", async () => {
		db.insert(schema.artifactTourStates)
			.values({
				id: "state-1",
				userId: "user-1",
				artifactType: "canvas",
				contentKey: `default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
				status: "completed",
				slideCount: 3,
				lastSlide: 2,
				completedAt: new Date(),
			})
			.run();

		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "document",
			options: { db },
		});

		expect(result?.seen).toBe(false);
		expect(result?.lastSlide).toBe(0);
	});
});
