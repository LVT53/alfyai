import type {
	RenderMarkdownOptions,
	SourceReferenceCandidate,
} from "$lib/services/markdown";
import type { MarkdownBlock } from "$lib/services/markdown-blocks";

/**
 * Shared markdown module loader with lazy caching.
 *
 * DocumentPreviewRenderer.svelte and DocumentWorkspace.svelte dynamically import
 * the markdown service. This utility consolidates the caching pattern so
 * the module is only loaded once regardless of how many consumers call it.
 */

type MarkdownModule = typeof import("$lib/services/markdown");

let markdownModulePromise: Promise<MarkdownModule> | null = null;

/**
 * Gets the cached markdown module promise, creating it on first call.
 * Safe to call multiple times — the same promise is returned.
 */
function getMarkdownModule(): Promise<MarkdownModule> {
	if (!markdownModulePromise) {
		markdownModulePromise = import("$lib/services/markdown");
	}
	return markdownModulePromise;
}

/**
 * Renders highlighted text using the shared markdown module.
 * Calls getMarkdownModule() internally, so callers don't need to manage the promise.
 *
 * @param content - The text content to render
 * @param language - Syntax highlighting language (e.g., 'python', 'javascript')
 * @param isDark - Whether dark mode is active (affects highlight theme)
 */
export async function renderHighlightedText(
	content: string,
	language: string,
	isDark: boolean,
): Promise<string> {
	const { renderHighlightedText: fn } = await getMarkdownModule();
	return fn(content, language, isDark);
}

export async function renderMarkdown(
	content: string,
	isDark: boolean,
	options?: RenderMarkdownOptions,
): Promise<string> {
	const { renderMarkdown: fn } = await getMarkdownModule();
	return fn(content, isDark, options);
}

export async function collectSourceReferenceCandidates(
	content: string,
): Promise<SourceReferenceCandidate[]> {
	const { collectSourceReferenceCandidates: fn } = await getMarkdownModule();
	return fn(content);
}

export async function renderCodeBlock(
	content: string,
	language: string | undefined,
	isDark: boolean,
): Promise<string> {
	const { renderCodeBlock: fn } = await getMarkdownModule();
	return fn(content, language, isDark);
}

export async function prepareCodeHighlighting(content: string): Promise<void> {
	const { prepareCodeHighlighting: fn } = await getMarkdownModule();
	await fn(content);
}

/**
 * Parse a markdown source string into the typed block model (Tier A3). The
 * single parse/split step for the chat renderer — replaces the line-scanning
 * fence splitter that used to live in MarkdownRenderer.svelte.
 */
export async function parseMarkdownBlocks(
	content: string,
): Promise<MarkdownBlock[]> {
	const { loadMarkdownBlocks: fn } = await getMarkdownModule();
	return fn(content);
}

/**
 * Render a short inline markdown fragment (checklist item body) to sanitized
 * HTML with no wrapping block element.
 */
export async function renderInlineMarkdown(
	content: string,
	isDark: boolean,
): Promise<string> {
	const { renderInlineMarkdown: fn } = await getMarkdownModule();
	return fn(content, isDark);
}
