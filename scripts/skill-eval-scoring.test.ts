import { describe, expect, it } from "vitest";
import {
	buildJudgePrompt,
	parseJudgeResponse,
	scoreDelta,
	structuralSignals,
} from "./skill-eval-scoring";

describe("structuralSignals", () => {
	describe("system:grill-with-docs (Plan Critic)", () => {
		it("hits the severity-tag signal when Blocker/Major/Minor labels are present", () => {
			const output = [
				"Blocker: dropping the column before backfill will lose data irrecoverably.",
				"Major: the rollout skips the two-phase migration required by ADR-014.",
				"Minor: naming could be clearer.",
				"Overall risk: High — do not ship as-is.",
			].join("\n");
			const signals = structuralSignals("system:grill-with-docs", output);
			const severity = signals.find((s) => s.signal === "severity_tags");
			expect(severity?.hit).toBe(true);
		});

		it("misses the severity-tag signal when no severity labels are used", () => {
			const output =
				"This plan has some issues. You should probably reconsider the migration approach and think about rollback.";
			const signals = structuralSignals("system:grill-with-docs", output);
			const severity = signals.find((s) => s.signal === "severity_tags");
			expect(severity?.hit).toBe(false);
		});

		it("hits the overall-risk-read signal when a Low/Medium/High rating is given", () => {
			const output = "Overall risk: Medium — mostly rework, not correctness.";
			const signals = structuralSignals("system:grill-with-docs", output);
			const risk = signals.find((s) => s.signal === "overall_risk_read");
			expect(risk?.hit).toBe(true);
		});

		it("misses the overall-risk-read signal when no risk rating is present", () => {
			const output = "There are some risky parts of this plan to consider.";
			const signals = structuralSignals("system:grill-with-docs", output);
			const risk = signals.find((s) => s.signal === "overall_risk_read");
			expect(risk?.hit).toBe(false);
		});
	});

	describe("system:purchase-helper (Purchase Helper)", () => {
		it("hits when a markdown table and a buy/wait/skip verdict are both present", () => {
			const output = [
				"| Option | Price | RAM | Battery |",
				"| --- | --- | --- | --- |",
				"| Laptop A | $999 | 16GB | 10h |",
				"| Laptop B | $1150 | 32GB | 8h |",
				"",
				"Verdict: buy Laptop A now — it fits your budget and RAM needs.",
			].join("\n");
			const signals = structuralSignals("system:purchase-helper", output);
			const table = signals.find((s) => s.signal === "comparison_table");
			const verdict = signals.find((s) => s.signal === "decisive_verdict");
			expect(table?.hit).toBe(true);
			expect(verdict?.hit).toBe(true);
		});

		it("misses the comparison-table signal when there is only prose", () => {
			const output =
				"Laptop A costs $999 and has 16GB RAM. Laptop B costs $1150 and has 32GB RAM. I'd wait for a sale.";
			const signals = structuralSignals("system:purchase-helper", output);
			const table = signals.find((s) => s.signal === "comparison_table");
			expect(table?.hit).toBe(false);
		});

		it("misses the decisive-verdict signal when there is no buy/wait/skip language", () => {
			const output =
				"| Option | Price |\n| --- | --- |\n| A | $999 |\n\nBoth are reasonable choices depending on preference.";
			const signals = structuralSignals("system:purchase-helper", output);
			const verdict = signals.find((s) => s.signal === "decisive_verdict");
			expect(verdict?.hit).toBe(false);
		});
	});

	describe("system:translate-rewrite (Translate & Rewrite)", () => {
		it("hits when input placeholders are all preserved verbatim in the output", () => {
			const input =
				"Hi {name}, your order <order_id> has shipped. Track: {tracking_url}";
			const output =
				"Hola {name}, tu pedido <order_id> ha sido enviado. Sigue el envío aquí: {tracking_url}";
			const signals = structuralSignals("system:translate-rewrite", output, {
				inputText: input,
			});
			const placeholders = signals.find(
				(s) => s.signal === "placeholders_preserved",
			);
			expect(placeholders?.hit).toBe(true);
		});

		it("misses when a placeholder present in the input is dropped from the output", () => {
			const input =
				"Hi {name}, your order <order_id> has shipped. Track: {tracking_url}";
			const output = "Hola, tu pedido ha sido enviado. Sigue el envío aquí.";
			const signals = structuralSignals("system:translate-rewrite", output, {
				inputText: input,
			});
			const placeholders = signals.find(
				(s) => s.signal === "placeholders_preserved",
			);
			expect(placeholders?.hit).toBe(false);
		});

		it("is vacuously true (hit) when the input has no placeholders to preserve", () => {
			const input = "Please make this more professional.";
			const output = "Please make this more professional and concise.";
			const signals = structuralSignals("system:translate-rewrite", output, {
				inputText: input,
			});
			const placeholders = signals.find(
				(s) => s.signal === "placeholders_preserved",
			);
			expect(placeholders?.hit).toBe(true);
		});
	});

	describe("system:document-explainer (Document Explainer)", () => {
		it("hits when confidence tagging language is present", () => {
			const output =
				"Takeaway: rent can rise after year one.\n\nConfidence: high — the clause is explicit in Section 7.2.";
			const signals = structuralSignals("system:document-explainer", output);
			const confidence = signals.find((s) => s.signal === "confidence_tags");
			expect(confidence?.hit).toBe(true);
		});

		it("hits when a high/medium/low style confidence phrase is used", () => {
			const output = "This is medium/low confidence given the small sample.";
			const signals = structuralSignals("system:document-explainer", output);
			const confidence = signals.find((s) => s.signal === "confidence_tags");
			expect(confidence?.hit).toBe(true);
		});

		it("misses when no confidence language appears", () => {
			const output = "The document says rent is fixed for one year.";
			const signals = structuralSignals("system:document-explainer", output);
			const confidence = signals.find((s) => s.signal === "confidence_tags");
			expect(confidence?.hit).toBe(false);
		});
	});

	describe("system:appointment-prep (Appointment Prep)", () => {
		it("hits when a verify/flag section and action-first ordering are present", () => {
			const output = [
				"Do first: bring your passport and financial statements.",
				"",
				"Verify / flag: confirm the required minimum balance with the consulate website — this changes yearly.",
			].join("\n");
			const signals = structuralSignals("system:appointment-prep", output);
			const verify = signals.find((s) => s.signal === "verify_flag_section");
			expect(verify?.hit).toBe(true);
		});

		it("misses when there is no verify/flag/confirm section", () => {
			const output =
				"Bring your passport. It should go fine, good luck with the interview.";
			const signals = structuralSignals("system:appointment-prep", output);
			const verify = signals.find((s) => s.signal === "verify_flag_section");
			expect(verify?.hit).toBe(false);
		});
	});

	describe("system:study-coach (Study Coach)", () => {
		it("hits when flashcard/Q&A or schedule cues are present", () => {
			const output =
				"Flashcard 1: Q: What enzyme catalyzes step 3? A: Aconitase.\n\nReview schedule: Day 1, Day 3, Day 6 before your exam.";
			const signals = structuralSignals("system:study-coach", output);
			const cards = signals.find((s) => s.signal === "flashcard_or_schedule");
			expect(cards?.hit).toBe(true);
		});

		it("misses when the output is plain explanatory prose only", () => {
			const output =
				"The Krebs cycle has eight steps, each catalyzed by a different enzyme.";
			const signals = structuralSignals("system:study-coach", output);
			const cards = signals.find((s) => s.signal === "flashcard_or_schedule");
			expect(cards?.hit).toBe(false);
		});
	});

	describe("system:spreadsheet-builder (Spreadsheet Builder)", () => {
		it("hits when scenario/breakeven language is present", () => {
			const output =
				"Scenario columns: base, downside, upside. Below breakeven in the downside case by month 4.";
			const signals = structuralSignals("system:spreadsheet-builder", output);
			const scenario = signals.find((s) => s.signal === "scenario_language");
			expect(scenario?.hit).toBe(true);
		});

		it("misses when there is no scenario/breakeven/what-would-change language", () => {
			const output = "Here is a simple KPI dashboard with your current MRR.";
			const signals = structuralSignals("system:spreadsheet-builder", output);
			const scenario = signals.find((s) => s.signal === "scenario_language");
			expect(scenario?.hit).toBe(false);
		});
	});

	it("returns an empty array for an unknown skillId rather than throwing", () => {
		expect(() =>
			structuralSignals("system:unknown-pack", "anything"),
		).not.toThrow();
		expect(structuralSignals("system:unknown-pack", "anything")).toEqual([]);
	});
});

describe("scoreDelta", () => {
	it("computes hit counts and the before-to-after delta", () => {
		const before = [
			{ signal: "a", hit: true },
			{ signal: "b", hit: false },
			{ signal: "c", hit: false },
		];
		const after = [
			{ signal: "a", hit: true },
			{ signal: "b", hit: true },
			{ signal: "c", hit: true },
		];
		const result = scoreDelta(before, after);
		expect(result).toEqual({ beforeHits: 1, afterHits: 3, delta: 2 });
	});

	it("reports a negative delta when after scores worse than before", () => {
		const before = [
			{ signal: "a", hit: true },
			{ signal: "b", hit: true },
		];
		const after = [
			{ signal: "a", hit: true },
			{ signal: "b", hit: false },
		];
		const result = scoreDelta(before, after);
		expect(result).toEqual({ beforeHits: 2, afterHits: 1, delta: -1 });
	});

	it("handles empty signal arrays as zero hits with zero delta", () => {
		expect(scoreDelta([], [])).toEqual({
			beforeHits: 0,
			afterHits: 0,
			delta: 0,
		});
	});
});

describe("buildJudgePrompt", () => {
	it("labels the two responses blindly as Response 1 / Response 2", () => {
		const prompt = buildJudgePrompt("Output A text", "Output B text", [
			"structure",
			"input-gating",
		]);
		expect(prompt).toContain("Response 1");
		expect(prompt).toContain("Response 2");
		expect(prompt).toContain("Output A text");
		expect(prompt).toContain("Output B text");
	});

	it("includes every rubric criterion by name", () => {
		const criteria = [
			"structure",
			"input-gating",
			"source-vs-reasoned",
			"decisiveness",
			"concreteness",
		];
		const prompt = buildJudgePrompt("A", "B", criteria);
		for (const criterion of criteria) {
			expect(prompt).toContain(criterion);
		}
	});

	it("requires a winner and asks for strict JSON output", () => {
		const prompt = buildJudgePrompt("A", "B", ["structure"]);
		expect(prompt.toLowerCase()).toContain("winner");
		expect(prompt.toLowerCase()).toContain("json");
	});
});

describe("parseJudgeResponse", () => {
	it("parses a valid JSON judge response with a numeric winner", () => {
		const text = JSON.stringify({
			winner: 1,
			scores: {
				structure: { r1: 4, r2: 3 },
				decisiveness: { r1: 5, r2: 2 },
			},
		});
		const result = parseJudgeResponse(text);
		expect(result).toEqual({
			winner: 1,
			scores: {
				structure: { r1: 4, r2: 3 },
				decisiveness: { r1: 5, r2: 2 },
			},
		});
	});

	it('parses a "tie" winner', () => {
		const text = JSON.stringify({
			winner: "tie",
			scores: { structure: { r1: 3, r2: 3 } },
		});
		const result = parseJudgeResponse(text);
		expect(result?.winner).toBe("tie");
	});

	it("extracts JSON embedded in surrounding prose or markdown fences", () => {
		const text = [
			"Here is my evaluation:",
			"```json",
			JSON.stringify({
				winner: 2,
				scores: { structure: { r1: 2, r2: 4 } },
			}),
			"```",
		].join("\n");
		const result = parseJudgeResponse(text);
		expect(result).toEqual({
			winner: 2,
			scores: { structure: { r1: 2, r2: 4 } },
		});
	});

	it("returns null for malformed JSON", () => {
		const result = parseJudgeResponse("this is not json at all { broken");
		expect(result).toBeNull();
	});

	it("returns null when winner is missing or invalid", () => {
		const text = JSON.stringify({
			winner: "banana",
			scores: { structure: { r1: 1, r2: 1 } },
		});
		expect(parseJudgeResponse(text)).toBeNull();
	});

	it("returns null when scores is missing", () => {
		const text = JSON.stringify({ winner: 1 });
		expect(parseJudgeResponse(text)).toBeNull();
	});

	it("returns null when a score entry is malformed", () => {
		const text = JSON.stringify({
			winner: 1,
			scores: { structure: { r1: "high", r2: 3 } },
		});
		expect(parseJudgeResponse(text)).toBeNull();
	});
});
