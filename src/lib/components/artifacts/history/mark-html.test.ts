import { describe, expect, it } from "vitest";
import { markAdded, markWords, visibleText } from "./mark-html";

const LABELS = { added: "Added: ", removed: "Removed: " };

function root(html: string): HTMLElement {
	const el = document.createElement("div");
	el.innerHTML = html;
	return el;
}

describe("visibleText", () => {
	it("is the text a reader sees, with a line break between blocks and none inside a word's markup", () => {
		expect(
			visibleText(
				"<p>Morning at the <strong>Belve</strong>dere.</p><p>Walk.</p>",
			),
		).toBe("Morning at the Belvedere.\nWalk.");
		expect(visibleText("<ul><li>One</li><li>Two</li></ul>")).toBe("One\nTwo");
		expect(visibleText("")).toBe("");
	});
});

describe("markWords", () => {
	it("wraps the words only the new text has in a mark, keeping the markup around them", () => {
		const out = markWords(
			"<p>Morning at the <strong>Belvedere</strong>, then a cafe and a walk.</p>",
			"<p>Morning at the <strong>Belvedere</strong>, then a walk.</p>",
			LABELS,
		);
		const el = root(out.html);
		const marks = [...el.querySelectorAll("mark")];
		expect(marks.map((mark) => mark.textContent?.trim())).toEqual([
			"cafe and a",
		]);
		expect(marks[0].getAttribute("data-sr")).toBe("Added: ");
		expect(el.querySelector("strong")?.textContent).toBe("Belvedere");
		expect(out.marks).toBe(1);
		// Nothing was lost: the text a reader sees is the new text.
		expect(el.textContent).toBe(
			"Morning at the Belvedere, then a cafe and a walk.",
		);
	});

	it("puts the words only the old text had back, struck through, where they stood", () => {
		const out = markWords(
			"<p>Visit the Albertina on Saturday</p>",
			"<p>Visit the Belvedere on Saturday</p>",
			LABELS,
		);
		const el = root(out.html);
		expect(
			[...el.querySelectorAll("del")].map((del) => del.textContent),
		).toEqual(["Belvedere"]);
		expect(
			[...el.querySelectorAll("mark")].map((mark) => mark.textContent),
		).toEqual(["Albertina"]);
		expect(el.querySelector("del")?.getAttribute("data-sr")).toBe("Removed: ");
		// The deletion stands before the replacement.
		expect(el.textContent).toBe("Visit the BelvedereAlbertina on Saturday");
	});

	it("marks across inline markup: a bold word that is new is marked inside the bold", () => {
		const out = markWords(
			"<p>Book <strong>two</strong> tickets.</p>",
			"<p>Book tickets.</p>",
			LABELS,
		);
		const el = root(out.html);
		expect(el.querySelector("strong mark")?.textContent).toBe("two");
		expect(out.marks).toBeGreaterThan(0);
	});

	it("says nothing is marked for identical text", () => {
		const out = markWords("<p>Same.</p>", "<p>Same.</p>", LABELS);
		expect(out.marks).toBe(0);
		expect(root(out.html).querySelector("mark, del")).toBeNull();
	});

	it("handles a deletion at the very end and at the very start", () => {
		const end = markWords("<p>One two</p>", "<p>One two three</p>", LABELS);
		expect(root(end.html).querySelector("del")?.textContent?.trim()).toBe(
			"three",
		);
		const start = markWords("<p>two</p>", "<p>one two</p>", LABELS);
		expect(root(start.html).querySelector("del")?.textContent?.trim()).toBe(
			"one",
		);
	});

	it("does not mark a block break or a lone space", () => {
		const out = markWords(
			"<p>One</p><p>Two three</p>",
			"<p>One</p><p>Two</p>",
			LABELS,
		);
		const marks = [...root(out.html).querySelectorAll("mark")];
		expect(marks.map((mark) => mark.textContent?.trim())).toEqual(["three"]);
		// A paragraph that is new in the middle of two others keeps the line break out of its marks.
		const between = markWords(
			"<p>One</p><p>New</p><p>Two</p>",
			"<p>One</p><p>Two</p>",
			LABELS,
		);
		expect(
			[...root(between.html).querySelectorAll("mark")].map((mark) =>
				mark.textContent?.trim(),
			),
		).toEqual(["New"]);
	});
});

describe("markAdded", () => {
	it("marks every word of a block that is new", () => {
		const out = markAdded("<p>Museum <em>tickets</em> online.</p>", LABELS);
		const el = root(out.html);
		expect(
			[...el.querySelectorAll("mark")].map((mark) => mark.textContent).join(""),
		).toBe("Museum tickets online.");
		expect(el.querySelector("em mark")?.textContent).toBe("tickets");
		expect(out.marks).toBeGreaterThan(0);
	});
});
