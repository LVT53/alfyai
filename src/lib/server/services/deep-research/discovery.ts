import type {
	ResearchRequest,
	ResearchResult,
	ResearchSource,
} from "$lib/server/services/web-research";
import {
	buildDiscoveryResearchRequest,
	researchWeb as defaultResearchWeb,
} from "$lib/server/services/web-research";
import type { ResearchPlan } from "./planning";
import { saveDiscoveredResearchSource } from "./sources";
import {
	type ResearchSourceCounts,
	type ResearchTimelineEvent,
	saveResearchTimelineEvent,
} from "./timeline";

export type DiscoveredResearchSourceCandidate = {
	jobId: string;
	conversationId: string;
	userId: string;
	url: string;
	title: string;
	provider: string;
	discoveredAt: string;
	metadata: {
		query: string;
		intendedComparedEntity: string | null;
		intendedComparisonAxis: string | null;
		snippet: string | null;
		text: string | null;
		canonicalUrl: string;
		publishedAt: string | null;
		authorityClass: string | null;
		authorityScore: number | null;
	};
};

export type SavedDiscoveredResearchSource = DiscoveredResearchSourceCandidate &
	Record<string, unknown>;

export type PublicWebDiscoveryInput = {
	jobId: string;
	conversationId: string;
	userId: string;
	approvedPlan: ResearchPlan;
	now?: Date;
};

export type PublicWebDiscoveryDependencies = {
	researchWeb?: (
		request: ResearchRequest,
	) => Promise<Pick<ResearchResult, "sources">>;
	sourceRepository?: {
		saveDiscoveredSources: (
			sources: DiscoveredResearchSourceCandidate[],
		) => Promise<SavedDiscoveredResearchSource[]>;
	};
	timelineRepository?: {
		saveTimelineEvent: (
			event: ResearchTimelineEvent,
		) => Promise<ResearchTimelineEvent & Record<string, unknown>>;
	};
};

export type PublicWebDiscoveryResult = {
	queries: string[];
	discoveredCount: number;
	savedSources: SavedDiscoveredResearchSource[];
	warnings: string[];
};

export async function runPublicWebDiscoveryPass(
	input: PublicWebDiscoveryInput,
	dependencies: PublicWebDiscoveryDependencies = {},
): Promise<PublicWebDiscoveryResult> {
	const now = input.now ?? new Date();
	const occurredAt = now.toISOString();
	const discoveryQueries = buildDiscoveryQueries(input.approvedPlan);
	const queries = discoveryQueries.map((query) => query.query);
	const maxSources = maxSourcesPerDiscoveryQuery(
		input.approvedPlan,
		queries.length,
	);
	const researchWeb = dependencies.researchWeb ?? defaultResearchWeb;
	const sourceRepository =
		dependencies.sourceRepository ?? defaultDiscoveredSourceRepository;
	const researchResults: Array<{
		query: DiscoveryQuery;
		sources: ResearchSource[];
	}> = [];
	const warnings: string[] = [];
	for (const discoveryQuery of discoveryQueries) {
		try {
			const result = await researchWeb(
				buildDiscoveryResearchRequest({
					query: discoveryQuery.query,
					maxSources,
				}),
			);
			researchResults.push({ query: discoveryQuery, sources: result.sources });
		} catch (error) {
			warnings.push(`Public web discovery failed: ${errorMessage(error)}`);
		}
	}

	if (researchResults.length === 0 && warnings.length > 0) {
		const warning = warnings[0] ?? "Public web discovery failed: unknown error";
		await (
			dependencies.timelineRepository?.saveTimelineEvent ??
			saveResearchTimelineEvent
		)(
			createSourceDiscoveryTimelineEvent({
				...input,
				occurredAt,
				sourceCounts: {
					discovered: 0,
					reviewed: 0,
					cited: 0,
				},
				warnings: [warning],
			}),
		);

		return {
			queries,
			discoveredCount: 0,
			savedSources: [],
			warnings: [warning],
		};
	}
	const candidates = dedupeCandidatesByUrl(
		researchResults.flatMap((result) =>
			result.sources.map((source) =>
				mapResearchSourceToCandidate({
					source,
					query: result.query,
					jobId: input.jobId,
					conversationId: input.conversationId,
					userId: input.userId,
					discoveredAt: occurredAt,
				}),
			),
		),
	);
	const savedSources =
		candidates.length > 0
			? await sourceRepository.saveDiscoveredSources(candidates)
			: [];
	const sourceCounts: ResearchSourceCounts = {
		discovered: savedSources.length,
		reviewed: 0,
		cited: 0,
	};

	await (
		dependencies.timelineRepository?.saveTimelineEvent ??
		saveResearchTimelineEvent
	)(
		createSourceDiscoveryTimelineEvent({
			...input,
			occurredAt,
			sourceCounts,
			warnings,
		}),
	);

	return {
		queries,
		discoveredCount: savedSources.length,
		savedSources,
		warnings,
	};
}

const defaultDiscoveredSourceRepository = {
	async saveDiscoveredSources(
		sources: DiscoveredResearchSourceCandidate[],
	): Promise<SavedDiscoveredResearchSource[]> {
		const savedSources = [];
		for (const source of sources) {
			savedSources.push(
				await saveDiscoveredResearchSource({
					jobId: source.jobId,
					conversationId: source.conversationId,
					userId: source.userId,
					url: source.url,
					title: source.title,
					provider: source.provider,
					snippet: source.metadata.snippet,
					sourceText: source.metadata.text,
					intendedComparedEntity: source.metadata.intendedComparedEntity,
					intendedComparisonAxis: source.metadata.intendedComparisonAxis,
					discoveredAt: new Date(source.discoveredAt),
				}),
			);
		}
		return savedSources;
	},
};

function mapResearchSourceToCandidate(input: {
	source: ResearchSource;
	query: DiscoveryQuery;
	jobId: string;
	conversationId: string;
	userId: string;
	discoveredAt: string;
}): DiscoveredResearchSourceCandidate {
	const canonicalUrl = canonicalizeResearchUrl(
		input.source.canonicalUrl || input.source.url,
	);
	return {
		jobId: input.jobId,
		conversationId: input.conversationId,
		userId: input.userId,
		url: canonicalUrl,
		title: input.source.title.trim() || canonicalUrl,
		provider: input.source.provider,
		discoveredAt: input.discoveredAt,
		metadata: {
			query: input.query.query,
			intendedComparedEntity: input.query.comparedEntity,
			intendedComparisonAxis: input.query.comparisonAxis,
			snippet: input.source.snippet,
			text: buildDiscoverySourceText(input.source),
			canonicalUrl,
			publishedAt: input.source.publishedAt,
			authorityClass: input.source.authorityClass,
			authorityScore: input.source.authorityScore,
		},
	};
}

function buildDiscoverySourceText(source: ResearchSource): string | null {
	const primaryText = source.markdown?.trim() ? source.markdown : source.text;
	const parts = [primaryText, ...(source.highlights ?? []), source.snippet]
		.map((part) => part?.trim() ?? "")
		.filter(Boolean);
	return parts.length > 0 ? parts.join("\n\n") : null;
}

function dedupeCandidatesByUrl(
	candidates: DiscoveredResearchSourceCandidate[],
): DiscoveredResearchSourceCandidate[] {
	const byUrl = new Map<string, DiscoveredResearchSourceCandidate>();
	for (const candidate of candidates) {
		if (!byUrl.has(candidate.url)) {
			byUrl.set(candidate.url, candidate);
		}
	}
	return [...byUrl.values()];
}

function canonicalizeResearchUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.protocol = parsed.protocol.toLowerCase();
		parsed.hostname = parsed.hostname.toLowerCase();
		parsed.hash = "";
		for (const key of [...parsed.searchParams.keys()]) {
			if (isTrackingQueryParam(key)) {
				parsed.searchParams.delete(key);
			}
		}
		parsed.searchParams.sort();
		const path =
			parsed.pathname.length > 1
				? parsed.pathname.replace(/\/+$/, "")
				: parsed.pathname;
		parsed.pathname = path || "/";
		const serialized = parsed.toString();
		return serialized.endsWith("/") && parsed.pathname !== "/"
			? serialized.slice(0, -1)
			: serialized;
	} catch {
		return url.trim();
	}
}

function isTrackingQueryParam(key: string): boolean {
	const normalized = key.toLowerCase();
	return (
		normalized.startsWith("utm_") ||
		["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"].includes(normalized)
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim())
		return error.message.trim();
	if (typeof error === "string" && error.trim()) return error.trim();
	return "unknown error";
}

type DiscoveryQuery = {
	query: string;
	comparedEntity: string | null;
	comparisonAxis: string | null;
};

function buildDiscoveryQueries(plan: ResearchPlan): DiscoveryQuery[] {
	const comparisonQueries = buildComparisonDiscoveryQueries(plan);
	const maxQueryCount = maxDiscoveryQueryCount(
		plan.depth,
		comparisonQueries.length > 0,
	);
	const candidates = (
		comparisonQueries.length > 0
			? comparisonQueries
			: [plan.goal, ...plan.keyQuestions].map((query) => ({
					query,
					comparedEntity: null,
					comparisonAxis: null,
				}))
	)
		.map((query) => ({
			...query,
			query: query.query.replace(/\s+/g, " ").trim(),
		}))
		.filter((query) => query.query);
	const uniqueQueries: DiscoveryQuery[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = candidate.query.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			uniqueQueries.push(candidate);
		}
		if (uniqueQueries.length >= maxQueryCount) break;
	}
	return uniqueQueries;
}

function buildComparisonDiscoveryQueries(plan: ResearchPlan): DiscoveryQuery[] {
	if (
		plan.reportIntent !== "comparison" ||
		!plan.comparedEntities?.length ||
		!plan.comparisonAxes?.length
	) {
		return [];
	}
	const comparedEntities = plan.comparedEntities;
	const comparisonAxes = plan.comparisonAxes
		.map(normalizeDiscoveryComparisonAxis)
		.filter(Boolean);
	return comparisonAxes.flatMap((axis) =>
		comparedEntities.map((entity) => ({
			query: `${entity} ${axis}`,
			comparedEntity: entity,
			comparisonAxis: axis,
		})),
	);
}

function normalizeDiscoveryComparisonAxis(axis: string): string {
	return axis
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:focusing|focused)\s+(?:on\s+)?/iu, "")
		.replace(/\bavailability\s+in\s+Europe\b/iu, "availability Europe")
		.trim();
}

function maxDiscoveryQueryCount(
	depth: ResearchPlan["depth"],
	hasComparisonQueries: boolean,
): number {
	if (hasComparisonQueries) {
		if (depth === "focused") return 6;
		if (depth === "max") return 24;
		return 12;
	}
	if (depth === "focused") return 2;
	if (depth === "max") return 6;
	return 4;
}

function createSourceDiscoveryTimelineEvent(
	input: PublicWebDiscoveryInput & {
		occurredAt: string;
		sourceCounts: ResearchSourceCounts;
		warnings: string[];
	},
): ResearchTimelineEvent {
	return {
		jobId: input.jobId,
		conversationId: input.conversationId,
		userId: input.userId,
		taskId: null,
		stage: "source_discovery",
		kind: input.warnings.length > 0 ? "warning" : "stage_completed",
		occurredAt: input.occurredAt,
		messageKey: "deepResearch.timeline.sourceDiscoveryCompleted",
		messageParams: {
			discoveredSources: input.sourceCounts.discovered,
		},
		sourceCounts: input.sourceCounts,
		assumptions: [],
		warnings: input.warnings,
		summary: `Discovered ${input.sourceCounts.discovered} public web source candidates.`,
	};
}

function maxSourcesPerDiscoveryQuery(
	plan: ResearchPlan,
	queryCount: number,
): number {
	const boundedQueryCount = Math.max(1, queryCount);
	return Math.max(
		1,
		Math.min(
			10,
			Math.ceil(plan.researchBudget.sourceReviewCeiling / boundedQueryCount),
		),
	);
}
