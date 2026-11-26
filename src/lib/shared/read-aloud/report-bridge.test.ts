// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REPORT_BRIDGE_KIND,
	REPORT_BRIDGE_MAX_SPANS,
	reportBridge,
	reportBridgeConfig,
	reportBridgeScript,
	withReportBridge,
} from "./report-bridge";
import { pointInBlocks, positionInBlocks, reportBlocks } from "./report-units";

const ORIGIN = "http://localhost:3000";
const KIT = { reportBlocks, positionInBlocks, pointInBlocks };

/** A report in a frame: the bridge's window is the frame's, its parent this test's window. */
const REPORT = `<div class="report-viewer"><aside class="report-sidebar"><p class="report-sidebar-title">Sections</p></aside><article class="report-content" id="report-content"><h1 class="report-title">Weekend report</h1><section class="report-section"><h2>Getting there</h2><p>The train leaves at nine<button type="button" class="basis-marker"><span class="basis-tooltip" role="tooltip">Supported claim</span></button> from the main station.</p></section></article></div>`;

class FakeHighlight {
	priority = 0;
	readonly ranges: Range[];
	constructor(...ranges: Range[]) {
		this.ranges = ranges;
	}
}

type Frame = {
	win: Window & typeof globalThis;
	doc: Document;
	highlights: Map<string, FakeHighlight>;
	posted: Array<{ data: unknown; origin: string }>;
	frames: Array<() => void>;
};

let frame: Frame;
let other: HTMLIFrameElement;

function makeFrame(): Frame {
	const iframe = document.createElement("iframe");
	document.body.append(iframe);
	const win = iframe.contentWindow as Window & typeof globalThis;
	const doc = win.document;
	doc.body.innerHTML = REPORT;
	const highlights = new Map<string, FakeHighlight>();
	const frames: Array<() => void> = [];
	Object.assign(win, {
		CSS: { highlights },
		Highlight: FakeHighlight,
		requestAnimationFrame: (callback: () => void) => {
			frames.push(callback);
			return frames.length;
		},
	});
	// The frame's parent is the environment's own window (in vitest it is not the
	// test's `window` object): what the bridge posts lands on it.
	const posted: Array<{ data: unknown; origin: string }> = [];
	vi.spyOn(win.parent, "postMessage").mockImplementation(((
		data: unknown,
		origin: string,
	) => {
		posted.push({ data, origin });
	}) as typeof window.postMessage);
	return { win, doc, highlights, posted, frames };
}

/** A message to the bridge, from its parent (or from `source`). */
function send(data: unknown, source?: Window | null) {
	frame.win.dispatchEvent(
		new frame.win.MessageEvent("message", {
			data,
			source: source === undefined ? frame.win.parent : source,
		}),
	);
}

const message = (type: string, extra: Record<string, unknown> = {}) => ({
	v: 1,
	kind: REPORT_BRIDGE_KIND,
	type,
	...extra,
});

const texts = (name: string) =>
	frame.highlights.get(name)?.ranges.map((range) => range.toString()) ?? [];

beforeEach(() => {
	frame = makeFrame();
	other = document.createElement("iframe");
	document.body.append(other);
	reportBridge(reportBridgeConfig(ORIGIN), KIT, frame.win);
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("the report bridge", () => {
	it("says it is ready, with its blocks and characters, to the app's origin alone", () => {
		expect(frame.posted).toEqual([
			{
				data: message("ready", { blocks: 3, chars: 74 }),
				origin: ORIGIN,
			},
		]);
	});

	it("draws the marks the page sends, as highlights of those spans", () => {
		send(
			message("marks", {
				sentence: [
					[2, 0, 9],
					[2, 10, 24],
				],
				word: [2, 4, 9],
				target: [],
			}),
		);
		expect(texts("alfy-read-aloud-sentence")).toEqual([
			"The train",
			"leaves at nine",
		]);
		expect(texts("alfy-read-aloud-word")).toEqual(["train"]);
		expect(frame.highlights.has("alfy-read-aloud-target")).toBe(false);
		// Its look comes with it: the Document marks' tints, written out for light and dark.
		const style = frame.doc.querySelector("style[data-alfy-read-aloud]");
		expect(style?.textContent).toContain(
			"::highlight(alfy-read-aloud-sentence)",
		);
		expect(style?.textContent).toContain("prefers-color-scheme: dark");
		send(message("clear"));
		expect(frame.highlights.size).toBe(0);
	});

	it("answers hello with ready again, for a page that started listening late", () => {
		frame.posted.length = 0;
		send(message("hello"));
		expect(
			frame.posted.map((post) => (post.data as { type: string }).type),
		).toEqual(["ready"]);
	});

	it("ignores a message from any window but its parent", () => {
		const marks = message("marks", {
			sentence: [[2, 0, 9]],
			word: null,
			target: [],
		});
		send(marks, other.contentWindow);
		send(marks, frame.win);
		send(marks, null);
		expect(frame.highlights.size).toBe(0);
		send(marks);
		expect(frame.highlights.size).toBe(1);
	});

	it("ignores an oversized message", () => {
		const good = { sentence: [[2, 0, 9]], word: null, target: [] };
		for (const bad of [
			{ ...message("marks", good), pad: "x".repeat(1_000_000) },
			message("x".repeat(1_000_000)),
			// A hello it took would be answered: nothing but the first ready is posted.
			{
				...message("hello"),
				...Object.fromEntries(
					Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]),
				),
			},
			message("marks", {
				...good,
				target: Array.from({ length: 100_000 }, () => [2, 0, 9]),
			}),
		])
			send(bad);
		expect(frame.highlights.size).toBe(0);
		expect(frame.posted).toHaveLength(1);
	});

	it("ignores a message of any other shape", () => {
		const good = { sentence: [[2, 0, 9]], word: null, target: [] };
		for (const bad of [
			{ ...message("marks", good), extra: 1 },
			{
				v: 1,
				kind: REPORT_BRIDGE_KIND,
				type: "marks",
				sentence: [[2, 0, 9]],
				word: null,
			},
			{ ...message("marks", good), v: 2 },
			{ ...message("marks", good), kind: "alfy.storage" },
			message("play"),
			message("marks", { ...good, sentence: [[3, 0, 1]] }),
			message("marks", { ...good, sentence: [[2, 5, 4]] }),
			message("marks", { ...good, sentence: [[2, 0, 999]] }),
			message("marks", { ...good, sentence: [[2, 0.5, 9]] }),
			message("marks", { ...good, sentence: [[-1, 0, 9]] }),
			message("marks", { ...good, sentence: [["2", 0, 9]] }),
			message("marks", { ...good, sentence: [[2, 0, 9, 1]] }),
			message("marks", { ...good, word: [2, 0] }),
			message("marks", {
				...good,
				sentence: Array.from({ length: REPORT_BRIDGE_MAX_SPANS + 1 }, () => [
					2, 0, 9,
				]),
			}),
			message("focus", { spans: [[2, 0, 9]], mode: "jump" }),
			message("focus", { spans: [], mode: "center" }),
			"marks",
			null,
			[message("marks", good)],
		])
			send(bad);
		expect(frame.highlights.size).toBe(0);
	});

	it("reports a selection as a block, an offset and its box, and never its text", () => {
		frame.posted.length = 0;
		const text = frame.doc.querySelector("#report-content p")
			?.firstChild as Text;
		const range = frame.doc.createRange();
		range.setStart(text, 4);
		range.setEnd(text, 9);
		// The whole selection's box: the page places its control above it, or below it on a touch screen.
		Object.defineProperty(range, "getClientRects", {
			value: () => [new DOMRect(40, 120, 38, 18), new DOMRect(8, 140, 90, 18)],
		});
		Object.defineProperty(range, "getBoundingClientRect", {
			value: () => new DOMRect(8, 120, 90, 38),
		});
		const selection = frame.doc.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		vi.spyOn(selection as Selection, "getRangeAt").mockReturnValue(range);
		frame.doc.dispatchEvent(new frame.win.Event("selectionchange"));
		for (const run of frame.frames.splice(0)) run();
		expect(frame.posted).toEqual([
			{
				data: message("selection", {
					block: 2,
					offset: 4,
					x: 8,
					y: 120,
					width: 90,
					height: 38,
				}),
				origin: ORIGIN,
			},
		]);
		selection?.removeAllRanges();
		frame.doc.dispatchEvent(new frame.win.Event("selectionchange"));
		for (const run of frame.frames.splice(0)) run();
		expect(frame.posted.at(-1)).toEqual({
			data: message("deselect"),
			origin: ORIGIN,
		});
	});

	it("brings a focused span into view in the report's own scroller", () => {
		const content = frame.doc.getElementById("report-content") as HTMLElement;
		const scrollTo = vi.fn();
		Object.assign(content, { scrollTo });
		send(message("focus", { spans: [[2, 0, 9]], mode: "center" }));
		expect(scrollTo).toHaveBeenCalledTimes(1);
	});
});

describe("the bridge's script", () => {
	it("is one inline script, its origin written in, and nothing it loads", () => {
		const script = reportBridgeScript(ORIGIN);
		expect(script.startsWith("<script>")).toBe(true);
		expect(script.endsWith("</script>")).toBe(true);
		expect(script.match(/<\/script/gi)).toHaveLength(1);
		expect(script).toContain(JSON.stringify(ORIGIN));
		expect(script).not.toContain(" src=");
		expect(script).not.toContain("nonce");
	});

	it("refuses an origin that is not one", () => {
		for (const origin of [
			"*",
			"null",
			"https://a.example/x",
			'https://a.example"><img src=x>',
			"javascript:alert(1)",
		])
			expect(reportBridgeScript(origin), origin).toBe("");
	});

	it("runs on its own: its source carries everything it needs", () => {
		const fresh = makeFrame();
		const code = reportBridgeScript(ORIGIN)
			.replace(/^<script>/, "")
			.replace(/<\/script>$/, "");
		new Function("window", code)(fresh.win);
		expect(fresh.posted.at(-1)).toEqual({
			data: message("ready", { blocks: 3, chars: 74 }),
			origin: ORIGIN,
		});
	});
});

// What the server does to a standard report's preview response
// (`generated-file-serving.ts`): the bridge goes last in its body.
describe("a report with the bridge", () => {
	const BODY =
		"<!doctype html><html><head><title>Report</title></head><body><main>Report</main><script>window.ready=true</script></body></html>";

	it("has the bridge last in its body, its own scripts and markup untouched", () => {
		const html = withReportBridge(BODY, ORIGIN);
		const script = reportBridgeScript(ORIGIN);
		expect(html).toBe(BODY.replace("</body>", () => `${script}</body>`));
	});

	it("keeps the bridge's source exactly, whatever `$` patterns it holds", () => {
		const html = withReportBridge(BODY, ORIGIN);
		expect(html).toContain(reportBridgeScript(ORIGIN));
	});

	it("goes before the last closing tag there is, or at the end", () => {
		const script = reportBridgeScript(ORIGIN);
		expect(withReportBridge("<html><p>Report</p></html>", ORIGIN)).toBe(
			`<html><p>Report</p>${script}</html>`,
		);
		expect(withReportBridge("<p>Report</p>", ORIGIN)).toBe(
			`<p>Report</p>${script}`,
		);
		// A `</body>` in the report's text is escaped: the last real one is the page's.
		expect(
			withReportBridge("<body><p>a &lt;/body&gt; b</p></body >", ORIGIN),
		).toBe(`<body><p>a &lt;/body&gt; b</p>${script}</body >`);
	});

	it("is the report unchanged for an origin that is not one", () => {
		expect(withReportBridge(BODY, "*")).toBe(BODY);
	});
});
