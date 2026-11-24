import { describe, expect, it } from "vitest";
import { memoryEntryTimeState } from "./entry-time";

const now = new Date("2026-11-23T12:00:00Z");
const daysAgo = (days: number) =>
	new Date(now.getTime() - days * 86_400_000).toISOString();
const thresholds = {
	temporaryEarlierDays: 21,
	ongoingQuietDays: 21,
	ongoingEarlierDays: 90,
};
const entry = (
	kind: "lasting" | "ongoing" | "temporary" | null,
	lastMentionedAt: string | null,
	eventAt: string | null = null,
	authored = false,
) => ({ kind, lastMentionedAt, eventAt, authored });

describe("Earlier, decided at read time", () => {
	it("makes a temporary entry earlier three weeks after it was said", () => {
		expect(
			memoryEntryTimeState(entry("temporary", daysAgo(20)), now, thresholds),
		).toBe("current");
		expect(
			memoryEntryTimeState(entry("temporary", daysAgo(21)), now, thresholds),
		).toBe("earlier");
	});

	it("counts a temporary entry from the later of its mention and its event", () => {
		// An exam said 60 days ago, held 10 days ago: current until 21 days after the exam.
		expect(
			memoryEntryTimeState(
				entry("temporary", daysAgo(60), daysAgo(10)),
				now,
				thresholds,
			),
		).toBe("current");
		expect(
			memoryEntryTimeState(
				entry("temporary", daysAgo(60), daysAgo(22)),
				now,
				thresholds,
			),
		).toBe("earlier");
		// An exam two months away stays current however long ago it was said.
		expect(
			memoryEntryTimeState(
				entry("temporary", daysAgo(300), daysAgo(-60)),
				now,
				thresholds,
			),
		).toBe("current");
		// An event long past does not age an entry said yesterday.
		expect(
			memoryEntryTimeState(
				entry("temporary", daysAgo(1), daysAgo(400)),
				now,
				thresholds,
			),
		).toBe("current");
	});

	it("marks an ongoing entry quiet, then earlier, by its last new fact only", () => {
		expect(
			memoryEntryTimeState(entry("ongoing", daysAgo(20)), now, thresholds),
		).toBe("current");
		expect(
			memoryEntryTimeState(entry("ongoing", daysAgo(21)), now, thresholds),
		).toBe("quiet");
		expect(
			memoryEntryTimeState(entry("ongoing", daysAgo(89)), now, thresholds),
		).toBe("quiet");
		expect(
			memoryEntryTimeState(entry("ongoing", daysAgo(90)), now, thresholds),
		).toBe("earlier");
		// A new fact makes it current again: only its newest mention counts.
		expect(
			memoryEntryTimeState(entry("ongoing", daysAgo(2)), now, thresholds),
		).toBe("current");
	});

	it("never ages a lasting, unlabelled or undated entry", () => {
		for (const kind of ["lasting", null] as const)
			expect(
				memoryEntryTimeState(entry(kind, daysAgo(5000)), now, thresholds),
			).toBe("current");
		for (const kind of ["temporary", "ongoing"] as const) {
			expect(memoryEntryTimeState(entry(kind, null), now, thresholds)).toBe(
				"current",
			);
			expect(
				memoryEntryTimeState(entry(kind, "not a date"), now, thresholds),
			).toBe("current");
		}
	});

	it("never ages an entry the person wrote", () => {
		for (const kind of ["temporary", "ongoing"] as const)
			expect(
				memoryEntryTimeState(
					entry(kind, daysAgo(1000), daysAgo(1000), true),
					now,
					thresholds,
				),
			).toBe("current");
	});

	it("follows the thresholds it is given", () => {
		const short = {
			temporaryEarlierDays: 3,
			ongoingQuietDays: 2,
			ongoingEarlierDays: 5,
		};
		expect(
			memoryEntryTimeState(entry("temporary", daysAgo(3)), now, short),
		).toBe("earlier");
		expect(memoryEntryTimeState(entry("ongoing", daysAgo(2)), now, short)).toBe(
			"quiet",
		);
		expect(memoryEntryTimeState(entry("ongoing", daysAgo(5)), now, short)).toBe(
			"earlier",
		);
	});
});
