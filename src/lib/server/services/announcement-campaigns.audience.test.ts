import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	archiveCampaign,
	completeCampaignForUser,
	FEATURE_NOTE_MAX_IMPRESSIONS,
	getEligibleCampaignForUser,
	getEligibleFeatureNoteForUser,
	getLatestPublishedAnnouncement,
	recordCampaignEvent,
} from "./announcement-campaigns";
import {
	buildFeatureNoteSlide,
	buildFirstRunOnboardingImageFreeSlides,
	publishFeatureNoteCampaign,
	publishFirstRunOnboardingCampaign,
	publishReleaseUpdateCampaign,
} from "./announcement-campaigns.test-helpers";

// Who is shown which announcement (owner, 2026-10-13). The welcome belongs to
// an account that has never been through one: a new revision, or an old one
// archived, reaches nobody who finished or skipped a welcome. A release update
// belongs to every account that was here when it came out and has not seen it:
// finishing a welcome never consumes it, and an account made after it was
// published is not handed it (the welcome was that account's introduction).
// The version badge opens the release.

const DAY_MS = 86_400_000;
// One instant for the whole file: every date below is counted back from it, so
// "made a second before it was published" cannot straddle a clock second.
const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS);

describe("who is shown which announcement", () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		db.insert(schema.users)
			.values([
				{
					id: "admin-user",
					email: "admin@example.com",
					passwordHash: "hash",
					role: "admin",
				},
				// An account that was here long before anything below is published.
				{
					id: "veteran",
					email: "veteran@example.com",
					passwordHash: "hash",
					createdAt: daysAgo(60),
				},
				// An account made after the release below was published (a day ago).
				{
					id: "newcomer",
					email: "newcomer@example.com",
					passwordHash: "hash",
					createdAt: daysAgo(1),
				},
			])
			.run();
	});

	afterEach(() => {
		sqlite.close();
	});

	/** A published welcome; `ago` is how many days ago it was published. */
	async function publishWelcome(id: string, ago: number) {
		const campaign = await publishFirstRunOnboardingCampaign(db, {
			campaignId: id,
			snapshotIds: [`${id}-snapshot`, `${id}-snap-1`, `${id}-snap-2`],
			name: id,
			slides: buildFirstRunOnboardingImageFreeSlides({
				setup: { id: `${id}-setup` },
				disclosure: { id: `${id}-disclosure` },
			}),
		});
		backdate(id, ago);
		return campaign;
	}

	/** A published release update; `ago` is how many days ago it was published. */
	async function publishRelease(id: string, ago: number, version = "2.2.0") {
		const campaign = await publishReleaseUpdateCampaign(db, {
			campaignId: id,
			name: id,
			releaseVersion: version,
		});
		backdate(id, ago);
		return campaign;
	}

	/** Says plainly when a campaign was published, on the row and on its snapshot. */
	function backdate(campaignId: string, ago: number) {
		const publishedAt = daysAgo(ago);
		db.update(schema.announcementCampaigns)
			.set({ publishedAt })
			.where(eq(schema.announcementCampaigns.id, campaignId))
			.run();
		db.update(schema.announcementCampaignSnapshots)
			.set({ publishedAt })
			.where(eq(schema.announcementCampaignSnapshots.campaignId, campaignId))
			.run();
	}

	function bornAt(userId: string, createdAt: Date) {
		db.update(schema.users)
			.set({ createdAt })
			.where(eq(schema.users.id, userId))
			.run();
	}

	const eligible = (userId: string) =>
		getEligibleCampaignForUser(userId, { db });
	const finish = (campaignId: string, userId: string) =>
		completeCampaignForUser(campaignId, userId, "completed", { db });
	const skip = (campaignId: string, userId: string) =>
		completeCampaignForUser(campaignId, userId, "skipped", { db });

	describe("a first-run welcome belongs to an account that has never been through one", () => {
		it("is shown until the account finishes it, and then never again", async () => {
			const welcome = await publishWelcome("welcome-1", 5);

			expect((await eligible("newcomer"))?.id).toBe(welcome.id);
			// Not finished (a closed tab) is not seen through: it comes back.
			expect((await eligible("newcomer"))?.id).toBe(welcome.id);

			await finish(welcome.id, "newcomer");
			expect(await eligible("newcomer")).toBeNull();
		});

		it("is not shown to an account that finished the old one when a new one replaces it", async () => {
			const old = await publishWelcome("welcome-old", 30);
			await finish(old.id, "veteran");

			// The owner's move: the old welcome archived, a new one published.
			await archiveCampaign(old.id, { db });
			await publishWelcome("welcome-new", 0);

			expect(await eligible("veteran")).toBeNull();
		});

		it("is not shown to an account that only skipped the old one either", async () => {
			const old = await publishWelcome("welcome-old", 30);
			await skip(old.id, "veteran");
			await archiveCampaign(old.id, { db });
			await publishWelcome("welcome-new", 0);

			expect(await eligible("veteran")).toBeNull();
		});

		it("is not shown to such an account while the old one is still published beside the new one", async () => {
			const old = await publishWelcome("welcome-old", 30);
			await finish(old.id, "veteran");
			await publishWelcome("welcome-new", 0);

			expect(await eligible("veteran")).toBeNull();
		});

		it("shows an account that has never been through a welcome the latest one, not the archived one", async () => {
			const old = await publishWelcome("welcome-old", 30);
			await archiveCampaign(old.id, { db });
			const current = await publishWelcome("welcome-new", 0);

			expect((await eligible("newcomer"))?.id).toBe(current.id);
		});

		it("shows the very first welcome to an account that has not been through any, however old the account", async () => {
			const first = await publishWelcome("welcome-first", 0);

			expect((await eligible("veteran"))?.id).toBe(first.id);
		});

		it("finishing one welcome does not touch what another account is shown", async () => {
			const welcome = await publishWelcome("welcome-1", 5);
			await finish(welcome.id, "veteran");

			expect((await eligible("newcomer"))?.id).toBe(welcome.id);
		});
	});

	describe("a release update belongs to every account that was here when it came out", () => {
		it("is shown to an account that has not seen it, and never again once it has", async () => {
			const release = await publishRelease("release-1", 10);

			expect((await eligible("veteran"))?.id).toBe(release.id);

			await finish(release.id, "veteran");
			expect(await eligible("veteran")).toBeNull();
		});

		for (const leave of ["finishes", "skips"] as const) {
			for (const order of ["welcome first", "release first"] as const) {
				it(`is still shown to an account that was here before it, after the account ${leave} a welcome (${order})`, async () => {
					let welcome: Awaited<ReturnType<typeof publishWelcome>>;
					if (order === "welcome first") {
						welcome = await publishWelcome("welcome-1", 12);
						await publishRelease("release-1", 10);
					} else {
						await publishRelease("release-1", 12);
						welcome = await publishWelcome("welcome-1", 10);
					}

					// One card at a time: the welcome, and the release behind it.
					expect((await eligible("veteran"))?.id).toBe(welcome.id);
					if (leave === "finishes") await finish(welcome.id, "veteran");
					else await skip(welcome.id, "veteran");

					expect((await eligible("veteran"))?.id).toBe("release-1");
				});
			}
		}

		it("is not shown to an account made after it was published, before or after its welcome", async () => {
			await publishRelease("release-1", 10);
			// "newcomer" was made a day ago, nine days after the release.
			expect(await eligible("newcomer")).toBeNull();

			const welcome = await publishWelcome("welcome-1", 0);
			expect((await eligible("newcomer"))?.id).toBe(welcome.id);

			await finish(welcome.id, "newcomer");
			expect(await eligible("newcomer")).toBeNull();
		});

		it("is shown to an account that was made a second before it was published", async () => {
			const release = await publishRelease("release-1", 10);
			bornAt("newcomer", new Date(daysAgo(10).getTime() - 1000));

			expect((await eligible("newcomer"))?.id).toBe(release.id);
		});

		it("is not shown to an account made in the very second it was published", async () => {
			await publishRelease("release-1", 10);
			bornAt("newcomer", daysAgo(10));

			expect(await eligible("newcomer")).toBeNull();
		});

		it("still reaches an account that has already finished the new welcome (2.2: the owner's account)", async () => {
			const old = await publishWelcome("welcome-old", 40);
			await finish(old.id, "veteran");
			await archiveCampaign(old.id, { db });
			const welcome = await publishWelcome("welcome-22", 0);
			await publishRelease("release-22", 0);

			// Shown the new welcome once, before this rule: it must not cost the release.
			await finish(welcome.id, "veteran");

			expect((await eligible("veteran"))?.id).toBe("release-22");
		});

		it("offers only the latest release, and does not queue the ones before it", async () => {
			await publishRelease("release-1", 20, "2.0.0");
			const latest = await publishRelease("release-2", 10, "2.2.0");

			expect((await eligible("veteran"))?.id).toBe(latest.id);
			await finish(latest.id, "veteran");
			expect(await eligible("veteran")).toBeNull();
		});

		it("offers an account that saw an older release the newer one", async () => {
			const older = await publishRelease("release-1", 20, "2.0.0");
			await finish(older.id, "veteran");
			const newer = await publishRelease("release-2", 10, "2.2.0");

			expect((await eligible("veteran"))?.id).toBe(newer.id);
		});
	});

	describe("a feature note is for accounts that were here before it", () => {
		/** A published feature note; `ago` is how many days ago it was published. */
		async function publishNote(
			id: string,
			ago: number,
			action?: { destination: string; label: { en: string; hu: string } },
		) {
			const campaign = await publishFeatureNoteCampaign(db, {
				campaignId: id,
				name: id,
				slides: [
					buildFeatureNoteSlide(id, {
						actionDestination: action?.destination ?? null,
						...(action ? { actionLabel: action.label } : {}),
					}),
				],
			});
			backdate(id, ago);
			return campaign;
		}

		/** Drizzle reads a timestamp column back in whole seconds. */
		const inSeconds = (date: Date) =>
			new Date(Math.floor(date.getTime() / 1000) * 1000);

		const noteFor = (userId: string) =>
			getEligibleFeatureNoteForUser(userId, { db });

		async function showNote(campaignId: string, userId: string, times: number) {
			for (let index = 0; index < times; index += 1) {
				await recordCampaignEvent(
					{ campaignId, userId, eventType: "auto_shown" },
					{ db },
				);
			}
		}

		it("maps its one note slide to the reader's note", async () => {
			await publishNote("note-1", 5);

			expect(await noteFor("veteran")).toMatchObject({
				id: "note-1",
				name: "note-1",
				snapshotId: "note-1-snapshot",
				title: {
					en: "Two-factor authentication",
					hu: "Kétfaktoros hitelesítés",
				},
				body: {
					en: "Add a second step to signing in.",
					hu: "Adj egy második lépést a belépéshez.",
				},
				actionLabel: { en: "", hu: "" },
				actionDestination: null,
				publishedAt: inSeconds(daysAgo(5)),
			});
		});

		it("maps the optional action when the note has one", async () => {
			await publishNote("note-action", 5, {
				destination: "/settings",
				label: { en: "Open settings", hu: "Beállítások megnyitása" },
			});

			expect(await noteFor("veteran")).toMatchObject({
				actionLabel: {
					en: "Open settings",
					hu: "Beállítások megnyitása",
				},
				actionDestination: "/settings",
			});
		});

		it("is not offered to an account made after it was published", async () => {
			await publishNote("note-1", 5);

			// "newcomer" was made a day ago, four days after the note.
			expect(await noteFor("newcomer")).toBeNull();
		});

		for (const reason of ["skipped", "completed"] as const) {
			it(`stops for good when the reader leaves it (${reason})`, async () => {
				await publishNote("note-1", 5);
				await (reason === "skipped"
					? skip("note-1", "veteran")
					: finish("note-1", "veteran"));

				expect(await noteFor("veteran")).toBeNull();
				// Another reader who was here before it is untouched.
				bornAt("newcomer", daysAgo(60));
				expect((await noteFor("newcomer"))?.id).toBe("note-1");
			});
		}

		it("allows the fourth showing and returns nothing from the fifth eligibility read", async () => {
			await publishNote("note-1", 5);

			await showNote("note-1", "veteran", 3);
			expect((await noteFor("veteran"))?.id).toBe("note-1");

			await showNote("note-1", "veteran", 1);
			expect(await noteFor("veteran")).toBeNull();
			expect(FEATURE_NOTE_MAX_IMPRESSIONS).toBe(4);
		});

		it("starts a newly published note at zero showings", async () => {
			await publishNote("note-1", 5);
			await showNote("note-1", "veteran", 4);
			expect(await noteFor("veteran")).toBeNull();

			const next = await publishNote("note-2", 0);

			expect((await noteFor("veteran"))?.id).toBe(next.id);
		});

		it("returns nothing when its one slide is missing", async () => {
			await publishNote("note-1", 5);
			db.delete(schema.announcementCampaignSnapshotSlides)
				.where(
					eq(schema.announcementCampaignSnapshotSlides.campaignId, "note-1"),
				)
				.run();

			expect(await noteFor("veteran")).toBeNull();
		});

		it("returns nothing when its published slide is not a standard feature", async () => {
			await publishNote("note-1", 5);
			db.update(schema.announcementCampaignSnapshotSlides)
				.set({ semanticRole: "data_disclosure" })
				.where(
					eq(schema.announcementCampaignSnapshotSlides.campaignId, "note-1"),
				)
				.run();

			expect(await noteFor("veteran")).toBeNull();
		});

		it("returns nothing when its snapshot holds more than one slide", async () => {
			await publishNote("note-1", 5);
			db.insert(schema.announcementCampaignSnapshotSlides)
				.values({
					id: "note-1-extra-slide",
					snapshotId: "note-1-snapshot",
					campaignId: "note-1",
					layoutType: "standard",
					semanticRole: "feature",
					sortOrder: 2,
					titleEn: "Extra",
					titleHu: "Extra",
					bodyEn: "Extra body",
					bodyHu: "Extra törzs",
					altTextEn: "",
					altTextHu: "",
				})
				.run();

			expect(await noteFor("veteran")).toBeNull();
		});

		it("counts showings for the live snapshot, not for another snapshot of the same campaign", async () => {
			await publishNote("note-1", 5);
			// A campaign publishes one snapshot; this one is older and must not
			// become the snapshot the reader is shown, nor contribute its events.
			db.insert(schema.announcementCampaignSnapshots)
				.values({
					id: "note-1-old-snapshot",
					campaignId: "note-1",
					identityKey: "feature_note:v1:r0-old",
					type: "feature_note",
					name: "note-1",
					campaignVersion: "v1",
					revision: 0,
					publishedAt: daysAgo(6),
				})
				.run();
			for (let index = 0; index < FEATURE_NOTE_MAX_IMPRESSIONS; index += 1) {
				db.insert(schema.announcementCampaignEvents)
					.values({
						id: `note-1-old-show-${index}`,
						userId: "veteran",
						campaignId: "note-1",
						snapshotId: "note-1-old-snapshot",
						eventType: "auto_shown",
					})
					.run();
			}

			expect((await noteFor("veteran"))?.id).toBe("note-1");
		});

		for (const destination of [
			"internal:chatgpt-import",
			"https://example.com",
		] as const) {
			it(`drops an action destination that is no longer safe (${destination})`, async () => {
				await publishNote("note-action", 5, {
					destination: "/settings",
					label: { en: "Open settings", hu: "Beállítások megnyitása" },
				});
				db.update(schema.announcementCampaignSnapshotSlides)
					.set({ actionDestination: destination })
					.where(
						eq(
							schema.announcementCampaignSnapshotSlides.campaignId,
							"note-action",
						),
					)
					.run();

				const note = await noteFor("veteran");
				expect(note?.actionDestination).toBeNull();
				expect(note?.actionLabel).toEqual({
					en: "Open settings",
					hu: "Beállítások megnyitása",
				});
			});
		}

		it("returns nothing once the live note is archived, and never resurrects the one it replaced", async () => {
			await publishNote("note-1", 10);
			await publishNote("note-2", 5);
			await archiveCampaign("note-2", { db });

			expect(await noteFor("veteran")).toBeNull();
		});

		it("is neither what the campaign modal opens nor what the version badge replays", async () => {
			await publishNote("note-1", 5);

			expect(await eligible("veteran")).toBeNull();
			expect(await getLatestPublishedAnnouncement({ db })).toBeNull();
		});

		it("leaves a release update as the campaign the shell opens", async () => {
			await publishNote("note-1", 5);
			await publishRelease("release-1", 10);

			expect((await eligible("veteran"))?.id).toBe("release-1");
			expect((await noteFor("veteran"))?.id).toBe("note-1");
		});
	});

	describe("the version badge", () => {
		it("opens the latest release update, even when a welcome was published after it", async () => {
			await publishRelease("release-1", 10);
			await publishWelcome("welcome-1", 0);

			expect((await getLatestPublishedAnnouncement({ db }))?.id).toBe(
				"release-1",
			);
		});

		it("opens the newest release when several are published", async () => {
			await publishRelease("release-1", 10, "2.0.0");
			await publishRelease("release-2", 5, "2.2.0");
			await publishWelcome("welcome-1", 0);

			expect((await getLatestPublishedAnnouncement({ db }))?.id).toBe(
				"release-2",
			);
		});

		it("opens the welcome when no release update has been published", async () => {
			await publishWelcome("welcome-1", 3);

			expect((await getLatestPublishedAnnouncement({ db }))?.id).toBe(
				"welcome-1",
			);
		});

		it("opens nothing before anything is published", async () => {
			expect(await getLatestPublishedAnnouncement({ db })).toBeNull();
		});
	});
});
