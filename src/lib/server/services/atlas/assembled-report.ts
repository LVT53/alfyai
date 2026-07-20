import type { SupportedLanguage } from "$lib/server/services/language";
import type { AtlasReportShapeDiagnostics } from "./report-shape-diagnostics";
import type {
	AtlasAssemblyMetadata,
	AtlasEvidencePack,
	AtlasSectionBrief,
	AtlasSectionBriefSourceAssociation,
} from "./types";
import { ATLAS_ASSEMBLY_SCHEMA_VERSION } from "./types";

// ---------------------------------------------------------------------------
// Assembled-report normalization module.
//
// This module owns the pure "make the model's assembled report well-formed"
// heuristics: malformed-report detection, heading dedup, boilerplate stripping,
// honest-fallback construction, and limitations-section insertion. It has no
// dependency on the pipeline orchestrator, model calls, or `dependencies`; it
// only transforms/inspects report text and the accepted evidence.
//
// NOTE: `report-shape-diagnostics.ts` maintains its own private copies of some
// of the same primitives (SAFE_REPORT_HEADING_LABELS, CLAIM_HEADING_VERB_PATTERN,
// PROMPT_INSTRUCTION_HEADING_PATTERN, stripMarkdown/normalizedHeading/wordCount).
// The duplication is intentionally left in place in this relocation pass.
// ---------------------------------------------------------------------------

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

export function hasLimitationsHeading(markdown: string): boolean {
	return markdownHeadingTitles(markdown).some((heading) => {
		const normalized = normalizedReportShapeText(heading);
		if (!normalized) return false;
		return /(?:\blimitations?\b(?:\s+(?:and|&)\s+(?:caveats|constraints|gaps))?|\bconstraints?\b|\bcaveats?\b|\breport\s*limitations?\b|\bkorlatok\b)/i.test(
			normalized,
		);
	});
}

export function stripModelBoilerplate(markdown: string): string {
	const patterns = [
		/Report generated at the \w+ stage/gi,
		/Generated (?:at|during|by) the (?:Atlas )?(?:assemble|synthesize|integrate|audit) stage/gi,
		/This report was (?:compiled|generated|produced) (?:by|during|at) Atlas/gi,
		/Use (?:this|the above) as a starting point for further investigation/gi,
	];
	let result = markdown;
	for (const pattern of patterns) {
		result = result.replace(pattern, "");
	}
	return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function deduplicateHeadings(markdown: string): string {
	const seen = new Set<string>();
	const lines = markdown.split(/\r?\n/);
	const result: string[] = [];
	for (const line of lines) {
		const match = /^(\s*#{2}\s+)(.+?)\s*#*\s*$/.exec(line);
		if (match) {
			const headingText = match[2].trim();
			const normalized = headingText
				.normalize("NFD")
				.replace(/[\u0300-\u036f]/g, "")
				.toLowerCase()
				.trim();
			if (seen.has(normalized)) {
				continue;
			}
			seen.add(normalized);
		}
		result.push(line);
	}
	return result.join("\n");
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
	/\b(?:(?:are|avoid|can|cannot|choose|dominates?|has|have|improves?|is|keeps?|leads?|limits?|needs?|offers?|outperforms?|requires?|should|supports?|uses?|wins?)\b|támogat|javít|nyújt|kínál|működik|teljesít)/i;

const PROMPT_INSTRUCTION_HEADING_PATTERN =
	/\b(?:answer|cite|compare|cover|explain|include|provide|return|use\s+current\s+web\s+evidence|with\s+current\s+web\s+evidence|write)\b/i;

export function isLikelySentenceClaimHeading(title: string): boolean {
	const trimmed = title.trim().replace(/[.:;]+$/g, "");
	const normalized = normalizedReportShapeText(trimmed);
	if (!normalized || SAFE_REPORT_HEADING_LABELS.has(normalized)) return false;
	if (/^(?:what|where|when|why|how)\b/i.test(trimmed)) return false;
	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length < 4) return false;
	// Require BOTH trailing punctuation AND a claim verb
	if (!/[.!?]$/.test(title.trim())) return false;
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

export function sanitizeMalformedWriterHeadings(input: {
	markdown: string;
	acceptedSourceTitles: string[];
}): string {
	// Pass 1: Demote malformed headings to bold text
	const demoted = input.markdown
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

	// Pass 2: Promote heading-like lines to H3
	// A non-heading line looks like a heading when it is short, has no
	// sentence-ending punctuation, and is followed by a longer paragraph.
	const demotedLines = demoted.split(/\r?\n/);
	const promotedLines: string[] = [];
	for (let i = 0; i < demotedLines.length; i++) {
		const line = demotedLines[i];
		const trimmed = line.trim();
		if (
			trimmed &&
			!line.startsWith("#") &&
			trimmed.length < 60 &&
			!/[.!?]/.test(trimmed)
		) {
			// Look ahead for the next non-empty line
			let nextNonEmpty = "";
			for (let j = i + 1; j < demotedLines.length; j++) {
				const next = demotedLines[j].trim();
				if (next) {
					nextNonEmpty = next;
					break;
				}
			}
			if (nextNonEmpty && nextNonEmpty.length > 120) {
				promotedLines.push(`### ${trimmed}`);
				continue;
			}
		}
		promotedLines.push(line);
	}
	return promotedLines.join("\n").trim();
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

export function buildHonestEvidenceFallbackReport(input: {
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

export function appendAdditionalLimitations(input: {
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

/**
 * Runs the pure post-model normalization pipeline over an assembled report
 * draft: ensure a limitations section, sanitize malformed writer headings,
 * strip model boilerplate, and deduplicate headings — in that exact order.
 * This is the small entry point pipeline.ts calls instead of the individual
 * report-shape helpers when a draft is not an honest fallback.
 */
export function finalizeAssembledReport(input: {
	markdown: string;
	language: SupportedLanguage;
	acceptedSourceTitles: string[];
}): string {
	let markdown = ensureLimitationsSection(input.markdown, input.language);
	markdown = sanitizeMalformedWriterHeadings({
		markdown,
		acceptedSourceTitles: input.acceptedSourceTitles,
	});
	markdown = stripModelBoilerplate(markdown);
	markdown = deduplicateHeadings(markdown);
	return markdown;
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

export function stripAtlasPromptInstructionTail(value: string): string {
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

export function normalizeAtlasReportTitleCasing(title: string): string {
	return title.replace(/^\p{Ll}/u, (letter) =>
		letter.toLocaleUpperCase("en-US"),
	);
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
]);

export function finalReportQualityFailures(
	diagnostics: AtlasReportShapeDiagnostics,
): {
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
