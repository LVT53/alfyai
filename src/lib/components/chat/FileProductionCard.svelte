<script lang="ts">
// The BODY of a file-production activity row. Reduced (unified tool activity
// rows) from the former standalone card: the job's title, its "Created /
// Creating" verb and the produced size now live on the ToolActivityRow above
// it, so this component renders only what goes INSIDE the opened panel —
// the status line, the progress sweep + Stop while producing, the produced
// file rows with Open/Download, and the failure reason with Retry/Dismiss.
//
// While a job is producing, its row is pinned open (see
// `buildFileProductionActivityItem`'s `alwaysOpen`), so row and body share one
// background and read as a single element.
import { Download, FileText, RotateCw, Square, X } from "@lucide/svelte";
import { prewarmDocumentPreview } from "$lib/client/document-preview-prewarm";
import { t } from "$lib/i18n";
import type { I18nKey } from "$lib/i18n";
import type {
	FileProductionJob,
	FileProductionJobFile,
} from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { formatByteSize } from "$lib/utils/format";
import {
	formatElapsed,
	isPendingFileProductionJobId,
	isStaleJob,
} from "./file-production-helpers";

const ERROR_MESSAGE_KEYS: Partial<Record<string, I18nKey>> = {
	too_many_outputs: "fileProduction.error.too_many_outputs",
	source_too_large: "fileProduction.error.source_too_large",
	projection_too_large: "fileProduction.error.projection_too_large",
	page_limit_exceeded: "fileProduction.error.page_limit_exceeded",
	table_limit_exceeded: "fileProduction.error.table_limit_exceeded",
	chart_limit_exceeded: "fileProduction.error.chart_limit_exceeded",
	image_limit_exceeded: "fileProduction.error.image_limit_exceeded",
	renderer_timeout: "fileProduction.error.renderer_timeout",
	sandbox_timeout: "fileProduction.error.sandbox_timeout",
	invalid_document_source: "fileProduction.error.invalid_document_source",
	unsupported_document_block: "fileProduction.error.unsupported_document_block",
	unsupported_table_structure:
		"fileProduction.error.unsupported_table_structure",
	unsupported_chart_type: "fileProduction.error.unsupported_chart_type",
	unsupported_chart_data: "fileProduction.error.unsupported_chart_data",
	unsupported_pdf_block: "fileProduction.error.unsupported_pdf_block",
	unsupported_output_type: "fileProduction.error.unsupported_output_type",
	pdf_font_missing: "fileProduction.error.pdf_font_missing",
	document_render_failed: "fileProduction.error.document_render_failed",
	output_file_too_large: "fileProduction.error.output_file_too_large",
	job_outputs_too_large: "fileProduction.error.job_outputs_too_large",
	// Item 6 (UX-speed plan) — set on a placeholder card when its
	// produce_file tool call fails before a real job ever gets queued (see
	// buildPendingFileProductionJobPlaceholder / failPendingFileProduction-
	// JobPlaceholder in ../../../routes/(app)/chat/[conversationId]/_helpers).
	tool_failed: "fileProduction.error.tool_failed",
};

let {
	job,
	onOpenDocument = undefined,
	onRetry = undefined,
	onCancel = undefined,
	onDismiss = undefined,
}: {
	job: FileProductionJob;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetry?: ((jobId: string) => void) | undefined;
	onCancel?: ((jobId: string) => void) | undefined;
	onDismiss?: ((jobId: string) => void) | undefined;
} = $props();

let isActive = $derived(job.status === "queued" || job.status === "running");

// Client-side elapsed timer for the active state. Ticks once per second; the
// "Producing · m:ss" copy derives from this. Reduced-motion is honored via
// CSS (static sweep) — the value still advances.
let nowMs = $state(Date.now());
$effect(() => {
	if (!isActive) return;
	const interval = window.setInterval(() => {
		nowMs = Date.now();
	}, 1000);
	return () => window.clearInterval(interval);
});

let elapsedLabel = $derived(formatElapsed(job.createdAt, nowMs));
// Pure client heuristic (ADR-0043 Slice 4): a queued/running job older than
// 90s shifts to the amber "stale" honesty state instead of pretending.
let isStale = $derived(isActive && isStaleJob(job.createdAt, nowMs));

let isError = $derived(job.status === "failed" || job.status === "cancelled");
let errorIsRetryable = $derived(
	job.status === "failed" && job.error?.retryable === true,
);
// Item 6 (UX-speed plan) — a placeholder card has no server-side job behind
// it yet, so retry/cancel/dismiss must never reach the server with its
// made-up id.
let isPlaceholder = $derived(isPendingFileProductionJobId(job.id));
let canDismiss = $derived(
	isError && onDismiss && !errorIsRetryable && !isPlaceholder,
);

function statusDescription(job: FileProductionJob): string | null {
	if (job.error?.message) {
		const key = ERROR_MESSAGE_KEYS[job.error.code];
		return key ? $t(key) : job.error.message;
	}
	switch (job.status) {
		case "queued":
			return $t("fileProduction.queuedDescription");
		case "running":
			return $t("fileProduction.runningDescription");
		case "failed":
			return $t("fileProduction.failedDescription");
		case "cancelled":
			return $t("fileProduction.cancelledDescription");
		default:
			return null;
	}
}

function openFile(file: FileProductionJobFile) {
	if (!onOpenDocument || !file.previewUrl) return;
	onOpenDocument({
		id: file.id,
		source: "chat_generated_file",
		filename: file.filename,
		title: file.documentLabel ?? file.filename,
		documentFamilyId: file.documentFamilyId ?? null,
		documentFamilyStatus: file.documentFamilyStatus ?? null,
		documentLabel: file.documentLabel ?? null,
		documentRole: file.documentRole ?? null,
		versionNumber: file.versionNumber ?? 1,
		originConversationId: file.originConversationId ?? job.conversationId,
		originAssistantMessageId:
			file.originAssistantMessageId ?? job.assistantMessageId ?? null,
		sourceChatFileId: file.sourceChatFileId ?? file.id,
		mimeType: file.mimeType,
		previewUrl: file.previewUrl,
		artifactId: file.artifactId ?? null,
		conversationId: job.conversationId,
		downloadUrl: file.downloadUrl,
	});
}

function handlePreviewIntent(file: FileProductionJobFile) {
	void prewarmDocumentPreview(file);
}
</script>

{#snippet producedFiles()}
	{#if job.files.length > 0}
		<div class="produced-files" data-testid="file-production-files">
			{#each job.files as file (file.id)}
				<div class="file-row">
					<FileText class="file-row-icon" size={14} strokeWidth={2} aria-hidden="true" />
					<span class="file-name" title={file.filename}>{file.filename}</span>
					<span class="file-size">{formatByteSize(file.sizeBytes, { trimWholeUnits: true })}</span>
					<span class="file-actions">
						<button
							type="button"
							class="mini-btn"
							disabled={!file.previewUrl}
							onclick={() => openFile(file)}
							onpointerenter={() => handlePreviewIntent(file)}
							onfocus={() => handlePreviewIntent(file)}
							aria-label={$t('fileProduction.previewLabel', { filename: file.filename })}
						>
							{$t('fileProduction.open')}
						</button>
						<a
							class="mini-btn"
							href={file.downloadUrl}
							download={file.filename}
							aria-label={$t('fileProduction.downloadLabel', { filename: file.filename })}
							title={$t('fileProduction.downloadLabel', { filename: file.filename })}
						>
							<Download size={13} strokeWidth={2} aria-hidden="true" />
						</a>
					</span>
				</div>
			{/each}
		</div>
	{/if}
{/snippet}

<div
	class="file-job-body"
	class:is-active={isActive}
	data-testid="file-production-card"
	data-motion={isActive ? 'producing-sweep' : undefined}
	aria-busy={isActive}
>
	{#if isActive}
		<div class="job-line">
			{#if isStale}
				<span class="job-stale">{$t('fileProduction.staleHeading')}</span>
				<span>{$t('fileProduction.staleDescription')}</span>
			{:else}
				<span>{$t('fileProduction.runningDescription')}</span>
				<span aria-hidden="true">·</span>
				<span class="job-elapsed" data-testid="file-production-elapsed">{elapsedLabel}</span>
			{/if}
		</div>
		<div class="track" class:is-stale-track={isStale} aria-hidden="true">
			{#if !isStale}<i></i>{/if}
		</div>
		{#if onCancel && !isPlaceholder}
			<div class="job-actions">
				<button
					type="button"
					class="mini-btn"
					onclick={() => onCancel?.(job.id)}
					title={$t('fileProduction.stopLabel')}
					aria-label={$t('fileProduction.stopLabel')}
				>
					<Square size={12} strokeWidth={2} aria-hidden="true" />
					{$t('fileProduction.stop')}
				</button>
			</div>
		{/if}
	{:else if isError}
		{#if statusDescription(job)}
			<div class="job-error">{statusDescription(job)}</div>
		{/if}
		{#if !errorIsRetryable}
			<div class="job-suggestion">{$t('fileProduction.suggestion')}</div>
		{/if}
		{@render producedFiles()}
		{#if (errorIsRetryable && onRetry && !isPlaceholder) || canDismiss}
			<div class="job-actions">
				{#if errorIsRetryable && onRetry && !isPlaceholder}
					<button type="button" class="mini-btn" onclick={() => onRetry?.(job.id)}>
						<RotateCw size={12} strokeWidth={2} aria-hidden="true" />
						{$t('fileProduction.retry')}
					</button>
				{/if}
				{#if canDismiss}
					<button
						type="button"
						class="mini-btn"
						onclick={() => onDismiss?.(job.id)}
						aria-label={$t('fileProduction.dismissLabel')}
					>
						<X size={12} strokeWidth={2} aria-hidden="true" />
						{$t('fileProduction.dismiss')}
					</button>
				{/if}
			</div>
		{/if}
	{:else}
		{@render producedFiles()}
	{/if}
</div>

<style>
	.file-job-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
		min-width: 0;
	}

	.job-line {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		color: var(--text-muted);
		line-height: 1.45;
	}

	.job-elapsed {
		font-variant-numeric: tabular-nums;
	}

	.job-stale {
		color: var(--warning);
		font-weight: 600;
	}

	.job-error {
		color: var(--danger);
		line-height: 1.45;
	}

	.job-suggestion {
		color: var(--text-muted);
		line-height: 1.45;
	}

	/* The progress sweep — the mockup's 3px track with a 40% accent runner. */
	.track {
		position: relative;
		height: 3px;
		margin: 2px 0;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-muted) 18%, transparent);
		overflow: hidden;
	}

	.track i {
		position: absolute;
		top: 0;
		left: 0;
		width: 40%;
		height: 100%;
		border-radius: 999px;
		background: var(--accent);
		animation: file-job-sweep 1.6s ease-in-out infinite;
	}

	.track.is-stale-track {
		background: color-mix(in srgb, var(--warning) 50%, transparent);
	}

	@keyframes file-job-sweep {
		0% {
			left: -40%;
		}
		100% {
			left: 100%;
		}
	}

	.produced-files {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.file-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		margin: 0 -6px;
		padding: 4px 6px;
		border-radius: 5px;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.file-row:hover {
		background: var(--surface-overlay);
	}

	:global(.file-row-icon) {
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		color: var(--text-muted);
		opacity: 0.85;
	}

	.file-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.file-size {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.file-actions {
		margin-left: auto;
		display: inline-flex;
		gap: 2px;
	}

	.job-actions {
		display: flex;
		justify-content: flex-end;
		gap: 4px;
	}

	.mini-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 24px;
		padding: 0 8px;
		border: 1px solid var(--border-default);
		border-radius: 5px;
		background: var(--surface-page);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.72rem;
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.mini-btn:hover:not(:disabled) {
		background: var(--surface-overlay);
		color: var(--text-primary);
	}

	.mini-btn:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.mini-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* Reduced-motion (HARD requirement): a static centered runner, no sweep. */
	@media (prefers-reduced-motion: reduce) {
		.track i {
			animation: none;
			left: 30%;
		}
	}
</style>
