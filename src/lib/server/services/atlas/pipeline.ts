import { getMaxModelContext } from "$lib/server/config-store";
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
import {
	appendAdditionalLimitations,
	buildHonestEvidenceFallbackReport,
	finalReportQualityFailures,
	finalizeAssembledReport,
	hasLimitationsHeading,
	looksLikeProcessOnlyReport,
	needsAssemblyRepair,
	normalizeAtlasReportTitleCasing,
	sanitizeMalformedWriterHeadings,
	stripAtlasPromptInstructionTail,
} from "./assembled-report";
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
import { canonicalSourceUrlKey } from "./source-url";
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
	AtlasWriterClaimBasisEntry,
} from "./types";
import {
	ATLAS_ASSEMBLY_SCHEMA_VERSION,
	ATLAS_CLAIM_SUPPORT_LEVELS,
} from "./types";
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
import { makeAtlasStageRunner } from "./stage-runner";

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
		searchImages?: (
			queries: string[],
			timeRange?: string | null,
		) => Promise<{
			imageCandidates: AtlasImageCandidate[];
			imageLimitation: { code: string; message: string } | null;
		}>;
		runModelStage: (input: {
			stage: ModelStage;
			prompt: string;
			system: string;
		}) => Promise<{
			text: string;
			finishReason?: string | null;
			usage: AtlasStageUsage;
		}>;
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
			writerClaimBasis?: AtlasWriterClaimBasisEntry[] | null;
			maxChars?: number;
		}) => Promise<{
			passed: boolean;
			honestyMarkers: AtlasHonestyMarker[];
			retryRequested: boolean;
			finishReason?: string | null;
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

export interface AtlasQualityFailureContext {
	profile: string;
	stage: string;
	sourceCounts?: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsdMicros: number;
	};
	assembledMarkdownSummary?: string;
	claimBasisStatus?: string;
	claimBasisFailureReason?: string | null;
	writerFinishReason?: string | null;
	auditFinishReason?: string | null;
}

export class AtlasPipelineQualityError extends Error {
	readonly code = "atlas_quality_gate_failed";
	readonly markers: AtlasHonestyMarker[];
	readonly failureContext: AtlasQualityFailureContext;

	constructor(
		markers: AtlasHonestyMarker[],
		failureContext: AtlasQualityFailureContext,
	) {
		const markerCodes = markers.map((marker) => marker.code).join(", ");
		super(`Atlas quality gate failed${markerCodes ? `: ${markerCodes}` : "."}`);
		this.name = "AtlasPipelineQualityError";
		this.markers = markers;
		this.failureContext = failureContext;
	}
}

/**
 * Critical marker codes that represent a structurally broken report (e.g. no
 * sources at all).  These warrant throwing away the entire job because the
 * output cannot be trusted regardless of what the writer produced.
 *
 * Model-generated critical markers (e.g. `multiplier_mismatch`,
 * `misleading_comparison`) are NOT included here — those flag specific
 * claim-level issues that the audit addendum already surfaces as limitations.
 * Throwing the whole job away for a single model-generated critical marker
 * wastes a full research run and leaves the user with no report at all.
 */
const STRUCTURAL_CRITICAL_MARKER_CODES = new Set(["atlas_no_sources"]);

function hasStructuralCriticalAuditFinding(
	markers: AtlasHonestyMarker[],
): boolean {
	return markers.some(
		(marker) =>
			marker.severity === "critical" &&
			STRUCTURAL_CRITICAL_MARKER_CODES.has(marker.code),
	);
}

/**
 * Downgrade non-structural critical audit markers to warnings so the pipeline
 * can proceed to render with the audit addendum already appended.  Structural
 * critical markers (e.g. `atlas_no_sources`) are preserved as-is and will
 * cause the pipeline to throw via {@link hasStructuralCriticalAuditFinding}.
 */
function downgradeNonStructuralCriticalMarkers(
	markers: AtlasHonestyMarker[],
): AtlasHonestyMarker[] {
	const downgraded: AtlasHonestyMarker[] = [];
	let hasNonStructuralCritical = false;
	for (const marker of markers) {
		if (
			marker.severity === "critical" &&
			!STRUCTURAL_CRITICAL_MARKER_CODES.has(marker.code)
		) {
			hasNonStructuralCritical = true;
			downgraded.push({ ...marker, severity: "warning" });
		} else {
			downgraded.push(marker);
		}
	}
	if (hasNonStructuralCritical) {
		console.warn(
			"[ATLAS] Downgraded non-structural critical audit markers to warnings — proceeding to render with audit addendum",
		);
	}
	return downgraded;
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
	const sourceUrlKey = canonicalSourceUrlKey(source.url);
	return (
		evidencePacks.find((pack) =>
			pack.sourceRefs.some((ref) => {
				if (ref.kind !== "web") return false;
				if (ref.id === source.id || ref.title === source.title) return true;
				return ref.url
					? canonicalSourceUrlKey(ref.url) === sourceUrlKey
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

/**
 * Single source of truth for every heartbeat progress percent Atlas emits.
 * Values are the exact literals/formulas each site emitted before the stage
 * runner refactor — see the per-site comments. Research-round stages depend on
 * `roundKind` + `roundNumber`, so they are expressed as functions.
 */
const ATLAS_PIPELINE_PROGRESS = {
	decompose: 10,
	research: {
		search: (roundKind: AtlasResearchRoundKind, roundNumber: number): number =>
			roundKind === "initial" ? 25 : Math.min(64, 50 + roundNumber * 4),
		imageSearch: 32,
		curate: (roundKind: AtlasResearchRoundKind, roundNumber: number): number =>
			roundKind === "initial" ? 40 : Math.min(72, 56 + roundNumber * 4),
		coverageReview: (
			roundKind: AtlasResearchRoundKind,
			roundNumber: number,
		): number =>
			roundKind === "initial" ? 50 : Math.min(78, 60 + roundNumber * 4),
	},
	synthesize: 55,
	integrate: 70,
	assemble: 82,
	assembleRepair: 86,
	assembleMinimalRepair: 88,
	assembleImprove: 88,
	audit: 92,
	reviseAfterAudit: 88,
	auditReview: 94,
	render: 97,
} as const;

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

function computeAtlasImageSearchTimeRange(
	query: string,
	currentYear: number,
): string | null {
	if (!isFreshnessSensitiveQuery(query, currentYear)) return null;
	const freshnessPatterns: Array<{ pattern: RegExp; range: string }> = [
		{
			pattern: /\b(today|now|breaking|price|availability|deadline|schedule)\b/i,
			range: "day",
		},
		{ pattern: /\bthis week\b/i, range: "week" },
		{ pattern: /\b(latest|recent|news|current|live)\b/i, range: "week" },
		{ pattern: /\bthis month\b/i, range: "month" },
		{ pattern: /\bthis year\b/i, range: "year" },
	];
	for (const { pattern, range } of freshnessPatterns) {
		if (pattern.test(query)) return range;
	}
	if (new RegExp(`\\b${currentYear}\\b`).test(query)) return "year";
	return "week";
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
	coverageReviewFinishReason?: string | null;
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
	const stageRunner = makeAtlasStageRunner({
		runModelStage: input.dependencies.runModelStage,
		heartbeat: input.dependencies.heartbeat,
		resolveStageSystem: (stage) =>
			stageSystem(
				stage,
				input.language,
				input.currentDate,
				input.profilePosture,
			),
	});

	await input.dependencies.heartbeat?.({
		stage: "search",
		progressPercent: ATLAS_PIPELINE_PROGRESS.research.search(
			input.roundKind,
			input.roundNumber,
		),
		progressDetails: { queries: input.searchQueries },
	});
	const search = await input.dependencies.searchWeb(input.searchQueries);

	let imageSearch: {
		imageCandidates: AtlasImageCandidate[];
		imageLimitation: { code: string; message: string } | null;
	} = { imageCandidates: [], imageLimitation: null };
	if (input.roundKind === "initial" && input.dependencies.searchImages) {
		const imageTimeRange = computeAtlasImageSearchTimeRange(
			input.job.query,
			input.now.getUTCFullYear(),
		);
		await input.dependencies.heartbeat?.({
			stage: "search",
			progressPercent: ATLAS_PIPELINE_PROGRESS.research.imageSearch,
			progressDetails: { queries: input.searchQueries },
		});
		try {
			imageSearch = await input.dependencies.searchImages(
				input.searchQueries,
				imageTimeRange,
			);
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

	const curate = await stageRunner.runStage("curate", {
		progress: ATLAS_PIPELINE_PROGRESS.research.curate(
			input.roundKind,
			input.roundNumber,
		),
		buildPrompt: () =>
			JSON.stringify({
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

	const coverageReviewModel = await stageRunner.runStage("coverage-review", {
		progress: ATLAS_PIPELINE_PROGRESS.research.coverageReview(
			input.roundKind,
			input.roundNumber,
		),
		buildPrompt: () =>
			buildAtlasCoverageReviewPrompt({
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
		coverageReviewFinishReason: coverageReviewModel.finishReason,
		usage: stageRunner.usage,
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
			canonicalSourceUrlKey(source.url),
		),
	);
	const seenMaterialKeys = new Set(
		input.existingWebSources
			.map((source) => webSourceMaterialKey(source))
			.filter((key): key is string => Boolean(key)),
	);
	let materiallyNewExcerptCount = 0;

	for (const source of input.candidates) {
		const urlKey = canonicalSourceUrlKey(source.url);
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
	const writerClaimBasis = parseWriterClaimBasis(parsed.claimBasis);
	return {
		markdown: markdown ?? text,
		metadata: {
			version: ATLAS_ASSEMBLY_SCHEMA_VERSION,
			generatedTitle: normalizeGeneratedTitle(parsed.generatedTitle),
			sectionBriefs: parseSectionBriefs(parsed.sectionBriefs),
			limitations: stringArray(parsed.limitations),
			structured: true,
			writerClaimBasis,
		},
	};
}

function parseWriterClaimBasis(
	value: unknown,
): AtlasWriterClaimBasisEntry[] | null {
	if (!Array.isArray(value)) return null;
	const entries: AtlasWriterClaimBasisEntry[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const claimText = normalizeAssemblyText(record.claimText);
		if (!claimText) continue;
		const supportLevel = record.supportLevel;
		if (
			typeof supportLevel !== "string" ||
			!ATLAS_CLAIM_SUPPORT_LEVELS.includes(supportLevel as never)
		) {
			continue;
		}
		entries.push({
			claimText,
			sectionTitle:
				normalizeAssemblyText(record.sectionTitle) ??
				normalizeAssemblyText(record.title) ??
				"Atlas report",
			supportLevel: supportLevel as AtlasWriterClaimBasisEntry["supportLevel"],
			evidenceCardIds: stringArray(
				record.evidenceCardIds ?? record.cardIds ?? record.evidenceCards,
			),
			rationale:
				normalizeAssemblyText(record.rationale) ??
				normalizeAssemblyText(record.reasoning) ??
				"Writer provided no rationale.",
		});
	}
	return entries.length > 0 ? entries : null;
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
		writerClaimBasis: next.writerClaimBasis ?? previous.writerClaimBasis,
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

interface AtlasFinalReportQualityGate {
	passed: boolean;
	fallbackApplied: boolean;
	reasonWarningCodes: string[];
	reasonMessages: string[];
	before: AtlasReportShapeDiagnostics;
	after?: AtlasReportShapeDiagnostics;
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
	const stageRunner = makeAtlasStageRunner({
		runModelStage: input.dependencies.runModelStage,
		heartbeat: input.dependencies.heartbeat,
		resolveStageSystem: (stage) =>
			stageSystem(stage, language, currentDate, profilePosture),
	});

	const decompose = await stageRunner.runStage("decompose", {
		progress: ATLAS_PIPELINE_PROGRESS.decompose,
		buildPrompt: () =>
			seededPrompt({
				query: input.job.query,
				lifecycle: input.job.lifecycle,
				language,
				currentDate,
			}),
	});
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
	stageRunner.foldUsage(initialRound.usage);
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
		stageRunner.foldUsage(gapRound.usage);
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
	const coverageReviewFinishReason =
		finalResearchRound.coverageReviewFinishReason;
	const searchLimitation = combineResearchRoundLimitations(researchRounds);

	const synthesize = await stageRunner.runStage("synthesize", {
		progress: ATLAS_PIPELINE_PROGRESS.synthesize,
		buildPrompt: () =>
			JSON.stringify({
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

	const integrate = await stageRunner.runStage("integrate", {
		progress: ATLAS_PIPELINE_PROGRESS.integrate,
		buildPrompt: () =>
			JSON.stringify({
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

	const assemble = await stageRunner.runStage("assemble", {
		progress: ATLAS_PIPELINE_PROGRESS.assemble,
		buildPrompt: () => writerPrompt,
	});
	const writerFinishReason = assemble.finishReason;
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
		const repair = await stageRunner.runStage("assemble", {
			progress: ATLAS_PIPELINE_PROGRESS.assembleRepair,
			buildPrompt: () =>
				buildAssembleRepairPrompt({
					basePrompt: writerPrompt,
					previousDraft: finalAssembledMarkdown,
					language,
				}),
		});
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
			assemblyDiagnostics.firstRepairOutputPrefix = repair.text.slice(0, 500);
			assemblyDiagnostics.firstRepairParsedAsJson =
				assemblyOutput.metadata.structured;
			assemblyDiagnostics.firstRepairRepairReason = firstRepairRepairReason;

			const minimalRepair = await stageRunner.runStage("assemble", {
				progress: ATLAS_PIPELINE_PROGRESS.assembleMinimalRepair,
				buildPrompt: () =>
					buildMinimalAssembleRepairPrompt({
						basePrompt: writerPrompt,
						query: input.job.query,
						language,
					}),
			});
			const minimalOutput = parseAtlasAssemblyOutput(minimalRepair.text);
			assemblyMetadata = mergeAssemblyMetadata(
				assemblyMetadata,
				minimalOutput.metadata,
			);
			finalAssembledMarkdown = minimalOutput.markdown;

			outputTokensByTier.secondRepair = minimalRepair.usage.outputTokens;
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
				assemblyDiagnostics.secondRepairOutputPrefix = minimalRepair.text.slice(
					0,
					500,
				);
				assemblyDiagnostics.secondRepairParsedAsJson =
					minimalOutput.metadata.structured;
				assemblyDiagnostics.secondRepairRepairReason = secondRepairRepairReason;
				assemblyDiagnostics.finalFailureCheck = "needsAssemblyRepair";
				assemblyDiagnostics.finalFailureSubCondition = secondRepairRepairReason;

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
		finalAssembledMarkdown = finalizeAssembledReport({
			markdown: finalAssembledMarkdown,
			language,
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
	} else if (
		shouldImproveAtlasWriterDraft(firstDraftReportShapeDiagnostics, {
			evidenceCardCount: writerEvidenceCardResult.writerEvidenceCards.length,
		})
	) {
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
		const improve = await stageRunner.runStage("assemble", {
			progress: ATLAS_PIPELINE_PROGRESS.assembleImprove,
			buildPrompt: () =>
				buildAtlasWriterImprovementPrompt({
					...writerPromptInput,
					currentDraft: finalAssembledMarkdown,
					reportShapeDiagnostics: firstDraftReportShapeDiagnostics,
				}),
		});
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
			finalAssembledMarkdown = finalizeAssembledReport({
				markdown: finalAssembledMarkdown,
				language,
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
		progressPercent: ATLAS_PIPELINE_PROGRESS.audit,
	});
	const claimBasisReportMaxChars = Math.min(
		12000,
		Math.floor(getMaxModelContext() * 0.15),
	);
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
		writerClaimBasis: assemblyMetadata.writerClaimBasis,
		maxChars: claimBasisReportMaxChars,
	});
	stageRunner.foldUsage(audit.usage);
	let auditFinishReason = audit.finishReason;
	if (audit.retryRequested) {
		const revise = await stageRunner.runStage("assemble", {
			progress: ATLAS_PIPELINE_PROGRESS.reviseAfterAudit,
			system:
				language === "hu"
					? "Dolgozd át az Atlas jelentést az audit megállapításai alapján. Tartsd meg az alátámasztott állításokat, vedd ki a nem alátámasztott bizonyosságot, és adj hozzá kifejezett korlátokat, ahol gyenge a bizonyíték. A jelentés magyar legyen."
					: "Revise the Atlas report to address audit findings. Preserve supported claims, remove unsupported certainty, and add explicit limitations where evidence is weak.",
			buildPrompt: () =>
				JSON.stringify({
					detectedLanguage: language,
					assembledMarkdown: finalAssembledMarkdown,
					auditFindings: audit,
					evidencePacksVersion: evidencePackResult.version,
					evidencePacks: evidencePackResult.evidencePacks,
					evidencePackDiagnostics,
					coverageReview,
				}),
		});
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
			progressPercent: ATLAS_PIPELINE_PROGRESS.auditReview,
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
			writerClaimBasis: assemblyMetadata.writerClaimBasis,
			maxChars: claimBasisReportMaxChars,
		});
		stageRunner.foldUsage(audit.usage);
		auditFinishReason = audit.finishReason;
	}
	const auditFailedOrRetry = !audit.passed || audit.retryRequested;
	const auditAddendum =
		"Some claims in this report could not be fully verified against the accepted evidence. Review the Basis Markers and Limitations above before relying on specific figures or recommendations.";
	let auditedMarkdown = finalAssembledMarkdown;
	if (auditFailedOrRetry) {
		if (hasLimitationsHeading(finalAssembledMarkdown)) {
			auditedMarkdown = [finalAssembledMarkdown.trim(), "", auditAddendum].join(
				"\n",
			);
		} else {
			auditedMarkdown = [
				finalAssembledMarkdown,
				"",
				"## Limitations",
				auditAddendum,
			].join("\n");
		}
	}
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
			writerClaimBasis: assemblyMetadata.writerClaimBasis,
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
	if (assemblyDiagnostics) {
		assemblyDiagnostics = {
			...assemblyDiagnostics,
			writerFinishReason: writerFinishReason ?? null,
			auditFinishReason: auditFinishReason ?? null,
			coverageReviewFinishReason: coverageReviewFinishReason ?? null,
		};
	}
	if (writerFinishReason === "length") {
		console.warn(
			"[ATLAS] Writer (assemble) stage hit max output tokens (finishReason=length). Report may be truncated.",
		);
	}
	if (auditFinishReason === "length") {
		console.warn(
			"[ATLAS] Audit stage hit max output tokens (finishReason=length). Claim basis may be incomplete.",
		);
	}
	if (coverageReviewFinishReason === "length") {
		console.warn(
			"[ATLAS] Coverage review stage hit max output tokens (finishReason=length). Gap proposals may be truncated.",
		);
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
			usage: isFinalRound ? stageRunner.usage : round.usage,
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

	if (hasStructuralCriticalAuditFinding(audit.honestyMarkers)) {
		throw new AtlasPipelineQualityError(audit.honestyMarkers, {
			profile: input.job.profile,
			stage: "audit",
			sourceCounts: {
				local: sources.localSources.length,
				web: finalResearchRound.webSources.length,
				accepted:
					sources.localSources.length + finalResearchRound.webSources.length,
				rejected: finalResearchRound.rejectedWebSources.filter(
					(source) => source.rejectionReason !== "source_cap",
				).length,
			},
			usage: {
				inputTokens: stageRunner.usage.inputTokens,
				outputTokens: stageRunner.usage.outputTokens,
				totalTokens: stageRunner.usage.totalTokens,
				costUsdMicros: stageRunner.usage.costUsdMicros,
			},
			assembledMarkdownSummary: auditedMarkdown.slice(0, 1000),
			claimBasisStatus,
			claimBasisFailureReason,
			writerFinishReason: writerFinishReason ?? null,
			auditFinishReason: auditFinishReason ?? null,
		});
	}
	audit = {
		...audit,
		honestyMarkers: downgradeNonStructuralCriticalMarkers(audit.honestyMarkers),
	};

	await input.dependencies.heartbeat?.({
		stage: "render",
		progressPercent: ATLAS_PIPELINE_PROGRESS.render,
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
		usage: stageRunner.usage,
		sourceCounts: {
			local: sources.localSources.length,
			web: finalResearchRound.webSources.length,
			accepted:
				sources.localSources.length + finalResearchRound.webSources.length,
			rejected: finalResearchRound.rejectedWebSources.filter(
				(source) => source.rejectionReason !== "source_cap",
			).length,
		},
	};
}
