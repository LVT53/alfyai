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
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import {
	BULLET_LINE_RE,
	type DocumentBlock,
	ORDERED_LINE_RE,
	splitTableCells,
	TASK_LINE_RE,
} from "$lib/shared/artifact-document/blocks";

const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/;
const CODE_FENCE_LINE_RE = /^(`{3,}|~{3,})\s*(\S*)\s*$/;
const CHIP_TOKEN_RE = /^\[chip\s+kind="([^"]*)"\s+value="([^"]*)"\]$/;
const MAX_FILENAME_LENGTH = 100;

function nonEmptyLines(markdown: string): string[] {
	return markdown.split("\n").filter((line) => line.trim().length > 0);
}

/** A table cell's canonical chip token (store/store/documents.ts's own convention) renders as its plain value — a rendered report has no chip pill styling to show. */
function cellText(raw: string): string {
	const trimmed = raw.trim();
	const chip = CHIP_TOKEN_RE.exec(trimmed);
	return chip ? chip[2] : trimmed;
}

function mapHeading(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	const match = HEADING_LINE_RE.exec(markdown.trim());
	const level = match
		? (Math.min(3, match[1].length) as 1 | 2 | 3)
		: (2 as const);
	const text = match ? match[2].trim() : markdown.trim();
	return { type: "heading", level, text };
}

function mapParagraph(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	return { type: "paragraph", text: markdown.trim() };
}

function mapList(markdown: string): GeneratedDocumentSource["blocks"][number] {
	const lines = nonEmptyLines(markdown);
	const style = lines.some((line) => ORDERED_LINE_RE.test(line))
		? ("numbered" as const)
		: ("bullet" as const);
	const items = lines.map((line) => {
		const ordered = ORDERED_LINE_RE.exec(line);
		if (ordered) return ordered[4].trim();
		const bullet = BULLET_LINE_RE.exec(line);
		if (bullet) return bullet[3].trim();
		return line.trim();
	});
	return { type: "list", style, items };
}

/**
 * Ruling 36: a checked box, never "[x]" folded into the item's own text — the
 * structured `{ text, checked }` shape the four renderers now all understand.
 */
function mapTaskList(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	const items = nonEmptyLines(markdown).map((line) => {
		const task = TASK_LINE_RE.exec(line);
		if (!task) return { text: line.trim(), checked: false };
		return {
			text: (task[4] ?? "").trim(),
			checked: task[2].toLowerCase() === "x",
		};
	});
	return { type: "list", style: "bullet", items };
}

function mapTable(markdown: string): GeneratedDocumentSource["blocks"][number] {
	const lines = nonEmptyLines(markdown);
	const headerLine = lines[0];
	if (!headerLine) return { type: "table", columns: [], rows: [] };

	const headers = splitTableCells(headerLine).map((cell) => cell.trim());
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
			row[column.key] = cellText(cells[index] ?? "");
		});
		return row;
	});
	return { type: "table", columns, rows };
}

function mapCode(markdown: string): GeneratedDocumentSource["blocks"][number] {
	const lines = markdown.split("\n");
	const fenceMatch = CODE_FENCE_LINE_RE.exec(lines[0]?.trim() ?? "");
	const language = fenceMatch?.[2] ? fenceMatch[2] : undefined;
	// Drop the opening and closing fence lines; the body is verbatim between them.
	const body = lines.slice(1, lines.length - 1).join("\n");
	return { type: "code", language, text: body };
}

function mapBlockquote(
	markdown: string,
): GeneratedDocumentSource["blocks"][number] {
	const text = markdown
		.split("\n")
		.map((line) => line.replace(/^\s*>\s?/, ""))
		.join("\n")
		.trim();
	return { type: "quote", text };
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
