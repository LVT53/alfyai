<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<script lang="ts" generics="T">
import { X } from "@lucide/svelte";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import { t } from "$lib/i18n";
// Chips redesign — `getFileType` moved into its own pure module so the
// decision is unit-testable and so the composer's chip, the bubble's chip
// and this card cannot disagree about a file. That is also where the
// `.docx` -> code-glyph bug was fixed: the old order tested
// `mime.includes("xml")`, which every OOXML mime satisfies, before it tested
// for a document.
import { getFileType } from "./attachment-file-type";
import ComposerChip from "./ComposerChip.svelte";
import {
	attachmentChipKind,
	attachmentChipMeta,
	attachmentThumbnailUrl,
} from "./composer-chip-presentation";

interface FileAttachmentData {
	id: string;
	name: string;
	mimeType?: string | null;
	// "Long-document comfort" (owner-approved mockup, 2026-09-06): shown as
	// a per-turn cost line under the filename when present.
	tokenEstimate?: number;
	pageCount?: number;
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
	// Chips redesign (owner-approved boards, 2026-09-15) — "chip" is the new
	// default shape inside a message: the SAME 22px pill the composer drew a
	// second earlier, minus its ×, because a sent attachment is a record of
	// what happened rather than a promise about the next turn. It delegates
	// to ComposerChip so there is exactly one chip implementation in the
	// product. "compact" / "pending" keep the old two-line card for any
	// surface that still wants the full per-turn cost line.
	variant?: "compact" | "pending" | "chip";
	compact?: boolean;
	viewable?: boolean;
	onRemove?: (payload: { id: string }) => void;
	onView?: (attachment: T & FileAttachmentData) => void;
} = $props();

let chipMeta = $derived.by(() => {
	const meta = attachmentChipMeta(attachment);
	if (!meta) return null;
	if (meta.key === "composerChips.fileMeta") {
		return $t(meta.key, { pages: meta.pages, tokens: meta.tokens });
	}
	if (meta.key === "composerChips.filePages") {
		return $t(meta.key, { pages: meta.pages });
	}
	return $t(meta.key, { tokens: meta.tokens });
});

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

function fileTypeLabel(filename: string): string {
	const ext = filename.split(".").pop() ?? "";
	return ext && ext !== filename ? ext.toUpperCase() : "";
}

let costLine = $derived.by(() => {
	if (!attachment.tokenEstimate || attachment.tokenEstimate <= 0) return null;
	const parts = [fileTypeLabel(attachment.name)].filter(Boolean);
	if (attachment.pageCount) {
		parts.push($t("attachmentChip.pages", { count: attachment.pageCount }));
	}
	return {
		prefix: parts.join(" · "),
		tokens: $t("attachmentChip.tokensPerTurn", {
			tokens: formatTokenCount(attachment.tokenEstimate),
		}),
	};
});

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

{#if variant === 'chip'}
	<ComposerChip
		kind={attachmentChipKind(attachment)}
		label={attachment.name}
		meta={chipMeta}
		thumbnailUrl={attachmentThumbnailUrl(attachment)}
		size="message"
		removable={removable}
		removeLabel={`Remove ${attachment.name}`}
		onRemove={removable && onRemove ? handleRemove : undefined}
		onActivate={viewable && onView ? handleClick : undefined}
		activateLabel={$t('composerChips.openAttachment', { name: attachment.name })}
		testId="message-attachment-chip"
	/>
{:else}
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
	<span class="file-attachment-text">
		<span class="filename">{attachment.name}</span>
		{#if costLine}
			<span class="file-cost-line" data-testid="file-attachment-cost-line">
				{#if costLine.prefix}<span>{costLine.prefix} · </span>{/if}<span class="file-cost-tokens">{costLine.tokens}</span>
			</span>
		{/if}
	</span>
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
{/if}

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

	.file-attachment-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 1px;
	}

	.file-cost-line {
		font-family: var(--font-sans);
		font-size: 0.7rem;
		line-height: 1.2;
		color: var(--text-muted);
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-cost-tokens {
		color: var(--accent);
		font-weight: 500;
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
