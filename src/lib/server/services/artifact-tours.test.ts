import Database from "better-sqlite3";
import { and, eq, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_TOUR_CONTENT_VERSION } from "$lib/server/artifact-tour-defaults";
import * as schema from "$lib/server/db/schema";
import type { ArtifactTourType } from "$lib/shared/artifacts/tours";
import {
	getArtifactTour,
	markArtifactTourSeen,
	parseArtifactTourSeenBody,
	seedArtifactTourDrafts,
} from "./artifact-tours";

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
				{
					id: "admin-user",
					email: "admin@example.com",
					passwordHash: "hash",
					role: "admin",
				},
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
			artifactType: "bogus" as never,
			options: { db },
		});

		expect(result).toBeNull();
	});

	it("does not mistake an inherited Object.prototype key for a real kind", async () => {
		// A plain-object `in` check (unlike the shipped list's membership test)
		// would say `"toString" in ARTIFACT_TOUR_DEFAULTS` is true.
		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "toString" as never,
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

	// --- Ruling 69: the kinds that do not ship are not served ---

	it("serves no tour for a kind that does not ship, even when a campaign for it is published", async () => {
		// An inert row an admin could in principle have written: the resolver
		// answers from the shipped list, so it is never read.
		insertTourCampaign({
			campaignId: "slides-campaign",
			snapshotId: "slides-snapshot",
			kind: "slides",
			status: "published",
		});

		const result = await getArtifactTour({
			userId: "user-1",
			artifactType: "slides" as never,
			options: { db },
		});

		expect(result).toBeNull();
	});

	// --- T4: seen-tracking ---

	const CURRENT_DEFAULT_KEY = `default:${ARTIFACT_TOUR_CONTENT_VERSION}`;

	function stateRows(userId: string) {
		return db
			.select()
			.from(schema.artifactTourStates)
			.where(eq(schema.artifactTourStates.userId, userId))
			.all();
	}

	function rowCounts(): Record<string, number> {
		const tables = sqlite
			.prepare(
				"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'",
			)
			.all() as Array<{ name: string }>;
		return Object.fromEntries(
			tables.map(({ name }) => [
				name,
				(
					sqlite.prepare(`select count(*) as n from "${name}"`).get() as {
						n: number;
					}
				).n,
			]),
		);
	}

	it("records a completed tour once and is idempotent on a second write", async () => {
		const write = () =>
			markArtifactTourSeen({
				userId: "user-1",
				artifactType: "document",
				contentKey: CURRENT_DEFAULT_KEY,
				status: "completed",
				lastSlide: 2,
				options: { db },
			});

		expect(await write()).toEqual({ ok: true, alreadyRecorded: false });
		expect(await write()).toEqual({ ok: true, alreadyRecorded: true });

		const rows = stateRows("user-1");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			artifactType: "document",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "completed",
			slideCount: 3,
			lastSlide: 2,
		});
		expect(rows[0]?.completedAt).toBeInstanceOf(Date);
		expect(rows[0]?.dismissedAt).toBeNull();
		const lookup = await getArtifactTour({
			userId: "user-1",
			artifactType: "document",
			options: { db },
		});
		expect(lookup).toMatchObject({ seen: true, lastSlide: 2 });
	});

	it("records a dismissed tour and does not offer it again", async () => {
		const result = await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "app",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "dismissed",
			lastSlide: 0,
			options: { db },
		});

		expect(result).toEqual({ ok: true, alreadyRecorded: false });
		const [row] = stateRows("user-1");
		expect(row?.status).toBe("dismissed");
		expect(row?.dismissedAt).toBeInstanceOf(Date);
		expect(row?.completedAt).toBeNull();
		// "Seen" is a row for this content, whichever way the user left it.
		const lookup = await getArtifactTour({
			userId: "user-1",
			artifactType: "app",
			options: { db },
		});
		expect(lookup?.seen).toBe(true);
	});

	it("keeps the last slide index on a dismissal", async () => {
		await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "canvas",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "dismissed",
			lastSlide: 1,
			options: { db },
		});

		const lookup = await getArtifactTour({
			userId: "user-1",
			artifactType: "canvas",
			options: { db },
		});
		expect(lookup).toMatchObject({ seen: true, lastSlide: 1 });
		expect(stateRows("user-1")[0]?.lastSlide).toBe(1);
	});

	it("leaves the first answer in place when a second, different one arrives", async () => {
		await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "document",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "dismissed",
			lastSlide: 1,
			options: { db },
		});
		// Another tab finished the same tour a moment later.
		const second = await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "document",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "completed",
			lastSlide: 2,
			options: { db },
		});

		expect(second).toEqual({ ok: true, alreadyRecorded: true });
		const rows = stateRows("user-1");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: "dismissed", lastSlide: 1 });
	});

	it("re-shows a kind's tour when a new snapshot is published", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "canvas",
			status: "published",
			revision: 1,
		});
		expect(
			await markArtifactTourSeen({
				userId: "user-1",
				artifactType: "canvas",
				contentKey: "snapshot:s1",
				status: "completed",
				lastSlide: 2,
				options: { db },
			}),
		).toEqual({ ok: true, alreadyRecorded: false });

		// The admin edits the words and publishes again: a new snapshot, so a
		// new content key, so the user is shown it once.
		insertTourCampaign({
			campaignId: "c2",
			snapshotId: "s2",
			kind: "canvas",
			status: "published",
			revision: 2,
		});
		const lookup = await getArtifactTour({
			userId: "user-1",
			artifactType: "canvas",
			options: { db },
		});
		expect(lookup?.tour.contentKey).toBe("snapshot:s2");
		expect(lookup).toMatchObject({ seen: false, lastSlide: 0 });
		// What the user already saw stays recorded: re-showing is by key.
		expect(stateRows("user-1")).toHaveLength(1);
	});

	it("does not re-show it when the same snapshot is opened again", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "canvas",
			status: "published",
		});
		await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "canvas",
			contentKey: "snapshot:s1",
			status: "dismissed",
			lastSlide: 1,
			options: { db },
		});

		for (let open = 0; open < 3; open += 1) {
			const lookup = await getArtifactTour({
				userId: "user-1",
				artifactType: "canvas",
				options: { db },
			});
			expect(lookup).toMatchObject({ seen: true, lastSlide: 1 });
		}
	});

	it("refuses a write for content that is no longer current, and says what is", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "document",
			status: "published",
		});

		// The user was shown the code default; an admin has since published.
		const result = await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "document",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "completed",
			lastSlide: 2,
			options: { db },
		});

		expect(result).toEqual({
			ok: false,
			reason: "content_changed",
			contentKey: "snapshot:s1",
		});
		expect(stateRows("user-1")).toEqual([]);
	});

	it("refuses a key nobody ever issued", async () => {
		const result = await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "document",
			contentKey: "snapshot:made-up",
			status: "completed",
			lastSlide: 2,
			options: { db },
		});

		expect(result).toEqual({
			ok: false,
			reason: "content_changed",
			contentKey: CURRENT_DEFAULT_KEY,
		});
		expect(stateRows("user-1")).toEqual([]);
	});

	it("names no current key when the kind's tour was retired, and writes nothing", async () => {
		insertTourCampaign({
			campaignId: "c1",
			snapshotId: "s1",
			kind: "app",
			status: "archived",
		});

		const result = await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "app",
			contentKey: "snapshot:s1",
			status: "completed",
			lastSlide: 2,
			options: { db },
		});

		expect(result).toEqual({
			ok: false,
			reason: "content_changed",
			contentKey: null,
		});
		expect(stateRows("user-1")).toEqual([]);
	});

	it("refuses a write for a kind that is not a tour kind, and writes nothing", async () => {
		for (const artifactType of ["file", "slides", "bogus", "toString", ""]) {
			const result = await markArtifactTourSeen({
				userId: "user-1",
				artifactType: artifactType as never,
				contentKey: CURRENT_DEFAULT_KEY,
				status: "completed",
				lastSlide: 2,
				options: { db },
			});
			expect(result).toEqual({ ok: false, reason: "unknown_type" });
		}
		expect(stateRows("user-1")).toEqual([]);
	});

	it("records one user's tour without touching another's", async () => {
		await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "document",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "completed",
			lastSlide: 2,
			options: { db },
		});

		const other = await getArtifactTour({
			userId: "user-2",
			artifactType: "document",
			options: { db },
		});
		expect(other).toMatchObject({ seen: false, lastSlide: 0 });
		expect(stateRows("user-2")).toEqual([]);
	});

	it("never stores a conversation id or an artifact id in the row", async () => {
		await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "canvas",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "completed",
			lastSlide: 2,
			options: { db },
		});

		// By shape: the table has nowhere to put either.
		expect(
			Object.values(getTableColumns(schema.artifactTourStates))
				.map((column) => column.name)
				.sort(),
		).toEqual([
			"artifact_type",
			"completed_at",
			"content_key",
			"created_at",
			"dismissed_at",
			"id",
			"last_slide",
			"slide_count",
			"status",
			"updated_at",
			"user_id",
		]);
		// By content: the stored row names the user, the kind and the content
		// key, and no other string.
		const [row] = stateRows("user-1");
		const strings = Object.values(row ?? {}).filter(
			(value): value is string => typeof value === "string",
		);
		expect(strings.sort()).toEqual(
			[row?.id, "user-1", "canvas", CURRENT_DEFAULT_KEY, "completed"].sort(),
		);
	});

	it("writes exactly one row in one table, and nothing into telemetry or logs", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(level) => vi.spyOn(console, level).mockImplementation(() => {}),
		);
		const before = rowCounts();

		await markArtifactTourSeen({
			userId: "user-1",
			artifactType: "canvas",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "dismissed",
			lastSlide: 1,
			options: { db },
		});

		const after = rowCounts();
		const changed = Object.keys(after).filter(
			(name) => after[name] !== before[name],
		);
		// No campaign event, no analytics event, no memory event: the seen
		// state is the whole of what a tour records about the user.
		expect(changed).toEqual(["artifact_tour_states"]);
		expect(after.artifact_tour_states).toBe(
			(before.artifact_tour_states ?? 0) + 1,
		);
		for (const spy of spies) {
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		}
	});

	it("forgets a user's tours with the user, so a recreated user sees them again", async () => {
		await markArtifactTourSeen({
			userId: "user-2",
			artifactType: "document",
			contentKey: CURRENT_DEFAULT_KEY,
			status: "completed",
			lastSlide: 2,
			options: { db },
		});
		expect(stateRows("user-2")).toHaveLength(1);

		db.delete(schema.users).where(eq(schema.users.id, "user-2")).run();
		expect(stateRows("user-2")).toEqual([]);
		db.insert(schema.users)
			.values({
				id: "user-2",
				email: "user2@example.com",
				passwordHash: "hash",
			})
			.run();

		const again = await getArtifactTour({
			userId: "user-2",
			artifactType: "document",
			options: { db },
		});
		expect(again).toMatchObject({ seen: false, lastSlide: 0 });
	});
});

describe("seedArtifactTourDrafts", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		db.insert(schema.users)
			.values({
				id: "admin-user",
				email: "admin@example.com",
				passwordHash: "hash",
				role: "admin",
			})
			.run();
	});

	afterEach(() => {
		sqlite.close();
	});

	it("seeds three drafts, one per shipped kind, and seeds nothing on a second call", async () => {
		const first = await seedArtifactTourDrafts("admin-user", { db });
		expect(first).toEqual({ created: 3, existing: 0 });

		const rows = db
			.select()
			.from(schema.announcementCampaigns)
			.where(eq(schema.announcementCampaigns.type, "artifact_tour"))
			.all();
		expect(rows).toHaveLength(3);
		// Ruling 69: Slides is shelved, so no Slides draft is seeded — its copy
		// waits in the defaults table and nobody is offered it.
		expect(rows.map((row) => row.releaseVersion).sort()).toEqual([
			"app",
			"canvas",
			"document",
		]);

		const second = await seedArtifactTourDrafts("admin-user", { db });
		expect(second).toEqual({ created: 0, existing: 3 });
		expect(
			db
				.select()
				.from(schema.announcementCampaigns)
				.where(eq(schema.announcementCampaigns.type, "artifact_tour"))
				.all(),
		).toHaveLength(3);
	});

	it("gives each seeded draft a distinct identity key", async () => {
		await seedArtifactTourDrafts("admin-user", { db });

		const rows = db
			.select({ identityKey: schema.announcementCampaigns.identityKey })
			.from(schema.announcementCampaigns)
			.where(eq(schema.announcementCampaigns.type, "artifact_tour"))
			.all();
		const keys = rows.map((row) => row.identityKey).sort();
		expect(keys).toEqual([
			"artifact_tour:app:r1",
			"artifact_tour:canvas:r1",
			"artifact_tour:document:r1",
		]);
		expect(new Set(keys).size).toBe(3);
	});

	it("leaves a seeded draft unpublished", async () => {
		await seedArtifactTourDrafts("admin-user", { db });

		const rows = db
			.select({ status: schema.announcementCampaigns.status })
			.from(schema.announcementCampaigns)
			.where(eq(schema.announcementCampaigns.type, "artifact_tour"))
			.all();
		expect(rows.every((row) => row.status === "draft")).toBe(true);
	});

	it("pre-fills each draft with one summary slide and three ordered standard slides", async () => {
		await seedArtifactTourDrafts("admin-user", { db });

		const canvasCampaign = db
			.select({ id: schema.announcementCampaigns.id })
			.from(schema.announcementCampaigns)
			.where(
				and(
					eq(schema.announcementCampaigns.type, "artifact_tour"),
					eq(schema.announcementCampaigns.releaseVersion, "canvas"),
				),
			)
			.get();
		const slides = db
			.select()
			.from(schema.announcementCampaignSlides)
			.where(
				eq(
					schema.announcementCampaignSlides.campaignId,
					canvasCampaign?.id ?? "",
				),
			)
			.orderBy(schema.announcementCampaignSlides.sortOrder)
			.all();

		expect(slides.map((slide) => slide.layoutType)).toEqual([
			"summary",
			"standard",
			"standard",
			"standard",
		]);
		expect(slides[0]?.titleEn).toBe(
			"Empty board. Insert a block or draw on it.",
		);
		expect(slides[1]?.titleEn).toBe("A board for anything");
	});
});

describe("artifact_tour_states table (Task T1)", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "user1@example.com",
				passwordHash: "hash",
			})
			.run();
	});

	afterEach(() => {
		sqlite.close();
	});

	it("enforces the unique index on (user_id, artifact_type, content_key)", () => {
		const row = {
			id: "state-1",
			userId: "user-1",
			artifactType: "canvas" as const,
			contentKey: "default:1",
			status: "completed",
			slideCount: 3,
			lastSlide: 2,
		};
		db.insert(schema.artifactTourStates).values(row).run();

		expect(() =>
			db
				.insert(schema.artifactTourStates)
				.values({ ...row, id: "state-2" })
				.run(),
		).toThrow(/UNIQUE constraint failed/);

		// A different content key for the same (user, kind) is a distinct row —
		// this is exactly how a new campaign snapshot re-shows the tour once.
		expect(() =>
			db
				.insert(schema.artifactTourStates)
				.values({ ...row, id: "state-3", contentKey: "default:2" })
				.run(),
		).not.toThrow();
	});

	it("cascades the row when the user is deleted", () => {
		db.insert(schema.artifactTourStates)
			.values({
				id: "state-1",
				userId: "user-1",
				artifactType: "canvas",
				contentKey: "default:1",
				status: "completed",
				slideCount: 3,
				lastSlide: 2,
			})
			.run();

		db.delete(schema.users).where(eq(schema.users.id, "user-1")).run();

		expect(db.select().from(schema.artifactTourStates).all()).toHaveLength(0);
	});
});

describe("parseArtifactTourSeenBody", () => {
	const valid = { contentKey: "default:1", status: "completed", lastSlide: 2 };

	it("accepts a completion and a dismissal at any slide of three", () => {
		for (const lastSlide of [0, 1, 2]) {
			for (const status of ["completed", "dismissed"] as const) {
				expect(
					parseArtifactTourSeenBody({ ...valid, status, lastSlide }),
				).toEqual({
					ok: true,
					value: { contentKey: "default:1", status, lastSlide },
				});
			}
		}
	});

	it("names every field that is wrong", () => {
		expect(parseArtifactTourSeenBody({})).toEqual({
			ok: false,
			fieldErrors: {
				contentKey: "invalid",
				status: "invalid",
				lastSlide: "invalid",
			},
		});
		expect(parseArtifactTourSeenBody({ ...valid, status: "seen" })).toEqual({
			ok: false,
			fieldErrors: { status: "invalid" },
		});
		expect(parseArtifactTourSeenBody({ ...valid, contentKey: "" })).toEqual({
			ok: false,
			fieldErrors: { contentKey: "invalid" },
		});
		expect(parseArtifactTourSeenBody({ ...valid, contentKey: 7 })).toEqual({
			ok: false,
			fieldErrors: { contentKey: "invalid" },
		});
	});

	it("refuses a slide index that is not a whole number inside the tour", () => {
		for (const lastSlide of [-1, 3, 1.5, Number.NaN, "1", null, undefined]) {
			expect(parseArtifactTourSeenBody({ ...valid, lastSlide })).toEqual({
				ok: false,
				fieldErrors: { lastSlide: "invalid" },
			});
		}
	});

	it("refuses a body that is not an object, with every field named", () => {
		for (const body of [null, undefined, "x", 4, [], true]) {
			expect(parseArtifactTourSeenBody(body)).toEqual({
				ok: false,
				fieldErrors: {
					contentKey: "invalid",
					status: "invalid",
					lastSlide: "invalid",
				},
			});
		}
	});

	it("drops every field it was not asked for, so none can reach a row", () => {
		const parsed = parseArtifactTourSeenBody({
			...valid,
			conversationId: "conv-1",
			artifactId: "artifact-1",
			userId: "someone-else",
		});
		expect(parsed).toEqual({
			ok: true,
			value: { contentKey: "default:1", status: "completed", lastSlide: 2 },
		});
	});
});
