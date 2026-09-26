/**
 * Block → `GeneratedDocumentSource` (Feature 2 · Artifacts, Slice 1, Task
 * T12). Exports a Document through the file-production engine we already
 * have — never a second export pipeline. The mapping is TOTAL: one output
 * block per input block, and `<!--b:id-->` markers (addressing, not content)
 * never reach the source this hands to `submitFileProductionIntake`.
 *
 * chart/image/sourceChips/pageBreak are Atlas-report concepts a Document has
 * no native block for, and this mapper never invents one — every Document
 * `BlockKind` maps to exactly one of heading/paragraph/list/quote/code/divider.
 */
import type {
	GeneratedDocumentListItem,
	GeneratedDocumentSource,
} from "$lib/server/services/file-production/source-schema";
import {
	BULLET_LINE_RE,
	type DocumentBlock,
	inlinePlainText,
	ORDERED_LINE_RE,
	splitTableCells,
	TASK_LINE_RE,
} from "$lib/shared/artifact-document/blocks";

const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/;
const CODE_FENCE_LINE_RE = /^(`{3,}|~{3,})\s*(\S*)\s*$/;
const CHIP_TOKEN_RE = /\[chip\s+kind="[^"]*"\s+value="([^"]*)"\]/g;
const MAX_FILENAME_LENGTH = 100;

function nonEmptyLines(markdown: string): string[] {
	return markdown.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Markdown as the text a reader sees (RV-1A): the report renderers print
 * text verbatim, so `**bold**`, `[a link](url)`, `&amp;` and `\*` reached the
 * PDF and the Word file as those characters. A tracker chip token renders as
 * its plain value (a rendered report has no chip pill), and a hard break as a
 * line break.
 */
function exportText(markdown: string): string {
	return inlinePlainText(
		markdown
			.replace(CHIP_TOKEN_RE, (_token, value: string) => value)
			// A soft line break reads as a space; a hard one (a backslash or two
			// spaces before the newline) stays a line break.
			.replace(/(?<!\\| {2})\n[ \t]*/g, " "),
		{ hardBreak: "\n" },
	).trim();
}

function mapHeading(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	const match = HEADING_LINE_RE.exec(markdown.trim());
	const level = match
		? (Math.min(3, match[1].length) as 1 | 2 | 3)
		: (2 as const);
	const text = match ? match[2].replace(/[ \t]+#+[ \t]*$/, "") : markdown;
	return { type: "heading", level, text: exportText(text) };
}

function mapParagraph(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	return { type: "paragraph", text: exportText(markdown) };
}

/** A list line's own text (marker removed), or `null` for a continuation line of the item before it. */
function listItemText(line: string): string | null {
	const ordered = ORDERED_LINE_RE.exec(line);
	if (ordered) return ordered[4];
	const bullet = BULLET_LINE_RE.exec(line);
	if (bullet) return bullet[3];
	return null;
}

function mapList(markdown: string): GeneratedDocumentSource["blocks"][number] {
	const lines = nonEmptyLines(markdown);
	const style = lines.some((line) => ORDERED_LINE_RE.test(line))
		? ("numbered" as const)
		: ("bullet" as const);
	// A continuation line (a hard break's second line, a wrapped line) belongs
	// to the item above it, never an item of its own.
	const raw: string[] = [];
	for (const line of lines) {
		const text = listItemText(line);
		if (text === null && raw.length > 0) {
			raw[raw.length - 1] += `\n${line.trim()}`;
		} else {
			raw.push(text ?? line.trim());
		}
	}
	return { type: "list", style, items: raw.map(exportText) };
}

/**
 * Ruling 36: a checked box, never "[x]" folded into the item's own text — the
 * structured `{ text, checked }` shape the four renderers now all understand.
 * A task item's block also holds its nested items (RV-1A's nesting fix): a
 * nested task is a box of its own, a nested plain item a plain item, and a
 * continuation line joins the item above it — never a stray unchecked box.
 */
function mapTaskList(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	const items: { text: string; checked?: boolean }[] = [];
	for (const line of nonEmptyLines(markdown)) {
		const task = TASK_LINE_RE.exec(line);
		if (task) {
			items.push({
				text: task[4] ?? "",
				checked: task[2].toLowerCase() === "x",
			});
			continue;
		}
		const plain = listItemText(line);
		if (plain !== null || items.length === 0) {
			items.push({ text: plain ?? line.trim() });
			continue;
		}
		items[items.length - 1].text += `\n${line.trim()}`;
	}
	return {
		type: "list",
		style: "bullet",
		items: items.map((item): GeneratedDocumentListItem => {
			const text = exportText(item.text);
			return item.checked === undefined
				? text
				: { text, checked: item.checked };
		}),
	};
}

function mapTable(markdown: string): GeneratedDocumentSource["blocks"][number] {
	const lines = nonEmptyLines(markdown);
	const headerLine = lines[0];
	if (!headerLine) return { type: "table", columns: [], rows: [] };

	const headers = splitTableCells(headerLine).map((cell) => exportText(cell));
	const columns = headers.map((label, index) => ({
		key: `c${index}`,
		label,
		kind: "text" as const,
	}));
	// lines[1] is the "---|---" delimiter row; body rows start after it.
	const rows = lines.slice(2).map((line) => {
		const cells = splitTableCells(line);
		const row: Record<string, string> = {};
		columns.forEach((column, index) => {
			row[column.key] = exportText(cells[index] ?? "");
		});
		return row;
	});
	return { type: "table", columns, rows };
}

function mapCode(markdown: string): GeneratedDocumentSource["blocks"][number] {
	const lines = markdown.split("\n");
	const fenceMatch = CODE_FENCE_LINE_RE.exec(lines[0]?.trim() ?? "");
	const language = fenceMatch?.[2] ? fenceMatch[2] : undefined;
	// Drop the opening fence, and the closing one only when there is one (an
	// unclosed fence runs to the block's end, and its last line is code):
	// the body is verbatim between them.
	const inner = lines.slice(1);
	if (
		inner.length > 0 &&
		CODE_FENCE_LINE_RE.test(inner[inner.length - 1].trim())
	) {
		inner.pop();
	}
	return { type: "code", language, text: inner.join("\n") };
}

function mapBlockquote(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	const text = markdown
		.split("\n")
		.map((line) => line.replace(/^\s*(?:>\s?)+/, ""))
		.join("\n");
	return { type: "quote", text: exportText(text) };
}

function mapBlock(
	block: DocumentBlock,
): GeneratedDocumentSource["blocks"][number] {
	switch (block.kind) {
		case "heading":
			return mapHeading(block.markdown);
		case "list":
			return mapList(block.markdown);
		case "taskList":
			return mapTaskList(block.markdown);
		case "table":
			return mapTable(block.markdown);
		case "code":
			return mapCode(block.markdown);
		case "blockquote":
			return mapBlockquote(block.markdown);
		case "hr":
			return { type: "divider" };
		// "other" (and "paragraph") preserve the block's own text as prose
		// rather than dropping it — the mapping is total (T12.3), and a block
		// this parser did not specifically recognize is still content.
		case "paragraph":
		case "other":
			return mapParagraph(block.markdown);
	}
}

/**
 * The one builder every export path (PDF, DOCX; Markdown takes a different
 * route, `inline_text` — see the export route) uses to turn a Document's
 * current blocks into a `GeneratedDocumentSource`. Never trusts a
 * client-sent body: the caller reads the artifact's own stored blocks.
 */
export function buildGeneratedDocumentSource(params: {
	title: string;
	blocks: DocumentBlock[];
}): GeneratedDocumentSource {
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: params.title,
		blocks: params.blocks.map(mapBlock),
	};
}

/**
 * A safe bare basename for a produced file (T12.1): path separators cannot
 * escape the storage directory, a leading dot cannot make a hidden file, and
 * an empty result (nothing left after stripping, or the source was blank)
 * falls back to "document" rather than shipping an unusable filename.
 */
export function sanitizeDocumentFilename(title: string): string {
	const withoutSeparators = title.trim().replace(/[\\/]+/g, "-");
	const withoutLeadingDots = withoutSeparators.replace(/^\.+/, "");
	const capped = withoutLeadingDots.slice(0, MAX_FILENAME_LENGTH).trim();
	return capped.length > 0 ? capped : "document";
}
