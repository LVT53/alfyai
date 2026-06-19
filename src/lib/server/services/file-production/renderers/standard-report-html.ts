import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
	GeneratedDocumentSourceChip,
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

function slugifyId(text: string, index: number): string {
	const slug = text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return `${slug || "section"}-${index + 1}`;
}

function sourceTooltip(source: GeneratedDocumentSourceChip): string {
	return [source.title, source.reasoning].filter(Boolean).join("\n");
}

function faviconUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return `${parsed.origin}/favicon.ico`;
	} catch {
		return null;
	}
}

function sourceInitial(title: string): string {
	return (Array.from(title.trim())[0] ?? "S").toUpperCase();
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

function renderSourceChips(
	block: Extract<GeneratedDocumentBlock, { type: "sourceChips" }>,
): string {
	return [
		`<section class="source-chip-section" data-source-chip-list="${escapeHtml(block.title)}">`,
		`<h3>${escapeHtml(block.title)}</h3>`,
		'<div class="source-chip-list">',
		...block.sources.map((source) => {
			const title = escapeHtml(sourceTooltip(source));
			const label = escapeHtml(
				source.provided ? `${source.title}. You provided these.` : source.title,
			);
			const favicon = faviconUrl(source.url);
			const content = favicon
				? `<img src="${escapeHtml(favicon)}" alt="" loading="lazy" />`
				: `<span aria-hidden="true">${escapeHtml(sourceInitial(source.title))}</span>`;
			return source.url
				? `<a class="source-chip" href="${escapeHtml(source.url)}" title="${title}" aria-label="${label}">${content}</a>`
				: `<span class="source-chip source-chip--library" title="${title}" aria-label="${label}">${content}</span>`;
		}),
		"</div>",
		"</section>",
	].join("");
}

function renderBlock(
	block: GeneratedDocumentBlock,
	headingId?: string | null,
): string {
	switch (block.type) {
		case "heading":
			return `<h${block.level}${headingId ? ` id="${escapeHtml(headingId)}"` : ""}>${escapeHtml(block.text)}</h${block.level}>`;
		case "paragraph":
			return `<p>${escapeHtml(block.text)}</p>`;
		case "list": {
			const tag = block.style === "numbered" ? "ol" : "ul";
			return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
		}
		case "callout":
			return `<aside class="callout ${block.tone}" title="${escapeHtml([block.title ?? block.tone, block.text].join("\n"))}"><span class="callout-pill"><span aria-hidden="true">${block.tone === "warning" ? "!" : "i"}</span>${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : `<strong>${escapeHtml(block.tone)}</strong>`}</span><p>${escapeHtml(block.text)}</p></aside>`;
		case "code":
			return `<pre><code${block.language ? ` data-language="${escapeHtml(block.language)}"` : ""}>${escapeHtml(block.text)}</code></pre>`;
		case "quote":
			return `<blockquote><p>${escapeHtml(block.text)}</p>${block.citation ? `<cite>${escapeHtml(block.citation)}</cite>` : ""}</blockquote>`;
		case "divider":
			return "<hr />";
		case "sourceChips":
			return renderSourceChips(block);
		case "pageBreak":
			return '<div class="page-break" aria-hidden="true"></div>';
		case "table":
			return renderTable(block);
		case "chart":
			return `<figure class="chart-figure">${renderChartSvg(block).svg}</figure>`;
		case "image":
			return `<figure class="image-placeholder" role="img" aria-label="${escapeHtml(block.altText)}"><div>${escapeHtml(block.altText)}</div>${block.caption ? `<figcaption>${escapeHtml(block.caption)}${block.sourceAttribution ? ` <a href="${escapeHtml(block.sourceAttribution.url)}">${escapeHtml(block.sourceAttribution.title)}</a>` : ""}</figcaption>` : block.sourceAttribution ? `<figcaption><a href="${escapeHtml(block.sourceAttribution.url)}">${escapeHtml(block.sourceAttribution.title)}</a></figcaption>` : ""}</figure>`;
	}
}

export function renderStandardReportHtml(
	source: GeneratedDocumentSource,
): StandardReportHtmlRenderResult {
	const blockEntries = source.blocks.map((block, index) => ({
		block,
		headingId: block.type === "heading" ? slugifyId(block.text, index) : null,
	}));
	const headingEntries = blockEntries.flatMap((entry) =>
		entry.block.type === "heading" && entry.headingId
			? [{ id: entry.headingId, text: entry.block.text }]
			: [],
	);
	const html = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`<title>${escapeHtml(source.title)}</title>`,
		"<style>",
		":root{color-scheme:light;--report-text:#1B1815;--report-body:#3E3933;--report-muted:#6F6860;--report-accent:#B65F3D;--report-bg:#FAF8F4;--report-panel:#F0EAE2;--report-rule:#DED6CB;--report-callout:#F5EFE6;font-family:Arial,Helvetica,sans-serif;}",
		"html.dark{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;}",
		"@media (prefers-color-scheme: dark){:root{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;}}",
		"body{margin:0;padding:32px 24px;line-height:1.55;color:var(--report-body);background:var(--report-bg);}",
		".report-shell{display:grid;grid-template-columns:minmax(160px,220px) minmax(0,880px);gap:36px;max-width:1180px;margin:0 auto;}",
		"main{min-width:0;}",
		".report-sidebar{position:sticky;top:24px;align-self:start;border-left:2px solid var(--report-rule);padding-left:14px;font-size:.86rem;}",
		".report-sidebar a{display:block;border-left:2px solid transparent;margin-left:-16px;padding:4px 0 4px 14px;color:var(--report-muted);text-decoration:none;}",
		".report-sidebar a:hover,.report-sidebar a:focus{border-left-color:var(--report-accent);color:var(--report-text);outline:none;}",
		"h1,h2,h3{line-height:1.2;margin:1.5rem 0 .65rem;color:var(--report-text);}",
		"h1{font-size:2rem;border-top:4px solid var(--report-accent);padding-top:1rem;}",
		"p,li{font-size:1rem;}",
		"a{color:var(--report-accent);text-underline-offset:2px;}",
		".subtitle,.caption,figcaption,cite{color:var(--report-muted);font-size:.92rem;}",
		".callout{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;border-left:4px solid var(--report-accent);background:var(--report-callout);padding:12px 14px;margin:16px 0;}",
		".callout p{flex-basis:100%;margin:.25rem 0 0;}",
		".callout-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 9px;background:var(--report-panel);color:var(--report-accent);font-size:.82rem;line-height:1;}",
		".callout.warning .callout-pill{color:#A6462F;}",
		".callout.tip .callout-pill{color:#2F7D54;}",
		"pre{white-space:pre-wrap;background:var(--report-panel);padding:12px;overflow-wrap:anywhere;}",
		"table{width:100%;border-collapse:collapse;font-size:.92rem;}",
		"th,td{border-bottom:1px solid var(--report-rule);padding:7px;text-align:left;vertical-align:top;}",
		"th{background:var(--report-panel);}td.numeric{text-align:right;}",
		".chart-figure svg{max-width:100%;height:auto;}",
		".image-placeholder{border:1px solid var(--report-rule);background:var(--report-panel);padding:18px;}",
		".source-chip-section{margin:1rem 0 1.5rem;}",
		".source-chip-section + .source-chip-section{margin-top:2rem;}",
		".source-chip-list{display:flex;flex-wrap:wrap;gap:10px;}",
		".source-chip{display:inline-grid;width:26px;height:26px;place-items:center;overflow:hidden;border-radius:999px;color:var(--report-muted);text-decoration:none;font-size:.72rem;font-weight:700;}",
		".source-chip img{width:18px;height:18px;border-radius:4px;}",
		"hr{border:0;border-top:1px solid var(--report-rule);margin:24px 0;}",
		"@media (max-width: 760px){body{padding:24px 18px;}.report-shell{display:block;}.report-sidebar{display:none;}}",
		"</style>",
		"</head>",
		'<body><div class="report-shell">',
		headingEntries.length > 0
			? `<nav class="report-sidebar" aria-label="Report sections">${headingEntries
					.map(
						(entry) =>
							`<a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a>`,
					)
					.join("")}</nav>`
			: '<nav class="report-sidebar" aria-label="Report sections"></nav>',
		"<main>",
		`<h1>${escapeHtml(source.title)}</h1>`,
		source.subtitle
			? `<p class="subtitle">${escapeHtml(source.subtitle)}</p>`
			: "",
		...blockEntries.map((entry) => renderBlock(entry.block, entry.headingId)),
		"</main></div></body></html>",
	].join("");

	return {
		filename: slugifyFilename(source.title, "html"),
		mimeType: "text/html",
		content: Buffer.from(html, "utf8"),
	};
}
