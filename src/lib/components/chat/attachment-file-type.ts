// Which glyph an attachment draws — lifted out of FileAttachment.svelte's
// inline `getFileType` so the decision is unit-testable on its own and so
// the composer's chip and the bubble's chip cannot disagree about a file.
//
// It also fixes the bug the chips redesign was asked to fix along the way:
// a `.docx` drew the CODE glyph. Its mime type is
//
//   application/vnd.openxmlformats-officedocument.wordprocessingml.document
//
// and the old order tested `mime.includes("xml")` — which "openxmlformats"
// satisfies — BEFORE it tested for a document, so every Word file in the
// product was a source-code file. `.xlsx` and `.pptx` escaped only by luck:
// their own `spreadsheet` / `presentation` branches happened to run first.
//
// The fix is to stop letting a substring of a vendor mime token decide.
// The extension is checked first (it is what the user actually named the
// file), Office formats are matched on their full OOXML mime tokens rather
// than on "xml", and the generic code/text sniffing only runs once every
// known format has had its turn.

export type AttachmentFileType =
	| "image"
	| "pdf"
	| "xlsx"
	| "pptx"
	| "code"
	| "archive"
	| "text"
	| "unsupported";

const IMAGE_EXTENSIONS = [
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
const SPREADSHEET_EXTENSIONS = ["csv", "xls", "xlsx", "ods"];
const PRESENTATION_EXTENSIONS = ["ppt", "pptx", "odp"];
const DOCUMENT_EXTENSIONS = ["txt", "md", "rtf", "log", "odt", "doc", "docx"];
const CODE_EXTENSIONS = [
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
const ARCHIVE_EXTENSIONS = ["zip", "rar", "7z", "tar", "gz"];

// The full OOXML mime tokens, matched whole. `wordprocessingml` is the one
// that has to beat the old "xml" substring test; the other two are listed
// with it so the three Office formats are decided by the same rule.
const OOXML_DOCUMENT = "wordprocessingml";
const OOXML_SPREADSHEET = "spreadsheetml";
const OOXML_PRESENTATION = "presentationml";

/** The extension, lowercased, or "" when the name carries none. */
export function fileExtension(filename: string): string {
	const parts = filename.split(".");
	if (parts.length < 2) return "";
	return (parts.pop() ?? "").toLowerCase().trim();
}

export function getFileType(
	mimeType: string | null,
	filename: string,
): AttachmentFileType {
	const mime = (mimeType ?? "").toLowerCase().trim();
	const ext = fileExtension(filename);

	// 1. The extension the user gave the file, for every format we name.
	if (IMAGE_EXTENSIONS.includes(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (SPREADSHEET_EXTENSIONS.includes(ext)) return "xlsx";
	if (PRESENTATION_EXTENSIONS.includes(ext)) return "pptx";
	if (DOCUMENT_EXTENSIONS.includes(ext)) return "text";
	if (CODE_EXTENSIONS.includes(ext)) return "code";
	if (ARCHIVE_EXTENSIONS.includes(ext)) return "archive";

	// 2. Unambiguous mime families.
	if (mime.startsWith("image/")) return "image";
	if (mime === "application/pdf") return "pdf";

	// 3. Office, matched on the whole OOXML token rather than on "xml".
	if (mime.includes(OOXML_DOCUMENT) || mime.includes("msword")) return "text";
	if (
		mime.includes(OOXML_SPREADSHEET) ||
		mime.includes("spreadsheet") ||
		mime.includes("excel") ||
		mime.includes("csv")
	) {
		return "xlsx";
	}
	if (mime.includes(OOXML_PRESENTATION) || mime.includes("presentation")) {
		return "pptx";
	}

	// 4. Generic sniffing, last, so it can no longer outrank a real format.
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
