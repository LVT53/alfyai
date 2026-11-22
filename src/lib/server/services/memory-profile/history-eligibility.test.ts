import { expect, it } from "vitest";
import { historicalMemoryExclusion } from "./history-eligibility";

const at = new Date("2026-11-02T10:00:00Z");
const firstRecorded = new Date("2026-11-03T10:00:00Z");
const end = new Date("2026-11-04T10:00:00Z");
const unset = {
	historyChoice: null,
	historyCutoff: null,
	historyPolicyVersion: "1",
};
const base = { enabled: true, account: unset, intervals: [] };

it("defaults on before instrumentation without requiring an account decision", () => {
	expect(historicalMemoryExclusion(base, { assertedAt: at })).toBeNull();
	expect(
		historicalMemoryExclusion(
			{ enabled: true, intervals: [] },
			{ assertedAt: at },
		),
	).toBeNull();
	expect(
		historicalMemoryExclusion(
			{
				...base,
				intervals: [{ enabled: true, startedAt: firstRecorded, endedAt: end }],
			},
			{ assertedAt: at },
		),
	).toBeNull();
});

it("preserves past decisions, reset, incognito, known off and ambiguous recorded boundaries", () => {
	expect(
		historicalMemoryExclusion({ ...base, enabled: false }, { assertedAt: at }),
	).toBe("memory_off");
	expect(
		historicalMemoryExclusion(base, { assertedAt: at, incognito: true }),
	).toBe("incognito");
	expect(
		historicalMemoryExclusion({ ...base, resetAt: at }, { assertedAt: at }),
	).toBe("pre_reset");
	expect(
		historicalMemoryExclusion(
			{ ...base, account: { ...unset, historyChoice: "decline" } },
			{ assertedAt: at },
		),
	).toBe("unknown_history");
	expect(
		historicalMemoryExclusion(
			{
				...base,
				account: { ...unset, historyChoice: "include", historyCutoff: at },
			},
			{ assertedAt: firstRecorded },
		),
	).toBe("unknown_history");
	expect(
		historicalMemoryExclusion(
			{
				...base,
				account: { ...unset, historyChoice: "include", historyCutoff: at },
			},
			{ assertedAt: at },
		),
	).toBeNull();
	const intervals = [
		{ enabled: false, startedAt: firstRecorded, endedAt: end },
		{ enabled: true, startedAt: end, endedAt: null },
	];
	expect(
		historicalMemoryExclusion(
			{ ...base, intervals },
			{ assertedAt: firstRecorded },
		),
	).toBe("known_off");
	expect(
		historicalMemoryExclusion({ ...base, intervals }, { assertedAt: end }),
	).toBe("known_off");
	expect(
		historicalMemoryExclusion(
			{ ...base, intervals: [intervals[1]] },
			{ assertedAt: end },
		),
	).toBe("unknown_history");
});

it("never gives invalid or future source timestamps default permission", () => {
	expect(historicalMemoryExclusion(base, { assertedAt: new Date(NaN) })).toBe(
		"missing_date",
	);
	expect(
		historicalMemoryExclusion(base, {
			assertedAt: new Date(Date.now() + 86_400_000),
		}),
	).toBe("future_date");
});
