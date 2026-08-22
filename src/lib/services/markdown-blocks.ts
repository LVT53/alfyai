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
	| "mermaid"
	| "chart"
	| "csv"
	| "html";

/**
 * The diagram fence languages (Stage 2). A fenced block whose info string is one
 * of these — AND whose fence is actually CLOSED — is promoted from a plain `code`
 * block to its own typed diagram kind, so the registry can dispatch it to a real
 * visual renderer instead of grey code. An UNTERMINATED diagram fence (mid-stream,
 * closing ``` not yet arrived) stays a `code` block: we never hand a partial
 * source to chart.js / mermaid — the code/placeholder shows until the fence
 * closes, mirroring how code blocks flush during streaming.
 */
export const DIAGRAM_FENCE_KINDS = ["mermaid", "chart", "csv"] as const;
export type DiagramFenceKind = (typeof DIAGRAM_FENCE_KINDS)[number];
const DIAGRAM_FENCE_LANGS = new Set<string>(DIAGRAM_FENCE_KINDS);

/**
 * Block source-syntax contract (the Normal Chat model is taught these):
 * - checklist → GFM task list: `- [ ] todo` / `- [x] done` (rendered as
 *   enabled, tick-able checkboxes by the Checklist component).
 * - accordion → raw HTML passthrough: `<details><summary>Title</summary> …body
 *   markdown… </details>`. Chosen because <details>/<summary> already survive
 *   DOMPurify and are natively collapsible (no JS needed). Blank lines inside
 *   are fine — the classifier re-joins the split tokens into one accordion.
 * - table    → standard GFM pipe tables (wrapped as a first-class scroll block).
 * - callout  → Obsidian blockquote callouts: `> [!NOTE] Title`.
 * - mermaid  → a ```mermaid fence whose body is mermaid diagram source
 *   (flowchart / sequence / etc.), rendered to sanitized SVG client-side.
 * - chart    → a ```chart fence whose body is a JSON Chart.js config
 *   (`{ "type": "bar", "data": { "labels": [...], "datasets": [...] } }`),
 *   rendered to a <canvas> client-side.
 * - csv      → a ```csv fence whose body is comma-separated rows (first row is
 *   the header), rendered as a first-class scrollable table.
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
	| { kind: "mermaid"; raw: string; code: string }
	| { kind: "chart"; raw: string; code: string }
	| { kind: "csv"; raw: string; code: string }
	| { kind: "html"; raw: string };

/**
 * How a block kind is rendered. This is the SINGLE source of truth for
 * dispatch: `MarkdownRenderer.svelte` maps each strategy to a concrete Svelte
 * component (or the prose `{@html}` lane) via the component registry, so the
 * template holds no per-kind switch — adding a block kind is one entry here +
 * one component, no template edits.
 * - `code`      → the `CodeBlock` component.
 * - `checklist` → the interactive `Checklist` component.
 * - `chart`     → the `Chart` component (Chart.js on a <canvas>).
 * - `csv`       → the `CsvTable` component (a first-class scrollable table).
 * - `mermaid`   → the `Mermaid` component (lazy mermaid → sanitized SVG).
 * - `prose`     → the sanitized `{@html}` markdown surface (table, callout,
 *                 accordion `<details>`, and generic prose all render here).
 */
export type BlockRenderStrategy =
	| "code"
	| "checklist"
	| "chart"
	| "csv"
	| "mermaid"
	| "prose";

export const BLOCK_RENDER_STRATEGIES: Record<
	MarkdownBlockKind,
	BlockRenderStrategy
> = {
	code: "code",
	checklist: "checklist",
	chart: "chart",
	csv: "csv",
	mermaid: "mermaid",
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
const FENCE_LINE_PATTERN = /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/;

/**
 * Is a fenced code token's source actually terminated? marked emits a `code`
 * token for an unterminated fence too (mid-stream, before the closing ``` has
 * streamed in) — its `raw` simply lacks the closing fence line. A closed fence's
 * `raw` ends with a line that is nothing but fence characters. We use this to
 * keep a partial diagram fence in the safe `code` lane until it closes.
 */
function isFenceClosed(raw: string): boolean {
	const lines = raw.replace(/\s+$/, "").split("\n");
	if (lines.length < 2) return false;
	return FENCE_LINE_PATTERN.test(lines[lines.length - 1]);
}

/** The bare fence language keyword, lower-cased (drops any info-string tail). */
function fenceLanguageKeyword(lang: string | undefined): string {
	return (lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
}

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
			const code = codeToken.text ?? "";
			const keyword = fenceLanguageKeyword(codeToken.lang);
			// A CLOSED diagram fence is promoted to its own visual kind. An
			// unterminated one (mid-stream) falls through to the code lane below,
			// so partial/invalid diagram source is never handed to the renderer.
			if (DIAGRAM_FENCE_LANGS.has(keyword) && isFenceClosed(raw)) {
				blocks.push({ kind: keyword as DiagramFenceKind, raw, code });
				continue;
			}
			const language = codeToken.lang?.trim() ? codeToken.lang : undefined;
			blocks.push({
				kind: "code",
				raw,
				code,
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
