import { expect, it } from "vitest";
import type { AdmittedMemoryEvidence } from "$lib/memory-types";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	formatRecalledMemory,
	parseEarlierStates,
	RECALL_EARLIER_NOTE,
	RECALL_TIMES_NOTE,
	recallLineTokens,
} from "./recall-format";

const now = new Date("2026-11-23T12:00:00Z");
const daysAgo = (d: number) =>
	new Date(now.getTime() - d * 86_400_000).toISOString();
const item = (
	text: string,
	lastMentionedAt: string | null,
	kind: "personal" | "project" = "personal",
) =>
	({
		ref: {
			scope: kind === "personal" ? { kind } : { kind, projectId: "p" },
			generation: "g",
			rowId: text,
		},
		text,
		sources: [],
		lastMentionedAt,
	}) as AdmittedMemoryEvidence;

it("says when each entry was last said", () => {
	expect(
		formatRecalledMemory(
			[0, 1, 3, 13, 14, 59, 60, 729, 730].map((d) => item(`d${d}`, daysAgo(d))),
			now,
		),
	).toBe(
		[
			RECALL_TIMES_NOTE,
			"- d0 (said less than a day ago)",
			"- d1 (said 1 day ago)",
			"- d3 (said 3 days ago)",
			"- d13 (said 13 days ago)",
			"- d14 (said 2 weeks ago)",
			"- d59 (said 8 weeks ago)",
			"- d60 (said 2 months ago)",
			"- d729 (said 24 months ago)",
			"- d730 (said 2 years ago)",
		].join("\n"),
	);
});

it("gives an undated entry no age and counts a future date as less than a day", () => {
	expect(
		formatRecalledMemory(
			[
				item("undated", null),
				item("bad", "not a date"),
				item("future", daysAgo(-2)),
			],
			now,
		),
	).toBe(
		`${RECALL_TIMES_NOTE}\n- undated\n- bad\n- future (said less than a day ago)`,
	);
});

it("puts the project's entries after the person's, under their own line", () => {
	expect(
		formatRecalledMemory(
			[
				item("Project A", null, "project"),
				item("Likes tea", null),
				item("Project B", null, "project"),
			],
			now,
		),
	).toBe("- Likes tea\nRemembered for this project:\n- Project A\n- Project B");
});

it("costs each row exactly its recallLineTokens", () => {
	// A timed row brings the note on the times, and an earlier one the note on
	// earlier entries; recall reserves both apart.
	const times = estimateTokenCount(RECALL_TIMES_NOTE);
	const earlierNote = estimateTokenCount(RECALL_EARLIER_NOTE);
	for (const d of [null, 0, 1, 5, 20, 100, 800])
		for (const kind of [null, "lasting", "ongoing", "temporary"] as const)
			for (const timeState of ["current", "quiet", "earlier"] as const)
				for (const states of [
					[],
					[{ text: "Lived in Pecs", saidAt: daysAgo(500) }],
				]) {
					const row = {
						...item("Prefers green tea", d === null ? null : daysAgo(d)),
						kind,
						timeState,
						earlierStates: states,
					};
					const out = formatRecalledMemory([row], now);
					const notes =
						(d === null && !states.length ? 0 : times) +
						(timeState === "earlier" || states.length ? earlierNote : 0);
					expect(estimateTokenCount(out) - notes).toBe(
						recallLineTokens(row, now),
					);
				}
});

it("shows the kind once labelled, and nothing more before labels", () => {
	expect(
		formatRecalledMemory(
			[
				{ ...item("Has an exam", daysAgo(21)), kind: "temporary" },
				{ ...item("Lives in Graz", daysAgo(800)), kind: "lasting" },
				{ ...item("Builds a boat", null), kind: "ongoing" },
				{ ...item("Likes tea", daysAgo(3)), kind: null },
			],
			now,
		).split("\n"),
	).toEqual([
		RECALL_TIMES_NOTE,
		"- Has an exam (temporary, said 3 weeks ago)",
		"- Lives in Graz (lasting, said 2 years ago)",
		"- Builds a boat (ongoing)",
		"- Likes tea (said 3 days ago)",
	]);
});

it("marks an Earlier entry, after a line on what earlier means", () => {
	expect(
		formatRecalledMemory(
			[
				{
					...item("Had a toothache", daysAgo(70)),
					kind: "temporary",
					timeState: "earlier",
				},
				{ ...item("Likes tea", daysAgo(3)), kind: "lasting" },
			],
			now,
		).split("\n"),
	).toEqual([
		RECALL_TIMES_NOTE,
		RECALL_EARLIER_NOTE,
		"- Had a toothache (earlier, temporary, said 2 months ago)",
		"- Likes tea (lasting, said 3 days ago)",
	]);
});

it("lists earlier states under their entry, marked, with when each was said", () => {
	expect(
		formatRecalledMemory(
			[
				{
					...item("Lives in Gyor", daysAgo(30)),
					kind: "lasting",
					earlierStates: [
						{ text: "Lived in Pecs", saidAt: daysAgo(400) },
						{ text: "Lived in Szeged", saidAt: null },
					],
				},
			],
			now,
		).split("\n"),
	).toEqual([
		RECALL_TIMES_NOTE,
		RECALL_EARLIER_NOTE,
		"- Lives in Gyor (lasting, said 4 weeks ago)",
		"  - earlier: Lived in Pecs (said 13 months ago)",
		"  - earlier: Lived in Szeged",
	]);
});

it("writes no line on earlier entries without one", () => {
	const out = formatRecalledMemory(
		[
			{
				...item("Builds a boat", daysAgo(40)),
				kind: "ongoing",
				timeState: "quiet",
			},
			{
				...item("Likes tea", daysAgo(3)),
				kind: "lasting",
				timeState: "current",
			},
		],
		now,
	);
	expect(out).not.toContain(RECALL_EARLIER_NOTE);
	expect(out).toContain("- Builds a boat (ongoing, said 5 weeks ago)");
});

it("reads the earlier states Hindsight writes after an observation's text", () => {
	expect(
		parseEarlierStates(
			"The user lives in Gyor. (2026-03-10 09:15: The user lives in Pecs (near the old town).) (2025-01-02 18:00: The user lives in Szeged.)",
			"The user lives in Gyor.",
		),
	).toEqual([
		{
			text: "The user lives in Pecs (near the old town).",
			saidAt: "2026-03-10T09:15:00.000Z",
		},
		{ text: "The user lives in Szeged.", saidAt: "2025-01-02T18:00:00.000Z" },
	]);
	expect(parseEarlierStates("Same text", "Same text")).toEqual([]);
	expect(parseEarlierStates("Changed text", "Other text")).toEqual([]);
	expect(parseEarlierStates("Text (not a note) here", "Text")).toEqual([]);
});

it("opens timed rows with one line on what the times mean", () => {
	const out = formatRecalledMemory(
		[
			item("Likes tea", daysAgo(400)),
			item("Undated", null),
			item("Project A", daysAgo(3), "project"),
		],
		now,
	);
	const lines = out.split("\n");
	expect(lines[0]).toBe(RECALL_TIMES_NOTE);
	expect(lines.filter((line) => line === RECALL_TIMES_NOTE)).toHaveLength(1);
	expect(lines.slice(1)).toEqual([
		"- Likes tea (said 13 months ago)",
		"- Undated",
		"Remembered for this project:",
		"- Project A (said 3 days ago)",
	]);
});

it("writes no line on the times without a timed row", () => {
	expect(formatRecalledMemory([], now)).toBe("");
	expect(
		formatRecalledMemory(
			[item("Undated", null), item("Bad", "not a date")],
			now,
		),
	).not.toContain(RECALL_TIMES_NOTE);
});

it("adds only ASCII words that name no language and give no reply instruction", () => {
	const out = formatRecalledMemory(
		[0, 1, 3, 20, 100, 800].flatMap((d) => [
			item("x", daysAgo(d)),
			{
				...item("y", daysAgo(d), "project"),
				kind: "temporary" as const,
				timeState: "earlier" as const,
				earlierStates: [{ text: "z", saidAt: daysAgo(d + 5) }],
			},
		]),
		now,
	);
	expect(/^[\x20-\x7e\n]*$/.test(out)).toBe(true);
	expect(out).not.toMatch(
		/\b(english|hungarian|magyar|angol|language|languages|reply|replies|respond|answer)\b/i,
	);
});
