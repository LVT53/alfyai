import { escapeHtml, sanitizeHtml } from "$lib/utils/html-sanitizer";

type MarkedModule = typeof import("marked");
type Highlighter = Awaited<
	ReturnType<
		ReturnType<typeof import("shiki/core")["createBundledHighlighter"]>
	>
>;

type RenderMarkdownOptions = {
	compactExternalLinks?: boolean;
};

const HIGHLIGHT_LANGS = {
	javascript: () => import("@shikijs/langs/javascript"),
	typescript: () => import("@shikijs/langs/typescript"),
	jsx: () => import("@shikijs/langs/jsx"),
	tsx: () => import("@shikijs/langs/tsx"),
	python: () => import("@shikijs/langs/python"),
	bash: () => import("@shikijs/langs/bash"),
	json: () => import("@shikijs/langs/json"),
	html: () => import("@shikijs/langs/html"),
	css: () => import("@shikijs/langs/css"),
	yaml: () => import("@shikijs/langs/yaml"),
	markdown: () => import("@shikijs/langs/markdown"),
	ruby: () => import("@shikijs/langs/ruby"),
	rust: () => import("@shikijs/langs/rust"),
	go: () => import("@shikijs/langs/go"),
	java: () => import("@shikijs/langs/java"),
	kotlin: () => import("@shikijs/langs/kotlin"),
	swift: () => import("@shikijs/langs/swift"),
	csharp: () => import("@shikijs/langs/csharp"),
	cpp: () => import("@shikijs/langs/cpp"),
	php: () => import("@shikijs/langs/php"),
	sql: () => import("@shikijs/langs/sql"),
	graphql: () => import("@shikijs/langs/graphql"),
	dockerfile: () => import("@shikijs/langs/dockerfile"),
	toml: () => import("@shikijs/langs/toml"),
	xml: () => import("@shikijs/langs/xml"),
	r: () => import("@shikijs/langs/r"),
} as const;

const HIGHLIGHT_THEMES = ["github-light", "github-dark"] as const;
const SUPPORTED_LANGUAGES = new Set(Object.keys(HIGHLIGHT_LANGS));

let markedModule: MarkedModule | null = null;
let markedPromise: Promise<void> | null = null;
let highlighter: Highlighter | null = null;
let highlighterPromise: Promise<void> | null = null;
const loadedLanguages = new Set<string>();
const languagePromises = new Map<string, Promise<void>>();

async function initMarkdownParser() {
	if (markedModule) return;

	if (!markedPromise) {
		markedPromise = (async () => {
			markedModule = await import("marked");
		})();
	}

	await markedPromise;
}

function getMarked() {
	if (!markedModule) {
		throw new Error("Markdown parser was not initialized");
	}

	return markedModule.marked;
}

async function initHighlighter() {
	if (highlighter) return;

	if (!highlighterPromise) {
		highlighterPromise = (async () => {
			const [{ createBundledHighlighter }, { createJavaScriptRegexEngine }] =
				await Promise.all([
					import("shiki/core"),
					import("shiki/engine/javascript"),
				]);

			const createHighlighter = createBundledHighlighter({
				langs: HIGHLIGHT_LANGS,
				themes: {
					"github-light": () => import("@shikijs/themes/github-light"),
					"github-dark": () => import("@shikijs/themes/github-dark"),
				},
				engine: () => createJavaScriptRegexEngine(),
			});

			highlighter = await createHighlighter({
				langs: Object.keys(HIGHLIGHT_LANGS) as Array<
					keyof typeof HIGHLIGHT_LANGS
				>,
				themes: [...HIGHLIGHT_THEMES],
			});
		})();
	}

	await highlighterPromise;
}

function normalizeLanguage(lang: string): string {
	const aliases: Record<string, string> = {
		js: "javascript",
		ts: "typescript",
		py: "python",
		sh: "bash",
		shell: "bash",
		zsh: "bash",
		yml: "yaml",
		md: "markdown",
		jsx: "jsx",
		tsx: "tsx",
		rb: "ruby",
		rs: "rust",
		cs: "csharp",
		cpp: "cpp",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		sql: "sql",
		graphql: "graphql",
		dockerfile: "dockerfile",
		toml: "toml",
		xml: "xml",
		php: "php",
		r: "r",
	};
	return aliases[lang.toLowerCase()] ?? lang.toLowerCase();
}

async function ensureLanguageLoaded(language: string | undefined) {
	if (!language?.trim()) return;

	const normalized = normalizeLanguage(language);
	if (!SUPPORTED_LANGUAGES.has(normalized)) return;

	await initHighlighter();

	const activeHighlighter = highlighter;
	if (!activeHighlighter) return;

	if (loadedLanguages.has(normalized)) return;

	let loadPromise = languagePromises.get(normalized);
	if (!loadPromise) {
		loadPromise = activeHighlighter.loadLanguage(normalized).then(() => {
			loadedLanguages.add(normalized);
		});
		languagePromises.set(normalized, loadPromise);
	}

	await loadPromise;
}

function extractFenceLanguages(content: string): string[] {
	const languages = new Set<string>();
	const fencePattern = /^\s*```\s*([^\s`]*)\s*$/gm;

	for (const match of content.matchAll(fencePattern)) {
		if (match[1]) {
			languages.add(match[1]);
		}
	}

	return [...languages];
}

async function prepareCodeHighlighting(content: string) {
	const languages = extractFenceLanguages(content);
	if (!languages.length) return;

	await Promise.all(
		languages.map((language) => ensureLanguageLoaded(language)),
	);
}

async function renderHighlightedText(
	content: string,
	language: string | undefined,
	isDark: boolean,
): Promise<string> {
	const normalized = language?.trim() ? normalizeLanguage(language) : undefined;

	if (normalized && SUPPORTED_LANGUAGES.has(normalized)) {
		await ensureLanguageLoaded(normalized);
	}

	return renderCodeBlock(content, normalized, isDark);
}

async function renderMarkdown(
	content: string,
	isDark: boolean,
	options: RenderMarkdownOptions = {},
): Promise<string> {
	await initMarkdownParser();
	if (content.includes("```")) {
		await prepareCodeHighlighting(content);
	}

	const marked = getMarked();
	const frontmatter = await extractFrontmatter(content);
	const displayContent = normalizeMarkdownContent(frontmatter.content);
	const renderer = createMarkdownRenderer(isDark, options);
	const html = marked.parse(displayContent, {
		renderer: renderer as Parameters<typeof marked.parse>[1]["renderer"],
		breaks: true,
		gfm: true,
	});

	return sanitizeHtml(
		`${frontmatter.html}${transformCalloutHtml(wrapMarkdownTables(html as string))}`,
		{ allowStyleAttributes: true },
	);
}

function renderCodeBlock(
	content: string,
	language: string | undefined,
	isDark: boolean,
): string {
	const escapedContent = escapeHtml(content, { apostropheEntity: "&#039;" });

	if (!highlighter || !language?.trim()) {
		return sanitizeHtml(`<pre><code>${escapedContent}</code></pre>`);
	}

	const normalized = normalizeLanguage(language);

	try {
		const theme = isDark ? "github-dark" : "github-light";
		return highlighter.codeToHtml(content, { lang: normalized, theme });
	} catch {
		return sanitizeHtml(`<pre><code>${escapedContent}</code></pre>`);
	}
}

function normalizeMarkdownContent(content: string): string {
	if (content.startsWith("[Translation unavailable]")) {
		return content.substring("[Translation unavailable]".length).trimStart();
	}

	return content;
}

function wrapMarkdownTables(html: string): string {
	return html
		.replace(
			/<table>/g,
			'<div class="markdown-table-wrap"><table class="markdown-table">',
		)
		.replace(/<\/table>/g, "</table></div>");
}

async function extractFrontmatter(
	content: string,
): Promise<{ content: string; html: string }> {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return { content, html: "" };
	}

	const endMatch = content.match(/\r?\n---\s*(?:\r?\n|$)/);
	if (endMatch?.index === undefined) {
		return { content, html: "" };
	}

	const startOffset = content.startsWith("---\r\n") ? 5 : 4;
	const header = content.slice(startOffset, endMatch.index);
	const bodyStart = endMatch.index + endMatch[0].length;
	const data = parseFrontmatterHeader(header);
	const entries = Object.entries(data).filter(
		([, value]) => value !== undefined && value !== null && value !== "",
	);

	if (entries.length === 0) {
		return { content: content.slice(bodyStart), html: "" };
	}

	const rows = entries
		.map(([key, value]) => {
			const label = escapeHtml(key);
			const renderedValue = Array.isArray(value)
				? value.map((entry) => escapeHtml(String(entry))).join(", ")
				: escapeHtml(String(value));
			return `<div class="markdown-frontmatter-row"><dt>${label}</dt><dd>${renderedValue}</dd></div>`;
		})
		.join("");

	return {
		content: content.slice(bodyStart),
		html: `<aside class="markdown-frontmatter" aria-label="Document metadata"><dl>${rows}</dl></aside>`,
	};
}

function parseFrontmatterHeader(
	header: string,
): Record<string, string | string[]> {
	const data: Record<string, string | string[]> = {};
	let currentListKey: string | null = null;

	for (const rawLine of header.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim() || line.trimStart().startsWith("#")) continue;

		const listMatch = line.match(/^\s+-\s*(.+)$/);
		if (listMatch && currentListKey) {
			const currentValue = data[currentListKey];
			data[currentListKey] = [
				...(Array.isArray(currentValue)
					? currentValue
					: currentValue
						? [currentValue]
						: []),
				normalizeFrontmatterValue(listMatch[1]),
			];
			continue;
		}

		const keyMatch = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
		if (!keyMatch) {
			currentListKey = null;
			continue;
		}

		const [, key, rawValue] = keyMatch;
		currentListKey = key;
		data[key] = parseFrontmatterValue(rawValue);
	}

	return data;
}

function parseFrontmatterValue(value: string): string | string[] {
	const trimmed = value.trim();
	if (!trimmed) return "";

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((entry) => normalizeFrontmatterValue(entry))
			.filter(Boolean);
	}

	return normalizeFrontmatterValue(trimmed);
}

function normalizeFrontmatterValue(value: string): string {
	return value.trim().replace(/^['"]|['"]$/g, "");
}

function transformCalloutHtml(html: string): string {
	return html.replace(
		/<blockquote>\s*<p>\[!([A-Za-z][\w-]*)\]\s*([^<\n]*)(?:<br\s*\/?>)?([\s\S]*?)<\/p>([\s\S]*?)<\/blockquote>/g,
		(
			_match,
			rawType: string,
			rawTitle: string,
			firstParagraphBody: string,
			remainingBody: string,
		) => {
			const type = rawType.toLowerCase();
			const fallbackTitle = type.charAt(0).toUpperCase() + type.slice(1);
			const title = escapeHtml(rawTitle.trim() || fallbackTitle);
			const body = `${firstParagraphBody.trim() ? `<p>${firstParagraphBody}</p>` : ""}${remainingBody}`;
			return `<aside class="markdown-callout markdown-callout-${escapeHtml(type)}"><div class="markdown-callout-title">${title}</div><div class="markdown-callout-body">${body}</div></aside>`;
		},
	);
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function plainTextFromInlineTokens(tokens: unknown): string {
	if (!Array.isArray(tokens)) return "";

	return tokens
		.map((token) => {
			if (!token || typeof token !== "object") return "";

			const record = token as Record<string, unknown>;
			if (typeof record.text === "string") return record.text;
			if (Array.isArray(record.tokens)) {
				return plainTextFromInlineTokens(record.tokens);
			}
			return "";
		})
		.join("");
}

function sourceLabelFromLinkText(params: {
	href: string;
	parsedHref: URL;
	tokens: unknown;
}): string {
	const text = compactWhitespace(plainTextFromInlineTokens(params.tokens));

	if (
		!text ||
		text === params.href ||
		text === params.parsedHref.href ||
		/^https?:\/\//i.test(text)
	) {
		return params.parsedHref.hostname.replace(/^www\./i, "");
	}

	return text;
}

function renderSourceLinkChip(params: { href: string; sourceName: string }) {
	const sourceName = escapeHtml(params.sourceName);
	const href = escapeHtml(params.href);
	const ariaLabel = escapeHtml(
		`Open source: ${params.sourceName} - ${params.href}`,
	);

	return [
		`<a href="${href}" class="source-link-chip" target="_blank" rel="noopener noreferrer external" aria-label="${ariaLabel}">`,
		`<span class="source-link-chip__label">${sourceName}</span>`,
		'<span class="source-link-chip__icon" aria-hidden="true"></span>',
		"</a>",
	].join("");
}

function createMarkdownRenderer(
	isDark: boolean,
	options: RenderMarkdownOptions,
) {
	const marked = getMarked();
	const renderer = new marked.Renderer();

	renderer.code = ({ text, lang = "" }) => renderCodeBlock(text, lang, isDark);
	renderer.link = ({ href, title, tokens }) => {
		const text = renderer.parser.parseInline(tokens);
		if (!/^(https?:|mailto:)/i.test(href)) {
			return text;
		}

		let parsedHref: URL;
		try {
			parsedHref = new URL(href);
		} catch {
			return text;
		}

		if (!["http:", "https:", "mailto:"].includes(parsedHref.protocol)) {
			return text;
		}

		if (
			options.compactExternalLinks &&
			["http:", "https:"].includes(parsedHref.protocol)
		) {
			const sourceName = sourceLabelFromLinkText({
				href,
				parsedHref,
				tokens,
			});
			return renderSourceLinkChip({ href, sourceName });
		}

		const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
		return `<a href="${escapeHtml(href)}"${titleAttribute} target="_blank" rel="noopener noreferrer external">${text}</a>`;
	};

	return renderer;
}

export {
	initHighlighter,
	normalizeLanguage,
	prepareCodeHighlighting,
	type RenderMarkdownOptions,
	renderCodeBlock,
	renderHighlightedText,
	renderMarkdown,
};
