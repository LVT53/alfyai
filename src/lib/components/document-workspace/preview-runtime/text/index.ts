import { escapeHtml, sanitizeHtml } from "$lib/utils/html-sanitizer";
import {
	renderHighlightedText,
	renderMarkdown,
} from "$lib/utils/markdown-loader";
import type { PreviewRuntimeAdapter } from "../index";

type TextRuntimeAdapter = Extract<PreviewRuntimeAdapter, { kind: "text" }>;
type HtmlRuntimeAdapter = Extract<PreviewRuntimeAdapter, { kind: "html" }>;

export type TextPreviewRenderResult =
	| {
			kind: "csv" | "markdown" | "highlighted";
			html: string;
	  }
	| {
			kind: "html";
			srcdoc: string;
			trustedRuntime: boolean;
	  };

const TRUSTED_HTML_RUNTIME_CSP =
	"default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";

export async function renderTextPreview(
	adapter: TextRuntimeAdapter | HtmlRuntimeAdapter,
	options: { isDark?: boolean } = {},
): Promise<TextPreviewRenderResult> {
	if (adapter.kind === "html") {
		const trustedRuntime = adapter.trustedRuntime === true;
		return {
			kind: "html",
			srcdoc: trustedRuntime
				? buildTrustedHtmlPreviewSrcdoc(adapter.text)
				: buildStaticHtmlPreviewSrcdoc(adapter.text),
			trustedRuntime,
		};
	}

	if (adapter.textKind === "csv") {
		return {
			kind: "csv",
			html: renderCsvPreviewHtml(adapter.text),
		};
	}

	if (adapter.textKind === "markdown") {
		return {
			kind: "markdown",
			html: await renderMarkdownPreviewHtml(adapter.text, options),
		};
	}

	return {
		kind: "highlighted",
		html: await renderHighlightedPreviewHtml(
			adapter.text,
			adapter.language,
			options,
		),
	};
}

export function renderCsvPreviewHtml(csvText: string): string {
	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentCell = "";
	let inQuotes = false;

	for (let i = 0; i < csvText.length; i++) {
		const char = csvText[i];
		const nextChar = csvText[i + 1];

		if (inQuotes) {
			if (char === '"' && nextChar === '"') {
				currentCell += '"';
				i++;
			} else if (char === '"') {
				inQuotes = false;
			} else {
				currentCell += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			currentRow.push(currentCell);
			currentCell = "";
		} else if (char === "\r" && nextChar === "\n") {
			currentRow.push(currentCell);
			rows.push(currentRow);
			currentRow = [];
			currentCell = "";
			i++;
		} else if (char === "\n" || char === "\r") {
			currentRow.push(currentCell);
			rows.push(currentRow);
			currentRow = [];
			currentCell = "";
		} else {
			currentCell += char;
		}
	}

	currentRow.push(currentCell);
	if (currentRow.length > 1 || currentRow[0] !== "" || rows.length === 0) {
		rows.push(currentRow);
	}

	let html = '<table class="csv-table">';
	for (const row of rows) {
		html += "<tr>";
		for (const cell of row) {
			html += `<td>${escapeHtml(cell)}</td>`;
		}
		html += "</tr>";
	}
	html += "</table>";
	return html;
}

async function renderMarkdownPreviewHtml(
	content: string,
	options: { isDark?: boolean } = {},
): Promise<string> {
	return renderMarkdown(content, options.isDark ?? false);
}

async function renderHighlightedPreviewHtml(
	content: string,
	language: string | undefined,
	options: { isDark?: boolean } = {},
): Promise<string> {
	return renderHighlightedText(
		content,
		language ?? "",
		options.isDark ?? false,
	);
}

export function buildStaticHtmlPreviewSrcdoc(content: string): string {
	const { html, css } = extractLocalStyleBlocks(content);
	const safeHtml = sanitizeHtml(html, {
		allowStyleAttributes: true,
	});
	const safeCss = sanitizeLocalCss(css);
	const safeHtmlWithSafeInlineStyles = sanitizeInlineStyleAttributes(safeHtml);
	const styleBlock = safeCss ? `<style>${safeCss}</style>` : "";
	return `<!doctype html><html><head><base target="_blank"><meta charset="utf-8">${styleBlock}</head><body>${safeHtmlWithSafeInlineStyles}</body></html>`;
}

export function buildTrustedHtmlPreviewSrcdoc(content: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${TRUSTED_HTML_RUNTIME_CSP}" />`;
	if (/<\/head\s*>/i.test(content)) {
		return content.replace(/<\/head\s*>/i, `${meta}</head>`);
	}

	if (/<html\b/i.test(content)) {
		return content.replace(/<html\b([^>]*)>/i, `<html$1><head>${meta}</head>`);
	}

	return `<!doctype html><html><head>${meta}</head><body>${content}</body></html>`;
}

function extractLocalStyleBlocks(content: string): {
	html: string;
	css: string;
} {
	let css = "";
	const html = content.replace(
		/<style\b[^>]*>([\s\S]*?)<\/style>/gi,
		(_match, styleContent: string) => {
			css += `\n${styleContent}`;
			return "";
		},
	);
	return { html, css };
}

function sanitizeLocalCss(css: string): string {
	return css
		.replace(/@import[^;]+;?/gi, "")
		.replace(/(?:-webkit-)?image-set\s*\([^)]*\)/gi, "none")
		.replace(/url\s*\([^)]*\)/gi, "none")
		.replace(/expression\s*\([^)]*\)/gi, "")
		.replace(/javascript:/gi, "")
		.replace(/[<>]/g, "")
		.trim();
}

function sanitizeInlineStyleAttributes(html: string): string {
	if (!html.includes("style=") || typeof document === "undefined") {
		return html;
	}

	const template = document.createElement("template");
	template.innerHTML = html;

	for (const element of template.content.querySelectorAll<HTMLElement>(
		"[style]",
	)) {
		const safeStyle = sanitizeLocalCss(element.getAttribute("style") ?? "");
		if (safeStyle) {
			element.setAttribute("style", safeStyle);
		} else {
			element.removeAttribute("style");
		}
	}

	return template.innerHTML;
}
