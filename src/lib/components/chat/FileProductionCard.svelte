<script lang="ts">
import { Download, LoaderCircle, RotateCw, Square, X } from "@lucide/svelte";
import { prewarmDocumentPreview } from "$lib/client/document-preview-prewarm";
import { t } from "$lib/i18n";
import type { I18nKey } from "$lib/i18n";
import type {
	DocumentWorkspaceItem,
	FileProductionJob,
	FileProductionJobFile,
} from "$lib/types";
import { formatByteSize } from "$lib/utils/format";
import { formatElapsed, isStaleJob } from "./file-production-helpers";

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
let isResolved = $derived(!isActive);

// Client-side elapsed timer for the active state. Ticks once per second; the
// producing bar + "Producing · m:ss" copy derive from this. Reduced-motion is
// honored via CSS (no spin, static sweep) — the value still advances.
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
let canDismiss = $derived(isError && onDismiss && !errorIsRetryable);

function fileCountLabel(count: number): string {
	if (count === 0) {
		return $t("fileProduction.noFiles");
	}
	return count === 1
		? $t("fileProduction.oneFile")
		: $t("fileProduction.fileCount", { count });
}

function statusLabel(status: FileProductionJob["status"]): string {
	switch (status) {
		case "queued":
			return $t("fileProduction.queued");
		case "running":
			return $t("fileProduction.running");
		case "failed":
			return $t("fileProduction.failed");
		case "cancelled":
			return $t("fileProduction.cancelled");
		default:
			return $t("fileProduction.ready");
	}
}

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

<div
	class="file-production-card"
	class:is-active={isActive}
	class:is-resolved={isResolved}
	class:is-stale={isStale}
	data-testid="file-production-card"
	data-motion={isActive ? 'producing-sweep' : undefined}
	aria-busy={isActive}
	aria-label={isActive ? $t('fileProduction.runningDescription') : undefined}
>
	{#if isActive}
		<div class="active-body">
			<div class="active-icon" aria-hidden="true">
				<LoaderCircle size={16} strokeWidth={2} aria-hidden="true" />
			</div>
			<div class="active-text">
				<div class="active-title" title={job.title}>{job.title}</div>
				<div class="active-meta">
					{#if isStale}
						<span class="active-stale-heading">{$t('fileProduction.staleHeading')}</span>
						<span class="active-stale-desc">{$t('fileProduction.staleDescription')}</span>
					{:else}
						<span class="active-producing">{$t('fileProduction.producing')}</span>
						<span class="active-elapsed" data-testid="file-production-elapsed">·</span>
						<span class="active-elapsed active-elapsed-time">{elapsedLabel}</span>
					{/if}
				</div>
			</div>
			{#if onCancel}
				<button
					type="button"
					class="active-stop btn-icon-bare"
					onclick={() => onCancel?.(job.id)}
					aria-label={$t('fileProduction.stopLabel')}
					title={$t('fileProduction.stopLabel')}
				>
					<Square size={16} strokeWidth={2} aria-hidden="true" />
				</button>
			{/if}
		</div>
		{#if isStale}
			<!-- Amber honesty bar: a static (reduced-motion-safe) amber track. -->
			<div class="producing-progress-track is-stale-track" aria-hidden="true"></div>
		{:else}
			<!-- Gold gradient sweep bar — reuses the compaction sweep motion (ADR-0043). -->
			<div class="producing-progress-sweep" aria-hidden="true">
				<span class="producing-progress-sweep-fill"></span>
			</div>
		{/if}
	{:else if isError}
		<div class="job-header job-header--error">
			<div class="job-title-group">
				<div class="job-eyebrow job-eyebrow--error">
					{job.status === 'cancelled'
						? $t('fileProduction.cancelled')
						: $t('fileProduction.couldNotProduce')}
				</div>
				{#if job.title}
					<div class="job-title" title={job.title}>{job.title}</div>
				{/if}
			</div>
			{#if canDismiss}
				<button
					type="button"
					class="job-dismiss btn-icon-bare"
					onclick={() => onDismiss?.(job.id)}
					aria-label={$t('fileProduction.dismissLabel')}
					title={$t('fileProduction.dismissLabel')}
				>
					<X size={16} strokeWidth={2} aria-hidden="true" />
				</button>
			{/if}
		</div>

		{#if statusDescription(job)}
			<div class="job-status-detail">{statusDescription(job)}</div>
		{/if}

		{#if !errorIsRetryable}
			<div class="job-suggestion">{$t('fileProduction.suggestion')}</div>
		{/if}

		{#if job.files.length > 0}
			<div class="produced-files" data-testid="file-production-files">
				{#each job.files as file (file.id)}
					<div class="produced-file-row">
						<button
							type="button"
							class="file-open"
							disabled={!file.previewUrl}
							onclick={() => openFile(file)}
							onpointerenter={() => handlePreviewIntent(file)}
							onfocus={() => handlePreviewIntent(file)}
							aria-label={$t('fileProduction.previewLabel', { filename: file.filename })}
						>
							<span class="file-name" title={file.filename}>{file.filename}</span>
							<span class="file-size">{formatByteSize(file.sizeBytes)}</span>
						</button>
						<a
							class="file-download"
							href={file.downloadUrl}
							download={file.filename}
							aria-label={$t('fileProduction.downloadLabel', { filename: file.filename })}
							title={$t('fileProduction.downloadLabel', { filename: file.filename })}
						>
						<Download size={16} strokeWidth={2} aria-hidden="true" />
						</a>
					</div>
				{/each}
			</div>
		{/if}

		{#if errorIsRetryable && onRetry}
			<div class="job-actions">
				<button
					type="button"
					class="job-action"
					onclick={() => onRetry?.(job.id)}
				>
					<RotateCw size={14} strokeWidth={2} aria-hidden="true" />
					<span>{$t('fileProduction.retry')}</span>
				</button>
			</div>
		{/if}
	{:else}
		<div class="job-header">
			<div class="job-title-group">
				<div class="job-eyebrow">{statusLabel(job.status)}</div>
				<div class="job-title" title={job.title}>{job.title}</div>
			</div>
			<div class="job-count">{fileCountLabel(job.files.length)}</div>
		</div>

		{#if statusDescription(job)}
			<div class="job-status-detail">{statusDescription(job)}</div>
		{/if}

		{#if job.files.length > 0}
			<div class="produced-files" data-testid="file-production-files">
				{#each job.files as file (file.id)}
					<div class="produced-file-row">
						<button
							type="button"
							class="file-open"
							disabled={!file.previewUrl}
							onclick={() => openFile(file)}
							onpointerenter={() => handlePreviewIntent(file)}
							onfocus={() => handlePreviewIntent(file)}
							aria-label={$t('fileProduction.previewLabel', { filename: file.filename })}
						>
							<span class="file-name" title={file.filename}>{file.filename}</span>
							<span class="file-size">{formatByteSize(file.sizeBytes)}</span>
						</button>
						<a
							class="file-download"
							href={file.downloadUrl}
							download={file.filename}
							aria-label={$t('fileProduction.downloadLabel', { filename: file.filename })}
							title={$t('fileProduction.downloadLabel', { filename: file.filename })}
						>
						<Download size={16} strokeWidth={2} aria-hidden="true" />
						</a>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.file-production-card {
		display: flex;
		position: relative;
		width: 100%;
		max-width: 100%;
		min-height: 4.75rem;
		flex-direction: column;
		gap: var(--space-sm);
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 78%, transparent 22%);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--surface-elevated) 60%, transparent 40%);
		padding: 0.75rem;
	}

	.file-production-card.is-active {
		background: color-mix(in srgb, var(--surface-elevated) 68%, var(--surface-page) 32%);
		border-color: color-mix(in srgb, var(--border-subtle) 70%, var(--accent) 30%);
	}

	/* Running body: icon + title/meta + Stop. */
	.active-body {
		display: flex;
		align-items: flex-start;
		gap: 0.55rem;
		position: relative;
		z-index: 1;
	}

	.active-icon {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.625rem;
		height: 1.625rem;
		margin-top: 0.0625rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent) 15%, transparent 85%);
		color: var(--accent);
		animation: file-production-spin 1s linear infinite;
	}

	.active-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.active-title {
		min-width: 0;
		overflow: hidden;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.active-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-top: 0.125rem;
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		line-height: 1.4;
	}

	.active-producing {
		color: color-mix(in srgb, var(--accent) 80%, var(--text-secondary) 20%);
		font-weight: 600;
	}

	.active-elapsed {
		color: var(--text-muted);
	}

	.active-elapsed-time {
		font-variant-numeric: tabular-nums;
	}

	/* Stale honesty state: amber accent. */
	.file-production-card.is-stale {
		border-color: color-mix(in srgb, var(--border-subtle) 62%, var(--warning) 38%);
	}

	.is-stale .active-icon {
		background: color-mix(in srgb, var(--warning) 16%, transparent 84%);
		color: var(--warning);
		animation: none;
	}

	.active-stale-heading {
		color: var(--warning);
		font-weight: 700;
	}

	.active-stale-desc {
		color: var(--text-secondary);
	}

	.active-stop {
		flex: 0 0 auto;
		color: var(--text-secondary);
	}

	/* Gold gradient-sweep progress bar — reuses the compaction motion (Slice 19):
	   same gold #B8945F, same track/sweep-fill structure, same 1.6s sweep. */
	.producing-progress-sweep {
		position: relative;
		flex: 1 1 auto;
		width: 100%;
		height: 3px;
		overflow: hidden;
		border-radius: 999px;
		background: color-mix(in srgb, #b8945f 18%, transparent 82%);
	}

	.producing-progress-sweep-fill {
		position: absolute;
		top: 0;
		left: 0;
		width: 25%;
		height: 100%;
		border-radius: 999px;
		background: #b8945f;
		animation: producing-progress-bar-sweep 1.6s ease-in-out infinite;
	}

	@keyframes producing-progress-bar-sweep {
		0% {
			left: -25%;
		}
		100% {
			left: 100%;
		}
	}

	/* Amber honesty track (static). */
	.producing-progress-track.is-stale-track {
		width: 100%;
		height: 3px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--warning) 50%, transparent 50%);
	}

	.job-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-md);
		min-width: 0;
	}

	.job-header--error {
		align-items: flex-start;
	}

	.job-title-group {
		min-width: 0;
	}

	.job-eyebrow {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 700;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 76%, var(--text-secondary) 24%);
	}

	.job-eyebrow--error {
		color: var(--danger);
	}

	.job-title {
		min-width: 0;
		overflow: hidden;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-md);
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.job-count {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
	}

	.job-status-detail {
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.35;
	}

	.job-suggestion {
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		line-height: 1.4;
	}

	.produced-files {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.produced-file-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-sm);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-page) 70%, transparent 30%);
		padding: 0.45rem 0.5rem;
	}

	.file-open {
		display: grid;
		min-width: 0;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--space-sm);
		border: 0;
		background: transparent;
		padding: 0;
		text-align: left;
	}

	.file-open:not(:disabled) {
		cursor: pointer;
	}

	.file-open:disabled {
		cursor: default;
	}

	.file-name {
		min-width: 0;
		overflow: hidden;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-size {
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
	}

	.file-download {
		display: inline-flex;
		width: 30px;
		height: 30px;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent 28%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 9%, var(--surface-page) 91%);
		color: color-mix(in srgb, var(--accent) 66%, var(--text-primary) 34%);
		text-decoration: none;
	}

	.file-download:hover {
		background: color-mix(in srgb, var(--accent) 15%, var(--surface-page) 85%);
	}

	.job-actions {
		display: flex;
		justify-content: flex-end;
	}

	.job-action {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 44px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 78%, transparent 22%);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-page) 86%, var(--accent) 14%);
		color: var(--text-primary);
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 700;
		padding: 0.5rem 0.7rem;
	}

	.job-action:hover {
		background: color-mix(in srgb, var(--surface-page) 78%, var(--accent) 22%);
	}

	/* ≥44px touch targets for the active Stop and failed Dismiss icon buttons
	   (btn-icon-bare gives 40px min; the producing card widens to 44px). */
	.active-stop,
	.job-dismiss {
		min-width: 44px;
		min-height: 44px;
		width: 44px;
		height: 44px;
	}

	.file-production-card.is-resolved .job-header,
	.file-production-card.is-resolved .job-status-detail,
	.file-production-card.is-resolved .produced-files,
	.file-production-card.is-resolved .job-actions {
		animation: file-production-reveal 260ms ease-out both;
	}

	.file-production-card.is-resolved .job-status-detail {
		animation-delay: 70ms;
	}

	.file-production-card.is-resolved .produced-files,
	.file-production-card.is-resolved .job-actions {
		animation-delay: 140ms;
	}

	@keyframes file-production-spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes file-production-reveal {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* Reduced-motion (HARD requirement): static bar, no spinner spin, no sweep.
	   The global override in app.css already collapses durations to ~0ms, but we
	   also explicitly stop the spin + sweep here so the intent is unambiguous. */
	@media (prefers-reduced-motion: reduce) {
		.active-icon {
			animation: none;
		}

		.producing-progress-sweep-fill {
			animation: none;
			/* Show a static centered gold segment instead of a frozen off-screen fill. */
			left: 37.5%;
			width: 25%;
		}

		.file-production-card.is-resolved .job-header,
		.file-production-card.is-resolved .job-status-detail,
		.file-production-card.is-resolved .produced-files,
		.file-production-card.is-resolved .job-actions {
			animation: none;
		}
	}
</style>
