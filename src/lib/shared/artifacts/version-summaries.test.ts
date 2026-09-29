import { describe, expect, it } from "vitest";
import {
	parseRestoredVersion,
	parseSaveSummaryKind,
	restoredSummary,
	saveSummaryFor,
	VERSION_SUMMARY,
} from "./version-summaries";

describe("save summary kinds", () => {
	it("recognises the one named kind and nothing else", () => {
		expect(parseSaveSummaryKind("undid_alfy_change")).toBe("undid_alfy_change");
		expect(parseSaveSummaryKind("edited")).toBeNull();
		expect(parseSaveSummaryKind("Undid Alfy's change")).toBeNull();
		expect(parseSaveSummaryKind(undefined)).toBeNull();
		expect(parseSaveSummaryKind(42)).toBeNull();
		expect(parseSaveSummaryKind({})).toBeNull();
	});

	it("never mistakes an inherited property name for a kind", () => {
		for (const inherited of [
			"toString",
			"constructor",
			"__proto__",
			"hasOwnProperty",
		]) {
			expect(parseSaveSummaryKind(inherited)).toBeNull();
		}
	});

	it("stores an ordinary save as Edited and a named kind under its own summary", () => {
		expect(saveSummaryFor(null)).toBe(VERSION_SUMMARY.edited);
		expect(saveSummaryFor(undefined)).toBe("Edited");
		expect(saveSummaryFor("undid_alfy_change")).toBe("Undid Alfy's change");
	});
});

// Polish G2-A: a restore names the version it brought back ("Restored v3"),
// instead of wrapping that version's own summary ("restored Edited").
describe("restore summaries", () => {
	it("names the version a restore came from, and reads it back", () => {
		expect(restoredSummary(3)).toBe("Restored v3");
		expect(parseRestoredVersion("Restored v3")).toBe(3);
		expect(parseRestoredVersion(restoredSummary(12))).toBe(12);
	});

	it("reads only that exact shape — never the older wrapper, a free-form label or a look-alike", () => {
		for (const other of [
			"restored Edited",
			"Restored v",
			"Restored v3 by mistake",
			"Restored vx",
			"restored v3",
			"Moved the museum to Thursday",
			"",
		]) {
			expect(parseRestoredVersion(other)).toBeNull();
		}
	});
});
