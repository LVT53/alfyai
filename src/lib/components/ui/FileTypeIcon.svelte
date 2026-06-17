<script lang="ts">
/**
 * Shared file type icon component.
 *
 * Renders a Lucide icon for a given file type.
 * Supports: pdf, docx, xlsx, pptx, odt, image, text, unsupported
 *
 * Usage:
 * ```svelte
 * <FileTypeIcon type="pdf" />
 * <FileTypeIcon type="docx" size={20} class="text-icon-muted" />
 * ```
 */

import { Archive, Code, File, FileText, Image, Presentation, Table } from "@lucide/svelte";

let { type = "unsupported", size = 16 }: { type?: string; size?: number } =
	$props();

const iconMap: Record<string, typeof File> = {
	pdf: FileText,
	docx: FileText,
	xlsx: Table,
	pptx: Presentation,
	odt: FileText,
	image: Image,
	text: FileText,
	html: Code,
	code: Code,
	archive: Archive,
};

let Icon = $derived(iconMap[type] ?? File);
</script>

<span aria-hidden="true">
	<Icon {size} strokeWidth={2} />
</span>
