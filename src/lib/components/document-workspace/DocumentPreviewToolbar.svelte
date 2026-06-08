<script lang="ts">
import { t } from "$lib/i18n";
import { ChevronLeft, ChevronRight } from "@lucide/svelte";

let {
	pageKind = null,
	currentPage = $bindable(1),
	totalPages = 0,
	zoom = null,
	onZoomIn,
	onZoomOut,
	onResetZoom,
	onFit,
}: {
	pageKind?: "page" | "slide" | null;
	currentPage?: number;
	totalPages?: number;
	zoom?: number | null;
	onZoomIn?: () => void;
	onZoomOut?: () => void;
	onResetZoom?: () => void;
	onFit?: () => void;
} = $props();

let pageInputValue = $state(String(currentPage));
let pageInputError = $state(false);

$effect(() => {
	if (!pageInputError) {
		pageInputValue = String(currentPage);
	}
});

let pageLabel = $derived(
	pageKind === "slide"
		? $t("documentWorkspace.slide")
		: $t("documentWorkspace.page"),
);
let previousLabel = $derived(
	pageKind === "slide"
		? $t("documentWorkspace.previousSlide")
		: $t("documentWorkspace.previousPage"),
);
let nextLabel = $derived(
	pageKind === "slide"
		? $t("documentWorkspace.nextSlide")
		: $t("documentWorkspace.nextPage"),
);

function setPage(nextPage: number) {
	if (totalPages <= 0) return;
	currentPage = Math.max(1, Math.min(totalPages, nextPage));
	pageInputValue = String(currentPage);
	pageInputError = false;
}

function handlePageInput(event: Event) {
	pageInputValue = (event.target as HTMLInputElement).value;
	pageInputError = false;
}

function commitPageInput() {
	const page = Number.parseInt(pageInputValue, 10);
	if (Number.isNaN(page) || page < 1 || page > totalPages) {
		pageInputError = true;
		return;
	}
	setPage(page);
}

function handlePageInputKeydown(event: KeyboardEvent) {
	if (event.key !== "Enter") return;
	event.preventDefault();
	commitPageInput();
}
</script>

<div class="preview-toolbar" data-testid="preview-toolbar">
	{#if pageKind && totalPages > 0}
		<div class="preview-toolbar-pages">
			<button
				type="button"
				class="preview-toolbar-button"
				onclick={() => setPage(currentPage - 1)}
				disabled={currentPage <= 1}
				aria-label={previousLabel}
			>
				<ChevronLeft size={15} strokeWidth={2.1} aria-hidden="true" />
			</button>
			<label class="preview-toolbar-page-input-wrap">
				<span>{pageLabel}</span>
				<input
					class:preview-toolbar-input-error={pageInputError}
					class="preview-toolbar-page-input"
					type="text"
					value={pageInputValue}
					oninput={handlePageInput}
					onkeydown={handlePageInputKeydown}
					data-testid="preview-page-input"
					aria-invalid={pageInputError}
				/>
				<span class="preview-toolbar-page-total">{$t('documentWorkspace.pageOf', { total: totalPages })}</span>
			</label>
			<button
				type="button"
				class="preview-toolbar-button"
				onclick={() => setPage(currentPage + 1)}
				disabled={currentPage >= totalPages}
				aria-label={nextLabel}
			>
				<ChevronRight size={15} strokeWidth={2.1} aria-hidden="true" />
			</button>
		</div>
	{/if}

	{#if zoom !== null && onZoomIn && onZoomOut && onResetZoom}
		<div class="preview-toolbar-zoom">
			<button type="button" class="preview-toolbar-button" onclick={onZoomOut} disabled={zoom <= 0.5} aria-label={$t('filePreview.zoomOut')}>-</button>
			<button type="button" class="preview-toolbar-zoom-reset" onclick={onResetZoom} aria-label={$t('filePreview.resetZoom')}>
				{Math.round(zoom * 100)}%
			</button>
			<button type="button" class="preview-toolbar-button" onclick={onZoomIn} disabled={zoom >= 3} aria-label={$t('filePreview.zoomIn')}>+</button>
			{#if onFit}
				<button type="button" class="preview-toolbar-zoom-reset" onclick={onFit} aria-label={$t('documentWorkspace.fitImage')}>
					{$t('documentWorkspace.fit')}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.preview-toolbar {
		position: sticky;
		top: 0;
		z-index: 8;
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.55rem 0.75rem;
		border-bottom: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
		font-family: 'Nimbus Sans L', sans-serif;
	}

	.preview-toolbar-pages,
	.preview-toolbar-zoom,
	.preview-toolbar-page-input-wrap {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}

	.preview-toolbar-page-input-wrap {
		font-size: 0.76rem;
		color: var(--text-secondary);
	}

	.preview-toolbar-button,
	.preview-toolbar-zoom-reset {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.9rem;
		height: 1.9rem;
		border: 1px solid var(--border-default);
		border-radius: 0.4rem;
		background: var(--surface-page);
		color: var(--text-secondary);
		font-size: 0.78rem;
	}

	.preview-toolbar-button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.preview-toolbar-page-input {
		width: 2.8rem;
		height: 1.9rem;
		border: 1px solid var(--border-default);
		border-radius: 0.4rem;
		background: var(--surface-page);
		color: var(--text-primary);
		text-align: center;
		font-size: 0.78rem;
	}

	.preview-toolbar-input-error {
		border-color: var(--danger);
	}

	.preview-toolbar-page-total {
		color: var(--text-muted);
	}

	.preview-toolbar-zoom-reset {
		min-width: 3.6rem;
	}
</style>
