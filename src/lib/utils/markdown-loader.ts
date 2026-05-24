import type { RenderMarkdownOptions } from "$lib/services/markdown";

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
export function getMarkdownModule(): Promise<MarkdownModule> {
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
