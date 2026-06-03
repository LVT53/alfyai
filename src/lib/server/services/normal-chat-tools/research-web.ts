import { z } from "zod";

import type { ResearchResult } from "$lib/server/services/web-research";
import type { ToolCallEntry, ToolEvidenceCandidate } from "$lib/types";

import { optionalScalarMetadata, truncateText } from "./shared";

export const researchWebInputSchema = z.object({
	query: z.string().min(1),
	mode: z.enum(["quick", "research", "exact"]).optional(),
	freshness: z.enum(["auto", "live", "recent", "cache"]).optional(),
	sourcePolicy: z
		.enum([
			"general",
			"technical",
			"news",
			"commerce",
			"medical_legal_financial",
		])
		.optional(),
	maxSources: z.number().int().min(1).max(12).optional(),
	quoteRequired: z.boolean().optional(),
});

export type ResearchWebInput = z.infer<typeof researchWebInputSchema>;

export function sanitizeResearchWebInput(
	input: ResearchWebInput,
): ResearchWebInput {
	return {
		query: input.query,
		...(input.mode ? { mode: input.mode } : {}),
		...(input.freshness ? { freshness: input.freshness } : {}),
		...(input.sourcePolicy ? { sourcePolicy: input.sourcePolicy } : {}),
		...(input.maxSources ? { maxSources: input.maxSources } : {}),
		...(input.quoteRequired !== undefined
			? { quoteRequired: input.quoteRequired }
			: {}),
	};
}

export function compactResearchWebModelPayload(result: ResearchResult) {
	const sources = result.sources.slice(0, 8).map((source) => ({
		id: source.id,
		title: truncateText(source.title, 180),
		url: truncateText(source.url, 500),
		provider: source.provider,
		authorityClass: source.authorityClass,
		authorityScore: source.authorityScore,
		publishedAt: source.publishedAt,
		updatedAt: source.updatedAt,
		...(source.snippet ? { snippet: truncateText(source.snippet, 500) } : {}),
		...(source.youtubeTranscript
			? { youtubeTranscript: source.youtubeTranscript }
			: {}),
	}));
	const evidence = result.evidence.slice(0, 12).map((item) => ({
		id: item.id,
		sourceId: item.sourceId,
		title: truncateText(item.title, 180),
		url: truncateText(item.url, 500),
		provider: item.provider,
		quote: truncateText(item.quote, 500),
		score: item.score,
	}));

	return {
		success: true as const,
		name: "research_web",
		sourceType: "web",
		query: result.query,
		queries: result.queries.slice(0, 6).map((query) => query.query),
		answerBrief: {
			instructions: result.answerBrief.instructions
				.slice(0, 8)
				.map((instruction) => truncateText(instruction, 240)),
			sourceCount: sources.length,
			evidenceCount: evidence.length,
		},
		answerBriefMarkdown: truncateText(result.answerBrief.markdown, 12000),
		sources,
		evidence,
		diagnostics: {
			mode: result.diagnostics.mode,
			freshness: result.diagnostics.freshness,
			sourcePolicy: result.diagnostics.sourcePolicy,
			plannedQueryCount: result.diagnostics.plannedQueryCount,
			fetchedSourceCount: result.diagnostics.fetchedSourceCount,
			fusedSourceCount: result.diagnostics.fusedSourceCount,
			selectedSourceCount: result.diagnostics.selectedSourceCount,
			openedPageCount: result.diagnostics.openedPageCount,
			evidenceCandidateCount: result.diagnostics.evidenceCandidateCount,
			exactEvidenceCandidateCount:
				result.diagnostics.exactEvidenceCandidateCount,
			reranked: result.diagnostics.reranked,
			sourceReranked: result.diagnostics.sourceReranked,
		},
		instructions:
			"Answer only from the returned answer brief, sources, and evidence. Use markdown links with returned source URLs, and never cite URLs outside the returned source list.",
	};
}

export function createResearchWebCandidates(
	result: ResearchResult,
): ToolEvidenceCandidate[] {
	return result.sources.slice(0, 12).map((source) => ({
		id: source.id,
		title: truncateText(source.title, 180),
		url: source.url,
		snippet: source.snippet
			? truncateText(source.snippet, 500)
			: source.highlights[0]
				? truncateText(source.highlights[0], 500)
				: null,
		sourceType: "web",
		material: true,
		metadata: {
			provider: source.provider,
			authorityClass: source.authorityClass,
			authorityScore: source.authorityScore,
			providerRank: source.providerRank,
			...(optionalScalarMetadata(source.publishedAt)
				? { publishedAt: source.publishedAt }
				: {}),
			...(optionalScalarMetadata(source.updatedAt)
				? { updatedAt: source.updatedAt }
				: {}),
		},
	}));
}

export function createResearchWebMetadata(
	result: ResearchResult,
): ToolCallEntry["metadata"] {
	return {
		ok: true,
		evidenceReady: true,
		sourceCount: result.sources.length,
		evidenceCount: result.evidence.length,
		mode: result.diagnostics.mode,
		freshness: result.diagnostics.freshness,
		sourcePolicy: result.diagnostics.sourcePolicy,
		selectedSourceCount: result.diagnostics.selectedSourceCount,
		openedPageCount: result.diagnostics.openedPageCount,
		reranked: result.diagnostics.reranked,
		sourceReranked: result.diagnostics.sourceReranked,
	};
}

export function summarizeResearchWebResult(result: ResearchResult): string {
	const sourceLabel = result.sources.length === 1 ? "source" : "sources";
	const evidenceLabel =
		result.evidence.length === 1 ? "evidence snippet" : "evidence snippets";
	return `Web research returned ${result.sources.length} ${sourceLabel} and ${result.evidence.length} ${evidenceLabel}.`;
}
