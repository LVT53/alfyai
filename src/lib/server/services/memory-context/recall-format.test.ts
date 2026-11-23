import { expect, it } from "vitest";
import type { AdmittedMemoryEvidence } from "$lib/memory-types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { formatRecalledMemory, recallLineTokens } from "./recall-format";

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
	).toBe("- undated\n- bad\n- future (said less than a day ago)");
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

it("never costs more than recallLineTokens for a row", () => {
	for (const d of [null, 0, 1, 5, 20, 100, 800]) {
		const line = formatRecalledMemory(
			[item("Prefers green tea", d === null ? null : daysAgo(d))],
			now,
		);
		expect(estimateTokenCount(line)).toBeLessThanOrEqual(
			recallLineTokens("Prefers green tea"),
		);
	}
	expect(
		estimateTokenCount(
			formatRecalledMemory([item("Prefers green tea", daysAgo(0))], now),
		),
	).toBe(recallLineTokens("Prefers green tea"));
});

it("adds only ASCII words that name no language and give no reply instruction", () => {
	const out = formatRecalledMemory(
		[0, 1, 3, 20, 100, 800].flatMap((d) => [
			item("x", daysAgo(d)),
			item("y", daysAgo(d), "project"),
		]),
		now,
	);
	expect(/^[\x20-\x7e\n]*$/.test(out)).toBe(true);
	expect(out).not.toMatch(
		/\b(english|hungarian|magyar|angol|language|languages|reply|replies|respond|answer)\b/i,
	);
});
