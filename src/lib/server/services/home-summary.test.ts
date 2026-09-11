import { describe, expect, it } from "vitest";
import {
	bucketWeeklyCounts,
	HOME_SUMMARY_CACHE_MAX_ENTRIES,
	isoWeekLabel,
	isoWeekStart,
	resolveFileJobPhase,
	resolveRunningJobPhase,
	storeBoundedSummary,
} from "./home-summary";

const BUDAPEST = "Europe/Budapest";
const UTC = "UTC";
// A zone west of UTC whose local Monday starts *after* the UTC one, which is
// where a naive UTC bucketing visibly disagrees with a zoned one.
const LOS_ANGELES = "America/Los_Angeles";
// A half-hour offset, because an implementation that only ever corrects by
// whole hours passes every European test and fails here.
const KOLKATA = "Asia/Kolkata";

function iso(value: string): Date {
	return new Date(value);
}

describe("isoWeekStart", () => {
	it("returns the Monday midnight of the week an instant falls in", () => {
		// Thursday 2026-09-10 14:00 Budapest -> Monday 2026-09-07 00:00 Budapest
		// which is 2026-09-06T22:00Z (CEST, UTC+2).
		const start = isoWeekStart(iso("2026-09-10T12:00:00Z"), BUDAPEST);
		expect(start.toISOString()).toBe("2026-09-06T22:00:00.000Z");
	});

	it("keeps a Sunday-night instant in the week that is ending", () => {
		// 2026-09-13 is a Sunday. 23:30 local is still week 37, not week 38.
		const sundayLate = isoWeekStart(iso("2026-09-13T21:30:00Z"), BUDAPEST);
		const thursday = isoWeekStart(iso("2026-09-10T12:00:00Z"), BUDAPEST);
		expect(sundayLate.toISOString()).toBe(thursday.toISOString());
	});

	it("starts the next week at local Monday midnight, not UTC midnight", () => {
		// 2026-09-13T22:30Z is Monday 00:30 in Budapest — a new week locally
		// while UTC still says Sunday.
		const start = isoWeekStart(iso("2026-09-13T22:30:00Z"), BUDAPEST);
		expect(start.toISOString()).toBe("2026-09-13T22:00:00.000Z");
	});

	it("draws the boundary in the given zone, not in UTC", () => {
		const instant = iso("2026-09-14T04:00:00Z"); // Mon 06:00 CEST / Sun 21:00 PDT
		expect(isoWeekStart(instant, BUDAPEST).toISOString()).toBe(
			"2026-09-13T22:00:00.000Z",
		);
		// In Los Angeles that same instant is still Sunday, so the week started
		// a full seven days earlier.
		expect(isoWeekStart(instant, LOS_ANGELES).toISOString()).toBe(
			"2026-09-07T07:00:00.000Z",
		);
	});

	it("handles a half-hour offset zone", () => {
		// Mon 2026-09-14 00:15 IST = Sun 2026-09-13 18:45Z.
		const start = isoWeekStart(iso("2026-09-13T18:45:00Z"), KOLKATA);
		expect(start.toISOString()).toBe("2026-09-13T18:30:00.000Z");
	});

	it("lands on local midnight across a DST transition inside the week", () => {
		// Europe/Budapest falls back on Sunday 2026-10-25. A Saturday instant in
		// that week must still resolve to Monday 2026-10-19 00:00 CEST.
		const start = isoWeekStart(iso("2026-10-24T10:00:00Z"), BUDAPEST);
		expect(start.toISOString()).toBe("2026-10-18T22:00:00.000Z");
		// And the week AFTER the change starts at 00:00 CET, an hour later in UTC.
		const after = isoWeekStart(iso("2026-10-28T10:00:00Z"), BUDAPEST);
		expect(after.toISOString()).toBe("2026-10-25T23:00:00.000Z");
	});

	it("is idempotent", () => {
		const once = isoWeekStart(iso("2026-09-10T12:00:00Z"), BUDAPEST);
		expect(isoWeekStart(once, BUDAPEST).toISOString()).toBe(once.toISOString());
	});
});

describe("isoWeekLabel", () => {
	it("labels the week by the year its Thursday falls in", () => {
		expect(
			isoWeekLabel(isoWeekStart(iso("2026-09-10T12:00:00Z"), UTC), UTC),
		).toBe("2026-W37");
	});

	it("gives 2026-W53 to the week straddling new year, not 2027-W01", () => {
		// 2026-12-31 is a Thursday, so the week of 2026-12-28 is 2026's W53 and
		// carries days that fall in 2027.
		expect(
			isoWeekLabel(isoWeekStart(iso("2027-01-02T12:00:00Z"), UTC), UTC),
		).toBe("2026-W53");
	});

	// 2026 opens ON a Thursday, which is the one shape where reaching the
	// week's Thursday by adding three times 86,400,000ms instead of three
	// calendar days would shift every week number in the year down by one if
	// an hour were ever given back mid-week. Pin the ends and the seam.
	it("numbers a year that opens on a Thursday from its first day", () => {
		expect(
			isoWeekLabel(isoWeekStart(iso("2026-01-01T12:00:00Z"), UTC), UTC),
		).toBe("2026-W01");
		expect(
			isoWeekLabel(isoWeekStart(iso("2026-01-05T12:00:00Z"), UTC), UTC),
		).toBe("2026-W02");
		expect(
			isoWeekLabel(isoWeekStart(iso("2026-12-27T12:00:00Z"), UTC), UTC),
		).toBe("2026-W52");
	});

	it("walks a whole year of weeks without repeating or skipping one", () => {
		const seen: string[] = [];
		for (let week = 0; week < 52; week += 1) {
			const instant = iso("2026-01-07T12:00:00Z");
			instant.setUTCDate(instant.getUTCDate() + week * 7);
			seen.push(isoWeekLabel(isoWeekStart(instant, BUDAPEST), BUDAPEST));
		}
		expect(new Set(seen).size).toBe(52);
		expect(seen[0]).toBe("2026-W02");
		expect(seen.at(-1)).toBe("2026-W53");
	});
});

describe("bucketWeeklyCounts", () => {
	const now = iso("2026-09-10T12:00:00Z"); // Thursday of 2026-W37

	it("returns twelve consecutive weeks ending with the current one", () => {
		const buckets = bucketWeeklyCounts({
			timestampsMs: [],
			now,
			timeZone: BUDAPEST,
		});
		expect(buckets).toHaveLength(12);
		expect(buckets.at(-1)?.isoWeek).toBe("2026-W37");
		expect(buckets[0]?.isoWeek).toBe("2026-W26");
		for (let i = 1; i < buckets.length; i += 1) {
			const gap =
				(buckets[i]?.startedAt ?? 0) - (buckets[i - 1]?.startedAt ?? 0);
			// Exactly one week apart, give or take the hour a DST change moves.
			expect([604_800, 601_200, 608_400]).toContain(gap);
		}
	});

	it("counts a turn into the week it happened in", () => {
		const buckets = bucketWeeklyCounts({
			timestampsMs: [
				iso("2026-09-10T08:00:00Z").getTime(), // this week
				iso("2026-09-09T08:00:00Z").getTime(), // this week
				iso("2026-09-03T08:00:00Z").getTime(), // last week
			],
			now,
			timeZone: BUDAPEST,
		});
		expect(buckets.at(-1)?.count).toBe(2);
		expect(buckets.at(-2)?.count).toBe(1);
	});

	it("keeps an empty week as a zero bucket rather than dropping it", () => {
		const buckets = bucketWeeklyCounts({
			timestampsMs: [iso("2026-09-10T08:00:00Z").getTime()],
			now,
			timeZone: BUDAPEST,
		});
		expect(buckets).toHaveLength(12);
		expect(buckets.slice(0, 11).every((bucket) => bucket.count === 0)).toBe(
			true,
		);
	});

	it("returns all-zero buckets for a user with no turns at all", () => {
		const buckets = bucketWeeklyCounts({
			timestampsMs: [],
			now,
			timeZone: BUDAPEST,
		});
		expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
		expect(buckets).toHaveLength(12);
	});

	it("ignores turns older than the twelve-week window", () => {
		const buckets = bucketWeeklyCounts({
			timestampsMs: [iso("2026-01-01T08:00:00Z").getTime()],
			now,
			timeZone: BUDAPEST,
		});
		expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(0);
	});

	it("puts a boundary turn on the correct side in the reporting zone", () => {
		// Monday 2026-09-07 00:30 Budapest = 2026-09-06T22:30Z. In Budapest that
		// opens the CURRENT week (W37); in UTC it is still the Sunday before, so
		// it lands in the previous bucket. Same instant, different bar.
		const timestampsMs = [iso("2026-09-06T22:30:00Z").getTime()];
		const budapest = bucketWeeklyCounts({
			timestampsMs,
			now,
			timeZone: BUDAPEST,
		});
		const utc = bucketWeeklyCounts({ timestampsMs, now, timeZone: UTC });
		expect(budapest.at(-1)?.count).toBe(1);
		expect(budapest.at(-2)?.count).toBe(0);
		expect(utc.at(-1)?.count).toBe(0);
		expect(utc.at(-2)?.count).toBe(1);
	});

	it("counts an instant on the exact week boundary into the new week", () => {
		const start = isoWeekStart(now, BUDAPEST);
		const buckets = bucketWeeklyCounts({
			timestampsMs: [start.getTime()],
			now,
			timeZone: BUDAPEST,
		});
		expect(buckets.at(-1)?.count).toBe(1);
	});

	it("honours a custom week count", () => {
		expect(
			bucketWeeklyCounts({
				timestampsMs: [],
				now,
				timeZone: BUDAPEST,
				weeks: 4,
			}),
		).toHaveLength(4);
	});

	it("does not lose a week across a DST transition in the window", () => {
		const buckets = bucketWeeklyCounts({
			timestampsMs: [],
			now: iso("2026-11-05T12:00:00Z"),
			timeZone: BUDAPEST,
		});
		expect(buckets).toHaveLength(12);
		expect(new Set(buckets.map((bucket) => bucket.isoWeek)).size).toBe(12);
	});
});

describe("resolveRunningJobPhase", () => {
	it("reads the phase out of progress details, not the stage column", () => {
		// A v2/v3 job that is writing while `stage` still says it was curating.
		expect(
			resolveRunningJobPhase({
				status: "running",
				stage: "curate",
				progressDetailsJson: JSON.stringify({
					pipelineVersion: 2,
					phase: "write",
				}),
				locale: "en",
			}),
		).toBe("Writing");
	});

	it("maps every v2 phase to an existing label", () => {
		const phases = ["plan", "research", "index", "write", "verify", "render"];
		for (const phase of phases) {
			const label = resolveRunningJobPhase({
				status: "running",
				stage: null,
				progressDetailsJson: JSON.stringify({ phase }),
				locale: "en",
			});
			expect(label).not.toBe("Running research");
			expect(label.length).toBeGreaterThan(0);
		}
	});

	it("maps the v3-only phases onto the nearest existing label", () => {
		const cases: Array<[string, string]> = [
			["ask", "Planning"],
			["outline", "Planning"],
			["answer", "Writing"],
			["critic", "Verifying"],
		];
		for (const [phase, expected] of cases) {
			expect(
				resolveRunningJobPhase({
					status: "running",
					stage: null,
					progressDetailsJson: JSON.stringify({ pipelineVersion: 3, phase }),
					locale: "en",
				}),
			).toBe(expected);
		}
	});

	it("falls back to the v1 stage column when details carry no phase", () => {
		expect(
			resolveRunningJobPhase({
				status: "running",
				stage: "curate",
				progressDetailsJson: JSON.stringify({ queries: ["a", "b"] }),
				locale: "en",
			}),
		).toBe("Curating sources");
		expect(
			resolveRunningJobPhase({
				status: "running",
				stage: "gap-fill",
				progressDetailsJson: "{}",
				locale: "en",
			}),
		).toBe("Filling evidence gaps");
	});

	it("says Queued for a queued job whatever the details claim", () => {
		expect(
			resolveRunningJobPhase({
				status: "queued",
				stage: "decompose",
				progressDetailsJson: JSON.stringify({ phase: "write" }),
				locale: "en",
			}),
		).toBe("Queued");
	});

	it("survives unparseable or absent details", () => {
		expect(
			resolveRunningJobPhase({
				status: "running",
				stage: null,
				progressDetailsJson: "{not json",
				locale: "en",
			}),
		).toBe("Running research");
		expect(
			resolveRunningJobPhase({
				status: "running",
				stage: null,
				progressDetailsJson: null,
				locale: "en",
			}),
		).toBe("Running research");
	});

	it("ignores a phase name no pipeline uses", () => {
		expect(
			resolveRunningJobPhase({
				status: "running",
				stage: "audit",
				progressDetailsJson: JSON.stringify({ phase: "teleport" }),
				locale: "en",
			}),
		).toBe("Auditing claims");
	});

	it("translates", () => {
		expect(
			resolveRunningJobPhase({
				status: "running",
				stage: null,
				progressDetailsJson: JSON.stringify({ phase: "research" }),
				locale: "hu",
			}),
		).toBe("Kutatás");
	});
});

describe("resolveFileJobPhase", () => {
	it("says Queued while waiting and Rendering while running", () => {
		expect(resolveFileJobPhase({ status: "queued", locale: "en" })).toBe(
			"Queued",
		);
		expect(resolveFileJobPhase({ status: "running", locale: "en" })).toBe(
			"Rendering",
		);
		expect(resolveFileJobPhase({ status: "running", locale: "hu" })).toBe(
			"Fájlok készítése",
		);
	});
});

describe("storeBoundedSummary — the 30-second cache stays a cache", () => {
	function entry(expiresAt: number) {
		return { expiresAt };
	}

	it("keeps an entry per user and reads it back", () => {
		const cache = new Map<string, { expiresAt: number }>();
		storeBoundedSummary(cache, "a", entry(1_000), 0);
		storeBoundedSummary(cache, "b", entry(1_000), 0);
		expect([...cache.keys()]).toEqual(["a", "b"]);
	});

	it("drops entries whose thirty seconds are up", () => {
		const cache = new Map<string, { expiresAt: number }>();
		storeBoundedSummary(cache, "stale", entry(1_000), 0);
		// A second user arriving after the first entry expired sweeps it: an
		// entry going stale has to mean the memory comes back, not just that
		// the value stops being served.
		storeBoundedSummary(cache, "fresh", entry(32_000), 2_000);
		expect([...cache.keys()]).toEqual(["fresh"]);
	});

	it("never holds more than the cap, whatever the user count", () => {
		const cache = new Map<string, { expiresAt: number }>();
		const total = HOME_SUMMARY_CACHE_MAX_ENTRIES + 25;
		for (let index = 0; index < total; index += 1) {
			// Every entry is live, so only the cap can bound this.
			storeBoundedSummary(cache, `user-${index}`, entry(30_000), 0);
		}
		expect(cache.size).toBe(HOME_SUMMARY_CACHE_MAX_ENTRIES);
		// The users evicted are the ones who have not read for longest.
		expect(cache.has("user-0")).toBe(false);
		expect(cache.has(`user-${total - 1}`)).toBe(true);
	});

	it("re-reading moves a user out of the eviction queue", () => {
		const cache = new Map<string, { expiresAt: number }>();
		storeBoundedSummary(cache, "regular", entry(30_000), 0, 3);
		storeBoundedSummary(cache, "b", entry(30_000), 0, 3);
		storeBoundedSummary(cache, "c", entry(30_000), 0, 3);
		storeBoundedSummary(cache, "regular", entry(30_000), 0, 3);
		storeBoundedSummary(cache, "d", entry(30_000), 0, 3);
		expect(cache.has("regular")).toBe(true);
		expect(cache.has("b")).toBe(false);
	});
});
