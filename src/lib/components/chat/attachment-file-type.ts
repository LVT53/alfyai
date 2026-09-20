// Which glyph an attachment draws — lifted out of FileAttachment.svelte's
// inline `getFileType` so the decision is unit-testable on its own and so
// the composer's chip and the bubble's chip cannot disagree about a file.
//
// The classification itself now comes from the shared registry
// (`$lib/shared/file-types`), so the composer chip, the knowledge list and the
// preview pane read ONE table. This file keeps only the translation from the
// registry's neutral `FileTypeCategory` to the `AttachmentFileType` vocabulary
// the chips were built on. See docs/plans/mineru4/phase1-registry-spec.md
// rows 13-15 and conflict 8.
//
// It also fixed the bug the chips redesign was asked to fix along the way: a
// Word file drew the CODE glyph. Its mime type contains the substring the old
// order sniffed for source code, and that arm ran BEFORE the one that tested
// for a document, so every Word file in the product was a source-code file.
// The spreadsheet and presentation formats escaped only by luck: their own
// branches happened to run first. The registry's `getCategory` keeps that fix —
// it answers from the entry the extension or the MIME resolves to, and only
// falls back to substring sniffing for a file it has never heard of, with the
// whole OOXML tokens still tested before the generic arm.

import type { FileTypeCategory } from "$lib/shared/file-types";
import { fileExtension, getCategory } from "$lib/shared/file-types";

export type AttachmentFileType =
	| "image"
	| "pdf"
	| "xlsx"
	| "pptx"
	| "code"
	| "archive"
	| "text"
	| "unsupported";

/**
 * The chips' glyph vocabulary, keyed on the registry's category.
 *
 * `media` and `other` collapse to "unsupported" because the chip has no audio
 * or video glyph: an .mp3 drew the generic icon before the registry existed
 * and still does.
 */
const CATEGORY_TO_ATTACHMENT_TYPE: Record<
	FileTypeCategory,
	AttachmentFileType
> = {
	image: "image",
	pdf: "pdf",
	spreadsheet: "xlsx",
	presentation: "pptx",
	document: "text",
	text: "text",
	code: "code",
	archive: "archive",
	media: "unsupported",
	other: "unsupported",
};

/** The extension, lowercased, or "" when the name carries none. */
export { fileExtension };

export function getFileType(
	mimeType: string | null,
	filename: string,
): AttachmentFileType {
	return CATEGORY_TO_ATTACHMENT_TYPE[getCategory(filename, mimeType)];
}
