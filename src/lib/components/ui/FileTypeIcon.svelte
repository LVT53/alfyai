<script lang="ts">
/**
 * Shared file type icon component — the product's glyph vocabulary.
 *
 * The map is keyed on the registry's `FileTypeCategory`, so a caller that has
 * already asked `getCategory(filename, mimeType)` can hand the answer straight
 * over:
 *
 * ```svelte
 * <FileTypeIcon category={getCategory(file.name, file.mimeType)} />
 * ```
 *
 * `type` is the compatibility prop the older call sites still use. It accepts
 * a `PreviewFileType` (OpenDocumentsRail) or an `AttachmentFileType`
 * (FileAttachment) as well as a bare category, and translates the handful of
 * values that are not categories. Spec open question 15 keeps it until both
 * call sites pass a category; it is the one place in the app allowed to know
 * that "docx" and "document" draw the same glyph.
 */

import type { FileTypeCategory } from "$lib/shared/file-types";
import {
	Archive,
	Code,
	File,
	FileText,
	Image,
	Presentation,
	Table,
} from "@lucide/svelte";

let {
	type,
	category,
	size = 16,
}: {
	type?: string;
	category?: FileTypeCategory;
	size?: number;
} = $props();

const iconMap: Record<FileTypeCategory, typeof File> = {
	image: Image,
	pdf: FileText,
	document: FileText,
	spreadsheet: Table,
	presentation: Presentation,
	code: Code,
	text: FileText,
	archive: Archive,
	media: File,
	other: File,
};

/** Preview kinds and attachment types that are not category names. */
const LEGACY_TYPE_TO_CATEGORY: Record<string, FileTypeCategory> = {
	docx: "document",
	odt: "document",
	xlsx: "spreadsheet",
	pptx: "presentation",
	html: "code",
	unsupported: "other",
};

let resolvedCategory = $derived<FileTypeCategory>(
	category ??
		LEGACY_TYPE_TO_CATEGORY[type ?? ""] ??
		((type ?? "") in iconMap ? (type as FileTypeCategory) : "other"),
);

let Icon = $derived(iconMap[resolvedCategory]);
</script>

<span aria-hidden="true">
	<Icon {size} strokeWidth={2} />
</span>
