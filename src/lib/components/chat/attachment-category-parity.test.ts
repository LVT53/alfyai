// Glyph parity for the chips, across EVERY extension and MIME the registry
// knows (spec section 5, slice B).
//
// `legacy-equivalence.test.ts` proves the registry's `getCategory` reproduces
// the old `getFileType`; this file proves the SHIPPED `getFileType` — the one
// FileAttachment and the composer chip actually call — still answers the same
// thing, so the category map in `attachment-file-type.ts` cannot drift from
// the one the equivalence test carries.
//
// The frozen copy below is `attachment-file-type.ts` as it stood before the
// registry landed. DO NOT edit it to match the new implementation: a
// difference is either a bug or belongs in DELTA_* with a spec pointer.

import { describe, expect, it } from "vitest";
import { FILE_TYPE_ENTRIES } from "$lib/shared/file-types";
import { getFileType } from "./attachment-file-type";

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/lib/components/chat/attachment-file-type.ts:31-138 (pre-registry)
// ───────────────────────────────────────────────────────────────────────────

const FROZEN_IMAGE_EXTENSIONS = [
	"png",
	"jpg",
	"jpeg",
	"jfif",
	"gif",
	"bmp",
	"tiff",
	"tif",
	"svg",
	"webp",
	"heic",
	"heif",
	"avif",
];
const FROZEN_SPREADSHEET_EXTENSIONS = ["csv", "xls", "xlsx", "ods"];
const FROZEN_PRESENTATION_EXTENSIONS = ["ppt", "pptx", "odp"];
const FROZEN_DOCUMENT_EXTENSIONS = [
	"txt",
	"md",
	"rtf",
	"log",
	"odt",
	"doc",
	"docx",
];
const FROZEN_CODE_EXTENSIONS = [
	"js",
	"ts",
	"tsx",
	"jsx",
	"json",
	"xml",
	"html",
	"htm",
	"css",
	"py",
	"java",
	"go",
	"rs",
	"sh",
	"rb",
];
const FROZEN_ARCHIVE_EXTENSIONS = ["zip", "rar", "7z", "tar", "gz"];

function frozenFileExtension(filename: string): string {
	const parts = filename.split(".");
	if (parts.length < 2) return "";
	return (parts.pop() ?? "").toLowerCase().trim();
}

function frozenGetFileType(mimeType: string | null, filename: string): string {
	const mime = (mimeType ?? "").toLowerCase().trim();
	const ext = frozenFileExtension(filename);

	if (FROZEN_IMAGE_EXTENSIONS.includes(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (FROZEN_SPREADSHEET_EXTENSIONS.includes(ext)) return "xlsx";
	if (FROZEN_PRESENTATION_EXTENSIONS.includes(ext)) return "pptx";
	if (FROZEN_DOCUMENT_EXTENSIONS.includes(ext)) return "text";
	if (FROZEN_CODE_EXTENSIONS.includes(ext)) return "code";
	if (FROZEN_ARCHIVE_EXTENSIONS.includes(ext)) return "archive";

	if (mime.startsWith("image/")) return "image";
	if (mime === "application/pdf") return "pdf";

	if (mime.includes("wordprocessingml") || mime.includes("msword")) {
		return "text";
	}
	if (
		mime.includes("spreadsheetml") ||
		mime.includes("spreadsheet") ||
		mime.includes("excel") ||
		mime.includes("csv")
	) {
		return "xlsx";
	}
	if (mime.includes("presentationml") || mime.includes("presentation")) {
		return "pptx";
	}

	if (
		mime.includes("code") ||
		mime.includes("javascript") ||
		mime.includes("typescript") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		mime.includes("html") ||
		mime.includes("css")
	) {
		return "code";
	}
	if (
		mime.includes("zip") ||
		mime.includes("compressed") ||
		mime.includes("archive")
	) {
		return "archive";
	}
	if (mime.startsWith("text/") || mime.includes("document")) return "text";

	return "unsupported";
}

// ───────────────────────────────────────────────────────────────────────────
// The two sanctioned delta groups. Both are copies of
// `legacy-equivalence.test.ts`'s KNOWN_DELTAS groups 4 and 6, kept here so a
// change to the shipped map has to be justified twice. Every member of
// DELTA_BY_EXTENSION is a file that drew the GENERIC glyph before and draws a
// real one now; nothing moves between two real glyphs there.
//
// Phase 5 adds two ENTRIES the frozen implementation had never heard of
// (`epub`, `ofd`), so both arrive as `unsupported -> …` by extension. The
// EPUB *MIME* is the one exception and carries its own note below.
// ───────────────────────────────────────────────────────────────────────────

/** KNOWN_DELTAS.attachmentGlyphExpansion */
const DELTA_BY_EXTENSION: Readonly<Record<string, readonly [string, string]>> =
	{
		markdown: ["unsupported", "text"],
		scss: ["unsupported", "code"],
		sass: ["unsupported", "code"],
		less: ["unsupported", "code"],
		mjs: ["unsupported", "code"],
		cjs: ["unsupported", "code"],
		bash: ["unsupported", "code"],
		zsh: ["unsupported", "code"],
		yaml: ["unsupported", "code"],
		yml: ["unsupported", "code"],
		toml: ["unsupported", "code"],
		sql: ["unsupported", "code"],
		graphql: ["unsupported", "code"],
		gql: ["unsupported", "code"],
		ini: ["unsupported", "code"],
		env: ["unsupported", "code"],
		conf: ["unsupported", "code"],
		kt: ["unsupported", "code"],
		kts: ["unsupported", "code"],
		swift: ["unsupported", "code"],
		cs: ["unsupported", "code"],
		cpp: ["unsupported", "code"],
		cxx: ["unsupported", "code"],
		cc: ["unsupported", "code"],
		hpp: ["unsupported", "code"],
		c: ["unsupported", "code"],
		h: ["unsupported", "code"],
		php: ["unsupported", "code"],
		r: ["unsupported", "code"],
		tsv: ["unsupported", "xlsx"],
		// Phase 5 D1/§2.3 — both are new table entries, so the frozen map had
		// no extension rule for either and answered `unsupported`. `epub` and
		// `ofd` are both `category: "document"`, which the chips draw with the
		// document glyph (`FileText`), and the Knowledge list with the same.
		epub: ["unsupported", "text"],
		ofd: ["unsupported", "text"],
	};

/** KNOWN_DELTAS.mimeOnlyGlyphExpansion, as `mime: before -> after` lines. */
const DELTA_BY_MIME_TYPE: readonly string[] = [
	// EPUB is the one row in this whole file that moves a file between two
	// REAL glyphs, and it is a fix rather than an expansion. The frozen
	// implementation had no `epub` rule at all, so an EPUB with no usable
	// extension fell through to its `mime.includes("zip")` arm and drew the
	// ARCHIVE glyph — an EPUB *is* a zip container, but a reader who is told
	// "archive" is told to unpack it, and Phase 5 makes it a format we read.
	// The registry answers from the entry (`category: "document"`), so it now
	// draws the document glyph, exactly as the `.epub` extension already did
	// through DELTA_BY_EXTENSION above.
	"application/epub+zip: archive -> text",
	"application/graphql: unsupported -> code",
	// `.ofd` stays a REFUSED upload (spec OQ3, zero evidence). The entry exists
	// only so the refusal can say "save it as PDF or DOCX" instead of "that
	// file type isn't supported" — and a file the user can see named in that
	// message should not be wearing the generic glyph while they read it.
	"application/ofd: unsupported -> text",
	"application/rtf: unsupported -> text",
	"application/sql: unsupported -> code",
	"application/toml: unsupported -> code",
	"application/vnd.ms-powerpoint: unsupported -> pptx",
	"application/vnd.rar: unsupported -> archive",
	"application/x-httpd-php: unsupported -> code",
	"application/x-sh: unsupported -> code",
	"application/x-tar: unsupported -> archive",
	"application/x-yaml: unsupported -> code",
	"application/yaml: unsupported -> code",
	"text/jsx: text -> code",
	"text/rust: text -> code",
	"text/tab-separated-values: text -> xlsx",
	"text/tsx: text -> code",
	"text/x-c++src: text -> code",
	"text/x-csharp: text -> code",
	"text/x-csrc: text -> code",
	"text/x-go: text -> code",
	"text/x-java-source: text -> code",
	"text/x-kotlin: text -> code",
	"text/x-less: text -> code",
	"text/x-python: text -> code",
	"text/x-r-source: text -> code",
	"text/x-ruby: text -> code",
	"text/x-sass: text -> code",
	"text/x-shellscript: text -> code",
	"text/x-swift: text -> code",
	"text/yaml: text -> code",
];

const ALL_EXTENSIONS = FILE_TYPE_ENTRIES.flatMap((entry) => [
	...entry.extensions,
]);
const ALL_MIME_TYPES = [
	...new Set(FILE_TYPE_ENTRIES.flatMap((entry) => [...entry.mimeTypes])),
].sort();

function sorted(values: readonly string[]): string[] {
	return [...values].sort();
}

describe("attachment glyph parity", () => {
	it("covers the whole table", () => {
		// A table that shrank to nothing would make every assertion below vacuous.
		expect(ALL_EXTENSIONS.length).toBeGreaterThan(80);
		expect(ALL_MIME_TYPES.length).toBeGreaterThan(70);
	});

	it("answers as the old getFileType did for every extension, bar the expansion", () => {
		const observed: Record<string, readonly [string, string]> = {};
		for (const extension of ALL_EXTENSIONS) {
			const filename = `attachment.${extension}`;
			const before = frozenGetFileType(null, filename);
			const after = getFileType(null, filename);
			if (before !== after) observed[extension] = [before, after];
		}
		expect(observed).toEqual(DELTA_BY_EXTENSION);
	});

	it("only ever replaces the generic glyph, never a real one", () => {
		for (const [before] of Object.values(DELTA_BY_EXTENSION)) {
			expect(before).toBe("unsupported");
		}
	});

	it("answers as the old getFileType did for every MIME, bar the expansion", () => {
		const observed: string[] = [];
		for (const mimeType of ALL_MIME_TYPES) {
			// A name with no usable extension, so the MIME is what decides.
			const before = frozenGetFileType(mimeType, "attachment");
			const after = getFileType(mimeType, "attachment");
			if (before !== after) observed.push(`${mimeType}: ${before} -> ${after}`);
		}
		expect(sorted(observed)).toEqual(sorted(DELTA_BY_MIME_TYPE));
	});

	it("keeps the extension authoritative over a lying MIME type", () => {
		// The property the frozen implementation had and the registry keeps: the
		// name the user gave the file beats the browser's guess.
		expect(getFileType("text/plain", "handbook.docx")).toBe("text");
		expect(getFileType("application/octet-stream", "figures.xlsx")).toBe(
			"xlsx",
		);
		expect(getFileType("text/plain", "photo.png")).toBe("image");
	});

	it("still gives up on a file it cannot place", () => {
		expect(getFileType(null, "mystery")).toBe("unsupported");
		expect(getFileType("application/octet-stream", "blob.bin")).toBe(
			"unsupported",
		);
		expect(getFileType("", "")).toBe("unsupported");
	});
});
