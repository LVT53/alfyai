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
 */
export function normalizeMarkdown(markdown: string): string {
	let lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	lines = lines.map((line) => line.replace(/[ \t]+$/, ""));
	lines = collapseBlankRuns(lines);
	lines = trimBlankEdges(lines);
	lines = normalizeTableLines(lines);
	lines = normalizeListMarkers(lines);
	lines = stripStrayLeadingWhitespace(lines);
	return normalizeChipSyntax(lines.join("\n"));
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

/** Split one `| a | b |`-shaped line into cell substrings (not yet trimmed). Shared with the patch engine's `addTableRow`. */
export function splitTableCells(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s.split("|");
}

function isTableDelimiterRow(line: string): boolean {
	const cells = splitTableCells(line).map((c) => c.trim());
	if (cells.length === 0) return false;
	return cells.every((cell) => /^:?-+:?$/.test(cell));
}

function normalizeTableRow(line: string): string {
	const cells = splitTableCells(line).map((cell) => cell.trim());
	return `| ${cells.join(" | ")} |`;
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
	return { checked: match[2].toLowerCase() === "x", text: (match[4] ?? "").trim() };
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

function normalizeChipSyntax(text: string): string {
	return text.replace(/\[chip\s+([^\]]*)\]/g, (_match, rawAttrs: string) => {
		const attrs: Record<string, string> = {};
		const attrRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
		let m: RegExpExecArray | null = attrRe.exec(rawAttrs);
		while (m !== null) {
			attrs[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? "");
			m = attrRe.exec(rawAttrs);
		}
		const kind = attrs.kind ?? "";
		const value = attrs.value ?? "";
		return `[chip kind="${kind}" value="${value}"]`;
	});
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

function consumeSingleListItem(
	lines: string[],
	start: number,
): { text: string; next: number } {
	const collected = [lines[start]];
	let i = start + 1;
	while (
		i < lines.length &&
		/^\s+\S/.test(lines[i]) &&
		!LIST_ITEM_START_RE.test(lines[i])
	) {
		collected.push(lines[i]);
		i += 1;
	}
	return { text: collected.join("\n"), next: i };
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
		if (familyRe.test(line) || /^\s+\S/.test(line)) {
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

/** The first line of visible text, stripped of block-level markup, for a model's `blockLabel` and the UI's refusal notice. */
function deriveLabel(markdown: string): string {
	const firstLine = markdown.split("\n").find((l) => l.trim().length > 0) ?? "";
	let text = firstLine.trim();
	text = text.replace(/^#{1,6}\s*/, "");
	text = text.replace(/^>\s?/, "");
	text = text.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "");
	text = text.replace(/^\d+[.)]\s+/, "");
	text = text.replace(/^`{3,}.*$/, "");
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|")) text = text.slice(0, -1);
	text = text.replace(/\[chip[^\]]*\]/g, "");
	text = text.replace(/\s+/g, " ").trim();
	if (text.length > 80) text = `${text.slice(0, 79)}…`;
	return text;
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
