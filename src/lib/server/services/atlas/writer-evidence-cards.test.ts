import { describe, expect, it, vi } from "vitest";
import type {
	AtlasEvidencePack,
	AtlasSectionBrief,
	AtlasWriterEvidenceCard,
} from "./types";
import {
	ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
	type AtlasWriterEvidenceCardReranker,
	buildAtlasWriterEvidenceCards,
	routeAtlasWriterEvidenceCards,
} from "./writer-evidence-cards";

function evidencePack(
	overrides: Partial<AtlasEvidencePack> = {},
): AtlasEvidencePack {
	return {
		version: "atlas.evidence-pack.v1",
		id: "pack-official-retrieval",
		sourceRefs: [
			{
				id: "web-official-1",
				kind: "web",
				title: "NIST AI retrieval guidance",
				url: "https://www.nist.gov/artificial-intelligence/retrieval-guidance",
				authority: "accepted_web",
			},
		],
		sourceKind: "web",
		authority: "accepted_web",
		supportedFacets: ["retrieval architecture", "regulated SaaS"],
		supportedQuestions: [
			"Which retrieval architecture should a regulated SaaS team use?",
		],
		evidence: {
			summary:
				"Official guidance says regulated teams should preserve exact policy matching while documenting evaluation and monitoring controls.",
			excerpt:
				"Fetched page excerpt: Official guidance says regulated teams should preserve exact policy matching. Navigation boilerplate ".repeat(
					30,
				),
		},
		conflicts: [],
		limitations: [],
		freshness: {
			asOfDate: "2026-05-10",
			retrievedAt: "2026-06-21",
			isCurrentEvidence: true,
			parentAtlasJobId: null,
			note: null,
		},
		affectedSectionHint: "Recommended architecture",
		versionNote: "test fixture",
		...overrides,
	};
}

describe("Atlas writer evidence cards", () => {
	function buildRoutingCards(): AtlasWriterEvidenceCard[] {
		return buildAtlasWriterEvidenceCards({
			evidencePacks: [
				evidencePack({
					id: "pack-alpha-vector",
					sourceRefs: [
						{
							id: "web-alpha-vector",
							kind: "web",
							title: "Alpha vector retrieval notes",
							url: "https://example.com/alpha-vector",
							authority: "accepted_web",
						},
					],
					evidence: {
						summary:
							"Vector retrieval broadens semantic recall but needs exact-match safeguards for compliance terms.",
						excerpt:
							"Vector retrieval broadens semantic recall for enterprise assistants.",
					},
					affectedSectionHint: "Retrieval options",
				}),
				evidencePack({
					id: "pack-zeta-hybrid",
					sourceRefs: [
						{
							id: "web-zeta-hybrid",
							kind: "web",
							title: "Zeta hybrid retrieval guide",
							url: "https://example.com/zeta-hybrid",
							authority: "accepted_web",
						},
					],
					evidence: {
						summary:
							"Hybrid retrieval preserves exact policy language while adding semantic discovery and reranking.",
						excerpt:
							"Hybrid retrieval combines lexical retrieval, vector retrieval, and reranking.",
					},
					affectedSectionHint: "Recommended architecture",
				}),
			],
		}).writerEvidenceCards;
	}

	it("distills Evidence Packs into bounded traceable writer cards", () => {
		const first = buildAtlasWriterEvidenceCards({
			evidencePacks: [
				evidencePack({
					sourceRefs: [
						{
							id: "web-official-1",
							kind: "web",
							title: "NIST AI retrieval guidance",
							url: "https://www.nist.gov/artificial-intelligence/retrieval-guidance",
							authority: "accepted_web",
						},
						{
							id: "web-official-1",
							kind: "web",
							title: "NIST AI retrieval guidance",
							url: "https://www.nist.gov/artificial-intelligence/retrieval-guidance",
							authority: "accepted_web",
						},
					],
					conflicts: [
						"Vendor benchmark results conflict with independent evaluations for latency under load.",
					],
					limitations: [
						"The guidance covers regulated controls but does not benchmark specific vector databases.",
					],
				}),
			],
		});
		const second = buildAtlasWriterEvidenceCards({
			evidencePacks: [evidencePack()],
		});

		expect(first.version).toBe(ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION);
		expect(first.writerEvidenceCards).toHaveLength(1);
		expect(first.writerEvidenceCards[0]).toMatchObject({
			version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
			sourceTitle: "NIST AI retrieval guidance",
			url: "https://www.nist.gov/artificial-intelligence/retrieval-guidance",
			authority: "official",
			supportsSections: ["Recommended architecture"],
			evidencePackIds: ["pack-official-retrieval"],
			sourceRefs: [
				{
					id: "web-official-1",
					kind: "web",
					title: "NIST AI retrieval guidance",
					url: "https://www.nist.gov/artificial-intelligence/retrieval-guidance",
					authority: "accepted_web",
				},
			],
		});
		expect(first.writerEvidenceCards[0].id).toBe(
			second.writerEvidenceCards[0].id,
		);
		expect(first.writerEvidenceCards[0].relevantFacts.length).toBeGreaterThan(
			0,
		);
		expect(
			first.writerEvidenceCards[0].relevantFacts.length,
		).toBeLessThanOrEqual(4);
		for (const fact of first.writerEvidenceCards[0].relevantFacts) {
			expect(fact.length).toBeLessThanOrEqual(240);
			expect(fact).not.toContain("Fetched page excerpt");
			expect(fact).not.toContain(
				"Navigation boilerplate Navigation boilerplate Navigation boilerplate",
			);
		}
		expect(first.writerEvidenceCards[0].limitations).toEqual([
			"The guidance covers regulated controls but does not benchmark specific vector databases.",
		]);
		expect(first.writerEvidenceCards[0].conflicts).toEqual([
			"Vendor benchmark results conflict with independent evaluations for latency under load.",
		]);
	});

	it("marks parent seed evidence as stale context rather than fresh evidence", () => {
		const result = buildAtlasWriterEvidenceCards({
			evidencePacks: [
				evidencePack({
					id: "pack-parent-seed",
					sourceRefs: [
						{
							id: "parent:atlas-parent-1:compressed-findings",
							kind: "local",
							title: "Parent Atlas compressed findings",
							url: null,
							authority: "parent_seed",
						},
					],
					sourceKind: "local",
					authority: "parent_seed",
					freshness: {
						asOfDate: null,
						retrievedAt: null,
						isCurrentEvidence: false,
						parentAtlasJobId: "atlas-parent-1",
						note: null,
					},
					limitations: [],
					affectedSectionHint: "Prior findings",
				}),
			],
		});

		expect(result.writerEvidenceCards).toEqual([
			expect.objectContaining({
				authority: "parent_seed",
				sourceTitle: "Parent Atlas compressed findings",
				url: null,
				supportsSections: ["Prior findings"],
				evidencePackIds: ["pack-parent-seed"],
				freshnessNote: expect.stringContaining("not fresh current evidence"),
				limitations: [
					expect.stringContaining(
						"Parent seed evidence is context, not fresh current evidence",
					),
				],
			}),
		]);
	});

	it("records a diagnostic instead of fabricating cards without Evidence Packs", () => {
		const result = buildAtlasWriterEvidenceCards({ evidencePacks: [] });

		expect(result).toEqual({
			version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
			writerEvidenceCards: [],
			diagnostics: [
				{
					code: "atlas_writer_evidence_cards_empty",
					severity: "warning",
					message:
						"No Atlas Evidence Packs were available for Writer Evidence Card creation.",
				},
			],
		});
	});

	it("routes cards with the injected TEI reranker without storing scores", async () => {
		const deterministicCards = buildRoutingCards();
		const reranker = vi
			.fn<AtlasWriterEvidenceCardReranker>()
			.mockResolvedValue({
				items: [
					{ item: deterministicCards[1], index: 1, score: 0.94 },
					{ item: deterministicCards[0], index: 0, score: 0.22 },
				],
			});

		const result = await routeAtlasWriterEvidenceCards({
			writerEvidenceCards: deterministicCards,
			userQuery:
				"Which retrieval architecture should a regulated SaaS assistant use?",
			sectionBriefs: [],
			reranker,
		});

		expect(deterministicCards.map((card) => card.sourceTitle)).toEqual([
			"Alpha vector retrieval notes",
			"Zeta hybrid retrieval guide",
		]);
		expect(result.writerEvidenceCards.map((card) => card.sourceTitle)).toEqual([
			"Zeta hybrid retrieval guide",
			"Alpha vector retrieval notes",
		]);
		expect(JSON.stringify(result.writerEvidenceCards)).not.toMatch(
			/"score"|"confidence"|0\.94|0\.22/i,
		);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "atlas_writer_evidence_cards_routing_reranked",
				severity: "info",
			}),
		]);
	});

	it("falls back to deterministic routing when TEI returns null, empty results, or throws", async () => {
		const deterministicCards = buildRoutingCards();
		const expectedTitles = deterministicCards.map((card) => card.sourceTitle);
		const cases: Array<{
			label: string;
			reranker: AtlasWriterEvidenceCardReranker;
		}> = [
			{
				label: "null",
				reranker: vi
					.fn<AtlasWriterEvidenceCardReranker>()
					.mockResolvedValue(null),
			},
			{
				label: "empty",
				reranker: vi.fn<AtlasWriterEvidenceCardReranker>().mockResolvedValue({
					items: [],
				}),
			},
			{
				label: "throw",
				reranker: vi
					.fn<AtlasWriterEvidenceCardReranker>()
					.mockRejectedValue(
						new Error("RAW_CARD_TEXT_SENTINEL should stay out of diagnostics"),
					),
			},
		];

		for (const fallbackCase of cases) {
			const result = await routeAtlasWriterEvidenceCards({
				writerEvidenceCards: deterministicCards,
				userQuery: `Regulated SaaS retrieval routing ${fallbackCase.label}`,
				sectionBriefs: [],
				reranker: fallbackCase.reranker,
			});

			expect(
				result.writerEvidenceCards.map((card) => card.sourceTitle),
			).toEqual(expectedTitles);
			expect(result.diagnostics).toEqual([
				expect.objectContaining({
					code: "atlas_writer_evidence_cards_routing_fallback",
					severity: "info",
				}),
			]);
			expect(JSON.stringify(result.diagnostics)).not.toMatch(
				/RAW_CARD_TEXT_SENTINEL|score|confidence/i,
			);
		}
	});

	it("adds top section matches while preserving existing section support", async () => {
		const deterministicCards = buildAtlasWriterEvidenceCards({
			evidencePacks: [
				evidencePack({
					id: "pack-governance",
					sourceRefs: [
						{
							id: "web-governance",
							kind: "web",
							title: "Governance logging guide",
							url: "https://example.com/governance",
							authority: "accepted_web",
						},
					],
					evidence: {
						summary:
							"Governance logging keeps retrieval evidence auditable for regulated teams.",
						excerpt:
							"Governance logging keeps exact retrieval evidence auditable.",
					},
					affectedSectionHint: "Governance",
				}),
				evidencePack({
					id: "pack-latency",
					sourceRefs: [
						{
							id: "web-latency",
							kind: "web",
							title: "Latency benchmark notes",
							url: "https://example.com/latency",
							authority: "accepted_web",
						},
					],
					evidence: {
						summary:
							"Latency benchmarks show reranking narrows candidates but adds measurable response-time cost.",
						excerpt:
							"Latency benchmarks compare reranking and no-reranking retrieval paths.",
					},
					affectedSectionHint: null,
				}),
			],
		}).writerEvidenceCards;
		const sectionBriefs: AtlasSectionBrief[] = [
			{
				sectionTitle: "Latency Analysis",
				brief:
					"Explains response-time tradeoffs and benchmark implications for reranking.",
				evidencePackIds: [],
				sourceAssociations: [],
				limitations: [],
			},
		];
		const reranker = vi.fn<AtlasWriterEvidenceCardReranker>(async (params) => {
			const latencyIndex = params.items.findIndex(
				(card) => card.sourceTitle === "Latency benchmark notes",
			);
			if (params.query.includes("Latency Analysis")) {
				return {
					items: [
						{
							item: params.items[latencyIndex],
							index: latencyIndex,
							score: 0.91,
						},
					],
				};
			}
			return {
				items: params.items.map((item, index) => ({
					item,
					index,
					score: 1 - index / 10,
				})),
			};
		});

		const result = await routeAtlasWriterEvidenceCards({
			writerEvidenceCards: deterministicCards,
			userQuery:
				"Compare governance and latency tradeoffs for retrieval reranking",
			sectionBriefs,
			reranker,
		});

		expect(
			result.writerEvidenceCards.find(
				(card) => card.sourceTitle === "Governance logging guide",
			)?.supportsSections,
		).toContain("Governance");
		expect(
			result.writerEvidenceCards.find(
				(card) => card.sourceTitle === "Latency benchmark notes",
			)?.supportsSections,
		).toContain("Latency Analysis");
	});

	it("keeps routing diagnostics free of raw card text, source titles, and TEI scores", async () => {
		const deterministicCards = buildAtlasWriterEvidenceCards({
			evidencePacks: [
				evidencePack({
					id: "pack-raw-diagnostic-sentinel",
					sourceRefs: [
						{
							id: "web-raw-diagnostic-sentinel",
							kind: "web",
							title: "RAW_SOURCE_TITLE_SENTINEL",
							url: "https://example.com/raw-diagnostic-sentinel",
							authority: "accepted_web",
						},
					],
					evidence: {
						summary:
							"RAW_CARD_TEXT_SENTINEL should be model-facing evidence, not routing diagnostics.",
						excerpt:
							"RAW_CARD_TEXT_SENTINEL appears in the evidence card body only.",
					},
				}),
			],
		}).writerEvidenceCards;
		const reranker = vi
			.fn<AtlasWriterEvidenceCardReranker>()
			.mockResolvedValue({
				items: [{ item: deterministicCards[0], index: 0, score: 0.87654321 }],
			});

		const result = await routeAtlasWriterEvidenceCards({
			writerEvidenceCards: deterministicCards,
			userQuery: "Route evidence without leaking raw text",
			sectionBriefs: [],
			reranker,
		});
		const diagnostics = JSON.stringify(result.diagnostics);

		expect(diagnostics).not.toMatch(
			/RAW_SOURCE_TITLE_SENTINEL|RAW_CARD_TEXT_SENTINEL|0\.87654321|score|confidence/i,
		);
	});
});
