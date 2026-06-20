import { marked } from "marked";
import type {
	GeneratedDocumentBlock,
	GeneratedDocumentChartBlock,
	GeneratedDocumentImageBlock,
	GeneratedDocumentScalar,
	GeneratedDocumentSource,
	GeneratedDocumentSourceChip,
	GeneratedDocumentTableBlock,
} from "$lib/server/services/file-production/source-schema";
import {
	detectLanguage,
	type SupportedLanguage,
} from "$lib/server/services/language";
import type { AtlasDocumentFamilyMetadata, AtlasHonestyMarker } from "./types";

export interface AtlasReportSource {
	title: string;
	url?: string | null;
	authority?: string | null;
	reasoning?: string | null;
}

export interface BuildAtlasDocumentSourceInput {
	title: string;
	subtitle?: string | null;
	family?: AtlasDocumentFamilyMetadata | null;
	assembledMarkdown: string;
	sources: AtlasReportSource[];
	honestyMarkers: AtlasHonestyMarker[];
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
		reasoning:
			source.reasoning ??
			(provided
				? chrome.providedSourcesReasoning
				: isWeb
					? chrome.webSourcesReasoning
					: chrome.librarySourcesReasoning),
	};
}

function atlasChrome(input: {
	language: SupportedLanguage;
	severity?: AtlasHonestyMarker["severity"];
}): {
	keyTakeaway: string;
	sources: string;
	webSources: string;
	librarySources: string;
	honestyMarkers: string;
	providedSourcesReasoning: string;
	webSourcesReasoning: string;
	librarySourcesReasoning: string;
	reportDate: string;
	confidenceLabel?: string;
} {
	if (input.language === "hu") {
		const confidenceLabel =
			input.severity === "critical"
				? "Nem alátámasztott"
				: input.severity === "warning"
					? "Részben alátámasztott"
					: input.severity === "info"
						? "Alátámasztott"
						: undefined;
		return {
			keyTakeaway: "Kulcsüzenet",
			sources: "Források",
			webSources: "Webes források",
			librarySources: "Saját könyvtár",
			honestyMarkers: "Őszinteségi jelölések",
			providedSourcesReasoning: "A felhasználó adta meg",
			webSourcesReasoning: "Az Atlas által elfogadott webes bizonyíték",
			librarySourcesReasoning:
				"Az Atlas által kiválasztott könyvtári bizonyíték",
			reportDate: "Jelentés dátuma",
			confidenceLabel,
		};
	}
	const confidenceLabel =
		input.severity === "critical"
			? "Unsupported"
			: input.severity === "warning"
				? "Partially Supported"
				: input.severity === "info"
					? "Supported"
					: undefined;
	return {
		keyTakeaway: "Key takeaway",
		sources: "Sources",
		webSources: "Web Sources",
		librarySources: "Your Library",
		honestyMarkers: "Honesty markers",
		providedSourcesReasoning: "You provided these",
		webSourcesReasoning: "Accepted web evidence gathered by Atlas",
		librarySourcesReasoning: "Accepted library evidence selected by Atlas",
		reportDate: "Report date",
		confidenceLabel,
	};
}

function confidenceLabelForSeverity(
	severity: AtlasHonestyMarker["severity"],
	language: SupportedLanguage,
): string {
	return atlasChrome({ language, severity }).confidenceLabel ?? "Supported";
}

function confidenceLabelForMarker(
	marker: AtlasHonestyMarker,
	language: SupportedLanguage,
): string {
	if (marker.code === "atlas_audit_passed") {
		return language === "hu" ? "Audit ellenőrizve" : "Audit checked";
	}
	return confidenceLabelForSeverity(marker.severity, language);
}

function cleanText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : null;
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

function hasTakeawayBlock(
	blocks: GeneratedDocumentSource["blocks"],
	language: SupportedLanguage,
): boolean {
	const headingPattern =
		language === "hu"
			? /^(kulcsüzenet|fő tanulság|legfontosabb tanulság)$/i
			: /^key takeaway$/i;
	return blocks.some((block) => {
		if (block.type === "callout") {
			return block.title ? headingPattern.test(block.title) : false;
		}
		if (block.type === "heading") return headingPattern.test(block.text);
		return false;
	});
}

function keyTakeawayText(
	blocks: GeneratedDocumentSource["blocks"],
	language: SupportedLanguage,
): string | null {
	const summaryPattern =
		language === "hu"
			? /^(vezetői összefoglaló|összefoglaló)$/i
			: /^(executive summary|summary)$/i;
	let afterSummaryHeading = false;
	for (const block of blocks) {
		if (block.type === "heading") {
			afterSummaryHeading = summaryPattern.test(block.text);
			continue;
		}
		if (afterSummaryHeading && block.type === "paragraph") {
			return block.text;
		}
	}
	const paragraph = blocks.find(
		(block): block is Extract<GeneratedDocumentBlock, { type: "paragraph" }> =>
			block.type === "paragraph",
	);
	return paragraph?.text ?? null;
}

function addKeyTakeawayBlock(
	blocks: GeneratedDocumentSource["blocks"],
	language: SupportedLanguage,
): void {
	if (hasTakeawayBlock(blocks, language)) return;
	const text = keyTakeawayText(blocks, language);
	if (!text) return;
	blocks.unshift({
		type: "callout",
		tone: "tip",
		title: atlasChrome({ language }).keyTakeaway,
		text,
	});
}

function normalizedHeading(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase();
}

function isSourcesHeading(text: string): boolean {
	const normalized = normalizedHeading(text);
	return (
		normalized === "sources" ||
		normalized === "forrasok" ||
		normalized === "web sources" ||
		normalized === "webes forrasok" ||
		normalized === "your library" ||
		normalized === "sajat konyvtar"
	);
}

function removeModelAuthoredSourcesSections(
	blocks: GeneratedDocumentSource["blocks"],
): void {
	const retained: GeneratedDocumentSource["blocks"] = [];
	let skippingSourcesSection = false;

	for (const block of blocks) {
		if (block.type === "heading" && block.level <= 2) {
			if (isSourcesHeading(block.text)) {
				skippingSourcesSection = true;
				continue;
			}
			skippingSourcesSection = false;
		}

		if (skippingSourcesSection) continue;
		retained.push(block);
	}

	blocks.splice(0, blocks.length, ...retained);
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

function auditPassedMarker(language: SupportedLanguage): AtlasHonestyMarker {
	return {
		code: "atlas_audit_passed",
		message:
			language === "hu"
				? "Az Atlas audit nem jelölt nem alátámasztott vagy egymásnak ellentmondó állítást az elfogadott bizonyítékok alapján."
				: "Atlas audit did not flag unsupported or conflicting claims in the accepted evidence set.",
		severity: "info",
	};
}

export function buildAtlasDocumentSource(
	input: BuildAtlasDocumentSourceInput,
): GeneratedDocumentSource {
	const language =
		input.language ??
		detectLanguage(`${input.title}\n${input.assembledMarkdown}`);
	const blocks: GeneratedDocumentSource["blocks"] = [];
	appendMarkdownBlocks(blocks, input.assembledMarkdown);
	removeModelAuthoredSourcesSections(blocks);
	addKeyTakeawayBlock(blocks, language);
	addInlineSourceFallbacks(blocks, input.sources, language);

	const librarySources = input.sources.filter((source) => !source.url);
	const webSources = input.sources.filter((source) => Boolean(source.url));
	const chrome = atlasChrome({ language });
	if (webSources.length > 0 || librarySources.length > 0) {
		blocks.push({ type: "heading", level: 2, text: chrome.sources });
	}
	addSourceSection(blocks, chrome.webSources, webSources, language);
	addSourceSection(blocks, chrome.librarySources, librarySources, language);

	const honestyMarkers =
		input.honestyMarkers.length > 0
			? input.honestyMarkers
			: [auditPassedMarker(language)];
	if (honestyMarkers.length > 0) {
		blocks.push({
			type: "heading",
			level: 2,
			text: chrome.honestyMarkers,
		});
		for (const marker of honestyMarkers) {
			blocks.push({
				type: "confidenceMarker",
				code: marker.code,
				label: confidenceLabelForMarker(marker, language),
				severity: marker.severity,
				message: marker.message,
			});
		}
	}

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
	const jobs = await listConversationFileProductionJobs(
		input.userId,
		input.conversationId,
	);
	const completedJob = jobs.find((job) => job.id === result.job.id);
	if (!completedJob || completedJob.status !== "succeeded") {
		throw new Error("Atlas output files were not produced.");
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
