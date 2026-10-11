/**
 * Marks the changed words of a rendered block (ruling 76, versioning.md §5.4).
 * The block is drawn first, with the app's own Markdown renderer, so its markup
 * (bold, links, lists, a checkbox) is the reader's own; then the words only the
 * newer text has are wrapped in `<mark>` where they stand and the words only the
 * older text had are put back as `<del>`. A change inside bold stays inside the
 * bold. Browser only (it walks a DOM), and unit-tested with jsdom.
 *
 * Each mark carries `data-sr`: the words a screen reader hears before it
 * ("Added: ", "Removed: "), drawn by CSS `::before` so a block of marked words
 * does not fill the markup with hidden text.
 */
import { diffWords } from "./document-diff";

export interface MarkLabels {
	added: string;
	removed: string;
}

const BLOCKISH = new Set([
	"P",
	"LI",
	"UL",
	"OL",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"BLOCKQUOTE",
	"PRE",
	"TR",
	"DIV",
	"TABLE",
	"HR",
	"BR",
]);

interface TextRun {
	node: Text;
	/** Where the node's text starts in the block's visible text. */
	start: number;
}

function parse(html: string): DocumentFragment {
	const template = document.createElement("template");
	template.innerHTML = html;
	return template.content;
}

/** The block's visible text and where each text node sits in it; block-level elements are separated by a line break. */
function collect(root: Node): { text: string; runs: TextRun[] } {
	let text = "";
	const runs: TextRun[] = [];
	const breakLine = () => {
		if (text !== "" && !text.endsWith("\n")) text += "\n";
	};
	const walk = (node: Node) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				const data = (child as Text).data;
				if (data === "") continue;
				runs.push({ node: child as Text, start: text.length });
				text += data;
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				const blockish = BLOCKISH.has((child as Element).tagName);
				if (blockish) breakLine();
				walk(child);
				if (blockish) breakLine();
			}
		}
	};
	walk(root);
	return { text: text.replace(/\n+$/, ""), runs };
}

/** The text a reader sees in a rendered block. */
export function visibleText(html: string): string {
	return collect(parse(html)).text;
}

function serialize(fragment: DocumentFragment): string {
	const holder = document.createElement("div");
	holder.append(fragment);
	return holder.innerHTML;
}

interface RunEdits {
	/** Local ranges of the node's text that are new. */
	adds: Array<{ start: number; end: number }>;
	/** Words the newer text lost, to stand before the character at `at` (a local offset; the node's length means after its last). */
	dels: Array<{ at: number; text: string }>;
}

function deletedElement(text: string, label: string): HTMLElement {
	const del = document.createElement("del");
	del.className = "hd";
	del.setAttribute("data-sr", label);
	del.textContent = text.replace(/\s+/g, " ");
	return del;
}

/**
 * Replaces one text node with its marked self: its new words wrapped in `<mark>`,
 * the words that were lost put back as `<del>` where they stood. Each node is
 * rebuilt on its own, so one change never disturbs where another lands.
 */
function rebuildRun(node: Text, edits: RunEdits, labels: MarkLabels): number {
	const text = node.data;
	const cuts = new Set<number>([0, text.length]);
	for (const add of edits.adds) {
		cuts.add(add.start);
		cuts.add(add.end);
	}
	for (const del of edits.dels) cuts.add(del.at);
	const points = [...cuts].sort((a, b) => a - b);

	const fragment = document.createDocumentFragment();
	let marks = 0;
	for (let i = 0; i < points.length; i++) {
		const from = points[i];
		for (const del of edits.dels) {
			if (del.at !== from || del.text.replace(/\s+/g, "") === "") continue;
			fragment.append(deletedElement(del.text, labels.removed));
			marks += 1;
		}
		const to = points[i + 1];
		if (to === undefined) break;
		const piece = text.slice(from, to);
		if (piece === "") continue;
		const added = edits.adds.some((add) => add.start <= from && to <= add.end);
		if (added && piece.trim() !== "") {
			const mark = document.createElement("mark");
			mark.className = "hm";
			mark.setAttribute("data-sr", labels.added);
			mark.textContent = piece;
			fragment.append(mark);
			marks += 1;
		} else {
			fragment.append(document.createTextNode(piece));
		}
	}
	node.replaceWith(fragment);
	return marks;
}

/**
 * `html` (the newer block) with its changed words marked against `baseHtml`
 * (the older one). `marks` counts the marks and deletions made.
 */
export function markWords(
	html: string,
	baseHtml: string,
	labels: MarkLabels,
): { html: string; marks: number } {
	const target = parse(html);
	const { text: targetText, runs } = collect(target);
	const baseText = visibleText(baseHtml);
	const ops = diffWords(baseText, targetText);

	const perRun = new Map<Text, RunEdits>();
	const editsOf = (node: Text): RunEdits => {
		let edits = perRun.get(node);
		if (!edits) {
			edits = { adds: [], dels: [] };
			perRun.set(node, edits);
		}
		return edits;
	};

	let offset = 0;
	let tailDeletion: string | null = null;
	for (const op of ops) {
		if (op.type === "del") {
			// Before the first character at or after this place; past the last one, after it.
			const run = runs.find(
				(candidate) => offset < candidate.start + candidate.node.data.length,
			);
			if (run) {
				editsOf(run.node).dels.push({
					at: Math.max(0, offset - run.start),
					text: op.text,
				});
			} else {
				tailDeletion = (tailDeletion ?? "") + op.text;
			}
			continue;
		}
		if (op.type === "add") {
			const end = offset + op.text.length;
			for (const run of runs) {
				const from = Math.max(offset, run.start);
				const to = Math.min(end, run.start + run.node.data.length);
				if (from < to) {
					editsOf(run.node).adds.push({
						start: from - run.start,
						end: to - run.start,
					});
				}
			}
		}
		offset += op.text.length;
	}

	// Where words lost at the very end go: the element that held the last text.
	const lastParent = runs.at(-1)?.node.parentNode ?? null;
	let marks = 0;
	for (const [node, edits] of perRun) marks += rebuildRun(node, edits, labels);
	if (tailDeletion !== null && tailDeletion.replace(/\s+/g, "") !== "") {
		(lastParent ?? target).append(deletedElement(tailDeletion, labels.removed));
		marks += 1;
	}
	return { html: serialize(target), marks };
}

/** `html` with every word marked: a block the newer text added. */
export function markAdded(
	html: string,
	labels: MarkLabels,
): { html: string; marks: number } {
	const target = parse(html);
	const { runs } = collect(target);
	let marks = 0;
	for (const run of runs) {
		if (run.node.data.trim() === "") continue;
		marks += rebuildRun(
			run.node,
			{ adds: [{ start: 0, end: run.node.data.length }], dels: [] },
			labels,
		);
	}
	return { html: serialize(target), marks };
}
