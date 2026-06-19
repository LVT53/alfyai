<script lang="ts">
import {
	Download,
	FileText,
	GitBranch,
	Pencil,
	RefreshCw,
	Square,
} from "@lucide/svelte";
import { t, type I18nKey } from "$lib/i18n";
import type {
	AtlasAction,
	AtlasJobCard,
	AtlasProfile,
	DocumentWorkspaceItem,
} from "$lib/types";

let {
	job,
	onOpenDocument = undefined,
	onCancel = undefined,
	onLifecycleAction = undefined,
}: {
	job: AtlasJobCard;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onCancel?: ((jobId: string) => void) | undefined;
	onLifecycleAction?:
		| ((payload: {
				jobId: string;
				action: AtlasAction;
				message: string;
				profile: AtlasProfile;
		  }) => void)
		| undefined;
} = $props();

let activePanel = $state<AtlasAction | null>(null);
let lifecycleMessage = $state("");

const isActive = $derived(job.status === "queued" || job.status === "running");
const isComplete = $derived(job.status === "succeeded");
const percent = $derived(
	Math.max(0, Math.min(100, Math.round(job.progress?.percent ?? 0))),
);
const profileLabel = $derived(formatProfile(job.profile));
const acceptedSourceCount = $derived(job.sourceCounts.accepted);
const costSummary = $derived(formatCost(job.usage.costUsdMicros));
const durationLabel = $derived(formatDuration(job.createdAt, job.completedAt));
const stageLabel = $derived(formatStage(job.progress?.stage ?? job.stage));
const lifecyclePanelLabel = $derived(
	activePanel ? lifecycleActionLabel(activePanel) : "",
);

const STAGE_LABEL_KEYS: Record<string, I18nKey> = {
	decompose: "atlas.stage.decompose",
	search: "atlas.stage.search",
	curate: "atlas.stage.curate",
	synthesize: "atlas.stage.synthesize",
	integrate: "atlas.stage.integrate",
	assemble: "atlas.stage.assemble",
	audit: "atlas.stage.audit",
};

const STATUS_STAGE_LABEL_KEYS: Record<string, I18nKey> = {
	queued: "atlas.stage.queued",
	failed: "atlas.stage.failed",
	cancelled: "atlas.stage.cancelled",
};

function formatProfile(profile: AtlasProfile): string {
	if (profile === "exhaustive") return $t("composerTools.atlasExhaustive");
	if (profile === "in-depth") return $t("composerTools.atlasInDepth");
	return $t("composerTools.atlasOverview");
}

function formatStage(stage: string | null | undefined): string {
	const stageKey = stage ? STAGE_LABEL_KEYS[stage] : null;
	if (stageKey) return $t(stageKey);
	const statusKey = STATUS_STAGE_LABEL_KEYS[job.status];
	if (statusKey) return $t(statusKey);
	return $t("atlas.stage.running");
}

function formatCost(micros: number): string {
	if (!Number.isFinite(micros) || micros <= 0) return "$0.0000";
	return `$${(micros / 1_000_000).toFixed(4)}`;
}

function formatDuration(start: number, end: number | null | undefined): string {
	if (!end || end <= start) return $t("atlas.durationPending");
	const seconds = Math.max(1, Math.round((end - start) / 1000));
	if (seconds < 60) return $t("atlas.durationSeconds", { seconds });
	return $t("atlas.durationMinutes", { minutes: Math.round(seconds / 60) });
}

function openDocument() {
	const fileId = job.outputs.htmlChatGeneratedFileId;
	if (!fileId || !onOpenDocument) return;
	onOpenDocument({
		id: fileId,
		source: "chat_generated_file",
		filename: `${job.title || "atlas-report"}.html`,
		title: job.title || $t("atlas.defaultTitle"),
		mimeType: "text/html",
		conversationId: job.conversationId,
		downloadUrl: `/api/chat/files/${fileId}/download`,
		previewUrl: `/api/chat/files/${fileId}/preview`,
	});
}

function downloadUrl(fileId: string | null | undefined): string | null {
	return fileId ? `/api/chat/files/${fileId}/download` : null;
}

function lifecycleActionLabel(action: AtlasAction): string {
	if (action === "fork") return $t("atlas.action.fork");
	if (action === "revise") return $t("atlas.action.revise");
	if (action === "continue") return $t("atlas.action.continue");
	return $t("composerTools.atlas");
}

function togglePanel(action: AtlasAction) {
	activePanel = activePanel === action ? null : action;
	lifecycleMessage = "";
}

function submitLifecycleAction() {
	if (!activePanel) return;
	const message = lifecycleMessage.trim();
	if (!message) return;
	onLifecycleAction?.({
		jobId: job.id,
		action: activePanel,
		message,
		profile: job.profile,
	});
	activePanel = null;
	lifecycleMessage = "";
}
</script>

<article
	class="atlas-card"
	class:atlas-card--active={isActive}
	class:atlas-card--complete={isComplete}
	data-testid="atlas-card"
>
	<header class="atlas-card__header">
		<div class="atlas-card__mark" aria-hidden="true">
			<span class="atlas-card__ring"></span>
		</div>
		<div class="atlas-card__title-block">
			<div class="atlas-card__eyebrow">ATLAS</div>
			<h3 class="atlas-card__title">{job.title || $t("atlas.defaultTitle")}</h3>
			<div class="atlas-card__meta">
				<span>{profileLabel}</span>
				{#if isComplete}
					<span>{durationLabel}</span>
					<span>{$t("atlas.sourceCount", { count: acceptedSourceCount })}</span>
					<span>{costSummary}</span>
				{/if}
			</div>
		</div>
		{#if isActive}
			<div class="atlas-card__percent">{percent}%</div>
		{/if}
	</header>

	{#if isActive}
		<div class="atlas-card__progress" aria-label={$t("atlas.progressLabel")}>
			<div class="atlas-card__progress-track">
				<div class="atlas-card__progress-fill" style={`width: ${percent}%`}></div>
			</div>
			<div class="atlas-card__status-row">
				<span>{stageLabel}</span>
				<button
					type="button"
					class="atlas-card__ghost atlas-card__ghost--text"
					onclick={() => onCancel?.(job.id)}
					aria-label={$t("atlas.action.cancel")}
				>
					<Square size={14} strokeWidth={2} aria-hidden="true" />
					<span>{$t("common.cancel")}</span>
				</button>
			</div>
		</div>
	{:else if isComplete}
		<div class="atlas-card__actions">
			<button
				type="button"
				class="atlas-card__open"
				onclick={openDocument}
				disabled={!job.outputs.htmlChatGeneratedFileId}
			>
				{$t("common.open")}
			</button>
			{#if downloadUrl(job.outputs.pdfChatGeneratedFileId)}
				<a
					class="atlas-card__icon-action"
					href={downloadUrl(job.outputs.pdfChatGeneratedFileId)}
					aria-label={$t("atlas.action.downloadPdf")}
					title={$t("atlas.action.downloadPdf")}
				>
					<Download size={16} strokeWidth={2} aria-hidden="true" />
				</a>
			{/if}
			{#if downloadUrl(job.outputs.markdownChatGeneratedFileId)}
				<a
					class="atlas-card__icon-action"
					href={downloadUrl(job.outputs.markdownChatGeneratedFileId)}
					aria-label={$t("atlas.action.downloadMarkdown")}
					title={$t("atlas.action.downloadMarkdown")}
				>
					<FileText size={16} strokeWidth={2} aria-hidden="true" />
				</a>
			{/if}
			<button
				type="button"
				class="atlas-card__icon-action"
				onclick={() => togglePanel('continue')}
				aria-label={$t("atlas.action.continue")}
				title={$t("atlas.action.continue")}
			>
				<RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="atlas-card__icon-action"
				onclick={() => togglePanel('fork')}
				aria-label={$t("atlas.action.fork")}
				title={$t("atlas.action.fork")}
			>
				<GitBranch size={16} strokeWidth={2} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="atlas-card__icon-action"
				onclick={() => togglePanel('revise')}
				aria-label={$t("atlas.action.revise")}
				title={$t("atlas.action.revise")}
			>
				<Pencil size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>

		{#if activePanel}
			<section class="atlas-card__panel" aria-label={lifecyclePanelLabel}>
				<textarea
					bind:value={lifecycleMessage}
					class="atlas-card__panel-input"
					placeholder={$t("atlas.lifecyclePromptPlaceholder")}
					rows="3"
				></textarea>
				<div class="atlas-card__panel-actions">
					<button
						type="button"
						class="atlas-card__ghost"
						onclick={() => activePanel = null}
					>
						{$t("common.cancel")}
					</button>
					<button
						type="button"
						class="atlas-card__icon-action atlas-card__icon-action--primary"
						onclick={submitLifecycleAction}
						disabled={!lifecycleMessage.trim()}
						aria-label={lifecyclePanelLabel}
						title={lifecyclePanelLabel}
					>
						<RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
					</button>
				</div>
			</section>
		{/if}
	{:else}
		<div class="atlas-card__terminal">
			{job.status === "failed" ? $t("atlas.failed") : stageLabel}
		</div>
	{/if}
</article>

<style>
	.atlas-card {
		display: flex;
		width: 100%;
		flex-direction: column;
		gap: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--surface-elevated) 88%, var(--surface-page) 12%);
		padding: 0.9rem;
		font-family: var(--font-sans);
		box-shadow: var(--shadow-sm);
	}

	.atlas-card__header {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
	}

	.atlas-card__mark {
		position: relative;
		display: grid;
		width: 2.25rem;
		height: 2.25rem;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}

	.atlas-card__ring {
		width: 1.35rem;
		height: 1.35rem;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: 999px;
	}

	.atlas-card--active .atlas-card__ring {
		animation: atlas-spin 900ms linear infinite;
	}

	.atlas-card__title-block {
		min-width: 0;
	}

	.atlas-card__eyebrow {
		font-size: var(--text-xs);
		font-weight: 700;
		letter-spacing: 0;
		color: var(--accent);
	}

	.atlas-card__title {
		margin: 0.05rem 0 0;
		overflow-wrap: anywhere;
		font-size: var(--text-md);
		font-weight: 700;
		line-height: 1.25;
		color: var(--text-primary);
	}

	.atlas-card__meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.65rem;
		margin-top: 0.25rem;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.atlas-card__percent {
		font-size: var(--text-sm);
		font-weight: 700;
		color: var(--text-primary);
	}

	.atlas-card__progress {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.atlas-card__progress-track {
		height: 0.45rem;
		overflow: hidden;
		border-radius: 999px;
		background: color-mix(in srgb, var(--border-default) 58%, transparent);
	}

	.atlas-card__progress-fill {
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		transition: width 220ms var(--ease-out);
	}

	.atlas-card__status-row,
	.atlas-card__actions,
	.atlas-card__panel-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.atlas-card__status-row {
		justify-content: space-between;
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.atlas-card__actions {
		flex-wrap: wrap;
	}

	.atlas-card__open,
	.atlas-card__ghost,
	.atlas-card__icon-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--border-default) 84%, transparent);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-primary);
		text-decoration: none;
		cursor: pointer;
	}

	.atlas-card__open {
		min-height: 2.1rem;
		padding: 0 0.8rem;
		background: var(--accent);
		color: var(--text-on-accent, #fff);
		font-size: var(--text-sm);
		font-weight: 700;
	}

	.atlas-card__ghost {
		min-height: 2rem;
		gap: 0.35rem;
		padding: 0 0.65rem;
		font-size: var(--text-sm);
	}

	.atlas-card__icon-action {
		width: 2.1rem;
		height: 2.1rem;
	}

	.atlas-card__icon-action--primary {
		background: var(--accent);
		color: var(--text-on-accent, #fff);
	}

	.atlas-card__open:hover:not(:disabled),
	.atlas-card__ghost:hover:not(:disabled),
	.atlas-card__icon-action:hover:not(:disabled),
	.atlas-card__open:focus-visible,
	.atlas-card__ghost:focus-visible,
	.atlas-card__icon-action:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent);
	}

	.atlas-card__panel {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		border-top: 1px solid color-mix(in srgb, var(--border-default) 70%, transparent);
		padding-top: 0.75rem;
	}

	.atlas-card__panel-input {
		width: 100%;
		resize: vertical;
		border: 1px solid color-mix(in srgb, var(--border-default) 84%, transparent);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		padding: 0.65rem;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
	}

	.atlas-card__panel-input:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent);
	}

	.atlas-card__panel-actions {
		justify-content: flex-end;
	}

	.atlas-card__terminal {
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}

	:global(.dark) .atlas-card {
		background: color-mix(in srgb, var(--surface-page) 88%, #000 12%);
	}

	@keyframes atlas-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.atlas-card--active .atlas-card__ring {
			animation: none;
		}
	}
</style>
