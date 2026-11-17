import { escapeHtml, sanitizeHtml } from "$lib/utils/html-sanitizer";
import {
	renderHighlightedText,
	renderMarkdown,
} from "$lib/utils/markdown-loader";
import type { PreviewRuntimeAdapter, TextPreviewKind } from "../index";

type TextRuntimeAdapter = Extract<PreviewRuntimeAdapter, { kind: "text" }>;
type HtmlRuntimeAdapter = Extract<PreviewRuntimeAdapter, { kind: "html" }>;

export type TextPreviewRenderResult =
	// One vocabulary: the renderer answers with the kind the runtime asked for
	// (`TextPreviewKind`), plus the html case this module handles on its own.
	| {
			kind: TextPreviewKind;
			html: string;
	  }
	| {
			kind: "html";
			srcdoc: string;
			trustedRuntime: boolean;
	  };

// The report's own policy as a meta tag (ADR-0068): pictures from itself only,
// like the header `file-serving-response-policy.ts` serves it with.
const TRUSTED_HTML_RUNTIME_CSP =
	"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";

export type TextPreviewOptions = {
	isDark?: boolean;
	/**
	 * Read aloud's bridge (`reportBridgeScript` in `$lib/client/read-aloud/report-bridge.ts`):
	 * the one script of the app's own a report's frame runs, added to a trusted
	 * report's srcdoc and never to a static one.
	 */
	readAloudBridge?: string;
};

export async function renderTextPreview(
	adapter: TextRuntimeAdapter | HtmlRuntimeAdapter,
	options: TextPreviewOptions = {},
): Promise<TextPreviewRenderResult> {
	if (adapter.kind === "html") {
		const trustedRuntime = adapter.trustedRuntime === true;
		return {
			kind: "html",
			srcdoc: trustedRuntime
				? buildTrustedHtmlPreviewSrcdoc(adapter.text, options.readAloudBridge)
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

/**
 * A trusted report as its frame's srcdoc: its own policy as a meta tag in its
 * head and, when one is given, read aloud's bridge as the last thing in its body.
 * Only this srcdoc ever carries the bridge (`buildStaticHtmlPreviewSrcdoc` takes
 * none, and its frame runs no script).
 */
export function buildTrustedHtmlPreviewSrcdoc(
	content: string,
	bridge = "",
): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${TRUSTED_HTML_RUNTIME_CSP}" />`;
	let srcdoc: string;
	if (/<\/head\s*>/i.test(content)) {
		srcdoc = content.replace(/<\/head\s*>/i, `${meta}</head>`);
	} else if (/<html\b/i.test(content)) {
		srcdoc = content.replace(
			/<html\b([^>]*)>/i,
			`<html$1><head>${meta}</head>`,
		);
	} else {
		srcdoc = `<!doctype html><html><head>${meta}</head><body>${content}</body></html>`;
	}
	return bridge === "" ? srcdoc : insertBeforeLastClose(srcdoc, bridge);
}

/**
 * `insert` put before the document's last `</body>`, else its last `</html>`,
 * else at its end. By slicing, never by `String.replace`, whose `$&`, `$1` and
 * `` $` `` patterns would change what is inserted.
 */
function insertBeforeLastClose(html: string, insert: string): string {
	for (const close of [/<\/body\s*>/gi, /<\/html\s*>/gi]) {
		let at = -1;
		for (const match of html.matchAll(close)) at = match.index;
		if (at !== -1) return html.slice(0, at) + insert + html.slice(at);
	}
	return html + insert;
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
