import { describe, expect, it } from "vitest";
import {
	ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
	buildAtlasEvidencePacks,
} from "./evidence-packs";

describe("Atlas evidence packs", () => {
	it("builds stable compact packs for explicit local sources with highest authority", () => {
		const longLocalText = [
			"Internal rollout playbook: regulated SaaS teams must keep lexical retrieval for exact compliance terms and vector retrieval for concept discovery.",
			"Reranking is required before final answer generation because broad retrieval can include stale policy drafts.",
			"This line should be compacted rather than persisted as an unbounded raw source dump.",
			"Extra operational detail ".repeat(80),
		].join(" ");

		const first = buildAtlasEvidencePacks({
			query: "Compare retrieval architectures for regulated SaaS",
			currentDate: "2026-06-21",
			curatedEvidence:
				"Curated fact: hybrid retrieval is the preferred architecture.",
			localSources: [
				{
					id: "artifact-explicit-1",
					title: "Internal rollout playbook",
					authority: "explicit",
					text: longLocalText,
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});
		const second = buildAtlasEvidencePacks({
			query: "Compare retrieval architectures for regulated SaaS",
			currentDate: "2026-06-21",
			curatedEvidence:
				"Curated fact: hybrid retrieval is the preferred architecture.",
			localSources: [
				{
					id: "artifact-explicit-1",
					title: "Internal rollout playbook",
					authority: "explicit",
					text: longLocalText,
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});

		expect(first.version).toBe(ATLAS_EVIDENCE_PACK_SCHEMA_VERSION);
		expect(first.evidencePacks).toHaveLength(1);
		expect(first.evidencePacks[0]).toMatchObject({
			version: ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
			sourceKind: "local",
			authority: "explicit_local",
			sourceRefs: [
				{
					id: "artifact-explicit-1",
					title: "Internal rollout playbook",
					kind: "local",
					authority: "explicit_local",
				},
			],
			supportedQuestions: [
				"Compare retrieval architectures for regulated SaaS",
			],
			freshness: {
				asOfDate: null,
				retrievedAt: null,
				isCurrentEvidence: true,
				parentAtlasJobId: null,
			},
		});
		expect(first.evidencePacks[0].evidence.excerpt.length).toBeLessThan(900);
		expect(first.evidencePacks[0].evidence.excerpt).not.toContain(
			"Extra operational detail Extra operational detail Extra operational detail Extra operational detail Extra operational detail Extra operational detail",
		);
		expect(first.evidencePacks[0].id).toBe(second.evidencePacks[0].id);
	});

	it("collapses duplicate web sources and records freshness metadata", () => {
		const result = buildAtlasEvidencePacks({
			query: "What changed in AI regulation this year?",
			currentDate: "2026-06-21",
			curatedEvidence:
				"Curated fact: current reporting says regulators updated enforcement guidance.",
			localSources: [],
			webSources: [
				{
					id: "web-a",
					title: "AI Regulation Update",
					url: "https://example.com/report?b=2&a=1#section",
					snippet:
						"Fetched page excerpt: Current reporting from 2026-06-20 says regulators updated enforcement guidance for AI systems.",
				},
				{
					id: "web-b",
					title: "AI Regulation Update duplicate",
					url: "https://example.com/report?a=1&b=2",
					snippet:
						"Search result snippet: Duplicate result for the same reporting.",
				},
			],
			searchLimitation: null,
			parentSeed: null,
		});

		expect(result.evidencePacks).toHaveLength(1);
		expect(result.evidencePacks[0]).toMatchObject({
			sourceKind: "web",
			authority: "accepted_web",
			sourceRefs: [
				expect.objectContaining({ id: "web-a", kind: "web" }),
				expect.objectContaining({ id: "web-b", kind: "web" }),
			],
			freshness: {
				asOfDate: "2026-06-20",
				retrievedAt: "2026-06-21",
				isCurrentEvidence: true,
				parentAtlasJobId: null,
			},
		});
		expect(result.evidencePacks[0].evidence.summary).toContain(
			"Current reporting",
		);
	});

	it("represents parent seed evidence without treating it as fresh current evidence", () => {
		const result = buildAtlasEvidencePacks({
			query: "Revise the prior Atlas report for current deployment risks",
			currentDate: "2026-06-21",
			curatedEvidence: "",
			localSources: [],
			webSources: [],
			searchLimitation: null,
			parentSeed: {
				parentAtlasJobId: "atlas-parent-1",
				compressedFindings: {
					synthesize:
						"Parent report found that hybrid retrieval reduced noisy matches, but it was written before the new deployment deadline.",
				},
				curatedSourcePool: null,
				checkpoint: {},
				documentSourceSummary: {},
			},
		});

		expect(result.evidencePacks).toHaveLength(1);
		expect(result.evidencePacks[0]).toMatchObject({
			sourceKind: "local",
			authority: "parent_seed",
			sourceRefs: [
				{
					id: "parent:atlas-parent-1:compressed-findings",
					title: "Parent Atlas compressed findings",
					kind: "local",
					authority: "parent_seed",
				},
			],
			freshness: {
				asOfDate: null,
				retrievedAt: null,
				isCurrentEvidence: false,
				parentAtlasJobId: "atlas-parent-1",
			},
			limitations: [
				expect.stringContaining(
					"Parent Atlas seed evidence is context, not fresh current evidence",
				),
			],
		});
	});

	it("records a diagnostic instead of fabricating packs when no evidence is available", () => {
		const result = buildAtlasEvidencePacks({
			query: "Research a topic with no available sources",
			currentDate: "2026-06-21",
			curatedEvidence: "",
			localSources: [],
			webSources: [],
			searchLimitation: {
				code: "atlas_search_unavailable",
				message: "Search endpoint unavailable.",
			},
			parentSeed: null,
		});

		expect(result.evidencePacks).toEqual([]);
		expect(result.diagnostics).toEqual([
			{
				code: "atlas_evidence_packs_empty",
				severity: "warning",
				message:
					"No accepted Atlas sources or parent seed findings were available for Evidence Pack creation.",
			},
			{
				code: "atlas_search_unavailable",
				severity: "warning",
				message: "Search endpoint unavailable.",
			},
		]);
	});
});
