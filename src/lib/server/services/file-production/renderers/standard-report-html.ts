import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
} from "../source-schema";
import { renderChartSvg } from "./chart-svg";

export interface StandardReportHtmlRenderResult {
	filename: string;
	mimeType: "text/html";
	content: Buffer;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
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

function renderTable(
	block: Extract<GeneratedDocumentBlock, { type: "table" }>,
): string {
	return [
		'<figure class="table-figure">',
		block.title
			? `<figcaption class="table-title">${escapeHtml(block.title)}</figcaption>`
			: "",
		block.caption ? `<p class="caption">${escapeHtml(block.caption)}</p>` : "",
		"<table>",
		"<thead><tr>",
		...block.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`),
		"</tr></thead><tbody>",
		...block.rows.map(
			(row) =>
				`<tr>${block.columns
					.map(
						(column) =>
							`<td class="${column.kind === "text" ? "" : "numeric"}">${escapeHtml(String(row[column.key] ?? ""))}</td>`,
					)
					.join("")}</tr>`,
		),
		"</tbody></table></figure>",
	].join("");
}

function renderBlock(block: GeneratedDocumentBlock): string {
	switch (block.type) {
		case "heading":
			return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
		case "paragraph":
			return `<p>${escapeHtml(block.text)}</p>`;
		case "list": {
			const tag = block.style === "numbered" ? "ol" : "ul";
			return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
		}
		case "callout":
			return `<aside class="callout ${block.tone}">${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : ""}<p>${escapeHtml(block.text)}</p></aside>`;
		case "code":
			return `<pre><code${block.language ? ` data-language="${escapeHtml(block.language)}"` : ""}>${escapeHtml(block.text)}</code></pre>`;
		case "quote":
			return `<blockquote><p>${escapeHtml(block.text)}</p>${block.citation ? `<cite>${escapeHtml(block.citation)}</cite>` : ""}</blockquote>`;
		case "divider":
			return "<hr />";
		case "pageBreak":
			return '<div class="page-break" aria-hidden="true"></div>';
		case "table":
			return renderTable(block);
		case "chart":
			return `<figure class="chart-figure">${renderChartSvg(block).svg}</figure>`;
		case "image":
			return `<figure class="image-placeholder" role="img" aria-label="${escapeHtml(block.altText)}"><div>${escapeHtml(block.altText)}</div>${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
	}
}

export function renderStandardReportHtml(
	source: GeneratedDocumentSource,
): StandardReportHtmlRenderResult {
	const html = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`<title>${escapeHtml(source.title)}</title>`,
		"<style>",
		":root{color:#1B1815;background:#FAF8F4;font-family:Arial,Helvetica,sans-serif;}",
		"body{margin:0;padding:32px 24px;line-height:1.55;}",
		"main{max-width:880px;margin:0 auto;}",
		"h1,h2,h3{line-height:1.2;margin:1.5rem 0 .65rem;}",
		"h1{font-size:2rem;border-top:4px solid #B65F3D;padding-top:1rem;}",
		"p,li{font-size:1rem;}",
		".subtitle,.caption,figcaption,cite{color:#6F6860;font-size:.92rem;}",
		".callout{border-left:4px solid #B65F3D;background:#F5EFE6;padding:12px 14px;margin:16px 0;}",
		"pre{white-space:pre-wrap;background:#ECE6DC;padding:12px;overflow-wrap:anywhere;}",
		"table{width:100%;border-collapse:collapse;font-size:.92rem;}",
		"th,td{border-bottom:1px solid #DED6CB;padding:7px;text-align:left;vertical-align:top;}",
		"th{background:#F0EAE2;}td.numeric{text-align:right;}",
		".chart-figure svg{max-width:100%;height:auto;}",
		".image-placeholder{border:1px solid #DED6CB;background:#F0EAE2;padding:18px;}",
		"hr{border:0;border-top:1px solid #DED6CB;margin:24px 0;}",
		"</style>",
		"</head>",
		"<body><main>",
		`<h1>${escapeHtml(source.title)}</h1>`,
		source.subtitle
			? `<p class="subtitle">${escapeHtml(source.subtitle)}</p>`
			: "",
		...source.blocks.map(renderBlock),
		"</main></body></html>",
	].join("");

	return {
		filename: slugifyFilename(source.title, "html"),
		mimeType: "text/html",
		content: Buffer.from(html, "utf8"),
	};
}
