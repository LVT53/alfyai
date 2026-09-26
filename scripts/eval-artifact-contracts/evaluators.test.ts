import { afterEach, describe, expect, it } from "vitest";
import { getSuiteEvaluator, SUITE_EVALUATORS } from "./evaluators";
import type { SuiteEvaluator } from "./types";

// The per-suite dispatch seam (decisions.md ruling 56), a sibling of
// scoring.ts's SUITE_SCORERS/getSuiteScorer — mirrors its own test (this
// file's `document` stand-in never collides with the real `app` entry
// evaluators.ts registers).
describe("getSuiteEvaluator", () => {
	afterEach(() => {
		delete SUITE_EVALUATORS.document;
	});

	it("returns undefined for an unregistered suite — never a throw", () => {
		expect(getSuiteEvaluator("document")).toBeUndefined();
		expect(getSuiteEvaluator("nonexistent-suite-name")).toBeUndefined();
	});

	it("dispatches to a suite's own evaluator once one is registered", async () => {
		const documentEvaluator: SuiteEvaluator = async () => ({ ran: true });
		SUITE_EVALUATORS.document = documentEvaluator;

		expect(getSuiteEvaluator("document")).toBe(documentEvaluator);
		expect(getSuiteEvaluator("nonexistent-suite-name")).toBeUndefined();
	});

	it("the real app suite has its own registered evaluator", () => {
		expect(getSuiteEvaluator("app")).toBeTypeOf("function");
	});
});
