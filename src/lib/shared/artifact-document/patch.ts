/**
 * The Document's patch engine (Feature 2 · Artifacts, Slice 1, spec §2.5,
 * §4). Pure, like `blocks.ts`: it runs on the server for every model patch,
 * and in the browser only to render the outcome the server already decided.
 *
 * "Your words win" is the one rule this file exists to enforce: a block the
 * user changed since Alfy's last read is refused, per operation, and every
 * other operation in the same patch still applies. The engine never carries
 * an English sentence — every refusal is a `RefusalReason` code, and the
 * human sentence is produced where it is shown (the UI's
 * `artifacts.document.refused.*`, or the tool layer's model-facing text).
 */
import {
	type BlockKind,
	type DocumentBlock,
	reblock,
	serializeDocument,
	splitTableCells,
} from "./blocks";

export type PatchOpKind =
	| "replaceBlock"
	| "insertText"
	| "replaceRange"
	| "toggleTask"
	| "addTableRow";

export interface PatchOp {
	opId: string;
	kind: PatchOpKind;
	blockId: string;
	/** The block's hash as the model read it. The whole guard. */
	baseHash: string;
	/** What the model calls this block, for the refusal notice. */
	blockLabel: string;
	text?: string;
	/** replaceRange: the exact text inside the block this op rewrites. */
	find?: string;
	at?: "start" | "end";
	checked?: boolean;
	cells?: (string | { chip: { kind: "status" | "date"; value: string } })[];
}

export interface PatchSet {
	patchId: string;
	label: string;
	note?: string;
	ops: PatchOp[];
}

export type RefusalReason =
	| "block_missing" // "block no longer exists"
	| "block_unseen" // "not in Alfy's last read (no hash to check)"
	| "block_changed" // "you changed this block after Alfy last read it"
	| "not_a_text_block"
	| "empty_text"
	| "find_not_found" // replaceRange: `find` is not in the block
	| "find_ambiguous" // replaceRange: `find` occurs more than once
	| "not_a_task_block"
	| "not_a_table_block"
	| "bad_row"; // cells length does not match the table's columns

export interface OpOutcome {
	opId: string;
	kind: PatchOpKind;
	blockId: string;
	blockLabel: string;
	status: "applied" | "refused";
	/** Human-readable, localized by the UI from `code`. Never set by this engine. */
	reason?: string;
	code?: RefusalReason;
}

/** Enough to undo exactly one applied op: the block's markdown immediately before it. */
export interface PatchInverse {
	opId: string;
	blockId: string;
	previousMarkdown: string;
	/**
	 * The blocks this op added after `blockId`, when its text read as more
	 * than one block (a paragraph that became two, a new section) — an exact
	 * Undo removes them too. Absent when the op produced exactly one block.
	 */
	insertedBlockIds?: string[];
}

export interface PatchResult {
	patchId: string;
	label: string;
	appliedAt: number;
	outcomes: OpOutcome[];
	applied: number;
	refused: number;
	/** The document after the applied ops. */
	blocks: DocumentBlock[];
	markdown: string;
	/** Applied ops in reverse, so Undo is exact rather than a re-parse. */
	inverses: PatchInverse[];
}

/** Kinds `insertText`/`replaceBlock` treat as prose. Lists, tables, code and hr use their own ops or none. */
const TEXT_BLOCK_KINDS: ReadonlySet<BlockKind> = new Set([
	"paragraph",
	"heading",
	"blockquote",
	"other",
]);

function renderCell(spec: NonNullable<PatchOp["cells"]>[number]): string {
	if (typeof spec === "string") return spec;
	return `[chip kind="${spec.chip.kind}" value="${spec.chip.value}"]`;
}

/** Appends one row to a table block's markdown. `null` means the row does not match the header's column count. */
function appendTableRow(
	markdown: string,
	cells: NonNullable<PatchOp["cells"]>,
): string | null {
	const lines = markdown.split("\n");
	if (lines.length === 0) return null;
	const headerCells = splitTableCells(lines[0]);
	if (cells.length !== headerCells.length) return null;
	const rowLine = `| ${cells.map(renderCell).join(" | ")} |`;
	return [...lines, rowLine].join("\n");
}

/** Flips (or sets) the checkbox on a task item's first line. `null` means the block is not a task item. */
function toggleTaskItem(
	markdown: string,
	checked: boolean | undefined,
): string | null {
	const lines = markdown.split("\n");
	const match = /^(\s*[-*+]\s+)\[[ xX]\](.*)$/.exec(lines[0] ?? "");
	if (!match) return null;
	const currentlyChecked = /\[[xX]\]/.test(lines[0]);
	const next = checked ?? !currentlyChecked;
	lines[0] = `${match[1]}[${next ? "x" : " "}]${match[2]}`;
	return lines.join("\n");
}

/**
 * The markup that makes a heading a heading (`## `) or a quote a quote (`> `),
 * which `insertText` at the start must keep IN FRONT of the new text. Text
 * put before it turned `# Title` into the paragraph `New # Title` (RV-1A).
 * Empty for every other kind: a paragraph's first character is its text.
 */
function leadingBlockMarkup(kind: BlockKind, markdown: string): string {
	if (kind === "heading") {
		const match = /^(\s{0,3}#{1,6})(?:[ \t]+|$)/.exec(markdown);
		return match ? `${match[1]} ` : "";
	}
	if (kind === "blockquote") {
		const match = /^\s{0,3}(?:>[ \t]?)+/.exec(markdown);
		return match ? match[0] : "";
	}
	return "";
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * Apply a patch set. Every op is checked against the SAME three-way guard,
 * applied to a copy of the document, so a refused op can never have mutated
 * anything: `blocks`/`markdown` in the result reflect only the applied ops.
 */
export function applyPatchSet(input: {
	blocks: DocumentBlock[];
	patch: PatchSet;
	/** What Alfy last read: block id → hash. */
	snapshot: Record<string, string>;
}): PatchResult {
	const working = [...input.blocks];
	let indexById = new Map(working.map((block, i) => [block.id, i]));
	/** Every id in the document, so an id minted for a split-off block is new. */
	const taken = new Set(working.map((block) => block.id));
	/**
	 * What each block said BEFORE this patch — what the user left. The guard
	 * compares against this, not against `working`: an earlier op in this same
	 * patch changing a block is Alfy's own edit, and blaming it on the user
	 * ("you changed this block") refused every second op on one block (RV-1A).
	 */
	const hashBeforePatch = new Map(
		input.blocks.map((block) => [block.id, block.hash]),
	);
	const outcomes: OpOutcome[] = [];
	const inverses: PatchInverse[] = [];

	for (const op of input.patch.ops) {
		const refuse = (code: RefusalReason) => {
			outcomes.push({
				opId: op.opId,
				kind: op.kind,
				blockId: op.blockId,
				blockLabel: op.blockLabel,
				status: "refused",
				code,
			});
		};

		const index = indexById.get(op.blockId);
		if (index === undefined) {
			refuse("block_missing");
			continue;
		}
		const block = working[index];

		// The guard, in this order — all three must agree. `snapshot` is what
		// Alfy last read; `hashBeforePatch` is what the document says now (the
		// user's side, before any op of this patch); `op.baseHash` is what the
		// model claims it read.
		const seenHash = input.snapshot[op.blockId];
		if (seenHash === undefined) {
			refuse("block_unseen");
			continue;
		}
		const currentHash = hashBeforePatch.get(op.blockId) ?? block.hash;
		if (seenHash !== currentHash || seenHash !== op.baseHash) {
			refuse("block_changed");
			continue;
		}

		const before = block.markdown;
		let nextMarkdown: string | null = null;
		let refusalCode: RefusalReason | null = null;

		switch (op.kind) {
			case "replaceBlock": {
				const text = op.text ?? "";
				if (text.trim().length === 0) {
					refusalCode = "empty_text";
					break;
				}
				nextMarkdown = text;
				break;
			}
			case "insertText": {
				if (!TEXT_BLOCK_KINDS.has(block.kind)) {
					refusalCode = "not_a_text_block";
					break;
				}
				const text = op.text ?? "";
				if (text.trim().length === 0) {
					refusalCode = "empty_text";
					break;
				}
				if (op.at === "start") {
					const markup = leadingBlockMarkup(block.kind, before);
					nextMarkdown = `${markup}${text} ${before.slice(markup.length).replace(/^\s+/, "")}`;
				} else {
					nextMarkdown = `${before} ${text}`;
				}
				break;
			}
			case "replaceRange": {
				const find = op.find ?? "";
				if (find.length === 0) {
					refusalCode = "find_not_found";
					break;
				}
				const occurrences = countOccurrences(before, find);
				if (occurrences === 0) {
					refusalCode = "find_not_found";
					break;
				}
				if (occurrences > 1) {
					refusalCode = "find_ambiguous";
					break;
				}
				// A replacer function, not a string: `String.replace` reads `$$`,
				// `$&`, `` $` `` and `$'` in a string replacement as patterns, so
				// "$$5" was stored as "$5" and "$&" as the found text (RV-1A).
				const replacement = op.text ?? "";
				nextMarkdown = before.replace(find, () => replacement);
				break;
			}
			case "toggleTask": {
				if (block.kind !== "taskList") {
					refusalCode = "not_a_task_block";
					break;
				}
				const toggled = toggleTaskItem(before, op.checked);
				if (toggled === null) {
					refusalCode = "not_a_task_block";
					break;
				}
				nextMarkdown = toggled;
				break;
			}
			case "addTableRow": {
				if (block.kind !== "table") {
					refusalCode = "not_a_table_block";
					break;
				}
				const withRow = appendTableRow(before, op.cells ?? []);
				if (withRow === null) {
					refusalCode = "bad_row";
					break;
				}
				nextMarkdown = withRow;
				break;
			}
		}

		if (refusalCode) {
			refuse(refusalCode);
			continue;
		}

		// The op's result is re-read as the blocks a reload will read (RV-1A):
		// text that is really two paragraphs becomes two blocks, the kind is
		// the one its text now has, and a marker line in the text is dropped
		// rather than stored inside this block — where the next reload would
		// have absorbed it and handed another block's id to this text.
		const rebuilt = reblock(block.id, nextMarkdown as string, taken);
		if (rebuilt.length === 0) {
			refuse("empty_text");
			continue;
		}
		working.splice(index, 1, ...rebuilt);
		if (rebuilt.length > 1) {
			indexById = new Map(working.map((b, i) => [b.id, i]));
		}
		inverses.push({
			opId: op.opId,
			blockId: block.id,
			previousMarkdown: before,
			...(rebuilt.length > 1
				? { insertedBlockIds: rebuilt.slice(1).map((b) => b.id) }
				: {}),
		});
		outcomes.push({
			opId: op.opId,
			kind: op.kind,
			blockId: op.blockId,
			blockLabel: op.blockLabel,
			status: "applied",
		});
	}

	const applied = outcomes.filter((o) => o.status === "applied").length;
	return {
		patchId: input.patch.patchId,
		label: input.patch.label,
		appliedAt: Date.now(),
		outcomes,
		applied,
		refused: outcomes.length - applied,
		blocks: working,
		markdown: serializeDocument(working),
		inverses,
	};
}
