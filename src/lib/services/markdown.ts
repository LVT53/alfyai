import { escapeHtml, sanitizeHtml } from "$lib/utils/html-sanitizer";
import { stripPlainSourceReferenceMarkers } from "./stream-protocol";

type MarkedModule = typeof import("marked");
type Highlighter = Awaited<
	ReturnType<
		ReturnType<typeof import("shiki/core")["createBundledHighlighter"]>
	>
>;

type RenderMarkdownOptions = {
	compactExternalLinks?: boolean;
	sourceReferences?: SourceReferenceCandidate[];
};

type SourceReferenceCandidate = {
	label: string;
	href: string;
	sourceName?: string;
};

type InlineSourceReference = {
	href: string;
	sourceName: string;
};

type InlineSourceReferenceMap = Map<string, InlineSourceReference>;

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
	scss: () => import("@shikijs/langs/scss"),
	sass: () => import("@shikijs/langs/sass"),
	less: () => import("@shikijs/langs/less"),
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
	c: () => import("@shikijs/langs/c"),
	php: () => import("@shikijs/langs/php"),
	sql: () => import("@shikijs/langs/sql"),
	graphql: () => import("@shikijs/langs/graphql"),
	dockerfile: () => import("@shikijs/langs/dockerfile"),
	toml: () => import("@shikijs/langs/toml"),
	ini: () => import("@shikijs/langs/ini"),
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

			highlighter = (await createHighlighter({
				langs: Object.keys(HIGHLIGHT_LANGS) as Array<
					keyof typeof HIGHLIGHT_LANGS
				>,
				themes: [...HIGHLIGHT_THEMES],
			})) as Highlighter;
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
		cxx: "cpp",
		cc: "cpp",
		hpp: "cpp",
		c: "c",
		h: "c",
		go: "go",
		java: "java",
		kt: "kotlin",
		kts: "kotlin",
		swift: "swift",
		sql: "sql",
		gql: "graphql",
		graphql: "graphql",
		dockerfile: "dockerfile",
		toml: "toml",
		ini: "ini",
		env: "ini",
		conf: "ini",
		xml: "xml",
		scss: "scss",
		sass: "sass",
		less: "less",
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
	const sourceDisplayContent = options.compactExternalLinks
		? stripPlainSourceReferenceMarkers(displayContent)
		: displayContent;
	const inlineSourceReferences = options.compactExternalLinks
		? options.sourceReferences
			? inlineSourceReferenceMapFromCandidates(options.sourceReferences)
			: collectInlineSourceReferences(sourceDisplayContent, marked)
		: new Map<string, InlineSourceReference>();
	const renderer = createMarkdownRenderer(
		isDark,
		options,
		inlineSourceReferences,
	);
	const parseOptions = {
		renderer,
		breaks: true,
		gfm: true,
	} as Parameters<typeof marked.parse>[1];
	const html = marked.parse(sourceDisplayContent, parseOptions);

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

function parseExternalHref(href: string): URL | null {
	if (!/^(https?:|mailto:)/i.test(href)) {
		return null;
	}

	try {
		const parsedHref = new URL(href);
		if (!["http:", "https:", "mailto:"].includes(parsedHref.protocol)) {
			return null;
		}

		return parsedHref;
	} catch {
		return null;
	}
}

function isCompactSourceLink(parsedHref: URL): boolean {
	return ["http:", "https:"].includes(parsedHref.protocol);
}

async function collectSourceReferenceCandidates(
	content: string,
): Promise<SourceReferenceCandidate[]> {
	await initMarkdownParser();
	const marked = getMarked();
	const frontmatter = await extractFrontmatter(content);
	const displayContent = normalizeMarkdownContent(frontmatter.content);
	const sourceDisplayContent = stripPlainSourceReferenceMarkers(displayContent);
	const references = collectInlineSourceReferences(
		sourceDisplayContent,
		marked,
	);

	return [...references.entries()].map(([label, reference]) => ({
		label,
		href: reference.href,
		sourceName: reference.sourceName,
	}));
}

function collectInlineSourceReferences(
	content: string,
	marked: MarkedModule["marked"],
): InlineSourceReferenceMap {
	const references: InlineSourceReferenceMap = new Map();
	const tokens = marked.lexer(content, {
		breaks: true,
		gfm: true,
	});

	collectInlineSourceReferencesFromTokens(tokens, references);

	return references;
}

function collectInlineSourceReferencesFromTokens(
	tokens: unknown,
	references: InlineSourceReferenceMap,
) {
	if (Array.isArray(tokens)) {
		for (const token of tokens) {
			collectInlineSourceReferencesFromTokens(token, references);
		}
		return;
	}

	if (!tokens || typeof tokens !== "object") return;

	const token = tokens as Record<string, unknown>;
	if (
		token.type === "link" &&
		typeof token.href === "string" &&
		Array.isArray(token.tokens)
	) {
		const parsedHref = parseExternalHref(token.href);
		if (parsedHref && isCompactSourceLink(parsedHref)) {
			const sourceName = sourceLabelFromLinkText({
				href: token.href,
				parsedHref,
				tokens: token.tokens,
			});
			if (sourceName && !references.has(sourceName)) {
				references.set(sourceName, { href: token.href, sourceName });
			}
		}
	}

	for (const value of Object.values(token)) {
		if (Array.isArray(value)) {
			collectInlineSourceReferencesFromTokens(value, references);
		}
	}
}

function inlineSourceReferenceMapFromCandidates(
	candidates: SourceReferenceCandidate[],
): InlineSourceReferenceMap {
	const references: InlineSourceReferenceMap = new Map();

	for (const candidate of candidates) {
		const label = compactWhitespace(candidate.label);
		const href = candidate.href.trim();
		if (!label || !href || references.has(label)) continue;

		const parsedHref = parseExternalHref(href);
		if (!parsedHref || !isCompactSourceLink(parsedHref)) continue;

		const sourceName =
			compactWhitespace(candidate.sourceName ?? label) || label;
		references.set(label, { href, sourceName });
	}

	return references;
}

function sourceFaviconUrl(href: string): string | null {
	const parsedHref = parseExternalHref(href);
	if (!parsedHref) return null;
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsedHref.hostname)}&sz=32`;
}

function renderSourceLinkChip(params: { href: string; sourceName: string }) {
	const sourceName = escapeHtml(params.sourceName);
	const href = escapeHtml(params.href);
	const faviconUrl = sourceFaviconUrl(params.href);
	const ariaLabel = escapeHtml(
		`Open source: ${params.sourceName} - ${params.href}`,
	);

	return [
		`<a href="${href}" class="source-link-chip" target="_blank" rel="noopener noreferrer external" aria-label="${ariaLabel}">`,
		faviconUrl
			? `<img class="source-link-chip__favicon" src="${escapeHtml(faviconUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" onerror="this.style.display='none'">`
			: "",
		`<span class="source-link-chip__label">${sourceName}</span>`,
		'<span class="source-link-chip__icon" aria-hidden="true"></span>',
		"</a>",
	].join("");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createInlineSourceReferencePattern(
	references: InlineSourceReferenceMap,
): RegExp | null {
	const labels = [...references.keys()]
		.filter((label) => label.trim())
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);

	if (!labels.length) return null;

	return new RegExp(`\\((${labels.join("|")})\\)`, "g");
}

function renderTextSegment(value: string, escaped: boolean): string {
	return escaped ? value : escapeHtml(value);
}

function renderInlineSourceReferencesInText(params: {
	text: string;
	escaped: boolean;
	pattern: RegExp;
	references: InlineSourceReferenceMap;
}): string {
	let output = "";
	let cursor = 0;

	params.pattern.lastIndex = 0;
	for (const match of params.text.matchAll(params.pattern)) {
		const start = match.index ?? 0;
		const rawMatch = match[0];
		const label = match[1] ?? "";
		const reference = params.references.get(label);

		output += renderTextSegment(
			params.text.slice(cursor, start),
			params.escaped,
		);
		output += reference
			? renderSourceLinkChip(reference)
			: renderTextSegment(rawMatch, params.escaped);
		cursor = start + rawMatch.length;
	}

	output += renderTextSegment(params.text.slice(cursor), params.escaped);

	return output;
}

function createMarkdownRenderer(
	isDark: boolean,
	options: RenderMarkdownOptions,
	inlineSourceReferences: InlineSourceReferenceMap = new Map(),
) {
	const marked = getMarked();
	const renderer = new marked.Renderer();
	const defaultTextRenderer = renderer.text.bind(renderer);
	const inlineSourceReferencePattern = options.compactExternalLinks
		? createInlineSourceReferencePattern(inlineSourceReferences)
		: null;
	let linkTextDepth = 0;

	function renderLinkText(
		tokens: Parameters<typeof renderer.link>[0]["tokens"],
	) {
		linkTextDepth += 1;
		try {
			return renderer.parser.parseInline(tokens);
		} finally {
			linkTextDepth -= 1;
		}
	}

	renderer.code = ({ text, lang = "" }) => renderCodeBlock(text, lang, isDark);
	renderer.link = ({ href, title, tokens }) => {
		const text = renderLinkText(tokens);
		const parsedHref = parseExternalHref(href);
		if (!parsedHref) {
			return text;
		}

		if (options.compactExternalLinks && isCompactSourceLink(parsedHref)) {
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
	renderer.text = (token) => {
		if (
			!inlineSourceReferencePattern ||
			linkTextDepth > 0 ||
			token.type !== "text"
		) {
			return defaultTextRenderer(token);
		}

		if ("tokens" in token && Array.isArray(token.tokens)) {
			return renderer.parser.parseInline(token.tokens);
		}

		return renderInlineSourceReferencesInText({
			text: token.text,
			escaped: "escaped" in token && token.escaped === true,
			pattern: inlineSourceReferencePattern,
			references: inlineSourceReferences,
		});
	};

	return renderer;
}

export {
	collectSourceReferenceCandidates,
	initHighlighter,
	prepareCodeHighlighting,
	type RenderMarkdownOptions,
	renderCodeBlock,
	renderHighlightedText,
	renderMarkdown,
	type SourceReferenceCandidate,
};
