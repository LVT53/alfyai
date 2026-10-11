/**
 * What changed between two versions of a Document, for History's preview
 * (ruling 76, versioning.md §5.4). Pure: no DOM, no Svelte, so the alignment and
 * the word diff are unit-tested without a browser.
 *
 * Blocks are matched by id (the id is written into the stored Markdown, so it
 * survives every save); words inside a block that changed are matched by a word
 * diff. A block only the newer text has is ADDED, one only the older text has is
 * REMOVED and stands where it stood. A body with no markers (an old or foreign
 * one) is matched by each block's own text instead, so equal paragraphs still
 * match and a changed paragraph reads as a removed one and an added one.
 */
import {
	type DocumentBlock,
	parseDocument,
} from "$lib/shared/artifact-document/blocks";

export type WordOp = { type: "same" | "add" | "del"; text: string };

// A word is a run of letters and digits in any script, a run of white space, or
// one other character: Hungarian letters are letters, not punctuation.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Above this many token comparisons a block is shown as one deletion and one addition: the table stays small. */
const MAX_DIFF_CELLS = 250_000;

function tokensOf(text: string): string[] {
	return text.match(TOKEN) ?? [];
}

function pushOp(ops: WordOp[], type: WordOp["type"], text: string) {
	if (text === "") return;
	const last = ops.at(-1);
	if (last && last.type === type) last.text += text;
	else ops.push({ type, text });
}

/**
 * A word diff of two texts: the words they share, the words only `target` has
 * (`add`) and the words only `base` has (`del`), in reading order, a deletion
 * before the addition that replaces it.
 */
export function diffWords(base: string, target: string): WordOp[] {
	if (base === target) return base === "" ? [] : [{ type: "same", text: base }];
	const a = tokensOf(base);
	const b = tokensOf(target);

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix += 1;
	}
	const middleA = a.slice(prefix, a.length - suffix);
	const middleB = b.slice(prefix, b.length - suffix);

	const ops: WordOp[] = [];
	pushOp(ops, "same", a.slice(0, prefix).join(""));

	const n = middleA.length;
	const m = middleB.length;
	if (n * m > MAX_DIFF_CELLS) {
		pushOp(ops, "del", middleA.join(""));
		pushOp(ops, "add", middleB.join(""));
	} else {
		// The classic longest-common-subsequence table, walked back from the end.
		const width = m + 1;
		const table = new Uint32Array((n + 1) * width);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				table[i * width + j] =
					middleA[i] === middleB[j]
						? table[(i + 1) * width + j + 1] + 1
						: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && middleA[i] === middleB[j]) {
				pushOp(ops, "same", middleA[i]);
				i += 1;
				j += 1;
			} else if (
				j < m &&
				(i === n || table[i * width + j + 1] >= table[(i + 1) * width + j])
			) {
				// Deletions are collected first so a replaced word reads "del, add".
				let deleted = "";
				while (
					i < n &&
					!(j < m && middleA[i] === middleB[j]) &&
					table[(i + 1) * width + j] >= table[i * width + j + 1]
				) {
					deleted += middleA[i];
					i += 1;
				}
				pushOp(ops, "del", deleted);
				if (deleted === "") {
					pushOp(ops, "add", middleB[j]);
					j += 1;
				}
			} else {
				pushOp(ops, "del", middleA[i]);
				i += 1;
			}
		}
	}

	pushOp(ops, "same", a.slice(a.length - suffix).join(""));
	return ops;
}

/** One block of the preview, as it stands against the version it is compared with. */
export type DiffBlock =
	| { type: "same"; id: string; markdown: string }
	| { type: "changed"; id: string; markdown: string; baseMarkdown: string }
	| { type: "added"; id: string; markdown: string }
	| { type: "removed"; id: string; markdown: string; label: string };

/** A block's identity across versions: its id, else its own text (with its place among equal ones). */
function keysOf(blocks: readonly DocumentBlock[]): string[] {
	const seen = new Map<string, number>();
	return blocks.map((block) => {
		const base = block.id ? `id:${block.id}` : `hash:${block.hash}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return count === 1 ? base : `${base}#${count}`;
	});
}

/**
 * The target text's blocks against the base text's. `base` is `null` when there
 * is nothing to compare with (a first version): every block is the same.
 */
export function alignDocuments(
	base: string | null,
	target: string,
): DiffBlock[] {
	const targetBlocks = parseDocument(target, { mint: false }).blocks;
	if (base === null) {
		return targetBlocks.map((block, index) => ({
			type: "same",
			id: block.id || `t${index}`,
			markdown: block.markdown,
		}));
	}
	const baseBlocks = parseDocument(base, { mint: false }).blocks;
	const baseKeys = keysOf(baseBlocks);
	const targetKeys = keysOf(targetBlocks);
	const baseIndexByKey = new Map(baseKeys.map((key, index) => [key, index]));
	const matchedBase = new Set<number>();
	for (const key of targetKeys) {
		const index = baseIndexByKey.get(key);
		if (index !== undefined) matchedBase.add(index);
	}

	const out: DiffBlock[] = [];
	let pointer = 0;
	// Within one gap between matched blocks what is gone is shown before what came
	// in, so a replaced paragraph reads "struck, then new".
	let arrived: DiffBlock[] = [];
	const emitRemovedUpTo = (limit: number) => {
		for (; pointer < limit; pointer++) {
			if (matchedBase.has(pointer)) continue;
			const block = baseBlocks[pointer];
			out.push({
				type: "removed",
				id: block.id || `r${pointer}`,
				markdown: block.markdown,
				label: block.label,
			});
		}
	};
	const flushArrived = () => {
		out.push(...arrived);
		arrived = [];
	};

	targetBlocks.forEach((block, index) => {
		const baseIndex = baseIndexByKey.get(targetKeys[index]);
		const id = block.id || `t${index}`;
		if (baseIndex === undefined) {
			arrived.push({ type: "added", id, markdown: block.markdown });
			return;
		}
		// Whatever stood between the last matched block and this one is gone.
		if (baseIndex >= pointer) {
			emitRemovedUpTo(baseIndex);
			pointer = baseIndex + 1;
		}
		flushArrived();
		const before = baseBlocks[baseIndex];
		out.push(
			before.hash === block.hash
				? { type: "same", id, markdown: block.markdown }
				: {
						type: "changed",
						id,
						markdown: block.markdown,
						baseMarkdown: before.markdown,
					},
		);
	});
	emitRemovedUpTo(baseBlocks.length);
	flushArrived();
	return out;
}

/** The blocks that changed in any way, in order: the change stepper's stops. */
export function changeBlocks(blocks: readonly DiffBlock[]): DiffBlock[] {
	return blocks.filter((block) => block.type !== "same");
}

export type FoldedItem =
	| { type: "block"; block: DiffBlock }
	| { type: "fold"; count: number; blocks: DiffBlock[] };

/** A stretch of unchanged blocks this long (not counting the context kept beside a change) folds into one line. */
const FOLD_AT_LEAST = 3;

/**
 * The blocks with long unchanged stretches folded into "12 unchanged
 * paragraphs": a block of context stays on each side of a change, and a short
 * stretch is left as it is. With nothing changed there is nothing to fold around,
 * so everything shows.
 */
export function foldUnchanged(blocks: readonly DiffBlock[]): FoldedItem[] {
	if (!blocks.some((block) => block.type !== "same")) {
		return blocks.map((block) => ({ type: "block", block }));
	}
	const out: FoldedItem[] = [];
	let index = 0;
	while (index < blocks.length) {
		if (blocks[index].type !== "same") {
			out.push({ type: "block", block: blocks[index] });
			index += 1;
			continue;
		}
		let end = index;
		while (end < blocks.length && blocks[end].type === "same") end += 1;
		const run = blocks.slice(index, end);
		const keepHead = index > 0 ? 1 : 0;
		const keepTail = end < blocks.length ? 1 : 0;
		const interior = run.length - keepHead - keepTail;
		if (interior >= FOLD_AT_LEAST) {
			for (const block of run.slice(0, keepHead)) {
				out.push({ type: "block", block });
			}
			out.push({
				type: "fold",
				count: interior,
				blocks: run.slice(keepHead, run.length - keepTail),
			});
			for (const block of run.slice(run.length - keepTail)) {
				out.push({ type: "block", block });
			}
		} else {
			for (const block of run) out.push({ type: "block", block });
		}
		index = end;
	}
	return out;
}
