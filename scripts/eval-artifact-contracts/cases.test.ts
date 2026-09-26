import { describe, expect, it } from "vitest";
import { assertUniqueCaseIds, EVAL_CASES } from "./cases";
import type { EvalCase } from "./types";

function makeCase(id: string, suite = "app"): EvalCase {
	return { id, suite, description: id, prompt: "x" };
}

describe("assertUniqueCaseIds", () => {
	it("returns the list unchanged when every id is distinct", () => {
		const cases = [makeCase("a"), makeCase("b")];
		expect(assertUniqueCaseIds("app", cases)).toBe(cases);
	});

	it("throws for a duplicate case id within a suite", () => {
		expect(() =>
			assertUniqueCaseIds("app", [makeCase("dup"), makeCase("dup")]),
		).toThrow(/duplicate case id "dup"/);
	});
});

describe("EVAL_CASES — the real registry", () => {
	it("registers the app and verification suites, each internally consistent (no duplicate ids)", () => {
		expect(EVAL_CASES.app?.length).toBeGreaterThan(0);
		expect(EVAL_CASES.verification?.length).toBeGreaterThan(0);
		for (const [suite, cases] of Object.entries(EVAL_CASES)) {
			const ids = cases.map((evalCase) => evalCase.id);
			expect(new Set(ids).size, `suite "${suite}" has a duplicate id`).toBe(
				ids.length,
			);
		}
	});
});
