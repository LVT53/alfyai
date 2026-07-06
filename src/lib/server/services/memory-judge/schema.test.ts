import { describe, expect, it } from "vitest";
import { parseJudgeDecisions } from "./schema";

const valid = (over: Record<string, unknown> = {}) => ({
	action: "add",
	statement: "I prefer plain language.",
	category: "preferences",
	scope: "global",
	confidence: "stated",
	expiryClass: "durable",
	sourceQuote: "plain language please",
	...over,
});

describe("parseJudgeDecisions", () => {
	it("accepts a valid add decision", () => {
		const out = parseJudgeDecisions(JSON.stringify({ decisions: [valid()] }));
		expect(out).toHaveLength(1);
		expect(out[0].category).toBe("preferences");
	});
	it("returns [] on malformed JSON", () => {
		expect(parseJudgeDecisions("not json")).toEqual([]);
	});
	it("drops decisions with unknown category", () => {
		expect(
			parseJudgeDecisions(
				JSON.stringify({ decisions: [valid({ category: "vibes" })] }),
			),
		).toEqual([]);
	});
	it("drops hedged statements (gate 4)", () => {
		for (const s of [
			"I might have a bike.",
			"I possibly work in a team.",
			"I have a bike or have a bike to which insurance might be applicable.",
			"Lehet, hogy Budapesten élek.",
			"Talán szeretem a teát.",
		]) {
			expect(
				parseJudgeDecisions(
					JSON.stringify({ decisions: [valid({ statement: s })] }),
				),
			).toEqual([]);
		}
	});
	it("drops evidence-trail prose (gate 2 leakage)", () => {
		for (const s of [
			"I run AlmaLinux, as indicated by the filesystem device name.",
			"I operate alfyws (extracted from: the working directory path).",
		]) {
			expect(
				parseJudgeDecisions(
					JSON.stringify({ decisions: [valid({ statement: s })] }),
				),
			).toEqual([]);
		}
	});
	it("drops third-person / peer-token statements", () => {
		expect(
			parseJudgeDecisions(
				JSON.stringify({
					decisions: [valid({ statement: "U_86dc59c07f prefers tea." })],
				}),
			),
		).toEqual([]);
		expect(
			parseJudgeDecisions(
				JSON.stringify({
					decisions: [valid({ statement: "The user prefers tea." })],
				}),
			),
		).toEqual([]);
	});
	it("requires expiresInDays for time_bound and rejects durable one-time events wording", () => {
		expect(
			parseJudgeDecisions(
				JSON.stringify({ decisions: [valid({ expiryClass: "time_bound" })] }),
			),
		).toEqual([]);
		const ok = parseJudgeDecisions(
			JSON.stringify({
				decisions: [
					valid({
						expiryClass: "time_bound",
						expiresInDays: 90,
						statement: "I am looking for accommodation in Limerick.",
					}),
				],
			}),
		);
		expect(ok).toHaveLength(1);
	});
	it("requires targetItemId for update/strengthen", () => {
		expect(
			parseJudgeDecisions(
				JSON.stringify({ decisions: [valid({ action: "update" })] }),
			),
		).toEqual([]);
	});
	it("truncates multi-sentence statements to one sentence", () => {
		const out = parseJudgeDecisions(
			JSON.stringify({
				decisions: [valid({ statement: "I prefer tea. I also like coffee." })],
			}),
		);
		expect(out[0].statement).toBe("I prefer tea.");
	});
});
