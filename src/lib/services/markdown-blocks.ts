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
export function isFenceClosed(raw: string): boolean {
	const lines = raw.replace(/\s+$/, "").split("\n");
	if (lines.length < 2) return false;
	return FENCE_LINE_PATTERN.test(lines[lines.length - 1]);
}

/** The bare fence language keyword, lower-cased (drops any info-string tail). */
function fenceLanguageKeyword(lang: string | undefined): string {
	return (lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
}

// A checklist line the model wrote inside a fence: an optional list marker, a
// `[ ]`/`[x]` box, then item text. The `- `/`* ` marker is optional precisely
// because the common failure mode is writing `[ ] item` WITHOUT it.
const CHECKLIST_FENCE_ITEM = /^(\s*)(?:[-*]\s+)?\[([ xX])\]\s+(\S.*)$/;

// Fence languages that signal checklist INTENT (promoted alongside bare fences).
const CHECKLIST_INTENT_LANGS = new Set(["checklist", "todo", "task", "tasks"]);

/**
 * A code fence the model MEANT as a checklist but that renders as a dead
 * monospaced block. Local Qwen models habitually emit checklists as `[ ] item`
 * lines wrapped in a bare ``` fence — no `- ` marker (so it is not valid GFM)
 * and inside a code fence (so it never becomes interactive). Detect that shape
 * so the loader can rescue it into a real task list. Deliberately conservative:
 * needs >=2 checkbox lines AND them being >=50% of the non-blank lines, so an
 * ordinary code sample — which practically never starts lines with `[ ]` — is
 * left untouched.
 */
export function isChecklistLikeFenceBody(text: string): boolean {
	const nonBlank = text.split("\n").filter((line) => line.trim().length > 0);
	if (nonBlank.length < 2) return false;
	const checkbox = nonBlank.filter((line) =>
		CHECKLIST_FENCE_ITEM.test(line),
	).length;
	return checkbox >= 2 && checkbox / nonBlank.length >= 0.5;
}

/**
 * Whether a fence is eligible for the checklist rescue by its language tag: a
 * bare fence (no language) or an explicit checklist-intent tag. A fence tagged
 * with a real language (including `md`/`markdown`, which means "show the source")
 * is never rescued.
 */
export function isPromotableChecklistFence(lang: string | undefined): boolean {
	const keyword = fenceLanguageKeyword(lang);
	return keyword === "" || CHECKLIST_INTENT_LANGS.has(keyword);
}

/** The leading-whitespace string common to every non-blank line (may be ""). */
function commonLeadingWhitespace(lines: string[]): string {
	const indents = lines
		.filter((line) => line.trim().length > 0)
		.map((line) => line.match(/^[ \t]*/)?.[0] ?? "");
	if (indents.length === 0) return "";
	let common = indents[0];
	for (const indent of indents.slice(1)) {
		let i = 0;
		while (i < common.length && i < indent.length && common[i] === indent[i]) {
			i++;
		}
		common = common.slice(0, i);
		if (common === "") break;
	}
	return common;
}

/**
 * Rewrite bare `[ ]`/`[x]` checklist lines to GFM task-list items (`- [ ] …`),
 * leaving every other line (section labels, blanks) as written so a re-lex turns
 * labels into prose and the checkbox runs into interactive lists.
 *
 * Two indentation hazards are handled so the re-lex actually yields a task list
 * rather than an indented code block: (1) any indent common to the whole body is
 * stripped, and (2) each emitted checkbox item is anchored at column 0. Without
 * this, an indented fence body (`    [ ] a`) would be rewritten to `    - [ ] a`,
 * which marked lexes as code — silently defeating the rescue AND injecting `- `
 * markers into content that stays monospaced.
 */
export function normalizeChecklistFenceBody(text: string): string {
	const lines = text.split("\n");
	const common = commonLeadingWhitespace(lines);
	return lines
		.map((line) => {
			const dedented =
				common !== "" && line.startsWith(common)
					? line.slice(common.length)
					: line;
			const match = dedented.match(CHECKLIST_FENCE_ITEM);
			if (!match) return dedented;
			const checked = match[2].toLowerCase() === "x" ? "x" : " ";
			return `- [${checked}] ${match[3]}`;
		})
		.join("\n");
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
