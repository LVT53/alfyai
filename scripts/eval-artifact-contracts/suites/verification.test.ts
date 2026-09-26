import { describe, expect, it } from "vitest";
import { scoreVerificationEval, VERIFICATION_EVAL_CASES } from "./verification";

function fenceJson(payload: unknown): string {
	return `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

describe("VERIFICATION_EVAL_CASES", () => {
	it("has the three hand-audited bug fixtures, one clean negative, and one known-bad fixture, all with unique ids", () => {
		const ids = VERIFICATION_EVAL_CASES.map((evalCase) => evalCase.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(VERIFICATION_EVAL_CASES).toHaveLength(5);
		expect(
			VERIFICATION_EVAL_CASES.filter((evalCase) => evalCase.knownBad),
		).toHaveLength(1);
	});

	it("every case belongs to the verification suite and carries the app's HTML in the prompt", () => {
		for (const evalCase of VERIFICATION_EVAL_CASES) {
			expect(evalCase.suite).toBe("verification");
			expect(evalCase.prompt).toContain("<html");
		}
	});
});

describe("scoreVerificationEval — the three prototype bug classes must be caught", () => {
	it("scores good when the verifier correctly flags mislabelled_aggregate", () => {
		const evalCase = VERIFICATION_EVAL_CASES.find(
			(c) => c.id === "verification-mislabelled-aggregate",
		);
		if (!evalCase) throw new Error("fixture not found");
		const result = scoreVerificationEval(evalCase, {
			caseId: evalCase.id,
			suite: "verification",
			response: fenceJson({
				claims: ["the yearly repayment amount"],
				findings: [
					{
						claim: "Year 1: 600,000; Year 2: 1,200,000; Year 3: 1,800,000",
						problem:
							"These are cumulative totals, not per-year figures — the sum of the column does not match the stated grand total.",
						class: "mislabelled_aggregate",
						location: "Éves bontás table",
						settled: true,
					},
				],
				repairedHtml: null,
				repairSafe: false,
			}),
		});
		expect(result.verdict).toBe("good");
	});

	it("scores bad when the verifier misses the bug entirely (empty findings)", () => {
		const evalCase = VERIFICATION_EVAL_CASES.find(
			(c) => c.id === "verification-wrong-key",
		);
		if (!evalCase) throw new Error("fixture not found");
		const result = scoreVerificationEval(evalCase, {
			caseId: evalCase.id,
			suite: "verification",
			response: fenceJson({
				claims: [],
				findings: [],
				repairedHtml: null,
				repairSafe: false,
			}),
		});
		expect(result.verdict).toBe("bad");
	});

	it("scores acceptable when the verifier flags something but not a settled match for the known bug", () => {
		const evalCase = VERIFICATION_EVAL_CASES.find(
			(c) => c.id === "verification-wrong-unit",
		);
		if (!evalCase) throw new Error("fixture not found");
		const result = scoreVerificationEval(evalCase, {
			caseId: evalCase.id,
			suite: "verification",
			response: fenceJson({
				claims: ["the frog flashcard gloss"],
				findings: [
					{
						claim: "frog — békák",
						problem: "Not sure this is wrong without checking a dictionary.",
						class: "wrong_unit",
						location: "Flashcard 3",
						settled: false,
					},
				],
				repairedHtml: null,
				repairSafe: false,
			}),
		});
		expect(result.verdict).toBe("acceptable");
	});
});

describe("scoreVerificationEval — the clean fixture must not be falsely flagged", () => {
	const cleanCase = VERIFICATION_EVAL_CASES.find(
		(c) => c.id === "verification-clean",
	);
	if (!cleanCase) throw new Error("fixture not found");

	it("scores good when the verifier is correctly silent", () => {
		const result = scoreVerificationEval(cleanCase, {
			caseId: cleanCase.id,
			suite: "verification",
			response: fenceJson({
				claims: ["the Celsius to Fahrenheit conversions"],
				findings: [],
				repairedHtml: null,
				repairSafe: false,
			}),
		});
		expect(result.verdict).toBe("good");
	});

	it("scores bad when the verifier confidently invents a problem in a clean app", () => {
		const result = scoreVerificationEval(cleanCase, {
			caseId: cleanCase.id,
			suite: "verification",
			response: fenceJson({
				claims: ["the Celsius to Fahrenheit conversions"],
				findings: [
					{
						claim: "37°C = 98.6°F",
						problem: "This conversion is wrong.",
						class: "other",
						location: "Table row 2",
						settled: true,
					},
				],
				repairedHtml: null,
				repairSafe: false,
			}),
		});
		expect(result.verdict).toBe("bad");
	});

	it("scores acceptable when the verifier raises an unsettled doubt rather than a confident false positive", () => {
		const result = scoreVerificationEval(cleanCase, {
			caseId: cleanCase.id,
			suite: "verification",
			response: fenceJson({
				claims: ["the Celsius to Fahrenheit conversions"],
				findings: [
					{
						claim: "37°C = 98.6°F",
						problem: "Could not fully confirm this without a calculator.",
						class: "other",
						location: "Table row 2",
						settled: false,
					},
				],
				repairedHtml: null,
				repairSafe: false,
			}),
		});
		expect(result.verdict).toBe("acceptable");
	});
});

describe("scoreVerificationEval — the harness's own known-bad fixture", () => {
	it("scores bad on an unparseable answer, proving the scorer can see a failure", () => {
		const knownBad = VERIFICATION_EVAL_CASES.find(
			(evalCase) => evalCase.knownBad,
		);
		if (!knownBad) throw new Error("no known-bad case declared");
		const result = scoreVerificationEval(knownBad, {
			caseId: knownBad.id,
			suite: "verification",
			response: "CONFIRMED",
		});
		expect(result.verdict).toBe("bad");
	});
});
