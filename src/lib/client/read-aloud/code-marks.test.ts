// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleReadAloudView, type ReadAloudView } from "$lib/stores/read-aloud";
import { MOTION_DURATION } from "$lib/utils/motion";
import {
	CODE_MARK_ATTRIBUTE,
	CODE_MARK_FADING_CLASS,
	CODE_MARK_NAMES,
	ensureCodeMarkStyle,
	paintCodeMarks,
} from "./code-marks";

class FakeHighlight {
	priority = 0;
	readonly ranges: Range[];
	constructor(...ranges: Range[]) {
		this.ranges = ranges;
	}
}

let registry: Map<string, FakeHighlight>;
const env = () => ({ registry, Highlight: FakeHighlight });

function rangeOf(node: Node, text: string): Range {
	const data = (node as Text).data;
	const range = document.createRange();
	range.setStart(node, data.indexOf(text));
	range.setEnd(node, data.indexOf(text) + text.length);
	return range;
}

const textOf = (id: string) => document.getElementById(id)?.firstChild as Node;

function reply() {
	document.body.innerHTML =
		'<div class="markdown-container"><p id="p">Call <code id="c">getUserName()</code> now.</p><div class="code-block"><pre><code><span class="line"><span id="t">total = len(f.read())</span></span>\n<span class="line"><span id="u">    print(total)</span></span></code></pre></div></div>';
	return {
		call: rangeOf(textOf("p"), "Call"),
		code: rangeOf(textOf("c"), "getUserName()"),
		total: rangeOf(textOf("t"), "total"),
		equals: rangeOf(textOf("t"), "="),
		len: rangeOf(textOf("t"), "len(f.read())"),
		print: rangeOf(textOf("u"), "print(total)"),
	};
}

const view = (extra: Partial<ReadAloudView>): ReadAloudView => ({
	...idleReadAloudView,
	status: "playing",
	key: "m1",
	...extra,
});

const markOf = (id: string) =>
	document.getElementById(id)?.getAttribute(CODE_MARK_ATTRIBUTE) ?? null;
const strings = (name: string) =>
	registry.get(name)?.ranges.map((range) => range.toString()) ?? [];

beforeEach(() => {
	registry = new Map();
	// Motion on: the marks fade out over the standard duration.
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
	}));
});

afterEach(() => {
	// A fade left running would clear the next test's marks.
	paintCodeMarks(idleReadAloudView, env());
	if (vi.isFakeTimers()) vi.advanceTimersByTime(MOTION_DURATION.standard);
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.documentElement.classList.remove(CODE_MARK_FADING_CLASS);
});

describe("paintCodeMarks", () => {
	it("tints a code block's sentence as one run per line: the spaces between its words too", () => {
		const { total, equals, len, print } = reply();
		paintCodeMarks(
			view({
				marks: { sentence: [total, equals, len, print], word: len, target: [] },
			}),
			env(),
		);
		// One run on each line, and not the next line's indentation.
		expect(strings(CODE_MARK_NAMES.sentence)).toEqual([
			"total = len(f.read())",
			"print(total)",
		]);
		expect(strings(CODE_MARK_NAMES.word)).toEqual(["len(f.read())"]);
		expect(registry.get(CODE_MARK_NAMES.word)?.priority).toBeGreaterThan(
			registry.get(CODE_MARK_NAMES.sentence)?.priority ?? 0,
		);
	});

	it("tints inline code whole, padding and corners included: the element carries the mark", () => {
		const { call, code } = reply();
		paintCodeMarks(
			view({ marks: { sentence: [call, code], word: call, target: [] } }),
			env(),
		);
		expect(markOf("c")).toBe("sentence");
		// No highlight for it: in WebKit a highlight's word mark stood taller than the pill.
		expect(registry.has(CODE_MARK_NAMES.sentence)).toBe(false);
		paintCodeMarks(
			view({ marks: { sentence: [call, code], word: code, target: [] } }),
			env(),
		);
		expect(markOf("c")).toBe("word");
		expect(registry.has(CODE_MARK_NAMES.word)).toBe(false);
	});

	it("never sets an attribute inside an editor's page: a Document's inline code is drawn by a highlight", () => {
		// ProseMirror reads a change to its own DOM as an edit, so a Document's page is only ever
		// painted over, never changed.
		document.body.innerHTML =
			'<div class="document-editor-host"><div class="ProseMirror" contenteditable="true"><p id="p">Call <code id="c">getUserName()</code> now.</p></div></div>';
		const call = rangeOf(textOf("p"), "Call");
		const code = rangeOf(textOf("c"), "getUserName()");
		paintCodeMarks(
			view({
				key: "document:doc-1",
				marks: { sentence: [call, code], word: code, target: [] },
			}),
			env(),
		);
		expect(markOf("c")).toBeNull();
		expect(strings(CODE_MARK_NAMES.sentence)).toEqual(["getUserName()"]);
		expect(strings(CODE_MARK_NAMES.word)).toEqual(["getUserName()"]);
	});

	it("tints a link chip whole, as it paints its own background as code does", () => {
		// Early review R8: the overlay behind the prose is hidden under the chip's background.
		document.body.innerHTML =
			'<div class="markdown-container"><p id="p">Read <a class="source-link-chip" id="chip" href="https://example.com"><span class="source-link-chip__label" id="l">the guide</span></a> now.</p></div>';
		const the = rangeOf(textOf("l"), "the");
		const guide = rangeOf(textOf("l"), "guide");
		const read = rangeOf(textOf("p"), "Read");
		paintCodeMarks(
			view({ marks: { sentence: [read, the, guide], word: read, target: [] } }),
			env(),
		);
		expect(markOf("chip")).toBe("sentence");
		expect(registry.size).toBe(0);
	});

	it("hides the word in a stopped reading and shows only the target while dragging", () => {
		const { code, total, len } = reply();
		paintCodeMarks(
			view({
				status: "stopped",
				marks: { sentence: [code, total], word: total, target: [] },
			}),
			env(),
		);
		expect(markOf("c")).toBe("sentence");
		expect(strings(CODE_MARK_NAMES.sentence)).toEqual(["total"]);
		expect(registry.has(CODE_MARK_NAMES.word)).toBe(false);
		paintCodeMarks(
			view({
				drag: 1,
				marks: { sentence: [code], word: code, target: [code, total, len] },
			}),
			env(),
		);
		expect(registry.has(CODE_MARK_NAMES.sentence)).toBe(false);
		expect(registry.has(CODE_MARK_NAMES.word)).toBe(false);
		expect(markOf("c")).toBe("target");
		expect(strings(CODE_MARK_NAMES.target)).toEqual(["total = len(f.read())"]);
	});

	it("fades out at the end, as the prose's marks do, then clears", () => {
		vi.useFakeTimers();
		const { code, total } = reply();
		paintCodeMarks(
			view({ marks: { sentence: [code, total], word: total, target: [] } }),
			env(),
		);
		paintCodeMarks(idleReadAloudView, env());
		// Fading: the element's tint eases out, and the block's highlights with the page's strength.
		expect(markOf("c")).toBe("fading");
		expect(registry.has(CODE_MARK_NAMES.sentence)).toBe(true);
		expect(
			document.documentElement.classList.contains(CODE_MARK_FADING_CLASS),
		).toBe(true);
		vi.advanceTimersByTime(MOTION_DURATION.standard);
		expect(markOf("c")).toBeNull();
		expect(registry.size).toBe(0);
		expect(
			document.documentElement.classList.contains(CODE_MARK_FADING_CLASS),
		).toBe(false);
	});

	it("a new mark during the fade is drawn at once, and the fade does not clear it", () => {
		vi.useFakeTimers();
		const { code, total } = reply();
		paintCodeMarks(
			view({ marks: { sentence: [code, total], word: total, target: [] } }),
			env(),
		);
		paintCodeMarks(idleReadAloudView, env());
		paintCodeMarks(
			view({ marks: { sentence: [code, total], word: code, target: [] } }),
			env(),
		);
		expect(
			document.documentElement.classList.contains(CODE_MARK_FADING_CLASS),
		).toBe(false);
		vi.advanceTimersByTime(MOTION_DURATION.standard);
		expect(markOf("c")).toBe("word");
		expect(strings(CODE_MARK_NAMES.sentence)).toEqual(["total"]);
	});

	it("under reduced motion clears at once", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query.includes("reduce"),
			media: query,
		}));
		const { code, total } = reply();
		paintCodeMarks(
			view({ marks: { sentence: [code, total], word: total, target: [] } }),
			env(),
		);
		paintCodeMarks(idleReadAloudView, env());
		expect(markOf("c")).toBeNull();
		expect(registry.size).toBe(0);
	});

	it("brings its own colours, once, outside the CSS build", () => {
		// esbuild's CSS minifier does not know ::highlight() and warned on each rule in
		// app.css; the build must print no warning (AGENTS.md).
		ensureCodeMarkStyle(document);
		ensureCodeMarkStyle(document);
		const styles = document.head.querySelectorAll(
			"style[data-read-aloud-code-marks]",
		);
		expect(styles).toHaveLength(1);
		const css = styles[0]?.textContent ?? "";
		for (const [part, name] of Object.entries(CODE_MARK_NAMES)) {
			expect(css).toContain(`::highlight(${name})`);
			expect(css).toContain(`var(--read-aloud-${part})`);
			expect(css).toContain(`[${CODE_MARK_ATTRIBUTE}="${part}"]`);
		}
	});

	it("does nothing where the browser has no highlights", () => {
		const { code } = reply();
		expect(() =>
			paintCodeMarks(
				view({ marks: { sentence: [code], word: code, target: [] } }),
				null,
			),
		).not.toThrow();
	});
});
