import { describe, expect, it } from "vitest";
import {
	assertNoDuplicateCaseIds,
	assertUniqueCaseIds,
	EVAL_CASES,
} from "./cases";
import type { EvalCase } from "./types";

function makeCase(id: string, suite = "app"): EvalCase {
	return { id, suite, description: id, prompt: "x" };
}

function makeDocumentCase(overrides: Partial<EvalCase> = {}): EvalCase {
	return {
		id: "case-1",
		suite: "document",
		description: "fixture",
		prompt: "prompt",
		...overrides,
	};
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

describe("assertNoDuplicateCaseIds", () => {
	it("does not throw for a case list with unique ids", () => {
		expect(() =>
			assertNoDuplicateCaseIds("document", [
				makeDocumentCase({ id: "a" }),
				makeDocumentCase({ id: "b" }),
			]),
		).not.toThrow();
	});

	it("throws for a duplicate case id — a silent overwrite would quietly shrink the gate", () => {
		expect(() =>
			assertNoDuplicateCaseIds("document", [
				makeDocumentCase({ id: "a" }),
				makeDocumentCase({ id: "a" }),
			]),
		).toThrow(/duplicate/i);
	});

	it("names the offending id and suite in the thrown message", () => {
		expect(() =>
			assertNoDuplicateCaseIds("document", [
				makeDocumentCase({ id: "dup" }),
				makeDocumentCase({ id: "dup" }),
			]),
		).toThrow(/"dup"/);
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

describe("EVAL_CASES.document (Slice 1, Task T13)", () => {
	it("is non-empty", () => {
		expect(EVAL_CASES.document?.length ?? 0).toBeGreaterThan(0);
	});

	it("has no duplicate ids among the real registered cases", () => {
		expect(() =>
			assertNoDuplicateCaseIds("document", EVAL_CASES.document ?? []),
		).not.toThrow();
	});

	it('every case carries a real prompt and is registered under suite "document"', () => {
		for (const evalCase of EVAL_CASES.document ?? []) {
			expect(evalCase.suite).toBe("document");
			expect(evalCase.prompt.trim().length).toBeGreaterThan(0);
			expect(evalCase.description.trim().length).toBeGreaterThan(0);
		}
	});

	it("declares at least one known-bad case (ruling 25's gate)", () => {
		const knownBad = (EVAL_CASES.document ?? []).filter((c) => c.knownBad);
		expect(knownBad.length).toBeGreaterThan(0);
	});

	it("has a fixture registered for every case id (scoring.ts's DOCUMENT_FIXTURES)", async () => {
		const { DOCUMENT_FIXTURES } = await import("./suites/document");
		for (const evalCase of EVAL_CASES.document ?? []) {
			expect(
				DOCUMENT_FIXTURES[evalCase.id],
				`case ${evalCase.id} has no matching fixture`,
			).toBeDefined();
		}
	});

	it("has a committed response fixture for every case id (needed for --replay)", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		for (const evalCase of EVAL_CASES.document ?? []) {
			const path = join(
				"scripts",
				"eval-artifact-contracts",
				"fixtures",
				"document",
				"responses",
				`${evalCase.id}.json`,
			);
			expect(
				() => readFileSync(path, "utf8"),
				`case ${evalCase.id} has no committed response at ${path}`,
			).not.toThrow();
		}
	});
});
