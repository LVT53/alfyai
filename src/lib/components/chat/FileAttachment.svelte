<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<script lang="ts" generics="T">
import { X } from "@lucide/svelte";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";

interface FileAttachmentData {
	id: string;
	name: string;
	mimeType?: string | null;
}

let {
	attachment,
	removable = false,
	variant = "compact",
	compact = false,
	viewable = false,
	onRemove,
	onView,
}: {
	attachment: T & FileAttachmentData;
	removable?: boolean;
	variant?: "compact" | "pending";
	compact?: boolean;
	viewable?: boolean;
	onRemove?: (payload: { id: string }) => void;
	onView?: (attachment: T & FileAttachmentData) => void;
} = $props();

function getFileType(mimeType: string | null, filename: string): string {
	const mime = (mimeType ?? "").toLowerCase().trim();
	const ext = (filename.split(".").pop() ?? "").toLowerCase();

	// Image
	if (
		mime.startsWith("image/") ||
		[
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
		].includes(ext)
	) {
		return "image";
	}
	// PDF
	if (mime === "application/pdf" || ext === "pdf") {
		return "pdf";
	}
	// Spreadsheet
	if (
		mime.includes("spreadsheet") ||
		mime.includes("excel") ||
		mime.includes("csv") ||
		["csv", "xls", "xlsx", "ods"].includes(ext)
	) {
		return "xlsx";
	}
	// Presentation
	if (mime.includes("presentation") || ["ppt", "pptx", "odp"].includes(ext)) {
		return "pptx";
	}
	// Code
	if (
		mime.includes("code") ||
		mime.includes("javascript") ||
		mime.includes("typescript") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		mime.includes("html") ||
		mime.includes("css") ||
		[
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
		].includes(ext)
	) {
		return "code";
	}
	// Archive
	if (
		mime.includes("zip") ||
		mime.includes("compressed") ||
		mime.includes("archive") ||
		["zip", "rar", "7z", "tar", "gz"].includes(ext)
	) {
		return "archive";
	}
	// Text/Document
	if (
		mime.includes("text/") ||
		["txt", "md", "rtf", "log", "odt", "doc", "docx"].includes(ext) ||
		mime.includes("document") ||
		mime.includes("word")
	) {
		return "text";
	}
	return "unsupported";
}

function handleRemove() {
	onRemove?.({ id: attachment.id });
}

function handleClick() {
	if (viewable && onView) {
		onView(attachment);
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (viewable && onView && (event.key === "Enter" || event.key === " ")) {
		event.preventDefault();
		onView(attachment);
	}
}
</script>

<div
	class="file-attachment"
	class:compact={variant === 'compact'}
	class:pending={variant === 'pending'}
	class:viewable={viewable && onView}
	role={viewable && onView ? 'button' : 'listitem'}
	onclick={handleClick}
	onkeydown={handleKeydown}
	tabindex={viewable && onView ? 0 : undefined}
	aria-label={viewable && onView ? `View ${attachment.name}` : undefined}
>
	<span class="file-icon">
		<FileTypeIcon type={getFileType(attachment.mimeType ?? null, attachment.name)} size={16} />
	</span>
	<span class="filename">{attachment.name}</span>
	{#if removable}
		<button
			type="button"
			class="remove-button"
			class:compact-remove={compact}
			onclick={handleRemove}
			aria-label={`Remove ${attachment.name}`}
		>
			<X size={14} strokeWidth={2} aria-hidden="true" />
		</button>
	{/if}
</div>

<style lang="postcss">
	.file-attachment {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		max-width: 100%;
	}

	.compact {
		border-radius: 1.2rem;
		border: 1px solid var(--border-default);
		background-color: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
		padding: var(--space-sm) var(--space-md);
	}

	.pending {
		border-radius: 1.2rem;
		border: 1px solid var(--border-default);
		background-color: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
		padding: var(--space-sm) var(--space-md);
		animation: borderPulse 2s ease-in-out infinite;
	}

	.viewable {
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.viewable:hover {
		background-color: color-mix(in srgb, var(--surface-page) 70%, var(--surface-elevated) 30%);
		border-color: var(--accent);
	}

	.viewable:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@keyframes borderPulse {
		0%,
		100% {
			border-color: var(--border-default);
		}
		50% {
			border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		}
	}

	.file-icon {
		flex-shrink: 0;
		color: var(--icon-muted);
	}

	.filename {
		font-family: var(--font-sans);
		font-size: var(--text-md);
		line-height: 1.25;
		color: var(--text-primary);
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.remove-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		margin: -8px;
		background-color: transparent;
		border: none;
		border-radius: var(--radius-md);
		color: var(--icon-muted);
		cursor: pointer;
		transition:
			color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
		outline: none;
	}

	.compact-remove {
		min-width: 28px;
		min-height: 28px;
		padding: 0.25rem;
		margin: 0;
	}

	.remove-button:hover {
		color: var(--icon-primary);
		background-color: color-mix(in srgb, var(--surface-overlay) 50%, transparent);
	}

	.remove-button:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.remove-button:active {
		transform: scale(0.92);
	}

	@media (prefers-reduced-motion: reduce) {
		.pending {
			animation: none;
		}

		.remove-button {
			transition: none;
		}
	}
</style>
