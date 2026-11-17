/**
 * The page's half of read aloud's report bridge (`report-bridge.ts` is the frame's).
 *
 * The page reads a report from its own inert copy (`DOMParser`: no script runs and
 * nothing loads in it), never from the frame: what the frame says is only ever a
 * place, and the page checks it against that copy.
 *
 * - `readFrameMessage` takes a message only from the report's own frame
 *   (`event.source` is its window: an opaque frame's origin is `"null"`, so an origin
 *   proves nothing, and anything else than `"null"` means the frame is not opaque any
 *   more), of one of three exact shapes (`ready`, `selection`, `deselect`), with at
 *   most nine keys, every number finite and every position an integer inside the
 *   copy. Anything else is dropped, and nothing answers it. `AppFrame.svelte`'s
 *   message handling is the pattern.
 * - `postToFrame` posts with `"*"`: an opaque frame has no origin to name, so no
 *   message carries anything but places.
 * - `spansOf` names ranges over the copy as spans (block, start, end), cut wherever
 *   something the walk leaves out lies between two of a block's text nodes (a basis
 *   marker and its tooltip), so a mark drawn in the frame never covers it.
 *
 * A selection never starts a reading: it only shows the page's own Read from here,
 * which a press in the page starts (`ReportReadAloud.svelte`).
 */
import type { ReadAloudView } from "$lib/stores/read-aloud";
import {
	REPORT_BRIDGE_KIND,
	REPORT_BRIDGE_MAX_SPANS,
	type ReportSpan,
} from "./report-bridge";
import { REPORT_UNIT_RULES, reportBlocks, reportRoot } from "./report-units";

/** The page's inert copy of a report and its units, the same the bridge finds in the frame. */
export type ReportCopy = {
	doc: Document;
	/** Its content (`#report-content`): what is read. */
	root: Element;
	blocks: Text[][];
	/** Each block's length in characters. */
	lengths: number[];
	chars: number;
	/** Each block's text: its nodes' text, joined. */
	texts: string[];
	/**
	 * Each block's breaks: the offsets where one of its text nodes ends and the next
	 * begins with something the walk leaves out between them. A span never crosses one.
	 */
	breaks: number[][];
	/** Where each unit text node is: its block and where it starts in it. */
	places: Map<Text, { block: number; start: number }>;
};

/** Parses a report's HTML into an inert copy (`DOMParser` runs no script and loads nothing) and finds its units. */
export function makeReportCopy(html: string): ReportCopy {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const root = reportRoot(doc);
	const blocks = reportBlocks(root, REPORT_UNIT_RULES);
	// Every non-empty text node of the document, in order: two of a block's nodes
	// are next to each other when nothing that is text lies between them.
	const order = new Map<Text, number>();
	const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode())
		if ((node as Text).data.length > 0) order.set(node as Text, order.size);
	const texts: string[] = [];
	const lengths: number[] = [];
	const breaks: number[][] = [];
	const places = new Map<Text, { block: number; start: number }>();
	blocks.forEach((nodes, block) => {
		let length = 0;
		const cuts: number[] = [];
		nodes.forEach((node, i) => {
			const before = nodes[i - 1];
			if (before && (order.get(node) ?? -1) !== (order.get(before) ?? -2) + 1)
				cuts.push(length);
			places.set(node, { block, start: length });
			length += node.data.length;
		});
		texts.push(nodes.map((node) => node.data).join(""));
		lengths.push(length);
		breaks.push(cuts);
	});
	return {
		doc,
		root,
		blocks,
		lengths,
		chars: lengths.reduce((sum, length) => sum + length, 0),
		texts,
		breaks,
		places,
	};
}

/**
 * The page's own CSP nonce (`%sveltekit.nonce%` on `app.html`'s scripts), which the
 * bridge's script carries: a srcdoc frame inherits the page's policy, which refuses
 * an inline script without it. Read from the `nonce` property (a browser empties the
 * attribute once the page has loaded); null on a page that has none.
 */
export function pageScriptNonce(doc: Document = document): string | null {
	const script = doc.querySelector<HTMLScriptElement>("script[nonce]");
	return script?.nonce || script?.getAttribute("nonce") || null;
}

/** What the page takes from the frame, checked. */
export type FrameMessage =
	| { type: "ready"; blocks: number; chars: number }
	| {
			type: "selection";
			block: number;
			offset: number;
			/** The selection's box in the frame's viewport, to place the page's own control by. */
			rect: { x: number; y: number; width: number; height: number };
	  }
	| { type: "deselect" };

/** No message the page takes has more keys than this (a selection's nine). */
const MAX_KEYS = 9;
/** A count the frame reports: no report has more blocks or characters. */
const MAX_COUNT = 10_000_000;
/** A coordinate in the frame, in pixels: a screen is never this big. */
const MAX_PIXELS = 1_000_000;

function hasKeys(data: object, keys: readonly string[]): boolean {
	const own = Object.keys(data);
	return own.length === keys.length && keys.every((key) => own.includes(key));
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value >= 0 &&
	value <= MAX_COUNT;

const isPixel = (value: unknown, min: number): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= min &&
	value <= MAX_PIXELS;

/**
 * A message from the report's frame, checked against the page's copy; null for
 * anything else: another window, an origin that is not the opaque frame's, a frame
 * that is gone, another shape, a position the copy does not have.
 */
export function readFrameMessage(
	event: MessageEvent,
	frame: HTMLIFrameElement | null,
	copy: ReportCopy,
): FrameMessage | null {
	const win = frame?.contentWindow ?? null;
	if (!win || event.source !== win) return null;
	if (event.origin !== "null") return null;
	const data = event.data as Record<string, unknown> | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	if (Object.keys(data).length > MAX_KEYS) return null;
	if (data.v !== 1 || data.kind !== REPORT_BRIDGE_KIND) return null;
	if (data.type === "deselect")
		return hasKeys(data, ["v", "kind", "type"]) ? { type: "deselect" } : null;
	if (data.type === "ready")
		return hasKeys(data, ["v", "kind", "type", "blocks", "chars"]) &&
			isCount(data.blocks) &&
			isCount(data.chars)
			? { type: "ready", blocks: data.blocks, chars: data.chars }
			: null;
	if (data.type !== "selection") return null;
	if (
		!hasKeys(data, [
			"v",
			"kind",
			"type",
			"block",
			"offset",
			"x",
			"y",
			"width",
			"height",
		])
	)
		return null;
	const { block, offset, x, y, width, height } = data;
	if (!isCount(block) || block >= copy.blocks.length) return null;
	if (!isCount(offset) || offset > (copy.lengths[block] ?? -1)) return null;
	if (
		!isPixel(x, -MAX_PIXELS) ||
		!isPixel(y, -MAX_PIXELS) ||
		!isPixel(width, 0) ||
		!isPixel(height, 0)
	)
		return null;
	return { type: "selection", block, offset, rect: { x, y, width, height } };
}

/** What the page tells the frame: only ever places, and `hello` and `clear`. */
export type PageMessage =
	| { type: "hello" }
	| { type: "clear" }
	| {
			type: "marks";
			sentence: ReportSpan[];
			word: ReportSpan | null;
			target: ReportSpan[];
	  }
	| { type: "focus"; spans: ReportSpan[]; mode: "center" | "reveal" };

/** Posts to the report's frame with `"*"`: an opaque frame has no origin to name. */
export function postToFrame(
	frame: HTMLIFrameElement | null,
	message: PageMessage,
): void {
	const win = frame?.contentWindow;
	if (!win) return;
	try {
		win.postMessage({ v: 1, kind: REPORT_BRIDGE_KIND, ...message }, "*");
	} catch {
		// The frame went away between the check and the post: nothing to tell.
	}
}

/** A point of the copy as a block and an offset; null outside its units. */
function placeOf(
	copy: ReportCopy,
	node: Node,
	offset: number,
): { block: number; offset: number } | null {
	const at = copy.places.get(node as Text);
	if (!at || offset < 0 || offset > (node as Text).data.length) return null;
	return { block: at.block, offset: at.start + offset };
}

/** A block's part from `start` to `end`, cut at its breaks. */
function cut(copy: ReportCopy, block: number, start: number, end: number) {
	const spans: ReportSpan[] = [];
	let from = start;
	for (const at of copy.breaks[block] ?? []) {
		if (at <= from || at >= end) continue;
		spans.push([block, from, at]);
		from = at;
	}
	if (end > from) spans.push([block, from, end]);
	return spans;
}

/**
 * The spans ranges over the copy cover, in order, at most the bridge's
 * `REPORT_BRIDGE_MAX_SPANS`: each range cut at blocks and at breaks, and a span
 * joined to the one before it when it overlaps it, or when only spaces of the same
 * text lie between them (the words of a line). A range outside the units is left out.
 */
export function spansOf(
	copy: ReportCopy,
	ranges: readonly Range[],
): ReportSpan[] {
	const pieces: ReportSpan[] = [];
	for (const range of ranges) {
		const start = placeOf(copy, range.startContainer, range.startOffset);
		const end = placeOf(copy, range.endContainer, range.endOffset);
		if (!start || !end || end.block < start.block) continue;
		for (let block = start.block; block <= end.block; block++)
			pieces.push(
				...cut(
					copy,
					block,
					block === start.block ? start.offset : 0,
					block === end.block ? end.offset : (copy.lengths[block] ?? 0),
				),
			);
	}
	const spans: ReportSpan[] = [];
	for (const piece of pieces) {
		const last = spans[spans.length - 1];
		const joins =
			last !== undefined &&
			last[0] === piece[0] &&
			piece[1] >= last[1] &&
			// Two spans that overlap are one; two with a gap, when it is spaces of one text.
			(piece[1] < last[2] ||
				((copy.texts[piece[0]] ?? "").slice(last[2], piece[1]).trim() === "" &&
					!(copy.breaks[piece[0]] ?? []).some(
						(at) => at >= last[2] && at <= piece[1],
					)));
		if (last && joins) last[2] = Math.max(last[2], piece[2]);
		else spans.push([...piece]);
	}
	return spans.slice(0, REPORT_BRIDGE_MAX_SPANS);
}

/**
 * The marks the frame is to draw for a view, the way `ReadAloudMarks.svelte` draws
 * them on a page: the sentence and the word being read, the target alone while the
 * scrubber is dragged, no word while stopped or waiting; `clear` when nothing of
 * this report (`key`) is being read.
 */
export function marksMessage(
	view: ReadAloudView,
	key: string,
	copy: ReportCopy,
): PageMessage {
	const marks = view.marks;
	if (view.status === "idle" || view.key !== key || !marks)
		return { type: "clear" };
	const dragging = view.drag !== null;
	const showWord =
		!dragging && view.status !== "stopped" && view.status !== "waiting";
	const word = showWord && marks.word ? spansOf(copy, [marks.word]) : [];
	return {
		type: "marks",
		sentence: dragging ? [] : spansOf(copy, marks.sentence),
		word: word.length === 1 ? (word[0] as ReportSpan) : null,
		target: dragging ? spansOf(copy, marks.target) : [],
	};
}
