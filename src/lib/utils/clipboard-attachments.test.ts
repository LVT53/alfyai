import { describe, expect, it } from "vitest";
import {
	decideClipboardAttachment,
	UPLOAD_REJECT_I18N_KEYS,
} from "./clipboard-attachments";

// jsdom has no constructible `DataTransfer`, and the decision only ever reads
// `types` and `files` — the two things a real ClipboardEvent carries. Building
// the shape by hand also lets a test say "Word puts BOTH on the clipboard",
// which is the case the whole rule exists for.
function clipboard(types: string[], files: File[] = []): DataTransfer {
	return { types, files } as unknown as DataTransfer;
}

function makeFile(name: string, type: string): File {
	return new File(["bytes"], name, { type });
}

const FIXED_NOW = new Date(2026, 8, 21, 4, 15, 0);

describe("decideClipboardAttachment", () => {
	it("does nothing for a clipboard with no DataTransfer at all", () => {
		const decision = decideClipboardAttachment(null);
		expect(decision).toEqual({
			files: [],
			preventDefault: false,
			refused: [],
		});
	});

	it("leaves a pure text paste to the browser", () => {
		const decision = decideClipboardAttachment(clipboard(["text/plain"]));
		expect(decision.preventDefault).toBe(false);
		expect(decision.files).toEqual([]);
	});

	// The case the conservative rule is FOR. Excel, Word and a web page all put
	// an image on the clipboard beside the text; attaching it would make the
	// composer unusable for the everyday paste.
	it("leaves a Word/Excel paste alone even though it carries an image file", () => {
		const decision = decideClipboardAttachment(
			clipboard(
				["text/plain", "text/html", "Files"],
				[makeFile("image.png", "image/png")],
			),
		);
		expect(decision.preventDefault).toBe(false);
		expect(decision.files).toEqual([]);
		expect(decision.refused).toEqual([]);
	});

	it("attaches a screenshot, which carries files and no text", () => {
		const decision = decideClipboardAttachment(
			clipboard(["Files", "image/png"], [makeFile("image.png", "image/png")]),
			{ now: FIXED_NOW },
		);
		expect(decision.preventDefault).toBe(true);
		expect(decision.files).toHaveLength(1);
		// `image.png` is the placeholder name Chrome and Safari invent for a
		// screenshot, so it is replaced with something recognisable in a row of
		// five chips — with the extension the REGISTRY gives the MIME.
		expect(decision.files[0].name).toBe("pasted-20260921-041500.png");
		expect(decision.files[0].type).toBe("image/png");
	});

	it("keeps the name of a file copied in Finder/Explorer", () => {
		const decision = decideClipboardAttachment(
			clipboard(["Files"], [makeFile("Q3 report.pdf", "application/pdf")]),
			{ now: FIXED_NOW },
		);
		expect(decision.preventDefault).toBe(true);
		expect(decision.files.map((file) => file.name)).toEqual(["Q3 report.pdf"]);
	});

	it("gives a nameless file the canonical extension for its MIME", () => {
		const decision = decideClipboardAttachment(
			clipboard(["Files"], [makeFile("", "image/jpeg")]),
			{ now: FIXED_NOW },
		);
		// `jpg`, not `jpeg`: the registry's first extension is the canonical one.
		expect(decision.files[0].name).toBe("pasted-20260921-041500.jpg");
	});

	it("numbers a multi-file paste so two screenshots are two chips", () => {
		const decision = decideClipboardAttachment(
			clipboard(
				["Files"],
				[
					makeFile("image.png", "image/png"),
					makeFile("image.png", "image/png"),
					makeFile("notes.md", "text/markdown"),
				],
			),
			{ now: FIXED_NOW },
		);
		expect(decision.files.map((file) => file.name)).toEqual([
			"pasted-20260921-041500.png",
			"pasted-20260921-041500-2.png",
			"notes.md",
		]);
		expect(decision.preventDefault).toBe(true);
	});

	it("refuses a media file with the message that says what to do instead", () => {
		const decision = decideClipboardAttachment(
			clipboard(["Files"], [makeFile("clip.mp4", "video/mp4")]),
			{ now: FIXED_NOW },
		);
		expect(decision.refused).toEqual([
			{
				name: "clip.mp4",
				errorKey: "knowledge.uploadRejectedMedia",
				ext: "MP4",
			},
		]);
		// Nothing was attached, so the paste is NOT swallowed: a clipboard with
		// no text pastes nothing anyway, and preventing the default would hide a
		// flavour the browser might still have known what to do with.
		expect(decision.preventDefault).toBe(false);
		expect(decision.files).toEqual([]);
	});

	it("keeps the good files of a mixed paste and refuses the rest", () => {
		const decision = decideClipboardAttachment(
			clipboard(
				["Files"],
				[
					makeFile("budget.xlsx", "application/vnd.ms-excel"),
					makeFile("archive.zip", "application/zip"),
				],
			),
			{ now: FIXED_NOW },
		);
		expect(decision.files.map((file) => file.name)).toEqual(["budget.xlsx"]);
		expect(decision.refused.map((refusal) => refusal.errorKey)).toEqual([
			"knowledge.uploadRejectedArchive",
		]);
		expect(decision.preventDefault).toBe(true);
	});

	// The MinerU-4 gate (spec D6). It fails OPEN: an absent or empty set is
	// "the backend has not answered", which disables nothing.
	it("refuses a gated format only when the gate says so", () => {
		const epub = () => clipboard(["Files"], [makeFile("novel.epub", "")]);

		const open = decideClipboardAttachment(epub(), { now: FIXED_NOW });
		expect(open.files).toHaveLength(1);
		expect(open.refused).toEqual([]);

		const closed = decideClipboardAttachment(epub(), {
			now: FIXED_NOW,
			disabledEntryIds: new Set(["epub"]),
		});
		expect(closed.files).toEqual([]);
		expect(closed.refused).toEqual([
			{
				name: "novel.epub",
				errorKey: "knowledge.uploadRejectedFormatNotEnabled",
				ext: "EPUB",
			},
		]);
	});

	it("admits an unknown extension the browser calls text, as the server does", () => {
		const decision = decideClipboardAttachment(
			clipboard(["Files"], [makeFile("notes.rst", "text/plain")]),
			{ now: FIXED_NOW },
		);
		// `text/plain` in `types` would be a TEXT paste; `text/plain` as a FILE's
		// MIME is a text file, and `admitUpload` reads it directly.
		expect(decision.files.map((file) => file.name)).toEqual(["notes.rst"]);
	});
});

describe("UPLOAD_REJECT_I18N_KEYS", () => {
	it("covers every reject reason the registry can answer with", () => {
		// The `Record<RejectReasonKey, string>` type is the real guard — this
		// asserts the values, which no type can.
		expect(UPLOAD_REJECT_I18N_KEYS).toEqual({
			unknownType: "knowledge.uploadUnsupportedType",
			media: "knowledge.uploadRejectedMedia",
			archive: "knowledge.uploadRejectedArchive",
			formatNotEnabled: "knowledge.uploadRejectedFormatNotEnabled",
		});
	});
});
