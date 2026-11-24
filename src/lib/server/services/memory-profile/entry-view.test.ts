import { describe, expect, it } from "vitest";
import { groupFactsById, memoryEntryView } from "./entry-view";
import type { FactLabels } from "./fact-labels";

const THRESHOLDS = {
	temporaryEarlierDays: 21,
	ongoingQuietDays: 21,
	ongoingEarlierDays: 90,
};
const NOW = new Date("2026-11-24T12:00:00Z");

function fact(id: string, said: string, eventId = `message:${id}`) {
	return {
		id,
		text: `Synthetic fact ${id}`,
		source: {
			assertedAt: new Date(said),
			explicitEditAt: null,
			eventId,
			context: "",
		},
	};
}
function labels(
	entries: Record<string, Partial<FactLabels>>,
): Map<string, FactLabels> {
	return new Map(
		Object.entries(entries).map(([id, value]) => [
			id,
			{
				kind: null,
				subject: null,
				eventAt: null,
				origin: "extraction",
				...value,
			},
		]),
	);
}

describe("one entry as recall and the Memory page read it", () => {
	it("an entry takes its newest fact's labels and last mention", () => {
		const facts = [fact("f1", "2026-11-01"), fact("f2", "2026-11-10")];
		const view = memoryEntryView(
			{
				sourceIds: ["f1", "f2"],
				factsById: groupFactsById(facts),
				labels: labels({
					f1: { kind: "temporary", subject: "health" },
					f2: { kind: "lasting", subject: "about_you" },
				}),
			},
			NOW,
			THRESHOLDS,
		);
		expect(view).toEqual({
			kind: "lasting",
			subject: "about_you",
			lastMentionedAt: new Date("2026-11-10").toISOString(),
			timeState: "current",
			authored: false,
		});
	});

	it("a temporary entry past its threshold is Earlier", () => {
		const view = memoryEntryView(
			{
				sourceIds: ["f1"],
				factsById: groupFactsById([fact("f1", "2026-10-01")]),
				labels: labels({ f1: { kind: "temporary", subject: "health" } }),
			},
			NOW,
			THRESHOLDS,
		);
		expect(view.timeState).toBe("earlier");
	});

	it("a person-written entry never ages", () => {
		const view = memoryEntryView(
			{
				sourceIds: ["f1"],
				factsById: groupFactsById([fact("f1", "2026-01-01", "manual:add")]),
				labels: labels({ f1: { kind: "temporary", subject: "health" } }),
			},
			NOW,
			THRESHOLDS,
		);
		expect(view).toMatchObject({ authored: true, timeState: "current" });
	});

	it("an id the facts do not hold is ignored", () => {
		const view = memoryEntryView(
			{
				sourceIds: ["missing", 5, "f1"],
				factsById: groupFactsById([fact("f1", "2026-11-20")]),
				labels: labels({ f1: { kind: "ongoing", subject: "projects" } }),
			},
			NOW,
			THRESHOLDS,
		);
		expect(view).toMatchObject({
			kind: "ongoing",
			subject: "projects",
			lastMentionedAt: new Date("2026-11-20").toISOString(),
			timeState: "current",
		});
	});

	it("an entry with no labelled fact reads as lasting and never ages", () => {
		const view = memoryEntryView(
			{
				sourceIds: ["f1"],
				factsById: groupFactsById([fact("f1", "2024-01-01")]),
				labels: new Map(),
			},
			NOW,
			THRESHOLDS,
		);
		expect(view).toMatchObject({
			kind: null,
			subject: null,
			timeState: "current",
		});
	});
});
