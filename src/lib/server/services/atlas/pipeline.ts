import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import {
	detectLanguage,
	type SupportedLanguage,
} from "$lib/server/services/language";
import {
	type AtlasProfileRuntimeConfig,
	getAtlasProfileRuntimeConfig,
} from "./config";
import {
	buildAtlasCoverageReviewPrompt,
	parseAndApproveAtlasCoverageReview,
} from "./coverage-review";
import {
	type BuildAtlasEvidencePacksResult,
	buildAtlasEvidencePacks,
} from "./evidence-packs";
import { parseJsonFromText } from "./json-extract";
import {
	type AtlasOutputIds,
	type AtlasReportSource,
	buildAtlasDocumentSource,
	collectAtlasSelectedImageCandidateIds,
	compactAtlasSourceRelevanceNote,
} from "./renderer-output";
import {
	type AtlasReportShapeDiagnostics,
	diagnoseAtlasReportShape,
} from "./report-shape-diagnostics";
import type {
	AtlasAssemblyMetadata,
	AtlasClaimBasis,
	AtlasClaimBasisDiagnostic,
	AtlasClaimBasisLimitation,
	AtlasClaimBasisSectionCoverage,
	AtlasCoverageReview,
	AtlasEvidenceAppendixSummary,
	AtlasEvidencePack,
	AtlasEvidencePackDiagnostic,
	AtlasGapProposal,
	AtlasHonestyMarker,
	AtlasImageCandidate,
	AtlasJobProgressDetails,
	AtlasLifecycleContext,
	AtlasPipelineJobContext,
	AtlasPipelineStage,
	AtlasSectionBrief,
	AtlasSectionBriefSourceAssociation,
} from "./types";
import { ATLAS_ASSEMBLY_SCHEMA_VERSION } from "./types";
import {
	buildAtlasWriterImprovementPrompt,
	buildAtlasWriterPrompt,
	shouldImproveAtlasWriterDraft,
} from "./writer";
import {
	type AtlasWriterEvidenceCardReranker,
	buildAtlasWriterEvidenceCards,
	routeAtlasWriterEvidenceCards,
} from "./writer-evidence-cards";

type ModelStage = Exclude<AtlasPipelineStage, "search" | "audit" | "render">;

export interface AtlasStageUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

interface AtlasPipelineLocalSource {
	id: string;
	title: string;
	authority: string;
	text: string;
}

interface AtlasPipelineWebSource {
	id: string;
	title: string;
	url: string;
	snippet: string | null;
}

interface AtlasPipelineRejectedWebSource extends AtlasPipelineWebSource {
	rejectionReason?: string;
}

interface AtlasPipelineSearchResult {
	sources: AtlasPipelineWebSource[];
	rejectedSources?: AtlasPipelineRejectedWebSource[];
	limitation: { code: string; message: string } | null;
}

export interface RunAtlasPipelineInput {
	job: AtlasPipelineJobContext;
	now?: Date;
	dependencies: {
		resolveSources: () => Promise<{
			localSources: AtlasPipelineLocalSource[];
		}>;
		searchWeb: (queries: string[]) => Promise<AtlasPipelineSearchResult>;
		searchImages?: (queries: string[]) => Promise<{
			imageCandidates: AtlasImageCandidate[];
			imageLimitation: { code: string; message: string } | null;
		}>;
		runModelStage: (input: {
			stage: ModelStage;
			prompt: string;
			system: string;
		}) => Promise<{ text: string; usage: AtlasStageUsage }>;
		auditBasis: (input: {
			assembledMarkdown: string;
			sources: Array<{ title: string; url?: string | null }>;
			limitation: { code: string; message: string } | null;
			language: SupportedLanguage;
			currentDate: string;
			evidencePacks: AtlasEvidencePack[];
			evidencePackDiagnostics: AtlasEvidencePackDiagnostic[];
			coverageReview: AtlasCoverageReview;
			sectionBriefs: AtlasSectionBrief[];
			assemblyMetadata: AtlasAssemblyMetadata;
		}) => Promise<{
			passed: boolean;
			honestyMarkers: AtlasHonestyMarker[];
			retryRequested: boolean;
			usage?: AtlasStageUsage | null;
			claimBasis?: AtlasClaimBasis[];
			basisLimitations?: AtlasClaimBasisLimitation[];
			basisDiagnostics?: AtlasClaimBasisDiagnostic[];
			claimBasisCoverageBySection?: AtlasClaimBasisSectionCoverage[];
			claimBasisStatus?: "succeeded" | "failed";
			claimBasisFailureReason?: string | null;
		}>;
		writeCheckpoint: (input: {
			jobId: string;
			roundNumber: number;
			stage: string;
			checkpoint: unknown;
			curatedSourcePool: unknown;
			compressedFindings: unknown;
			usage: AtlasStageUsage;
			qualityDiagnostics: unknown;
			documentSourceSummary: unknown;
		}) => Promise<void>;
		heartbeat?: (input: {
			stage: AtlasPipelineStage;
			progressPercent: number;
			progressDetails?: AtlasJobProgressDetails;
		}) => Promise<void>;
		applyGeneratedTitle?: (input: {
			jobId: string;
			title: string;
		}) => Promise<void>;
		rerankWriterEvidenceCards?: AtlasWriterEvidenceCardReranker;
		renderOutputs: (
			source: GeneratedDocumentSource,
		) => Promise<AtlasOutputIds & { sourceTitle?: string }>;
	};
}

export interface AtlasPipelineResult {
	status: "succeeded";
	stage: "render";
	title: string;
	generatedTitle: string | null;
	outputs: AtlasOutputIds;
	audit: {
		honestyMarkers: AtlasHonestyMarker[];
	};
	usage: AtlasStageUsage;
	sourceCounts: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
}

export class AtlasPipelineQualityError extends Error {
	readonly code = "atlas_quality_gate_failed";
	readonly markers: AtlasHonestyMarker[];

	constructor(markers: AtlasHonestyMarker[]) {
		const markerCodes = markers.map((marker) => marker.code).join(", ");
		super(`Atlas quality gate failed${markerCodes ? `: ${markerCodes}` : "."}`);
		this.name = "AtlasPipelineQualityError";
		this.markers = markers;
	}
}

function hasCriticalAuditFinding(markers: AtlasHonestyMarker[]): boolean {
	return markers.some((marker) => marker.severity === "critical");
}

function localSourceProjectionFallback(
	source: AtlasPipelineLocalSource,
): string {
	if (source.authority === "explicit") return "You provided these";
	if (source.authority === "working_document") {
		return "Readable working document selected by Atlas";
	}
	return "Parent or automatic library source selected by Atlas";
}

function evidencePackForLocalSource(
	evidencePacks: AtlasEvidencePack[],
	source: AtlasPipelineLocalSource,
): AtlasEvidencePack | null {
	return (
		evidencePacks.find((pack) =>
			pack.sourceRefs.some(
				(ref) =>
					ref.kind === "local" &&
					(ref.id === source.id || ref.title === source.title),
			),
		) ?? null
	);
}

function evidencePackForWebSource(
	evidencePacks: AtlasEvidencePack[],
	source: AtlasPipelineWebSource,
): AtlasEvidencePack | null {
	const sourceUrlKey = canonicalWebSourceUrlKey(source.url);
	return (
		evidencePacks.find((pack) =>
			pack.sourceRefs.some((ref) => {
				if (ref.kind !== "web") return false;
				if (ref.id === source.id || ref.title === source.title) return true;
				return ref.url
					? canonicalWebSourceUrlKey(ref.url) === sourceUrlKey
					: false;
			}),
		) ?? null
	);
}

function buildPublishedAtlasSources(input: {
	localSources: AtlasPipelineLocalSource[];
	webSources: AtlasPipelineWebSource[];
	evidencePacks: AtlasEvidencePack[];
}): AtlasReportSource[] {
	return [
		...input.localSources.map((source): AtlasReportSource => {
			const fallback = localSourceProjectionFallback(source);
			const pack = evidencePackForLocalSource(input.evidencePacks, source);
			const note =
				source.authority === "explicit" ? fallback : pack?.evidence.summary;
			return {
				title: source.title,
				url: null,
				authority: source.authority,
				relevanceNote: compactAtlasSourceRelevanceNote({
					note,
					fallback,
				}),
			};
		}),
		...input.webSources.map((source): AtlasReportSource => {
			const fallback = "Accepted web evidence gathered by Atlas";
			const pack = evidencePackForWebSource(input.evidencePacks, source);
			return {
				title: source.title,
				url: source.url,
				relevanceNote: compactAtlasSourceRelevanceNote({
					note: pack?.evidence.summary ?? source.snippet,
					fallback,
				}),
			};
		}),
	];
}

const RAW_EXCERPT_LABEL_PATTERN =
	/(?:fetched\s+page\s+excerpt|search\s+result\s+snippet|source\s+excerpt)\s*:/gi;

function countRawExcerptLabels(value: string | null | undefined): number {
	if (!value) return 0;
	return Array.from(value.matchAll(RAW_EXCERPT_LABEL_PATTERN)).length;
}

function safeRejectedReason(value: string | undefined): string {
	const normalized = value?.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
	return normalized || "unknown";
}

function buildEvidenceAppendixSummary(input: {
	localSources: AtlasPipelineLocalSource[];
	webSources: AtlasPipelineWebSource[];
	rejectedWebSources: AtlasPipelineRejectedWebSource[];
}): AtlasEvidenceAppendixSummary {
	const sourceTexts = [
		...input.localSources.map((source) => source.text),
		...input.webSources.map((source) => source.snippet),
		...input.rejectedWebSources.map((source) => source.snippet),
	];
	const rawExcerptLabelCount = sourceTexts.reduce(
		(total, text) => total + countRawExcerptLabels(text),
		0,
	);
	const maxSnippetChars = Math.max(
		0,
		...sourceTexts.map((text) => text?.length ?? 0),
	);
	const rejectedReasonCounts: Record<string, number> = {};
	for (const source of input.rejectedWebSources) {
		const reason = safeRejectedReason(source.rejectionReason);
		rejectedReasonCounts[reason] = (rejectedReasonCounts[reason] ?? 0) + 1;
	}

	return {
		status: "checkpoint_only",
		acceptedWebSourceCount: input.webSources.length,
		acceptedLocalSourceCount: input.localSources.length,
		rejectedWebSourceCount: input.rejectedWebSources.length,
		rawExcerptPresent: rawExcerptLabelCount > 0,
		rawExcerptLabelCount,
		maxSnippetChars,
		rejectedReasonCounts,
		publishedReportIncludesRawExcerpts: false,
	};
}

function addUsage(
	total: AtlasStageUsage,
	next: AtlasStageUsage,
): AtlasStageUsage {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		totalTokens: total.totalTokens + next.totalTokens,
		costUsdMicros: total.costUsdMicros + next.costUsdMicros,
	};
}

function seededPrompt(input: {
	query: string;
	lifecycle: AtlasLifecycleContext;
	language: SupportedLanguage;
	currentDate: string;
}): string {
	return JSON.stringify({
		query: input.query,
		detectedLanguage: input.language,
		currentDate: input.currentDate,
		atlasLifecycle: {
			action: input.lifecycle.family.action,
			family: input.lifecycle.family,
			parentSeed: input.lifecycle.seed
				? {
						parentAtlasJobId: input.lifecycle.seed.parentAtlasJobId,
						compressedFindings: input.lifecycle.seed.compressedFindings,
					}
				: null,
		},
	});
}

const STAGE_SYSTEMS: Record<SupportedLanguage, Record<ModelStage, string>> = {
	en: {
		decompose:
			"Break the Atlas question into durable research queries. Return only search query strings, one per line. Do not include prose, numbering, Markdown fences, or commentary.",
		curate:
			"Curate Atlas local and web evidence. Extract source-grounded facts only; do not summarize the fact that research happened.",
		"coverage-review":
			"Review Atlas coverage against the intended questions and Evidence Packs. Return strict JSON only with typed gap proposals; do not decide whether Atlas runs another round.",
		synthesize:
			"Synthesize Atlas findings from curated evidence. Produce substantive findings, tradeoffs, and source-grounded uncertainty; do not write a process summary.",
		integrate:
			"Integrate Atlas findings into a coherent report outline. Preserve the substantive findings and map each section to the evidence basis.",
		assemble:
			"Write the final Atlas published report from compact Writer Evidence Cards. Produce decision-quality synthesis, not a source dump or process report.",
	},
	hu: {
		decompose:
			"Bontsd az Atlas kérdést tartós kutatási lekérdezésekre. Csak keresési lekérdezéseket adj vissza, soronként egyet. Ne adj prózát, számozást, Markdown blokkot vagy kommentárt.",
		curate:
			"Válogasd az Atlas helyi és webes bizonyítékait. Csak forrásokkal alátámasztott tényeket emelj ki; ne azt foglald össze, hogy kutatás történt.",
		"coverage-review":
			"Vizsgáld meg az Atlas lefedettségét a tervezett kérdések és az Evidence Packek alapján. Csak szigorú JSON-t adj vissza tipizált hiányjavaslatokkal; ne dönts arról, hogy az Atlas futtat-e újabb kört.",
		synthesize:
			"Szintetizáld az Atlas megállapításait a válogatott bizonyítékokból. Valódi megállapításokat, kompromisszumokat és forrásalapú bizonytalanságot adj; ne folyamatösszefoglalót.",
		integrate:
			"Rendezd az Atlas megállapításait koherens jelentésvázlatba. Őrizd meg az érdemi megállapításokat, és kösd a szakaszokat a bizonyítékalaphoz.",
		assemble:
			"Írd meg a végleges, publikált Atlas jelentést kompakt Writer Evidence Cardokból. Döntésminőségű szintézist adj, ne forrásdumpot vagy folyamatjelentést.",
	},
};

function stageSystem(
	stage: ModelStage,
	language: SupportedLanguage,
	currentDate: string,
	profilePosture: string,
): string {
	const languageInstruction =
		language === "hu"
			? "A jelentés és a szakasz kimenete magyar legyen; a forráscímek maradjanak eredeti nyelven."
			: "Write the stage output and final report in English; keep source titles in their original language.";
	const freshnessInstruction =
		language === "hu"
			? `Mai dátum: ${currentDate}. A friss, aktuális, legújabb vagy híralapú állításokat kezeld időérzékenyként; webes bizonyítékokra támaszkodj, ne régi modellismeretre.`
			: `Current date: ${currentDate}. Treat recent, current, latest, or news-based claims as freshness-sensitive; ground them in web evidence instead of stale model knowledge.`;
	return `${STAGE_SYSTEMS[language][stage]}\n\n${languageInstruction}\n\n${freshnessInstruction}\n\n${profilePosture}`;
}

function parseDecomposeQueries(text: string, maxQueries: number): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	for (const candidate of [trimmed, fencedJson].filter(
		(candidate): candidate is string => Boolean(candidate),
	)) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const rawQueries = Array.isArray(parsed)
				? parsed
				: parsed && typeof parsed === "object"
					? ((parsed as { queries?: unknown; researchQueries?: unknown })
							.queries ??
						(parsed as { researchQueries?: unknown }).researchQueries)
					: null;
			if (Array.isArray(rawQueries)) {
				const queries = rawQueries
					.map((query) =>
						typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "",
					)
					.filter(Boolean)
					.slice(0, maxQueries);
				if (queries.length > 0) return queries;
			}
		} catch {
			// Fall through to line parsing.
		}
	}
	return text
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^[-*\d.)\s]+/, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter(Boolean)
		.slice(0, maxQueries);
}

function normalizeQueryForComparison(query: string): string {
	return query
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function uniqueQueries(queries: string[]): string[] {
	return Array.from(
		new Set(queries.map((query) => query.trim()).filter(Boolean)),
	);
}

function isPromptEcho(query: string, prompt: string): boolean {
	const normalizedQuery = normalizeQueryForComparison(query);
	return (
		normalizedQuery.length > 0 &&
		normalizedQuery === normalizeQueryForComparison(prompt)
	);
}

function fallbackDecomposeQueries(query: string): string[] {
	const trimmed = query.replace(/\s+/g, " ").trim();
	if (!trimmed) return [];
	const stopwords = new Set([
		"about",
		"compare",
		"for",
		"please",
		"research",
		"the",
	]);
	const core = trimmed
		.split(/\s+/)
		.map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean)
		.filter((token) => !stopwords.has(token.toLowerCase()))
		.join(" ");
	const queryCore = core || trimmed;
	return uniqueQueries([
		`${queryCore} evidence`,
		`${queryCore} comparison`,
		`${queryCore} best practices`,
	]).slice(0, 3);
}

function buildAtlasSearchQueries(input: {
	query: string;
	decomposeText: string;
	now: Date;
	maxQueries: number;
}): string[] {
	const decomposeQueries = parseDecomposeQueries(
		input.decomposeText,
		input.maxQueries,
	).filter((query) => !isPromptEcho(query, input.query));
	const queries =
		decomposeQueries.length > 0
			? uniqueQueries(decomposeQueries).slice(0, input.maxQueries)
			: fallbackDecomposeQueries(input.query);
	return applyFreshnessGrounding({
		userQuery: input.query,
		queries,
		now: input.now,
		maxQueries: input.maxQueries,
	});
}

function isFreshnessSensitiveQuery(
	query: string,
	currentYear: number,
): boolean {
	const freshnessPattern =
		/\b(today|now|current|latest|recent|breaking|news|this week|this month|this year|price|availability|deadline|policy|schedule)\b/i;
	return (
		freshnessPattern.test(query) ||
		new RegExp(`\\b${currentYear}\\b`).test(query)
	);
}

function explicitYears(query: string): Set<string> {
	return new Set(query.match(/\b(?:19|20)\d{2}\b/g) ?? []);
}

function replaceStaleUnrequestedYears(input: {
	query: string;
	currentYear: number;
	requestedYears: Set<string>;
}): string {
	return input.query.replace(/\b(?:19|20)\d{2}\b/g, (year) => {
		if (input.requestedYears.has(year)) return year;
		const numericYear = Number(year);
		return numericYear < input.currentYear ? String(input.currentYear) : year;
	});
}

function removeTerminalQuestionMark(query: string): string {
	return query.trim().replace(/\?+$/g, "");
}

function applyFreshnessGrounding(input: {
	userQuery: string;
	queries: string[];
	now: Date;
	maxQueries: number;
}): string[] {
	const currentYear = input.now.getUTCFullYear();
	if (!isFreshnessSensitiveQuery(input.userQuery, currentYear)) {
		return input.queries;
	}
	const requestedYears = explicitYears(input.userQuery);
	const grounded = input.queries.map((query) => {
		const rewritten = replaceStaleUnrequestedYears({
			query,
			currentYear,
			requestedYears,
		});
		return new RegExp(`\\b${currentYear}\\b`).test(rewritten)
			? rewritten
			: `${rewritten} ${currentYear}`;
	});
	const userQueryCore = removeTerminalQuestionMark(input.userQuery);
	grounded.push(`${userQueryCore} recent news ${currentYear}`);
	grounded.push(`${userQueryCore} latest updates ${currentYear}`);
	return uniqueQueries(grounded).slice(0, input.maxQueries);
}

type AtlasResearchRoundKind = "initial" | "gap-fill";

interface AtlasGapFillDiagnostics {
	useful: boolean;
	stopReason: string | null;
	approvedGapCount: number;
	searchQueries: string[];
	acceptedNewWebSourceCount: number;
	rejectedNewWebSourceCount: number;
	materiallyNewExcerptCount: number;
	diagnostics: AtlasEvidencePackDiagnostic[];
}

interface AtlasResearchRoundDiagnostics {
	roundNumber: number;
	roundKind: AtlasResearchRoundKind;
	searchQueries: string[];
	acceptedWebSourceCount: number;
	rejectedWebSourceCount: number;
	evidencePackCount: number;
	coverageReviewApprovedGapCount: number;
	gapFill?: AtlasGapFillDiagnostics;
}

interface AtlasResearchRoundResult {
	roundNumber: number;
	roundKind: AtlasResearchRoundKind;
	searchQueries: string[];
	approvedGaps: AtlasGapProposal[];
	curatedEvidence: string;
	webSources: AtlasPipelineWebSource[];
	rejectedWebSources: AtlasPipelineRejectedWebSource[];
	roundAcceptedWebSources: AtlasPipelineWebSource[];
	roundRejectedWebSources: AtlasPipelineRejectedWebSource[];
	searchLimitation: { code: string; message: string } | null;
	imageSearch: {
		imageCandidates: AtlasImageCandidate[];
		imageLimitation: { code: string; message: string } | null;
	};
	evidencePackResult: BuildAtlasEvidencePacksResult;
	evidencePackDiagnostics: AtlasEvidencePackDiagnostic[];
	coverageReview: AtlasCoverageReview;
	usage: AtlasStageUsage;
	qualityDiagnostics: AtlasResearchRoundDiagnostics;
}

async function runAtlasResearchRound(input: {
	job: AtlasPipelineJobContext;
	roundNumber: number;
	roundKind: AtlasResearchRoundKind;
	language: SupportedLanguage;
	currentDate: string;
	now: Date;
	profileConfig: AtlasProfileRuntimeConfig;
	profilePosture: string;
	localSources: AtlasPipelineLocalSource[];
	existingWebSources: AtlasPipelineWebSource[];
	existingRejectedWebSources: AtlasPipelineRejectedWebSource[];
	searchQueries: string[];
	approvedGaps: AtlasGapProposal[];
	decomposeText: string;
	parentCuratedSourcePool: unknown | null;
	completedGapFillRoundsForReview: number;
	dependencies: Pick<
		RunAtlasPipelineInput["dependencies"],
		"searchWeb" | "searchImages" | "runModelStage" | "heartbeat"
	>;
}): Promise<AtlasResearchRoundResult> {
	const usageSeed: AtlasStageUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsdMicros: 0,
	};
	let usage = usageSeed;

	await input.dependencies.heartbeat?.({
		stage: "search",
		progressPercent:
			input.roundKind === "initial"
				? 25
				: Math.min(64, 50 + input.roundNumber * 4),
		progressDetails: { queries: input.searchQueries },
	});
	const search = await input.dependencies.searchWeb(input.searchQueries);

	let imageSearch: {
		imageCandidates: AtlasImageCandidate[];
		imageLimitation: { code: string; message: string } | null;
	} = { imageCandidates: [], imageLimitation: null };
	if (input.roundKind === "initial" && input.dependencies.searchImages) {
		await input.dependencies.heartbeat?.({
			stage: "search",
			progressPercent: 32,
			progressDetails: { queries: input.searchQueries },
		});
		try {
			imageSearch = await input.dependencies.searchImages(input.searchQueries);
		} catch (error) {
			imageSearch = {
				imageCandidates: [],
				imageLimitation: {
					code: "atlas_image_search_failed",
					message:
						error instanceof Error
							? error.message
							: "Atlas image search failed.",
				},
			};
		}
	}

	const convergence =
		input.roundKind === "gap-fill"
			? convergeGapFillWebSources({
					candidates: search.sources,
					existingWebSources: input.existingWebSources,
					existingRejectedWebSources: [
						...input.existingRejectedWebSources,
						...(search.rejectedSources ?? []),
					],
					maxAcceptedNewSources:
						input.profileConfig.architecture.gapFillCaps.maxAcceptedWebSources,
				})
			: {
					acceptedNewSources: search.sources,
					rejectedSources: [
						...input.existingRejectedWebSources,
						...(search.rejectedSources ?? []),
					],
					roundRejectedSources: search.rejectedSources ?? [],
					materiallyNewExcerptCount: search.sources.length,
				};
	const webSources =
		input.roundKind === "gap-fill"
			? [...input.existingWebSources, ...convergence.acceptedNewSources]
			: convergence.acceptedNewSources;
	const gapDiagnostics =
		input.roundKind === "gap-fill"
			? buildGapFillDiagnostics({
					approvedGaps: input.approvedGaps,
					searchQueries: input.searchQueries,
					acceptedNewSources: convergence.acceptedNewSources,
					roundRejectedSources: convergence.roundRejectedSources,
					materiallyNewExcerptCount: convergence.materiallyNewExcerptCount,
					currentDate: input.currentDate,
				})
			: null;

	await input.dependencies.heartbeat?.({
		stage: "curate",
		progressPercent:
			input.roundKind === "initial"
				? 40
				: Math.min(72, 56 + input.roundNumber * 4),
	});
	const curate = await input.dependencies.runModelStage({
		stage: "curate",
		system: stageSystem(
			"curate",
			input.language,
			input.currentDate,
			input.profilePosture,
		),
		prompt: JSON.stringify({
			detectedLanguage: input.language,
			currentDate: input.currentDate,
			roundNumber: input.roundNumber,
			roundKind: input.roundKind,
			searchQueries: input.searchQueries,
			approvedGaps: input.approvedGaps,
			local: input.localSources,
			web: webSources,
			newWeb: convergence.acceptedNewSources,
			rejectedWeb: convergence.roundRejectedSources,
			imageCandidates: imageSearch.imageCandidates,
			parentCuratedSourcePool: input.parentCuratedSourcePool,
			atlasLifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, curate.usage);

	const evidencePackResult = buildAtlasEvidencePacks({
		query: input.job.query,
		currentDate: input.currentDate,
		curatedEvidence: curate.text,
		localSources: input.localSources,
		webSources,
		searchLimitation: search.limitation,
		parentSeed: input.job.lifecycle.seed,
	});
	const evidencePackDiagnostics = [
		...evidencePackResult.diagnostics,
		...(gapDiagnostics?.diagnostics ?? []),
	];

	await input.dependencies.heartbeat?.({
		stage: "coverage-review",
		progressPercent:
			input.roundKind === "initial"
				? 50
				: Math.min(78, 60 + input.roundNumber * 4),
	});
	const coverageReviewModel = await input.dependencies.runModelStage({
		stage: "coverage-review",
		system: stageSystem(
			"coverage-review",
			input.language,
			input.currentDate,
			input.profilePosture,
		),
		prompt: buildAtlasCoverageReviewPrompt({
			language: input.language,
			query: input.job.query,
			currentDate: input.currentDate,
			intendedQuestions: coverageReviewIntendedQuestions({
				query: input.job.query,
				decomposeText: input.decomposeText,
				maxQueries: input.profileConfig.maxSearchQueries,
			}),
			outline: input.decomposeText,
			evidencePacks: evidencePackResult.evidencePacks,
			evidencePackDiagnostics,
		}),
	});
	usage = addUsage(usage, coverageReviewModel.usage);
	const coverageReview = parseAndApproveAtlasCoverageReview({
		modelText: coverageReviewModel.text,
		profileConfig: input.profileConfig,
		completedGapFillRounds: input.completedGapFillRoundsForReview,
	});

	return {
		roundNumber: input.roundNumber,
		roundKind: input.roundKind,
		searchQueries: input.searchQueries,
		approvedGaps: input.approvedGaps,
		curatedEvidence: curate.text,
		webSources,
		rejectedWebSources: convergence.rejectedSources,
		roundAcceptedWebSources: convergence.acceptedNewSources,
		roundRejectedWebSources: convergence.roundRejectedSources,
		searchLimitation: search.limitation,
		imageSearch,
		evidencePackResult,
		evidencePackDiagnostics,
		coverageReview,
		usage,
		qualityDiagnostics: {
			roundNumber: input.roundNumber,
			roundKind: input.roundKind,
			searchQueries: input.searchQueries,
			acceptedWebSourceCount: webSources.length,
			rejectedWebSourceCount: convergence.rejectedSources.length,
			evidencePackCount: evidencePackResult.evidencePacks.length,
			coverageReviewApprovedGapCount:
				coverageReview.approvedGapCandidates.length,
			...(gapDiagnostics ? { gapFill: gapDiagnostics } : {}),
		},
	};
}

function buildGapFillSearchQueries(input: {
	coverageReview: AtlasCoverageReview;
	maxQueries: number;
}): { queries: string[]; approvedGaps: AtlasGapProposal[] } {
	const approvedGaps = input.coverageReview.approvedGapCandidates.slice(
		0,
		input.maxQueries,
	);
	const queries = uniqueQueries(
		approvedGaps.map((proposal) => proposal.targetSearchQuery),
	).slice(0, input.maxQueries);
	return { queries, approvedGaps };
}

function combineResearchRoundLimitations(
	rounds: AtlasResearchRoundResult[],
): { code: string; message: string } | null {
	const limitations = rounds
		.map((round) => round.searchLimitation)
		.filter(
			(limitation): limitation is { code: string; message: string } =>
				limitation !== null,
		);
	if (limitations.length === 0) return null;
	if (limitations.length === 1) return limitations[0];
	return {
		code: "atlas_search_round_limitations",
		message: limitations
			.map((limitation) => limitation.message)
			.filter(Boolean)
			.join(" "),
	};
}

function convergeGapFillWebSources(input: {
	candidates: AtlasPipelineWebSource[];
	existingWebSources: AtlasPipelineWebSource[];
	existingRejectedWebSources: AtlasPipelineRejectedWebSource[];
	maxAcceptedNewSources: number;
}): {
	acceptedNewSources: AtlasPipelineWebSource[];
	rejectedSources: AtlasPipelineRejectedWebSource[];
	roundRejectedSources: AtlasPipelineRejectedWebSource[];
	materiallyNewExcerptCount: number;
} {
	const acceptedNewSources: AtlasPipelineWebSource[] = [];
	const roundRejectedSources: AtlasPipelineRejectedWebSource[] = [];
	const seenUrlKeys = new Set(
		input.existingWebSources.map((source) =>
			canonicalWebSourceUrlKey(source.url),
		),
	);
	const seenMaterialKeys = new Set(
		input.existingWebSources
			.map((source) => webSourceMaterialKey(source))
			.filter((key): key is string => Boolean(key)),
	);
	let materiallyNewExcerptCount = 0;

	for (const source of input.candidates) {
		const urlKey = canonicalWebSourceUrlKey(source.url);
		if (seenUrlKeys.has(urlKey)) {
			roundRejectedSources.push({
				...source,
				rejectionReason: "duplicate_url",
			});
			continue;
		}
		const materialKey = webSourceMaterialKey(source);
		if (!materialKey) {
			roundRejectedSources.push({
				...source,
				rejectionReason: "low_authority_material",
			});
			continue;
		}
		if (materialMatchesExisting(materialKey, seenMaterialKeys)) {
			roundRejectedSources.push({
				...source,
				rejectionReason: "duplicate_material",
			});
			continue;
		}
		if (acceptedNewSources.length >= input.maxAcceptedNewSources) {
			roundRejectedSources.push({
				...source,
				rejectionReason: "source_cap",
			});
			continue;
		}
		acceptedNewSources.push(source);
		seenUrlKeys.add(urlKey);
		seenMaterialKeys.add(materialKey);
		materiallyNewExcerptCount += 1;
	}

	return {
		acceptedNewSources,
		rejectedSources: [
			...input.existingRejectedWebSources,
			...roundRejectedSources,
		],
		roundRejectedSources,
		materiallyNewExcerptCount,
	};
}

function buildGapFillDiagnostics(input: {
	approvedGaps: AtlasGapProposal[];
	searchQueries: string[];
	acceptedNewSources: AtlasPipelineWebSource[];
	roundRejectedSources: AtlasPipelineRejectedWebSource[];
	materiallyNewExcerptCount: number;
	currentDate: string;
}): AtlasGapFillDiagnostics {
	const duplicateRejectedCount = input.roundRejectedSources.filter((source) =>
		(source.rejectionReason ?? "").startsWith("duplicate_"),
	).length;
	const useful =
		input.acceptedNewSources.length > 0 && input.materiallyNewExcerptCount > 0;
	const stopReason = useful
		? null
		: duplicateRejectedCount > 0
			? "no_materially_new_evidence"
			: input.acceptedNewSources.length === 0
				? "no_accepted_sources"
				: "no_materially_new_evidence";
	const diagnostics: AtlasEvidencePackDiagnostic[] = [];
	const currentYear = input.currentDate.slice(0, 4);
	for (const gap of input.approvedGaps) {
		if (
			isFreshnessSensitiveGap(gap, currentYear) &&
			!input.acceptedNewSources.some((source) =>
				webSourceHasFreshnessSignal(source, currentYear),
			)
		) {
			diagnostics.push({
				code: "atlas_gap_fill_freshness_unresolved",
				severity: "warning",
				message:
					"Gap-fill spent a bounded freshness round but did not add clearly current evidence; the report should state this limitation explicitly.",
			});
		}
	}
	if (!useful) {
		diagnostics.push({
			code: "atlas_gap_fill_not_useful",
			severity: "info",
			message:
				"Gap-fill stopped because the round did not add materially new accepted evidence.",
		});
	}
	return {
		useful,
		stopReason,
		approvedGapCount: input.approvedGaps.length,
		searchQueries: input.searchQueries,
		acceptedNewWebSourceCount: input.acceptedNewSources.length,
		rejectedNewWebSourceCount: input.roundRejectedSources.length,
		materiallyNewExcerptCount: input.materiallyNewExcerptCount,
		diagnostics,
	};
}

function canonicalWebSourceUrlKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.searchParams.sort();
		return parsed.toString().replace(/\/+$/, "").toLowerCase();
	} catch {
		return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
	}
}

function webSourceMaterialKey(source: AtlasPipelineWebSource): string | null {
	const normalized = normalizeEvidenceMaterial(source.snippet ?? source.title);
	const tokens = normalized.split(" ").filter(Boolean);
	if (normalized.length < 60 || tokens.length < 8) return null;
	return normalized.slice(0, 900);
}

function normalizeEvidenceMaterial(value: string): string {
	return value
		.replace(/\bSearch result snippet:\s*/gi, "")
		.replace(/\bFetched page excerpt:\s*/gi, "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function materialMatchesExisting(
	materialKey: string,
	existingKeys: Set<string>,
): boolean {
	for (const existing of existingKeys) {
		if (
			existing === materialKey ||
			(existing.length >= 120 && materialKey.includes(existing)) ||
			(materialKey.length >= 120 && existing.includes(materialKey))
		) {
			return true;
		}
	}
	return false;
}

function isFreshnessSensitiveGap(
	gap: AtlasGapProposal,
	currentYear: string,
): boolean {
	const haystack = [
		gap.missingQuestion,
		gap.whyCurrentEvidenceIsWeak,
		gap.targetSearchQuery,
		gap.desiredEvidenceType,
	].join(" ");
	return (
		/\b(current|latest|recent|fresh|freshness|stale|outdated|news|today|now|this year)\b/i.test(
			haystack,
		) || new RegExp(`\\b${currentYear}\\b`).test(haystack)
	);
}

function webSourceHasFreshnessSignal(
	source: AtlasPipelineWebSource,
	currentYear: string,
): boolean {
	const haystack = [source.title, source.url, source.snippet ?? ""].join(" ");
	return new RegExp(`\\b${currentYear}\\b`).test(haystack);
}

function sectionHintsByEvidencePackId(
	sectionBriefs: AtlasSectionBrief[],
): Record<string, string[]> {
	const hints: Record<string, string[]> = {};
	for (const brief of sectionBriefs) {
		for (const evidencePackId of brief.evidencePackIds) {
			hints[evidencePackId] = [
				...(hints[evidencePackId] ?? []),
				brief.sectionTitle,
			];
		}
		for (const association of brief.sourceAssociations) {
			if (!association.evidencePackId) continue;
			hints[association.evidencePackId] = [
				...(hints[association.evidencePackId] ?? []),
				brief.sectionTitle,
			];
		}
	}
	return hints;
}

function sectionBriefsFromIntegration(text: string): AtlasSectionBrief[] {
	const parsed = parseJsonObject(text);
	return parsed ? parseSectionBriefs(parsed.sectionBriefs) : [];
}

function normalizeAssemblyText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized || null;
}

function normalizeGeneratedTitle(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (/[\r\n]/.test(raw)) return null;
	const normalized = normalizeAssemblyText(raw)
		?.replace(/^#{1,6}\s+/, "")
		.replace(/^["']|["']$/g, "")
		.trim();
	if (!normalized) return null;
	if (normalized.length < 4 || normalized.length > 160) return null;
	if (/^(untitled|title|report|atlas report)$/i.test(normalized)) return null;
	if (/[\r\n]/.test(normalized)) return null;
	return normalized;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	const parsed = parseJsonFromText(text);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	return null;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => normalizeAssemblyText(entry))
		.filter((entry): entry is string => Boolean(entry))
		.slice(0, 24);
}

function sourceKind(value: unknown): "web" | "local" | null {
	return value === "web" || value === "local" ? value : null;
}

function parseSourceAssociation(
	value: unknown,
): AtlasSectionBriefSourceAssociation | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const sourceId =
		normalizeAssemblyText(record.sourceId) ??
		normalizeAssemblyText(record.id) ??
		normalizeAssemblyText(record.sourceRef);
	if (!sourceId) return null;
	return {
		sourceId,
		sourceKind: sourceKind(record.sourceKind ?? record.kind),
		sourceTitle:
			normalizeAssemblyText(record.sourceTitle) ??
			normalizeAssemblyText(record.title),
		url: normalizeAssemblyText(record.url),
		evidencePackId:
			normalizeAssemblyText(record.evidencePackId) ??
			normalizeAssemblyText(record.packId),
		relevance:
			normalizeAssemblyText(record.relevance) ??
			normalizeAssemblyText(record.reasoning) ??
			normalizeAssemblyText(record.rationale),
	};
}

function parseSectionBrief(value: unknown): AtlasSectionBrief | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const sectionTitle =
		normalizeAssemblyText(record.sectionTitle) ??
		normalizeAssemblyText(record.title) ??
		normalizeAssemblyText(record.heading);
	const brief =
		normalizeAssemblyText(record.brief) ??
		normalizeAssemblyText(record.summary) ??
		normalizeAssemblyText(record.description);
	if (!sectionTitle || !brief) return null;
	const sourceAssociations = (
		Array.isArray(record.sourceAssociations)
			? record.sourceAssociations
			: Array.isArray(record.sources)
				? record.sources
				: []
	)
		.map(parseSourceAssociation)
		.filter((association): association is AtlasSectionBriefSourceAssociation =>
			Boolean(association),
		)
		.slice(0, 24);
	return {
		sectionTitle,
		brief,
		evidencePackIds: stringArray(
			record.evidencePackIds ?? record.packIds ?? record.evidencePacks,
		),
		sourceAssociations,
		limitations: stringArray(record.limitations),
	};
}

function parseSectionBriefs(value: unknown): AtlasSectionBrief[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(parseSectionBrief)
		.filter((brief): brief is AtlasSectionBrief => Boolean(brief))
		.slice(0, 24);
}

function emptyAssemblyMetadata(structured: boolean): AtlasAssemblyMetadata {
	return {
		version: ATLAS_ASSEMBLY_SCHEMA_VERSION,
		generatedTitle: null,
		sectionBriefs: [],
		limitations: [],
		structured,
	};
}

function parseAtlasAssemblyOutput(text: string): {
	markdown: string;
	metadata: AtlasAssemblyMetadata;
} {
	const parsed = parseJsonObject(text);
	if (!parsed) {
		return {
			markdown: text,
			metadata: emptyAssemblyMetadata(false),
		};
	}
	const markdown =
		typeof parsed.bodyMarkdown === "string"
			? parsed.bodyMarkdown
			: typeof parsed.reportMarkdown === "string"
				? parsed.reportMarkdown
				: typeof parsed.assembledMarkdown === "string"
					? parsed.assembledMarkdown
					: typeof parsed.markdown === "string"
						? parsed.markdown
						: null;
	return {
		markdown: markdown ?? text,
		metadata: {
			version: ATLAS_ASSEMBLY_SCHEMA_VERSION,
			generatedTitle: normalizeGeneratedTitle(parsed.generatedTitle),
			sectionBriefs: parseSectionBriefs(parsed.sectionBriefs),
			limitations: stringArray(parsed.limitations),
			structured: true,
		},
	};
}

function mergeAssemblyMetadata(
	previous: AtlasAssemblyMetadata,
	next: AtlasAssemblyMetadata,
): AtlasAssemblyMetadata {
	return {
		version: ATLAS_ASSEMBLY_SCHEMA_VERSION,
		generatedTitle: next.generatedTitle ?? previous.generatedTitle,
		sectionBriefs:
			next.sectionBriefs.length > 0
				? next.sectionBriefs
				: previous.sectionBriefs,
		limitations:
			next.limitations.length > 0 ? next.limitations : previous.limitations,
		structured: previous.structured || next.structured,
	};
}

function coverageReviewIntendedQuestions(input: {
	query: string;
	decomposeText: string;
	maxQueries: number;
}): string[] {
	return uniqueQueries([
		input.query,
		...parseDecomposeQueries(input.decomposeText, input.maxQueries),
	]);
}

function looksLikeProcessOnlyReport(markdown: string): boolean {
	const normalized = markdown.replace(/\s+/g, " ").trim().toLowerCase();
	if (!normalized) return true;
	const bodyBeforeSources = markdown
		.split(/\n\s*#{2,3}\s+sources\b/i)[0]
		.replace(/^\s*#\s+.+$/gm, "")
		.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const bodyWords = bodyBeforeSources
		? bodyBeforeSources.split(/\s+/).length
		: 0;
	const hasSubstantiveReportSection =
		/^\s*#{2,3}\s+(executive summary|findings|analysis|key findings|recommendations|overview|összefoglaló|vezetői összefoglaló|megállapítások|elemzés|ajánlások)\b/im.test(
			markdown,
		);
	if (!hasSubstantiveReportSection || bodyWords < 60) return true;
	const processPhrases = [
		/\bsources?\s+(?:checked|reviewed|consulted|examined)\b/i,
		/\b(?:checked|reviewed|consulted|examined)\s+sources?\b/i,
		/\bsynthesi[sz]ed\s+(?:the\s+)?findings\b/i,
		/\bcompleted\s+(?:the\s+)?research\b/i,
		/\bresearch\s+process\b/i,
		/\bI\s+(?:checked|reviewed|consulted|examined)\b/i,
	];
	const processHitCount = processPhrases.filter((phrase) =>
		phrase.test(markdown),
	).length;
	if (processHitCount === 0) return false;
	const words = normalized.split(/\s+/).filter(Boolean).length;
	const substantiveSignals =
		/\b(evidence shows|the evidence|finding:|trade[- ]offs?|because|therefore|however|kockázat|bizonyíték|megállapítás)\b/i.test(
			markdown,
		);
	return processHitCount >= 2 || words < 180 || !substantiveSignals;
}

function stripMarkdownFormatting(value: string): string {
	return value
		.replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
		.replace(/[*_`~>#|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizedReportShapeText(value: string): string {
	return stripMarkdownFormatting(value)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function markdownHeadingTitles(markdown: string): string[] {
	return markdown
		.split(/\r?\n/)
		.map((line) => /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1] ?? null)
		.filter((title): title is string => Boolean(title));
}

function isReportEnvelopeHeading(title: string): boolean {
	const normalized = normalizedReportShapeText(title);
	return (
		isReportScalarOnlyHeading(title) ||
		normalized === "report" ||
		normalized === "evidence basis" ||
		normalized === "evidence base" ||
		normalized === "research evidence" ||
		normalized === "accepted evidence" ||
		normalized === "status final evidence based" ||
		normalized.startsWith("date ") ||
		normalized.startsWith("profile ") ||
		normalized.startsWith("stage ") ||
		normalized.startsWith("status ") ||
		normalized.startsWith("key finding ") ||
		normalized.startsWith("key strength ") ||
		normalized.startsWith("license ") ||
		normalized.startsWith("parameters ") ||
		normalized.startsWith("context ") ||
		normalized.startsWith("datum ") ||
		normalized.startsWith("profil ") ||
		normalized.startsWith("allapot ")
	);
}

function isReportScalarOnlyHeading(title: string): boolean {
	const normalized = normalizedReportShapeText(title);
	return /^\d+(?:\.\d+)?\s*[bmk]?\s+(?:dimensions?|gb|mb|ms|parameters?|params?|tokens?)$/i.test(
		normalized,
	);
}

function tokenSetForReportShape(value: string): Set<string> {
	const stopwords = new Set([
		"a",
		"an",
		"and",
		"best",
		"for",
		"in",
		"of",
		"on",
		"the",
		"to",
		"with",
		"guide",
		"report",
		"reports",
		"comparison",
		"compared",
		"benchmark",
		"benchmarks",
	]);
	return new Set(
		normalizedReportShapeText(value)
			.split(/\s+/)
			.filter((token) => token.length >= 4 && !stopwords.has(token)),
	);
}

function isLikelyAcceptedSourceTitleHeading(
	title: string,
	acceptedSourceTitles: string[],
): boolean {
	const normalized = normalizedReportShapeText(title);
	if (!normalized || acceptedSourceTitles.length === 0) return false;
	if (/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(title)) return true;
	const headingTokens = tokenSetForReportShape(title);
	if (headingTokens.size < 2) return false;
	for (const sourceTitle of acceptedSourceTitles) {
		const sourceTokens = tokenSetForReportShape(sourceTitle);
		if (sourceTokens.size < 2) continue;
		let overlap = 0;
		for (const token of headingTokens) {
			if (sourceTokens.has(token)) overlap += 1;
		}
		if (overlap >= Math.min(3, headingTokens.size, sourceTokens.size)) {
			return true;
		}
	}
	return false;
}

function countReportEnvelopeScalarLines(markdown: string): number {
	return markdown
		.split(/\r?\n/)
		.filter((line) =>
			/^\s*(?:[-*]\s*)?(?:\*\*)?(date|profile|stage|status|key finding|key strength|license|parameters|context|evidence basis|datum|profil|allapot)(?:\*\*)?\s*:/i.test(
				line,
			),
		).length;
}

function hasLimitationsHeading(markdown: string): boolean {
	return markdownHeadingTitles(markdown).some((heading) =>
		/\b(limitations?|constraints?|caveats?|korlatok)\b/i.test(
			normalizedReportShapeText(heading),
		),
	);
}

function looksLikeMalformedAssembledReport(input: {
	markdown: string;
	acceptedSourceTitles: string[];
}): boolean {
	const headings = markdownHeadingTitles(input.markdown);
	const envelopeHeadingCount = headings.filter(isReportEnvelopeHeading).length;
	const scalarHeadingCount = headings.filter(isReportScalarOnlyHeading).length;
	const sourceHeadingCount = headings.filter((heading) =>
		isLikelyAcceptedSourceTitleHeading(heading, input.acceptedSourceTitles),
	).length;
	const envelopeScalarCount = countReportEnvelopeScalarLines(input.markdown);
	return (
		scalarHeadingCount >= 1 ||
		envelopeHeadingCount >= 2 ||
		sourceHeadingCount >= 2 ||
		envelopeHeadingCount + envelopeScalarCount >= 3 ||
		(headings.length >= 4 && !hasLimitationsHeading(input.markdown))
	);
}

const MALFORMED_WRITER_HEADING_LABELS = new Set([
	"core insight",
	"lead candidates",
	"key tradeoff",
	"report outline",
	"table",
	"top models",
	"key model characteristics",
]);

const SAFE_REPORT_HEADING_LABELS = new Set([
	"analysis",
	"deployment implications",
	"evidence gaps",
	"executive summary",
	"findings",
	"key findings",
	"latency and cost",
	"limitations",
	"model shortlist",
	"overview",
	"ranked shortlist",
	"recommendation",
	"recommendations",
	"recommended architecture",
	"retrieval quality",
	"sources",
	"summary",
	"tradeoffs",
	"trade offs",
	"vezetoi osszefoglalo",
	"osszefoglalo",
	"megallapitasok",
	"ajanlas",
	"ajanlasok",
	"korlatok",
	"kompromisszumok",
]);

const CLAIM_HEADING_VERB_PATTERN =
	/\b(?:are|avoid|can|cannot|choose|dominates?|has|have|improves?|is|keeps?|leads?|limits?|needs?|offers?|outperforms?|requires?|should|supports?|uses?|wins?)\b/i;

function isLikelySentenceClaimHeading(title: string): boolean {
	const trimmed = title.trim().replace(/[.:;]+$/g, "");
	const normalized = normalizedReportShapeText(trimmed);
	if (!normalized || SAFE_REPORT_HEADING_LABELS.has(normalized)) return false;
	if (/^(?:what|where|when|why|how)\b/i.test(trimmed)) return false;
	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length < 4) return false;
	if (/[.!?]$/.test(title.trim())) return true;
	return CLAIM_HEADING_VERB_PATTERN.test(trimmed);
}

function isMalformedWriterHeading(
	title: string,
	acceptedSourceTitles: string[],
): boolean {
	const trimmed = title.trim();
	const normalized = normalizedReportShapeText(trimmed);
	if (!normalized) return true;
	if (trimmed.startsWith("-") || trimmed.startsWith("*")) return true;
	if (MALFORMED_WRITER_HEADING_LABELS.has(normalized)) return true;
	if (isReportEnvelopeHeading(trimmed)) return true;
	if (isReportScalarOnlyHeading(trimmed)) return true;
	if (isEvidencePackIdFragment(trimmed)) return true;
	if (isFallbackTableFragment(trimmed)) return true;
	if (/[|]/.test(trimmed)) return true;
	if (isLikelySentenceClaimHeading(trimmed)) return true;
	if (isLikelyAcceptedSourceTitleHeading(trimmed, acceptedSourceTitles)) {
		return true;
	}
	return false;
}

function sanitizeMalformedWriterHeadings(input: {
	markdown: string;
	acceptedSourceTitles: string[];
}): string {
	return input.markdown
		.split(/\r?\n/)
		.map((line) => {
			const match = /^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
			if (!match) return line;
			const title = match[2].trim();
			if (!isMalformedWriterHeading(title, input.acceptedSourceTitles)) {
				return line;
			}
			const demotedTitle = title
				.replace(/^[-*]\s+/, "")
				.replace(/[|]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			if (!demotedTitle) return "";
			return `${match[1]}**${demotedTitle.replace(/[.:;]+$/g, "")}.**`;
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function needsAssemblyRepair(input: {
	markdown: string;
	acceptedSourceTitles: string[];
}): boolean {
	return (
		looksLikeProcessOnlyReport(input.markdown) ||
		looksLikeMalformedAssembledReport(input)
	);
}

function buildAssembleRepairPrompt(input: {
	basePrompt: string;
	previousDraft: string;
	language: SupportedLanguage;
}): string {
	const repairInstruction =
		input.language === "hu"
			? "Az előző vázlat folyamatleírás volt. Írd újra teljes Atlas jelentésként valódi, forrásalapú megállapításokkal. Ne mondd el, hogy forrásokat ellenőriztél vagy szintetizáltál; mondd el, mit bizonyítanak a források."
			: "The previous draft was a process summary. Rewrite it as a complete Atlas report with real source-grounded findings. Do not say that sources were checked or findings were synthesized; state what the sources actually show.";
	return JSON.stringify({
		...JSON.parse(input.basePrompt),
		repairInstruction,
		previousProcessOnlyDraft: input.previousDraft,
	});
}

interface AtlasFallbackReportSection {
	title: string;
	text: string;
	limitations: string[];
}

function fallbackSectionLabels(language: SupportedLanguage): {
	executive: string;
	findings: string;
	tradeoffs: string;
	recommendations: string;
	limitations: string;
} {
	if (language === "hu") {
		return {
			executive: "Vezetői összefoglaló",
			findings: "Megállapítások",
			tradeoffs: "Kompromisszumok",
			recommendations: "Ajánlás",
			limitations: "Korlátok",
		};
	}
	return {
		executive: "Executive Summary",
		findings: "Findings",
		tradeoffs: "Tradeoffs",
		recommendations: "Recommendation",
		limitations: "Limitations",
	};
}

function cleanFallbackStageText(value: string): string {
	return value
		.replace(/```[\s\S]*?```/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function cleanFallbackScalar(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed || null;
}

function normalizedFallbackHeading(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
}

function outlineTitleCandidate(value: string): string | null {
	const cleaned = cleanFallbackScalar(
		value
			.replace(/^#{1,6}\s+/, "")
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+(?:\.\d+)*[.)]?\s+/, "")
			.replace(/^section\s+\d+\s*[:.-]\s*/i, ""),
	);
	if (!cleaned) return null;
	const delimiterMatch = /\s[-–—]\s|:\s/.exec(cleaned);
	const title = delimiterMatch
		? cleaned.slice(0, delimiterMatch.index).trim()
		: cleaned.trim();
	if (title.length < 3 || title.length > 80) return null;
	if (/[.!?]\s+\S/.test(title)) return null;
	if (isReportEnvelopeHeading(title)) return null;
	if (isReportScalarOnlyHeading(title)) return null;
	if (isEvidencePackIdFragment(title)) return null;
	const normalized = normalizedFallbackHeading(title);
	if (
		[
			"outline",
			"report outline",
			"core insight",
			"lead candidates",
			"key tradeoff",
			"table",
			"top models",
			"key model characteristics",
		].includes(normalized)
	) {
		return null;
	}
	if (/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(title)) return null;
	if (
		/\b(source|sources|bibliography|references|forras|forrasok|hivatkozasok)\b/i.test(
			title,
		)
	) {
		return null;
	}
	return title.replace(/[.:;,-]+$/g, "").trim() || null;
}

function canonicalFallbackSectionTitle(
	title: string,
	language: SupportedLanguage,
): string {
	const labels = fallbackSectionLabels(language);
	const normalized = normalizedFallbackHeading(title);
	if (
		normalized === "executive summary" ||
		normalized === "summary" ||
		normalized === "vezetoi osszefoglalo" ||
		normalized === "osszefoglalo"
	) {
		return labels.executive;
	}
	if (
		normalized === "limitations" ||
		normalized === "limits" ||
		normalized === "korlatok"
	) {
		return labels.limitations;
	}
	if (
		normalized === "findings" ||
		normalized === "key findings" ||
		normalized === "megallapitasok"
	) {
		return labels.findings;
	}
	if (
		normalized === "tradeoffs" ||
		normalized === "trade offs" ||
		normalized === "trade off" ||
		normalized === "kompromisszumok"
	) {
		return labels.tradeoffs;
	}
	if (
		normalized === "recommendation" ||
		normalized === "recommendations" ||
		normalized === "recommended path" ||
		normalized === "ajanlas" ||
		normalized === "ajanlasok"
	) {
		return labels.recommendations;
	}
	return title;
}

function uniqueFallbackSectionTitles(
	titles: string[],
	language: SupportedLanguage,
): string[] {
	const labels = fallbackSectionLabels(language);
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const rawTitle of titles) {
		const title = canonicalFallbackSectionTitle(rawTitle, language);
		const key = normalizedFallbackHeading(title);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(title);
	}
	const defaultMiddleSections = [
		labels.findings,
		labels.tradeoffs,
		labels.recommendations,
	];
	const requiredKeys = new Set(
		[labels.executive, ...defaultMiddleSections, labels.limitations].map(
			normalizedFallbackHeading,
		),
	);
	const customSections = unique.filter(
		(title) =>
			!requiredKeys.has(normalizedFallbackHeading(title)) &&
			isCleanCustomFallbackSectionTitle(title),
	);
	return [
		labels.executive,
		...defaultMiddleSections,
		...customSections.slice(0, 5),
		labels.limitations,
	];
}

function isCleanCustomFallbackSectionTitle(title: string): boolean {
	const normalized = normalizedFallbackHeading(title);
	if (!normalized || isFallbackTableFragment(title)) return false;
	if (isReportScalarOnlyHeading(title)) return false;
	if (isEvidencePackIdFragment(title)) return false;
	if (/^[a-z]/.test(title.trim())) return false;
	if (title.includes(":") || title.includes("|")) return false;
	if (
		/\b(evidence packs?|source ids?|accepted evidence|report outline)\b/i.test(
			title,
		)
	) {
		return false;
	}
	const tokens = normalized.split(/\s+/).filter(Boolean);
	return tokens.length >= 2 && tokens.length <= 6;
}

function isEvidencePackIdFragment(value: string): boolean {
	return /(?:^|[^a-z0-9])atlas-pack-v\d[-_a-z0-9]*/i.test(value);
}

function extractFallbackOutlineTitles(
	outline: string,
	language: SupportedLanguage,
): string[] {
	const parsed = parseJsonObject(outline);
	const parsedBriefs = parsed ? parseSectionBriefs(parsed.sectionBriefs) : [];
	const parsedTitles = parsedBriefs.map((brief) => brief.sectionTitle);
	if (parsedTitles.length > 0) {
		return uniqueFallbackSectionTitles(parsedTitles, language);
	}

	const cleaned = cleanFallbackStageText(outline)
		.replace(/^\s*outline\s*:\s*/i, "")
		.trim();
	const chunks = cleaned
		.split(/\n+|;/)
		.map(outlineTitleCandidate)
		.filter((title): title is string => Boolean(title));
	return uniqueFallbackSectionTitles(chunks, language);
}

function stripFallbackSectionPrefix(value: string): {
	prefix: string | null;
	body: string;
} {
	const cleaned = cleanFallbackScalar(
		value
			.replace(/^#{1,6}\s+/, "")
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+(?:\.\d+)*[.)]?\s+/, ""),
	);
	if (!cleaned) return { prefix: null, body: "" };
	const delimiterMatch = /\s[-–—]\s|:\s/.exec(cleaned);
	if (!delimiterMatch) return { prefix: null, body: cleaned };
	const prefix = cleaned.slice(0, delimiterMatch.index).trim();
	const body = cleaned
		.slice(delimiterMatch.index + delimiterMatch[0].length)
		.trim();
	if (prefix.length < 3 || prefix.length > 80 || !body) {
		return { prefix: null, body: cleaned };
	}
	return { prefix, body };
}

function isProcessFallbackStatement(value: string): boolean {
	return (
		/\bI\s+(?:checked|reviewed|consulted|examined)\b/i.test(value) ||
		/\bsources?\s+(?:checked|reviewed|consulted|examined)\b/i.test(value) ||
		/\bsynthesi[sz]ed\s+(?:the\s+)?findings\b/i.test(value) ||
		/\bcompleted\s+(?:the\s+)?research\b/i.test(value)
	);
}

function isFallbackTableFragment(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	const pipeCount = (trimmed.match(/\|/g) ?? []).length;
	return (
		trimmed.startsWith("|") ||
		/^\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+$/.test(trimmed) ||
		pipeCount >= 3
	);
}

function isLowQualityFallbackText(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return true;
	if (isFallbackTableFragment(trimmed)) return true;
	if (isReportScalarOnlyHeading(trimmed)) return true;
	if (isEvidencePackIdFragment(trimmed)) return true;
	if (/[|\u00b7\ue000]/.test(trimmed)) return true;
	if (/:\.$/.test(trimmed)) return true;
	if (/\.\.\./.test(trimmed)) return true;
	const normalized = normalizedReportShapeText(trimmed);
	return /\b(search result snippet|fetched page excerpt|evidence packs used|loading chart|copied to clipboard|source ids?|rating|ertekeles|eur|cookie)\b/i.test(
		normalized,
	);
}

function fallbackStatementsFromStageText(value: string): Array<{
	prefix: string | null;
	body: string;
}> {
	return cleanFallbackStageText(value)
		.split(/\n+/)
		.flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/))
		.map(stripFallbackSectionPrefix)
		.map((entry) => ({
			prefix: entry.prefix,
			body: ensureTerminalPunctuation(entry.body),
		}))
		.filter(
			(entry) =>
				entry.body.length >= 30 &&
				!isProcessFallbackStatement(entry.body) &&
				!isLowQualityFallbackText(entry.body),
		)
		.slice(0, 32);
}

function fallbackStatementsFromEvidencePacks(
	evidencePacks: AtlasEvidencePack[],
): Array<{ prefix: string | null; body: string }> {
	return evidencePacks
		.map((pack) => cleanFallbackScalar(pack.evidence.summary))
		.filter((summary): summary is string => Boolean(summary))
		.filter(
			(summary) =>
				!isProcessFallbackStatement(summary) &&
				!isLowQualityFallbackText(summary),
		)
		.map((summary) => ({
			prefix: null,
			body: ensureTerminalPunctuation(summary),
		}))
		.slice(0, 16);
}

function sectionTitleTokenSet(title: string): Set<string> {
	const stopwords = new Set([
		"and",
		"the",
		"for",
		"with",
		"summary",
		"executive",
		"limitations",
		"limits",
		"section",
		"vezetoi",
		"osszefoglalo",
		"korlatok",
	]);
	return new Set(
		normalizedFallbackHeading(title)
			.split(/\s+/)
			.filter((token) => token.length >= 4 && !stopwords.has(token)),
	);
}

function statementMatchesSectionTitle(
	statement: { prefix: string | null; body: string },
	title: string,
): boolean {
	const sectionKey = normalizedFallbackHeading(title);
	if (
		statement.prefix &&
		normalizedFallbackHeading(statement.prefix) === sectionKey
	) {
		return true;
	}
	const tokens = sectionTitleTokenSet(title);
	if (tokens.size === 0) return false;
	const body = normalizedFallbackHeading(
		`${statement.prefix ?? ""} ${statement.body}`,
	);
	let matches = 0;
	for (const token of tokens) {
		if (body.includes(token)) matches += 1;
	}
	return matches >= Math.min(2, tokens.size);
}

function fallbackLimitationsText(input: {
	language: SupportedLanguage;
	limitation: { code: string; message: string } | null;
	evidencePacks: AtlasEvidencePack[];
}): string {
	const packLimitations = input.evidencePacks
		.flatMap((pack) => pack.limitations)
		.map(cleanFallbackScalar)
		.filter((limitation): limitation is string => Boolean(limitation))
		.filter((limitation) => !isLowQualityFallbackText(limitation))
		.slice(0, 3);
	if (input.limitation)
		return ensureTerminalPunctuation(input.limitation.message);
	if (packLimitations.length > 0) {
		return packLimitations.map(ensureTerminalPunctuation).join(" ");
	}
	return input.language === "hu"
		? "A jelentés az elfogadott Atlas forrásokra korlátozódik; a gyenge vagy hiányzó bizonyítékokat óvatosan kell kezelni."
		: "The report is limited to the accepted Atlas sources; weak or missing evidence should be treated cautiously.";
}

function fallbackTextForSection(input: {
	title: string;
	language: SupportedLanguage;
	query: string;
	statements: Array<{ prefix: string | null; body: string }>;
	usedStatementIndexes: Set<number>;
	limitation: { code: string; message: string } | null;
	evidencePacks: AtlasEvidencePack[];
}): string {
	const labels = fallbackSectionLabels(input.language);
	const sectionKey = normalizedFallbackHeading(input.title);
	const executiveKey = normalizedFallbackHeading(labels.executive);
	const limitationsKey = normalizedFallbackHeading(labels.limitations);
	if (sectionKey === limitationsKey) {
		return fallbackLimitationsText(input);
	}
	const matchedIndex = input.statements.findIndex(
		(statement, statementIndex) =>
			!input.usedStatementIndexes.has(statementIndex) &&
			statementMatchesSectionTitle(statement, input.title),
	);
	if (matchedIndex >= 0) {
		input.usedStatementIndexes.add(matchedIndex);
		return developFallbackSectionText({
			...input,
			baseText: input.statements[matchedIndex].body,
		});
	}
	if (sectionKey === executiveKey) {
		const executiveStatements = input.statements
			.filter(
				(_, statementIndex) => !input.usedStatementIndexes.has(statementIndex),
			)
			.slice(0, 2);
		executiveStatements.forEach((statement) => {
			const index = input.statements.indexOf(statement);
			if (index >= 0) input.usedStatementIndexes.add(index);
		});
		if (executiveStatements.length > 0) {
			return developFallbackSectionText({
				...input,
				baseText: executiveStatements
					.map((statement) => statement.body)
					.join(" "),
			});
		}
	}
	const fallbackIndex = input.statements.findIndex(
		(_, statementIndex) => !input.usedStatementIndexes.has(statementIndex),
	);
	if (fallbackIndex >= 0) {
		input.usedStatementIndexes.add(fallbackIndex);
		return developFallbackSectionText({
			...input,
			baseText: input.statements[fallbackIndex].body,
		});
	}
	return developFallbackSectionText({
		...input,
		baseText:
			input.language === "hu"
				? "Az elfogadott bizonyítékok alapján csak óvatos, forráshoz kötött megállapítás adható ehhez a szakaszhoz."
				: "The accepted evidence supports only a cautious, source-bounded finding for this section.",
	});
}

function fallbackSentenceCount(value: string): number {
	return Math.max(0, value.match(/[.!?]+(?=\s|$)/g)?.length ?? 0);
}

function fallbackQueryNounPhrase(query: string): string {
	const cleaned = normalizeFallbackTitle(query)
		?.replace(/[?!.]+$/g, "")
		.trim();
	return cleaned
		? cleaned.charAt(0).toLowerCase() + cleaned.slice(1)
		: "this decision";
}

function fallbackSourceBasisText(input: {
	language: SupportedLanguage;
	evidencePacks: AtlasEvidencePack[];
}): string {
	const sourceTitles = input.evidencePacks
		.flatMap((pack) => pack.sourceRefs.map((ref) => ref.title))
		.map(cleanFallbackScalar)
		.filter((title): title is string => Boolean(title))
		.slice(0, 3);
	if (sourceTitles.length === 0) {
		return input.language === "hu"
			? "A bizonyítékalap reprezentatív, ezért az állításokat ellenőrzött bevezetési mérőszámokkal kell megerősíteni."
			: "The evidence base is representative, so the claims should be validated with measured rollout data before adoption.";
	}
	return input.language === "hu"
		? `A legerősebb forrásjelek ezekhez a forrásokhoz kötődnek: ${sourceTitles.join(", ")}.`
		: `The strongest source signals come from ${sourceTitles.join(", ")}.`;
}

function developFallbackSectionText(input: {
	title: string;
	language: SupportedLanguage;
	query: string;
	baseText: string;
	statements: Array<{ prefix: string | null; body: string }>;
	usedStatementIndexes: Set<number>;
	limitation: { code: string; message: string } | null;
	evidencePacks: AtlasEvidencePack[];
}): string {
	const labels = fallbackSectionLabels(input.language);
	const sectionKey = normalizedFallbackHeading(input.title);
	const querySubject = fallbackQueryNounPhrase(input.query);
	const sourceBasis = fallbackSourceBasisText(input);
	const baseText = ensureTerminalPunctuation(input.baseText);
	const additions: string[] = [];
	if (
		sectionKey === normalizedFallbackHeading(labels.limitations) ||
		/\b(?:limitations?|constraints?|korlatok)\b/i.test(sectionKey)
	) {
		additions.push(
			input.language === "hu"
				? "Ezért a végső döntést saját korpuszon, késleltetési célokon és üzemeltetési korlátokon kell validálni."
				: "The final decision should therefore be validated against the user's corpus, latency target, and operating constraints.",
		);
	} else if (
		sectionKey === normalizedFallbackHeading(labels.recommendations) ||
		/\b(?:recommend|decision|verdict|ajanlas)\b/i.test(sectionKey)
	) {
		additions.push(
			input.language === "hu"
				? `Az ajánlott út az, hogy a legerősebben alátámasztott mintát használd kiindulópontként a(z) ${querySubject} kérdésben, majd csak mért validáció után szélesítsd a bevezetést.`
				: `We recommend using the strongest supported pattern as the starting point for ${querySubject}, then widening deployment only after measured validation.`,
		);
		additions.push(sourceBasis);
	} else if (
		sectionKey === normalizedFallbackHeading(labels.tradeoffs) ||
		/\b(?:tradeoff|cost|latency|deployment|kompromisszum)\b/i.test(sectionKey)
	) {
		additions.push(
			input.language === "hu"
				? "A gyakorlati kompromisszum az, hogy a minőségi jelzéseket, költséget, késleltetést, karbantarthatóságot és auditálhatóságot együtt kell mérni, nem külön-külön."
				: "The practical tradeoff is to evaluate quality signals, cost, latency, maintainability, and auditability together instead of optimizing one metric in isolation.",
		);
		additions.push(sourceBasis);
	} else if (
		sectionKey === normalizedFallbackHeading(labels.executive) ||
		/\b(?:summary|overview|osszefoglalo)\b/i.test(sectionKey)
	) {
		additions.push(
			input.language === "hu"
				? `A döntési következmény az, hogy a(z) ${querySubject} kérdésben nem érdemes puszta rangsort közölni; a választ a működési kockázatokkal és bizonyítékhiányokkal együtt kell rögzíteni.`
				: `The decision implication is that ${querySubject} should not be treated as a bare ranking; the answer needs to preserve operating risks and evidence gaps alongside the preferred path.`,
		);
		additions.push(sourceBasis);
	} else {
		additions.push(
			input.language === "hu"
				? "A szakasz következtetése ezért döntési bemenetként használható, de nem helyettesíti a saját környezetben végzett validációt."
				: "That makes this section useful as decision input, but it does not replace validation in the user's own environment.",
		);
		additions.push(sourceBasis);
	}
	if (sectionKey !== normalizedFallbackHeading(labels.limitations)) {
		additions.push(
			input.language === "hu"
				? "A bizonyítékot ezért nem forráslistaként kell olvasni, hanem döntési ellenőrzőpontként: mi támogatott, mi vitatott, és mit kell mérni a következő lépés előtt."
				: "The evidence should therefore be read as a decision checkpoint rather than a source list: what is supported, what remains contested, and what must be measured before the next step.",
		);
		additions.push(
			input.language === "hu"
				? "A végrehajtás sorrendje legyen mérhető: először a legerősebb állítást validáld, majd a kockázatosabb opciókat csak akkor vedd be, ha új bizonyíték vagy saját teszt igazolja őket."
				: "Execution should be staged and measurable: validate the strongest claim first, then add riskier options only when new evidence or local testing justifies them.",
		);
	}
	const expanded = [baseText, ...additions]
		.map(ensureTerminalPunctuation)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (
		fallbackSentenceCount(expanded) >= 3 ||
		sectionKey === normalizedFallbackHeading(labels.limitations)
	) {
		return expanded;
	}
	const validationSentence =
		input.language === "hu"
			? "A bevezetési sorrendet a legerősebb bizonyíték, a maradék bizonytalanság és a mérhető üzemeltetési cél együtt határozza meg."
			: "The rollout order should be set by the strongest evidence, the remaining uncertainty, and the measurable operating target together.";
	return `${expanded} ${validationSentence}`;
}

function buildFallbackReportSections(input: {
	language: SupportedLanguage;
	query: string;
	curatedEvidence: string;
	synthesis: string;
	outline: string;
	evidencePacks: AtlasEvidencePack[];
	limitation: { code: string; message: string } | null;
}): AtlasFallbackReportSection[] {
	const titles = extractFallbackOutlineTitles(input.outline, input.language);
	const statements = [
		...fallbackStatementsFromStageText(input.synthesis),
		...fallbackStatementsFromStageText(input.curatedEvidence),
		...fallbackStatementsFromEvidencePacks(input.evidencePacks),
	];
	const usedStatementIndexes = new Set<number>();
	return titles.map((title) => {
		const limitations =
			normalizedFallbackHeading(title) ===
			normalizedFallbackHeading(
				fallbackSectionLabels(input.language).limitations,
			)
				? [fallbackLimitationsText(input)]
				: [];
		return {
			title,
			text: fallbackTextForSection({
				title,
				language: input.language,
				query: input.query,
				statements,
				usedStatementIndexes,
				limitation: input.limitation,
				evidencePacks: input.evidencePacks,
			}),
			limitations,
		};
	});
}

function buildFallbackSectionBriefsFromSections(input: {
	sections: AtlasFallbackReportSection[];
	evidencePacks: AtlasEvidencePack[];
}): AtlasSectionBrief[] {
	const packs = input.evidencePacks
		.filter((pack) => pack.sourceRefs.length > 0)
		.slice(0, 8);
	const evidencePackIds = packs.map((pack) => pack.id);
	const sourceAssociations = sourceAssociationsFromEvidencePacks(packs);
	return input.sections.map((section) => ({
		sectionTitle: section.title,
		brief: compactSectionBrief(section.text),
		evidencePackIds,
		sourceAssociations,
		limitations: section.limitations,
	}));
}

function buildDeterministicFallbackReport(input: {
	language: SupportedLanguage;
	query: string;
	curatedEvidence: string;
	synthesis: string;
	outline: string;
	evidencePacks: AtlasEvidencePack[];
	sources: Array<{
		title: string;
		url?: string | null;
		reasoning?: string | null;
	}>;
	limitation: { code: string; message: string } | null;
}): { markdown: string; metadata: AtlasAssemblyMetadata } {
	const title = buildFallbackGeneratedTitle({
		language: input.language,
		query: input.query,
		sources: input.sources,
	});
	const sections = buildFallbackReportSections({
		language: input.language,
		query: input.query,
		curatedEvidence: input.curatedEvidence,
		synthesis: input.synthesis,
		outline: input.outline,
		evidencePacks: input.evidencePacks,
		limitation: input.limitation,
	});
	const sectionBriefs = buildFallbackSectionBriefsFromSections({
		sections,
		evidencePacks: input.evidencePacks,
	});
	const markdown = [
		`# ${title}`,
		"",
		...sections.flatMap((section) => [`## ${section.title}`, section.text, ""]),
	].join("\n");
	return {
		markdown,
		metadata: {
			version: ATLAS_ASSEMBLY_SCHEMA_VERSION,
			generatedTitle: title,
			sectionBriefs,
			limitations: input.limitation ? [input.limitation.message] : [],
			structured: true,
		},
	};
}

function buildFallbackGeneratedTitle(input: {
	language: SupportedLanguage;
	query: string;
	sources: Array<{ title: string }>;
}): string {
	const queryTitle = normalizeFallbackTitle(input.query);
	if (queryTitle) return queryTitle;
	const sourceTitle = normalizeFallbackTitle(input.sources[0]?.title);
	if (sourceTitle) return sourceTitle;
	return input.language === "hu"
		? "Forrásalapú Atlas jelentés"
		: "Source-Grounded Atlas Report";
}

function normalizeFallbackTitle(
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	const normalized = value
		.replace(/^#+\s*/, "")
		.replace(
			/^(create|generate|write|build)\s+(a\s+)?(concise|brief|detailed|in-depth|exhaustive|overview\s+)?(atlas\s+)?(overview\s+)?report\s+(comparing|about|on|for)\s+/i,
			"",
		)
		.replace(
			/\s+[-|:]\s+(Better Stack Community|A Developer.*|Dev\.to|GitHub).*$/i,
			"",
		)
		.replace(/\s*[|]\s*[^|]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized || /^atlas report$/i.test(normalized)) return null;
	const clipped =
		normalized.length <= 120
			? normalized
			: normalized
					.slice(0, 121)
					.replace(/\s+\S*$/, "")
					.trim();
	return clipped.length >= 4 ? clipped : null;
}

function sourceAssociationsFromEvidencePacks(
	packs: AtlasEvidencePack[],
): AtlasSectionBriefSourceAssociation[] {
	return packs
		.flatMap((pack) =>
			pack.sourceRefs.map((sourceRef) => ({
				sourceId: sourceRef.id,
				sourceKind: sourceRef.kind,
				sourceTitle: sourceRef.title,
				url: sourceRef.url,
				evidencePackId: pack.id,
				relevance: pack.evidence.summary,
			})),
		)
		.slice(0, 24);
}

function compactSectionBrief(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= 360) return normalized;
	return `${normalized
		.slice(0, 361)
		.replace(/\s+\S*$/, "")
		.trim()}...`;
}

function ensureTerminalPunctuation(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const FINAL_REPORT_GATE_WARNING_CODES = new Set([
	"atlas_report_sections_too_sparse",
	"atlas_too_many_one_sentence_sections",
	"atlas_source_projection_dominates_report",
	"atlas_too_many_images_for_body_size",
	"atlas_claim_shaped_headings",
]);
const FINAL_REPORT_HARD_STOP_CODES = new Set([
	"atlas_report_sections_too_sparse",
	"atlas_too_many_one_sentence_sections",
	"atlas_source_projection_dominates_report",
	"atlas_claim_shaped_headings",
	"atlas_final_source_share_too_high",
	"atlas_final_sections_too_shallow",
]);

interface AtlasFinalReportQualityGate {
	passed: boolean;
	fallbackApplied: boolean;
	reasonWarningCodes: string[];
	reasonMessages: string[];
	before: AtlasReportShapeDiagnostics;
	after?: AtlasReportShapeDiagnostics;
}

function finalReportQualityFailures(diagnostics: AtlasReportShapeDiagnostics): {
	reasonWarningCodes: string[];
	reasonMessages: string[];
} {
	const reasonWarningCodes: string[] = diagnostics.warnings
		.map((warning) => warning.code)
		.filter((code) => FINAL_REPORT_GATE_WARNING_CODES.has(code));
	const reasonMessages: string[] = diagnostics.warnings
		.filter((warning) => FINAL_REPORT_GATE_WARNING_CODES.has(warning.code))
		.map((warning) => warning.message);
	if (
		diagnostics.bodyWordCount > 0 &&
		diagnostics.bodyWordCount < 550 &&
		(diagnostics.sectionCount >= 6 ||
			diagnostics.sourceWordShare >= 0.45 ||
			diagnostics.oneSentenceSectionCount >= 4)
	) {
		reasonWarningCodes.push("atlas_final_body_word_count_too_low");
		reasonMessages.push(
			"Final Atlas report body is too short for a decision-quality report after audit and rendering preparation.",
		);
	}
	if (
		diagnostics.sourceWordCount >= 250 &&
		diagnostics.sourceWordShare >= 0.5 &&
		diagnostics.bodyWordCount < 900
	) {
		reasonWarningCodes.push("atlas_final_source_share_too_high");
		reasonMessages.push(
			"Final Atlas source projection occupies too much of the rendered report relative to the authored body.",
		);
	}
	if (
		diagnostics.sectionCount >= 6 &&
		diagnostics.oneSentenceSectionCount / diagnostics.sectionCount >= 0.5 &&
		diagnostics.substantiveSectionCount <= 2
	) {
		reasonWarningCodes.push("atlas_final_sections_too_shallow");
		reasonMessages.push(
			"Final Atlas report has too many shallow one-sentence sections after the model improvement pass.",
		);
	}
	return {
		reasonWarningCodes: Array.from(new Set(reasonWarningCodes)),
		reasonMessages: Array.from(new Set(reasonMessages)),
	};
}

function shouldHardStopAfterFinalFallback(failures: {
	reasonWarningCodes: string[];
}): boolean {
	return failures.reasonWarningCodes.some((code) =>
		FINAL_REPORT_HARD_STOP_CODES.has(code),
	);
}

export async function runAtlasPipeline(
	input: RunAtlasPipelineInput,
): Promise<AtlasPipelineResult> {
	const language = detectLanguage(input.job.query);
	const now = input.now ?? new Date();
	const currentDate = now.toISOString().slice(0, 10);
	const profileConfig = getAtlasProfileRuntimeConfig(input.job.profile);
	const profilePosture = profileConfig.promptPosture[language];
	const sources = await input.dependencies.resolveSources();
	const usageSeed: AtlasStageUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsdMicros: 0,
	};
	let usage = usageSeed;

	await input.dependencies.heartbeat?.({
		stage: "decompose",
		progressPercent: 10,
	});
	const decompose = await input.dependencies.runModelStage({
		stage: "decompose",
		system: stageSystem("decompose", language, currentDate, profilePosture),
		prompt: seededPrompt({
			query: input.job.query,
			lifecycle: input.job.lifecycle,
			language,
			currentDate,
		}),
	});
	usage = addUsage(usage, decompose.usage);
	const searchQueries = buildAtlasSearchQueries({
		query: input.job.query,
		decomposeText: decompose.text,
		now,
		maxQueries: profileConfig.maxSearchQueries,
	});
	const researchRounds: AtlasResearchRoundResult[] = [];
	const initialRound = await runAtlasResearchRound({
		job: input.job,
		roundNumber: 1,
		roundKind: "initial",
		language,
		currentDate,
		now,
		profileConfig,
		profilePosture,
		localSources: sources.localSources,
		existingWebSources: [],
		existingRejectedWebSources: [],
		searchQueries,
		approvedGaps: [],
		decomposeText: decompose.text,
		parentCuratedSourcePool:
			input.job.lifecycle.seed?.curatedSourcePool ?? null,
		completedGapFillRoundsForReview: 0,
		dependencies: input.dependencies,
	});
	usage = addUsage(usage, initialRound.usage);
	researchRounds.push(initialRound);
	let latestRound = initialRound;

	const gapFillCaps = profileConfig.architecture.gapFillCaps;
	for (
		let completedGapFillRounds = 0;
		completedGapFillRounds < gapFillCaps.maxRounds;
		completedGapFillRounds += 1
	) {
		const gapSearch = buildGapFillSearchQueries({
			coverageReview: latestRound.coverageReview,
			maxQueries: gapFillCaps.maxSearchQueries,
		});
		if (gapSearch.queries.length === 0 || gapSearch.approvedGaps.length === 0) {
			break;
		}
		const gapRound = await runAtlasResearchRound({
			job: input.job,
			roundNumber: completedGapFillRounds + 2,
			roundKind: "gap-fill",
			language,
			currentDate,
			now,
			profileConfig,
			profilePosture,
			localSources: sources.localSources,
			existingWebSources: latestRound.webSources,
			existingRejectedWebSources: latestRound.rejectedWebSources,
			searchQueries: gapSearch.queries,
			approvedGaps: gapSearch.approvedGaps,
			decomposeText: decompose.text,
			parentCuratedSourcePool:
				input.job.lifecycle.seed?.curatedSourcePool ?? null,
			completedGapFillRoundsForReview: completedGapFillRounds + 1,
			dependencies: input.dependencies,
		});
		usage = addUsage(usage, gapRound.usage);
		researchRounds.push(gapRound);
		latestRound = gapRound;
		if (!gapRound.qualityDiagnostics.gapFill?.useful) {
			break;
		}
	}

	const finalResearchRound = latestRound;
	const imageSearch = initialRound.imageSearch;
	const evidencePackResult = finalResearchRound.evidencePackResult;
	const evidencePackDiagnostics = finalResearchRound.evidencePackDiagnostics;
	const coverageReview = finalResearchRound.coverageReview;
	const searchLimitation = combineResearchRoundLimitations(researchRounds);

	await input.dependencies.heartbeat?.({
		stage: "synthesize",
		progressPercent: 55,
	});
	const synthesize = await input.dependencies.runModelStage({
		stage: "synthesize",
		system: stageSystem("synthesize", language, currentDate, profilePosture),
		prompt: JSON.stringify({
			detectedLanguage: language,
			currentDate,
			evidencePacksVersion: evidencePackResult.version,
			evidencePacks: evidencePackResult.evidencePacks,
			evidencePackDiagnostics,
			coverageReview,
			curationSummary: finalResearchRound.curatedEvidence,
			parentCompressedFindings:
				input.job.lifecycle.seed?.compressedFindings ?? null,
			atlasLifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, synthesize.usage);

	await input.dependencies.heartbeat?.({
		stage: "integrate",
		progressPercent: 70,
	});
	const integrate = await input.dependencies.runModelStage({
		stage: "integrate",
		system: stageSystem("integrate", language, currentDate, profilePosture),
		prompt: JSON.stringify({
			detectedLanguage: language,
			currentDate,
			synthesis: synthesize.text,
			evidencePacksVersion: evidencePackResult.version,
			evidencePacks: evidencePackResult.evidencePacks,
			evidencePackDiagnostics,
			coverageReview,
			atlasLifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, integrate.usage);

	const integratedSectionBriefs = sectionBriefsFromIntegration(integrate.text);
	const deterministicWriterEvidenceCardResult = buildAtlasWriterEvidenceCards({
		evidencePacks: evidencePackResult.evidencePacks,
		sectionHintsByEvidencePackId: sectionHintsByEvidencePackId(
			integratedSectionBriefs,
		),
	});
	const routedWriterEvidenceCardResult = await routeAtlasWriterEvidenceCards({
		writerEvidenceCards:
			deterministicWriterEvidenceCardResult.writerEvidenceCards,
		userQuery: input.job.query,
		sectionBriefs: integratedSectionBriefs,
		reranker: input.dependencies.rerankWriterEvidenceCards,
	});
	const writerEvidenceCardResult = {
		version: deterministicWriterEvidenceCardResult.version,
		writerEvidenceCards: routedWriterEvidenceCardResult.writerEvidenceCards,
		diagnostics: [
			...deterministicWriterEvidenceCardResult.diagnostics,
			...routedWriterEvidenceCardResult.diagnostics,
		],
	};
	const writerPromptInput = {
		language,
		query: input.job.query,
		currentDate,
		profile: input.job.profile,
		profilePosture,
		decomposeText: decompose.text,
		synthesis: synthesize.text,
		outline: integrate.text,
		sectionBriefs: integratedSectionBriefs,
		imageCandidates: imageSearch.imageCandidates,
		writerEvidenceCardsVersion: writerEvidenceCardResult.version,
		writerEvidenceCards: writerEvidenceCardResult.writerEvidenceCards,
		writerEvidenceCardDiagnostics: writerEvidenceCardResult.diagnostics,
		evidencePackDiagnostics,
		coverageReview,
		limitation: searchLimitation,
		lifecycle: input.job.lifecycle.family,
	};
	const writerPrompt = buildAtlasWriterPrompt(writerPromptInput);

	await input.dependencies.heartbeat?.({
		stage: "assemble",
		progressPercent: 82,
	});
	const assemble = await input.dependencies.runModelStage({
		stage: "assemble",
		system: stageSystem("assemble", language, currentDate, profilePosture),
		prompt: writerPrompt,
	});
	usage = addUsage(usage, assemble.usage);
	let assemblyOutput = parseAtlasAssemblyOutput(assemble.text);
	let assemblyMetadata = assemblyOutput.metadata;
	let finalAssembledMarkdown = assemblyOutput.markdown;
	let usedDeterministicFallbackBeforeImprovement = false;
	let firstDraftReportShapeDiagnostics: AtlasReportShapeDiagnostics | null =
		null;
	let writerImprovement = {
		ran: false,
		passCount: 0,
		reasonWarningCodes: [] as string[],
		startedAfterDeterministicFallback: false,
	};
	const acceptedSourceTitles = [
		...sources.localSources.map((source) => source.title),
		...finalResearchRound.webSources.map((source) => source.title),
	];
	const fallbackSources = [
		...sources.localSources.map((source) => ({
			title: source.title,
			url: null,
			reasoning: source.text,
		})),
		...finalResearchRound.webSources.map((source) => ({
			title: source.title,
			url: source.url,
			reasoning: source.snippet,
		})),
	];
	if (
		needsAssemblyRepair({
			markdown: finalAssembledMarkdown,
			acceptedSourceTitles,
		})
	) {
		await input.dependencies.heartbeat?.({
			stage: "assemble",
			progressPercent: 86,
		});
		const repair = await input.dependencies.runModelStage({
			stage: "assemble",
			system: stageSystem("assemble", language, currentDate, profilePosture),
			prompt: buildAssembleRepairPrompt({
				basePrompt: writerPrompt,
				previousDraft: finalAssembledMarkdown,
				language,
			}),
		});
		usage = addUsage(usage, repair.usage);
		assemblyOutput = parseAtlasAssemblyOutput(repair.text);
		assemblyMetadata = mergeAssemblyMetadata(
			assemblyMetadata,
			assemblyOutput.metadata,
		);
		finalAssembledMarkdown = assemblyOutput.markdown;
	}
	if (
		needsAssemblyRepair({
			markdown: finalAssembledMarkdown,
			acceptedSourceTitles,
		})
	) {
		const fallbackReport = buildDeterministicFallbackReport({
			language,
			query: input.job.query,
			curatedEvidence: finalResearchRound.curatedEvidence,
			synthesis: synthesize.text,
			outline: integrate.text,
			evidencePacks: evidencePackResult.evidencePacks,
			sources: fallbackSources,
			limitation: searchLimitation,
		});
		finalAssembledMarkdown = fallbackReport.markdown;
		assemblyMetadata = mergeAssemblyMetadata(
			assemblyMetadata,
			fallbackReport.metadata,
		);
		usedDeterministicFallbackBeforeImprovement = true;
	}

	finalAssembledMarkdown = sanitizeMalformedWriterHeadings({
		markdown: finalAssembledMarkdown,
		acceptedSourceTitles,
	});
	firstDraftReportShapeDiagnostics = diagnoseAtlasReportShape(
		finalAssembledMarkdown,
	);
	if (shouldImproveAtlasWriterDraft(firstDraftReportShapeDiagnostics)) {
		writerImprovement = {
			ran: true,
			passCount: 1,
			reasonWarningCodes: firstDraftReportShapeDiagnostics.warnings.map(
				(warning) => warning.code,
			),
			startedAfterDeterministicFallback:
				usedDeterministicFallbackBeforeImprovement,
		};
		await input.dependencies.heartbeat?.({
			stage: "assemble",
			progressPercent: 88,
		});
		const improve = await input.dependencies.runModelStage({
			stage: "assemble",
			system: stageSystem("assemble", language, currentDate, profilePosture),
			prompt: buildAtlasWriterImprovementPrompt({
				...writerPromptInput,
				currentDraft: finalAssembledMarkdown,
				reportShapeDiagnostics: firstDraftReportShapeDiagnostics,
			}),
		});
		usage = addUsage(usage, improve.usage);
		assemblyOutput = parseAtlasAssemblyOutput(improve.text);
		assemblyMetadata = mergeAssemblyMetadata(
			assemblyMetadata,
			assemblyOutput.metadata,
		);
		finalAssembledMarkdown = assemblyOutput.markdown;
		if (
			needsAssemblyRepair({
				markdown: finalAssembledMarkdown,
				acceptedSourceTitles,
			})
		) {
			const fallbackReport = buildDeterministicFallbackReport({
				language,
				query: input.job.query,
				curatedEvidence: finalResearchRound.curatedEvidence,
				synthesis: synthesize.text,
				outline: integrate.text,
				evidencePacks: evidencePackResult.evidencePacks,
				sources: fallbackSources,
				limitation: searchLimitation,
			});
			finalAssembledMarkdown = fallbackReport.markdown;
			assemblyMetadata = mergeAssemblyMetadata(
				assemblyMetadata,
				fallbackReport.metadata,
			);
		}
		finalAssembledMarkdown = sanitizeMalformedWriterHeadings({
			markdown: finalAssembledMarkdown,
			acceptedSourceTitles,
		});
	}

	const auditSources = [
		...sources.localSources.map((source) => ({
			title: source.title,
			url: null,
		})),
		...finalResearchRound.webSources.map((source) => ({
			title: source.title,
			url: source.url,
		})),
	];
	const publishedSources = buildPublishedAtlasSources({
		localSources: sources.localSources,
		webSources: finalResearchRound.webSources,
		evidencePacks: evidencePackResult.evidencePacks,
	});
	await input.dependencies.heartbeat?.({
		stage: "audit",
		progressPercent: 92,
	});
	let audit = await input.dependencies.auditBasis({
		assembledMarkdown: finalAssembledMarkdown,
		sources: auditSources,
		limitation: searchLimitation,
		language,
		currentDate,
		evidencePacks: evidencePackResult.evidencePacks,
		evidencePackDiagnostics,
		coverageReview,
		sectionBriefs: assemblyMetadata.sectionBriefs,
		assemblyMetadata,
	});
	if (audit.usage) {
		usage = addUsage(usage, audit.usage);
	}
	if (audit.retryRequested) {
		await input.dependencies.heartbeat?.({
			stage: "assemble",
			progressPercent: 88,
		});
		const revise = await input.dependencies.runModelStage({
			stage: "assemble",
			system:
				language === "hu"
					? "Dolgozd át az Atlas jelentést az audit megállapításai alapján. Tartsd meg az alátámasztott állításokat, vedd ki a nem alátámasztott bizonyosságot, és adj hozzá kifejezett korlátokat, ahol gyenge a bizonyíték. A jelentés magyar legyen."
					: "Revise the Atlas report to address audit findings. Preserve supported claims, remove unsupported certainty, and add explicit limitations where evidence is weak.",
			prompt: JSON.stringify({
				detectedLanguage: language,
				assembledMarkdown: finalAssembledMarkdown,
				auditFindings: audit,
				evidencePacksVersion: evidencePackResult.version,
				evidencePacks: evidencePackResult.evidencePacks,
				evidencePackDiagnostics,
				coverageReview,
			}),
		});
		usage = addUsage(usage, revise.usage);
		assemblyOutput = parseAtlasAssemblyOutput(revise.text);
		assemblyMetadata = mergeAssemblyMetadata(
			assemblyMetadata,
			assemblyOutput.metadata,
		);
		finalAssembledMarkdown = assemblyOutput.markdown;
		finalAssembledMarkdown = sanitizeMalformedWriterHeadings({
			markdown: finalAssembledMarkdown,
			acceptedSourceTitles,
		});
		await input.dependencies.heartbeat?.({
			stage: "audit",
			progressPercent: 94,
		});
		audit = await input.dependencies.auditBasis({
			assembledMarkdown: finalAssembledMarkdown,
			sources: auditSources,
			limitation: searchLimitation,
			language,
			currentDate,
			evidencePacks: evidencePackResult.evidencePacks,
			evidencePackDiagnostics,
			coverageReview,
			sectionBriefs: assemblyMetadata.sectionBriefs,
			assemblyMetadata,
		});
		if (audit.usage) {
			usage = addUsage(usage, audit.usage);
		}
	}
	let auditedMarkdown =
		audit.passed && !audit.retryRequested
			? finalAssembledMarkdown
			: [
					finalAssembledMarkdown,
					"",
					"## Limitations",
					"Atlas audit requested additional verification. This version ships with explicit limitations and Basis Markers instead of unsupported certainty.",
				].join("\n");
	let claimBasis = audit.claimBasis ?? [];
	let basisLimitations = audit.basisLimitations ?? [];
	let basisDiagnostics = audit.basisDiagnostics ?? [];
	let claimBasisCoverageBySection = audit.claimBasisCoverageBySection ?? [];
	let claimBasisStatus =
		audit.claimBasisStatus ?? (claimBasis.length > 0 ? "succeeded" : "failed");
	let claimBasisFailureReason = audit.claimBasisFailureReason ?? null;
	const buildCurrentDocumentSource = () =>
		buildAtlasDocumentSource({
			title: assemblyMetadata.generatedTitle ?? input.job.title,
			subtitle: null,
			family: input.job.lifecycle.family,
			assembledMarkdown: auditedMarkdown,
			sources: publishedSources,
			honestyMarkers: audit.honestyMarkers,
			claimBasis,
			imageCandidates: imageSearch.imageCandidates,
			maxRenderedImages: profileConfig.maxRenderedImages,
			date: currentDate,
			language,
		});

	let documentSource = buildCurrentDocumentSource();
	let finalReportShapeDiagnostics = diagnoseAtlasReportShape(documentSource);
	let finalReportQualityGate: AtlasFinalReportQualityGate = {
		passed: true,
		fallbackApplied: false,
		reasonWarningCodes: [],
		reasonMessages: [],
		before: finalReportShapeDiagnostics,
	};
	const finalQualityFailures = finalReportQualityFailures(
		finalReportShapeDiagnostics,
	);
	if (finalQualityFailures.reasonWarningCodes.length > 0) {
		const fallbackReport = buildDeterministicFallbackReport({
			language,
			query: input.job.query,
			curatedEvidence: finalResearchRound.curatedEvidence,
			synthesis: synthesize.text,
			outline: integrate.text,
			evidencePacks: evidencePackResult.evidencePacks,
			sources: fallbackSources,
			limitation: searchLimitation,
		});
		const fallbackMetadata = {
			...fallbackReport.metadata,
			generatedTitle: assemblyMetadata.generatedTitle,
		};
		assemblyMetadata = mergeAssemblyMetadata(
			assemblyMetadata,
			fallbackMetadata,
		);
		finalAssembledMarkdown = sanitizeMalformedWriterHeadings({
			markdown: fallbackReport.markdown,
			acceptedSourceTitles,
		});
		await input.dependencies.heartbeat?.({
			stage: "audit",
			progressPercent: 95,
		});
		audit = await input.dependencies.auditBasis({
			assembledMarkdown: finalAssembledMarkdown,
			sources: auditSources,
			limitation: searchLimitation,
			language,
			currentDate,
			evidencePacks: evidencePackResult.evidencePacks,
			evidencePackDiagnostics,
			coverageReview,
			sectionBriefs: assemblyMetadata.sectionBriefs,
			assemblyMetadata,
		});
		if (audit.usage) {
			usage = addUsage(usage, audit.usage);
		}
		auditedMarkdown =
			audit.passed && !audit.retryRequested
				? finalAssembledMarkdown
				: [
						finalAssembledMarkdown,
						"",
						"## Limitations",
						"Atlas audit requested additional verification. This version ships with explicit limitations and Basis Markers instead of unsupported certainty.",
					].join("\n");
		claimBasis = audit.claimBasis ?? [];
		basisLimitations = audit.basisLimitations ?? [];
		basisDiagnostics = audit.basisDiagnostics ?? [];
		claimBasisCoverageBySection = audit.claimBasisCoverageBySection ?? [];
		claimBasisStatus =
			audit.claimBasisStatus ??
			(claimBasis.length > 0 ? "succeeded" : "failed");
		claimBasisFailureReason = audit.claimBasisFailureReason ?? null;
		documentSource = buildCurrentDocumentSource();
		finalReportShapeDiagnostics = diagnoseAtlasReportShape(documentSource);
		const afterFailures = finalReportQualityFailures(
			finalReportShapeDiagnostics,
		);
		finalReportQualityGate = {
			passed: afterFailures.reasonWarningCodes.length === 0,
			fallbackApplied: true,
			reasonWarningCodes: finalQualityFailures.reasonWarningCodes,
			reasonMessages: finalQualityFailures.reasonMessages,
			before: finalReportQualityGate.before,
			after: finalReportShapeDiagnostics,
		};
		if (shouldHardStopAfterFinalFallback(afterFailures)) {
			audit = {
				...audit,
				honestyMarkers: [
					...audit.honestyMarkers,
					{
						code: "atlas_final_report_quality_gate_failed",
						message: [
							"Atlas final report remained too sparse after the bounded writer improvement and deterministic expansion.",
							...afterFailures.reasonMessages,
						].join(" "),
						severity: "critical",
					},
				],
			};
		}
	}
	const canonicalTitle = assemblyMetadata.generatedTitle ?? input.job.title;
	if (assemblyMetadata.generatedTitle) {
		await input.dependencies.applyGeneratedTitle?.({
			jobId: input.job.id,
			title: assemblyMetadata.generatedTitle,
		});
	}
	const selectedImageCandidateIds = collectAtlasSelectedImageCandidateIds(
		documentSource,
		imageSearch.imageCandidates,
	);
	const writerCheckpoint = {
		evidenceCards: {
			version: writerEvidenceCardResult.version,
			count: writerEvidenceCardResult.writerEvidenceCards.length,
			diagnostics: writerEvidenceCardResult.diagnostics,
		},
		improvement: writerImprovement,
		firstDraftReportShapeDiagnostics,
		finalReportShapeDiagnostics,
		finalReportQualityGate,
	};
	const evidenceAppendixSummary = buildEvidenceAppendixSummary({
		localSources: sources.localSources,
		webSources: finalResearchRound.webSources,
		rejectedWebSources: finalResearchRound.rejectedWebSources,
	});

	for (const round of researchRounds) {
		const isFinalRound = round.roundNumber === finalResearchRound.roundNumber;
		await input.dependencies.writeCheckpoint({
			jobId: input.job.id,
			roundNumber: round.roundNumber,
			stage: isFinalRound ? "audit" : "coverage-review",
			checkpoint: {
				roundNumber: round.roundNumber,
				roundKind: round.roundKind,
				searchQueries: round.searchQueries,
				approvedGaps: round.approvedGaps,
				gapFill: round.qualityDiagnostics.gapFill ?? null,
				...(isFinalRound
					? {
							assembledMarkdown: auditedMarkdown,
							assembly: assemblyMetadata,
							honestyMarkers: audit.honestyMarkers,
							claimBasis,
							basisLimitations,
							basisDiagnostics,
							claimBasisStatus,
							claimBasisFailureReason,
							claimBasisCoverageBySection,
							imageCandidates: imageSearch.imageCandidates,
							selectedImageCandidateIds,
							writer: writerCheckpoint,
							writerEvidenceCards: writerEvidenceCardResult.writerEvidenceCards,
							reportShapeDiagnostics: finalReportShapeDiagnostics,
						}
					: {}),
				evidencePacksVersion: round.evidencePackResult.version,
				evidencePacks: round.evidencePackResult.evidencePacks,
				evidencePackDiagnostics: round.evidencePackDiagnostics,
				coverageReview: round.coverageReview,
			},
			curatedSourcePool: {
				local: sources.localSources,
				web: round.webSources,
				rejectedWeb: round.rejectedWebSources,
				images: isFinalRound ? imageSearch.imageCandidates : [],
			},
			compressedFindings: isFinalRound
				? {
						synthesize: synthesize.text,
						integrate: integrate.text,
					}
				: {
						curate: round.curatedEvidence,
						coverageReview: round.coverageReview,
					},
			usage: isFinalRound ? usage : round.usage,
			qualityDiagnostics: isFinalRound
				? {
						...audit,
						claimBasis,
						basisLimitations,
						basisDiagnostics,
						claimBasisStatus,
						claimBasisFailureReason,
						claimBasisCoverageBySection,
						...(round.qualityDiagnostics.gapFill
							? { gapFill: round.qualityDiagnostics.gapFill }
							: {}),
						researchRound: round.qualityDiagnostics,
						writer: writerCheckpoint,
						writerImprovement,
						reportShapeDiagnostics: finalReportShapeDiagnostics,
					}
				: round.qualityDiagnostics,
			documentSourceSummary: {
				title: canonicalTitle,
				generatedTitle: assemblyMetadata.generatedTitle,
				date: currentDate,
				atlasFamily: input.job.lifecycle.family,
				roundNumber: round.roundNumber,
				roundKind: round.roundKind,
				searchQueries: round.searchQueries,
				approvedGaps: round.approvedGaps,
				imageCandidateCount: isFinalRound
					? imageSearch.imageCandidates.length
					: 0,
				selectedImageCandidateIds: isFinalRound
					? selectedImageCandidateIds
					: [],
				imageLimitation: isFinalRound ? imageSearch.imageLimitation : null,
				evidenceAppendixSummary: isFinalRound ? evidenceAppendixSummary : null,
				evidencePacks: {
					version: round.evidencePackResult.version,
					count: round.evidencePackResult.evidencePacks.length,
					diagnostics: round.evidencePackDiagnostics,
				},
				coverageReview: {
					version: round.coverageReview.version,
					sufficient: round.coverageReview.sufficient,
					proposalCount: round.coverageReview.proposals.length,
					approvedGapCandidateCount:
						round.coverageReview.approvedGapCandidates.length,
					diagnostics: round.coverageReview.diagnostics,
					limitations: round.coverageReview.limitations,
				},
				claimBasis: isFinalRound
					? {
							status: claimBasisStatus,
							count: claimBasis.length,
							limitationCount: basisLimitations.length,
							diagnostics: basisDiagnostics,
							failureReason: claimBasisFailureReason,
							coverageBySection: claimBasisCoverageBySection,
						}
					: null,
				writer: isFinalRound
					? {
							evidenceCards: writerCheckpoint.evidenceCards,
							improvement: writerImprovement,
							reportShapeDiagnostics: finalReportShapeDiagnostics,
						}
					: null,
				gapFill: round.qualityDiagnostics.gapFill ?? null,
				parentSeedUsed: input.job.lifecycle.seed
					? {
							parentAtlasJobId: input.job.lifecycle.seed.parentAtlasJobId,
							compressedFindings: true,
							curatedSourcePool:
								input.job.lifecycle.seed.curatedSourcePool !== null,
						}
					: null,
			},
		});
	}

	if (hasCriticalAuditFinding(audit.honestyMarkers)) {
		throw new AtlasPipelineQualityError(audit.honestyMarkers);
	}

	await input.dependencies.heartbeat?.({
		stage: "render",
		progressPercent: 97,
	});
	const outputs = await input.dependencies.renderOutputs(documentSource);

	return {
		status: "succeeded",
		stage: "render",
		title: canonicalTitle,
		generatedTitle: assemblyMetadata.generatedTitle,
		outputs,
		audit: {
			honestyMarkers: audit.honestyMarkers,
		},
		usage,
		sourceCounts: {
			local: sources.localSources.length,
			web: finalResearchRound.webSources.length,
			accepted:
				sources.localSources.length + finalResearchRound.webSources.length,
			rejected: finalResearchRound.rejectedWebSources.length,
		},
	};
}
