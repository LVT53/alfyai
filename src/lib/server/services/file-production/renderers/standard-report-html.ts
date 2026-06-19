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

function renderReportContent(
	blockEntries: Array<{
		block: GeneratedDocumentBlock;
		headingId: string | null;
	}>,
): string {
	const html: string[] = [];
	let sectionOpen = false;

	for (const entry of blockEntries) {
		if (entry.block.type === "heading") {
			if (sectionOpen) html.push("</section>");
			html.push(
				`<section class="report-section" id="${escapeHtml(entry.headingId ?? "section")}">`,
			);
			sectionOpen = true;
			html.push(renderBlock(entry.block, null));
			continue;
		}
		if (!sectionOpen) {
			html.push('<section class="report-section">');
			sectionOpen = true;
		}
		html.push(renderBlock(entry.block, null));
	}

	if (sectionOpen) html.push("</section>");
	return html.join("");
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
		":root{color-scheme:light;--report-text:#1B1815;--report-body:#3E3933;--report-muted:#6F6860;--report-accent:#B65F3D;--report-bg:#FAFAF8;--report-panel:#F4F3EE;--report-rule:rgba(0,0,0,.08);--report-callout:#F7F6F2;--report-serif:\"Libre Baskerville\",\"Georgia\",serif;font-family:\"Nimbus Sans L\",\"Inter\",system-ui,sans-serif;}",
		"html.dark{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;}",
		"@media (prefers-color-scheme: dark){:root{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;}}",
		"body{margin:0;padding:32px 24px;line-height:1.55;color:var(--report-body);background:var(--report-bg);font-family:\"Nimbus Sans L\",\"Inter\",system-ui,sans-serif;}",
		".report-shell{display:flex;min-height:calc(100vh - 64px);max-width:1180px;margin:0 auto;border:1px solid var(--report-rule);border-radius:8px;background:var(--report-bg);overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);}",
		".report-sidebar{width:240px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--report-rule);background:var(--report-panel);padding:24px;}",
		".report-sidebar-title{margin:0 0 16px;color:var(--report-muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}",
		".report-nav{display:flex;flex-direction:column;gap:2px;list-style:none;margin:0;padding:0;}",
		".report-nav a{display:block;border-left:3px solid transparent;border-radius:6px;padding:8px 12px;color:var(--report-muted);font-size:13px;text-decoration:none;transition:background .15s ease,color .15s ease,border-color .15s ease;}",
		".report-nav a:hover,.report-nav a:focus{background:rgba(0,0,0,.03);border-left-color:var(--report-accent);color:var(--report-text);outline:none;}",
		".report-content{flex:1;max-height:calc(100vh - 64px);overflow-y:auto;padding:32px 48px;scroll-behavior:smooth;}",
		".report-title{margin:0 0 24px;color:var(--report-text);font-family:\"Nimbus Sans L\",\"Inter\",system-ui,sans-serif;font-size:32px;font-weight:700;line-height:1.2;}",
		".report-section{margin:0 0 32px;padding-bottom:24px;border-bottom:1px solid rgba(0,0,0,.04);}",
		".report-section:last-of-type{border-bottom:none;}",
		"h1,h2,h3{line-height:1.2;color:var(--report-text);font-family:\"Nimbus Sans L\",\"Inter\",system-ui,sans-serif;}",
		"h2{margin:0 0 16px;border-left:3px solid var(--report-accent);padding-left:16px;font-size:24px;font-weight:700;}",
		"h3{margin:24px 0 8px;font-size:17px;font-weight:700;}",
		"p,li{font-size:15px;line-height:1.7;color:var(--report-text);}",
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
		".source-chip{display:inline-grid;width:16px;height:16px;place-items:center;overflow:hidden;border-radius:3px;color:var(--report-muted);text-decoration:none;font-size:.62rem;font-weight:700;transition:transform .1s ease;}",
		".source-chip:hover{transform:translateY(-1px);}",
		".source-chip img{width:16px;height:16px;border-radius:3px;}",
		"hr{border:0;border-top:1px solid var(--report-rule);margin:24px 0;}",
		"@media (max-width: 760px){body{padding:0;}.report-shell{display:block;min-height:100vh;border:0;border-radius:0;}.report-sidebar{display:none;}.report-content{max-height:none;padding:24px;}.report-title{font-size:24px;}}",
		"</style>",
		"</head>",
		'<body><div class="report-shell">',
		headingEntries.length > 0
			? `<nav class="report-sidebar" aria-label="Report sections"><p class="report-sidebar-title">Sections</p><ul class="report-nav">${headingEntries
					.map(
						(entry) =>
							`<li><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`,
					)
					.join("")}</ul></nav>`
			: '<nav class="report-sidebar" aria-label="Report sections"></nav>',
		'<article class="report-content">',
		`<h1 class="report-title">${escapeHtml(source.title)}</h1>`,
		source.subtitle
			? `<p class="subtitle">${escapeHtml(source.subtitle)}</p>`
			: "",
		renderReportContent(blockEntries),
		"</article></div></body></html>",
	].join("");

	return {
		filename: slugifyFilename(source.title, "html"),
		mimeType: "text/html",
		content: Buffer.from(html, "utf8"),
	};
}
