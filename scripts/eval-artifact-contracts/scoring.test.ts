import { describe, expect, it } from "vitest";
import { scoreArtifactEvalAttempt } from "./scoring";
import type { EvalAttempt, EvalCase } from "./types";

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
	return {
		id: "case-1",
		suite: "document",
		description: "A fixture case",
		prompt: "Write a weekend checklist",
		...overrides,
	};
}

function makeAttempt(overrides: Partial<EvalAttempt> = {}): EvalAttempt {
	return {
		caseId: "case-1",
		suite: "document",
		response: "# Weekend\n- [ ] Buy groceries",
		...overrides,
	};
}

describe("scoreArtifactEvalAttempt", () => {
	it("grades a fixture attempt as good/acceptable/bad with reasons", () => {
		const result = scoreArtifactEvalAttempt(makeCase(), makeAttempt());

		expect(["good", "acceptable", "bad"]).toContain(result.verdict);
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("grades an empty answer as bad rather than throwing", () => {
		const result = scoreArtifactEvalAttempt(
			makeCase(),
			makeAttempt({ response: "" }),
		);

		expect(result.verdict).toBe("bad");
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("grades a whitespace-only answer as bad", () => {
		const result = scoreArtifactEvalAttempt(
			makeCase(),
			makeAttempt({ response: "   \n\t  " }),
		);

		expect(result.verdict).toBe("bad");
	});

	it("does not throw for a mismatched case/attempt suite", () => {
		expect(() =>
			scoreArtifactEvalAttempt(
				makeCase({ suite: "document" }),
				makeAttempt({ suite: "app" }),
			),
		).not.toThrow();
	});
});
