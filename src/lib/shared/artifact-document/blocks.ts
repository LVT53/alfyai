/**
 * The Document's pure block model (Feature 2 · Artifacts, Slice 1, spec §2.6,
 * ruling 12). No `@tiptap/*`, no `prosemirror*`, no Svelte, no DOM: this
 * module is importable from `$lib/server/**` and from the browser, because the
 * server has to be able to refuse a patch and the server has no editor.
 *
 * Block ids are minted or absorbed IMMEDIATELY inside `parseDocument`, before
 * any hash is computed. This is the prototype's one real bug, made
 * structurally impossible here: the prototype minted ids lazily (on the first
 * ProseMirror transaction), so the very first read of a freshly loaded
 * document had no stable identity at all, and every patch against it was
 * refused. There is no code path in this module that can hash a block before
 * it has an id.
 */

export const MARKER_PREFIX = "<!--b:";
const MARKER_RE = /^<!--b:([A-Za-z0-9_.-]+)-->$/;

export type BlockKind =
	| "paragraph"
	| "heading"
	| "list"
	| "taskList"
	| "table"
	| "blockquote"
	| "code"
	| "hr"
	| "other";

export interface DocumentBlock {
	/** Stable across reloads because it is written into the Markdown. */
	id: string;
	kind: BlockKind;
	/** The block's Markdown with the id marker line removed. Hashing input and the patch unit. */
	markdown: string;
	/** fnv1aHex(normalizeMarkdown(markdown)) — the same value on both sides. */
	hash: string;
	/** The first line of visible text, for the model's blockLabel and the UI's refusal notice. */
	label: string;
}

export interface ParsedDocument {
	/** The canonical Markdown, with one marker line before every block. */
	markdown: string;
	blocks: DocumentBlock[];
	/** true when this parse minted at least one id — the caller must persist the result. */
	minted: boolean;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** FNV-1a, 32 bit, hex. Dependency-free, deterministic, and fast enough for a per-block guard. */
export function fnv1aHex(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Ruling 12: the canonical block form, defined here, next to the hasher, and
 * pinned by the named gate (`blocks.test.ts` → "canonical form: open →
 * serialise → reload → serialise keeps every hash"). The prototypes measured
 * that a plain Markdown round trip is NOT byte-identical — reopening a
 * document rewrote table padding and blank-line runs — so hashing the raw
 * serialiser output would make a hash change on a mere open, and "your words
 * win" would refuse every patch on a document nobody touched.
 *
 * The rule, applied to one block's Markdown at a time:
 *   1. trimmed lines — no trailing whitespace on any line, and no leading
 *      whitespace on a line with no structural reason to carry any (a plain
 *      paragraph/heading/blockquote/hr block; list and table lines keep their
 *      own indentation, which IS structural);
 *   2. collapsed table padding — `| a  |   b |` and `| a | b |` normalise to
 *      the same key (the padding the prototypes lost on a mere reopen);
 *   3. normalised list markers — `*`/`+`/`-` bullets become `-`, an ordered
 *      marker becomes `N.` with its number kept, `- [X]`/`- [x]` becomes
 *      `- [x]` and `- [ ]` stays `- [ ]`;
 *   4. no trailing blank lines, and internal runs of 3+ blank lines collapse
 *      to one;
 *   5. stabilised chip syntax — `[chip kind="…" value="…"]` attribute order
 *      and quoting are fixed regardless of how the source wrote them.
 *
 * `normalizeMarkdown` MUST be idempotent — that property is what `blockHash`
 * rests on — and `serializeDocument` writes exactly this function's output for
 * every block, so the stored bytes and the hashed bytes can never drift apart.
 *
 * A fenced code block is content, not Markdown structure: only rule 1's
 * trailing-whitespace trim and rule 4's edge trim apply to it. Rules 2, 3 and
 * 5 and the blank-run collapse are about the serialiser's own noise in
 * prose, and applied to code they rewrote what the code says — a diff's
 * `+ added` line became `- added`, a `1)` became `1.`, a blank line between
 * two functions disappeared (RV-1A).
 */
export function normalizeMarkdown(markdown: string): string {
	let lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (isFencedCodeBlock(lines)) {
		return trimBlankEdges(
			lines.map((line) => line.replace(/[ \t]+$/, "")),
		).join("\n");
	}
	lines = keepHardBreaks(lines);
	lines = lines.map((line) => line.replace(/[ \t]+$/, ""));
	lines = collapseBlankRuns(lines);
	lines = trimBlankEdges(lines);
	lines = normalizeTableLines(lines);
	lines = normalizeListMarkers(lines);
	lines = stripStrayLeadingWhitespace(lines);
	return normalizeChipSyntax(lines.join("\n"));
}

/**
 * A line ending in two or more spaces, followed by more text of the same
 * paragraph, is a CommonMark hard break — and it is the form the editor
 * writes for Shift+Enter. Rule 1's trailing-space trim deleted it, so every
 * hard break came back from a reload as a plain space (RV-1A). It is written
 * as the equivalent backslash break instead, which no trim can remove. Only
 * where the next line really continues the paragraph: before a new block (a
 * list item, a heading, a marker…) a trailing backslash would be literal text.
 */
function keepHardBreaks(lines: string[]): string[] {
	if (lines.some((line) => isTableDelimiterRow(line))) return lines;
	// The editor's task-item reader does not read a hard break back (it keeps
	// a backslash as literal text), so a task item's trailing spaces are just
	// trimmed, as before.
	const first = lines.find((line) => line.trim() !== "") ?? "";
	if (TASK_LINE_RE.test(first)) return lines;
	return lines.map((line, i) => {
		const next = lines[i + 1];
		if (next === undefined || !continuesParagraph(line, next)) return line;
		return /\S {2,}$/.test(line) ? line.replace(/ +$/, "\\") : line;
	});
}

const QUOTE_PREFIX_RE = /^\s{0,3}(?:>[ \t]?)+/;

/**
 * Whether `next` carries on the paragraph `line` is in. Inside a quote both
 * lines carry the `>` prefix, so it is the text after the prefix that must
 * not start a block of its own (RV-1A: a break between two lines of one quote
 * was trimmed away like any other).
 */
function continuesParagraph(line: string, next: string): boolean {
	if (next.trim() === "") return false;
	const lineQuote = QUOTE_PREFIX_RE.exec(line)?.[0];
	const nextQuote = QUOTE_PREFIX_RE.exec(next)?.[0];
	const depth = (prefix: string) => prefix.split(">").length - 1;
	if (
		lineQuote !== undefined &&
		nextQuote !== undefined &&
		depth(lineQuote) !== depth(nextQuote)
	) {
		return false;
	}
	const text =
		lineQuote !== undefined && nextQuote !== undefined
			? next.slice(nextQuote.length)
			: next;
	if (text.trim() === "") return false;
	return !startsNewBlock(text) && !LIST_ITEM_START_RE.test(text);
}

/** `fnv1aHex(normalizeMarkdown(markdown))` — the one hasher, so nothing can bypass the canonicaliser. */
export function blockHash(markdown: string): string {
	return fnv1aHex(normalizeMarkdown(markdown));
}

function collapseBlankRuns(lines: string[]): string[] {
	const out: string[] = [];
	let blankRun = 0;
	for (const line of lines) {
		if (line.trim() === "") {
			blankRun += 1;
			if (blankRun <= 1) out.push("");
		} else {
			blankRun = 0;
			out.push(line);
		}
	}
	return out;
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start += 1;
	while (end > start && lines[end - 1].trim() === "") end -= 1;
	return lines.slice(start, end);
}

/**
 * Split one `| a | b |`-shaped line into cell substrings (not yet trimmed).
 * Shared with the patch engine's `addTableRow` and the export mapper. A
 * backslash escapes the character after it, so `\|` is cell text (GFM's
 * only way to put a pipe in a cell), never a column separator — splitting
 * on it turned one cell into two on every save (RV-1A).
 */
export function splitTableCells(line: string): string[] {
	const s = line.trim();
	const cells: string[] = [];
	let current = "";
	let endedWithSeparator = false;
	for (let i = 0; i < s.length; i += 1) {
		const ch = s[i];
		endedWithSeparator = false;
		if (ch === "\\" && i + 1 < s.length) {
			current += ch + s[i + 1];
			i += 1;
			continue;
		}
		if (ch === "|") {
			cells.push(current);
			current = "";
			endedWithSeparator = true;
			continue;
		}
		current += ch;
	}
	cells.push(current);
	// The row's opening and closing pipes delimit cells; neither is one.
	if (s.startsWith("|")) cells.shift();
	if (endedWithSeparator) cells.pop();
	return cells;
}

/**
 * A GFM delimiter row: pipe-separated cells of `-` with optional alignment
 * colons. The pipe is required — a bare `---` line is a horizontal rule (or a
 * setext underline), and reading it as a one-cell delimiter row rewrote every
 * horizontal rule into the paragraph text `| --- |` on its first save (RV-1A).
 */
function isTableDelimiterRow(line: string): boolean {
	if (!line.includes("|")) return false;
	const cells = splitTableCells(line).map((c) => c.trim());
	if (cells.length === 0) return false;
	return cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * One table row with its padding collapsed. A delimiter row's dashes are
 * padding too: the editor pads them to the column's width (`| ------- |`), so
 * a table Alfy wrote with `| --- |` changed its hash on a mere reopen as soon
 * as a cell was wider than three characters (RV-1A). Each delimiter cell
 * becomes `---`, keeping its alignment colons.
 */
function normalizeTableRow(line: string): string {
	const cells = splitTableCells(line).map((cell) => cell.trim());
	const normalized = isTableDelimiterRow(line)
		? cells.map((cell) => cell.replace(/^(:?)-+(:?)$/, "$1---$2"))
		: cells;
	return `| ${normalized.join(" | ")} |`;
}

/** Collapses padding on any contiguous run of table lines (found by their delimiter row). */
function normalizeTableLines(lines: string[]): string[] {
	const out = [...lines];
	let i = 0;
	while (i < out.length) {
		if (!isTableDelimiterRow(out[i])) {
			i += 1;
			continue;
		}
		let start = i;
		if (start > 0 && out[start - 1].includes("|")) start -= 1;
		let end = i + 1;
		while (end < out.length && out[end].includes("|")) end += 1;
		for (let j = start; j < end; j += 1) out[j] = normalizeTableRow(out[j]);
		i = end;
	}
	return out;
}

// Exported (Slice 1, T12): the export builder (services/artifacts/export.ts)
// reads a task/bullet/ordered line the exact same way this parser does,
// rather than a second, possibly-drifting copy of the same three patterns.
export const TASK_LINE_RE = /^(\s*)[-*+]\s+\[([ xX])\](\s+(.*))?$/;
export const BULLET_LINE_RE = /^(\s*)[-*+](\s+)(.*)$/;
export const ORDERED_LINE_RE = /^(\s*)(\d+)[.)](\s+)(.*)$/;

/**
 * A `taskList` block's checked state and visible text, read from its own
 * first line — the one reader the server's card-preview projection
 * (`conversation-detail`'s `ArtifactCardSummary.documentPreview`) and the
 * client's full-body `documentArtifactCardView` (`document/card-view.ts`)
 * both use, so "is this item checked" and "what does it say" can never drift
 * between the two. `null` for any block that is not a task line (including a
 * non-`taskList` block, or a `taskList` block whose first line the shared
 * regex does not match — defensive, never expected in practice).
 */
export function readTaskBlock(
	block: DocumentBlock,
): { checked: boolean; text: string } | null {
	if (block.kind !== "taskList") return null;
	const match = TASK_LINE_RE.exec(block.markdown.split("\n")[0] ?? "");
	if (!match) return null;
	return {
		checked: match[2].toLowerCase() === "x",
		// The text a reader sees: the card showed "**deposit**" and raw chip
		// tokens otherwise (RV-1A). The whitespace a removed chip leaves is
		// folded.
		text: inlinePlainText(match[4] ?? "")
			.replace(/\s+/g, " ")
			.trim(),
	};
}

function normalizeListMarkers(lines: string[]): string[] {
	return lines.map((line) => {
		const task = TASK_LINE_RE.exec(line);
		if (task) {
			const [, indent, mark, , rest] = task;
			const checked = mark.toLowerCase() === "x";
			const suffix = rest && rest.trim().length > 0 ? ` ${rest.trim()}` : "";
			return `${indent}- [${checked ? "x" : " "}]${suffix}`;
		}
		const bullet = BULLET_LINE_RE.exec(line);
		if (bullet) {
			const [, indent, , rest] = bullet;
			return `${indent}- ${rest}`;
		}
		const ordered = ORDERED_LINE_RE.exec(line);
		if (ordered) {
			const [, indent, num, , rest] = ordered;
			return `${indent}${num}. ${rest}`;
		}
		return line;
	});
}

function isFencedCodeBlock(lines: string[]): boolean {
	const first = lines.find((l) => l.trim().length > 0);
	return !!first && /^(`{3,}|~{3,})/.test(first.trim());
}

/**
 * Rule 1's leading-whitespace trim, restricted to blocks that have no
 * structural reason to carry indentation. A block containing any list marker
 * or table row is left alone here (its own rules already produced a stable,
 * idempotent form for those lines), and a fenced code block is never touched
 * — code is verbatim.
 */
function stripStrayLeadingWhitespace(lines: string[]): string[] {
	if (isFencedCodeBlock(lines)) return lines;
	const hasListMarker = lines.some(
		(l) => BULLET_LINE_RE.test(l) || ORDERED_LINE_RE.test(l),
	);
	const hasTableRow = lines.some((l) => l.includes("|"));
	if (hasListMarker || hasTableRow) return lines;
	return lines.map((line) => line.replace(/^[ \t]+/, ""));
}

/**
 * Rule 5: a chip token's attribute order and quoting are fixed. Only a real
 * token is touched — an unescaped `[chip` whose body is nothing but
 * `name="value"` / `name='value'` pairs, including `kind` or `value`. The
 * user's own bracketed words are text: the editor writes a typed "[chip in]"
 * as `\[chip in\]`, and rewriting that as an empty chip deleted the words
 * (RV-1A).
 */
function normalizeChipSyntax(text: string): string {
	return text.replace(
		/(?<!\\)\[chip\s+([^\]]*)\]/g,
		(match, rawAttrs: string) => {
			if (!/^(?:\s*\w+\s*=\s*(?:"[^"]*"|'[^']*'))+\s*$/.test(rawAttrs)) {
				return match;
			}
			const attrs: Record<string, string> = {};
			const attrRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
			let m: RegExpExecArray | null = attrRe.exec(rawAttrs);
			while (m !== null) {
				attrs[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? "");
				m = attrRe.exec(rawAttrs);
			}
			if (attrs.kind === undefined && attrs.value === undefined) return match;
			return `[chip kind="${attrs.kind ?? ""}" value="${attrs.value ?? ""}"]`;
		},
	);
}

// ---------------------------------------------------------------------------
// Id minting
// ---------------------------------------------------------------------------

const KIND_PREFIX: Record<BlockKind, string> = {
	paragraph: "p",
	heading: "h",
	list: "l",
	taskList: "t",
	table: "tb",
	blockquote: "q",
	code: "c",
	hr: "r",
	other: "o",
};

/**
 * The 5-character suffix space is `36^5` (≈60.5M) values. A plain
 * `Math.random()` draw over that space collides roughly half the time across
 * 10,000 calls (the birthday bound), which is not an acceptable answer to "two
 * calls do not collide over 10,000 iterations" — that has to be true, not
 * usually true. So the suffix is a full-period linear congruential generator
 * instead: `ID_STEP` is odd and not a multiple of 3, so it is coprime with
 * `ID_SPACE = 36^5 = 2^10 * 3^10`, which makes repeated addition mod
 * `ID_SPACE` a bijection — every one of the 60.5M residues is visited exactly
 * once before the sequence repeats. The starting point is randomised per
 * process so ids are not identical across restarts, but collisions inside one
 * process are structurally impossible until the space itself is exhausted.
 */
const ID_SPACE = 36 ** 5;
const ID_STEP = 48_271;
let idCursor = Math.floor(Math.random() * ID_SPACE);

function nextIdSuffix(): string {
	idCursor = (idCursor + ID_STEP) % ID_SPACE;
	return idCursor.toString(36).padStart(5, "0");
}

/** Kind-prefixed id, e.g. `p7k2xq`: the prefix is for a hand-read board, the suffix is the identity. */
export function mintBlockId(kind: BlockKind): string {
	return `${KIND_PREFIX[kind]}${nextIdSuffix()}`;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** `id → hash`, derived on demand from the parsed blocks — the one index in the system. */
export function buildIndex(blocks: DocumentBlock[]): Record<string, string> {
	const index: Record<string, string> = {};
	for (const block of blocks) index[block.id] = block.hash;
	return index;
}

/** Count of `<!--b:` occurrences — the size cost, made visible (and a T1.3 assertion). */
export function countMarkers(markdown: string): number {
	return markdown.split(MARKER_PREFIX).length - 1;
}

/**
 * The canonical Markdown: one marker line immediately before every block, the
 * block's already-normalised text, and blocks separated by exactly one blank
 * line. `serializeDocument` is the ONLY function that writes markers, and it
 * writes `normalizeMarkdown`'s output for each block, so the stored bytes and
 * the hashed bytes are the same bytes.
 */
export function serializeDocument(blocks: DocumentBlock[]): string {
	if (blocks.length === 0) return "";
	return `${blocks
		.map(
			(block) =>
				`${MARKER_PREFIX}${block.id}-->\n${normalizeMarkdown(block.markdown)}`,
		)
		.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// The block splitter — a deliberately narrow reader for exactly the
// constructs the spec names: ATX headings, fenced code, blockquotes, `- [ ]`
// task lists, `|`-tables, `-`/`*`/`1.` lists (with continuation lines),
// horizontal rules, everything else as a paragraph (or "other" for a raw HTML
// block the splitter recognises but does not otherwise classify).
// ---------------------------------------------------------------------------

const FENCE_RE = /^(`{3,}|~{3,})/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_RE = /^ {0,3}#{1,6}(\s+.*)?$/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const TASK_START_RE = /^ {0,3}[-*+]\s+\[[ xX]\]/;
const BULLET_START_RE = /^ {0,3}[-*+]\s+/;
const ORDERED_START_RE = /^ {0,3}\d+[.)]\s+/;
// A plain list's family excludes task syntax, so a blank line between a plain
// bullet item and a following task item is never read as one loose list.
const PLAIN_LIST_FAMILY_RE = /^ {0,3}(?:[-*+]\s+(?!\[[ xX]\])|\d+[.)]\s+)/;
const HTML_START_RE = /^ {0,3}</;

type Segment =
	| { type: "marker"; id: string }
	| { type: "block"; kind: BlockKind; text: string };

function startsNewBlock(line: string): boolean {
	const trimmed = line.trim();
	if (MARKER_RE.test(trimmed)) return true;
	if (FENCE_RE.test(trimmed)) return true;
	if (HR_RE.test(line)) return true;
	if (HEADING_RE.test(line)) return true;
	if (BLOCKQUOTE_RE.test(line)) return true;
	if (
		TASK_START_RE.test(line) ||
		BULLET_START_RE.test(line) ||
		ORDERED_START_RE.test(line)
	) {
		return true;
	}
	if (HTML_START_RE.test(line)) return true;
	return false;
}

/**
 * A checklist item is addressed on its own: `toggleTask` carries only
 * `blockId` and `checked` — no item locator — so it can only ever mean "this
 * whole block is the one item," never "the third line of a five-item block."
 * Every task item is therefore its own block, unlike a plain bullet/ordered
 * list (which has no per-item op and stays one block).
 */
const LIST_ITEM_START_RE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
const LIST_MARKER_PREFIX_RE = /^(\s*)([-*+]|\d+[.)])(\s+)/;

/**
 * The column a list item's content starts at (CommonMark: indent + marker +
 * the spaces after it, at most 4 of them). A line indented to at least this
 * column is INSIDE the item — a continuation or a nested list — never a
 * sibling.
 */
function listItemContentColumn(line: string): number {
	const match = LIST_MARKER_PREFIX_RE.exec(line);
	if (!match) return 0;
	return match[1].length + match[2].length + Math.min(match[3].length, 4);
}

function leadingWhitespace(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * One task item: its first line, its indented continuation lines, and its
 * nested items. A nested item is part of its parent's block, not a block of
 * its own: a marker line between a parent and its child ends the list in
 * every Markdown reader, so a split-off child came back un-nested on the
 * next reopen — its text and hash changed with no user edit, which broke
 * ruling 12's gate for every nested checklist (RV-1A).
 */
function consumeSingleListItem(
	lines: string[],
	start: number,
): { text: string; next: number } {
	const collected = [lines[start]];
	const contentColumn = listItemContentColumn(lines[start]);
	let i = start + 1;
	while (i < lines.length && /^\s+\S/.test(lines[i])) {
		const nested =
			LIST_ITEM_START_RE.test(lines[i]) &&
			leadingWhitespace(lines[i]) >= contentColumn;
		if (LIST_ITEM_START_RE.test(lines[i]) && !nested) break;
		collected.push(lines[i]);
		i += 1;
	}
	return { text: collected.join("\n"), next: i };
}

/**
 * CommonMark's lazy continuation: a line right after a list item's text that
 * starts no block of its own continues that text, indented or not. The editor
 * writes the second line of a Shift+Enter break in a list item exactly so
 * (`- item one  ` then `item line two`), and reading it as a new paragraph
 * moved that line out of its item on the next reload (RV-1A). Plain lists
 * only: the editor's task-item reader handles neither a lazy line nor a hard
 * break, so a task item keeps its old, stable split (review-1a.md, open
 * question for the editor).
 */
function isLazyContinuation(line: string): boolean {
	return line.trim() !== "" && !startsNewBlock(line);
}

/** Consumes a plain list block: its items, indented continuations, and a loose blank line before another item of the SAME family. */
function consumeListBlock(
	lines: string[],
	start: number,
	familyRe: RegExp,
): { text: string; next: number } {
	const collected: string[] = [lines[start]];
	let i = start + 1;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			const next = lines.slice(i + 1).find((l) => l.trim() !== "");
			if (next !== undefined && familyRe.test(next)) {
				collected.push(line);
				i += 1;
				continue;
			}
			break;
		}
		if (
			familyRe.test(line) ||
			/^\s+\S/.test(line) ||
			isLazyContinuation(line)
		) {
			collected.push(line);
			i += 1;
			continue;
		}
		break;
	}
	return { text: collected.join("\n"), next: i };
}

function splitIntoSegments(lines: string[]): Segment[] {
	const segments: Segment[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === "") {
			i += 1;
			continue;
		}

		const markerMatch = MARKER_RE.exec(trimmed);
		if (markerMatch) {
			segments.push({ type: "marker", id: markerMatch[1] });
			i += 1;
			continue;
		}

		if (FENCE_RE.test(trimmed)) {
			const fenceChar = trimmed[0];
			const fenceLen = (new RegExp(`^\\${fenceChar}+`).exec(trimmed) ?? [""])[0]
				.length;
			const closeRe = new RegExp(`^\\${fenceChar}{${fenceLen},}\\s*$`);
			const collected = [line];
			i += 1;
			while (i < lines.length && !closeRe.test(lines[i].trim())) {
				collected.push(lines[i]);
				i += 1;
			}
			if (i < lines.length) {
				collected.push(lines[i]);
				i += 1;
			}
			segments.push({
				type: "block",
				kind: "code",
				text: collected.join("\n"),
			});
			continue;
		}

		if (HR_RE.test(line)) {
			segments.push({ type: "block", kind: "hr", text: line });
			i += 1;
			continue;
		}

		if (HEADING_RE.test(line)) {
			segments.push({ type: "block", kind: "heading", text: line });
			i += 1;
			continue;
		}

		if (BLOCKQUOTE_RE.test(line)) {
			const collected = [line];
			i += 1;
			while (
				i < lines.length &&
				(BLOCKQUOTE_RE.test(lines[i]) || lines[i].trim() === ">")
			) {
				collected.push(lines[i]);
				i += 1;
			}
			segments.push({
				type: "block",
				kind: "blockquote",
				text: collected.join("\n"),
			});
			continue;
		}

		if (
			line.includes("|") &&
			i + 1 < lines.length &&
			isTableDelimiterRow(lines[i + 1])
		) {
			const collected = [line, lines[i + 1]];
			i += 2;
			while (
				i < lines.length &&
				lines[i].includes("|") &&
				lines[i].trim() !== ""
			) {
				collected.push(lines[i]);
				i += 1;
			}
			segments.push({
				type: "block",
				kind: "table",
				text: collected.join("\n"),
			});
			continue;
		}

		if (TASK_START_RE.test(line)) {
			const { text, next } = consumeSingleListItem(lines, i);
			segments.push({ type: "block", kind: "taskList", text });
			i = next;
			continue;
		}

		if (BULLET_START_RE.test(line) || ORDERED_START_RE.test(line)) {
			const { text, next } = consumeListBlock(lines, i, PLAIN_LIST_FAMILY_RE);
			segments.push({ type: "block", kind: "list", text });
			i = next;
			continue;
		}

		if (HTML_START_RE.test(line)) {
			const collected = [line];
			i += 1;
			while (i < lines.length && lines[i].trim() !== "") {
				collected.push(lines[i]);
				i += 1;
			}
			segments.push({
				type: "block",
				kind: "other",
				text: collected.join("\n"),
			});
			continue;
		}

		// Paragraph: the fallback. Consumes consecutive non-blank lines until a
		// blank line or a line that clearly starts a different kind of block.
		const collected = [line];
		i += 1;
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!startsNewBlock(lines[i])
		) {
			collected.push(lines[i]);
			i += 1;
		}
		segments.push({
			type: "block",
			kind: "paragraph",
			text: collected.join("\n"),
		});
	}
	return segments;
}

// ---------------------------------------------------------------------------
// Visible text — what the reader sees of a block: the editor's own text
// (ProseMirror's `textBetween` over the block, marks stripped, "\n" between
// the text blocks inside a list, quote or table). A comment's anchor is
// captured from that text, so it has to be resolved against it too, never
// against the Markdown source (RV-1A); an export renders it, since the report
// renderers print text verbatim.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
		(match, name: string) => {
			if (name.startsWith("#")) {
				const code =
					name[1].toLowerCase() === "x"
						? Number.parseInt(name.slice(2), 16)
						: Number.parseInt(name.slice(1), 10);
				return code > 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: match;
			}
			return NAMED_ENTITIES[name.toLowerCase()] ?? match;
		},
	);
}

/**
 * Inline Markdown as the text it shows: code spans verbatim, backslash
 * escapes resolved, emphasis/strong/strike delimiters dropped (a lone `*`
 * between spaces, and an underscore inside a word, are literal), a link
 * or autolink as its text, an image or a tracker chip as nothing (both are
 * atoms with no text in the editor), inline HTML tags dropped, entities
 * decoded, and a hard break as nothing. A soft line break stays "\n".
 */
export function inlinePlainText(
	markdown: string,
	options: {
		/** What a hard break becomes: nothing, like the editor's text (the default), or a line break for a rendered export. */
		hardBreak?: string;
	} = {},
): string {
	const hardBreak = options.hardBreak ?? "";
	const codeSpans: string[] = [];
	let text = markdown.replace(
		/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g,
		(_match, _ticks: string, body: string) => {
			codeSpans.push(/^ .* $/.test(body) ? body.slice(1, -1) : body);
			return `\uE000${codeSpans.length - 1}\uE000`;
		},
	);
	const escapes: string[] = [];
	text = text.replace(/\\([!-/:-@[-`{-~])/g, (_match, ch: string) => {
		escapes.push(ch);
		return `\uE001${escapes.length - 1}\uE001`;
	});
	text = text
		.replace(/\\\n[ \t]*/g, hardBreak)
		.replace(/ {2,}\n[ \t]*/g, hardBreak);
	text = text
		.replace(/\[chip\s+[^\]]*\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<((?:https?|mailto|ftp):[^>\s]*)>/gi, "$1")
		.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "")
		.replace(/~~/g, "");
	text = text.replace(
		/\*+|_+/g,
		(run: string, offset: number, whole: string) => {
			const before = whole[offset - 1] ?? " ";
			const after = whole[offset + run.length] ?? " ";
			const leftFlanking = !/\s/.test(after);
			const rightFlanking = !/\s/.test(before);
			if (!leftFlanking && !rightFlanking) return run;
			if (
				run[0] === "_" &&
				/[\p{L}\p{N}]/u.test(before) &&
				/[\p{L}\p{N}]/u.test(after)
			) {
				return run;
			}
			return "";
		},
	);
	text = decodeEntities(text);
	text = text.replace(
		/\uE001(\d+)\uE001/g,
		(_m, i: string) => escapes[Number(i)],
	);
	return text.replace(
		/\uE000(\d+)\uE000/g,
		(_m, i: string) => codeSpans[Number(i)],
	);
}

/**
 * A block's visible text: the block's own markup (heading hashes, quote
 * markers, list markers and checkboxes, table pipes and delimiter row, code
 * fences) removed, its inline Markdown read by `inlinePlainText`, and "\n"
 * between the text blocks inside it (list items, table cells), exactly where
 * the editor puts one.
 */
export function blockVisibleText(
	block: Pick<DocumentBlock, "kind" | "markdown">,
): string {
	const key = `${block.kind}\n${block.markdown}`;
	const cached = visibleTextCache.get(key);
	if (cached !== undefined) return cached;
	const text = computeBlockVisibleText(block);
	if (visibleTextCache.size >= VISIBLE_TEXT_CACHE_LIMIT)
		visibleTextCache.clear();
	visibleTextCache.set(key, text);
	return text;
}

/**
 * The margin re-resolves every comment against every block on every change,
 * and a block's visible text is a pure function of its kind and Markdown —
 * so it is computed once per distinct block, not once per render (a
 * 1 000-block document with ten threads cost ~22 ms a render without it).
 * Bounded: cleared when it reaches the cap.
 */
const VISIBLE_TEXT_CACHE_LIMIT = 4096;
const visibleTextCache = new Map<string, string>();

function computeBlockVisibleText(
	block: Pick<DocumentBlock, "kind" | "markdown">,
): string {
	const lines = block.markdown.split("\n");
	switch (block.kind) {
		case "hr":
			return "";
		case "code": {
			const inner = lines.slice(1);
			if (inner.length > 0 && FENCE_RE.test(inner[inner.length - 1].trim())) {
				inner.pop();
			}
			return inner.join("\n");
		}
		case "table":
			return lines
				.filter((line) => !isTableDelimiterRow(line))
				.flatMap((line) =>
					splitTableCells(line).map((cell) => inlinePlainText(cell.trim())),
				)
				.join("\n");
		case "heading": {
			const text = lines[0]
				.replace(/^\s{0,3}#{1,6}[ \t]*/, "")
				.replace(/[ \t]+#+[ \t]*$/, "");
			return inlinePlainText(text);
		}
		default: {
			// A hard break joins its two lines into one text; the line after it
			// carries no marker of its own.
			const joined = block.markdown
				.replace(/\\\n[ \t]*/g, "\uE002")
				.replace(/ {2,}\n[ \t]*/g, "\uE002");
			return joined
				.split("\n")
				.map((line) =>
					inlinePlainText(
						line
							.replace(/^\s{0,3}(?:>[ \t]?)+/, "")
							.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "")
							.replace(/^\s+/, "")
							.replace(/\uE002/g, ""),
					),
				)
				.join("\n");
		}
	}
}

/** The first line of visible text, stripped of block-level markup, for a model's `blockLabel` and the UI's refusal notice. */
function deriveLabel(markdown: string): string {
	const lines = markdown.split("\n").filter((l) => l.trim().length > 0);
	// A code block is named by its first line of code: its fence line alone
	// left the label empty, and the refusal notice then named nothing (RV-1A).
	if (FENCE_RE.test(lines[0]?.trim() ?? "")) {
		const code = lines.slice(1).find((l) => !FENCE_RE.test(l.trim())) ?? "";
		return clampLabel(code.trim());
	}
	let text = (lines[0] ?? "").trim();
	text = text.replace(/^#{1,6}\s*/, "");
	text = text.replace(/^(?:>\s?)+/, "");
	text = text.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "");
	text = text.replace(/^\d+[.)]\s+/, "");
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
	// The label is what the user sees, not the Markdown: "**Bold** start"
	// was named with its asterisks (RV-1A). Chips have no text of their own.
	return clampLabel(inlinePlainText(text).replace(/\s+/g, " ").trim());
}

function clampLabel(text: string): string {
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Build one `DocumentBlock` from an id, a kind and its raw (not yet
 * normalised) markdown text. The one place that runs normalise → hash → label
 * for a single block, so `parseDocument` and the patch engine (which rebuilds
 * a block after a text-level edit) can never compute a hash a different way.
 */
export function makeBlock(
	id: string,
	kind: BlockKind,
	rawMarkdown: string,
): DocumentBlock {
	const normalized = normalizeMarkdown(rawMarkdown);
	return {
		id,
		kind,
		markdown: normalized,
		hash: fnv1aHex(normalized),
		label: deriveLabel(normalized),
	};
}

/**
 * Re-reads the text an edit produced for ONE block as the blocks it really
 * is — the same splitter `parseDocument` runs, so the result is exactly what
 * a reload of the stored document will read. The first block keeps `id`;
 * every further block (a paragraph that became two, a new section) gets a
 * freshly minted id not in `taken`, which this function adds it to. Marker
 * lines in the text are dropped, never absorbed: a block's markdown never
 * carries one, and an id is never chosen by an edit's text. `[]` when the
 * text holds no block at all.
 */
export function reblock(
	id: string,
	markdown: string,
	taken: Set<string>,
): DocumentBlock[] {
	const lines = markdown
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n");
	const blocks: DocumentBlock[] = [];
	for (const segment of splitIntoSegments(lines)) {
		if (segment.type !== "block") continue;
		let blockId = id;
		if (blocks.length > 0) {
			do {
				blockId = mintBlockId(segment.kind);
			} while (taken.has(blockId));
			taken.add(blockId);
		}
		blocks.push(makeBlock(blockId, segment.kind, segment.text));
	}
	return blocks;
}

/**
 * Parse, then mint or absorb. The mint happens HERE, before any hash is
 * computed, so the returned blocks always have ids. Never hash a document
 * that has not been through this function.
 */
export function parseDocument(
	markdown: string,
	opts?: { mint?: boolean },
): ParsedDocument {
	const mint = opts?.mint !== false;
	const rawLines = markdown
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n");
	const segments = splitIntoSegments(rawLines);

	const staged: { kind: BlockKind; text: string; absorbedId: string | null }[] =
		[];
	let pendingMarkerId: string | null = null;
	for (const segment of segments) {
		if (segment.type === "marker") {
			pendingMarkerId = segment.id;
			continue;
		}
		staged.push({
			kind: segment.kind,
			text: segment.text,
			absorbedId: pendingMarkerId,
		});
		pendingMarkerId = null;
	}
	// A trailing marker with no following block is dropped: `pendingMarkerId`
	// simply falls out of scope here.

	const seen = new Set<string>();
	let minted = false;
	const blocks: DocumentBlock[] = staged.map(({ kind, text, absorbedId }) => {
		let id: string;
		if (absorbedId && !seen.has(absorbedId)) {
			id = absorbedId;
		} else if (mint) {
			do {
				id = mintBlockId(kind);
			} while (seen.has(id));
			minted = true;
		} else {
			id = absorbedId ?? "";
		}
		if (id) seen.add(id);
		return makeBlock(id, kind, text);
	});

	return {
		markdown: serializeDocument(blocks),
		blocks,
		minted,
	};
}
