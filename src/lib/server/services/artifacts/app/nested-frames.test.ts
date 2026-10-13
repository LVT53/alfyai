import { describe, expect, it } from "vitest";
import {
	hasNestedFrameMarkup,
	NESTED_FRAME_TAG_BEGUN_SOURCE,
	NESTED_FRAME_TAG_NAMES,
	NESTED_FRAME_TAG_SOURCE,
	nestedFrameApiUses,
} from "./nested-frames";

describe("hasNestedFrameMarkup: a tag that makes a document of its own", () => {
	it.each([
		["an iframe", '<iframe srcdoc="x"></iframe>'],
		["an upper-case IFRAME", "<IFRAME SRC=x></IFRAME>"],
		["an iframe closed by a slash", "<iframe/srcdoc=x>"],
		["an iframe split over lines", "<iframe\nsrcdoc=x>"],
		["an iframe with a tab after the name", "<iframe\tsrc=x>"],
		["an iframe that ends the text", "<iframe"],
		["a frame", '<frameset><frame src="x"></frameset>'],
		["a frameset", "<frameset cols=1>"],
		["an object", '<object data="x"></object>'],
		["an embed", '<embed src="x">'],
		["a fencedframe", "<fencedframe></fencedframe>"],
		["a portal", "<portal src=x>"],
		["a frame inside a template", "<template><iframe></template>"],
		["a frame in a script string", `var s = '<iframe src="x">';`],
		["a frame in a comment", "<!-- <iframe> -->"],
	])("finds %s", (_name, html) => {
		expect(hasNestedFrameMarkup(html)).toBe(true);
	});

	it.each([
		["plain markup", "<p>hello</p><button>go</button>"],
		["the word iframe in text", "<p>an iframe is a frame</p>"],
		["an end tag alone", "</iframe>"],
		["an escaped tag", "&lt;iframe&gt; <code>&lt;iframe&gt;</code>"],
		["a longer tag name", "<iframes><framework><objective><embedded>"],
		["a custom element", "<x-frame><my-object></my-object></x-frame>"],
		["a tag with a space after the bracket", "< iframe>"],
		["an empty document", ""],
	])("leaves %s alone", (_name, html) => {
		expect(hasNestedFrameMarkup(html)).toBe(false);
	});

	it("names every tag that opens a document of its own", () => {
		expect([...NESTED_FRAME_TAG_NAMES].sort()).toEqual([
			"embed",
			"fencedframe",
			"frame",
			"frameset",
			"iframe",
			"object",
			"portal",
		]);
	});

	it("shares its pattern with the bootstrap's policy, as a source string", () => {
		expect(new RegExp(NESTED_FRAME_TAG_SOURCE, "i").test("<IFrame>")).toBe(
			true,
		);
	});

	it("scans a very large document in linear time", () => {
		const started = performance.now();
		hasNestedFrameMarkup(`${"<i".repeat(300_000)}x`);
		hasNestedFrameMarkup("<".repeat(600_000));
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe("nestedFrameApiUses: the same thing spelled in script, for the audit's second layer", () => {
	it.each([
		[
			"createElement with a double-quoted name",
			'document.createElement("iframe")',
			"createElement(iframe)",
		],
		[
			"createElement with a single-quoted name",
			"document.createElement( 'IFRAME' )",
			"createElement(iframe)",
		],
		[
			"createElement with a template name",
			"document.createElement(`iframe`)",
			"createElement(iframe)",
		],
		[
			"createElement of an object",
			'document.createElement("object")',
			"createElement(object)",
		],
		[
			"a joined name",
			'document.createElement("if" + "rame")',
			"createElement(iframe)",
		],
		[
			"a name in escapes",
			'document.createElement("\\u0069frame")',
			"createElement(iframe)",
		],
		["the srcdoc property", "frame.srcdoc = html", "srcdoc"],
		["the srcdoc attribute", 'f.setAttribute("srcdoc", html)', "srcdoc"],
		["a joined srcdoc", 'f["src" + "doc"] = x', "srcdoc"],
		["an upper-case SRCDOC", 'f.setAttribute("SRCDOC", x)', "srcdoc"],
		["XSLTProcessor", "new XSLTProcessor()", "XSLTProcessor"],
	])("finds %s", (_name, script, use) => {
		expect(nestedFrameApiUses(script)).toContain(use);
	});

	it.each([
		["ordinary DOM code", 'document.createElement("div").textContent = "x"'],
		["a variable named frame", "var frame = 1; frame += 1;"],
		["requestAnimationFrame", "requestAnimationFrame(tick)"],
		["a createElement of a list item", "document.createElement('li')"],
		["the word frame in prose", "an iframe is a frame in a page"],
	])("leaves %s alone", (_name, script) => {
		expect(nestedFrameApiUses(script)).toEqual([]);
	});

	it("flags the bare word srcdoc, which is the one false positive it accepts", () => {
		expect(nestedFrameApiUses("srcdoc is the source of a frame")).toEqual([
			"srcdoc",
		]);
	});
});

describe("NESTED_FRAME_TAG_BEGUN_SOURCE: where a tag could be going when a write ends", () => {
	const begun = new RegExp(NESTED_FRAME_TAG_BEGUN_SOURCE, "i");

	it("matches the bracket and every prefix of every name, whole names included", () => {
		for (const name of NESTED_FRAME_TAG_NAMES) {
			for (let length = 0; length <= name.length; length += 1) {
				expect(begun.test(`text <${name.slice(0, length)}`), name).toBe(true);
				expect(
					begun.test(`text <${name.slice(0, length).toUpperCase()}`),
					name,
				).toBe(true);
			}
		}
	});

	it("does not match a bracket that is not at the end, or a name that has gone its own way", () => {
		for (const text of [
			"",
			"a",
			"a <b",
			"<iframes",
			"<ifx",
			"<p>",
			"<i>",
			"<iframe ",
			"1 < 2 and",
			"<framex",
		]) {
			expect(begun.test(text), text).toBe(false);
		}
	});
});
