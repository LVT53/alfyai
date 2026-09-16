import { describe, expect, it } from "vitest";
import {
	attachmentChipKind,
	attachmentChipMeta,
	attachmentThumbnailUrl,
	buildOutlineQuote,
	formatTokenCount,
	quoteChipLabel,
	splitUserMessageQuotes,
} from "./composer-chip-presentation";

describe("attachmentChipKind", () => {
	it("gives an image its own kind so the pill can wear a crop of itself", () => {
		expect(
			attachmentChipKind({
				name: "floor-plan-level-2.png",
				mimeType: "image/png",
			}),
		).toBe("image");
	});

	it("gives everything else the file mark", () => {
		expect(
			attachmentChipKind({
				name: "Lease agreement 2026.pdf",
				mimeType: "application/pdf",
			}),
		).toBe("file");
	});

	// The shelf mark is what separates a document you LINKED from the Library
	// from a file you just uploaded.
	it("gives a linked Library document the shelf mark", () => {
		expect(
			attachmentChipKind(
				{ name: "Employee handbook.docx", mimeType: null },
				{ linked: true },
			),
		).toBe("library");
	});
});

describe("attachmentChipMeta", () => {
	it("says pages and cost together when it knows both", () => {
		expect(
			attachmentChipMeta({
				name: "lease.pdf",
				pageCount: 24,
				tokenEstimate: 18_400,
			}),
		).toEqual({ key: "composerChips.fileMeta", pages: "24", tokens: "18k" });
	});

	it("says whichever half it knows", () => {
		expect(attachmentChipMeta({ name: "a.pdf", pageCount: 24 })).toEqual({
			key: "composerChips.filePages",
			pages: "24",
		});
		expect(attachmentChipMeta({ name: "a.pdf", tokenEstimate: 900 })).toEqual({
			key: "composerChips.fileTokens",
			tokens: "900",
		});
	});

	it("says nothing rather than zero", () => {
		expect(attachmentChipMeta({ name: "a.pdf" })).toBeNull();
		expect(
			attachmentChipMeta({ name: "a.pdf", pageCount: 0, tokenEstimate: 0 }),
		).toBeNull();
	});
});

describe("formatTokenCount", () => {
	it("compacts the way the old two-line cost card did", () => {
		expect(formatTokenCount(940)).toBe("940");
		expect(formatTokenCount(18_400)).toBe("18k");
		expect(formatTokenCount(2_400_000)).toBe("2M");
	});
});

describe("attachmentThumbnailUrl", () => {
	it("points an image chip at the existing preview endpoint", () => {
		expect(
			attachmentThumbnailUrl({
				id: "artifact-1",
				name: "photo.png",
				mimeType: "image/png",
			}),
		).toBe("/api/knowledge/artifact-1/preview");
	});

	it("escapes an id rather than splicing it into a path raw", () => {
		expect(
			attachmentThumbnailUrl({
				id: "a/b",
				name: "photo.png",
				mimeType: "image/png",
			}),
		).toBe("/api/knowledge/a%2Fb/preview");
	});

	it("is null for a non-image and for an artifact with no id yet", () => {
		expect(
			attachmentThumbnailUrl({
				id: "artifact-1",
				name: "lease.pdf",
				mimeType: "application/pdf",
			}),
		).toBeNull();
		expect(
			attachmentThumbnailUrl({ name: "photo.png", mimeType: "image/png" }),
		).toBeNull();
	});
});

describe("quoteChipLabel", () => {
	it("keeps the section heading and leaves the document's prose out", () => {
		expect(
			quoteChipLabel(
				"2.3 Break clause: Either party may terminate on six months' notice…",
			),
		).toBe("2.3 Break clause");
	});

	it("falls back to the whole quote when there is no heading clause", () => {
		expect(quoteChipLabel("  A heading with no colon  ")).toBe(
			"A heading with no colon",
		);
	});
});

describe("splitUserMessageQuotes", () => {
	const OUTLINE = [
		{ title: "2.3 Break clause", preview: "Either party may terminate" },
		{ title: "4.1 Service charge", preview: "The tenant pays" },
		{ title: "Summary", preview: "" },
	];

	it("builds the quote the outline row produces, and nothing else", () => {
		expect(
			buildOutlineQuote({
				title: "2.3 Break clause",
				preview: "Either party may terminate",
			}),
		).toBe("2.3 Break clause: Either party may terminate…");
		expect(buildOutlineQuote({ title: "Summary", preview: "  " })).toBe(
			"Summary",
		);
	});

	it("peels a sent quote back off the front of the message", () => {
		expect(
			splitUserMessageQuotes(
				"2.3 Break clause: Either party may terminate…\n\nCan we get out of this early?",
				OUTLINE,
			),
		).toEqual({
			quoteLabels: ["2.3 Break clause"],
			body: "Can we get out of this early?",
		});
	});

	it("peels several, in the order they were picked", () => {
		expect(
			splitUserMessageQuotes(
				"4.1 Service charge: The tenant pays…\n\n2.3 Break clause: Either party may terminate…\n\nWhat do we owe?",
				OUTLINE,
			),
		).toEqual({
			quoteLabels: ["4.1 Service charge", "2.3 Break clause"],
			body: "What do we owe?",
		});
	});

	it("handles a turn that was nothing but a quote", () => {
		expect(
			splitUserMessageQuotes(
				"2.3 Break clause: Either party may terminate…",
				OUTLINE,
			),
		).toEqual({ quoteLabels: ["2.3 Break clause"], body: "" });
	});

	it("recognises a bare-title quote from an entry with no preview", () => {
		expect(
			splitUserMessageQuotes("Summary\n\nShorter please.", OUTLINE),
		).toEqual({ quoteLabels: ["Summary"], body: "Shorter please." });
	});

	// The safe direction to fail: a quote shown as prose is a cosmetic miss;
	// prose eaten as a quote would lose the user's own words.
	it("leaves prose alone when nothing matches a persisted outline quote", () => {
		const content = "Break clause: what does it say?\n\nAnd the rest.";
		expect(splitUserMessageQuotes(content, OUTLINE)).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	// The heading alone is not enough: the user's own "2.3 Break clause: is
	// this enforceable?" shares a heading with the outline entry but is not
	// the quote the outline built, so it stays their sentence.
	it("does not eat a sentence that merely starts with a heading and a colon", () => {
		const content =
			"2.3 Break clause: is this enforceable?\n\nI need to know by Friday.";
		expect(splitUserMessageQuotes(content, OUTLINE)).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	it("does not eat a paragraph the quote merely prefixes", () => {
		const content =
			"2.3 Break clause: Either party may terminate… and then some words of mine\n\nRight?";
		expect(splitUserMessageQuotes(content, OUTLINE)).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	it("leaves the message untouched when the attachment has no outline", () => {
		const content =
			"2.3 Break clause: Either party may terminate…\n\nAnything?";
		expect(splitUserMessageQuotes(content, [])).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	it("stops at the first block that is not a quote", () => {
		expect(
			splitUserMessageQuotes(
				"2.3 Break clause: Either party may terminate…\n\nSome prose\n\n4.1 Service charge: The tenant pays…",
				OUTLINE,
			),
		).toEqual({
			quoteLabels: ["2.3 Break clause"],
			body: "Some prose\n\n4.1 Service charge: The tenant pays…",
		});
	});
});
