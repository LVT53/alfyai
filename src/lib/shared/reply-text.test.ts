import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getClipboardText, joinReplyText } from "./reply-text";

describe("getClipboardText", () => {
	it("takes the words of a row without its thinking text", () => {
		expect(
			getClipboardText("<thinking>Inline hidden thought.</thinking>Visible."),
		).toBe("Visible.");
		expect(getClipboardText("  <thinking>Open")).toBe("Open");
		expect(getClipboardText("Plain words.")).toBe("Plain words.");
	});
});

describe("joinReplyText", () => {
	it("is a row's words alone for a reply of one row", () => {
		expect(joinReplyText(["  A plan for Saturday.\n"])).toBe(
			"A plan for Saturday.",
		);
	});

	it("joins the rows' words by a blank line, in order", () => {
		expect(joinReplyText(["First words.", "Second words.", "Last."])).toBe(
			"First words.\n\nSecond words.\n\nLast.",
		);
	});

	it("leaves out a row with no words, and strips the thinking of each", () => {
		expect(
			joinReplyText([
				"<thinking>Plan.</thinking>First words.",
				"   ",
				"<thinking>Nothing to say.</thinking>",
				"Last words.",
			]),
		).toBe("First words.\n\nLast words.");
	});

	it("has no words for a reply with none, or no rows", () => {
		expect(joinReplyText(["", " \n"])).toBe("");
		expect(joinReplyText([])).toBe("");
	});
});

describe("module hygiene", () => {
	// The same zero-value-import guard the other shared leaves carry
	// (extraction-status.ts, ask-user.ts): the chat components and the artifacts
	// service both import this file, and anything it imported would travel to both.
	it("has no imports", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(path.join(here, "reply-text.ts"), "utf8");
		expect(source.match(/^import\s/gm)).toBeNull();
	});
});
