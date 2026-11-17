import { describe, expect, it, vi } from "vitest";
import { focusScrollTop, PAGE_NOT_TEXT, textRevision } from "./read-aloud-page";

/** A ProseMirror doc as far as the revision reads one: immutable, so a change is a new object. */
function doc(text: string) {
	return {
		content: { size: text.length },
		textBetween: vi.fn(() => text),
	};
}

describe("textRevision", () => {
	it("moves when the text shown changes, and only then", () => {
		const revision = textRevision();
		const first = doc("Weekend plan\nBook the hotel.");
		const start = revision(first, "tab-1");
		expect(revision(first, "tab-1")).toBe(start);
		// A new doc of the same text: a mark changed (Alfy's change kept), or a chip's value.
		expect(revision(doc("Weekend plan\nBook the hotel."), "tab-1")).toBe(start);
		const edited = revision(doc("Weekend plan\nBook the cabin."), "tab-1");
		expect(edited).not.toBe(start);
		// Another tab shows another section.
		expect(revision(doc("Weekend plan\nBook the cabin."), "tab-2")).not.toBe(
			edited,
		);
	});

	it("reads a doc's text once, however often it is asked", () => {
		const revision = textRevision();
		const same = doc("Pack the warm coats.");
		for (let i = 0; i < 10; i++) revision(same, "t");
		expect(same.textBetween).toHaveBeenCalledTimes(1);
		// Blocks apart: a split paragraph is another text.
		expect(same.textBetween).toHaveBeenCalledWith(0, 20, "\n", " ");
	});

	it("counts a page with no editor yet as no text", () => {
		const revision = textRevision();
		const none = revision(null, "t");
		expect(revision(null, "t")).toBe(none);
		expect(revision(doc("Now there is text."), "t")).not.toBe(none);
	});
});

describe("PAGE_NOT_TEXT", () => {
	it("names the chips, Alfy's pill and tag, and the block markers", () => {
		document.body.innerHTML =
			'<span class="tracker-chip"></span><span class="change-pill-mount"></span><span class="alfy-writing-tag"></span><span data-block-marker="b1"></span><span class="comment-anchor"></span>';
		expect(
			[...document.body.children].map((element) =>
				element.matches(PAGE_NOT_TEXT),
			),
		).toEqual([true, true, true, true, false]);
	});
});

describe("focusScrollTop", () => {
	const scroller = new DOMRect(0, 100, 600, 500);
	const at = (top: number, height = 24) => new DOMRect(40, top, 300, height);
	const base = {
		scroller,
		scrollTop: 1000,
		clientHeight: 500,
		scrollHeight: 4000,
		covered: 0,
	};

	it("centres the sentence in what can be seen", () => {
		// The sentence is 700 px below the scroller's top: 700 + 12 - 250 more.
		expect(focusScrollTop({ ...base, rect: at(800), mode: "center" })).toBe(
			1000 + 712 - 250,
		);
	});

	it("leaves the page where it is when a revealed sentence is already in view", () => {
		expect(
			focusScrollTop({ ...base, rect: at(300), mode: "reveal" }),
		).toBeNull();
		expect(focusScrollTop({ ...base, rect: at(900), mode: "reveal" })).toBe(
			1000 + 812 - 250,
		);
	});

	it("keeps clear of what covers the page's foot (the review bar)", () => {
		// 400 px can be seen: the sentence at 380 to 404 is partly under the bar.
		expect(
			focusScrollTop({ ...base, covered: 100, rect: at(480), mode: "reveal" }),
		).toBe(1000 + 392 - 200);
	});

	it("never goes past either end", () => {
		expect(focusScrollTop({ ...base, rect: at(-2000), mode: "center" })).toBe(
			0,
		);
		expect(focusScrollTop({ ...base, rect: at(9000), mode: "center" })).toBe(
			3500,
		);
		expect(focusScrollTop({ ...base, rect: null, mode: "center" })).toBeNull();
	});
});
