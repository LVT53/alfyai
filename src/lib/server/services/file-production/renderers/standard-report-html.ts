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

type ReportLanguage = "en" | "hu";

interface ReportChrome {
	language: ReportLanguage;
	sections: string;
	reportSectionsLabel: string;
	openSectionMenu: string;
	resizeReportSidebar: string;
	sources: string;
	sourceLabel: string;
	webSources: string;
	librarySources: string;
	localLibrary: string;
	providedLabel: string;
}

function reportChrome(
	language: GeneratedDocumentSource["language"],
): ReportChrome {
	if (language === "hu") {
		return {
			language: "hu",
			sections: "Szakaszok",
			reportSectionsLabel: "Jelentésszakaszok",
			openSectionMenu: "Szakaszmenü megnyitása",
			resizeReportSidebar: "Jelentés oldalsáv átméretezése",
			sources: "Források",
			sourceLabel: "Forrás",
			webSources: "Webes források",
			librarySources: "Saját könyvtár",
			localLibrary: "saját könyvtár",
			providedLabel: "A felhasználó adta meg",
		};
	}
	return {
		language: "en",
		sections: "Sections",
		reportSectionsLabel: "Report sections",
		openSectionMenu: "Open section menu",
		resizeReportSidebar: "Resize report sidebar",
		sources: "Sources",
		sourceLabel: "Source",
		webSources: "Web Sources",
		librarySources: "Your Library",
		localLibrary: "local library",
		providedLabel: "You provided these",
	};
}

function normalizedLabel(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase();
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

function sourceDomain(
	url: string | null | undefined,
	chrome = reportChrome("en"),
): string {
	if (!url) return chrome.localLibrary;
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

function sourceKey(source: GeneratedDocumentSourceChip): string {
	return `${source.url ?? ""}\u0000${source.title}`;
}

function isFinalSourcesHeading(text: string): boolean {
	const normalized = normalizedLabel(text);
	return normalized === "sources" || normalized === "forrasok";
}

function isFinalSourceGroupTitle(text: string): boolean {
	const normalized = normalizedLabel(text);
	return (
		normalized === "sources" ||
		normalized === "forrasok" ||
		normalized === "web sources" ||
		normalized === "webes forrasok" ||
		normalized === "your library" ||
		normalized === "sajat konyvtar"
	);
}

interface ReportSourceIndex {
	sources: GeneratedDocumentSourceChip[];
	indexByKey: Map<string, number>;
}

function collectReportSources(
	blocks: GeneratedDocumentBlock[],
): ReportSourceIndex {
	const finalSources: GeneratedDocumentSourceChip[] = [];
	const fallbackSources: GeneratedDocumentSourceChip[] = [];
	let insideSourcesSection = false;

	for (const block of blocks) {
		if (block.type === "heading" && block.level <= 2) {
			insideSourcesSection = isFinalSourcesHeading(block.text);
			continue;
		}
		if (block.type === "paragraph" && block.sources) {
			fallbackSources.push(...block.sources);
			continue;
		}
		if (block.type !== "sourceChips") continue;
		fallbackSources.push(...block.sources);
		if (insideSourcesSection) finalSources.push(...block.sources);
	}

	const seen = new Set<string>();
	const sources = (
		finalSources.length > 0 ? finalSources : fallbackSources
	).filter((source) => {
		const key = sourceKey(source);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		sources,
		indexByKey: new Map(
			sources.map((source, index) => [sourceKey(source), index]),
		),
	};
}

function sourceNumberFor(
	sourceIndex: ReportSourceIndex,
	source: GeneratedDocumentSourceChip,
): number | null {
	const index = sourceIndex.indexByKey.get(sourceKey(source));
	return typeof index === "number" ? index + 1 : null;
}

function renderSourceTooltip(
	source: GeneratedDocumentSourceChip,
	chrome: ReportChrome,
): string {
	const title = escapeHtml(source.title);
	const reasoning = escapeHtml(compactSourceReasoning(source.reasoning));
	const domain = escapeHtml(sourceDomain(source.url, chrome));
	return `<span class="source-tooltip" role="tooltip"><span class="source-tooltip-head">${renderSourceFavicon(source.url)}<strong class="source-tooltip-title">${title}</strong></span>${reasoning ? `<span class="source-tooltip-reason">${reasoning}</span>` : ""}<span class="source-tooltip-domain">${domain}</span></span>`;
}

function renderSourceChip(
	source: GeneratedDocumentSourceChip,
	chrome: ReportChrome,
	options: {
		link?: boolean;
		sourceNumber?: number | null;
		className?: string;
	} = {},
): string {
	const title = escapeHtml(sourceTooltip(source));
	const domain = escapeHtml(sourceDomain(source.url, chrome));
	const sourceTitle = escapeHtml(source.title);
	const reasoning = escapeHtml(compactSourceReasoning(source.reasoning));
	const sourceNumber = options.sourceNumber ?? null;
	const label = escapeHtml(
		[
			sourceNumber
				? `${chrome.sourceLabel} ${sourceNumber}: ${source.title}`
				: `${chrome.sourceLabel}: ${source.title}`,
			source.provided ? `${chrome.providedLabel}.` : null,
		]
			.filter((part): part is string => Boolean(part))
			.join(". "),
	);
	const className = [
		"source-chip",
		!source.url ? "source-chip--library" : null,
		options.className ?? null,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	const attributes = [
		`class="${className}"`,
		`title="${title}"`,
		`aria-label="${label}"`,
		`data-source-title="${sourceTitle}"`,
		`data-source-domain="${domain}"`,
		sourceNumber ? `data-source-number="${sourceNumber}"` : null,
		reasoning ? `data-source-reason="${reasoning}"` : null,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	const content = `${renderSourceFavicon(source.url)}${renderSourceTooltip(source, chrome)}`;

	if (source.url && options.link !== false) {
		return `<a ${attributes} href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${content}</a>`;
	}
	return `<span ${attributes}>${content}</span>`;
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

function renderImageSource(
	block: Extract<GeneratedDocumentBlock, { type: "image" }>,
): string | null {
	if (block.source.kind === "https") return block.source.url;
	if (block.source.kind === "data") {
		return `data:${block.source.mimeType};base64,${block.source.data}`;
	}
	return null;
}

function renderImage(
	block: Extract<GeneratedDocumentBlock, { type: "image" }>,
): string {
	const src = renderImageSource(block);
	const attribution = block.sourceAttribution
		? `<p class="figure-source">Source: <a href="${escapeHtml(block.sourceAttribution.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(block.sourceAttribution.title)}</a></p>`
		: "";
	const caption = block.caption
		? `<figcaption class="figure-caption">${escapeHtml(block.caption)}</figcaption>`
		: "";
	if (!src) {
		return `<figure class="report-figure image-placeholder" role="img" aria-label="${escapeHtml(block.altText)}"><div>${escapeHtml(block.altText)}</div>${caption}${attribution}</figure>`;
	}
	return `<figure class="report-figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(block.altText)}" loading="lazy" />${caption}${attribution}</figure>`;
}

function renderSourceChips(
	block: Extract<GeneratedDocumentBlock, { type: "sourceChips" }>,
	sourceIndex: ReportSourceIndex,
	chrome: ReportChrome,
): string {
	return `<span class="inline-source-chips" aria-label="${escapeHtml(block.title)}">${block.sources
		.map((source) =>
			renderSourceChip(source, chrome, {
				sourceNumber: sourceNumberFor(sourceIndex, source),
			}),
		)
		.join("")}</span>`;
}

function renderSourcesGroup(
	block: Extract<GeneratedDocumentBlock, { type: "sourceChips" }>,
	sourceIndex: ReportSourceIndex,
	chrome: ReportChrome,
): string {
	return [
		`<p class="source-subheading">${escapeHtml(block.title)}</p>`,
		'<ul class="source-list">',
		...block.sources.map((source) => {
			const domain = escapeHtml(sourceDomain(source.url, chrome));
			const title = escapeHtml(source.title);
			const sourceNumber = sourceNumberFor(sourceIndex, source);
			const titleNode = source.url
				? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
				: `<span class="source-title">${title}</span>`;
			const provided = source.provided
				? `<span class="source-provided">${escapeHtml(chrome.providedLabel)}</span>`
				: "";
			return `<li class="source-item">${renderSourceChip(source, chrome, {
				link: false,
				sourceNumber,
			})}${titleNode}<span class="source-domain">${domain}</span>${provided}</li>`;
		}),
		"</ul>",
	].join("");
}

function renderOrganizedSourcesGroups(
	sourceIndex: ReportSourceIndex,
	chrome: ReportChrome,
): string {
	const webSources = sourceIndex.sources.filter((source) => source.url);
	const librarySources = sourceIndex.sources.filter((source) => !source.url);
	return [
		webSources.length > 0
			? renderSourcesGroup(
					{
						type: "sourceChips",
						title: chrome.webSources,
						sources: webSources,
					},
					sourceIndex,
					chrome,
				)
			: "",
		librarySources.length > 0
			? renderSourcesGroup(
					{
						type: "sourceChips",
						title: chrome.librarySources,
						sources: librarySources,
					},
					sourceIndex,
					chrome,
				)
			: "",
	].join("");
}

function renderInlineTextWithSourceCitations(
	text: string,
	sourceIndex: ReportSourceIndex,
	chrome: ReportChrome,
): string {
	const citationPattern = /\[(\d{1,3})\]/g;
	let cursor = 0;
	let html = "";
	for (const match of text.matchAll(citationPattern)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		const sourceNumber = Number.parseInt(match[1], 10);
		const source = sourceIndex.sources[sourceNumber - 1];
		html += escapeHtml(text.slice(cursor, start));
		html += source
			? renderSourceChip(source, chrome, { sourceNumber })
			: escapeHtml(match[0]);
		cursor = end;
	}
	html += escapeHtml(text.slice(cursor));
	return html;
}

function renderParagraph(
	block: Extract<GeneratedDocumentBlock, { type: "paragraph" }>,
	sourceIndex: ReportSourceIndex,
	chrome: ReportChrome,
): string {
	const explicitSources = block.sources ?? [];
	const inlineSources =
		explicitSources.length > 0
			? ` <span class="inline-source-chips">${explicitSources
					.map((source) =>
						renderSourceChip(source, chrome, {
							sourceNumber: sourceNumberFor(sourceIndex, source),
						}),
					)
					.join("")}</span>`
			: "";
	return `<p>${renderInlineTextWithSourceCitations(block.text, sourceIndex, chrome)}${inlineSources}</p>`;
}

function confidenceMarkerClass(
	severity: Extract<
		GeneratedDocumentBlock,
		{ type: "confidenceMarker" }
	>["severity"],
): string {
	switch (severity) {
		case "critical":
			return "unverified";
		case "warning":
			return "partial";
		case "info":
			return "verified";
	}
}

function renderConfidenceMarkerIcon(
	severity: Extract<
		GeneratedDocumentBlock,
		{ type: "confidenceMarker" }
	>["severity"],
): string {
	if (severity === "info") {
		return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
	}
	return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
}

function renderConfidenceMarker(
	block: Extract<GeneratedDocumentBlock, { type: "confidenceMarker" }>,
): string {
	return `<p class="honesty-marker-block"><span class="honesty-marker ${confidenceMarkerClass(block.severity)}" tabindex="0" data-confidence-code="${escapeHtml(block.code)}" data-confidence-severity="${escapeHtml(block.severity)}">${renderConfidenceMarkerIcon(block.severity)}<span>${escapeHtml(block.label)}</span><span class="honesty-tooltip" role="tooltip"><strong>${escapeHtml(block.label)}</strong><span>${escapeHtml(block.message)}</span><span class="honesty-tooltip-code">${escapeHtml(block.code)}</span></span></span><span class="honesty-marker-message">${escapeHtml(block.message)}</span></p>`;
}

function renderBlock(
	block: GeneratedDocumentBlock,
	options: {
		headingId?: string | null;
		sourceIndex: ReportSourceIndex;
		chrome: ReportChrome;
		inSourcesSection?: boolean;
	},
): string {
	switch (block.type) {
		case "heading":
			return `<h${block.level}${options.headingId ? ` id="${escapeHtml(options.headingId)}"` : ""}>${escapeHtml(block.text)}</h${block.level}>`;
		case "paragraph":
			return renderParagraph(block, options.sourceIndex, options.chrome);
		case "list": {
			const tag = block.style === "numbered" ? "ol" : "ul";
			return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
		}
		case "callout":
			return `<aside class="callout ${block.tone}" title="${escapeHtml([block.title ?? block.tone, block.text].join("\n"))}"><span class="callout-pill"><span aria-hidden="true">${block.tone === "warning" ? "!" : "i"}</span>${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : `<strong>${escapeHtml(block.tone)}</strong>`}</span><p>${escapeHtml(block.text)}</p></aside>`;
		case "confidenceMarker":
			return renderConfidenceMarker(block);
		case "code":
			return `<pre><code${block.language ? ` data-language="${escapeHtml(block.language)}"` : ""}>${escapeHtml(block.text)}</code></pre>`;
		case "quote":
			return `<blockquote><p>${escapeHtml(block.text)}</p>${block.citation ? `<cite>${escapeHtml(block.citation)}</cite>` : ""}</blockquote>`;
		case "divider":
			return "<hr />";
		case "sourceChips":
			if (options.inSourcesSection && isFinalSourcesHeading(block.title)) {
				return renderOrganizedSourcesGroups(
					options.sourceIndex,
					options.chrome,
				);
			}
			return options.inSourcesSection
				? renderSourcesGroup(block, options.sourceIndex, options.chrome)
				: renderSourceChips(block, options.sourceIndex, options.chrome);
		case "pageBreak":
			return '<div class="page-break" aria-hidden="true"></div>';
		case "table":
			return renderTable(block);
		case "chart":
			return `<figure class="chart-figure">${renderChartSvg(block).svg}</figure>`;
		case "image":
			return renderImage(block);
	}
}

function renderReportContent(
	blockEntries: Array<{
		block: GeneratedDocumentBlock;
		headingId: string | null;
	}>,
	sourceIndex: ReportSourceIndex,
	chrome: ReportChrome,
): string {
	const html: string[] = [];
	let sectionOpen = false;
	let inSourcesSection = false;
	const hasExplicitSourcesSection = blockEntries.some(
		(entry) =>
			entry.block.type === "heading" &&
			entry.block.level <= 2 &&
			isFinalSourcesHeading(entry.block.text),
	);
	let fallbackSourcesSectionOpen = false;

	for (const entry of blockEntries) {
		if (entry.block.type === "heading") {
			if (sectionOpen) html.push("</section>");
			fallbackSourcesSectionOpen = false;
			inSourcesSection =
				entry.block.level <= 2 && isFinalSourcesHeading(entry.block.text);
			html.push(
				`<section class="report-section" id="${escapeHtml(entry.headingId ?? "section")}">`,
			);
			sectionOpen = true;
			html.push(
				renderBlock(entry.block, {
					sourceIndex,
					chrome,
					inSourcesSection,
				}),
			);
			continue;
		}
		if (
			!hasExplicitSourcesSection &&
			entry.block.type === "sourceChips" &&
			isFinalSourceGroupTitle(entry.block.title)
		) {
			if (!fallbackSourcesSectionOpen) {
				if (sectionOpen) html.push("</section>");
				html.push('<section class="report-section" id="sources">');
				html.push(`<h2>${escapeHtml(chrome.sources)}</h2>`);
				sectionOpen = true;
				inSourcesSection = true;
				fallbackSourcesSectionOpen = true;
			}
			html.push(
				isFinalSourcesHeading(entry.block.title)
					? renderOrganizedSourcesGroups(sourceIndex, chrome)
					: renderSourcesGroup(entry.block, sourceIndex, chrome),
			);
			continue;
		}
		if (fallbackSourcesSectionOpen) {
			html.push("</section>");
			sectionOpen = false;
			inSourcesSection = false;
			fallbackSourcesSectionOpen = false;
		}
		if (!sectionOpen) {
			html.push('<section class="report-section">');
			sectionOpen = true;
		}
		html.push(
			renderBlock(entry.block, {
				sourceIndex,
				chrome,
				inSourcesSection,
			}),
		);
	}

	if (sectionOpen) html.push("</section>");
	return html.join("");
}

export function renderStandardReportHtml(
	source: GeneratedDocumentSource,
): StandardReportHtmlRenderResult {
	const chrome = reportChrome(source.language);
	const sourceIndex = collectReportSources(source.blocks);
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
		`<html lang="${chrome.language}">`,
		"<head>",
		'<meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`<title>${escapeHtml(source.title)}</title>`,
		"<style>",
		':root{color-scheme:light;--report-text:#1B1815;--report-body:#3E3933;--report-muted:#6F6860;--report-accent:#B65F3D;--report-bg:#FAFAF8;--report-panel:#F4F3EE;--report-rule:rgba(0,0,0,.08);--report-callout:#F7F6F2;--report-tooltip-bg:#1B1815;--report-tooltip-text:#FAFAF8;--report-tooltip-muted:rgba(250,250,248,.78);--report-tooltip-border:rgba(255,255,255,.12);--report-serif:"Libre Baskerville","Georgia",serif;font-family:"Nimbus Sans L","Inter",system-ui,sans-serif;}',
		"html.dark{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;--report-tooltip-bg:#27211D;--report-tooltip-text:#F4EFE8;--report-tooltip-muted:#CFC4B8;--report-tooltip-border:#4A4038;}",
		"@media (prefers-color-scheme: dark){:root{color-scheme:dark;--report-text:#F4EFE8;--report-body:#E1D8CE;--report-muted:#AFA59A;--report-accent:#E19A78;--report-bg:#171412;--report-panel:#27211D;--report-rule:#3B332D;--report-callout:#241F1B;--report-tooltip-bg:#27211D;--report-tooltip-text:#F4EFE8;--report-tooltip-muted:#CFC4B8;--report-tooltip-border:#4A4038;}}",
		"html,body{margin:0;width:100%;height:100%;min-height:100vh;min-height:100dvh;overflow:hidden;}",
		'body{box-sizing:border-box;padding:0;line-height:1.55;color:var(--report-body);background:var(--report-bg);font-family:"Nimbus Sans L","Inter",system-ui,sans-serif;}',
		".report-viewer{display:flex;position:relative;width:100%;height:100vh;height:100dvh;min-height:100vh;min-height:100dvh;max-width:none;margin:0;border:0;border-radius:0;background:var(--report-bg);overflow:hidden;box-shadow:none;}",
		".report-sidebar{width:240px;box-sizing:border-box;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--report-rule);background:var(--report-panel);padding:24px;}",
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
		".report-content{flex:1;min-width:0;height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;box-sizing:border-box;overflow-y:auto;padding:32px 48px;scroll-behavior:smooth;}",
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
		".honesty-marker-block{display:flex;align-items:center;gap:10px;margin:16px 0;}",
		".honesty-marker-message{color:var(--report-muted);font-size:13px;line-height:1.5;}",
		".honesty-tooltip{position:fixed;top:var(--tooltip-top,0);left:var(--tooltip-left,50vw);z-index:120;width:300px;max-width:min(300px,calc(100vw - 32px));box-sizing:border-box;border:1px solid var(--report-tooltip-border);border-radius:6px;background:var(--report-tooltip-bg);box-shadow:0 10px 30px rgba(0,0,0,.22);color:var(--report-tooltip-text);opacity:0;visibility:hidden;padding:8px 12px;pointer-events:none;text-align:left;transform:var(--tooltip-transform,translate(-50%,-100%));transition:opacity .15s ease;white-space:normal;font-size:12px;font-weight:400;line-height:1.5;}",
		'.honesty-tooltip::after{content:"";position:absolute;top:100%;left:50%;border:6px solid transparent;border-top-color:var(--report-tooltip-bg);transform:translateX(-50%);}',
		".honesty-tooltip.tooltip-below::after{top:auto;bottom:100%;border-top-color:transparent;border-bottom-color:var(--report-tooltip-bg);}",
		".honesty-marker:hover .honesty-tooltip,.honesty-marker:focus .honesty-tooltip{opacity:1;visibility:visible;}",
		".honesty-tooltip strong{display:block;margin-bottom:4px;font-weight:600;color:var(--report-tooltip-text);}",
		".honesty-tooltip-code{display:block;margin-top:4px;color:var(--report-tooltip-muted);font-size:11px;}",
		"pre{white-space:pre-wrap;background:var(--report-panel);padding:12px;overflow-wrap:anywhere;}",
		"table{width:100%;border-collapse:collapse;font-size:.92rem;}",
		"th,td{border-bottom:1px solid var(--report-rule);padding:7px;text-align:left;vertical-align:top;}",
		"th{background:var(--report-panel);}td.numeric{text-align:right;}",
		".chart-figure svg{max-width:100%;height:auto;}",
		".report-figure{margin:22px 0 26px;}",
		".report-figure img{display:block;width:100%;height:auto;border-radius:6px;}",
		".figure-caption{margin-top:8px;color:var(--report-muted);font-size:13px;line-height:1.5;}",
		".figure-source{margin:4px 0 0;color:var(--report-muted);font-size:12px;}",
		".image-placeholder{border:1px solid var(--report-rule);background:var(--report-panel);padding:18px;}",
		".inline-source-chips{display:inline-flex;align-items:center;gap:4px;margin-left:4px;vertical-align:middle;}",
		"p.inline-source-chips{display:flex;gap:8px;margin:.5rem 0 1rem;}",
		".source-chip{display:inline-flex;align-items:center;justify-content:center;position:relative;width:16px;height:16px;margin-left:2px;vertical-align:middle;color:var(--report-muted);text-decoration:none;cursor:pointer;transition:transform .1s ease;}",
		".source-chip:hover,.source-chip:focus{outline:none;}",
		".source-favicon,.source-chip img,.favicon-placeholder{display:block;width:16px;height:16px;border-radius:3px;}",
		".source-chip img{object-fit:cover;}",
		".favicon-placeholder{box-sizing:border-box;background:var(--report-accent);color:#fff;padding:2px;}",
		"[hidden]{display:none!important;}",
		".favicon-placeholder svg{display:block;width:100%;height:100%;}",
		".source-tooltip{position:fixed;top:var(--tooltip-top,0);left:var(--tooltip-left,50vw);z-index:120;width:280px;max-width:min(280px,calc(100vw - 32px));box-sizing:border-box;border:1px solid var(--report-tooltip-border);border-radius:6px;background:var(--report-tooltip-bg);box-shadow:0 10px 30px rgba(0,0,0,.22);color:var(--report-tooltip-text);opacity:0;visibility:hidden;padding:8px 10px;pointer-events:none;text-align:left;transform:var(--tooltip-transform,translate(-50%,-100%));transition:opacity .15s ease;}",
		'.source-tooltip::after{content:"";position:absolute;top:100%;left:50%;border:6px solid transparent;border-top-color:var(--report-tooltip-bg);transform:translateX(-50%);}',
		".source-tooltip.tooltip-below::after{top:auto;bottom:100%;border-top-color:transparent;border-bottom-color:var(--report-tooltip-bg);}",
		".source-chip:hover .source-tooltip,.source-chip:focus .source-tooltip{opacity:1;visibility:visible;}",
		".source-tooltip-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}",
		".source-tooltip-title{min-width:0;overflow:hidden;color:var(--report-tooltip-text);font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;}",
		".source-tooltip-reason,.source-tooltip-domain{display:block;color:var(--report-tooltip-muted);font-size:11px;line-height:1.4;}",
		".source-tooltip-domain{margin-top:4px;}",
		".source-subheading{margin:20px 0 8px;color:var(--report-muted);font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}",
		".source-subheading + .source-list + .source-subheading{margin-top:32px;}",
		".source-list{display:flex;flex-direction:column;gap:8px;list-style:none;margin:0;padding:0;}",
		".source-item{display:flex;align-items:center;gap:8px;padding:8px 0;color:var(--report-text);font-size:13px;line-height:1.45;}",
		".source-item a,.source-title{color:var(--report-text);font-weight:600;text-decoration:none;}",
		".source-item a:hover{text-decoration:underline;}",
		".source-domain,.source-provided{color:var(--report-muted);font-size:12px;}",
		"hr{border:0;border-top:1px solid var(--report-rule);margin:24px 0;}",
		"@media (max-width: 760px){body{padding:0;}.report-viewer{display:block;height:100vh;height:100dvh;min-height:100vh;min-height:100dvh;border:0;border-radius:0;}.mobile-report-header{display:flex;}.report-sidebar{position:fixed;top:0;left:0;z-index:90;height:100vh;height:100dvh;width:260px!important;box-sizing:border-box;border-right:1px solid var(--report-rule);box-shadow:0 16px 40px rgba(0,0,0,.18);transform:translateX(-100%);transition:transform .25s ease;}.report-sidebar-resizer{display:none;}.report-sidebar.open{transform:translateX(0);}.sidebar-backdrop.open{display:block;}.report-content{height:calc(100vh - 63px);height:calc(100dvh - 63px);max-height:calc(100vh - 63px);max-height:calc(100dvh - 63px);padding:24px;}.report-title{font-size:24px;}}",
		"</style>",
		"</head>",
		'<body><div class="report-viewer" id="report-viewer">',
		headingEntries.length > 0
			? `<aside class="report-sidebar" id="report-sidebar" aria-label="${escapeHtml(chrome.reportSectionsLabel)}"><p class="report-sidebar-title">${escapeHtml(chrome.sections)}</p><ul class="report-nav">${headingEntries
					.map(
						(entry) =>
							`<li><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`,
					)
					.join("")}</ul></aside>`
			: `<aside class="report-sidebar" id="report-sidebar" aria-label="${escapeHtml(chrome.reportSectionsLabel)}"></aside>`,
		`<div class="report-sidebar-resizer" id="report-sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(chrome.resizeReportSidebar)}" tabindex="0"></div>`,
		'<div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>',
		`<div class="mobile-report-header"><button type="button" class="mobile-menu-btn" id="mobile-menu-btn" aria-label="${escapeHtml(chrome.openSectionMenu)}" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h16"></path></svg></button><p class="mobile-report-title">${escapeHtml(chrome.sections)}</p></div>`,
		'<article class="report-content" id="report-content">',
		`<h1 class="report-title">${escapeHtml(source.title)}</h1>`,
		source.subtitle
			? `<p class="subtitle">${escapeHtml(source.subtitle)}</p>`
			: "",
		renderReportContent(blockEntries, sourceIndex, chrome),
		"</article></div>",
		"<script>",
		"(() => { const sidebar = document.getElementById('report-sidebar'); const backdrop = document.getElementById('sidebar-backdrop'); const button = document.getElementById('mobile-menu-btn'); if (!sidebar || !backdrop || !button) return; const close = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); }; const open = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); button.setAttribute('aria-expanded', 'true'); }; button.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open()); backdrop.addEventListener('click', close); sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', close)); })();",
		"(() => { const reportContent = document.getElementById('report-content'); const reportNavLinks = Array.from(document.querySelectorAll('.report-nav a')); const reportSections = Array.from(document.querySelectorAll('.report-section[id]')); if (!reportContent || reportNavLinks.length === 0 || reportSections.length === 0) return; function updateActiveSection() { const contentRect = reportContent.getBoundingClientRect(); const threshold = contentRect.top + Math.min(160, contentRect.height * 0.35); const atScrollEnd = reportContent.scrollTop + reportContent.clientHeight >= reportContent.scrollHeight - 32; let activeId = atScrollEnd ? reportSections[reportSections.length - 1].id : reportSections[0].id; if (!atScrollEnd) { reportSections.forEach((section) => { const rect = section.getBoundingClientRect(); if (rect.top <= threshold && rect.bottom > contentRect.top + 8) activeId = section.id; }); } reportNavLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === '#' + activeId)); } reportContent.addEventListener('scroll', updateActiveSection, { passive: true }); reportNavLinks.forEach((link) => link.addEventListener('click', () => window.setTimeout(updateActiveSection, 120))); updateActiveSection(); })();",
		"(() => { const sidebar = document.getElementById('report-sidebar'); const resizer = document.getElementById('report-sidebar-resizer'); if (!sidebar || !resizer) return; const minWidth = 180; const maxWidth = 380; const clampWidth = (width) => Math.max(minWidth, Math.min(maxWidth, width)); function positionReportSidebar(width) { sidebar.style.width = clampWidth(width) + 'px'; } let startX = 0; let startWidth = 0; const onMove = (event) => positionReportSidebar(startWidth + event.clientX - startX); const stopResize = () => { document.documentElement.classList.remove('is-resizing-report-sidebar'); window.removeEventListener('pointermove', onMove); }; resizer.addEventListener('pointerdown', (event) => { if (window.matchMedia('(max-width: 760px)').matches) return; event.preventDefault(); startX = event.clientX; startWidth = sidebar.getBoundingClientRect().width; document.documentElement.classList.add('is-resizing-report-sidebar'); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', stopResize, { once: true }); window.addEventListener('pointercancel', stopResize, { once: true }); }); resizer.addEventListener('keydown', (event) => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); const delta = event.key === 'ArrowLeft' ? -16 : 16; positionReportSidebar(sidebar.getBoundingClientRect().width + delta); }); })();",
		"(() => { const reportContent = document.getElementById('report-content'); const reportSidebar = document.getElementById('report-sidebar'); const triggers = Array.from(document.querySelectorAll('.source-chip,.honesty-marker')); function sidebarSafeLeft() { if (!reportSidebar || window.matchMedia('(max-width: 760px)').matches) return 12; const rect = reportSidebar.getBoundingClientRect(); return rect.width > 0 ? Math.max(12, rect.right + 12) : 12; } function positionFloatingTooltips(trigger) { const tooltip = trigger.querySelector('.source-tooltip,.honesty-tooltip'); if (!tooltip) return; tooltip.classList.remove('tooltip-below'); const triggerRect = trigger.getBoundingClientRect(); const tooltipRect = tooltip.getBoundingClientRect(); const margin = 12; const tooltipWidth = Math.min(tooltipRect.width || 280, window.innerWidth - margin * 2); const tooltipHeight = tooltipRect.height || 80; const minLeft = sidebarSafeLeft(); const maxLeft = window.innerWidth - margin; let left = triggerRect.left + triggerRect.width / 2; left = Math.max(minLeft + tooltipWidth / 2, Math.min(maxLeft - tooltipWidth / 2, left)); let top = triggerRect.top - margin; let transform = 'translate(-50%,-100%)'; if (top - tooltipHeight < margin) { top = triggerRect.bottom + margin; transform = 'translate(-50%,0)'; tooltip.classList.add('tooltip-below'); } tooltip.style.setProperty('--tooltip-left', left + 'px'); tooltip.style.setProperty('--tooltip-top', top + 'px'); tooltip.style.setProperty('--tooltip-transform', transform); } function positionVisibleTooltips() { document.querySelectorAll('.source-chip:hover,.source-chip:focus,.honesty-marker:hover,.honesty-marker:focus').forEach((trigger) => positionFloatingTooltips(trigger)); } triggers.forEach((trigger) => { trigger.addEventListener('mouseenter', () => positionFloatingTooltips(trigger)); trigger.addEventListener('focus', () => positionFloatingTooltips(trigger)); }); reportContent?.addEventListener('scroll', positionVisibleTooltips, { passive: true }); window.addEventListener('resize', positionVisibleTooltips); })();",
		"</script>",
		"</body></html>",
	].join("");

	return {
		filename: slugifyFilename(source.title, "html"),
		mimeType: "text/html",
		content: Buffer.from(html, "utf8"),
	};
}
