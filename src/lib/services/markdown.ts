import { isPhotoProxyPath } from "$lib/shared/artifacts/block-urls";
import {
	faviconRouteUrl,
	imageThumbnailRouteUrl,
	provenanceKey,
	readFaviconRouteUrl,
	readImageThumbnailRouteUrl,
	sourceHostOf,
	type ToolImage,
} from "$lib/shared/url-provenance";
import {
	escapeHtml,
	isRasterImageDataUri,
	type ResourceRequest,
	sanitizeHtml,
} from "$lib/utils/html-sanitizer";
import {
	classifyMarkdownBlocks,
	isChecklistLikeFenceBody,
	isFenceClosed,
	isPromotableChecklistFence,
	type MarkdownBlock,
	normalizeChecklistFenceBody,
} from "./markdown-blocks";
import { stripPlainSourceReferenceMarkers } from "./stream-protocol";

type MarkedModule = typeof import("marked");
type MarkedToken = ReturnType<MarkedModule["marked"]["lexer"]>[number];
type Highlighter = Awaited<
	ReturnType<
		ReturnType<typeof import("shiki/core")["createBundledHighlighter"]>
	>
>;

type RenderMarkdownOptions = {
	compactExternalLinks?: boolean;
	sourceReferences?: SourceReferenceCandidate[];
	/**
	 * What the message's image_search calls returned: the only pictures a reply may
	 * show, and then as Brave's thumbnail through the app's own route. Without them no
	 * picture from the web is shown (a preview, a history page).
	 */
	toolImages?: readonly ToolImage[];
	/**
	 * The hosts of what the message's tool calls returned: the only sites whose favicon
	 * a source chip asks the app's proxy for. Every other chip shows the globe at once.
	 */
	toolSourceHosts?: ReadonlySet<string>;
	/**
	 * What a chip says (as its title and its accessible name) where a picture was not
	 * loaded, in the reader's language, given the picture's words or its host.
	 */
	imageNotLoadedLabel?: (name: string) => string;
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

// Every class name this renderer writes, and Shiki, whose `<pre>` carries `shiki` and
// the theme's name and each of whose lines carries `line`. Model markup keeps these
// and no others (the sanitizer's `inert` option), so the app's global utility classes
// (`fixed inset-0 z-50`) are not there to borrow. A callout's type is the model's own
// word, in a namespace of its own. markdown.test.ts reads this file for every
// `class="…"` it writes, so a class added to the markup below that is not listed here
// fails there and not in front of a reader.
const RENDERED_CLASSES: ReadonlySet<string> = new Set([
	"markdown-frontmatter",
	"markdown-frontmatter-row",
	"markdown-callout",
	"markdown-callout-title",
	"markdown-callout-body",
	"markdown-table-wrap",
	"markdown-table",
	"markdown-image-frame",
	"markdown-image-frame--loading",
	"markdown-image",
	"source-link-chip",
	"source-link-chip__favicon-wrap",
	"source-link-chip__favicon",
	"source-link-chip__favicon-fallback",
	"source-link-chip__label",
	"source-link-chip__icon",
	"source-link-chip--image",
	"source-link-chip__image-icon",
	"source-link-chip__host",
	"shiki",
	"line",
	...HIGHLIGHT_THEMES,
]);
const CALLOUT_TYPE_CLASS = /^markdown-callout-[a-z][a-z0-9_-]*$/;

function isRenderedClass(name: string): boolean {
	return RENDERED_CLASSES.has(name) || CALLOUT_TYPE_CLASS.test(name);
}

/** What model markdown is sanitized with: in-flow content, and only our own classes. */
const INERT_MARKUP = { allowClass: isRenderedClass };

/**
 * What a reply may make the browser fetch on its own (docs/plans/exfil-channels): an
 * address comes from a tool's result, never from the model's words. The renderer
 * writes each such address itself, from this policy, and the sanitizer is handed the
 * same policy as its predicate, so raw HTML can ask for nothing the renderer would
 * not have written.
 */
type ResourcePolicy = {
	/** image_search's results, by the comparison form of their address and of their thumbnail's. */
	images: ReadonlyMap<string, ToolImage>;
	/** The thumbnails the app's route may be asked for. */
	thumbnails: ReadonlySet<string>;
	/** The hosts whose favicon a chip may ask for. */
	sourceHosts: ReadonlySet<string>;
};

function createResourcePolicy(options: RenderMarkdownOptions): ResourcePolicy {
	const images = new Map<string, ToolImage>();
	const thumbnails = new Set<string>();
	for (const image of options.toolImages ?? []) {
		if (image.thumbnail) thumbnails.add(image.thumbnail);
		for (const address of [image.url, image.thumbnail]) {
			const key = provenanceKey(address);
			// A picture a tool returned twice is shown by the result that has a thumbnail.
			if (key && !images.get(key)?.thumbnail) images.set(key, image);
		}
	}
	return {
		images,
		thumbnails,
		sourceHosts: options.toolSourceHosts ?? new Set(),
	};
}

/** The addresses the renderer writes into `<img src>` itself, and no other. */
function allowedResource(
	policy: ResourcePolicy,
): (request: ResourceRequest) => boolean {
	return ({ tag, attribute, address }) => {
		if (tag !== "img" || attribute !== "src") return false;
		if (isPhotoProxyPath(address)) return true;
		const thumbnail = readImageThumbnailRouteUrl(address);
		if (thumbnail) return policy.thumbnails.has(thumbnail);
		const host = readFaviconRouteUrl(address);
		return host !== null && policy.sourceHosts.has(host);
	};
}

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
	const policy = createResourcePolicy(options);
	const renderer = createMarkdownRenderer(
		isDark,
		options,
		policy,
		inlineSourceReferences,
	);
	const parseOptions = {
		renderer,
		breaks: true,
		gfm: true,
	} as Parameters<typeof marked.parse>[1];
	const html = marked.parse(sourceDisplayContent, parseOptions);

	return sanitizeHtml(
		`${frontmatter.html}${transformCalloutHtml(html as string)}`,
		{
			allowStyleAttributes: true,
			inert: INERT_MARKUP,
			allowResource: allowedResource(policy),
		},
	);
}

/**
 * Parse a markdown source string into the typed block model used by the chat
 * renderer. This is the single parse/split step (Tier A3 / B3): it owns fence
 * and block detection so `MarkdownRenderer.svelte` no longer re-scans for
 * fences. The caller renders each block through the registry.
 */
async function loadMarkdownBlocks(content: string): Promise<MarkdownBlock[]> {
	await initMarkdownParser();
	const marked = getMarked();
	const normalized = normalizeMarkdownContent(content);
	const lex = (source: string): MarkedToken[] =>
		marked.lexer(source, { breaks: true, gfm: true });
	return classifyMarkdownBlocks(rescueChecklistFences(lex(normalized), lex));
}

/**
 * Rescue checklists the model buried in a bare code fence. A closed, promotable
 * fence whose body reads as a checklist is normalized (bare `[ ]` → `- [ ]`) and
 * re-lexed in place, so its section labels become prose and its checkbox runs
 * become interactive task lists instead of a dead monospaced block. Every other
 * token passes through untouched. See markdown-blocks.ts for the shape checks.
 */
function rescueChecklistFences(
	tokens: MarkedToken[],
	lex: (source: string) => MarkedToken[],
): MarkedToken[] {
	const out: MarkedToken[] = [];
	for (const token of tokens) {
		if (
			token.type === "code" &&
			isFenceClosed(token.raw ?? "") &&
			isPromotableChecklistFence((token as { lang?: string }).lang) &&
			isChecklistLikeFenceBody((token as { text?: string }).text ?? "")
		) {
			const body = normalizeChecklistFenceBody(
				(token as { text?: string }).text ?? "",
			);
			out.push(...lex(body));
			continue;
		}
		out.push(token);
	}
	return out;
}

/**
 * Render a short inline markdown fragment (no wrapping block element) to
 * sanitized HTML. Used for interactive-checklist item bodies, whose text may
 * contain inline emphasis, code, or links.
 */
async function renderInlineMarkdown(
	content: string,
	isDark: boolean,
): Promise<string> {
	await initMarkdownParser();
	const marked = getMarked();
	const policy = createResourcePolicy({});
	const renderer = createMarkdownRenderer(isDark, {}, policy);
	const html = marked.parseInline(content, {
		renderer,
		breaks: true,
		gfm: true,
	} as Parameters<typeof marked.parseInline>[1]);
	return sanitizeHtml(html as string, {
		inert: INERT_MARKUP,
		allowResource: allowedResource(policy),
	});
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
		// Every HTML string this module returns goes through the sanitizer — this
		// branch used to be the one exception. Shiki escapes the code it
		// highlights, so there is no known injection today, but the guarantee
		// should not rest on a third-party renderer's escaping: a future Shiki
		// option or transformer that emitted markup would land in `{@html}`
		// unchecked. `allowStyleAttributes` is scoped to THIS call — the argument
		// is the highlighted-code container and nothing else — because Shiki
		// carries every colour as an inline `style` (and the CSS scrubbing hooks
		// that flag turns on run over those values). Legitimate output survives
		// byte-for-byte; see markdown.test.ts.
		return sanitizeHtml(
			highlighter.codeToHtml(content, { lang: normalized, theme }),
			{ allowStyleAttributes: true },
		);
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

function defaultImageNotLoadedLabel(name: string): string {
	return `Image not loaded: ${name}. Open the link to see it.`;
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

// Privacy proxy (ADR-0043): route source-chip favicons through the app's own
// same-origin `/api/favicon` endpoint instead of a third-party favicon service.
// The previous `www.google.com/s2/favicons` URL leaked every cited domain to
// Google on render. The proxy is itself a request nobody clicked, and its query
// names a host: a host the model chose (a link with private data in a subdomain)
// would hand that data to whoever runs the site, so only a host a tool returned
// gets one (docs/plans/exfil-channels). Preserves the null-on-parse-failure
// contract for non-web hrefs.
function sourceFaviconUrl(
	href: string,
	toolSourceHosts: ReadonlySet<string> | undefined,
): string | null {
	const host = sourceHostOf(href);
	return host !== null && toolSourceHosts?.has(host)
		? faviconRouteUrl(host)
		: null;
}

function renderSourceLinkChip(
	params: { href: string; sourceName: string },
	toolSourceHosts: ReadonlySet<string> | undefined,
) {
	const sourceName = escapeHtml(params.sourceName);
	const href = escapeHtml(params.href);
	const faviconUrl = sourceFaviconUrl(params.href, toolSourceHosts);
	const ariaLabel = escapeHtml(
		`Open source: ${params.sourceName} - ${params.href}`,
	);

	return [
		`<a href="${href}" class="source-link-chip" target="_blank" rel="noopener noreferrer external" aria-label="${ariaLabel}">`,
		// The globe is what a chip shows with no favicon to ask for, at once; with one it
		// stays hidden until the image fails (MarkdownRenderer reveals it).
		'<span class="source-link-chip__favicon-wrap" aria-hidden="true">',
		faviconUrl
			? `<img class="source-link-chip__favicon" src="${escapeHtml(faviconUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" aria-hidden="true">`
			: "",
		`<span class="source-link-chip__favicon-fallback" aria-hidden="true"${faviconUrl ? " hidden" : ""}></span>`,
		"</span>",
		`<span class="source-link-chip__label">${sourceName}</span>`,
		'<span class="source-link-chip__icon" aria-hidden="true"></span>',
		"</a>",
	].join("");
}

/**
 * The words that stand where a picture was not loaded: a link chip to the picture's
 * address, which the reader may open (a click is theirs to make) and which is never
 * fetched. Rendered like a source chip, with the picture's words (or its host), the
 * host, and a title and accessible name that say it was not loaded.
 */
function renderBlockedImage(params: {
	href: string;
	alt: string;
	imageNotLoadedLabel: (name: string) => string;
}): string {
	const host = sourceHostOf(params.href) ?? "";
	const words = compactWhitespace(params.alt) || host;
	const notice = escapeHtml(params.imageNotLoadedLabel(words));
	return [
		`<a href="${escapeHtml(params.href)}" class="source-link-chip source-link-chip--image" target="_blank" rel="noopener noreferrer external" title="${notice}" aria-label="${notice}">`,
		'<span class="source-link-chip__image-icon" aria-hidden="true"></span>',
		`<span class="source-link-chip__label">${escapeHtml(words)}</span>`,
		// A space between the two keeps them two words where no stylesheet lays them out.
		words === host
			? ""
			: ` <span class="source-link-chip__host">${escapeHtml(host)}</span>`,
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
	toolSourceHosts: ReadonlySet<string>;
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
			? renderSourceLinkChip(reference, params.toolSourceHosts)
			: renderTextSegment(rawMatch, params.escaped);
		cursor = start + rawMatch.length;
	}

	output += renderTextSegment(params.text.slice(cursor), params.escaped);

	return output;
}

function createMarkdownRenderer(
	isDark: boolean,
	options: RenderMarkdownOptions,
	policy: ResourcePolicy,
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
	// First-class table block: wrap the rendered table in the scroll container
	// (`markdown-table-wrap`) directly from the renderer instead of a regex
	// post-process over the whole document (Tier A3 / B3). Keeps the existing
	// overflow/scroll behaviour driven by MarkdownRenderer.enhanceRenderedTables.
	const defaultTableRenderer = renderer.table.bind(renderer);
	renderer.table = (token) => {
		const tableHtml = defaultTableRenderer(token).replace(
			"<table>",
			'<table class="markdown-table">',
		);
		return `<div class="markdown-table-wrap">${tableHtml}</div>`;
	};
	// Embedded images (C4): wrap every rendered image in a skeleton frame so a
	// slow (not broken) image shows a shimmer placeholder and reserves space
	// instead of flashing layout-shift when it finally loads. The frame starts in
	// the `--loading` state; MarkdownRenderer flips it to `--loaded` on the image's
	// load event (and `--broken` via the existing error handler). Data-attributes
	// are stripped by DOMPurify, so the loading state rides on CSS classes.
	// Which address becomes an <img> is the policy's (docs/plans/exfil-channels), not
	// the model's: the app's own thumbnail of a connected photo, a picture that holds
	// its own bytes, or a picture image_search returned (shown as its Brave thumbnail
	// through the app's route). Any other web address is a link chip that is never
	// fetched, and anything that is not a web address is only its words.
	const imageFrame = (src: string, alt: string, title: string | undefined) => {
		const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
		return [
			'<span class="markdown-image-frame markdown-image-frame--loading">',
			`<img class="markdown-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttribute} loading="lazy" decoding="async">`,
			"</span>",
		].join("");
	};
	const imageNotLoadedLabel =
		options.imageNotLoadedLabel ?? defaultImageNotLoadedLabel;
	renderer.image = ({ href, title, text }) => {
		const alt = text ?? "";
		if (isPhotoProxyPath(href) || isRasterImageDataUri(href)) {
			return imageFrame(href, alt, title ?? undefined);
		}
		const key = provenanceKey(href);
		if (key === null) return escapeHtml(alt);
		const result = policy.images.get(key);
		if (result?.thumbnail) {
			return imageFrame(
				imageThumbnailRouteUrl(result.thumbnail),
				alt,
				title ?? undefined,
			);
		}
		// Inside a link the link is the way to the address; a chip there would be a link
		// inside a link.
		if (linkTextDepth > 0) {
			return escapeHtml(compactWhitespace(alt) || (sourceHostOf(href) ?? ""));
		}
		return renderBlockedImage({ href, alt, imageNotLoadedLabel });
	};
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
			return renderSourceLinkChip({ href, sourceName }, policy.sourceHosts);
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
			toolSourceHosts: policy.sourceHosts,
		});
	};

	return renderer;
}

export {
	collectSourceReferenceCandidates,
	initHighlighter,
	loadMarkdownBlocks,
	prepareCodeHighlighting,
	type RenderMarkdownOptions,
	renderCodeBlock,
	renderHighlightedText,
	renderInlineMarkdown,
	renderMarkdown,
	type SourceReferenceCandidate,
	sourceFaviconUrl,
};
