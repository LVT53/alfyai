import { marked } from "marked";
import type {
	GeneratedDocumentBasisMarkerBlock,
	GeneratedDocumentBlock,
	GeneratedDocumentChartBlock,
	GeneratedDocumentImageBlock,
	GeneratedDocumentParagraphBasisMarker,
	GeneratedDocumentScalar,
	GeneratedDocumentSource,
	GeneratedDocumentSourceChip,
	GeneratedDocumentTableBlock,
} from "$lib/server/services/file-production/source-schema";
import {
	detectLanguage,
	type SupportedLanguage,
} from "$lib/server/services/language";
import type { FileProductionJob } from "$lib/types";
import {
	atlasImageCandidateEvidenceText,
	atlasImageMeaningfulTokens,
	isUsableAtlasImageCandidate,
} from "./image-quality";
import type {
	AtlasClaimBasis,
	AtlasDocumentFamilyMetadata,
	AtlasHonestyMarker,
	AtlasImageCandidate,
} from "./types";

export interface AtlasReportSource {
	title: string;
	url?: string | null;
	authority?: string | null;
	reasoning?: string | null;
	relevanceNote?: string | null;
}

export interface BuildAtlasDocumentSourceInput {
	title: string;
	subtitle?: string | null;
	family?: AtlasDocumentFamilyMetadata | null;
	assembledMarkdown: string;
	sources: AtlasReportSource[];
	honestyMarkers: AtlasHonestyMarker[];
	claimBasis?: AtlasClaimBasis[];
	imageCandidates?: AtlasImageCandidate[];
	maxRenderedImages?: number;
	date?: string | null;
	language?: SupportedLanguage | null;
}

export interface AtlasOutputIds {
	fileProductionJobId: string | null;
	htmlChatGeneratedFileId: string | null;
	pdfChatGeneratedFileId: string | null;
	markdownChatGeneratedFileId: string | null;
}

export interface RenderAtlasOutputsInput {
	userId: string;
	conversationId: string;
	assistantMessageId: string | null;
	jobId: string;
	source: GeneratedDocumentSource;
	createOutputJob?: (input: {
		userId: string;
		conversationId: string;
		body: unknown;
	}) => Promise<AtlasOutputIds>;
}

const ATLAS_OUTPUT_JOB_POLL_INTERVAL_MS = 250;
const ATLAS_OUTPUT_JOB_POLL_TIMEOUT_MS = 30_000;
export const ATLAS_SOURCE_RELEVANCE_NOTE_MAX_LENGTH = 220;

function addSourceSection(
	blocks: GeneratedDocumentSource["blocks"],
	title: string,
	sources: AtlasReportSource[],
	language: SupportedLanguage,
) {
	if (sources.length === 0) return;
	blocks.push({
		type: "sourceChips",
		title,
		sources: sources.map((source) =>
			sourceChipForAtlasSource(source, language),
		),
	});
}

function sourceChipForAtlasSource(
	source: AtlasReportSource,
	language: SupportedLanguage,
): GeneratedDocumentSourceChip {
	const isWeb = Boolean(source.url);
	const provided = source.authority === "explicit";
	const chrome = atlasChrome({ language });
	return {
		title: source.title,
		url: source.url ?? null,
		kind: isWeb ? "web" : "library",
		provided,
		reasoning: compactAtlasSourceRelevanceNote({
			note: source.relevanceNote ?? source.reasoning,
			fallback: provided
				? chrome.providedSourcesReasoning
				: isWeb
					? chrome.webSourcesReasoning
					: chrome.librarySourcesReasoning,
		}),
	};
}

function atlasChrome(input: { language: SupportedLanguage }): {
	keyTakeaway: string;
	sources: string;
	webSources: string;
	librarySources: string;
	providedSourcesReasoning: string;
	webSourcesReasoning: string;
	librarySourcesReasoning: string;
	reportDate: string;
} {
	if (input.language === "hu") {
		return {
			keyTakeaway: "Kulcsüzenet",
			sources: "Források",
			webSources: "Webes források",
			librarySources: "Saját könyvtár",
			providedSourcesReasoning: "A felhasználó adta meg",
			webSourcesReasoning: "Az Atlas által elfogadott webes bizonyíték",
			librarySourcesReasoning:
				"Az Atlas által kiválasztott könyvtári bizonyíték",
			reportDate: "Jelentés dátuma",
		};
	}
	return {
		keyTakeaway: "Key takeaway",
		sources: "Sources",
		webSources: "Web Sources",
		librarySources: "Your Library",
		providedSourcesReasoning: "You provided these",
		webSourcesReasoning: "Accepted web evidence gathered by Atlas",
		librarySourcesReasoning: "Accepted library evidence selected by Atlas",
		reportDate: "Report date",
	};
}

function cleanText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : null;
}

function withoutRawExcerptTail(text: string): string {
	const rawLabelMatch = text.match(
		/\b(?:Fetched page excerpt|Accepted source excerpt)\s*:/i,
	);
	if (!rawLabelMatch || typeof rawLabelMatch.index !== "number") return text;
	if (rawLabelMatch.index === 0) return "";
	const beforeRawLabel = text.slice(0, rawLabelMatch.index).trim();
	return beforeRawLabel.length >= 24 ? beforeRawLabel : "";
}

function removeSourceDumpLabels(text: string): string {
	return text
		.replace(/\bSearch result snippet\s*:\s*/gi, "")
		.replace(/\bFetched page excerpt\s*:\s*/gi, "")
		.replace(/\bAccepted source excerpt\s*:\s*/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function usefulSourceNoteSentences(text: string): string[] {
	const sentences = text
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const candidates = sentences.length > 0 ? sentences : [text.trim()];
	const filtered = candidates.filter(
		(sentence) =>
			!/\b(?:cookie|subscribe|sign in|privacy policy|advertisement|loading|navigation menu|copied from the fetched page)\b/i.test(
				sentence,
			),
	);
	return (filtered.length > 0 ? filtered : candidates).slice(0, 2);
}

function truncateSourceNote(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const clipped = text.slice(0, maxLength + 1);
	const lastSentence = clipped.search(/[.!?](?=\s|$)[^.!?]*$/);
	if (lastSentence >= 80) return text.slice(0, lastSentence + 1).trim();
	const lastSpace = clipped.lastIndexOf(" ");
	const end = Math.max(lastSpace, Math.min(maxLength, 80));
	return `${clipped.slice(0, end).trim()}...`;
}

export function compactAtlasSourceRelevanceNote(input: {
	note?: string | null;
	fallback: string;
	maxLength?: number;
}): string {
	const fallback =
		cleanText(input.fallback) ?? "Accepted evidence gathered by Atlas";
	const normalized = cleanText(input.note) ?? fallback;
	const cleaned = removeSourceDumpLabels(withoutRawExcerptTail(normalized));
	const sentences = usefulSourceNoteSentences(cleaned).join(" ");
	const compact = cleanText(sentences) ?? fallback;
	return truncateSourceNote(
		compact,
		input.maxLength ?? ATLAS_SOURCE_RELEVANCE_NOTE_MAX_LENGTH,
	);
}

function cleanCodeText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trimEnd();
	return trimmed.trim().length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function inlineTextFromToken(token: unknown): string {
	if (!isRecord(token)) return "";
	if (Array.isArray(token.tokens)) {
		return inlineTextFromTokens(token.tokens);
	}
	if (token.type === "br") return " ";
	return typeof token.text === "string" ? token.text : "";
}

function inlineTextFromTokens(tokens: unknown[]): string {
	return tokens.map((token) => inlineTextFromToken(token)).join("");
}

function blockText(token: unknown): string | null {
	if (!isRecord(token)) return null;
	if (Array.isArray(token.tokens)) {
		return cleanText(inlineTextFromTokens(token.tokens));
	}
	return cleanText(token.text);
}

function tokenText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function markdownImageFromToken(
	token: unknown,
): GeneratedDocumentImageBlock | null {
	if (!isRecord(token) || token.type !== "image") return null;
	const href = tokenText(token.href);
	if (!href?.startsWith("https://")) return null;
	const altText = tokenText(token.text) ?? tokenText(token.title) ?? "Image";
	const caption = tokenText(token.title) ?? altText;
	let attributionTitle = caption;
	try {
		attributionTitle = caption || new URL(href).hostname;
	} catch {
		// Keep the caption fallback when URL parsing fails.
	}
	return {
		type: "image",
		source: { kind: "https", url: href },
		altText,
		caption,
		sourceAttribution: {
			title: attributionTitle,
			url: href,
		},
		critical: false,
	};
}

function imagesFromParagraphToken(
	token: unknown,
): GeneratedDocumentImageBlock[] {
	if (!isRecord(token) || !Array.isArray(token.tokens)) return [];
	return token.tokens
		.map((inlineToken) => markdownImageFromToken(inlineToken))
		.filter((block): block is GeneratedDocumentImageBlock => Boolean(block));
}

function makeColumnKey(
	label: string,
	index: number,
	usedKeys: Set<string>,
): string {
	const base =
		label
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || `col_${index + 1}`;
	let key = base;
	let suffix = 2;
	while (usedKeys.has(key)) {
		key = `${base}_${suffix}`;
		suffix += 1;
	}
	usedKeys.add(key);
	return key;
}

function appendMarkdownBlocks(
	blocks: GeneratedDocumentSource["blocks"],
	markdown: string,
) {
	const tokens = marked.lexer(markdown, { gfm: true });
	for (const token of tokens) {
		if (token.type === "space") continue;

		if (token.type === "heading") {
			const text = blockText(token);
			if (!text) continue;
			blocks.push({
				type: "heading",
				level: token.depth >= 3 ? 3 : 2,
				text,
			});
			continue;
		}

		if (token.type === "paragraph" || token.type === "text") {
			const images = imagesFromParagraphToken(token);
			if (images.length > 0) {
				blocks.push(...images);
				const imageText = images.map((image) => image.altText).join(" ");
				const text = blockText(token);
				if (text && text !== imageText)
					blocks.push({ type: "paragraph", text });
				continue;
			}
			const text = blockText(token);
			if (text) blocks.push({ type: "paragraph", text });
			continue;
		}

		if (token.type === "list") {
			const listToken = token as {
				ordered?: boolean;
				items?: unknown[];
			};
			const items = (Array.isArray(listToken.items) ? listToken.items : [])
				.map((item) => blockText(item))
				.filter((item): item is string => Boolean(item));
			if (items.length > 0) {
				blocks.push({
					type: "list",
					style: listToken.ordered ? "numbered" : "bullet",
					items,
				});
			}
			continue;
		}

		if (token.type === "code") {
			const text = cleanCodeText(token.text);
			if (text) {
				blocks.push({
					type: "code",
					language: cleanText(token.lang)?.split(/\s+/)[0] ?? null,
					text,
				});
			}
			continue;
		}

		if (token.type === "blockquote") {
			const text = blockText(token);
			if (text) blocks.push({ type: "quote", text, citation: null });
			continue;
		}

		if (token.type === "table") {
			const tableToken = token as {
				header?: unknown[];
				rows?: unknown[][];
			};
			const usedKeys = new Set<string>();
			const columns = (
				Array.isArray(tableToken.header) ? tableToken.header : []
			)
				.map((cell, index) => {
					const label = blockText(cell);
					return label
						? {
								key: makeColumnKey(label, index, usedKeys),
								label,
								kind: "text" as const,
							}
						: null;
				})
				.filter((column): column is NonNullable<typeof column> =>
					Boolean(column),
				);
			const rows = (Array.isArray(tableToken.rows) ? tableToken.rows : [])
				.map((row) => {
					const record: Record<string, string | null> = {};
					for (const [index, column] of columns.entries()) {
						record[column.key] = blockText(row[index] ?? {}) ?? null;
					}
					return record;
				})
				.filter((row) => Object.values(row).some((value) => value !== null));
			if (columns.length > 0 && rows.length > 0) {
				const tableBlock: GeneratedDocumentTableBlock = {
					type: "table",
					columns,
					rows,
				};
				blocks.push(tableBlock);
				const chart = chartFromTable(tableBlock);
				if (chart) blocks.push(chart);
			}
			continue;
		}

		if (token.type === "hr") {
			blocks.push({ type: "divider" });
		}
	}
}

function valueAsNumber(value: GeneratedDocumentScalar): {
	value: number;
	units: string;
} | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { value, units: "value" };
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const percent = /%$/.test(trimmed);
	const numeric = Number(
		trimmed
			.replace(/[$€£,]/g, "")
			.replace(/%$/, "")
			.trim(),
	);
	if (!Number.isFinite(numeric)) return null;
	return { value: numeric, units: percent ? "%" : "value" };
}

function titleCase(text: string): string {
	return text
		.split(/\s+/)
		.map((part) =>
			part
				? `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`
				: part,
		)
		.join(" ");
}

function chartFromTable(
	table: GeneratedDocumentTableBlock,
): GeneratedDocumentChartBlock | null {
	if (table.rows.length < 2 || table.columns.length < 2) return null;
	const labelColumn = table.columns.find((column) =>
		table.rows.some((row) => typeof row[column.key] === "string"),
	);
	if (!labelColumn) return null;

	for (const valueColumn of table.columns) {
		if (valueColumn.key === labelColumn.key) continue;
		const data: Record<string, GeneratedDocumentScalar>[] = [];
		let units: string | null = null;
		for (const row of table.rows) {
			const label = row[labelColumn.key];
			const numeric = valueAsNumber(row[valueColumn.key]);
			if (typeof label !== "string" || !numeric) {
				data.length = 0;
				break;
			}
			units = units ?? numeric.units;
			data.push({
				[labelColumn.key]: label,
				[valueColumn.key]: numeric.value,
			});
		}
		if (data.length < 2) continue;
		const title = `${titleCase(valueColumn.label)} by ${titleCase(
			labelColumn.label,
		)}`;
		return {
			type: "chart",
			chartType: "bar",
			title,
			caption: `Chart derived from the report table: ${title}.`,
			altText: `Bar chart comparing ${valueColumn.label} by ${labelColumn.label}.`,
			xKey: labelColumn.key,
			yKey: valueColumn.key,
			labelKey: null,
			valueKey: null,
			seriesKey: null,
			radiusKey: null,
			units: units ?? "value",
			data,
		};
	}

	return null;
}

function takeawayHeadingPattern(language: SupportedLanguage): RegExp {
	return language === "hu"
		? /^(kulcsüzenet|fő tanulság|legfontosabb tanulság)$/i
		: /^(key takeaway|takeaway)$/i;
}

function isTakeawayHeading(
	block: GeneratedDocumentBlock,
	language: SupportedLanguage,
): block is Extract<GeneratedDocumentBlock, { type: "heading" }> {
	return (
		block.type === "heading" &&
		takeawayHeadingPattern(language).test(block.text)
	);
}

function compactExcerpt(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	const maxLength = 360;
	if (normalized.length <= maxLength) return normalized;
	const sentenceEnd = normalized
		.slice(0, maxLength)
		.search(/[.!?](?=\s|$)[^.!?]*$/);
	if (sentenceEnd >= 120) return normalized.slice(0, sentenceEnd + 1).trim();
	const clipped = normalized.slice(0, maxLength + 1);
	const lastSpace = clipped.lastIndexOf(" ");
	return `${clipped.slice(0, Math.max(lastSpace, 120)).trim()}...`;
}

function compactTakeawayText(
	block: GeneratedDocumentBlock | undefined,
): { text: string; consumedBlocks: number } | null {
	if (!block) return null;
	if (block.type === "paragraph" || block.type === "quote") {
		return { text: compactExcerpt(block.text), consumedBlocks: 1 };
	}
	if (block.type === "list") {
		const text = block.items.slice(0, 2).join(" ");
		return text ? { text: compactExcerpt(text), consumedBlocks: 1 } : null;
	}
	return null;
}

function convertAuthoredTakeawaysToCallouts(
	blocks: GeneratedDocumentSource["blocks"],
	language: SupportedLanguage,
): void {
	const converted: GeneratedDocumentSource["blocks"] = [];
	const headingPattern = takeawayHeadingPattern(language);
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		if (block.type === "callout" && block.title) {
			converted.push(
				headingPattern.test(block.title)
					? {
							...block,
							tone: "tip",
							title: atlasChrome({ language }).keyTakeaway,
						}
					: block,
			);
			continue;
		}
		if (!isTakeawayHeading(block, language)) {
			converted.push(block);
			continue;
		}
		const takeaway = compactTakeawayText(blocks[index + 1]);
		if (!takeaway) continue;
		converted.push({
			type: "callout",
			tone: "tip",
			title: atlasChrome({ language }).keyTakeaway,
			text: takeaway.text,
		});
		index += takeaway.consumedBlocks;
	}
	blocks.splice(0, blocks.length, ...converted);
}

function normalizedHeading(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[`*_~]+/g, "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.:;]+$/g, "");
}

function isExecutiveSummaryHeading(
	block: GeneratedDocumentBlock,
	language: SupportedLanguage,
): boolean {
	if (block.type !== "heading") return false;
	const normalized = normalizedHeading(block.text);
	if (language === "hu") {
		return (
			normalized === "vezetoi osszefoglalo" || normalized === "osszefoglalo"
		);
	}
	return normalized === "executive summary" || normalized === "summary";
}

function textBlockText(block: GeneratedDocumentBlock): string | null {
	if (block.type === "heading") return block.text;
	if (block.type === "paragraph" || block.type === "quote") return block.text;
	if (block.type === "callout")
		return `${block.title ?? ""} ${block.text}`.trim();
	return null;
}

function sameNormalizedTitle(left: string, right: string): boolean {
	return normalizedHeading(left) === normalizedHeading(right);
}

function isShortSubtitleLikeBlock(block: GeneratedDocumentBlock): boolean {
	const text = textBlockText(block);
	if (!text) return false;
	return text.length <= 180 && !/[.!?]\s+\S/.test(text);
}

function removeOpeningTitleBlockCluster(
	blocks: GeneratedDocumentSource["blocks"],
	title: string,
	language: SupportedLanguage,
): void {
	const executiveSummaryIndex = blocks.findIndex((block) =>
		isExecutiveSummaryHeading(block, language),
	);
	if (executiveSummaryIndex > 0) {
		const openingBlocks = blocks.slice(0, executiveSummaryIndex);
		const startsWithTitleLikeHeading =
			openingBlocks[0]?.type === "heading" && openingBlocks[0].level <= 2;
		const repeatsTitle = openingBlocks.some((block) => {
			const text = textBlockText(block);
			return text ? sameNormalizedTitle(text, title) : false;
		});
		if (startsWithTitleLikeHeading || repeatsTitle) {
			blocks.splice(0, executiveSummaryIndex);
		}
		return;
	}

	const firstBlock = blocks[0];
	if (
		firstBlock?.type !== "heading" ||
		firstBlock.level > 2 ||
		!sameNormalizedTitle(firstBlock.text, title)
	) {
		return;
	}

	let removeCount = 1;
	while (
		removeCount < blocks.length &&
		blocks[removeCount]?.type !== "heading" &&
		isShortSubtitleLikeBlock(blocks[removeCount])
	) {
		removeCount += 1;
	}
	blocks.splice(0, removeCount);
}

const SOURCE_APPENDIX_LABELS = new Set([
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

function sourceAppendixLabel(text: string): string | null {
	const normalized = text
		.replace(/^(appendix|fuggelek)\s*[:.-]\s*/, "")
		.replace(/[.:;]+$/g, "")
		.trim();
	return SOURCE_APPENDIX_LABELS.has(normalized) ? normalized : null;
}

function isSourcesHeading(text: string): boolean {
	return sourceAppendixLabel(normalizedHeading(text)) !== null;
}

function isSourceAppendixIntroBlock(block: GeneratedDocumentBlock): boolean {
	const text = textBlockText(block);
	if (!text || text.length > 140) return false;
	return sourceAppendixLabel(normalizedHeading(text)) !== null;
}

function sourceListItemLooksLikeSource(text: string): boolean {
	const normalized = normalizedHeading(text);
	return (
		/https?:\/\/|www\./i.test(text) ||
		/\b[a-z0-9-]+\.(com|org|net|io|edu|gov|hu|eu|co|ai)\b/i.test(text) ||
		/^(source|forras|reference|citation|cited source)\b/.test(normalized)
	);
}

function listLooksLikeSourceAppendix(
	block: GeneratedDocumentBlock,
	requireEveryItem = false,
): boolean {
	if (block.type !== "list" || block.items.length === 0) return false;
	const sourceLikeCount = block.items.filter(
		sourceListItemLooksLikeSource,
	).length;
	return requireEveryItem
		? sourceLikeCount === block.items.length
		: sourceLikeCount > 0;
}

function terminalSourceAppendixContent(
	blocks: GeneratedDocumentSource["blocks"],
): boolean {
	return blocks.some((block) => listLooksLikeSourceAppendix(block));
}

function tailHasNoHeading(blocks: GeneratedDocumentSource["blocks"]): boolean {
	return blocks.every((block) => block.type !== "heading");
}

function terminalTailAfterSourceIntro(
	blocks: GeneratedDocumentSource["blocks"],
	index: number,
): boolean {
	const tail = blocks.slice(index + 1);
	return (
		tail.length > 0 &&
		tailHasNoHeading(tail) &&
		terminalSourceAppendixContent(tail)
	);
}

function isStrictSourceAppendixTailBlock(
	block: GeneratedDocumentBlock,
): boolean {
	return (
		listLooksLikeSourceAppendix(block, true) ||
		(block.type === "paragraph" && sourceListItemLooksLikeSource(block.text)) ||
		block.type === "divider"
	);
}

function terminalTailIsStrictSourceAppendix(
	blocks: GeneratedDocumentSource["blocks"],
	index: number,
): boolean {
	const tail = blocks.slice(index);
	return tailHasNoHeading(tail) && tail.every(isStrictSourceAppendixTailBlock);
}

function removeTerminalModelAuthoredSourceAppendix(
	blocks: GeneratedDocumentSource["blocks"],
): void {
	const introIndex = blocks.findIndex(
		(block, index) =>
			isSourceAppendixIntroBlock(block) &&
			terminalTailAfterSourceIntro(blocks, index),
	);
	if (introIndex >= 0) {
		blocks.splice(introIndex);
		return;
	}

	const listIndex = blocks.findIndex(
		(block, index) =>
			listLooksLikeSourceAppendix(block, true) &&
			terminalTailIsStrictSourceAppendix(blocks, index),
	);
	if (listIndex >= 0) {
		blocks.splice(listIndex);
	}
}

function removeModelAuthoredSourcesSections(
	blocks: GeneratedDocumentSource["blocks"],
): void {
	const retained: GeneratedDocumentSource["blocks"] = [];
	let skippingSourceSectionLevel: 1 | 2 | 3 | null = null;

	for (const block of blocks) {
		if (block.type === "heading") {
			if (
				skippingSourceSectionLevel !== null &&
				block.level <= skippingSourceSectionLevel
			) {
				skippingSourceSectionLevel = null;
			}
			if (isSourcesHeading(block.text)) {
				skippingSourceSectionLevel = block.level;
				continue;
			}
		}

		if (skippingSourceSectionLevel !== null) continue;
		retained.push(block);
	}

	blocks.splice(0, blocks.length, ...retained);
	removeTerminalModelAuthoredSourceAppendix(blocks);
}

function paragraphHasExplicitSourceCitation(text: string): boolean {
	return /\[\d{1,3}\]/.test(text);
}

function paragraphIsSubstantive(text: string): boolean {
	return text.replace(/\s+/g, " ").trim().length >= 80;
}

function addInlineSourceFallbacks(
	blocks: GeneratedDocumentSource["blocks"],
	sources: AtlasReportSource[],
	language: SupportedLanguage,
): void {
	if (sources.length === 0) return;
	const alreadyHasInlineCitations = blocks.some(
		(block) =>
			block.type === "paragraph" &&
			(paragraphHasExplicitSourceCitation(block.text) ||
				(block.sources?.length ?? 0) > 0),
	);
	if (alreadyHasInlineCitations) return;

	const eligibleParagraphIndexes: number[] = [];
	let insideSourcesSection = false;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "heading" && block.level <= 2) {
			insideSourcesSection = isSourcesHeading(block.text);
			continue;
		}
		if (
			!insideSourcesSection &&
			block.type === "paragraph" &&
			paragraphIsSubstantive(block.text)
		) {
			eligibleParagraphIndexes.push(index);
		}
	}
	if (eligibleParagraphIndexes.length === 0) return;

	const sourceChips = sources.map((source) =>
		sourceChipForAtlasSource(source, language),
	);
	for (const [sourceIndex, blockIndex] of eligibleParagraphIndexes.entries()) {
		const source = sourceChips[sourceIndex];
		if (!source) break;
		const block = blocks[blockIndex];
		if (block?.type !== "paragraph") continue;
		blocks[blockIndex] = { ...block, sources: [source] };
	}
}

function cleanBasisKey(value: string | null | undefined): string | null {
	const text = cleanText(value);
	if (!text) return null;
	const key = text.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
	return key || null;
}

function basisMarkerForClaim(
	basis: AtlasClaimBasis,
	index: number,
): GeneratedDocumentBasisMarkerBlock {
	const id = cleanBasisKey(basis.id) ?? `atlas_basis_${index + 1}`;
	const auditCode = cleanBasisKey(basis.auditConcernCode);
	return {
		type: "basisMarker",
		id,
		support: basis.supportLevel,
		rationale: cleanText(basis.supportRationale) ?? basis.supportRationale,
		...(auditCode ? { auditCode } : {}),
	};
}

function paragraphMarkerForClaim(input: {
	basis: AtlasClaimBasis;
	index: number;
	anchorText: string;
	occurrence: number;
}): GeneratedDocumentParagraphBasisMarker {
	return {
		...basisMarkerForClaim(input.basis, input.index),
		anchorText: input.anchorText,
		occurrence: input.occurrence,
	};
}

function sectionMatchesLocator(
	currentSection: string | null,
	locatorSection: string | null,
): boolean {
	if (!locatorSection) return true;
	if (!currentSection) return false;
	return (
		canonicalBasisSectionHeading(currentSection) ===
		canonicalBasisSectionHeading(locatorSection)
	);
}

function canonicalBasisSectionHeading(text: string): string {
	return normalizedHeading(text)
		.replace(/^(?:key|model|operational|deployment|source grounded)\s+/, "")
		.replace(/\s+(?:analysis|section)$/i, "")
		.trim();
}

function occurrenceForAnchor(
	text: string,
	anchorText: string,
	start: number,
): number {
	let occurrence = 0;
	let cursor = 0;
	while (cursor < start) {
		const found = text.indexOf(anchorText, cursor);
		if (found < 0 || found >= start) break;
		occurrence += 1;
		cursor = found + anchorText.length;
	}
	return occurrence;
}

function findClaimAnchor(
	text: string,
	basis: AtlasClaimBasis,
): { anchorText: string; occurrence: number } | null {
	const candidates = [basis.locator.quote, basis.locator.claimText]
		.map(cleanText)
		.filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		const found = text.indexOf(candidate);
		if (found >= 0) {
			return {
				anchorText: candidate,
				occurrence: occurrenceForAnchor(text, candidate, found),
			};
		}
	}
	return null;
}

function paragraphContexts(blocks: GeneratedDocumentSource["blocks"]): Array<{
	blockIndex: number;
	paragraphIndexInSection: number;
	sectionTitle: string | null;
	block: Extract<GeneratedDocumentBlock, { type: "paragraph" }>;
}> {
	const contexts: Array<{
		blockIndex: number;
		paragraphIndexInSection: number;
		sectionTitle: string | null;
		block: Extract<GeneratedDocumentBlock, { type: "paragraph" }>;
	}> = [];
	let sectionTitle: string | null = null;
	let paragraphIndexInSection = 0;
	for (const [blockIndex, block] of blocks.entries()) {
		if (block.type === "heading" && block.level <= 2) {
			sectionTitle = block.text;
			paragraphIndexInSection = 0;
			continue;
		}
		if (block.type !== "paragraph") continue;
		contexts.push({
			blockIndex,
			paragraphIndexInSection,
			sectionTitle,
			block,
		});
		paragraphIndexInSection += 1;
	}
	return contexts;
}

function fallbackIndexForClaimBasis(
	blocks: GeneratedDocumentSource["blocks"],
	basis: AtlasClaimBasis,
	contexts: ReturnType<typeof paragraphContexts>,
): number {
	const paragraphContext = contexts.find(
		(context) =>
			sectionMatchesLocator(context.sectionTitle, basis.locator.sectionTitle) &&
			(basis.locator.paragraphIndex === null ||
				context.paragraphIndexInSection === basis.locator.paragraphIndex),
	);
	if (paragraphContext) return paragraphContext.blockIndex + 1;
	if (basis.locator.sectionTitle) {
		const headingIndex = blocks.findIndex(
			(block) =>
				block.type === "heading" &&
				normalizedHeading(block.text) ===
					normalizedHeading(basis.locator.sectionTitle ?? ""),
		);
		if (headingIndex >= 0) return headingIndex + 1;
	}
	return executiveSummaryFallbackIndex(blocks);
}

function nearestParagraphIndexForClaimBasisFallback(
	blocks: GeneratedDocumentSource["blocks"],
	insertionIndex: number,
): number | null {
	for (
		let index = Math.min(insertionIndex - 1, blocks.length - 1);
		index >= 0;
		index -= 1
	) {
		if (blocks[index]?.type === "paragraph") return index;
		if (blocks[index]?.type === "heading" && index < insertionIndex - 1) break;
	}
	for (let index = insertionIndex; index < blocks.length; index += 1) {
		if (blocks[index]?.type === "paragraph") return index;
		if (blocks[index]?.type === "heading" && index > insertionIndex) break;
	}
	return null;
}

function basisMarkerDedupeKey(
	marker: GeneratedDocumentParagraphBasisMarker,
): string {
	return [
		marker.support,
		normalizedHeading(marker.rationale),
		normalizedHeading(marker.anchorText).slice(0, 160),
		marker.auditCode ?? "",
	].join("|");
}

function paragraphWithBasisMarker(
	block: Extract<GeneratedDocumentBlock, { type: "paragraph" }>,
	marker: GeneratedDocumentParagraphBasisMarker,
): Extract<GeneratedDocumentBlock, { type: "paragraph" }> {
	const existing = block.basisMarkers ?? [];
	const markerKey = basisMarkerDedupeKey(marker);
	if (
		existing.some(
			(existingMarker) => basisMarkerDedupeKey(existingMarker) === markerKey,
		)
	) {
		return block;
	}
	return {
		...block,
		basisMarkers: [...existing, marker],
	};
}

function applyAtlasClaimBasisMarkers(
	blocks: GeneratedDocumentSource["blocks"],
	claimBasis: AtlasClaimBasis[] = [],
): void {
	if (claimBasis.length === 0) return;
	const contexts = paragraphContexts(blocks);
	const standaloneInsertions = new Map<
		number,
		GeneratedDocumentBasisMarkerBlock[]
	>();

	for (const [basisIndex, basis] of claimBasis.entries()) {
		const candidates = contexts.filter(
			(context) =>
				sectionMatchesLocator(
					context.sectionTitle,
					basis.locator.sectionTitle,
				) &&
				(basis.locator.paragraphIndex === null ||
					context.paragraphIndexInSection === basis.locator.paragraphIndex),
		);
		let anchored = false;
		for (const context of candidates) {
			const anchor = findClaimAnchor(context.block.text, basis);
			if (!anchor) continue;
			const marker = paragraphMarkerForClaim({
				basis,
				index: basisIndex,
				anchorText: anchor.anchorText,
				occurrence: anchor.occurrence,
			});
			const currentBlock = blocks[context.blockIndex];
			if (currentBlock?.type === "paragraph") {
				blocks[context.blockIndex] = paragraphWithBasisMarker(
					currentBlock,
					marker,
				);
			}
			anchored = true;
			break;
		}
		if (anchored) continue;

		const fallbackContext = candidates[0];
		if (fallbackContext) {
			const marker = paragraphMarkerForClaim({
				basis,
				index: basisIndex,
				anchorText: fallbackContext.block.text,
				occurrence: 0,
			});
			const currentBlock = blocks[fallbackContext.blockIndex];
			if (currentBlock?.type === "paragraph") {
				blocks[fallbackContext.blockIndex] = paragraphWithBasisMarker(
					currentBlock,
					marker,
				);
			}
			continue;
		}

		const insertionIndex = fallbackIndexForClaimBasis(blocks, basis, contexts);
		const nearestParagraphIndex = nearestParagraphIndexForClaimBasisFallback(
			blocks,
			insertionIndex,
		);
		if (nearestParagraphIndex !== null) {
			const paragraph = blocks[nearestParagraphIndex];
			if (paragraph?.type === "paragraph") {
				const marker = paragraphMarkerForClaim({
					basis,
					index: basisIndex,
					anchorText: paragraph.text,
					occurrence: 0,
				});
				blocks[nearestParagraphIndex] = paragraphWithBasisMarker(
					paragraph,
					marker,
				);
				continue;
			}
		}
		const existing = standaloneInsertions.get(insertionIndex) ?? [];
		existing.push(basisMarkerForClaim(basis, basisIndex));
		standaloneInsertions.set(insertionIndex, existing);
	}

	if (standaloneInsertions.size === 0) return;
	const converted: GeneratedDocumentSource["blocks"] = [];
	for (let index = 0; index <= blocks.length; index += 1) {
		const atIndex = standaloneInsertions.get(index);
		if (atIndex) converted.push(...atIndex);
		const block = blocks[index];
		if (block) converted.push(block);
	}
	blocks.splice(0, blocks.length, ...converted);
}

function imageUrlsInBlocks(
	blocks: GeneratedDocumentSource["blocks"],
): Set<string> {
	const urls = new Set<string>();
	for (const block of blocks) {
		if (
			block.type === "image" &&
			block.source.kind === "https" &&
			block.source.url
		) {
			urls.add(block.source.url);
		}
	}
	return urls;
}

function blockSearchText(block: GeneratedDocumentBlock): string {
	if (block.type === "heading" || block.type === "paragraph") return block.text;
	if (block.type === "list") return block.items.join(" ");
	if (block.type === "callout") return `${block.title ?? ""} ${block.text}`;
	return "";
}

function blockMatchScore(
	block: GeneratedDocumentBlock,
	tokens: Set<string>,
): number {
	if (tokens.size === 0) return 0;
	const haystack = atlasImageMeaningfulTokens(blockSearchText(block));
	let score = 0;
	for (const token of tokens) {
		for (const candidate of haystack) {
			if (
				candidate === token ||
				candidate.includes(token) ||
				token.includes(candidate)
			) {
				score += 1;
				break;
			}
		}
	}
	return score;
}

function imageBlockForCandidate(
	candidate: AtlasImageCandidate,
): GeneratedDocumentImageBlock {
	const attributionUrl = candidate.sourcePageUrl ?? candidate.imageUrl;
	return {
		type: "image",
		source: { kind: "https", url: candidate.imageUrl },
		altText: candidate.title,
		caption: candidate.caption || candidate.title,
		sourceAttribution: {
			title: candidate.sourceTitle ?? candidate.title,
			url: attributionUrl,
		},
		critical: false,
	};
}

function canonicalAtlasImagePageKey(
	candidate: AtlasImageCandidate,
): string | null {
	const value = candidate.sourcePageUrl ?? candidate.imageUrl;
	if (!value) return null;
	try {
		const parsed = new URL(value);
		parsed.hash = "";
		parsed.searchParams.sort();
		return parsed.toString().replace(/\/+$/, "").toLowerCase();
	} catch {
		return value.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
	}
}

function normalizedAtlasImageVisualKey(candidate: AtlasImageCandidate): string {
	const tokens = Array.from(
		atlasImageMeaningfulTokens(`${candidate.title} ${candidate.caption}`),
	).sort();
	return tokens.join(" ");
}

function atlasImageVisualKeysOverlap(left: string, right: string): boolean {
	if (!left || !right) return false;
	if (left === right) return true;
	const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
	const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
	if (leftTokens.size === 0 || rightTokens.size === 0) return false;
	let overlap = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) overlap += 1;
	}
	return overlap >= Math.min(4, leftTokens.size, rightTokens.size);
}

function executiveSummaryFallbackIndex(
	blocks: GeneratedDocumentSource["blocks"],
): number {
	const headingIndex = blocks.findIndex(
		(block) =>
			block.type === "heading" &&
			/^(executive summary|vezetői összefoglaló|összefoglaló)$/i.test(
				block.text.trim(),
			),
	);
	if (headingIndex < 0) return Math.min(1, blocks.length);
	for (let index = headingIndex + 1; index < blocks.length; index += 1) {
		const block = blocks[index];
		if (block?.type === "heading") break;
		if (
			block?.type === "paragraph" ||
			block?.type === "list" ||
			block?.type === "callout"
		) {
			return index + 1;
		}
	}
	return headingIndex + 1;
}

function insertionIndexForImageCandidate(
	blocks: GeneratedDocumentSource["blocks"],
	candidate: AtlasImageCandidate,
): number | null {
	if (!isUsableAtlasImageCandidate(candidate)) return null;
	const tokens = atlasImageMeaningfulTokens(
		`${candidate.query} ${atlasImageCandidateEvidenceText(candidate)}`,
	);
	const minimumScore = Math.min(2, tokens.size);
	const evidenceTokens = atlasImageMeaningfulTokens(
		atlasImageCandidateEvidenceText(candidate),
	);
	const minimumEvidenceScore = Math.min(2, evidenceTokens.size);
	let bestIndex = -1;
	let bestScore = 0;
	let bestEvidenceScore = 0;
	for (const [index, block] of blocks.entries()) {
		if (
			block.type === "sourceChips" ||
			block.type === "confidenceMarker" ||
			block.type === "basisMarker"
		)
			continue;
		const score = blockMatchScore(block, tokens);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = index;
		}
		bestEvidenceScore = Math.max(
			bestEvidenceScore,
			blockMatchScore(block, evidenceTokens),
		);
	}
	if (bestScore < minimumScore || bestIndex < 0) return null;
	if (minimumEvidenceScore > 0 && bestEvidenceScore < minimumEvidenceScore) {
		return null;
	}
	const block = blocks[bestIndex];
	if (block?.type !== "heading") return bestIndex + 1;
	for (let index = bestIndex + 1; index < blocks.length; index += 1) {
		const next = blocks[index];
		if (next?.type === "heading") break;
		if (
			next?.type === "paragraph" ||
			next?.type === "list" ||
			next?.type === "callout"
		) {
			return index + 1;
		}
	}
	return bestIndex + 1;
}

function filterAuthoredImageBlocksByCandidates(
	blocks: GeneratedDocumentSource["blocks"],
	imageCandidates: AtlasImageCandidate[] | undefined,
): void {
	if (imageCandidates === undefined) return;
	const allowedUrls = new Set(
		imageCandidates
			.filter(isUsableAtlasImageCandidate)
			.map((candidate) => candidate.imageUrl),
	);
	const filtered = blocks.filter((block) => {
		if (block.type !== "image") return true;
		return block.source.kind === "https" && allowedUrls.has(block.source.url);
	});
	if (filtered.length !== blocks.length) {
		blocks.splice(0, blocks.length, ...filtered);
	}
}

function insertDeterministicImageBlocks(
	blocks: GeneratedDocumentSource["blocks"],
	imageCandidates: AtlasImageCandidate[] = [],
	maxRenderedImages = 0,
): void {
	if (imageCandidates.length === 0 || maxRenderedImages <= 0) return;
	if (Array.from(imageUrlsInBlocks(blocks)).length > 0) return;
	const limit = imageDensityLimit(blocks, maxRenderedImages);
	const insertions = new Map<number, GeneratedDocumentImageBlock[]>();
	const selectedPageKeys = new Set<string>();
	const selectedVisualKeys: string[] = [];
	let selected = 0;
	for (const candidate of imageCandidates) {
		if (selected >= limit) break;
		const pageKey = canonicalAtlasImagePageKey(candidate);
		if (pageKey && selectedPageKeys.has(pageKey)) continue;
		const visualKey = normalizedAtlasImageVisualKey(candidate);
		if (
			visualKey &&
			selectedVisualKeys.some((selectedKey) =>
				atlasImageVisualKeysOverlap(selectedKey, visualKey),
			)
		) {
			continue;
		}
		const index = insertionIndexForImageCandidate(blocks, candidate);
		if (index === null) continue;
		const existing = insertions.get(index) ?? [];
		existing.push(imageBlockForCandidate(candidate));
		insertions.set(index, existing);
		if (pageKey) selectedPageKeys.add(pageKey);
		if (visualKey) selectedVisualKeys.push(visualKey);
		selected += 1;
	}
	if (selected === 0) return;
	const converted: GeneratedDocumentSource["blocks"] = [];
	for (let index = 0; index <= blocks.length; index += 1) {
		const atIndex = insertions.get(index);
		if (atIndex) converted.push(...atIndex);
		const block = blocks[index];
		if (block) converted.push(block);
	}
	blocks.splice(0, blocks.length, ...converted);
}

function imageDensityLimit(
	blocks: GeneratedDocumentSource["blocks"],
	maxRenderedImages: number,
): number {
	const sectionCount = blocks.filter(
		(block) => block.type === "heading" && block.level <= 2,
	).length;
	const densityLimit = Math.max(1, Math.floor(Math.max(sectionCount, 1) / 3));
	return Math.min(maxRenderedImages, densityLimit);
}

function capAuthoredImageBlocks(
	blocks: GeneratedDocumentSource["blocks"],
	maxRenderedImages: number | undefined,
): void {
	if (maxRenderedImages === undefined) return;
	const limit =
		maxRenderedImages <= 0 ? 0 : imageDensityLimit(blocks, maxRenderedImages);
	let kept = 0;
	const capped = blocks.filter((block) => {
		if (block.type !== "image") return true;
		if (kept >= limit) return false;
		kept += 1;
		return true;
	});
	if (capped.length !== blocks.length) {
		blocks.splice(0, blocks.length, ...capped);
	}
}

export function collectAtlasSelectedImageCandidateIds(
	source: GeneratedDocumentSource,
	imageCandidates: AtlasImageCandidate[] = [],
): string[] {
	const renderedUrls = imageUrlsInBlocks(source.blocks);
	return imageCandidates
		.filter((candidate) => renderedUrls.has(candidate.imageUrl))
		.map((candidate) => candidate.id);
}

export function buildAtlasDocumentSource(
	input: BuildAtlasDocumentSourceInput,
): GeneratedDocumentSource {
	const language =
		input.language ??
		detectLanguage(`${input.title}\n${input.assembledMarkdown}`);
	const blocks: GeneratedDocumentSource["blocks"] = [];
	appendMarkdownBlocks(blocks, input.assembledMarkdown);
	removeOpeningTitleBlockCluster(blocks, input.title, language);
	removeModelAuthoredSourcesSections(blocks);
	convertAuthoredTakeawaysToCallouts(blocks, language);
	filterAuthoredImageBlocksByCandidates(blocks, input.imageCandidates);
	capAuthoredImageBlocks(blocks, input.maxRenderedImages);
	addInlineSourceFallbacks(blocks, input.sources, language);
	insertDeterministicImageBlocks(
		blocks,
		input.imageCandidates,
		input.maxRenderedImages,
	);
	applyAtlasClaimBasisMarkers(blocks, input.claimBasis ?? []);

	const librarySources = input.sources.filter((source) => !source.url);
	const webSources = input.sources.filter((source) => Boolean(source.url));
	const chrome = atlasChrome({ language });
	if (webSources.length > 0 || librarySources.length > 0) {
		blocks.push({ type: "heading", level: 2, text: chrome.sources });
	}
	addSourceSection(blocks, chrome.webSources, webSources, language);
	addSourceSection(blocks, chrome.librarySources, librarySources, language);

	return {
		version: 1,
		template: "alfyai_standard_report",
		title: input.title,
		subtitle: input.subtitle ?? null,
		date: input.date ?? null,
		language,
		cover:
			input.family || input.date
				? {
						enabled: true,
						eyebrow: input.date
							? `${chrome.reportDate}: ${input.date}`
							: chrome.reportDate,
						dateLabel: null,
					}
				: undefined,
		blocks,
	};
}

function atlasDocumentIntent(input: {
	jobId: string;
	source: GeneratedDocumentSource;
}): string {
	return ["Atlas research report", `atlas_job_id=${input.jobId}`]
		.filter((part): part is string => part !== null)
		.join("; ");
}

type ListConversationFileProductionJobs = (
	userId: string,
	conversationId: string,
) => Promise<FileProductionJob[]>;

function isTerminalFileProductionJobStatus(
	status: FileProductionJob["status"],
): boolean {
	return (
		status === "succeeded" || status === "failed" || status === "cancelled"
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findConversationFileProductionJob(input: {
	userId: string;
	conversationId: string;
	jobId: string;
	listConversationFileProductionJobs: ListConversationFileProductionJobs;
}): Promise<FileProductionJob | null> {
	const jobs = await input.listConversationFileProductionJobs(
		input.userId,
		input.conversationId,
	);
	return jobs.find((job) => job.id === input.jobId) ?? null;
}

async function waitForAtlasOutputFileProductionJob(input: {
	userId: string;
	conversationId: string;
	jobId: string;
	listConversationFileProductionJobs: ListConversationFileProductionJobs;
}): Promise<FileProductionJob> {
	const deadline = Date.now() + ATLAS_OUTPUT_JOB_POLL_TIMEOUT_MS;
	let latestJob: FileProductionJob | null = null;

	while (Date.now() <= deadline) {
		latestJob = await findConversationFileProductionJob(input);
		if (latestJob && isTerminalFileProductionJobStatus(latestJob.status)) {
			return latestJob;
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await delay(Math.min(ATLAS_OUTPUT_JOB_POLL_INTERVAL_MS, remainingMs));
	}

	throw new Error(
		latestJob
			? `Atlas output files were not produced before the timeout; latest status was ${latestJob.status}.`
			: "Atlas output files were not produced before the timeout; the output job was not found.",
	);
}

async function createFileProductionAtlasOutputJob(input: {
	userId: string;
	conversationId: string;
	body: unknown;
}): Promise<AtlasOutputIds> {
	const {
		drainFileProductionWorker,
		listConversationFileProductionJobs,
		submitFileProductionIntake,
	} = await import("$lib/server/services/file-production");
	const result = await submitFileProductionIntake({
		...input,
		wakeWorker: () => drainFileProductionWorker(),
	});
	if (!result.ok) {
		throw new Error(result.error);
	}
	const completedJob = await waitForAtlasOutputFileProductionJob({
		userId: input.userId,
		conversationId: input.conversationId,
		jobId: result.job.id,
		listConversationFileProductionJobs,
	});
	if (completedJob.status !== "succeeded") {
		throw new Error(
			completedJob.error?.message
				? `Atlas output files were not produced: ${completedJob.error.message}`
				: "Atlas output files were not produced.",
		);
	}
	return {
		fileProductionJobId: completedJob.id,
		htmlChatGeneratedFileId:
			completedJob.files.find((file) => file.mimeType === "text/html")?.id ??
			null,
		pdfChatGeneratedFileId:
			completedJob.files.find((file) => file.mimeType === "application/pdf")
				?.id ?? null,
		markdownChatGeneratedFileId:
			completedJob.files.find((file) => file.mimeType === "text/markdown")
				?.id ?? null,
	};
}

export async function renderAtlasOutputs(
	input: RenderAtlasOutputsInput,
): Promise<AtlasOutputIds> {
	const createOutputJob =
		input.createOutputJob ?? createFileProductionAtlasOutputJob;
	return createOutputJob({
		userId: input.userId,
		conversationId: input.conversationId,
		body: {
			conversationId: input.conversationId,
			assistantMessageId: input.assistantMessageId,
			idempotencyKey: `atlas-output:v2:${input.jobId}`,
			requestTitle: input.source.title,
			sourceMode: "document_source",
			requestedOutputs: [
				{ type: "html" },
				{ type: "pdf" },
				{ type: "markdown" },
			],
			documentIntent: atlasDocumentIntent({
				jobId: input.jobId,
				source: input.source,
			}),
			templateHint: "alfyai_standard_report",
			documentSource: input.source,
		},
	});
}
