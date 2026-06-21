import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
	GeneratedDocumentTableBlock,
} from "../source-schema";
import { formatGeneratedDocumentBasisNote } from "../source-schema";

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

function renderTable(block: GeneratedDocumentTableBlock): string {
	const header = `| ${block.columns.map((column) => scalarToMarkdown(column.label)).join(" | ")} |`;
	const separator = `| ${block.columns.map(() => "---").join(" | ")} |`;
	const rows = block.rows.map(
		(row) =>
			`| ${block.columns
				.map((column) => scalarToMarkdown(row[column.key]))
				.join(" | ")} |`,
	);
	return [block.title ? `### ${block.title}` : null, header, separator, ...rows]
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
		case "paragraph":
			return [
				block.text,
				...(block.basisMarkers ?? []).map(
					(marker) => `> ${formatGeneratedDocumentBasisNote(marker)}`,
				),
			].join("\n");
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
			return `> ${formatGeneratedDocumentBasisNote(block)}`;
		case "code":
			return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
		case "quote":
			return `> ${block.text}${block.citation ? `\n>\n> ${block.citation}` : ""}`;
		case "divider":
			return "---";
		case "sourceChips": {
			const stripHtml = (text: string): string =>
				text.replace(/<[^>]*>/g, "").replace(/&[^;]+;/g, " ");
			return [
				`### ${block.title}`,
				...block.sources.map((source) => {
					const cleanTitle = stripHtml(source.title);
					const label = source.url
						? `[${cleanTitle}](${source.url})`
						: cleanTitle;
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
		case "chart":
			return `### ${block.title ?? "Chart"}\n\n${block.altText ?? block.caption ?? "Chart data is available in the rendered report."}`;
		case "image": {
			const src = renderImageSource(block);
			return [
				src ? `![${block.altText}](${src})` : `**Image:** ${block.altText}`,
				block.caption ?? null,
				block.sourceAttribution
					? `Source: [${block.sourceAttribution.title}](${block.sourceAttribution.url})`
					: null,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
		}
		case "pageBreak":
			return "";
	}
}

export function renderStandardReportMarkdown(
	source: GeneratedDocumentSource,
): StandardReportMarkdownRenderResult {
	const content = [
		`# ${source.title}`,
		source.subtitle ?? null,
		source.date ?? null,
		...source.blocks.map(renderBlock),
	]
		.filter((line): line is string => Boolean(line?.trim()))
		.join("\n\n");
	return {
		filename: filenameForTitle(source.title),
		mimeType: "text/markdown",
		content: Buffer.from(`${content}\n`, "utf8"),
	};
}
