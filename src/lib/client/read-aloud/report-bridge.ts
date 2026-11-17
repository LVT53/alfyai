/**
 * Read aloud's bridge into a standard report's frame: the one inline script of the
 * app's own that the preview adds to a report's trusted srcdoc (never to the static
 * one), so the page can mark the reading inside the report and hear where the
 * reader selected text. The frame stays opaque (`html-sandbox.ts`: never
 * `allow-same-origin`), so the two talk by `postMessage` alone, and only of places:
 *
 * - the page sends marks (spans: a block, a start and an end), a focus (spans and a
 *   mode), `clear` and `hello`;
 * - the bridge sends `ready` (how many blocks and characters it found) and a
 *   selection (a block, an offset and a rect to place the page's own control by),
 *   or `deselect`. It never sends text, HTML, an address or a style, and it can
 *   never start a reading: only a press in the page does.
 *
 * Both sides read the report with the same walk (`report-units.ts`), so a block and
 * an offset name the same place in the page's inert copy and in the frame.
 *
 * The bridge accepts a message only from its parent window, of one of four exact
 * shapes with every span inside the report, and posts only to the app's origin,
 * written into the script when it is injected. The page answers a message only
 * from this frame's window (`report-bridge-host.ts`).
 *
 * `reportBridge` is self-contained: `reportBridgeScript` writes its own source into
 * the srcdoc, with the walk's. It draws the marks as CSS highlights, which change no
 * node of the report, in the Document marks' tints written out for light and dark
 * (the app's tokens do not exist in the frame).
 */
import {
	pointInBlocks,
	positionInBlocks,
	REPORT_UNIT_RULES,
	type ReportUnitRules,
	reportBlocks,
} from "./report-units";

/** The `kind` of every message either side sends. */
export const REPORT_BRIDGE_KIND = "alfy.readAloud";

/** At most this many spans in a message: a sentence's words, or a drag's target. */
export const REPORT_BRIDGE_MAX_SPANS = 400;

/** A place in the report: its block, and the start and end of a run of its characters. */
export type ReportSpan = [block: number, start: number, end: number];

export type ReportBridgeConfig = {
	/** The app's origin: the only one the bridge posts to. */
	origin: string;
	kind: string;
	rules: ReportUnitRules;
	maxSpans: number;
	/** The marks' highlight rules, with their colours written out. */
	css: string;
};

type ReportKit = {
	reportBlocks: typeof reportBlocks;
	positionInBlocks: typeof positionInBlocks;
	pointInBlocks: typeof pointInBlocks;
};

/**
 * The marks' look: the Document marks' tints (`--read-aloud-sentence`, `-word`,
 * `-target` in `app.css`: the accent at 12, 30 and 22% in light, 18, 36 and 28% in
 * dark), written out, for the report's own two ways of being dark.
 */
const MARK_CSS = (() => {
	const rules = (rgb: string, sentence: number, word: number, target: number) =>
		`::highlight(alfy-read-aloud-sentence){background-color:rgba(${rgb},${sentence})}` +
		`::highlight(alfy-read-aloud-target){background-color:rgba(${rgb},${target})}` +
		`::highlight(alfy-read-aloud-word){background-color:rgba(${rgb},${word})}`;
	const dark = rules("212,131,107", 0.18, 0.36, 0.28);
	return `${rules("193,95,60", 0.12, 0.3, 0.22)}@media (prefers-color-scheme: dark){${dark}}${dark
		.split("::highlight")
		.filter((part) => part !== "")
		.map((part) => `html.dark ::highlight${part}`)
		.join("")}`;
})();

export function reportBridgeConfig(origin: string): ReportBridgeConfig {
	return {
		origin,
		kind: REPORT_BRIDGE_KIND,
		rules: REPORT_UNIT_RULES,
		maxSpans: REPORT_BRIDGE_MAX_SPANS,
		css: MARK_CSS,
	};
}

/**
 * The bridge, as it runs in the report's frame (`win`). Self-contained: everything
 * it uses is its arguments or the frame's own globals.
 */
export function reportBridge(
	config: ReportBridgeConfig,
	kit: ReportKit,
	win: Window,
): void {
	const doc = win.document;
	const parent = win.parent;
	if (!parent || parent === win) return;
	const root = doc.getElementById("report-content") || doc.body;
	if (!root) return;
	const scroller =
		root.id === "report-content"
			? root
			: doc.scrollingElement || doc.documentElement;
	const blocks = kit.reportBlocks(root, config.rules);
	const lengths = blocks.map((nodes) =>
		nodes.reduce((sum, node) => sum + node.data.length, 0),
	);
	const kind = config.kind;
	const post = (message: Record<string, unknown>) => {
		try {
			parent.postMessage(message, config.origin);
		} catch {
			// The page is gone, or is no longer the app: nothing to tell.
		}
	};
	const ready = () =>
		post({
			v: 1,
			kind,
			type: "ready",
			blocks: blocks.length,
			chars: lengths.reduce((sum, length) => sum + length, 0),
		});

	// ---- What the page may say: four exact shapes, every span inside the report.
	const whole = (value: unknown): value is number =>
		typeof value === "number" && Number.isInteger(value);
	const isSpan = (value: unknown): value is ReportSpan => {
		if (!Array.isArray(value) || value.length !== 3) return false;
		const [block, start, end] = value as unknown[];
		return (
			whole(block) &&
			whole(start) &&
			whole(end) &&
			block >= 0 &&
			block < blocks.length &&
			start >= 0 &&
			start <= end &&
			end <= (lengths[block] ?? -1)
		);
	};
	const isSpans = (value: unknown): value is ReportSpan[] =>
		Array.isArray(value) &&
		value.length <= config.maxSpans &&
		value.every(isSpan);
	const hasKeys = (data: object, keys: string[]) => {
		const own = Object.keys(data);
		return own.length === keys.length && keys.every((key) => own.includes(key));
	};
	type Said =
		| { type: "hello" | "clear" }
		| {
				type: "marks";
				sentence: ReportSpan[];
				word: ReportSpan | null;
				target: ReportSpan[];
		  }
		| { type: "focus"; spans: ReportSpan[]; mode: "center" | "reveal" };
	const read = (event: MessageEvent): Said | null => {
		if (event.source !== parent) return null;
		const data = event.data as Record<string, unknown> | null;
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		if (data.v !== 1 || data.kind !== kind) return null;
		if (data.type === "hello" || data.type === "clear")
			return hasKeys(data, ["v", "kind", "type"]) ? { type: data.type } : null;
		if (data.type === "marks")
			return hasKeys(data, [
				"v",
				"kind",
				"type",
				"sentence",
				"word",
				"target",
			]) &&
				isSpans(data.sentence) &&
				isSpans(data.target) &&
				(data.word === null || isSpan(data.word))
				? {
						type: "marks",
						sentence: data.sentence,
						word: data.word,
						target: data.target,
					}
				: null;
		if (data.type === "focus")
			return hasKeys(data, ["v", "kind", "type", "spans", "mode"]) &&
				isSpans(data.spans) &&
				data.spans.length > 0 &&
				(data.mode === "center" || data.mode === "reveal")
				? { type: "focus", spans: data.spans, mode: data.mode }
				: null;
		return null;
	};

	// ---- The marks: CSS highlights, which change no node of the report.
	const rangeOf = (span: ReportSpan): Range | null => {
		const start = kit.pointInBlocks(blocks, span[0], span[1]);
		const end = kit.pointInBlocks(blocks, span[0], span[2], true);
		if (!start || !end) return null;
		const range = doc.createRange();
		range.setStart(start.node, start.offset);
		range.setEnd(end.node, end.offset);
		return range;
	};
	const scope = win as Window & {
		CSS?: { highlights?: Map<string, unknown> };
		Highlight?: new (...ranges: Range[]) => { priority: number };
	};
	let styled = false;
	const paint = (name: string, spans: ReportSpan[], priority: number) => {
		const registry = scope.CSS?.highlights;
		const Highlight = scope.Highlight;
		if (!registry || !Highlight) return;
		const ranges = spans
			.map(rangeOf)
			.filter((range): range is Range => range !== null);
		if (ranges.length === 0) {
			registry.delete(name);
			return;
		}
		if (!styled) {
			styled = true;
			const style = doc.createElement("style");
			style.setAttribute("data-alfy-read-aloud", "");
			style.textContent = config.css;
			(doc.head || doc.documentElement).appendChild(style);
		}
		const highlight = new Highlight(...ranges);
		highlight.priority = priority;
		registry.set(name, highlight);
	};

	// ---- Focus: the report's own scroller brings the spans into view.
	const focus = (spans: ReportSpan[], mode: "center" | "reveal") => {
		let top = Number.POSITIVE_INFINITY;
		let bottom = Number.NEGATIVE_INFINITY;
		for (const span of spans) {
			const range = rangeOf(span);
			if (!range) continue;
			for (const rect of Array.from(range.getClientRects?.() ?? [])) {
				top = Math.min(top, rect.top);
				bottom = Math.max(bottom, rect.bottom);
			}
		}
		const frame = scroller.getBoundingClientRect();
		const area = Math.max(1, scroller.clientHeight);
		const from = Number.isFinite(top) ? top - frame.top : 0;
		const to = Number.isFinite(bottom) ? bottom - frame.top : 0;
		if (mode === "reveal" && from >= 0 && to <= area) return;
		const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		const goal = Math.min(
			max,
			Math.max(0, scroller.scrollTop + (from + to) / 2 - area / 2),
		);
		const still =
			typeof win.matchMedia === "function" &&
			win.matchMedia("(prefers-reduced-motion: reduce)").matches;
		scroller.scrollTo({ top: goal, behavior: still ? "auto" : "smooth" });
	};

	win.addEventListener("message", (event) => {
		const said = read(event);
		if (!said) return;
		if (said.type === "hello") ready();
		else if (said.type === "clear") {
			for (const name of [
				"alfy-read-aloud-sentence",
				"alfy-read-aloud-target",
				"alfy-read-aloud-word",
			])
				scope.CSS?.highlights?.delete(name);
		} else if (said.type === "marks") {
			paint("alfy-read-aloud-sentence", said.sentence, 0);
			paint("alfy-read-aloud-target", said.target, 1);
			paint("alfy-read-aloud-word", said.word ? [said.word] : [], 2);
		} else if (said.type === "focus") focus(said.spans, said.mode);
	});

	// ---- The reader's selection: where it starts, and its box to place a control by.
	const startOf = (range: Range): { block: number; offset: number } | null => {
		const node = range.startContainer;
		if (node.nodeType === 3)
			return kit.positionInBlocks(blocks, node, range.startOffset);
		// A selection that starts between elements: the first unit after its start.
		const walker = doc.createTreeWalker(root, 4);
		walker.currentNode = node.childNodes[range.startOffset] || node;
		for (
			let text: Node | null =
				walker.currentNode.nodeType === 3
					? walker.currentNode
					: walker.nextNode();
			text;
			text = walker.nextNode()
		) {
			const at = kit.positionInBlocks(blocks, text, 0);
			if (at) return at;
		}
		return null;
	};
	let reported = "";
	let pending = false;
	const report = () => {
		pending = false;
		const selection = doc.getSelection();
		let said: Record<string, unknown> | null = null;
		if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
			const range = selection.getRangeAt(0);
			const at = startOf(range);
			// The whole selection's box: the page puts its control above it, or below it.
			const rect = range.getBoundingClientRect?.();
			if (at && rect)
				said = {
					v: 1,
					kind,
					type: "selection",
					block: at.block,
					offset: at.offset,
					x: rect.left,
					y: rect.top,
					width: rect.width,
					height: rect.height,
				};
		}
		if (!said) {
			if (reported === "") return;
			reported = "";
			post({ v: 1, kind, type: "deselect" });
			return;
		}
		const key = JSON.stringify(said);
		if (key === reported) return;
		reported = key;
		post(said);
	};
	const schedule = () => {
		if (pending) return;
		pending = true;
		win.requestAnimationFrame(report);
	};
	doc.addEventListener("selectionchange", schedule);
	scroller.addEventListener("scroll", schedule, { passive: true });
	win.addEventListener("resize", schedule);

	ready();
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/u;
const NONCE = /^[A-Za-z0-9+/=_-]{1,200}$/u;

/**
 * The bridge as one inline `<script>`: its source and the walk's, with the app's
 * origin and the rules written in, and the page's CSP nonce, without which the
 * policy the srcdoc inherits from the page refuses it. Empty for an origin that is
 * not a plain `http(s)://host[:port]` or a nonce that is not a plain token.
 */
export function reportBridgeScript(options: {
	origin: string;
	nonce: string | null;
}): string {
	if (!ORIGIN.test(options.origin)) return "";
	if (options.nonce !== null && !NONCE.test(options.nonce)) return "";
	const config = JSON.stringify(reportBridgeConfig(options.origin)).replace(
		/</g,
		"\\u003c",
	);
	const kit = `{reportBlocks:${reportBlocks.toString()},positionInBlocks:${positionInBlocks.toString()},pointInBlocks:${pointInBlocks.toString()}}`;
	const code = `(${reportBridge.toString()})(${config},${kit},window);`.replace(
		/<\/(script)/gi,
		"<\\/$1",
	);
	const nonce = options.nonce === null ? "" : ` nonce="${options.nonce}"`;
	return `<script${nonce}>${code}</script>`;
}
