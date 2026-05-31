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
	  };

export async function renderTextPreview(
	adapter: TextRuntimeAdapter | HtmlRuntimeAdapter,
	options: { isDark?: boolean } = {},
): Promise<TextPreviewRenderResult> {
	if (adapter.kind === "html") {
		return {
			kind: "html",
			srcdoc: buildStaticHtmlPreviewSrcdoc(adapter.text),
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

export async function renderMarkdownPreviewHtml(
	content: string,
	options: { isDark?: boolean } = {},
): Promise<string> {
	return renderMarkdown(content, options.isDark ?? false);
}

export async function renderHighlightedPreviewHtml(
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
	const styleBlock = safeCss ? `<style>${safeCss}</style>` : "";
	return `<!doctype html><html><head><base target="_blank"><meta charset="utf-8">${styleBlock}</head><body>${safeHtml}</body></html>`;
}

export function extractLocalStyleBlocks(content: string): {
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

export function sanitizeLocalCss(css: string): string {
	return css
		.replace(/@import[^;]+;?/gi, "")
		.replace(/url\s*\([^)]*\)/gi, "none")
		.replace(/expression\s*\([^)]*\)/gi, "")
		.replace(/javascript:/gi, "")
		.replace(/[<>]/g, "")
		.trim();
}
