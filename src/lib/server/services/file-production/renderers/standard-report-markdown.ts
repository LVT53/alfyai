import type {
	GeneratedDocumentBasisMarkerBlock,
	GeneratedDocumentBlock,
	GeneratedDocumentChartBlock,
	GeneratedDocumentParagraphBasisMarker,
	GeneratedDocumentSource,
	GeneratedDocumentSourceChip,
	GeneratedDocumentTableBlock,
} from "../source-schema";
import {
	formatGeneratedDocumentBasisNote,
	GENERATED_DOCUMENT_CITATION_LEVELS,
	generatedDocumentCitationLevelGlyph,
	generatedDocumentCitationLevelLabel,
	generatedDocumentCitationPlainText,
	generatedDocumentUsesCitationAnnotations,
	isAllowedGeneratedDocumentUrl,
} from "../source-schema";

export interface StandardReportMarkdownRenderResult {
	filename: string;
	mimeType: "text/markdown";
	content: Buffer;
}

function filenameForTitle(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.toLowerCase()
		.replace(/[-\s]+/g, "-")
		.slice(0, 80);
	return `${slug || "document"}.md`;
}

function scalarToMarkdown(value: unknown): string {
	return String(value ?? "")
		.replace(/\|/g, "\\|")
		.replace(/\s+/g, " ")
		.trim();
}

/** Shared by the `sourceChips` block and paragraph-level `sources`. */
function stripHtml(text: string): string {
	return text.replace(/<[^>]*>/g, "").replace(/&[^;]+;/g, " ");
}

/**
 * The URL this renderer may turn into a link, or null.
 *
 * Defence in depth behind the schema's scheme allowlist: a source JSON stored
 * before that allowlist existed can still carry a `javascript:` URL, and this
 * Markdown is both downloaded and stored as the document's text, so a viewer
 * that renders it would make the link clickable.
 */
function linkableUrl(url: string | null | undefined): string | null {
	return url && isAllowedGeneratedDocumentUrl(url) ? url : null;
}

/** `[Title](url)`, or plain `Title` when the source has no linkable URL. */
function sourceLinkMarkdown(source: GeneratedDocumentSourceChip): string {
	const cleanTitle = stripHtml(source.title);
	const url = linkableUrl(source.url);
	return url ? `[${cleanTitle}](${url})` : cleanTitle;
}

/**
 * `stackedBar` -> `stacked bar`. No label table to keep in step with the
 * schema's `GeneratedDocumentChartType` union — every value already reads as
 * a word or two once the camelCase boundary gets a space.
 */
function chartTypeLabel(
	chartType: GeneratedDocumentChartBlock["chartType"],
): string {
	return chartType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * `*(Basis: Supported — rationale)*`, matching this renderer's existing
 * `Basis: <label>` phrasing but now carrying the rationale the HTML and PDF
 * renderers already show — the short label alone left the model, and the
 * user reading the downloaded `.md`, with a claim marked but not explained.
 */
function basisNoteMarkdown(
	marker:
		| GeneratedDocumentBasisMarkerBlock
		| GeneratedDocumentParagraphBasisMarker,
): string {
	return `*(Basis: ${formatGeneratedDocumentBasisNote(marker)})*`;
}

function renderTable(block: GeneratedDocumentTableBlock): string {
	const header = `| ${block.columns.map((column) => scalarToMarkdown(column.label)).join(" | ")} |`;
	const separator = `| ${block.columns.map(() => "---").join(" | ")} |`;
	const rows = block.rows.map(
		(row) =>
			`| ${block.columns
				.map((column) => scalarToMarkdown(row[column.key]))
				.join(" | ")} |`,
	);
	return [
		block.title ? `### ${block.title}` : null,
		block.caption ? `*${block.caption}*` : null,
		header,
		separator,
		...rows,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function renderImageSource(
	block: Extract<GeneratedDocumentBlock, { type: "image" }>,
): string | null {
	if (block.source.kind === "https") return block.source.url;
	if (block.source.kind === "data") {
		return `data:${block.source.mimeType};base64,${block.source.data}`;
	}
	return null;
}

function renderBlock(block: GeneratedDocumentBlock): string {
	switch (block.type) {
		case "heading":
			return `${"#".repeat(block.level)} ${block.text}`;
		case "paragraph": {
			const text = generatedDocumentCitationPlainText(block.text);
			const markers = block.basisMarkers ?? [];
			const sources = block.sources ?? [];
			const parts = [
				text,
				markers.length > 0 ? markers.map(basisNoteMarkdown).join(" ") : null,
				// Recorded, not endorsed: the paragraph is generated from these
				// sources but the sources themselves are not woven into the prose,
				// so they trail as a compact parenthetical rather than inline
				// citation chips (the HTML/PDF/DOCX renderers' job).
				sources.length > 0
					? `*(Sources: ${sources.map(sourceLinkMarkdown).join(", ")})*`
					: null,
			].filter((part): part is string => Boolean(part));
			return parts.join(" ");
		}
		case "list":
			return block.items
				.map((item, index) =>
					block.style === "numbered" ? `${index + 1}. ${item}` : `- ${item}`,
				)
				.join("\n");
		case "callout":
			return [
				`> ${block.title ? `**${block.title}.** ` : ""}${block.text}`,
			].join("\n");
		case "confidenceMarker":
			return `> **${block.label}.** ${block.message}`;
		case "basisMarker":
			return basisNoteMarkdown(block);
		case "code":
			return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
		case "quote":
			return `> ${block.text}${block.citation ? `\n>\n> ${block.citation}` : ""}`;
		case "divider":
			return "---";
		case "sourceChips": {
			return [
				`### ${block.title}`,
				...block.sources.map((source) => {
					const label = sourceLinkMarkdown(source);
					const cleanReasoning = source.reasoning
						? stripHtml(source.reasoning)
						: null;
					const details = [
						source.provided ? "You provided these" : null,
						cleanReasoning,
					].filter((part): part is string => Boolean(part));
					return details.length > 0
						? `- ${label} - ${details.join("; ")}`
						: `- ${label}`;
				}),
			].join("\n");
		}
		case "table":
			return renderTable(block);
		case "chart": {
			const description =
				block.altText ??
				block.caption ??
				"Chart data is available in the rendered report.";
			const pointCount = block.data.length;
			const pointLabel = `${pointCount} data point${pointCount === 1 ? "" : "s"}`;
			return `### ${block.title ?? "Chart"}\n\n${description}\n\n*(${chartTypeLabel(block.chartType)} chart, ${pointLabel})*`;
		}
		case "image": {
			const src = renderImageSource(block);
			return [
				src ? `![${block.altText}](${src})` : `**Image:** ${block.altText}`,
				block.caption ?? null,
				block.sourceAttribution
					? `Source: ${
							linkableUrl(block.sourceAttribution.url)
								? `[${block.sourceAttribution.title}](${block.sourceAttribution.url})`
								: block.sourceAttribution.title
						}`
					: null,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
		}
		case "pageBreak":
			return "";
	}
}

// Markdown stays plain text, so the legend explains the glyphs the paragraphs
// carry (`[4]ᶜ`) rather than the coloured dots the HTML and PDF reports draw.
function citationLegendMarkdown(): string {
	return GENERATED_DOCUMENT_CITATION_LEVELS.map(
		(level) =>
			`${generatedDocumentCitationLevelGlyph(level)} ${generatedDocumentCitationLevelLabel(level)}`,
	).join(" · ");
}

function renderBlocksWithCitationLegend(
	blocks: GeneratedDocumentSource["blocks"],
): string[] {
	const rendered = blocks.map(renderBlock);
	if (!generatedDocumentUsesCitationAnnotations(blocks)) return rendered;
	const legend = citationLegendMarkdown();
	const lastSourceList = blocks.reduce(
		(last, block, index) => (block.type === "sourceChips" ? index : last),
		-1,
	);
	if (lastSourceList < 0) return [...rendered, legend];
	return [
		...rendered.slice(0, lastSourceList + 1),
		legend,
		...rendered.slice(lastSourceList + 1),
	];
}

export function renderStandardReportMarkdown(
	source: GeneratedDocumentSource,
): StandardReportMarkdownRenderResult {
	const content = [
		// The cover eyebrow (the PDF/HTML/DOCX cover's small label above the
		// title, e.g. "AlfyAI Standard Report") only exists when a cover is
		// requested — a plain `.md` gets no synthetic default, unlike the PDF
		// renderer, which always draws one.
		source.cover?.eyebrow ? `*${source.cover.eyebrow}*` : null,
		`# ${source.title}`,
		source.subtitle ?? null,
		source.date ?? null,
		...renderBlocksWithCitationLegend(source.blocks),
	]
		.filter((line): line is string => Boolean(line?.trim()))
		.join("\n\n");
	return {
		filename: filenameForTitle(source.title),
		mimeType: "text/markdown",
		content: Buffer.from(`${content}\n`, "utf8"),
	};
}
