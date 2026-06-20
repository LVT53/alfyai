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
	return [source.title, compactSourceReasoning(source.reasoning)]
		.filter(Boolean)
		.join("\n");
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

function sourceDomain(url: string | null | undefined): string {
	if (!url) return "local library";
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "source";
	}
}

function compactSourceReasoning(value: string | null | undefined): string {
	if (!value) return "";
	const withoutFetcherPrefix = value.replace(
		/^\s*Fetched\s+page\s+excerpt:\s*/i,
		"",
	);
	const normalized = withoutFetcherPrefix.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
	const candidate = sentenceMatch?.[1] ?? normalized;
	if (candidate.length <= 160) return candidate;
	return `${candidate.slice(0, 157).trimEnd()}...`;
}

function renderGlobeFallback(hidden = false): string {
	return `<span class="favicon-placeholder" data-favicon-fallback aria-hidden="true"${hidden ? " hidden" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg></span>`;
}

function renderSourceFavicon(url: string | null | undefined): string {
	const favicon = faviconUrl(url);
	if (!favicon)
		return `<span class="source-favicon">${renderGlobeFallback()}</span>`;
	return `<span class="source-favicon"><img src="${escapeHtml(favicon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false;" />${renderGlobeFallback(true)}</span>`;
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
			const domain = escapeHtml(sourceDomain(source.url));
			const sourceTitle = escapeHtml(source.title);
			const reasoning = escapeHtml(compactSourceReasoning(source.reasoning));
			const content = `${renderSourceFavicon(source.url)}<span class="source-tooltip" role="tooltip"><span class="source-tooltip-head"><span class="source-favicon">${renderGlobeFallback()}</span><strong class="source-tooltip-title">${sourceTitle}</strong></span>${reasoning ? `<span class="source-tooltip-reason">${reasoning}</span>` : ""}<span class="source-tooltip-domain">${domain}</span></span>`;
			return source.url
				? `<a class="source-chip" href="${escapeHtml(source.url)}" title="${title}" aria-label="${label}" data-source-title="${sourceTitle}" data-source-domain="${domain}"${reasoning ? ` data-source-reason="${reasoning}"` : ""}>${content}</a>`
				: `<span class="source-chip source-chip--library" title="${title}" aria-label="${label}" data-source-title="${sourceTitle}" data-source-domain="${domain}"${reasoning ? ` data-source-reason="${reasoning}"` : ""}>${content}</span>`;
		}),
		"</div>",
		"</section>",
	].join("");
}

function renderHonestyMarker(
	block: Extract<GeneratedDocumentBlock, { type: "callout" }>,
): string {
	const marker =
		block.tone === "warning"
			? {
					className: "partial",
					label: "Partially Supported",
					title: "Needs verification",
					text: "This section includes unsupported certainty or a claim that needs additional source support.",
				}
			: {
					className: "verified",
					label: "Supported",
					title: "Source-backed",
					text: "This note is grounded in the report evidence available to Atlas.",
				};
	return `<span class="honesty-marker ${marker.className}" tabindex="0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg><span>${marker.label}</span><span class="honesty-tooltip"><strong>${marker.title}</strong>${marker.text}</span></span>`;
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
			return `<aside class="callout ${block.tone}" title="${escapeHtml([block.title ?? block.tone, block.text].join("\n"))}"><span class="callout-pill"><span aria-hidden="true">${block.tone === "warning" ? "!" : "i"}</span>${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : `<strong>${escapeHtml(block.tone)}</strong>`}</span>${renderHonestyMarker(block)}<p>${escapeHtml(block.text)}</p></aside>`;
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
		':root{color-scheme:light;--report-text:#1B1815;--report-body:#3E3933;--report-muted:#6F6860;--report-accent:#B65F3D;--report-bg:#FAFAF8;--report-panel:#F4F3EE;--report-rule:rgba(0,0,0,.08);--report-callout:#F7F6F2;--report-serif:"Libre Baskerville","Georgia",serif;font-family:"Nimbus Sans L","Inter",system-ui,sans-serif;}',
		"html.dark{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;}",
		"@media (prefers-color-scheme: dark){:root{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;}}",
		"html,body{margin:0;min-height:100vh;min-height:100dvh;}",
		'body{box-sizing:border-box;padding:32px 24px;line-height:1.55;color:var(--report-body);background:var(--report-bg);font-family:"Nimbus Sans L","Inter",system-ui,sans-serif;}',
		".report-viewer{display:flex;position:relative;min-height:100vh;min-height:100dvh;max-width:1180px;margin:0 auto;border:1px solid var(--report-rule);border-radius:8px;background:var(--report-bg);overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);}",
		".report-sidebar{width:240px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--report-rule);background:var(--report-panel);padding:24px;}",
		".report-sidebar-resizer{width:6px;flex:0 0 6px;cursor:col-resize;background:transparent;border:0;border-right:1px solid var(--report-rule);transition:background .15s ease;}",
		".report-sidebar-resizer:hover,.report-sidebar-resizer:focus{background:rgba(182,95,61,.12);outline:none;}",
		".report-sidebar-title{margin:0 0 16px;color:var(--report-muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}",
		".report-nav{display:flex;flex-direction:column;gap:2px;list-style:none;margin:0;padding:0;}",
		".report-nav a{display:block;border-left:3px solid transparent;border-radius:6px;padding:8px 12px;color:var(--report-muted);font-size:13px;text-decoration:none;transition:background .15s ease,color .15s ease,border-color .15s ease;}",
		".report-nav a:hover,.report-nav a:focus{background:rgba(0,0,0,.03);border-left-color:var(--report-accent);color:var(--report-text);outline:none;}",
		".report-nav a.active{background:rgba(182,95,61,.08);border-left-color:var(--report-accent);color:var(--report-accent);font-weight:600;padding-left:13px;}",
		".mobile-report-header{display:none;align-items:center;gap:10px;padding:14px 18px;background:var(--report-panel);border-bottom:1px solid var(--report-rule);}",
		".mobile-menu-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:0;border-radius:6px;background:transparent;color:var(--report-text);cursor:pointer;}",
		".mobile-menu-btn:hover,.mobile-menu-btn:focus{background:rgba(0,0,0,.04);outline:none;}",
		".mobile-menu-btn svg{width:20px;height:20px;}",
		".mobile-report-title{margin:0;color:var(--report-text);font-size:15px;font-weight:600;}",
		".sidebar-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.2);z-index:80;}",
		".report-content{flex:1;max-height:100vh;max-height:100dvh;overflow-y:auto;padding:32px 48px;scroll-behavior:smooth;}",
		'.report-title{margin:0 0 24px;color:var(--report-text);font-family:"Nimbus Sans L","Inter",system-ui,sans-serif;font-size:32px;font-weight:700;line-height:1.2;}',
		".report-section{margin:0 0 32px;padding-bottom:24px;border-bottom:1px solid rgba(0,0,0,.04);}",
		".report-section:last-of-type{border-bottom:none;}",
		'h1,h2,h3{line-height:1.2;color:var(--report-text);font-family:"Nimbus Sans L","Inter",system-ui,sans-serif;}',
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
		".honesty-marker{display:inline-flex;align-items:center;justify-content:center;position:relative;gap:4px;border:1px solid transparent;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;line-height:1;letter-spacing:.02em;vertical-align:middle;cursor:help;white-space:nowrap;}",
		".honesty-marker svg{display:block;width:11px;height:11px;flex-shrink:0;}",
		".honesty-marker.verified{border-color:rgba(21,128,61,.2);background:rgba(21,128,61,.08);color:#15803D;}",
		".honesty-marker.partial{border-color:rgba(234,179,8,.35);background:rgba(234,179,8,.14);color:#92400E;}",
		".honesty-marker.unverified{border-color:rgba(185,28,28,.2);background:rgba(185,28,28,.08);color:#B91C1C;}",
		".honesty-marker.conflicting{border-color:rgba(249,115,22,.3);background:rgba(249,115,22,.1);color:#9A3412;}",
		".honesty-tooltip{position:absolute;bottom:calc(100% + 10px);left:50%;z-index:25;width:300px;box-sizing:border-box;border-radius:6px;background:var(--report-text);box-shadow:0 10px 30px rgba(0,0,0,.18);color:var(--report-bg);opacity:0;padding:8px 12px;pointer-events:none;text-align:left;transform:translateX(-50%);transition:opacity .15s ease;white-space:normal;font-size:12px;font-weight:400;line-height:1.5;}",
		'.honesty-tooltip::after{content:"";position:absolute;top:100%;left:50%;border:6px solid transparent;border-top-color:var(--report-text);transform:translateX(-50%);}',
		".honesty-marker:hover .honesty-tooltip,.honesty-marker:focus .honesty-tooltip{opacity:1;}",
		".honesty-tooltip strong{display:block;margin-bottom:4px;font-weight:600;}",
		"pre{white-space:pre-wrap;background:var(--report-panel);padding:12px;overflow-wrap:anywhere;}",
		"table{width:100%;border-collapse:collapse;font-size:.92rem;}",
		"th,td{border-bottom:1px solid var(--report-rule);padding:7px;text-align:left;vertical-align:top;}",
		"th{background:var(--report-panel);}td.numeric{text-align:right;}",
		".chart-figure svg{max-width:100%;height:auto;}",
		".image-placeholder{border:1px solid var(--report-rule);background:var(--report-panel);padding:18px;}",
		".source-chip-section{margin:1rem 0 1.5rem;}",
		".source-chip-section + .source-chip-section{margin-top:2rem;}",
		".source-chip-list{display:flex;flex-wrap:wrap;gap:10px;}",
		".source-chip{display:inline-flex;align-items:center;justify-content:center;position:relative;width:16px;height:16px;vertical-align:middle;color:var(--report-muted);text-decoration:none;transition:transform .1s ease;}",
		".source-chip:hover,.source-chip:focus{transform:translateY(-1px);outline:none;}",
		".source-favicon,.source-chip img,.favicon-placeholder{display:block;width:16px;height:16px;border-radius:3px;}",
		".source-chip img{object-fit:cover;}",
		".favicon-placeholder{box-sizing:border-box;background:var(--report-accent);color:#fff;padding:2px;}",
		"[hidden]{display:none!important;}",
		".favicon-placeholder svg{display:block;width:100%;height:100%;}",
		".source-tooltip{position:absolute;bottom:calc(100% + 10px);left:50%;z-index:25;width:280px;max-width:min(280px,calc(100vw - 32px));box-sizing:border-box;border-radius:6px;background:var(--report-text);box-shadow:0 10px 30px rgba(0,0,0,.18);color:var(--report-bg);opacity:0;padding:8px 10px;pointer-events:none;text-align:left;transform:translateX(-50%);transition:opacity .15s ease;}",
		'.source-tooltip::after{content:"";position:absolute;top:100%;left:50%;border:6px solid transparent;border-top-color:var(--report-text);transform:translateX(-50%);}',
		".source-chip:hover .source-tooltip,.source-chip:focus .source-tooltip{opacity:1;}",
		".source-tooltip-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}",
		".source-tooltip-title{min-width:0;overflow:hidden;color:#fff;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;}",
		".source-tooltip-reason,.source-tooltip-domain{display:block;color:rgba(255,255,255,.78);font-size:11px;line-height:1.4;}",
		".source-tooltip-domain{margin-top:4px;color:rgba(255,255,255,.62);}",
		"hr{border:0;border-top:1px solid var(--report-rule);margin:24px 0;}",
		"@media (max-width: 760px){body{padding:0;}.report-viewer{display:block;min-height:100vh;min-height:100dvh;border:0;border-radius:0;}.mobile-report-header{display:flex;}.report-sidebar{position:fixed;top:0;left:0;z-index:90;height:100vh;height:100dvh;width:260px!important;box-sizing:border-box;border-right:1px solid var(--report-rule);box-shadow:0 16px 40px rgba(0,0,0,.18);transform:translateX(-100%);transition:transform .25s ease;}.report-sidebar-resizer{display:none;}.report-sidebar.open{transform:translateX(0);}.sidebar-backdrop.open{display:block;}.report-content{max-height:none;padding:24px;}.report-title{font-size:24px;}}",
		"</style>",
		"</head>",
		'<body><div class="report-viewer" id="report-viewer">',
		headingEntries.length > 0
			? `<aside class="report-sidebar" id="report-sidebar" aria-label="Report sections"><p class="report-sidebar-title">Sections</p><ul class="report-nav">${headingEntries
					.map(
						(entry) =>
							`<li><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`,
					)
					.join("")}</ul></aside>`
			: '<aside class="report-sidebar" id="report-sidebar" aria-label="Report sections"></aside>',
		'<div class="report-sidebar-resizer" id="report-sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize report sidebar" tabindex="0"></div>',
		'<div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>',
		'<div class="mobile-report-header"><button type="button" class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open section menu" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h16"></path></svg></button><p class="mobile-report-title">Sections</p></div>',
		'<article class="report-content" id="report-content">',
		`<h1 class="report-title">${escapeHtml(source.title)}</h1>`,
		source.subtitle
			? `<p class="subtitle">${escapeHtml(source.subtitle)}</p>`
			: "",
		renderReportContent(blockEntries),
		"</article></div>",
		"<script>",
		"(() => { const sidebar = document.getElementById('report-sidebar'); const backdrop = document.getElementById('sidebar-backdrop'); const button = document.getElementById('mobile-menu-btn'); if (!sidebar || !backdrop || !button) return; const close = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); }; const open = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); button.setAttribute('aria-expanded', 'true'); }; button.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open()); backdrop.addEventListener('click', close); sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', close)); })();",
		"(() => { const reportContent = document.getElementById('report-content'); const reportNavLinks = document.querySelectorAll('.report-nav a'); const reportSections = document.querySelectorAll('.report-section[id]'); if (!reportContent || reportNavLinks.length === 0 || reportSections.length === 0) return; function updateActiveSection() { const scrollTop = reportContent.scrollTop; let activeId = reportSections[0].id; reportSections.forEach((section) => { const offsetTop = section.offsetTop - reportContent.offsetTop; if (scrollTop >= offsetTop - 40) activeId = section.id; }); reportNavLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === '#' + activeId)); } reportContent.addEventListener('scroll', updateActiveSection, { passive: true }); updateActiveSection(); })();",
		"(() => { const sidebar = document.getElementById('report-sidebar'); const resizer = document.getElementById('report-sidebar-resizer'); if (!sidebar || !resizer) return; const minWidth = 180; const maxWidth = 380; const setWidth = (width) => { sidebar.style.width = Math.max(minWidth, Math.min(maxWidth, width)) + 'px'; }; let startX = 0; let startWidth = 0; resizer.addEventListener('pointerdown', (event) => { startX = event.clientX; startWidth = sidebar.getBoundingClientRect().width; resizer.setPointerCapture(event.pointerId); const move = (moveEvent) => setWidth(startWidth + moveEvent.clientX - startX); const up = (upEvent) => { resizer.releasePointerCapture(upEvent.pointerId); resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', up); resizer.removeEventListener('pointercancel', up); }; resizer.addEventListener('pointermove', move); resizer.addEventListener('pointerup', up); resizer.addEventListener('pointercancel', up); }); resizer.addEventListener('keydown', (event) => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); const delta = event.key === 'ArrowLeft' ? -16 : 16; setWidth(sidebar.getBoundingClientRect().width + delta); }); })();",
		"</script>",
		"</body></html>",
	].join("");

	return {
		filename: slugifyFilename(source.title, "html"),
		mimeType: "text/html",
		content: Buffer.from(html, "utf8"),
	};
}
