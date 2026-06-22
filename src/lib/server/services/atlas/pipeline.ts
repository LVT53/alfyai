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
	AtlasAssemblyDiagnostics,
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
			"Write the final Atlas published report from compact Writer Evidence Cards. Return ONLY a JSON object. Do not write prose before or after the JSON. Do not describe the research process. The bodyMarkdown field must contain the full report, not a summary of what you did. Produce decision-quality synthesis, not a source dump or process report.",
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
			"Írd meg a végleges, publikált Atlas jelentést kompakt Writer Evidence Cardokból. Csak JSON objektumot adj vissza. Ne írj prózát a JSON előtt vagy után. Ne írd le a kutatási folyamatot. A bodyMarkdown mezőnek a teljes jelentést kell tartalmaznia, ne a folyamat összefoglalóját. Döntésminőségű szintézist adj, ne forrásdumpot vagy folyamatjelentést.",
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

const PROMPT_INSTRUCTION_HEADING_PATTERN =
	/\b(?:answer|cite|compare|cover|explain|include|provide|return|use\s+current\s+web\s+evidence|with\s+current\s+web\s+evidence|write)\b/i;

function stripAtlasPromptInstructionTail(value: string): string {
	return value
		.replace(
			/\s*[.!?]\s*(?:answer|cite|compare|cover|explain|include|provide|return|use\s+current\s+web\s+evidence|with\s+current\s+web\s+evidence|write)\b[\s\S]*$/i,
			"",
		)
		.replace(
			/\s+(?:cite\s+sources?|include\s+(?:citations?|sources?|references?)|use\s+current\s+web\s+evidence|with\s+current\s+web\s+evidence)\b[\s\S]*$/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeAtlasReportTitleCasing(title: string): string {
	return title.replace(/^\p{Ll}/u, (letter) =>
		letter.toLocaleUpperCase("en-US"),
	);
}

function normalizeGeneratedTitle(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const raw = stripAtlasPromptInstructionTail(value.trim());
	if (/[\r\n]/.test(raw)) return null;
	const normalized = normalizeAssemblyText(raw)
		?.replace(/^#{1,6}\s+/, "")
		.replace(/^["']|["']$/g, "")
		.trim();
	if (!normalized) return null;
	if (normalized.length < 4 || normalized.length > 160) return null;
	if (/^(untitled|title|report|atlas report)$/i.test(normalized)) return null;
	if (/[\r\n]/.test(normalized)) return null;
	return normalizeAtlasReportTitleCasing(normalized);
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

export function looksLikeProcessOnlyReport(markdown: string): boolean {
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
	return /^\d+(?:\.\d+)?\s*[bmk]?\s+(?:dimensions?|gb|mb|ms|parameters?|params?|tokens?)$/i.test(normalized);
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

export function looksLikeMalformedAssembledReport(input: {
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
		scalarHeadingCount >= 2 ||
		envelopeHeadingCount >= 2 ||
		sourceHeadingCount >= 3 ||
		envelopeHeadingCount + envelopeScalarCount >= 3
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

function isLikelyPromptInstructionHeading(title: string): boolean {
	const trimmed = title.trim();
	const normalized = normalizedReportShapeText(trimmed);
	if (!normalized || SAFE_REPORT_HEADING_LABELS.has(normalized)) return false;
	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length < 5) return false;
	if (/[.!?]\s+\S/.test(trimmed)) return true;
	return PROMPT_INSTRUCTION_HEADING_PATTERN.test(trimmed);
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
	if (isLikelyPromptInstructionHeading(trimmed)) return true;
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

export function needsAssemblyRepair(input: {
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

function buildMinimalAssembleRepairPrompt(input: {
	basePrompt: string;
	query: string;
	language: SupportedLanguage;
}): string {
	const parsed = JSON.parse(input.basePrompt);
	const evidenceCardSummaries = Array.isArray(parsed.writerEvidenceCards)
		? parsed.writerEvidenceCards.map(
				(card: Record<string, unknown>) =>
					`${typeof card.sourceTitle === "string" ? card.sourceTitle : "source"}: ${
						Array.isArray(card.relevantFacts)
							? (card.relevantFacts as string[]).slice(0, 2).join(" ")
							: ""
					}`,
			)
		: [];
	const instruction =
		input.language === "hu"
			? "Return ONLY JSON with generatedTitle, bodyMarkdown, sectionBriefs, and limitations. bodyMarkdown must be the full report in Markdown. Do not include anything outside the JSON object."
			: "Return ONLY JSON with generatedTitle, bodyMarkdown, sectionBriefs, and limitations. bodyMarkdown must be the full report in Markdown. Do not include anything outside the JSON object.";

	return JSON.stringify({
		minimalRepair: true,
		detectedLanguage: parsed.detectedLanguage ?? input.language,
		currentDate: parsed.currentDate ?? "",
		query: input.query,
		instruction,
		outputContract: {
			strictJson: true,
			requiredFields: [
				"generatedTitle",
				"bodyMarkdown",
				"sectionBriefs",
				"limitations",
			],
		},
		evidenceCardSummaries,
		sourceProjectionRule:
			"Do not write Markdown Sources, bibliographies, references, works-cited sections, citation appendices, or source lists; the backend owns source projection.",
	});
}

function honestFallbackSectionLabels(language: SupportedLanguage): {
	executive: string;
	evidenceSummary: string;
	limitations: string;
	additionalLimitations: string;
} {
	if (language === "hu") {
		return {
			executive: "Vezetői összefoglaló",
			evidenceSummary: "Bizonyíték összefoglaló",
			limitations: "Korlátok",
			additionalLimitations: "További korlátok",
		};
	}
	return {
		executive: "Executive Summary",
		evidenceSummary: "Evidence Summary",
		limitations: "Limitations",
		additionalLimitations: "Additional Limitations",
	};
}

function honestFallbackEvidenceEntries(
	evidencePacks: AtlasEvidencePack[],
): Array<{ pack: AtlasEvidencePack; summary: string }> {
	return evidencePacks
		.map((pack) => ({
			pack,
			summary: cleanFallbackScalar(pack.evidence.summary),
		}))
		.filter((entry): entry is { pack: AtlasEvidencePack; summary: string } =>
			Boolean(entry.summary),
		)
		.filter(
			(entry) =>
				!isProcessFallbackStatement(entry.summary) &&
				!isLowQualityFallbackText(entry.summary),
		)
		.map((entry) => ({
			...entry,
			summary: ensureTerminalPunctuation(entry.summary),
		}))
		.slice(0, 16);
}

function honestFallbackEvidenceLabel(pack: AtlasEvidencePack): string | null {
	const source = pack.sourceRefs[0];
	if (!source) return null;
	const authority =
		pack.authority === "accepted_web"
			? "web"
			: pack.authority.replace(/_/g, " ");
	return [source.title, authority].filter(Boolean).join(", ");
}

function buildHonestFallbackSectionBriefs(input: {
	language: SupportedLanguage;
	evidencePacks: AtlasEvidencePack[];
}): AtlasSectionBrief[] {
	const packs = input.evidencePacks
		.filter((pack) => pack.sourceRefs.length > 0)
		.slice(0, 8);
	const evidencePackIds = packs.map((pack) => pack.id);
	const sourceAssociations = sourceAssociationsFromEvidencePacks(packs);
	const labels = honestFallbackSectionLabels(input.language);
	return [
		{
			sectionTitle: labels.executive,
			brief:
				input.language === "hu"
					? "Az Atlas elfogadott bizonyítékokat gyűjtött, de nem tudott döntési minőségű szintézist készíteni."
					: "Atlas gathered accepted evidence but could not synthesize it into a decision-quality report.",
			evidencePackIds,
			sourceAssociations,
			limitations: [],
		},
		{
			sectionTitle: labels.evidenceSummary,
			brief:
				input.language === "hu"
					? "A szakasz az elfogadott Evidence Pack összefoglalókat változatlan elemzés nélkül listázza."
					: "This section lists accepted Evidence Pack summaries without generated analysis.",
			evidencePackIds,
			sourceAssociations,
			limitations: [],
		},
		{
			sectionTitle: labels.limitations,
			brief:
				input.language === "hu"
					? "A fallback kimenet nyers, rangsorolatlan bizonyíték-összefoglaló, nem publikálható ajánlás."
					: "The fallback output is a raw, unranked evidence summary rather than a publishable recommendation.",
			evidencePackIds,
			sourceAssociations,
			limitations: [
				input.language === "hu"
					? "Nem készült ajánlás, kompromisszum-elemzés vagy bevezetési útmutatás."
					: "No recommendation, tradeoff analysis, or deployment guidance was generated.",
			],
		},
	];
}

function buildHonestFallbackGeneratedTitle(input: {
	language: SupportedLanguage;
	query: string;
}): string {
	const queryTitle = normalizeFallbackTitle(input.query);
	if (queryTitle) return queryTitle;
	return input.language === "hu"
		? "Forrásalapú Atlas jelentés"
		: "Source-Grounded Atlas Report";
}

function buildHonestFallbackLimitations(input: {
	language: SupportedLanguage;
	searchLimitation: { code: string; message: string } | null;
}): string[] {
	const limitations =
		input.language === "hu"
			? [
					"Az Atlas nem tudott döntési minőségű szintézist készíteni az elfogadott bizonyítékokból. A modell kimenete nem volt használható publikált jelentésként.",
					"A fenti bizonyíték nyers és rangsorolatlan. Nem készült ajánlás, kompromisszum-elemzés vagy bevezetési útmutatás.",
					"Használd a Continue vagy Revise műveletet, ha új szintézis-kísérletet szeretnél ugyanebből a bizonyítékalapból.",
				]
			: [
					"Atlas could not produce a decision-quality synthesis from the accepted evidence. The model output was not usable as a published report.",
					"The evidence above is raw and unranked. No recommendation, tradeoff analysis, or deployment guidance was generated.",
					"Use Continue or Revise to attempt a fresh synthesis with the same evidence base.",
				];
	if (input.searchLimitation) {
		limitations.push(ensureTerminalPunctuation(input.searchLimitation.message));
	}
	return limitations;
}

function buildHonestEvidenceFallbackReport(input: {
	language: SupportedLanguage;
	query: string;
	evidencePacks: AtlasEvidencePack[];
	searchLimitation: { code: string; message: string } | null;
	currentDate: string;
}): { markdown: string; metadata: AtlasAssemblyMetadata } {
	const labels = honestFallbackSectionLabels(input.language);
	const title = buildHonestFallbackGeneratedTitle({
		language: input.language,
		query: input.query,
	});
	const acceptedSourceCount = input.evidencePacks.length;
	const executive =
		input.language === "hu"
			? `Az Atlas ${acceptedSourceCount} elfogadott bizonyítékcsomagot gyűjtött ehhez a kérdéshez, de nem tudta döntési minőségű jelentéssé szintetizálni őket. Az alábbi bizonyíték-összefoglalók áttekinthetők; Continue vagy Revise művelettel új szintézis-kísérlet indítható.`
			: `Atlas gathered ${acceptedSourceCount} accepted evidence pack${acceptedSourceCount === 1 ? "" : "s"} for this query but could not synthesize ${acceptedSourceCount === 1 ? "it" : "them"} into a decision-quality report. The evidence summaries below are available for review. You can retry with Continue or Revise for a fresh synthesis attempt.`;
	const evidenceEntries = honestFallbackEvidenceEntries(input.evidencePacks);
	const evidenceBullets = evidenceEntries.map((entry) => {
		const label = honestFallbackEvidenceLabel(entry.pack);
		return label ? `- **${label}:** ${entry.summary}` : `- ${entry.summary}`;
	});
	const noEvidence =
		input.language === "hu"
			? "- Nem állt rendelkezésre használható Evidence Pack összefoglaló."
			: "- No usable evidence pack summaries were available.";
	const limitations = buildHonestFallbackLimitations({
		language: input.language,
		searchLimitation: input.searchLimitation,
	});
	const markdown = [
		`# ${title}`,
		"",
		`## ${labels.executive}`,
		executive,
		"",
		`## ${labels.evidenceSummary}`,
		...(evidenceBullets.length > 0 ? evidenceBullets : [noEvidence]),
		"",
		`## ${labels.limitations}`,
		...limitations.map((limitation) => `- ${limitation}`),
	].join("\n");
	return {
		markdown,
		metadata: {
			version: ATLAS_ASSEMBLY_SCHEMA_VERSION,
			generatedTitle: title,
			sectionBriefs: buildHonestFallbackSectionBriefs({
				language: input.language,
				evidencePacks: input.evidencePacks,
			}),
			limitations,
			structured: true,
		},
	};
}

function appendAdditionalLimitations(input: {
	markdown: string;
	language: SupportedLanguage;
	failures: { reasonMessages: string[] };
}): string {
	const labels = honestFallbackSectionLabels(input.language);
	const intro =
		input.language === "hu"
			? "Az Atlas jelentésalak-diagnosztikája szerint ez a jelentés túl vékony, túl forrásdominált vagy egyes szakaszaiban túl sekély lehet. A fenti szintézis a modell legjobb kísérlete az elfogadott bizonyítékok alapján. Tekintsd át a bizonyítékokat, és használd a Continue vagy Revise műveletet, ha mélyebb elemzés szükséges."
			: "Atlas report-shape diagnostics indicate that this report may be too thin, too source-dominated, or too shallow in some sections. The synthesis above represents the model's best effort given the accepted evidence. Review the evidence and retry with Continue or Revise if deeper analysis is needed.";
	const details = input.failures.reasonMessages.map(
		(message) => `- ${ensureTerminalPunctuation(message)}`,
	);
	return [
		input.markdown.trim(),
		"",
		`## ${labels.additionalLimitations}`,
		intro,
		...(details.length > 0 ? ["", ...details] : []),
	].join("\n");
}

export function ensureLimitationsSection(
	markdown: string,
	language: SupportedLanguage,
): string {
	const headings = markdownHeadingTitles(markdown);
	if (headings.length < 4) return markdown;
	if (hasLimitationsHeading(markdown)) return markdown;
	const labels = honestFallbackSectionLabels(language);
	const limitationNote =
		language === "hu"
			? "A jelentés megállapításai és ajánlásai az elfogadott bizonyítékforrásokon alapulnak. További kontextus, domain-specifikus tényezők vagy frissebb adatok befolyásolhatják a következtetéseket."
			: "The findings and recommendations in this report are based on the accepted evidence sources. Additional context, domain-specific factors, or more recent data may affect the conclusions.";
	return [markdown.trim(), "", `## ${labels.limitations}`, limitationNote].join(
		"\n",
	);
}

function cleanFallbackScalar(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed || null;
}

function isEvidencePackIdFragment(value: string): boolean {
	return /(?:^|[^a-z0-9])atlas-pack-v\d[-_a-z0-9]*/i.test(value);
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
	if (
		/\b(search result snippet|fetched page excerpt|evidence packs used|loading chart|copied to clipboard|source ids?|rating|ertekeles|eur|cookie|10 min read|read time|newsletter|subscribe|sign up|ailog team|back to all lists|recommendations for your rag applications)\b/i.test(
			normalized,
		)
	) {
		return true;
	}
	if (
		/\bmteb benchmarks\b/i.test(normalized) &&
		/\bmultilingual performance\b/i.test(normalized)
	) {
		return true;
	}
	if (
		/\bcomprehensive comparison\b/i.test(normalized) &&
		/\b(?:mteb benchmarks|recommendations for your rag|news embedding models|benchmark and comparison)\b/i.test(
			normalized,
		)
	) {
		return true;
	}
	if (
		/\b(?:best|top)\s+(?:self hosted\s+)?embedding models?\s+(?:in\s+)?20\d{2}\b/i.test(
			normalized,
		) &&
		normalized.split(/\s+/).length < 18
	) {
		return true;
	}
	return false;
}

function normalizeFallbackTitle(
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	const normalized = stripAtlasPromptInstructionTail(
		value
			.replace(
				/^\s*live\s+atlas\s+regression\s+check\s+\d{4}-\d{2}-\d{2}t[0-9:.]+z\.?\s*/i,
				"",
			)
			.replace(/\b\d{4}-\d{2}-\d{2}t[0-9:.]+z\b/gi, "")
			.replace(
				/^(?:compare|find|choose|select|rank|recommend)\s+(?:the\s+)?(?:best\s+)?/i,
				"",
			)
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
			.trim(),
	);
	if (!normalized || /^atlas report$/i.test(normalized)) return null;
	const clipped =
		normalized.length <= 120
			? normalized
			: normalized
					.slice(0, 121)
					.replace(/\s+\S*$/, "")
					.trim();
	return clipped.length >= 4 ? normalizeAtlasReportTitleCasing(clipped) : null;
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

function ensureTerminalPunctuation(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const FINAL_REPORT_GATE_WARNING_CODES = new Set([
	"atlas_report_sections_too_sparse",
	"atlas_too_many_one_sentence_sections",
	"atlas_source_projection_dominates_report",
	"atlas_claim_shaped_headings",
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
	let currentDraftIsHonestFallback = false;
	let firstDraftReportShapeDiagnostics: AtlasReportShapeDiagnostics | null =
		null;
	let writerImprovement = {
		ran: false,
		passCount: 0,
		reasonWarningCodes: [] as string[],
		startedAfterDeterministicFallback: false,
		skippedReason: null as string | null,
	};
	const acceptedSourceTitles = [
		...sources.localSources.map((source) => source.title),
		...finalResearchRound.webSources.map((source) => source.title),
	];
	const outputTokensByTier: Record<string, number> = {};
	let assemblyDiagnostics: AtlasAssemblyDiagnostics | null = null;
	if (
		needsAssemblyRepair({
			markdown: finalAssembledMarkdown,
			acceptedSourceTitles,
		})
	) {
		const firstPassRepairReason = looksLikeProcessOnlyReport(
			finalAssembledMarkdown,
		)
			? "process_only"
			: "malformed";
		const firstPassOutputPrefix = assemble.text.slice(0, 500);
		outputTokensByTier.firstPass = assemble.usage.outputTokens;
		assemblyDiagnostics = {
			firstPassOutputPrefix,
			firstPassParsedAsJson: assemblyOutput.metadata.structured,
			firstPassRepairReason,
			outputTokensByTier: { ...outputTokensByTier },
			writerPromptTruncated: false,
			writerPromptCharCount: writerPrompt.length,
		};
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

		outputTokensByTier.firstRepair = repair.usage.outputTokens;
		assemblyDiagnostics.outputTokensByTier = {
			...outputTokensByTier,
		};

		if (
			needsAssemblyRepair({
				markdown: finalAssembledMarkdown,
				acceptedSourceTitles,
			})
		) {
			const firstRepairRepairReason = looksLikeProcessOnlyReport(
				finalAssembledMarkdown,
			)
				? "process_only"
				: "malformed";
			assemblyDiagnostics.firstRepairOutputPrefix =
				repair.text.slice(0, 500);
			assemblyDiagnostics.firstRepairParsedAsJson =
				assemblyOutput.metadata.structured;
			assemblyDiagnostics.firstRepairRepairReason =
				firstRepairRepairReason;

			await input.dependencies.heartbeat?.({
				stage: "assemble",
				progressPercent: 88,
			});
			const minimalRepair = await input.dependencies.runModelStage({
				stage: "assemble",
				system: stageSystem(
					"assemble",
					language,
					currentDate,
					profilePosture,
				),
				prompt: buildMinimalAssembleRepairPrompt({
					basePrompt: writerPrompt,
					query: input.job.query,
					language,
				}),
			});
			usage = addUsage(usage, minimalRepair.usage);
			const minimalOutput = parseAtlasAssemblyOutput(minimalRepair.text);
			assemblyMetadata = mergeAssemblyMetadata(
				assemblyMetadata,
				minimalOutput.metadata,
			);
			finalAssembledMarkdown = minimalOutput.markdown;

			outputTokensByTier.secondRepair =
				minimalRepair.usage.outputTokens;
			assemblyDiagnostics.outputTokensByTier = {
				...outputTokensByTier,
			};

			if (
				needsAssemblyRepair({
					markdown: finalAssembledMarkdown,
					acceptedSourceTitles,
				})
			) {
				const secondRepairRepairReason = looksLikeProcessOnlyReport(
					finalAssembledMarkdown,
				)
					? "process_only"
					: "malformed";
				assemblyDiagnostics.secondRepairOutputPrefix =
					minimalRepair.text.slice(0, 500);
				assemblyDiagnostics.secondRepairParsedAsJson =
					minimalOutput.metadata.structured;
				assemblyDiagnostics.secondRepairRepairReason =
					secondRepairRepairReason;
				assemblyDiagnostics.finalFailureCheck =
					"needsAssemblyRepair";
				assemblyDiagnostics.finalFailureSubCondition =
					secondRepairRepairReason;

				const fallbackReport = buildHonestEvidenceFallbackReport({
					language,
					query: input.job.query,
					evidencePacks: evidencePackResult.evidencePacks,
					searchLimitation,
					currentDate,
				});
				finalAssembledMarkdown = fallbackReport.markdown;
				assemblyMetadata = mergeAssemblyMetadata(
					assemblyMetadata,
					fallbackReport.metadata,
				);
				usedDeterministicFallbackBeforeImprovement = true;
				currentDraftIsHonestFallback = true;
			}
		}
	}

	if (!currentDraftIsHonestFallback) {
		finalAssembledMarkdown = ensureLimitationsSection(
			finalAssembledMarkdown,
			language,
		);
		finalAssembledMarkdown = sanitizeMalformedWriterHeadings({
			markdown: finalAssembledMarkdown,
			acceptedSourceTitles,
		});
	}
	firstDraftReportShapeDiagnostics = diagnoseAtlasReportShape(
		finalAssembledMarkdown,
		{
			acceptedSourceCount: acceptedSourceTitles.length,
			query: input.job.query,
			writerEvidenceCardCount:
				writerEvidenceCardResult.writerEvidenceCards.length,
		},
	);
	if (currentDraftIsHonestFallback) {
		writerImprovement = {
			ran: false,
			passCount: 0,
			reasonWarningCodes: firstDraftReportShapeDiagnostics.warnings.map(
				(warning) => warning.code,
			),
			startedAfterDeterministicFallback: true,
			skippedReason: "honest_fallback_does_not_need_improvement",
		};
	} else if (shouldImproveAtlasWriterDraft(firstDraftReportShapeDiagnostics)) {
		writerImprovement = {
			ran: true,
			passCount: 1,
			reasonWarningCodes: firstDraftReportShapeDiagnostics.warnings.map(
				(warning) => warning.code,
			),
			startedAfterDeterministicFallback:
				usedDeterministicFallbackBeforeImprovement,
			skippedReason: null,
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
		currentDraftIsHonestFallback = false;
		if (
			needsAssemblyRepair({
				markdown: finalAssembledMarkdown,
				acceptedSourceTitles,
			})
		) {
			const fallbackReport = buildHonestEvidenceFallbackReport({
				language,
				query: input.job.query,
				evidencePacks: evidencePackResult.evidencePacks,
				searchLimitation,
				currentDate,
			});
			finalAssembledMarkdown = fallbackReport.markdown;
			assemblyMetadata = mergeAssemblyMetadata(
				assemblyMetadata,
				fallbackReport.metadata,
			);
			currentDraftIsHonestFallback = true;
		}
		if (!currentDraftIsHonestFallback) {
			finalAssembledMarkdown = ensureLimitationsSection(
				finalAssembledMarkdown,
				language,
			);
			finalAssembledMarkdown = sanitizeMalformedWriterHeadings({
				markdown: finalAssembledMarkdown,
				acceptedSourceTitles,
			});
		}
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
	const claimBasis = audit.claimBasis ?? [];
	const basisLimitations = audit.basisLimitations ?? [];
	const basisDiagnostics = audit.basisDiagnostics ?? [];
	const claimBasisCoverageBySection = audit.claimBasisCoverageBySection ?? [];
	const claimBasisStatus =
		audit.claimBasisStatus ?? (claimBasis.length > 0 ? "succeeded" : "failed");
	const claimBasisFailureReason = audit.claimBasisFailureReason ?? null;
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
		auditedMarkdown = appendAdditionalLimitations({
			markdown: auditedMarkdown,
			language,
			failures: finalQualityFailures,
		});
		documentSource = buildCurrentDocumentSource();
		finalReportShapeDiagnostics = diagnoseAtlasReportShape(documentSource);
		finalReportQualityGate = {
			passed: false,
			fallbackApplied: false,
			reasonWarningCodes: finalQualityFailures.reasonWarningCodes,
			reasonMessages: finalQualityFailures.reasonMessages,
			before: finalReportQualityGate.before,
			after: finalReportShapeDiagnostics,
		};
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
	if (assemblyDiagnostics && basisDiagnostics.length > 0) {
		assemblyDiagnostics = {
			...assemblyDiagnostics,
			claimBasisDiagnostics: basisDiagnostics,
		};
	}
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
		assemblyDiagnostics,
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
