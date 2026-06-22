import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
	GeneratedDocumentSourceChip,
} from "$lib/server/services/file-production/source-schema";

export type AtlasReportShapeWarningCode =
	| "atlas_report_body_too_thin"
	| "atlas_report_sections_too_sparse"
	| "atlas_too_many_one_sentence_sections"
	| "atlas_source_projection_dominates_report"
	| "atlas_recommendation_not_decisive"
	| "atlas_too_many_images_for_body_size"
	| "atlas_claim_shaped_headings";

export interface AtlasReportShapeWarning {
	code: AtlasReportShapeWarningCode;
	message: string;
}

export interface AtlasReportShapeDiagnostics {
	bodyWordCount: number;
	sourceWordCount: number;
	totalWordCount: number;
	sourceWordShare: number;
	sectionCount: number;
	substantiveSectionCount: number;
	oneSentenceSectionCount: number;
	claimShapedHeadingCount: number;
	imageCount: number;
	hasDecisionOrRecommendationSignal: boolean;
	warnings: AtlasReportShapeWarning[];
}

interface ReportShapeSection {
	title: string | null;
	textParts: string[];
	hasStructuredContent: boolean;
}

interface ReportShapeParts {
	bodyText: string;
	sourceText: string;
	sections: ReportShapeSection[];
	imageCount: number;
}

const BODY_TOO_THIN_WORDS = 220;
const SPARSE_REPORT_MAX_WORDS = 700;
const SHALLOW_SECTION_REPORT_MAX_WORDS = 900;
const MIN_SECTIONS_FOR_SPARSE_WARNING = 6;
const MIN_ONE_SENTENCE_SECTIONS_FOR_WARNING = 6;
const SOURCE_DOMINATES_MIN_WORDS = 300;
const SOURCE_DOMINATES_SHARE = 0.55;
const SOURCE_DOMINATES_RATIO = 2;
const SUBSTANTIVE_SECTION_WORDS = 55;
const SUBSTANTIVE_STRUCTURED_SECTION_WORDS = 30;
const HOLLOW_RECOMMENDATION_WORDS = 18;
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
const PROMPT_INSTRUCTION_HEADING_PATTERN =
	/\b(?:answer|cite|compare|cover|explain|include|provide|return|use\s+current\s+web\s+evidence|with\s+current\s+web\s+evidence|write)\b/i;

const SOURCE_SECTION_LABELS = new Set([
	"sources",
	"source list",
	"sources cited",
	"sources consulted",
	"sources consulted by the model",
	"sources used",
	"web sources",
	"your library",
	"bibliography",
	"references",
	"reference list",
	"works cited",
	"citations",
	"citation appendix",
	"forrasok",
	"forraslista",
	"felhasznalt forrasok",
	"webes forrasok",
	"sajat konyvtar",
	"hivatkozasok",
	"hivatkozasi fuggelek",
	"irodalomjegyzek",
	"felhasznalt irodalom",
]);

function normalizedHeading(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.:;]+$/g, "");
}

function isSourceHeading(text: string): boolean {
	const normalized = normalizedHeading(text).replace(
		/^(appendix|fuggelek)\s*[:.-]\s*/,
		"",
	);
	return SOURCE_SECTION_LABELS.has(normalized);
}

function stripMarkdown(text: string): string {
	return text
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/[`*_~>#|-]+/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function wordCount(text: string): number {
	return (
		stripMarkdown(text).match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)
			?.length ?? 0
	);
}

function sentenceCount(text: string): number {
	const stripped = stripMarkdown(text);
	if (!stripped) return 0;
	const endings = stripped.match(/[.!?]+(?=\s|$)/g)?.length ?? 0;
	return Math.max(1, endings);
}

function hasDecisionSignal(text: string): boolean {
	return /\b(?:we recommend|recommend(?:ed|s)?|should|choose|use|adopt|avoid|default|best fit|best option|verdict|decision is|start with|opt for|ranked|shortlist)\b/i.test(
		text,
	);
}

function isRecommendationTitle(title: string | null): boolean {
	return Boolean(
		title &&
			/\b(?:recommendation|recommended|decision|verdict|shortlist|what to do|javaslat|dontes)\b/i.test(
				normalizedHeading(title),
			),
	);
}

function isLikelyClaimShapedHeading(title: string | null): boolean {
	if (!title) return false;
	const trimmed = title.trim().replace(/[.:;]+$/g, "");
	const normalized = normalizedHeading(trimmed);
	if (!normalized || SAFE_REPORT_HEADING_LABELS.has(normalized)) return false;
	if (/^(?:what|where|when|why|how)\b/i.test(trimmed)) return false;
	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length < 4) return false;
	if (/[.!?]$/.test(title.trim()) || /[.!?]\s+\S/.test(title.trim())) {
		return true;
	}
	if (words.length >= 5 && PROMPT_INSTRUCTION_HEADING_PATTERN.test(trimmed)) {
		return true;
	}
	return CLAIM_HEADING_VERB_PATTERN.test(trimmed);
}

function isTitleRestatement(title: string | null, text: string): boolean {
	if (!title) return false;
	const normalizedTitle = normalizedHeading(title);
	const normalizedText = normalizedHeading(text);
	if (!normalizedTitle || !normalizedText) return false;
	return (
		normalizedText === normalizedTitle ||
		normalizedText.startsWith(`${normalizedTitle} for `) ||
		normalizedText.startsWith(`${normalizedTitle}:`) ||
		normalizedText.startsWith(`${normalizedTitle} `)
	);
}

function blockText(block: GeneratedDocumentBlock): string {
	if (block.type === "heading" || block.type === "paragraph") return block.text;
	if (block.type === "quote") return block.text;
	if (block.type === "callout") return `${block.title ?? ""} ${block.text}`;
	if (block.type === "list") return block.items.join(" ");
	if (block.type === "code") return block.text;
	if (block.type === "table") {
		return [
			...block.columns.map((column) => column.label),
			...block.rows.flatMap((row) =>
				Object.values(row).map((value) => String(value ?? "")),
			),
		].join(" ");
	}
	if (block.type === "chart") {
		return `${block.title} ${block.caption ?? ""} ${block.altText ?? ""}`;
	}
	if (block.type === "image") {
		return `${block.altText ?? ""} ${block.caption ?? ""}`;
	}
	return "";
}

function sourceChipText(source: GeneratedDocumentSourceChip): string {
	return [source.title, source.reasoning ?? ""].filter(Boolean).join(" ");
}

function reportPartsFromDocumentSource(
	source: GeneratedDocumentSource,
): ReportShapeParts {
	const bodyTextParts: string[] = [];
	const sourceTextParts: string[] = [];
	const sections: ReportShapeSection[] = [];
	let currentSection: ReportShapeSection | null = null;
	let previousHeadingWasCanonicalSources = false;
	let imageCount = 0;

	for (const block of source.blocks) {
		if (block.type === "sourceChips") {
			if (previousHeadingWasCanonicalSources) {
				const lastBodyPart = bodyTextParts.at(-1);
				if (lastBodyPart && isSourceHeading(lastBodyPart)) bodyTextParts.pop();
			}
			sourceTextParts.push(
				block.title,
				...block.sources.map((chip) => sourceChipText(chip)),
			);
			previousHeadingWasCanonicalSources = false;
			continue;
		}

		if (block.type === "heading") {
			previousHeadingWasCanonicalSources = isSourceHeading(block.text);
			if (previousHeadingWasCanonicalSources) {
				sourceTextParts.push(block.text);
				currentSection = null;
				continue;
			}
			currentSection = {
				title: block.text,
				textParts: [],
				hasStructuredContent: false,
			};
			sections.push(currentSection);
			bodyTextParts.push(block.text);
			continue;
		}

		previousHeadingWasCanonicalSources = false;
		if (block.type === "image") imageCount += 1;
		const text = blockText(block);
		if (!text) continue;
		bodyTextParts.push(text);
		if (!currentSection) {
			currentSection = {
				title: null,
				textParts: [],
				hasStructuredContent: false,
			};
			sections.push(currentSection);
		}
		currentSection.textParts.push(text);
		if (
			block.type === "list" ||
			block.type === "table" ||
			block.type === "chart"
		) {
			currentSection.hasStructuredContent = true;
		}
	}

	return {
		bodyText: bodyTextParts.join(" "),
		sourceText: sourceTextParts.join(" "),
		sections,
		imageCount,
	};
}

function reportPartsFromMarkdown(markdown: string): ReportShapeParts {
	const bodyTextParts: string[] = [];
	const sourceTextParts: string[] = [];
	const sections: ReportShapeSection[] = [];
	let currentSection: ReportShapeSection | null = null;
	let sourceSectionLevel: number | null = null;
	let imageCount = 0;

	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const imageMatches = line.match(/!\[[^\]]*]\([^)]*\)/g);
		if (imageMatches) imageCount += imageMatches.length;

		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			const level = heading[1].length;
			const title = heading[2].trim();
			if (sourceSectionLevel !== null && level <= sourceSectionLevel) {
				sourceSectionLevel = null;
			}
			if (sourceSectionLevel !== null || isSourceHeading(title)) {
				sourceSectionLevel = sourceSectionLevel ?? level;
				sourceTextParts.push(title);
				currentSection = null;
				continue;
			}
			currentSection = {
				title,
				textParts: [],
				hasStructuredContent: false,
			};
			sections.push(currentSection);
			bodyTextParts.push(title);
			continue;
		}

		if (sourceSectionLevel !== null) {
			sourceTextParts.push(line);
			continue;
		}

		bodyTextParts.push(line);
		if (!currentSection) {
			currentSection = {
				title: null,
				textParts: [],
				hasStructuredContent: false,
			};
			sections.push(currentSection);
		}
		currentSection.textParts.push(line);
		if (/^\s*(?:[-*]|\d+\.)\s+/.test(rawLine) || line.includes("|")) {
			currentSection.hasStructuredContent = true;
		}
	}

	return {
		bodyText: bodyTextParts.join(" "),
		sourceText: sourceTextParts.join(" "),
		sections,
		imageCount,
	};
}

function buildWarnings(input: {
	bodyWordCount: number;
	sourceWordCount: number;
	totalWordCount: number;
	sourceWordShare: number;
	sectionCount: number;
	substantiveSectionCount: number;
	oneSentenceSectionCount: number;
	imageCount: number;
	claimShapedHeadingCount: number;
	hasDecisionOrRecommendationSignal: boolean;
	hasRecommendationSection: boolean;
	recommendationSectionHasDecisionSignal: boolean;
	recommendationSectionIsHollow: boolean;
}): AtlasReportShapeWarning[] {
	const warnings: AtlasReportShapeWarning[] = [];
	if (input.bodyWordCount > 0 && input.bodyWordCount < BODY_TOO_THIN_WORDS) {
		warnings.push({
			code: "atlas_report_body_too_thin",
			message:
				"Atlas report body is thin; this diagnostic is advisory and must not fail the job by itself.",
		});
	}
	const substantiveFloor = Math.min(3, Math.ceil(input.sectionCount / 3));
	if (
		input.sectionCount >= MIN_SECTIONS_FOR_SPARSE_WARNING &&
		input.bodyWordCount > 0 &&
		input.bodyWordCount < SPARSE_REPORT_MAX_WORDS &&
		input.substantiveSectionCount < substantiveFloor
	) {
		warnings.push({
			code: "atlas_report_sections_too_sparse",
			message:
				"Atlas report has too few substantive body sections for the requested decision-quality synthesis; this diagnostic may trigger the bounded writer improvement pass.",
		});
	}
	if (
		input.sectionCount >= MIN_SECTIONS_FOR_SPARSE_WARNING &&
		input.bodyWordCount > 0 &&
		input.bodyWordCount < SHALLOW_SECTION_REPORT_MAX_WORDS &&
		input.oneSentenceSectionCount >= MIN_ONE_SENTENCE_SECTIONS_FOR_WARNING &&
		input.oneSentenceSectionCount / input.sectionCount >= 0.6 &&
		input.substantiveSectionCount <=
			Math.max(2, Math.floor(input.sectionCount / 3))
	) {
		warnings.push({
			code: "atlas_too_many_one_sentence_sections",
			message:
				"Atlas report has many one-sentence sections and needs more decision-quality development in the body.",
		});
	}
	if (
		input.sourceWordCount >= SOURCE_DOMINATES_MIN_WORDS &&
		input.sourceWordShare >= SOURCE_DOMINATES_SHARE &&
		input.sourceWordCount >= input.bodyWordCount * SOURCE_DOMINATES_RATIO
	) {
		warnings.push({
			code: "atlas_source_projection_dominates_report",
			message:
				"Atlas source projection dominates the report body; publish compact sources and improve synthesis when possible.",
		});
	}
	if (
		input.hasRecommendationSection &&
		(!input.recommendationSectionHasDecisionSignal ||
			input.recommendationSectionIsHollow)
	) {
		warnings.push({
			code: "atlas_recommendation_not_decisive",
			message:
				"Atlas has a recommendation or decision section without a concrete, developed recommendation.",
		});
	}
	const imageLimit =
		input.bodyWordCount < 400
			? 1
			: Math.max(1, Math.ceil(input.bodyWordCount / 700));
	if (input.imageCount > imageLimit) {
		warnings.push({
			code: "atlas_too_many_images_for_body_size",
			message:
				"Atlas image count is high for the amount of report body text; this is an advisory shape diagnostic.",
		});
	}
	if (input.claimShapedHeadingCount > 0) {
		warnings.push({
			code: "atlas_claim_shaped_headings",
			message:
				"Atlas report still has sentence-like claim headings; those claims should be prose with basis markers, not section titles.",
		});
	}
	return warnings;
}

export function diagnoseAtlasReportShape(
	input: string | GeneratedDocumentSource,
): AtlasReportShapeDiagnostics {
	const parts =
		typeof input === "string"
			? reportPartsFromMarkdown(input)
			: reportPartsFromDocumentSource(input);
	const bodyWordCount = wordCount(parts.bodyText);
	const sourceWordCount = wordCount(parts.sourceText);
	const totalWordCount = bodyWordCount + sourceWordCount;
	const sourceWordShare =
		totalWordCount > 0 ? sourceWordCount / totalWordCount : 0;
	const sectionStats = parts.sections.map((section) => {
		const text = section.textParts.join(" ");
		const words = wordCount(text);
		return {
			title: section.title,
			text,
			words,
			sentences: sentenceCount(text),
			hasStructuredContent: section.hasStructuredContent,
			hasDecisionSignal: hasDecisionSignal(text),
		};
	});
	const bodySectionStats = sectionStats.filter((section) => section.words > 0);
	const substantiveSectionCount = bodySectionStats.filter(
		(section) =>
			section.words >= SUBSTANTIVE_SECTION_WORDS ||
			(section.hasStructuredContent &&
				section.words >= SUBSTANTIVE_STRUCTURED_SECTION_WORDS),
	).length;
	const oneSentenceSectionCount = bodySectionStats.filter(
		(section) => section.sentences <= 1,
	).length;
	const claimShapedHeadingCount = bodySectionStats.filter((section) =>
		isLikelyClaimShapedHeading(section.title),
	).length;
	const hasDecisionOrRecommendationSignal = hasDecisionSignal(parts.bodyText);
	const recommendationSections = bodySectionStats.filter((section) =>
		isRecommendationTitle(section.title),
	);
	const recommendationSectionHasDecisionSignal = recommendationSections.some(
		(section) => section.hasDecisionSignal,
	);
	const recommendationSectionIsHollow = recommendationSections.some(
		(section) =>
			(section.words < HOLLOW_RECOMMENDATION_WORDS &&
				!section.hasDecisionSignal) ||
			isTitleRestatement(section.title, section.text),
	);

	return {
		bodyWordCount,
		sourceWordCount,
		totalWordCount,
		sourceWordShare,
		sectionCount: bodySectionStats.length,
		substantiveSectionCount,
		oneSentenceSectionCount,
		claimShapedHeadingCount,
		imageCount: parts.imageCount,
		hasDecisionOrRecommendationSignal,
		warnings: buildWarnings({
			bodyWordCount,
			sourceWordCount,
			totalWordCount,
			sourceWordShare,
			sectionCount: bodySectionStats.length,
			substantiveSectionCount,
			oneSentenceSectionCount,
			imageCount: parts.imageCount,
			claimShapedHeadingCount,
			hasDecisionOrRecommendationSignal,
			hasRecommendationSection: recommendationSections.length > 0,
			recommendationSectionHasDecisionSignal,
			recommendationSectionIsHollow,
		}),
	};
}
