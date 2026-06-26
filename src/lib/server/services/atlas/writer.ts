import {
	getAtlasMaxWriterPromptChars,
	getMaxModelContext,
} from "$lib/server/config-store";
import type { SupportedLanguage } from "$lib/server/services/language";
import type { AtlasReportShapeDiagnostics } from "./report-shape-diagnostics";
import type {
	AtlasCoverageReview,
	AtlasEvidencePackDiagnostic,
	AtlasImageCandidate,
	AtlasLifecycleContext,
	AtlasProfile,
	AtlasSectionBrief,
	AtlasWriterEvidenceCard,
	AtlasWriterEvidenceCardDiagnostic,
} from "./types";

export interface BuildAtlasWriterPromptInput {
	language: SupportedLanguage;
	query: string;
	currentDate: string;
	profile: AtlasProfile;
	profilePosture: string;
	decomposeText: string;
	synthesis: string;
	outline: string;
	sectionBriefs: AtlasSectionBrief[];
	imageCandidates: AtlasImageCandidate[];
	writerEvidenceCardsVersion: string;
	writerEvidenceCards: AtlasWriterEvidenceCard[];
	writerEvidenceCardDiagnostics: AtlasWriterEvidenceCardDiagnostic[];
	evidencePackDiagnostics: AtlasEvidencePackDiagnostic[];
	coverageReview: AtlasCoverageReview;
	limitation: { code: string; message: string } | null;
	lifecycle: AtlasLifecycleContext["family"];
}

interface BuildAtlasWriterImprovementPromptInput
	extends BuildAtlasWriterPromptInput {
	currentDraft: string;
	reportShapeDiagnostics: AtlasReportShapeDiagnostics;
}

const RAW_DUMP_PATTERNS = [
	/\bsearch result snippet\s*:/i,
	/\bfetched page excerpt\s*:/i,
	/\braw[_ -]?[a-z0-9_]*sentinel\b/i,
	/\bcopied from the fetched page\b/i,
	/\bnavigation boilerplate\b/i,
	/\bboilerplate copied\b/i,
];

const SERIOUS_REPORT_SHAPE_WARNING_CODES = new Set([
	"atlas_report_body_too_thin",
	"atlas_report_underdeveloped_for_section_count",
	"atlas_evidence_rich_decision_report_underdeveloped",
	"atlas_report_sections_too_sparse",
	"atlas_too_many_one_sentence_sections",
	"atlas_source_projection_dominates_report",
	"atlas_recommendation_not_decisive",
]);

function writerInstructions(language: SupportedLanguage): string {
	if (language === "hu") {
		return [
			"Return strict JSON with generatedTitle, bodyMarkdown, sectionBriefs, and limitations.",
			"Írj olvasói, döntésminőségű Atlas jelentést a bodyMarkdown mezőben; a jelentés a kérdésre válaszoljon, ne a kutatási folyamatot írja le.",
			"A szerkezetet a kéréshez igazítsd. Döntési vagy választási kérésnél használhatsz rangsorolt shortlistet, döntési kritériumokat, hardver/latency/költség kompromisszumokat, ajánlott stacket, kerülendő opciókat és bizonyítékhiányokat.",
			"Do not write Markdown Sources, bibliographies, references, works-cited sections, citation appendices, or source lists; source projection is backend-owned.",
			"Do not include inline source citations, source website names, URLs, or 'Source: ...' attributions in body paragraphs. All source references are handled deterministically by the backend.",
			"Do not include raw source dumps, fetched-page excerpts, search-result snippets, or long quoted source blocks.",
			"Put the canonical report title only in generatedTitle, not in bodyMarkdown.",
			"Ne írj H1/H2 címet, alcímet vagy jelentéscím blokkot a bodyMarkdown elejére; ha van vezetői összefoglaló, azzal kezdj.",
			"Ne ismételd a jelentés címét vagy annak változatát a bodyMarkdownban; a cím egyszer szerepel a generatedTitle mezőben, a háttérrendszer rendereli.",
			"H2 címsorokat használj a fő jelentésszakaszokhoz (pl. Elemzés, Javaslatok, Korlátok). Minden címsor alatt több bekezdéssel fejtsd ki az elemzést. H3 címsorokat használj alszakaszokhoz. Ne használj címsort egyetlen mondat számára — azt bekezdésként írd meg. Ne írj hosszú bekezdést ott, ahol egy H3 alszakasz törés javítaná az olvashatóságot.",
			"A Writer Evidence Cardokból írj elemzést, rangsorolást, kompromisszumokat, korlátokat és bizonyítékhoz kötött ajánlást, ahol ezt a forrásalap támogatja.",
			"Csak támogatott állításokat tegyél. Ha a bizonyíték gyenge vagy ellentmondásos, mondd ki a releváns szakaszban és a limitations mezőben.",
			"Adj kompakt Markdown táblázatot, ha összehasonlítás vagy döntési kritériumok tisztábban olvashatók táblázatként.",
			"Képet csak az imageCandidates mezőből válassz, HTTPS URL-lel; ne találj ki kép URL-eket, és ne használj logót, ikont, devicont, SVG/vektor vagy dekoratív képet.",
			"Each sectionBrief must preserve relevant evidencePackIds and sourceAssociations when the section depends on specific cards.",
			"Ne írj olyan lista elemet, amely csak egy címkét és kettőspontot tartalmaz tartalom nélkül (pl. '- **Hardware fit:**' érvénytelen). Minden lista elemnek tartalmaznia kell leíró szöveget a címke után.",
			"Opcionálisan adj meg egy claimBasis tömböt kulcsfontosságú tényszerű állítások ellenőrzéséhez, ahol minden bejegyzés tartalmazza a claimText, sectionTitle, supportLevel (supported/partial/unsupported), evidenceCardIds és rationale mezőket.",
		].join(" ");
	}
	return [
		"Return strict JSON with generatedTitle, bodyMarkdown, sectionBriefs, and limitations.",
		"Write a reader-facing, decision-quality Atlas report in bodyMarkdown; answer the user's question instead of describing the research process.",
		"Choose a structure that fits the request. For decision or selection queries, you may use ranked shortlists, decision criteria, hardware fit, latency/cost tradeoffs, language/domain coverage, recommended stack, what to avoid, and evidence gaps.",
		"Do not write Markdown Sources, bibliographies, references, works-cited sections, citation appendices, or source lists; source projection is backend-owned.",
		"Do not include inline source citations, source website names, URLs, or 'Source: ...' attributions in body paragraphs. All source references are handled deterministically by the backend.",
		"Do not include raw source dumps, fetched-page excerpts, search-result snippets, or long quoted source blocks.",
		"Put the canonical report title only in generatedTitle, not in bodyMarkdown.",
		"Do not emit an H1/H2 title, subtitle, alternate report name, or report-title block at the start of bodyMarkdown; start with Executive Summary when that section is useful.",
		"Do not repeat the report title or any variant of it inside bodyMarkdown; the title appears once in generatedTitle and is rendered by the backend.",
		"Use H2 headings for major report sections (e.g., Analysis, Recommendations, Limitations). Under each heading, write at least 2-3 paragraphs of analysis. Use H3 for sub-sections within a major section. Do not use a heading for text that is a single sentence — make it a paragraph instead. Do not write a long paragraph where an H3 sub-section break would improve readability.",
		"Each major section must contain substantive analysis, not just bullet points or a single paragraph. Aim for at least 150 words per major section. The Executive Summary should be 2-3 sentences summarizing the key conclusion and main tradeoffs.",
		"Use Writer Evidence Cards to write analysis, rankings, tradeoffs, limitations, and evidence-grounded recommendations where the source basis supports them.",
		"When a source directly states a specific fact (price, benchmark score, hardware spec, license term, performance metric, release date), present that fact as a standalone declarative sentence before synthesizing it with other evidence. This separates directly-sourced facts from interpretive synthesis and improves claim verification.",
		"Make only supported claims. If evidence is weak or conflicting, state that in the relevant section and in limitations.",
		"Use compact Markdown tables when comparisons or decision criteria become clearer as a table.",
		"Choose images only from imageCandidates with HTTPS URLs; do not invent image URLs and do not use logos, icons, devicons, SVG/vector assets, or decorative images. Only choose images that are directly relevant to the report topic.",
		"Each sectionBrief must preserve relevant evidencePackIds and sourceAssociations when the section depends on specific cards.",
		"Do not emit list items that have only a label and colon with no content after the colon (e.g., '- **Hardware fit:**' is invalid). Every list item must have descriptive text after any label.",
		"Optionally return a claimBasis array to verify key factual claims against evidence cards; each entry should include claimText, sectionTitle, supportLevel (supported/partial/unsupported), evidenceCardIds, and rationale. Do not place claimBasis entries in the Executive Summary section.",
	].join(" ");
}

function improvementInstructions(language: SupportedLanguage): string {
	if (language === "hu") {
		return [
			"Ez az egyetlen engedélyezett writer improvement pass ehhez az Atlas jobhoz.",
			"A vázlat alakdiagnosztikája szerint a jelentés túl vékony, a szakaszszámhoz vagy bizonyítékalaphoz képest alul kidolgozott, túl sok egymondatos szakaszból áll, nem elég döntésképes, vagy a forrásanyag dominál.",
			"Írd újra döntésminőségű jelentéssé a meglévő Writer Evidence Cardokból: legyen vezetői összefoglaló, rangsor vagy shortlist, összehasonlító kompromisszumok, telepítési/üzemeltetési következmények, konkrét ajánlás, valamint korlátok.",
			"Minden fő szakaszban fejtsd ki a választ több mondatban; ne hagyj címszerű vagy csak egymondatos ajánlási szakaszt.",
			"Do not add sources. Do not run or request new searches. Do not invent unsupported claims. Do not append a Markdown Sources section. Do not include inline source citations, URLs, or 'Source: ...' attributions in body paragraphs.",
			"Return the same strict JSON schema as the first writer pass.",
		].join(" ");
	}
	return [
		"This is the only allowed writer improvement pass for this Atlas job.",
		"The draft shape diagnostics show that the report is too thin, underdeveloped for its section count or evidence basis, has too many one-sentence sections, is not decisive enough, or is dominated by source material.",
		"Rewrite it into a decision-quality report from the existing Writer Evidence Cards: include an executive summary, ranking or shortlist, comparative tradeoffs, deployment and operating implications, a concrete recommendation, and limitations.",
		"Develop each main body section with multiple sentences; do not leave a recommendation section as a heading-like restatement or a single hollow sentence.",
		"Do not add sources. Do not run or request new searches. Do not invent unsupported claims. Do not append a Markdown Sources section. Do not include inline source citations, URLs, or 'Source: ...' attributions in body paragraphs.",
		"Return the same strict JSON schema as the first writer pass.",
	].join(" ");
}

function normalizePromptText(value: string, maxLength: number): string {
	const normalized = value
		.replace(/\bSearch result snippet:\s*/gi, "")
		.replace(/\bFetched page excerpt:\s*/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized
		.slice(0, maxLength + 1)
		.replace(/\s+\S*$/, "")
		.trim()}...`;
}

function isLikelyRawDump(value: string): boolean {
	return RAW_DUMP_PATTERNS.some((pattern) => pattern.test(value));
}

function compactPromptTexts(values: string[], maxLength: number): string[] {
	return values
		.map((value) => normalizePromptText(value, maxLength))
		.filter((value) => value && !isLikelyRawDump(value));
}

function modelFacingWriterEvidenceCard(card: AtlasWriterEvidenceCard) {
	const relevantFacts = compactPromptTexts(card.relevantFacts, 240);
	const fallbackFact =
		relevantFacts.length === 0 && card.supportsSections.length > 0
			? `Accepted evidence supports: ${card.supportsSections.join("; ")}.`
			: null;
	return {
		version: card.version,
		id: card.id,
		sourceTitle: normalizePromptText(card.sourceTitle, 140),
		url: card.url,
		authority: card.authority,
		relevantFacts: fallbackFact ? [fallbackFact] : relevantFacts,
		limitations: compactPromptTexts(card.limitations, 220),
		conflicts: compactPromptTexts(card.conflicts, 220),
		supportsSections: card.supportsSections.map((section) =>
			normalizePromptText(section, 90),
		),
		evidencePackIds: card.evidencePackIds,
		sourceRefs: card.sourceRefs.map((sourceRef) => ({
			id: sourceRef.id,
			kind: sourceRef.kind,
			title: normalizePromptText(sourceRef.title, 140),
			url: sourceRef.url,
			authority: sourceRef.authority,
		})),
		freshnessNote: card.freshnessNote
			? normalizePromptText(card.freshnessNote, 220)
			: null,
	};
}

function compactString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}

function baseWriterPrompt(
	input: BuildAtlasWriterPromptInput,
	truncationLevel = 0,
) {
	const factsPerCard =
		truncationLevel >= 5
			? 1
			: truncationLevel >= 4
				? 2
				: truncationLevel >= 2
					? 3
					: null;
	const synthesisMaxLen = truncationLevel >= 1 ? 1500 : null;
	const outlineMaxLen = truncationLevel >= 1 ? 1500 : null;
	const trimCoverageReview = truncationLevel >= 3;
	const omitCoverageReview = truncationLevel >= 5;
	const omitDiagnostics = truncationLevel >= 5;

	const synthesis =
		synthesisMaxLen !== null
			? compactString(input.synthesis, synthesisMaxLen)
			: input.synthesis;
	const outline =
		outlineMaxLen !== null
			? compactString(input.outline, outlineMaxLen)
			: input.outline;
	const writerEvidenceCards = input.writerEvidenceCards.map((card) => {
		const base = modelFacingWriterEvidenceCard(card);
		if (factsPerCard === null) return base;
		const truncated = {
			...base,
			relevantFacts: base.relevantFacts.slice(0, factsPerCard),
		};
		if (truncationLevel >= 5) {
			return {
				...truncated,
				conflicts: [],
				supportsSections: [],
				sourceRefs: [],
				limitations: truncated.limitations.slice(0, 1),
			};
		}
		return truncated;
	});
	const coverageReview = omitCoverageReview
		? {
				sufficient: input.coverageReview.sufficient,
				truncated: true,
			}
		: trimCoverageReview
			? {
					sufficient: input.coverageReview.sufficient,
					proposals: input.coverageReview.proposals,
					diagnostics: input.coverageReview.diagnostics,
					limitations: input.coverageReview.limitations,
				}
			: {
					version: input.coverageReview.version,
					sufficient: input.coverageReview.sufficient,
					proposals: input.coverageReview.proposals,
					approvedGapCandidates: input.coverageReview.approvedGapCandidates,
					diagnostics: input.coverageReview.diagnostics,
					limitations: input.coverageReview.limitations,
				};

	return {
		detectedLanguage: input.language,
		currentDate: input.currentDate,
		query: input.query,
		profile: input.profile,
		profilePosture: input.profilePosture,
		instructions: writerInstructions(input.language),
		outputContract: {
			strictJson: true,
			requiredFields: [
				"generatedTitle",
				"bodyMarkdown",
				"sectionBriefs",
				"limitations",
			],
			optionalFields: ["sourceAssociations", "claimBasis"],
			claimBasisDescription:
				"Optional array of AtlasWriterClaimBasisEntry objects for verifying key factual claims. Each entry must include claimText, sectionTitle, supportLevel (supported/partial/unsupported), evidenceCardIds, and rationale. When absent, the audit stage will generate claim basis post-hoc.",
		},
		reportIntent: {
			originalQuery: input.query,
			decomposition: input.decomposeText,
			synthesis,
			integratedOutline: outline,
			sectionBriefs: input.sectionBriefs,
		},
		synthesis,
		outline,
		sectionBriefs: input.sectionBriefs,
		imageCandidates: input.imageCandidates,
		writerEvidenceCardsVersion: input.writerEvidenceCardsVersion,
		writerEvidenceCards,
		writerEvidenceCardDiagnostics: omitDiagnostics
			? []
			: input.writerEvidenceCardDiagnostics,
		evidencePackDiagnostics: omitDiagnostics
			? []
			: input.evidencePackDiagnostics,
		coverageReview,
		searchLimitation: input.limitation,
		limitations: omitDiagnostics
			? [
					...(input.limitation ? [input.limitation.message] : []),
					...(input.coverageReview.limitations.length > 0
						? [
								"Evidence coverage limitations suppressed under aggressive truncation.",
							]
						: []),
				]
			: [
					...(input.limitation ? [input.limitation.message] : []),
					...input.coverageReview.limitations.map(
						(limitation) => limitation.message,
					),
					...input.evidencePackDiagnostics
						.filter((diagnostic) => diagnostic.severity === "warning")
						.map((diagnostic) => diagnostic.message),
				],
		atlasLifecycle: input.lifecycle,
		sourceProjectionRule:
			"Do not write Markdown Sources, bibliographies, references, works-cited sections, citation appendices, or source lists; the backend owns source projection.",
	};
}

export function buildAtlasWriterPrompt(
	input: BuildAtlasWriterPromptInput,
): string {
	const effectiveMax = Math.min(
		getAtlasMaxWriterPromptChars(),
		Math.floor(getMaxModelContext() * 0.55),
	);
	const firstPass = JSON.stringify(baseWriterPrompt(input));
	if (firstPass.length <= effectiveMax) return firstPass;
	console.info("[ATLAS_WRITER] Prompt truncated", {
		originalLength: firstPass.length,
		maxChars: effectiveMax,
		profile: input.profile,
		evidenceCardCount: input.writerEvidenceCards.length,
	});
	for (let level = 1; level <= 5; level++) {
		const result = JSON.stringify(baseWriterPrompt(input, level));
		if (result.length <= effectiveMax) return result;
	}
	return JSON.stringify(baseWriterPrompt(input, 5));
}

export function buildAtlasWriterImprovementPrompt(
	input: BuildAtlasWriterImprovementPromptInput,
): string {
	const effectiveMax = Math.min(
		getAtlasMaxWriterPromptChars(),
		Math.floor(getMaxModelContext() * 0.55),
	);
	const codeWarnings = input.reportShapeDiagnostics.warnings
		.map((warning) => warning.code)
		.filter((code) => SERIOUS_REPORT_SHAPE_WARNING_CODES.has(code));
	const makePrompt = (level: number) => ({
		...baseWriterPrompt(input, level),
		writerImprovement: {
			pass: 1,
			maxPasses: 1,
			warningCodes: codeWarnings,
		},
		improvementInstructions: improvementInstructions(input.language),
		currentDraft: input.currentDraft,
		reportShapeDiagnostics: input.reportShapeDiagnostics,
	});
	const firstPass = JSON.stringify(makePrompt(0));
	if (firstPass.length <= effectiveMax) return firstPass;
	for (let level = 1; level <= 5; level++) {
		const result = JSON.stringify(makePrompt(level));
		if (result.length <= effectiveMax) return result;
	}
	return JSON.stringify(makePrompt(5));
}

export function shouldImproveAtlasWriterDraft(
	diagnostics: AtlasReportShapeDiagnostics,
	context?: { evidenceCardCount?: number },
): boolean {
	const warningCodes = new Set(
		diagnostics.warnings.map((warning) => warning.code),
	);
	if (warningCodes.has("atlas_source_projection_dominates_report")) return true;
	if (warningCodes.has("atlas_recommendation_not_decisive")) return true;
	if (warningCodes.has("atlas_report_underdeveloped_for_section_count")) {
		return true;
	}
	if (warningCodes.has("atlas_evidence_rich_decision_report_underdeveloped")) {
		return true;
	}
	if (warningCodes.has("atlas_report_sections_too_sparse")) return true;
	if (warningCodes.has("atlas_too_many_one_sentence_sections")) return true;
	const evidenceCardCount = context?.evidenceCardCount ?? 0;
	return (
		warningCodes.has("atlas_report_body_too_thin") &&
		diagnostics.bodyWordCount < Math.max(200, evidenceCardCount * 12) &&
		!diagnostics.hasDecisionOrRecommendationSignal
	);
}
