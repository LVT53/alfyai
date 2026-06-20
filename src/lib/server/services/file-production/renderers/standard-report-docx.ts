import {
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
} from "../source-schema";

export interface StandardReportDocxRenderResult {
	filename: string;
	mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	content: Buffer;
}

function slugifyFilename(title: string, extension: string): string {
	const slug = title
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${slug || "document"}.${extension}`;
}

function paragraph(text: string): Paragraph {
	return new Paragraph({ children: [new TextRun(text)] });
}

function renderTable(
	block: Extract<GeneratedDocumentBlock, { type: "table" }>,
): Table {
	return new Table({
		width: { size: 100, type: WidthType.PERCENTAGE },
		rows: [
			new TableRow({
				tableHeader: true,
				children: block.columns.map(
					(column) =>
						new TableCell({
							children: [
								new Paragraph({
									children: [new TextRun({ text: column.label, bold: true })],
								}),
							],
						}),
				),
			}),
			...block.rows.map(
				(row) =>
					new TableRow({
						children: block.columns.map(
							(column) =>
								new TableCell({
									children: [paragraph(String(row[column.key] ?? ""))],
								}),
						),
					}),
			),
		],
	});
}

function renderBlock(block: GeneratedDocumentBlock): Paragraph | Table {
	switch (block.type) {
		case "heading":
			return new Paragraph({
				text: block.text,
				heading:
					block.level === 1
						? HeadingLevel.HEADING_1
						: block.level === 2
							? HeadingLevel.HEADING_2
							: HeadingLevel.HEADING_3,
			});
		case "paragraph":
			return paragraph(block.text);
		case "list":
			return new Paragraph({
				children: [
					new TextRun(block.items.map((item) => `• ${item}`).join("\n")),
				],
			});
		case "callout":
			return new Paragraph({
				children: [
					new TextRun({
						text: block.title ? `${block.title}: ` : `${block.tone}: `,
						bold: true,
					}),
					new TextRun(block.text),
				],
			});
		case "confidenceMarker":
			return new Paragraph({
				children: [
					new TextRun({ text: `${block.label}: `, bold: true }),
					new TextRun(block.message),
				],
			});
		case "code":
			return new Paragraph({
				children: [new TextRun({ text: block.text, font: "Courier New" })],
			});
		case "quote":
			return paragraph(
				block.citation ? `${block.text} — ${block.citation}` : block.text,
			);
		case "divider":
			return paragraph("---");
		case "sourceChips":
			return new Paragraph({
				children: [
					new TextRun({ text: `${block.title}\n`, bold: true }),
					new TextRun(
						block.sources
							.map((source) => {
								const details = [
									source.url,
									source.provided ? "You provided these" : null,
									source.reasoning,
								].filter((part): part is string => Boolean(part));
								return details.length > 0
									? `• ${source.title} (${details.join("; ")})`
									: `• ${source.title}`;
							})
							.join("\n"),
					),
				],
			});
		case "pageBreak":
			return paragraph("");
		case "table":
			return renderTable(block);
		case "chart":
			return paragraph(
				`Chart: ${block.title ?? block.chartType}. ${block.altText ?? ""}`,
			);
		case "image":
			return paragraph(
				[
					`Image: ${block.altText}`,
					block.caption,
					block.sourceAttribution
						? `Source: ${block.sourceAttribution.title} - ${block.sourceAttribution.url}`
						: null,
				]
					.filter((part): part is string => Boolean(part))
					.join(" — "),
			);
	}
}

export async function renderStandardReportDocx(
	source: GeneratedDocumentSource,
): Promise<StandardReportDocxRenderResult> {
	const children: Array<Paragraph | Table> = [
		new Paragraph({ text: source.title, heading: HeadingLevel.TITLE }),
		...(source.subtitle ? [paragraph(source.subtitle)] : []),
		...source.blocks.map(renderBlock),
	];
	const document = new Document({
		creator: "AlfyAI",
		title: source.title,
		description: "AlfyAI Standard Report",
		sections: [{ children }],
	});

	return {
		filename: slugifyFilename(source.title, "docx"),
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		content: Buffer.from(await Packer.toBuffer(document)),
	};
}
