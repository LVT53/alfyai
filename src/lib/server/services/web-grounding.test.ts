import { describe, expect, it } from "vitest";
import type { ResearchResult } from "$lib/server/services/web-research";
import {
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	extractAssistantWebCitationUrls,
	extractGroundedWebCitationSources,
} from "./web-grounding";

function researchResult(): ResearchResult {
	return {
		query: "current product price",
		queries: [{ query: "official current product price", purpose: "official" }],
		sources: [
			{
				id: "source-1",
				provider: "searxng",
				title: "Official Product Page",
				url: "https://www.example.com/product?utm_source=search",
				canonicalUrl: "https://example.com/product",
				snippet: "Current price is $799.",
				highlights: ["Current price is $799."],
				text: "RAW PAGE TEXT SHOULD NOT REACH MODEL PAYLOAD",
				score: 0.94,
				providerRank: 1,
				query: "official current product price",
				publishedAt: null,
				updatedAt: "2026-06-01T10:00:00.000Z",
				retrievedAt: "2026-06-04T10:00:00.000Z",
				authorityClass: "official",
				authorityScore: 0.96,
			},
		],
		evidence: [
			{
				id: "evidence-1",
				sourceId: "source-1",
				title: "Official Product Page",
				url: "https://www.example.com/product?utm_source=search",
				provider: "searxng",
				quote: "Current price is $799.",
				surroundingText: "RAW SURROUNDING TEXT SHOULD NOT REACH MODEL PAYLOAD",
				score: 0.91,
				authorityScore: 0.96,
			},
		],
		answerBrief: {
			markdown: "Use [Official Product Page](https://www.example.com/product).",
			instructions: ["Only cite returned source URLs."],
			sources: [],
			evidence: [],
		},
		diagnostics: {
			mode: "exact",
			freshness: "live",
			sourcePolicy: "commerce",
			providers: { searxngConfigured: true },
			plannedQueryCount: 1,
			directUrlCount: 0,
			fetchedSourceCount: 1,
			fusedSourceCount: 1,
			selectedSourceCount: 1,
			providerCalls: [],
			contentCharBudget: 12_000,
			openedPageCount: 1,
			sourceReranked: false,
			evidenceCandidateCount: 1,
			exactEvidenceCandidateCount: 1,
			reranked: true,
			youtubeTranscriptCandidateCount: 0,
			youtubeTranscriptFetchedCount: 0,
			youtubeTranscriptFailedCount: 0,
			youtubeTranscriptErrors: [],
			fallbackReasons: [],
		},
	};
}

describe("web grounding", () => {
	it("builds the model-safe research_web payload without raw source text", () => {
		const payload = buildGroundedWebModelPayload(researchResult());

		expect(payload).toMatchObject({
			success: true,
			name: "research_web",
			sourceType: "web",
			query: "current product price",
			answerBrief: {
				sourceCount: 1,
				evidenceCount: 1,
			},
			diagnostics: {
				mode: "exact",
				freshness: "live",
				sourcePolicy: "commerce",
			},
		});
		expect(payload.sources[0]).toMatchObject({
			id: "source-1",
			title: "Official Product Page",
			url: "https://www.example.com/product?utm_source=search",
			authorityClass: "official",
		});
		expect(payload.evidence[0]).toMatchObject({
			id: "evidence-1",
			sourceId: "source-1",
			quote: "Current price is $799.",
		});
		expect(JSON.stringify(payload)).not.toContain("RAW PAGE TEXT");
		expect(JSON.stringify(payload)).not.toContain("RAW SURROUNDING TEXT");
	});

	it("creates citation-ready candidates and deduped canonical audit sources", () => {
		const candidates = createGroundedWebCandidates(researchResult());
		const firstCandidate = candidates[0];
		expect(firstCandidate).toBeDefined();
		if (!firstCandidate) throw new Error("Expected grounded web candidate");
		const sources = extractGroundedWebCitationSources([
			{
				callId: "call-1",
				name: "research_web",
				input: { query: "current product price" },
				status: "done",
				sourceType: "web",
				outputSummary: "Found sources",
				candidates: [
					...candidates,
					{
						...firstCandidate,
						id: "duplicate-source",
						url: "https://example.com/product?utm_campaign=chat",
					},
				],
			},
		]);

		expect(candidates[0]).toMatchObject({
			id: "source-1",
			title: "Official Product Page",
			url: "https://www.example.com/product?utm_source=search",
			snippet: "Current price is $799.",
			sourceType: "web",
			material: true,
		});
		expect(sources).toEqual([
			{
				id: "source-1",
				title: "Official Product Page",
				url: "https://www.example.com/product?utm_source=search",
				canonicalUrl: "https://example.com/product",
				host: "example.com",
			},
		]);
	});

	it("marks zero-source research results as not evidence-ready", () => {
		const result = researchResult();
		result.sources = [];
		result.evidence = [];

		expect(createGroundedWebMetadata(result)).toMatchObject({
			ok: true,
			evidenceReady: false,
			sourceCount: 0,
			evidenceCount: 0,
			mode: "exact",
			freshness: "live",
		});
	});

	it("marks source-only research results without snippets as not evidence-ready", () => {
		const result = researchResult();
		const firstSource = result.sources[0];
		expect(firstSource).toBeDefined();
		if (!firstSource) throw new Error("Expected research source");
		result.sources = [
			{
				...firstSource,
				snippet: null,
				highlights: [],
				text: null,
			},
		];
		result.evidence = [];

		expect(createGroundedWebMetadata(result)).toMatchObject({
			ok: true,
			evidenceReady: false,
			sourceCount: 1,
			evidenceCount: 0,
		});
		expect(buildGroundedWebModelPayload(result)).toMatchObject({
			success: false,
			answerBrief: {
				sourceCount: 1,
				evidenceCount: 0,
			},
			diagnostics: {
				fallbackReasons: [],
			},
		});
	});

	it("extracts markdown and bare web citation URLs for audit handoff", () => {
		expect(
			extractAssistantWebCitationUrls(
				"See [official](https://example.com/product). Mirror: https://cdn.example.net/item.",
			),
		).toEqual(["https://example.com/product", "https://cdn.example.net/item."]);
	});
});
