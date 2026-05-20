<script lang="ts">
import { prewarmDocumentPreview } from "$lib/client/document-preview-prewarm";
import { t } from "$lib/i18n";
import type { I18nKey } from "$lib/i18n";
import type {
	DocumentWorkspaceItem,
	FileProductionJob,
	FileProductionJobFile,
} from "$lib/types";
import { formatByteSize } from "$lib/utils/format";

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
}: {
	job: FileProductionJob;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetry?: ((jobId: string) => void) | undefined;
	onCancel?: ((jobId: string) => void) | undefined;
} = $props();

let isActive = $derived(job.status === "queued" || job.status === "running");
let isResolved = $derived(!isActive);

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
	data-testid="file-production-card"
	data-motion={isActive ? 'smooth-shimmer' : undefined}
	aria-busy={isActive}
	aria-label={isActive ? $t('fileProduction.runningDescription') : undefined}
>
	{#if isActive}
		{#if onCancel}
			<button
				type="button"
				class="active-cancel"
				onclick={() => onCancel?.(job.id)}
				aria-label={$t('fileProduction.cancelLabel')}
				title={$t('fileProduction.cancelLabel')}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M18 6 6 18" />
					<path d="m6 6 12 12" />
				</svg>
			</button>
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
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
								<polyline points="7 10 12 15 17 10" />
								<line x1="12" x2="12" y1="15" y2="3" />
							</svg>
						</a>
					</div>
				{/each}
			</div>
		{/if}

		{#if job.status === 'failed' && job.error?.retryable && onRetry}
			<div class="job-actions">
				<button
					type="button"
					class="job-action"
					onclick={() => onRetry?.(job.id)}
					aria-label={$t('fileProduction.retryLabel')}
				>
					{$t('fileProduction.retry')}
				</button>
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

	.file-production-card.is-active::before {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(
			100deg,
			transparent 0%,
			transparent 32%,
			color-mix(in srgb, var(--surface-page) 58%, var(--accent) 42%) 48%,
			transparent 64%,
			transparent 100%
		);
		opacity: 0.72;
		transform: translate3d(-100%, 0, 0);
		animation: file-production-shimmer 1.15s linear infinite;
		will-change: transform;
		pointer-events: none;
	}

	.active-cancel {
		position: absolute;
		top: 0.55rem;
		right: 0.55rem;
		z-index: 1;
		display: inline-flex;
		width: 1.75rem;
		height: 1.75rem;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent 30%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-page) 72%, transparent 28%);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.active-cancel:hover {
		background: color-mix(in srgb, var(--surface-page) 84%, var(--accent) 16%);
		color: var(--text-primary);
	}

	.job-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-md);
		min-width: 0;
	}

	.job-title-group {
		min-width: 0;
	}

	.job-eyebrow {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 76%, var(--text-secondary) 24%);
	}

	.job-title {
		min-width: 0;
		overflow: hidden;
		color: var(--text-primary);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.9rem;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.job-count {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.74rem;
	}

	.job-status-detail {
		color: var(--text-secondary);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.78rem;
		line-height: 1.35;
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
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.82rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-size {
		color: var(--text-muted);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.72rem;
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
		border: 1px solid color-mix(in srgb, var(--border-subtle) 78%, transparent 22%);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-page) 86%, var(--accent) 14%);
		color: var(--text-primary);
		cursor: pointer;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.76rem;
		font-weight: 700;
		padding: 0.36rem 0.55rem;
	}

	.job-action:hover {
		background: color-mix(in srgb, var(--surface-page) 78%, var(--accent) 22%);
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

	@keyframes file-production-shimmer {
		from {
			transform: translate3d(-100%, 0, 0);
		}
		to {
			transform: translate3d(100%, 0, 0);
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

	@media (prefers-reduced-motion: reduce) {
		.file-production-card.is-active,
		.file-production-card.is-resolved .job-header,
		.file-production-card.is-resolved .job-status-detail,
		.file-production-card.is-resolved .produced-files,
		.file-production-card.is-resolved .job-actions {
			animation: none;
		}
	}
</style>
