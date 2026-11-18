import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REPORT_BRIDGE_KIND,
	REPORT_BRIDGE_MAX_SPANS,
} from "$lib/shared/read-aloud/report-bridge";
import { idleReadAloudView, type ReadAloudView } from "$lib/stores/read-aloud";
import {
	makeReportCopy,
	marksMessage,
	postToFrame,
	type ReportCopy,
	readFrameMessage,
	spansOf,
} from "./report-bridge-host";

/** The same report the bridge's own tests read: three blocks, 74 characters. */
const REPORT = `<!doctype html><html><head><style>.x{color:red}</style></head><body><div class="report-viewer"><aside class="report-sidebar"><p class="report-sidebar-title">Sections</p></aside><article class="report-content" id="report-content"><h1 class="report-title">Weekend report</h1><section class="report-section"><h2>Getting there</h2><p>The train leaves at nine<button type="button" class="basis-marker"><span class="basis-tooltip" role="tooltip">Supported claim</span></button> from the main station.</p></section></article></div><script>document.title = "changed";</script></body></html>`;

let copy: ReportCopy;
let frame: HTMLIFrameElement;
let other: HTMLIFrameElement;

const message = (type: string, extra: Record<string, unknown> = {}) => ({
	v: 1,
	kind: REPORT_BRIDGE_KIND,
	type,
	...extra,
});

const selection = (extra: Record<string, unknown> = {}) =>
	message("selection", {
		block: 2,
		offset: 4,
		x: 40,
		y: 120,
		width: 38,
		height: 18,
		...extra,
	});

/** A message as the page hears it: from the report's frame, whose origin is opaque, unless said otherwise. */
function heard(
	data: unknown,
	options: { source?: Window | null; origin?: string } = {},
) {
	return readFrameMessage(
		new MessageEvent("message", {
			data,
			source:
				options.source === undefined ? frame.contentWindow : options.source,
			origin: options.origin ?? "null",
		}),
		frame,
		copy,
	);
}

beforeEach(() => {
	copy = makeReportCopy(REPORT);
	frame = document.createElement("iframe");
	other = document.createElement("iframe");
	document.body.append(frame, other);
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("the page's copy of a report", () => {
	it("is inert: its scripts never ran, and it is not the page's document", () => {
		expect(copy.doc).not.toBe(document);
		expect(copy.doc.title).toBe("");
		expect(copy.root.id).toBe("report-content");
	});

	it("has the bridge's units: three blocks and 74 characters, with the report's chrome left out", () => {
		expect(copy.blocks).toHaveLength(3);
		expect(copy.chars).toBe(74);
		expect(copy.lengths).toEqual([14, 13, 47]);
	});
});

describe("what the page hears from the frame", () => {
	it("takes ready, a selection and deselect, of their exact shapes, from the report's frame", () => {
		expect(heard(message("ready", { blocks: 3, chars: 74 }))).toEqual({
			type: "ready",
			blocks: 3,
			chars: 74,
		});
		expect(heard(selection())).toEqual({
			type: "selection",
			block: 2,
			offset: 4,
			rect: { x: 40, y: 120, width: 38, height: 18 },
		});
		expect(heard(message("deselect"))).toEqual({ type: "deselect" });
	});

	it("ignores a message from any other window", () => {
		expect(heard(selection(), { source: other.contentWindow })).toBeNull();
		expect(heard(selection(), { source: window })).toBeNull();
		expect(heard(selection(), { source: null })).toBeNull();
	});

	it("ignores a message whose origin is not the opaque frame's", () => {
		expect(heard(selection(), { origin: window.location.origin })).toBeNull();
		expect(heard(selection(), { origin: "" })).toBeNull();
	});

	it("ignores every message when the frame is gone", () => {
		frame.remove();
		expect(
			readFrameMessage(
				new MessageEvent("message", { data: selection(), origin: "null" }),
				frame,
				copy,
			),
		).toBeNull();
		expect(
			readFrameMessage(
				new MessageEvent("message", { data: selection(), origin: "null" }),
				null,
				copy,
			),
		).toBeNull();
	});

	it("ignores a message of any other shape", () => {
		for (const bad of [
			{ ...selection(), text: "the train" },
			{ ...message("deselect"), block: 2 },
			message("ready", { blocks: 3 }),
			{ ...selection(), v: 2 },
			{ ...selection(), kind: "alfy.storage" },
			message("play"),
			message("marks", { sentence: [], word: null, target: [] }),
			message("selection", { block: 2, offset: 4 }),
			selection({ block: "2" }),
			selection({ x: "40px" }),
			selection({ width: null }),
			"selection",
			null,
			42,
			[selection()],
		])
			expect(heard(bad), JSON.stringify(bad)).toBeNull();
	});

	it("ignores a position that is not in the page's copy", () => {
		for (const bad of [
			selection({ block: -1 }),
			selection({ block: 3 }),
			selection({ block: 1.5 }),
			selection({ offset: -1 }),
			selection({ offset: 48 }),
			selection({ offset: 4.5 }),
			selection({ offset: Number.NaN }),
			selection({ x: Number.POSITIVE_INFINITY }),
			selection({ y: Number.NaN }),
			selection({ width: -1 }),
			selection({ height: 2_000_000 }),
			selection({ x: -2_000_000 }),
			message("ready", { blocks: -1, chars: 74 }),
			message("ready", { blocks: 3, chars: 7.4 }),
		])
			expect(heard(bad), JSON.stringify(bad)).toBeNull();
		// The last character's end is a place in the block.
		expect(heard(selection({ offset: 47 }))).not.toBeNull();
	});

	it("ignores an oversized message", () => {
		expect(heard({ ...selection(), pad: "x".repeat(1_000_000) })).toBeNull();
		expect(heard(message("x".repeat(1_000_000)))).toBeNull();
		expect(
			heard({
				...message("deselect"),
				...Object.fromEntries(
					Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]),
				),
			}),
		).toBeNull();
		expect(
			heard(message("ready", { blocks: 3, chars: 1_000_000_000 })),
		).toBeNull();
	});
});

describe("what the page tells the frame", () => {
	it("posts with *, the only target an opaque frame has", () => {
		const post = vi
			.spyOn(frame.contentWindow as Window, "postMessage")
			.mockImplementation(() => {});
		postToFrame(frame, { type: "hello" });
		expect(post).toHaveBeenCalledWith(
			{ v: 1, kind: REPORT_BRIDGE_KIND, type: "hello" },
			"*",
		);
	});

	it("posts nothing when the frame is gone", () => {
		expect(() => postToFrame(null, { type: "clear" })).not.toThrow();
	});
});

describe("spans", () => {
	const textOf = (span: [number, number, number]) => {
		const [block, start, end] = span;
		return (copy.blocks[block] ?? [])
			.map((node) => node.data)
			.join("")
			.slice(start, end);
	};
	const rangeOver = (from: string, to: string = from) => {
		const walker = copy.doc.createTreeWalker(copy.root, NodeFilter.SHOW_TEXT);
		const range = copy.doc.createRange();
		let started = false;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const data = (node as Text).data;
			if (!started && data.includes(from)) {
				range.setStart(node, data.indexOf(from));
				started = true;
			}
			if (started && data.includes(to)) {
				range.setEnd(node, data.indexOf(to) + to.length);
				return range;
			}
		}
		throw new Error(`no ${from}…${to}`);
	};

	it("names each word by its block, start and end", () => {
		const spans = spansOf(copy, [rangeOver("train")]);
		expect(spans).toEqual([[2, 4, 9]]);
		expect(spans.map(textOf)).toEqual(["train"]);
	});

	it("joins the words of a line across the spaces between them", () => {
		const spans = spansOf(copy, [
			rangeOver("The"),
			rangeOver("train"),
			rangeOver("leaves"),
		]);
		expect(spans.map(textOf)).toEqual(["The train leaves"]);
	});

	it("never joins across a part of the report that is not read (a basis marker)", () => {
		const spans = spansOf(copy, [rangeOver("nine"), rangeOver("from")]);
		expect(spans.map(textOf)).toEqual(["nine", "from"]);
	});

	it("cuts a range that runs over a basis marker at the marker", () => {
		const spans = spansOf(copy, [rangeOver("nine", "from")]);
		expect(spans).toEqual([
			[2, 20, 24],
			[2, 24, 29],
		]);
		expect(spans.map(textOf)).toEqual(["nine", " from"]);
	});

	it("cuts a range that runs over two blocks at the block", () => {
		const spans = spansOf(copy, [rangeOver("there", "The")]);
		expect(spans.map(textOf)).toEqual(["there", "The"]);
	});

	it("drops a range outside the report's units", () => {
		const tooltip = copy.doc.querySelector(".basis-tooltip")
			?.firstChild as Text;
		const range = copy.doc.createRange();
		range.setStart(tooltip, 0);
		range.setEnd(tooltip, 4);
		expect(spansOf(copy, [range])).toEqual([]);
	});
});

describe("the marks the frame is sent", () => {
	const KEY = "report:file-1";
	const word = (text: string) => {
		const node = copy.blocks[2]?.[0] as Text;
		const range = copy.doc.createRange();
		const at = node.data.indexOf(text);
		range.setStart(node, at);
		range.setEnd(node, at + text.length);
		return range;
	};
	const view = (extra: Partial<ReadAloudView>): ReadAloudView => ({
		...idleReadAloudView,
		status: "playing",
		key: KEY,
		target: "report",
		count: 2,
		marks: {
			sentence: [word("The"), word("train")],
			word: word("train"),
			target: [],
		},
		...extra,
	});

	it("are the sentence and the word being read", () => {
		expect(marksMessage(view({}), KEY, copy)).toEqual({
			type: "marks",
			sentence: [[2, 0, 9]],
			word: [2, 4, 9],
			target: [],
		});
	});

	it("are the target alone while the scrubber is dragged", () => {
		expect(
			marksMessage(
				view({
					drag: 1,
					marks: {
						sentence: [word("The")],
						word: null,
						target: [word("leaves")],
					},
				}),
				KEY,
				copy,
			),
		).toEqual({
			type: "marks",
			sentence: [],
			word: null,
			target: [[2, 10, 16]],
		});
	});

	it("leave the word out while stopped or waiting", () => {
		for (const status of ["stopped", "waiting"] as const)
			expect(marksMessage(view({ status }), KEY, copy)).toMatchObject({
				type: "marks",
				word: null,
			});
	});

	it("are never more spans than the bridge takes", () => {
		const many = Array.from({ length: 900 }, () => word("train"));
		const sent = marksMessage(
			view({ drag: 1, marks: { sentence: [], word: null, target: many } }),
			KEY,
			copy,
		);
		// The same word 900 times is one span.
		expect(sent).toMatchObject({ type: "marks", target: [[2, 4, 9]] });
		// 500 places in 500 blocks are the first 400 the bridge takes.
		const long = makeReportCopy(
			`<article id="report-content">${"<p>Word here.</p>".repeat(500)}</article>`,
		);
		const firsts = long.blocks.map((nodes) => {
			const range = long.doc.createRange();
			range.setStart(nodes[0] as Text, 0);
			range.setEnd(nodes[0] as Text, 4);
			return range;
		});
		const capped = marksMessage(
			view({ drag: 1, marks: { sentence: [], word: null, target: firsts } }),
			KEY,
			long,
		);
		expect(capped.type === "marks" && capped.target).toHaveLength(
			REPORT_BRIDGE_MAX_SPANS,
		);
	});

	it("are cleared when nothing of this report is read", () => {
		expect(marksMessage(view({ key: "report:another" }), KEY, copy)).toEqual({
			type: "clear",
		});
		expect(marksMessage(view({ marks: null }), KEY, copy)).toEqual({
			type: "clear",
		});
		expect(marksMessage(idleReadAloudView, KEY, copy)).toEqual({
			type: "clear",
		});
	});
});
