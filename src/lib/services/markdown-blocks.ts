import type { Token, Tokens } from "marked";

/**
 * Typed rich-block markdown model (Tier A3).
 *
 * A single parse/split step (`classifyMarkdownBlocks`) turns marked's block
 * lexer tokens into a typed, ordered list of blocks. This is the ONE fence /
 * block grammar for the chat renderer — it replaces the line-scanning
 * `splitMarkdownBlocks` that used to live in `MarkdownRenderer.svelte`, folding
 * in B3 so fences are detected in exactly one place. `markdown.ts`
 * `extractFenceLanguages` remains only as a language-preload scan, not a
 * splitter.
 *
 * A renderer registry (`BLOCK_RENDER_STRATEGIES`) maps each block kind to a
 * render strategy, so adding a block type is one registry entry plus one
 * renderer/component — not another regex smeared across the pipeline.
 */
export type MarkdownBlockKind =
	| "code"
	| "table"
	| "callout"
	| "checklist"
	| "accordion"
	| "html";

/**
 * Stage 2 (diagrams) will add mermaid / chart / csv block kinds. Their fences
 * are currently classified as plain `code` blocks (grey code). The names are
 * reserved here so Stage 2 is a purely additive change (one registry entry +
 * one renderer per kind). They are intentionally NOT produced or registered
 * yet.
 */
export const RESERVED_STAGE2_KINDS = ["mermaid", "chart", "csv"] as const;
export type ReservedStage2Kind = (typeof RESERVED_STAGE2_KINDS)[number];

/**
 * Block source-syntax contract (Stage 2 teaches these to the Normal Chat model):
 * - checklist → GFM task list: `- [ ] todo` / `- [x] done` (rendered as
 *   enabled, tick-able checkboxes by the Checklist component).
 * - accordion → raw HTML passthrough: `<details><summary>Title</summary> …body
 *   markdown… </details>`. Chosen because <details>/<summary> already survive
 *   DOMPurify and are natively collapsible (no JS needed). Blank lines inside
 *   are fine — the classifier re-joins the split tokens into one accordion.
 * - table    → standard GFM pipe tables (wrapped as a first-class scroll block).
 * - callout  → Obsidian blockquote callouts: `> [!NOTE] Title`.
 */
export type MarkdownChecklistItem = {
	checked: boolean;
	task: boolean;
	text: string;
};

export type MarkdownBlock =
	| { kind: "code"; raw: string; code: string; language?: string }
	| { kind: "checklist"; raw: string; items: MarkdownChecklistItem[] }
	| { kind: "table"; raw: string }
	| { kind: "callout"; raw: string }
	| { kind: "accordion"; raw: string }
	| { kind: "html"; raw: string };

/** How a block kind is rendered by the component-side registry. */
export type BlockRenderStrategy = "code" | "checklist" | "prose";

/**
 * The renderer registry: block kind → render strategy.
 * - `code`      → the `CodeBlock` Svelte component.
 * - `checklist` → the interactive `Checklist` Svelte component.
 * - `prose`     → the sanitized `{@html}` markdown surface (table, callout,
 *                 accordion `<details>`, and generic prose all render here).
 */
export const BLOCK_RENDER_STRATEGIES: Record<
	MarkdownBlockKind,
	BlockRenderStrategy
> = {
	code: "code",
	checklist: "checklist",
	table: "prose",
	callout: "prose",
	accordion: "prose",
	html: "prose",
};

export function resolveBlockRenderStrategy(
	kind: MarkdownBlockKind,
): BlockRenderStrategy {
	return BLOCK_RENDER_STRATEGIES[kind];
}

const CALLOUT_PATTERN = /^\s*>\s*\[!([A-Za-z][\w-]*)\]/;
const DETAILS_OPEN_PATTERN = /<details(?=[\s>])/gi;
const DETAILS_CLOSE_PATTERN = /<\/details\s*>/gi;

function countMatches(source: string, pattern: RegExp): number {
	const matches = source.match(pattern);
	return matches ? matches.length : 0;
}

function detailsDepthDelta(raw: string): number {
	return (
		countMatches(raw, DETAILS_OPEN_PATTERN) -
		countMatches(raw, DETAILS_CLOSE_PATTERN)
	);
}

function isCalloutBlockquote(token: Token): boolean {
	return token.type === "blockquote" && CALLOUT_PATTERN.test(token.raw ?? "");
}

function isTaskListToken(token: Token): token is Tokens.List {
	return (
		token.type === "list" &&
		Array.isArray((token as Tokens.List).items) &&
		(token as Tokens.List).items.some((item) => item.task === true)
	);
}

function isDetailsOpener(token: Token): boolean {
	return token.type === "html" && DETAILS_OPEN_PATTERN.test(token.raw ?? "");
}

function checklistBlock(token: Tokens.List): MarkdownBlock {
	return {
		kind: "checklist",
		raw: token.raw ?? "",
		items: token.items.map((item) => ({
			checked: item.checked === true,
			task: item.task === true,
			text: item.text ?? "",
		})),
	};
}

/**
 * Classify block-level lexer tokens into typed markdown blocks.
 *
 * Consecutive "prose" tokens (paragraphs, headings, plain lists, normal
 * blockquotes, horizontal rules, spacing, passthrough HTML) are coalesced into
 * a single `html` block so the downstream `renderMarkdown` call sees the same
 * slice it would have today — preserving prose spacing and inline behaviour.
 * A `<details>` element that the lexer split across several tokens (because a
 * blank line interrupts the HTML block) is re-joined into one `accordion` block
 * so the collapsible renders as a single complete element.
 */
export function classifyMarkdownBlocks(tokens: Token[]): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let prose = "";
	let accordion: string | null = null;
	let accordionDepth = 0;

	const flushProse = () => {
		if (prose.trim()) {
			blocks.push({ kind: "html", raw: prose });
		}
		prose = "";
	};

	const flushAccordion = () => {
		if (accordion !== null) {
			blocks.push({ kind: "accordion", raw: accordion });
		}
		accordion = null;
		accordionDepth = 0;
	};

	for (const token of tokens) {
		const raw = token.raw ?? "";

		// Inside an open <details> span: keep consuming tokens (body prose and
		// the eventual closing tag) until the nesting depth returns to zero.
		if (accordion !== null) {
			accordion += raw;
			accordionDepth += detailsDepthDelta(raw);
			if (accordionDepth <= 0) {
				flushAccordion();
			}
			continue;
		}

		if (isDetailsOpener(token)) {
			flushProse();
			const depth = detailsDepthDelta(raw);
			if (depth <= 0) {
				blocks.push({ kind: "accordion", raw });
			} else {
				accordion = raw;
				accordionDepth = depth;
			}
			continue;
		}

		if (token.type === "code") {
			flushProse();
			const codeToken = token as Tokens.Code;
			const language = codeToken.lang?.trim() ? codeToken.lang : undefined;
			blocks.push({
				kind: "code",
				raw,
				code: codeToken.text ?? "",
				language,
			});
			continue;
		}

		if (token.type === "table") {
			flushProse();
			blocks.push({ kind: "table", raw });
			continue;
		}

		if (isTaskListToken(token)) {
			flushProse();
			blocks.push(checklistBlock(token));
			continue;
		}

		if (isCalloutBlockquote(token)) {
			flushProse();
			blocks.push({ kind: "callout", raw });
			continue;
		}

		prose += raw;
	}

	flushProse();
	flushAccordion();

	return blocks;
}
