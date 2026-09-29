import { describe, expect, it } from "vitest";
import {
	parseSaveSummaryKind,
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
