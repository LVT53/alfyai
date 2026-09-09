import { describe, expect, it, vi } from "vitest";
import { buildAtlasV2EvidenceIndex } from "./evidence-index";
import type {
	AtlasV2EvidenceIndex,
	AtlasV2RawSource,
	AtlasV2VerifiedSection,
	AtlasV2WrittenSection,
	AtlasV2WrittenSentence,
} from "./types";
import {
	checkAtlasV2CoreAnswer,
	figureCorroboration,
	findContradictions,
	isStaleSource,
	parseAtlasV2EntailmentAnswer,
	parseAtlasV2EntailmentBatchAnswer,
	trimSentenceCitations,
	verifyAtlasV2Report,
} from "./verify";

const NOW = new Date("2026-09-08T00:00:00.000Z");

function raw(overrides: Partial<AtlasV2RawSource>): AtlasV2RawSource {
	return {
		questionId: "q1",
		round: 1,
		url: "https://example.com/a",
		title: "A report",
		snippets: ["Placeholder evidence text with enough prose to survive."],
		publishedAt: "2026-05-01",
		pageExcerpt: null,
		...overrides,
	};
}

function indexOf(sources: AtlasV2RawSource[]): AtlasV2EvidenceIndex {
	return buildAtlasV2EvidenceIndex(sources);
}

function sentence(
	overrides: Partial<AtlasV2WrittenSentence> = {},
): AtlasV2WrittenSentence {
	return {
		text: "Solar capacity reached 8 GW.",
		citations: [1],
		inferred: false,
		calcId: null,
		...overrides,
	};
}

function section(
	sentences: AtlasV2WrittenSentence[],
	overrides: Partial<AtlasV2WrittenSection> = {},
): AtlasV2WrittenSection {
	return {
		sectionId: "s1",
		title: "Capacity",
		paragraphs: [{ sentences }],
		calculations: [],
		...overrides,
	};
}

describe("verifyAtlasV2Report — citation resolution", () => {
	it("cuts a sentence whose citation does not exist", async () => {
		const index = indexOf([raw({})]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence({ citations: [42] })])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(1);
		expect(result.sections[0].paragraphs).toEqual([]);
	});

	it("keeps a sentence whose every figure the cited source states", async () => {
		const index = indexOf([
			raw({
				snippets: ["Installed solar capacity reached 8,000 MW by June."],
			}),
		]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(0);
		expect(result.sections[0].paragraphs[0][0].text).toBe(
			"Solar capacity reached 8 GW.",
		);
	});
});

describe("verifyAtlasV2Report — number matching", () => {
	it("cuts a figure the cited source does not state", async () => {
		const index = indexOf([
			raw({ snippets: ["Installed solar capacity reached 6,000 MW by June."] }),
		]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(1);
	});

	it("accepts the figure when any one of several cited sources states it", async () => {
		const index = indexOf([
			raw({
				url: "https://one.example/a",
				snippets: [
					"This report covers grid connection queues and permitting timelines across the member states.",
				],
			}),
			raw({
				url: "https://iea.org/a",
				title: "IEA update",
				snippets: ["Capacity reached 8 gigawatts."],
			}),
		]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence({ citations: [1, 2] })])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(0);
	});
});

describe("verifyAtlasV2Report — inferred sentences", () => {
	it("keeps a hedged inferred sentence with no figure", async () => {
		const index = indexOf([raw({})]);
		const result = await verifyAtlasV2Report({
			sections: [
				section([
					sentence({
						text: "Taken together, the evidence points to continued growth.",
						citations: [],
						inferred: true,
					}),
				]),
			],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.inferred).toBe(1);
		expect(result.totals.cut).toBe(0);
	});

	it("cuts an inferred sentence that smuggles in a figure", async () => {
		const index = indexOf([raw({})]);
		const result = await verifyAtlasV2Report({
			sections: [
				section([
					sentence({
						text: "Taken together, growth is likely to exceed 8 GW.",
						citations: [],
						inferred: true,
					}),
				]),
			],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(1);
	});

	it("cuts a factual sentence that carries a figure and no citation", async () => {
		const index = indexOf([raw({})]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence({ citations: [] })])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(1);
	});
});

describe("verifyAtlasV2Report — entailment", () => {
	it("asks the model once per non-numeric cited claim and cuts on a no", async () => {
		const index = indexOf([raw({})]);
		const checkEntailment = vi.fn().mockResolvedValue(false);
		const result = await verifyAtlasV2Report({
			sections: [
				section([
					sentence({
						text: "The agency opposes the proposal.",
						citations: [1],
					}),
				]),
			],
			index,
			staleMonths: 18,
			now: NOW,
			checkEntailment,
		});
		expect(checkEntailment).toHaveBeenCalledTimes(1);
		expect(result.entailmentCallCount).toBe(1);
		expect(result.totals.cut).toBe(1);
	});

	it("keeps the claim on a yes, and on an ambiguous answer", async () => {
		const index = indexOf([raw({})]);
		for (const answer of [true, null]) {
			const result = await verifyAtlasV2Report({
				sections: [
					section([
						sentence({
							text: "The agency opposes the proposal.",
							citations: [1],
						}),
					]),
				],
				index,
				staleMonths: 18,
				now: NOW,
				checkEntailment: vi.fn().mockResolvedValue(answer),
			});
			expect(result.totals.cut).toBe(0);
		}
	});

	it("does not ask about a numeric claim — that check is deterministic", async () => {
		const index = indexOf([raw({ snippets: ["Capacity reached 8 GW."] })]);
		const checkEntailment = vi.fn().mockResolvedValue(true);
		await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
			checkEntailment,
		});
		expect(checkEntailment).not.toHaveBeenCalled();
	});
});

describe("verifyAtlasV2Report — rewrite then cut", () => {
	it("keeps a rewritten sentence that now passes", async () => {
		const index = indexOf([
			raw({ snippets: ["Installed solar capacity reached 6,000 MW by June."] }),
		]);
		const rewriteSection = vi
			.fn()
			.mockResolvedValue(
				section([sentence({ text: "Solar capacity reached 6 GW." })]),
			);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
			rewriteSection,
		});
		expect(rewriteSection).toHaveBeenCalledTimes(1);
		expect(result.totals.cut).toBe(0);
		expect(result.sections[0].paragraphs[0][0]).toMatchObject({
			text: "Solar capacity reached 6 GW.",
			rewritten: true,
		});
	});

	it("cuts when the rewrite still fails, and rewrites only once", async () => {
		const index = indexOf([
			raw({ snippets: ["Installed solar capacity reached 6,000 MW by June."] }),
		]);
		const rewriteSection = vi
			.fn()
			.mockResolvedValue(section([sentence({ text: "Still 9 GW." })]));
		const result = await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
			rewriteSection,
		});
		expect(rewriteSection).toHaveBeenCalledTimes(1);
		expect(result.totals.cut).toBe(1);
	});
});

describe("figureCorroboration", () => {
	it("needs two different organisations, not two hosts", () => {
		const mirrored = indexOf([
			raw({ url: "https://example.com/a", snippets: ["Capacity is 8 GW."] }),
			raw({
				url: "https://cdn.example.com/b",
				title: "Different story about capacity",
				snippets: ["Capacity is 8 GW."],
			}),
		]);
		expect(
			figureCorroboration({
				sentence: "Capacity reached 8 GW.",
				sources: mirrored.sources,
			}).organisations,
		).toHaveLength(1);

		const independent = indexOf([
			raw({ url: "https://iea.org/a", snippets: ["Capacity is 8 GW."] }),
			raw({
				url: "https://irena.org/b",
				title: "IRENA capacity statistics",
				snippets: ["Capacity is 8 GW."],
			}),
		]);
		expect(
			figureCorroboration({
				sentence: "Capacity reached 8 GW.",
				sources: independent.sources,
			}).organisations,
		).toHaveLength(2);
	});
});

describe("verifyAtlasV2Report — confidence", () => {
	it("marks a figure two independent organisations state as corroborated", async () => {
		const index = indexOf([
			raw({ url: "https://iea.org/a", snippets: ["Capacity reached 8 GW."] }),
			raw({
				url: "https://irena.org/b",
				title: "IRENA capacity statistics",
				snippets: ["Capacity reached 8 GW."],
			}),
		]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.corroborated).toBe(1);
	});

	it("marks a figure only one organisation states as single", async () => {
		const index = indexOf([
			raw({ url: "https://iea.org/a", snippets: ["Capacity reached 8 GW."] }),
		]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.single).toBe(1);
	});
});

describe("findContradictions", () => {
	const sources = indexOf([
		raw({
			url: "https://iea.org/a",
			snippets: ["Installed solar capacity reached 8 GW across the union."],
		}),
		raw({
			url: "https://irena.org/b",
			title: "IRENA solar capacity review",
			snippets: [
				"Installed solar capacity across the union stands at 6.2 GW this year.",
			],
		}),
	]).sources;

	it("flags two sources cited in the same sentence that disagree", () => {
		const contradictions = findContradictions({
			sentence: "Installed solar capacity reached 8 GW across the union.",
			citedSources: sources,
		});
		expect(contradictions).toEqual([
			expect.objectContaining({
				statedValue: "8 GW",
				statedCitation: 1,
				competingValue: "6.2 GW",
				competingCitation: 2,
			}),
		]);
		expect(contradictions[0].quantity).toContain("8 GW");
	});

	it("never scans a source the sentence does not cite", () => {
		// The defect this replaced: every GW figure in every indexed source was
		// compared against the sentence's figure, which turned one report's
		// Limitations into 26 lines of bogus disagreement.
		expect(
			findContradictions({
				sentence: "Installed solar capacity reached 8 GW across the union.",
				citedSources: [sources[0]],
			}),
		).toEqual([]);
	});

	it("ignores a disagreement in an unrelated passage of a cited source", () => {
		const unrelated = indexOf([
			raw({
				url: "https://iea.org/a",
				snippets: ["Installed solar capacity reached 8 GW across the union."],
			}),
			raw({
				url: "https://irena.org/b",
				title: "IRENA offshore wind pipeline",
				snippets: [
					"Offshore wind tender awards in Japan totalled 6.2 GW of turbine orders.",
				],
			}),
		]).sources;
		expect(
			findContradictions({
				sentence: "Installed solar capacity reached 8 GW across the union.",
				citedSources: unrelated,
			}),
		).toEqual([]);
	});

	it("ignores a cited figure that describes a different year", () => {
		const otherYear = indexOf([
			raw({
				url: "https://iea.org/a",
				snippets: [
					"Installed solar capacity across the union reached 8 GW in 2025.",
				],
			}),
			raw({
				url: "https://irena.org/b",
				title: "IRENA solar capacity review",
				snippets: [
					"Installed solar capacity across the union reached 6.2 GW in 2019.",
				],
			}),
		]).sources;
		expect(
			findContradictions({
				sentence:
					"Installed solar capacity across the union reached 8 GW in 2025.",
				citedSources: otherYear,
			}),
		).toEqual([]);
	});

	it("caps the disagreements Limitations can report", async () => {
		// One sentence can only produce one disagreement now (at most two
		// citations), so the cap is about a report full of them.
		const many = indexOf(
			Array.from({ length: 10 }, (_, position) =>
				raw({
					url: `https://org${position}.example/a`,
					title: `Solar capacity review ${position}`,
					snippets: [
						position % 2 === 0
							? "Installed solar capacity across the union stands at 8 GW."
							: `Installed solar capacity across the union stands at ${position + 2}.5 GW.`,
					],
				}),
			),
		);
		const result = await verifyAtlasV2Report({
			sections: [
				section(
					Array.from({ length: 5 }, (_, position) =>
						sentence({
							text: "Installed solar capacity across the union stands at 8 GW.",
							citations: [position * 2 + 1, position * 2 + 2],
						}),
					),
				),
			],
			index: many,
			staleMonths: 18,
			now: NOW,
			maxContradictions: 3,
		});
		expect(result.contradictions).toHaveLength(3);
	});

	it("does not flag a sentence that already states both figures", async () => {
		const result = await verifyAtlasV2Report({
			sections: [
				section([
					sentence({
						text: "Installed solar capacity across the union reached 8 GW, though another estimate puts it at 6.2 GW.",
						citations: [1, 2],
					}),
				]),
			],
			index: { sources, dropped: [], filteredCount: 0, byQuestion: {} },
			staleMonths: 18,
			now: NOW,
		});
		expect(result.contradictions).toEqual([]);
		expect(result.totals.cut).toBe(0);
	});

	it("cuts a sentence that hides a disagreement between its own sources", async () => {
		const result = await verifyAtlasV2Report({
			sections: [
				section([
					sentence({
						text: "Installed solar capacity reached 8 GW across the union.",
						citations: [1, 2],
					}),
				]),
			],
			index: { sources, dropped: [], filteredCount: 0, byQuestion: {} },
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(1);
		expect(result.contradictions.length).toBeGreaterThan(0);
	});
});

describe("isStaleSource", () => {
	it("is true past the stale window and false inside it", () => {
		const [fresh, old] = indexOf([
			raw({ url: "https://a.example/1", publishedAt: "2026-05-01" }),
			raw({
				url: "https://b.example/2",
				title: "An older capacity report",
				publishedAt: "2023-01-01",
			}),
		]).sources;
		expect(isStaleSource(fresh, 18, NOW)).toBe(false);
		expect(isStaleSource(old, 18, NOW)).toBe(true);
	});

	it("is false when the source carries no date", () => {
		const [undated] = indexOf([raw({ publishedAt: null })]).sources;
		expect(isStaleSource(undated, 18, NOW)).toBe(false);
	});
});

describe("verifyAtlasV2Report — recency and arithmetic", () => {
	it("records a stale citation behind a statistic", async () => {
		const index = indexOf([
			raw({
				url: "https://iea.org/a",
				snippets: ["Capacity reached 8 GW."],
				publishedAt: "2022-01-01",
			}),
		]);
		const result = await verifyAtlasV2Report({
			sections: [section([sentence()])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.staleCitations).toEqual([1]);
	});

	it("marks a derived figure inferred when no calculation ran", async () => {
		const index = indexOf([raw({ snippets: ["Capacity reached 8 GW."] })]);
		const result = await verifyAtlasV2Report({
			sections: [
				section(
					[
						sentence({
							text: "That is 66% of the target.",
							citations: [1],
							calcId: "c1",
						}),
					],
					{
						calculations: [{ id: "c1", expression: "8/12*100", inputs: [1] }],
					},
				),
			],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.totals.cut).toBe(1);
	});

	it("accepts a derived figure that run_python computed", async () => {
		const index = indexOf([raw({ snippets: ["Capacity reached 8 GW."] })]);
		const result = await verifyAtlasV2Report({
			sections: [
				section(
					[
						sentence({
							text: "That is 66.7% of the target.",
							citations: [1],
							calcId: "c1",
						}),
					],
					{
						calculations: [{ id: "c1", expression: "8/12*100", inputs: [1] }],
					},
				),
			],
			index,
			staleMonths: 18,
			now: NOW,
			runCalculation: async () => ({ ok: true, value: "66.666" }),
		});
		expect(result.totals.cut).toBe(0);
		expect(result.totals.single).toBe(1);
	});
});

describe("parseAtlasV2EntailmentAnswer", () => {
	it("reads yes and no in both languages", () => {
		expect(parseAtlasV2EntailmentAnswer("yes")).toBe(true);
		expect(parseAtlasV2EntailmentAnswer("No.")).toBe(false);
		expect(parseAtlasV2EntailmentAnswer("igen")).toBe(true);
		expect(parseAtlasV2EntailmentAnswer("nem")).toBe(false);
	});

	it("returns null when the answer is not a verdict", () => {
		expect(parseAtlasV2EntailmentAnswer("It depends, yes and no")).toBeNull();
		expect(parseAtlasV2EntailmentAnswer("")).toBeNull();
	});
});

describe("parseAtlasV2EntailmentBatchAnswer", () => {
	it("reads an array of verdicts", () => {
		expect(parseAtlasV2EntailmentBatchAnswer('["yes","no","yes"]', 3)).toEqual([
			true,
			false,
			true,
		]);
	});

	it("reads booleans and the object shapes a small model produces", () => {
		expect(parseAtlasV2EntailmentBatchAnswer("[true, false]", 2)).toEqual([
			true,
			false,
		]);
		expect(
			parseAtlasV2EntailmentBatchAnswer(
				'[{"i":1,"answer":"yes"},{"i":2,"entailed":false}]',
				2,
			),
		).toEqual([true, false]);
	});

	it("reads an array wrapped in a code fence or surrounding prose", () => {
		expect(
			parseAtlasV2EntailmentBatchAnswer('```json\n["yes","no"]\n```', 2),
		).toEqual([true, false]);
		expect(
			parseAtlasV2EntailmentBatchAnswer('Here you go: ["no","no"]', 2),
		).toEqual([false, false]);
	});

	it("returns null on the wrong length or unreadable output, so the caller falls back", () => {
		expect(parseAtlasV2EntailmentBatchAnswer('["yes"]', 3)).toBeNull();
		expect(parseAtlasV2EntailmentBatchAnswer("not json at all", 2)).toBeNull();
		expect(parseAtlasV2EntailmentBatchAnswer('{"answer":"yes"}', 1)).toBeNull();
	});

	it("reads an unrecognisable entry as null rather than a verdict", () => {
		expect(parseAtlasV2EntailmentBatchAnswer('["yes", 42]', 2)).toEqual([
			true,
			null,
		]);
	});
});

describe("verifyAtlasV2Report — batched entailment", () => {
	// No digits anywhere: a numeric claim is checked deterministically and never
	// reaches the entailment path at all.
	const claims = (count: number) =>
		Array.from({ length: count }, (_, position) =>
			sentence({
				text: `The agency restated its opposition in reply number ${"a".repeat(position + 1)}.`,
				citations: [1],
			}),
		);

	it("checks many claims in one call", async () => {
		const index = indexOf([raw({})]);
		const checkEntailmentBatch = vi.fn(
			async (items: Array<{ claim: string }>) => items.map(() => true),
		);
		const checkEntailment = vi.fn().mockResolvedValue(true);
		const result = await verifyAtlasV2Report({
			sections: [section(claims(7))],
			index,
			staleMonths: 18,
			now: NOW,
			checkEntailment,
			checkEntailmentBatch,
			entailmentBatchSize: 10,
		});
		expect(checkEntailmentBatch).toHaveBeenCalledTimes(1);
		expect(checkEntailment).not.toHaveBeenCalled();
		expect(result.entailmentCallCount).toBe(7);
		expect(result.entailmentBatchCount).toBe(1);
		expect(result.totals.cut).toBe(0);
	});

	it("splits the claims into batches of the configured size", async () => {
		const index = indexOf([raw({})]);
		const checkEntailmentBatch = vi.fn(
			async (items: Array<{ claim: string }>) => items.map(() => true),
		);
		const result = await verifyAtlasV2Report({
			sections: [section(claims(7))],
			index,
			staleMonths: 18,
			now: NOW,
			checkEntailmentBatch,
			entailmentBatchSize: 3,
		});
		expect(checkEntailmentBatch).toHaveBeenCalledTimes(3);
		expect(result.entailmentBatchCount).toBe(3);
	});

	it("cuts the claim the batch answered no for, and only that one", async () => {
		const index = indexOf([raw({})]);
		const result = await verifyAtlasV2Report({
			sections: [section(claims(3))],
			index,
			staleMonths: 18,
			now: NOW,
			checkEntailmentBatch: async () => [true, false, true],
			entailmentBatchSize: 10,
		});
		expect(result.totals.cut).toBe(1);
		expect(result.sections[0].paragraphs[0]).toHaveLength(2);
	});

	it("falls back to one call per claim when the batch answer does not parse", async () => {
		const index = indexOf([raw({})]);
		const checkEntailment = vi.fn().mockResolvedValue(true);
		const result = await verifyAtlasV2Report({
			sections: [section(claims(3))],
			index,
			staleMonths: 18,
			now: NOW,
			checkEntailment,
			checkEntailmentBatch: async () => null,
			entailmentBatchSize: 10,
		});
		expect(checkEntailment).toHaveBeenCalledTimes(3);
		expect(result.totals.cut).toBe(0);
	});

	it("falls back when the batch throws", async () => {
		const index = indexOf([raw({})]);
		const checkEntailment = vi.fn().mockResolvedValue(false);
		const result = await verifyAtlasV2Report({
			sections: [section(claims(2))],
			index,
			staleMonths: 18,
			now: NOW,
			checkEntailment,
			checkEntailmentBatch: async () => {
				throw new Error("the model timed out");
			},
			entailmentBatchSize: 10,
		});
		expect(checkEntailment).toHaveBeenCalledTimes(2);
		expect(result.totals.cut).toBe(2);
	});
});

describe("trimSentenceCitations", () => {
	const index = indexOf([
		raw({
			url: "https://a.example/1",
			title: "First capacity report",
			snippets: [
				"This report walks through grid connection queues and permitting without giving a capacity figure.",
			],
		}),
		raw({
			url: "https://b.example/2",
			title: "Second capacity report",
			snippets: [
				"Installed solar capacity reached 8 GW according to the transmission operators.",
			],
		}),
		raw({
			url: "https://c.example/3",
			title: "Third capacity report",
			snippets: [
				"A qualitative discussion of member-state policy with nothing numeric in it.",
			],
		}),
	]);
	const byNumber = new Map(index.sources.map((source) => [source.n, source]));

	it("leaves one or two citations alone", () => {
		expect(
			trimSentenceCitations({
				sentence: sentence({ citations: [1, 2] }),
				sourcesByNumber: byNumber,
			}),
		).toEqual([1, 2]);
	});

	it("keeps at most two, preferring the source that states the figure", () => {
		expect(
			trimSentenceCitations({
				sentence: sentence({ citations: [1, 3, 2] }),
				sourcesByNumber: byNumber,
			}),
		).toEqual([1, 2]);
	});

	it("keeps the writer's order among equally useful sources", () => {
		expect(
			trimSentenceCitations({
				sentence: sentence({
					text: "The agency published its response.",
					citations: [3, 1, 2],
				}),
				sourcesByNumber: byNumber,
			}),
		).toEqual([3, 1]);
	});

	it("caps citation density on every sentence the verifier keeps", async () => {
		const result = await verifyAtlasV2Report({
			sections: [section([sentence({ citations: [1, 2, 3] })])],
			index,
			staleMonths: 18,
			now: NOW,
		});
		expect(result.sections[0].paragraphs[0][0].citations).toEqual([1, 2]);
	});
});

describe("checkAtlasV2CoreAnswer", () => {
	const summary = (
		sentences: Array<{ text: string; citations: number[] }>,
	): AtlasV2VerifiedSection => ({
		sectionId: "summary",
		title: "summary",
		paragraphs: [
			sentences.map((entry) => ({
				sectionId: "summary",
				text: entry.text,
				citations: entry.citations,
				confidence: "single" as const,
				failures: [],
				kept: true,
				rewritten: false,
			})),
		],
	});

	it("is absent when the summary cites none of the core question's evidence", () => {
		expect(
			checkAtlasV2CoreAnswer({
				summary: summary([
					{ text: "Germany led the member states.", citations: [9] },
				]),
				coreSourceNumbers: [1, 2],
			}),
		).toEqual({ present: false, citedFigure: false });
	});

	it("is present, with a figure, when a cited core sentence carries one", () => {
		expect(
			checkAtlasV2CoreAnswer({
				summary: summary([
					{ text: "The EU added 65.1 GW in that year.", citations: [2] },
				]),
				coreSourceNumbers: [1, 2],
			}),
		).toEqual({ present: true, citedFigure: true });
	});

	it("is present without a figure when the core answer is not numeric", () => {
		expect(
			checkAtlasV2CoreAnswer({
				summary: summary([
					{ text: "The guideline names metformin first-line.", citations: [1] },
				]),
				coreSourceNumbers: [1],
			}),
		).toEqual({ present: true, citedFigure: false });
	});

	it("falls back to any cited sentence when the core question found no sources", () => {
		expect(
			checkAtlasV2CoreAnswer({
				summary: summary([{ text: "Something cited.", citations: [4] }]),
				coreSourceNumbers: [],
			}).present,
		).toBe(true);
	});

	it("is absent when there is no summary at all", () => {
		expect(
			checkAtlasV2CoreAnswer({ summary: null, coreSourceNumbers: [1] }),
		).toEqual({ present: false, citedFigure: false });
	});
});
