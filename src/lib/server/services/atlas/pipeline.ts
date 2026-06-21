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
	buildAtlasDocumentSource,
	collectAtlasSelectedImageCandidateIds,
} from "./renderer-output";
import type {
	AtlasAssemblyMetadata,
	AtlasClaimBasis,
	AtlasClaimBasisDiagnostic,
	AtlasClaimBasisLimitation,
	AtlasClaimBasisSectionCoverage,
	AtlasCoverageReview,
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
			"Assemble final Atlas report Markdown with actual findings. Do not write a process report about sources checked or steps performed.",
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
			"Állítsd össze a végleges Atlas jelentést Markdown formában, valódi megállapításokkal. Ne folyamatjelentést írj a vizsgált forrásokról vagy elvégzett lépésekről.",
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

function buildAssemblePrompt(input: {
	language: SupportedLanguage;
	query: string;
	curatedEvidence: string;
	synthesis: string;
	outline: string;
	imageCandidates: AtlasImageCandidate[];
	evidencePacksVersion: string;
	evidencePacks: AtlasEvidencePack[];
	evidencePackDiagnostics: AtlasEvidencePackDiagnostic[];
	coverageReview: AtlasCoverageReview;
	limitation: { code: string; message: string } | null;
	lifecycle: AtlasLifecycleContext["family"];
}): string {
	const instructions =
		input.language === "hu"
			? [
					"Return strict JSON with generatedTitle, bodyMarkdown, sectionBriefs, and limitations.",
					"Írj teljes Atlas jelentést a bodyMarkdown mezőben.",
					"Do not write a process report about checking sources, synthesizing findings, or completing research steps.",
					"Do not emit an H1/H2 title, subtitle, alternate report name, or report-title block in bodyMarkdown; the body should start with Vezetői összefoglaló when that section is present.",
					"A jelentés érdemi megállapításokat tartalmazzon: Vezetői összefoglaló, tematikus elemző szakaszok és Korlátok. Ne írj Markdown Források szakaszt; a backend determinisztikusan adja hozzá a forrásokat.",
					"Put the canonical report title only in generatedTitle, not in bodyMarkdown.",
					"Each sectionBrief must preserve evidencePackIds and sourceAssociations for the section.",
					"Ne írj jelentés-szintű Kulcsüzenet szakaszt. Csak akkor adj rövid, kompakt Kulcsüzenet kivonatot egy adott, tartalmilag sűrű szakaszon belül, ha az segíti az olvasást.",
					"Csak az elfogadott forrásokból és a válogatott bizonyítékokból következő állításokat tegyél.",
					"Ha a bizonyíték gyenge vagy ellentmondásos, azt a Limitations részben és a releváns szakaszban mondd ki.",
					"Ha összehasonlítható számszerű bizonyíték van, adj kompakt Markdown táblázatot, hogy a renderer diagramot készíthessen.",
					"Csak akkor adj Markdown képet HTTPS URL-lel, ha az hasznos, forrásalapú, és van világos képaláírása vagy forrásmegjelölése.",
					"A képeket az imageCandidates mezőből válaszd; ne találj ki kép URL-eket.",
				].join(" ")
			: [
					"Return strict JSON with generatedTitle, bodyMarkdown, sectionBriefs, and limitations.",
					"Write a complete Atlas report in the bodyMarkdown field.",
					"Do not write a process report about checking sources, synthesizing findings, or completing research steps.",
					"Do not emit an H1/H2 title, subtitle, alternate report name, or report-title block in bodyMarkdown; the body should start with Executive Summary when that section is present.",
					"The report must contain substantive findings: Executive Summary, thematic analytical sections, and Limitations. Do not write a Markdown Sources section; the backend appends deterministic Sources.",
					"Put the canonical report title only in generatedTitle, not in bodyMarkdown.",
					"Each sectionBrief must preserve evidencePackIds and sourceAssociations for the section.",
					"Do not write a report-level Key takeaway section. Only include a short, compact Key takeaway excerpt inside a specific content-heavy section when it improves scanability.",
					"Make only claims supported by accepted sources and curated evidence.",
					"If evidence is weak or conflicting, state that in Limitations and in the relevant section.",
					"When comparable numeric evidence is available, include a compact Markdown table so the renderer can build a useful chart.",
					"Only include Markdown images with HTTPS URLs when they are useful, source-backed, and have a clear caption or attribution.",
					"Choose images from the imageCandidates field; do not invent image URLs.",
				].join(" ");
	return JSON.stringify({
		detectedLanguage: input.language,
		query: input.query,
		instructions,
		curatedEvidence: input.curatedEvidence,
		synthesis: input.synthesis,
		outline: input.outline,
		imageCandidates: input.imageCandidates,
		evidencePacksVersion: input.evidencePacksVersion,
		evidencePacks: input.evidencePacks,
		evidencePackDiagnostics: input.evidencePackDiagnostics,
		coverageReview: input.coverageReview,
		searchLimitation: input.limitation,
		atlasLifecycle: input.lifecycle,
	});
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
	limitations: string;
} {
	if (language === "hu") {
		return {
			executive: "Vezetői összefoglaló",
			findings: "Megállapítások",
			limitations: "Korlátok",
		};
	}
	return {
		executive: "Executive Summary",
		findings: "Findings",
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
	const executiveIndex = unique.findIndex(
		(title) =>
			normalizedFallbackHeading(title) ===
			normalizedFallbackHeading(labels.executive),
	);
	if (executiveIndex > 0) {
		const [executive] = unique.splice(executiveIndex, 1);
		unique.unshift(executive);
	} else if (executiveIndex < 0) {
		unique.unshift(labels.executive);
	}
	const limitationsIndex = unique.findIndex(
		(title) =>
			normalizedFallbackHeading(title) ===
			normalizedFallbackHeading(labels.limitations),
	);
	if (limitationsIndex >= 0 && limitationsIndex !== unique.length - 1) {
		const [limitations] = unique.splice(limitationsIndex, 1);
		unique.push(limitations);
	} else if (limitationsIndex < 0) {
		unique.push(labels.limitations);
	}
	if (unique.length < 3) {
		const findingsKey = normalizedFallbackHeading(labels.findings);
		if (
			!unique.some((title) => normalizedFallbackHeading(title) === findingsKey)
		) {
			unique.splice(Math.max(1, unique.length - 1), 0, labels.findings);
		}
	}
	return unique.slice(0, 10);
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
				entry.body.length >= 30 && !isProcessFallbackStatement(entry.body),
		)
		.slice(0, 32);
}

function fallbackStatementsFromEvidencePacks(
	evidencePacks: AtlasEvidencePack[],
): Array<{ prefix: string | null; body: string }> {
	return evidencePacks
		.map((pack) => cleanFallbackScalar(pack.evidence.summary))
		.filter((summary): summary is string => Boolean(summary))
		.filter((summary) => !isProcessFallbackStatement(summary))
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
		return input.statements[matchedIndex].body;
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
			return executiveStatements.map((statement) => statement.body).join(" ");
		}
	}
	const fallbackIndex = input.statements.findIndex(
		(_, statementIndex) => !input.usedStatementIndexes.has(statementIndex),
	);
	if (fallbackIndex >= 0) {
		input.usedStatementIndexes.add(fallbackIndex);
		return input.statements[fallbackIndex].body;
	}
	return input.language === "hu"
		? "Az elfogadott bizonyítékok alapján csak óvatos, forráshoz kötött megállapítás adható ehhez a szakaszhoz."
		: "The accepted evidence supports only a cautious, source-bounded finding for this section.";
}

function buildFallbackReportSections(input: {
	language: SupportedLanguage;
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

	await input.dependencies.heartbeat?.({
		stage: "assemble",
		progressPercent: 82,
	});
	const assemble = await input.dependencies.runModelStage({
		stage: "assemble",
		system: stageSystem("assemble", language, currentDate, profilePosture),
		prompt: buildAssemblePrompt({
			language,
			query: input.job.query,
			curatedEvidence: finalResearchRound.curatedEvidence,
			synthesis: synthesize.text,
			outline: integrate.text,
			imageCandidates: imageSearch.imageCandidates,
			evidencePacksVersion: evidencePackResult.version,
			evidencePacks: evidencePackResult.evidencePacks,
			evidencePackDiagnostics,
			coverageReview,
			limitation: searchLimitation,
			lifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, assemble.usage);
	let assemblyOutput = parseAtlasAssemblyOutput(assemble.text);
	let assemblyMetadata = assemblyOutput.metadata;
	let finalAssembledMarkdown = assemblyOutput.markdown;
	if (looksLikeProcessOnlyReport(finalAssembledMarkdown)) {
		await input.dependencies.heartbeat?.({
			stage: "assemble",
			progressPercent: 86,
		});
		const basePrompt = buildAssemblePrompt({
			language,
			query: input.job.query,
			curatedEvidence: finalResearchRound.curatedEvidence,
			synthesis: synthesize.text,
			outline: integrate.text,
			imageCandidates: imageSearch.imageCandidates,
			evidencePacksVersion: evidencePackResult.version,
			evidencePacks: evidencePackResult.evidencePacks,
			evidencePackDiagnostics,
			coverageReview,
			limitation: searchLimitation,
			lifecycle: input.job.lifecycle.family,
		});
		const repair = await input.dependencies.runModelStage({
			stage: "assemble",
			system: stageSystem("assemble", language, currentDate, profilePosture),
			prompt: buildAssembleRepairPrompt({
				basePrompt,
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
	if (looksLikeProcessOnlyReport(finalAssembledMarkdown)) {
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

	const auditSources = [
		...sources.localSources.map((source) => ({
			title: source.title,
			url: null,
			authority: source.authority,
			reasoning:
				source.authority === "explicit"
					? "You provided these"
					: source.authority === "working_document"
						? "Readable working document selected by Atlas"
						: "Parent or automatic library source selected by Atlas",
		})),
		...finalResearchRound.webSources.map((source) => ({
			title: source.title,
			url: source.url,
			reasoning: source.snippet ?? "Accepted web evidence gathered by Atlas",
		})),
	];
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
	const auditedMarkdown =
		audit.passed && !audit.retryRequested
			? finalAssembledMarkdown
			: [
					finalAssembledMarkdown,
					"",
					"## Limitations",
					"Atlas audit requested additional verification. This version ships with explicit limitations and Basis Markers instead of unsupported certainty.",
				].join("\n");
	const canonicalTitle = assemblyMetadata.generatedTitle ?? input.job.title;
	if (assemblyMetadata.generatedTitle) {
		await input.dependencies.applyGeneratedTitle?.({
			jobId: input.job.id,
			title: assemblyMetadata.generatedTitle,
		});
	}
	const claimBasis = audit.claimBasis ?? [];
	const basisLimitations = audit.basisLimitations ?? [];
	const basisDiagnostics = audit.basisDiagnostics ?? [];
	const claimBasisCoverageBySection = audit.claimBasisCoverageBySection ?? [];
	const claimBasisStatus =
		audit.claimBasisStatus ?? (claimBasis.length > 0 ? "succeeded" : "failed");
	const claimBasisFailureReason = audit.claimBasisFailureReason ?? null;

	const documentSource = buildAtlasDocumentSource({
		title: canonicalTitle,
		subtitle: null,
		family: input.job.lifecycle.family,
		assembledMarkdown: auditedMarkdown,
		sources: auditSources,
		honestyMarkers: audit.honestyMarkers,
		claimBasis,
		imageCandidates: imageSearch.imageCandidates,
		maxRenderedImages: profileConfig.maxRenderedImages,
		date: currentDate,
		language,
	});
	const selectedImageCandidateIds = collectAtlasSelectedImageCandidateIds(
		documentSource,
		imageSearch.imageCandidates,
	);

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
