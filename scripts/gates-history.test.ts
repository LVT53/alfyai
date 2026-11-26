import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import * as history from "./gates-history.mjs";

test("preserves valid entries when a line is damaged", () => {
	const dir = mkdtempSync(join(tmpdir(), "alfyai-history-"));
	try {
		expect(history.appendHistory(dir, { v: 1, head: "a" })).toBeNull();
		appendFileSync(join(dir, "history.jsonl"), "broken\n");
		expect(history.appendHistory(dir, { v: 1, head: "b" })).toBeNull();
		expect(history.readHistory(dir)).toEqual([
			{ v: 1, head: "a" },
			{ v: 1, head: "b" },
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("finds the previous release even if finishing order differs from start order", () => {
	const older = { mode: "release", at: "2026-11-24T12:00:00Z" };
	const recent = { mode: "release", at: "2026-11-25T12:00:00Z" };
	expect(
		history.previousRelease(
			[recent, older, { mode: "agent", at: "2026-11-26T12:00:00Z" }],
			"2026-11-27T00:00:00Z",
		),
	).toBe(recent);
});

test("reports clamp frequency, medians and failure rates", () => {
	const at = "2026-11-26T00:00:00Z";
	const entry = (minutes: number, priorityLowest: number, passed: boolean) => ({
		mode: "release",
		at,
		machine: { priorityLowest },
		totalMs: minutes * 60_000,
		passed,
		measured: { counts: passed && priorityLowest >= 31 },
	});
	expect(
		history
			.historyReport(
				[
					entry(20, 4, false),
					entry(18, 4, true),
					entry(10, 31, true),
					entry(11, 31, true),
				],
				{ now: Date.parse(at) },
			)
			.join("\n"),
	).toContain(
		"clamped: 2 of 4 runs (50%), median 19m00s, 1 of 2 failed; unclamped: median 10m30s, 0 of 2 failed",
	);
});

test("history failures are diagnostic", () => {
	expect(history.appendHistory(null, {})).toMatch(/^history: not written/);
	expect(history.readHistory(null)).toEqual([]);
});
