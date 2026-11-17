import { beforeEach, describe, expect, it } from "vitest";
import { idleReadAloudView, type ReadAloudView } from "$lib/stores/read-aloud";
import { CODE_MARK_NAMES, paintCodeMarks } from "./code-marks";

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

function reply() {
	document.body.innerHTML =
		'<div class="markdown-container"><p id="p">Call <code id="c">getUserName()</code> now.</p><div class="code-block"><pre><code><span class="line"><span id="t">total = 1</span></span></code></pre></div></div>';
	const call = rangeOf(
		document.getElementById("p")?.firstChild as Node,
		"Call",
	);
	const code = rangeOf(
		document.getElementById("c")?.firstChild as Node,
		"getUserName()",
	);
	const total = rangeOf(
		document.getElementById("t")?.firstChild as Node,
		"total",
	);
	return { call, code, total };
}

const view = (extra: Partial<ReadAloudView>): ReadAloudView => ({
	...idleReadAloudView,
	status: "playing",
	messageId: "m1",
	...extra,
});

beforeEach(() => {
	registry = new Map();
});

describe("paintCodeMarks", () => {
	it("marks only the ranges inside code, the word above the sentence", () => {
		const { call, code, total } = reply();
		paintCodeMarks(
			view({
				marks: { sentence: [call, code, total], word: code, target: [] },
			}),
			env(),
		);
		expect(registry.get(CODE_MARK_NAMES.sentence)?.ranges).toEqual([
			code,
			total,
		]);
		expect(registry.get(CODE_MARK_NAMES.word)?.ranges).toEqual([code]);
		expect(registry.get(CODE_MARK_NAMES.word)?.priority).toBeGreaterThan(
			registry.get(CODE_MARK_NAMES.sentence)?.priority ?? 0,
		);
		expect(registry.has(CODE_MARK_NAMES.target)).toBe(false);
		// A word outside code marks no code word.
		paintCodeMarks(
			view({ marks: { sentence: [call, code], word: call, target: [] } }),
			env(),
		);
		expect(registry.has(CODE_MARK_NAMES.word)).toBe(false);
	});

	it("hides the word in a stopped reading, shows only the target while dragging, and clears at the end", () => {
		const { call, code, total } = reply();
		paintCodeMarks(
			view({
				status: "stopped",
				marks: { sentence: [code], word: code, target: [] },
			}),
			env(),
		);
		expect(registry.get(CODE_MARK_NAMES.sentence)?.ranges).toEqual([code]);
		expect(registry.has(CODE_MARK_NAMES.word)).toBe(false);
		paintCodeMarks(
			view({
				drag: 1,
				marks: { sentence: [code], word: code, target: [call, total] },
			}),
			env(),
		);
		expect(registry.has(CODE_MARK_NAMES.sentence)).toBe(false);
		expect(registry.has(CODE_MARK_NAMES.word)).toBe(false);
		expect(registry.get(CODE_MARK_NAMES.target)?.ranges).toEqual([total]);
		paintCodeMarks(idleReadAloudView, env());
		expect(registry.size).toBe(0);
	});

	it("marks a link chip's words too: a chip paints its own background as code does", () => {
		// Early review R8: the overlay behind the prose is hidden under the chip's background.
		document.body.innerHTML =
			'<div class="markdown-container"><p id="p">Read <a class="source-link-chip" href="https://example.com"><span class="source-link-chip__label" id="l">the guide</span></a> now.</p></div>';
		const label = rangeOf(
			document.getElementById("l")?.firstChild as Node,
			"guide",
		);
		const read = rangeOf(
			document.getElementById("p")?.firstChild as Node,
			"Read",
		);
		paintCodeMarks(
			view({ marks: { sentence: [read, label], word: label, target: [] } }),
			env(),
		);
		expect(registry.get(CODE_MARK_NAMES.sentence)?.ranges).toEqual([label]);
		expect(registry.get(CODE_MARK_NAMES.word)?.ranges).toEqual([label]);
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
