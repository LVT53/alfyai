import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
	GeneratedDocumentTableBlock,
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

function renderBlock(block: GeneratedDocumentBlock): string {
	switch (block.type) {
		case "heading":
			return `${"#".repeat(block.level)} ${block.text}`;
		case "paragraph":
			return block.text;
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
		case "code":
			return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
		case "quote":
			return `> ${block.text}${block.citation ? `\n>\n> ${block.citation}` : ""}`;
		case "divider":
			return "---";
		case "sourceChips":
			return [
				`### ${block.title}`,
				...block.sources.map((source) => {
					const label = source.url
						? `[${source.title}](${source.url})`
						: source.title;
					const details = [
						source.provided ? "You provided these" : null,
						source.reasoning,
					].filter((part): part is string => Boolean(part));
					return details.length > 0
						? `- ${label} - ${details.join("; ")}`
						: `- ${label}`;
				}),
			].join("\n");
		case "table":
			return renderTable(block);
		case "chart":
			return `### ${block.title ?? "Chart"}\n\n${block.altText ?? block.caption ?? "Chart data is available in the rendered report."}`;
		case "image":
			return [
				`![${block.altText}](${block.caption ?? ""})`,
				block.sourceAttribution
					? `Source: [${block.sourceAttribution.title}](${block.sourceAttribution.url})`
					: null,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
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
