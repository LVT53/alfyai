import { describe, expect, it } from "vitest";
import {
	parseJsonWithEnvelopeExtraction,
	parseJudgeDecisions,
	parseJudgeDecisionsDetailed,
} from "./schema";

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
	it("aliases action 'create' to 'add' before validation", () => {
		const out = parseJudgeDecisions(
			JSON.stringify({ decisions: [valid({ action: "create" })] }),
		);
		expect(out).toHaveLength(1);
		expect(out[0].action).toBe("add");
	});
});

describe("parseJudgeDecisionsDetailed", () => {
	it("returns empty lists on malformed JSON (no candidates to attribute)", () => {
		expect(parseJudgeDecisionsDetailed("not json")).toEqual({
			decisions: [],
			rejected: [],
		});
	});
	it("records one rejected candidate per reason", () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ statement: "I might have a bike." }, "hedge"],
			[
				{ statement: "I run AlmaLinux, as indicated by the filesystem." },
				"evidence_trail",
			],
			[{ statement: "The user prefers tea." }, "third_person"],
			[{ category: "vibes" }, "invalid_shape"],
			[{ expiryClass: "time_bound" }, "missing_expiry"],
			[{ action: "update" }, "missing_target"],
		];
		for (const [over, reason] of cases) {
			const { decisions, rejected } = parseJudgeDecisionsDetailed(
				JSON.stringify({ decisions: [valid(over)] }),
			);
			expect(decisions).toEqual([]);
			expect(rejected).toHaveLength(1);
			expect(rejected[0].reason).toBe(reason);
		}
	});
	it("keeps accepted decisions out of the rejected list", () => {
		const { decisions, rejected } = parseJudgeDecisionsDetailed(
			JSON.stringify({ decisions: [valid()] }),
		);
		expect(decisions).toHaveLength(1);
		expect(rejected).toEqual([]);
	});
});

describe("missing-target resolution against existing facts", () => {
	const facts = [
		{
			id: "f-tea",
			statement: "I prefer plain language.",
			category: "preferences",
		},
		{ id: "f-home", statement: "I live in Budapest.", category: "about_you" },
	];
	const parse = (
		over: Record<string, unknown>,
		existingFacts: Array<{
			id: string;
			statement: string;
			category: string;
		}> = facts,
	) =>
		parseJudgeDecisionsDetailed(JSON.stringify({ decisions: [valid(over)] }), {
			existingFacts,
		});

	it("resolves a unique exact normalized statement match in the same category", () => {
		const { decisions, rejected } = parse({
			action: "strengthen",
			statement: "  I prefer PLAIN language!  ",
		});
		expect(rejected).toEqual([]);
		expect(decisions).toEqual([
			expect.objectContaining({
				action: "strengthen",
				targetItemId: "f-tea",
				targetResolution: "statement_match",
			}),
		]);
	});

	it("does not match a fact in a different category", () => {
		const { decisions } = parse({
			action: "update",
			statement: "I live in Budapest.",
			category: "preferences",
		});
		expect(decisions).toEqual([
			expect.objectContaining({
				action: "add",
				targetResolution: "no_match_admitted_as_new",
			}),
		]);
		expect(decisions[0].targetItemId).toBeUndefined();
	});

	it("admits an update with no matching fact as a new fact", () => {
		const { decisions, rejected } = parse({
			action: "update",
			statement: "I live in Amsterdam.",
			category: "about_you",
		});
		expect(rejected).toEqual([]);
		expect(decisions).toEqual([
			expect.objectContaining({
				action: "add",
				statement: "I live in Amsterdam.",
				targetResolution: "no_match_admitted_as_new",
			}),
		]);
	});

	it("keeps rejecting as missing_target when the match is ambiguous", () => {
		const { decisions, rejected } = parse({ action: "update" }, [
			...facts,
			{
				id: "f-tea-2",
				statement: "I prefer plain language",
				category: "preferences",
			},
		]);
		expect(decisions).toEqual([]);
		expect(rejected).toEqual([
			{ statement: "I prefer plain language.", reason: "missing_target" },
		]);
	});

	it("still runs gates 1-4 before target resolution", () => {
		const { decisions, rejected } = parse({
			action: "update",
			statement: "I might live in Amsterdam.",
			category: "about_you",
		});
		expect(decisions).toEqual([]);
		expect(rejected[0]?.reason).toBe("hedge");
	});

	it("strips the prompt's [brackets] from a supplied targetItemId", () => {
		const { decisions } = parse({
			action: "update",
			targetItemId: " [f-home] ",
		});
		expect(decisions[0]?.targetItemId).toBe("f-home");
	});
});

describe("parseJsonWithEnvelopeExtraction", () => {
	it("returns null (without spinning) when the key sits at index 0 with no enclosing object", () => {
		// `lastIndexOf(needle, -1)` still matches at index 0, so the scan-back
		// loop used to return 0 forever on this shape and hang the event loop.
		expect(
			parseJsonWithEnvelopeExtraction(
				'"followUps": ["What next?", "Why now?"]',
				"followUps",
			),
		).toBeNull();
	});

	it("still extracts an embedded envelope that is preceded by prose", () => {
		expect(
			parseJsonWithEnvelopeExtraction(
				'Sure! {"followUps": ["What next?"]} — hope that helps.',
				"followUps",
			),
		).toEqual({ followUps: ["What next?"] });
	});

	it("extracts an envelope whose object starts at index 0", () => {
		expect(
			parseJsonWithEnvelopeExtraction(
				'{"followUps": ["A?"]} trailing',
				"followUps",
			),
		).toEqual({ followUps: ["A?"] });
	});
});
