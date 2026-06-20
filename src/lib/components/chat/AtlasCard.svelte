<script lang="ts">
import {
	Check,
	ChevronDown,
	Download,
	FileText,
	GitBranch,
	Pencil,
	RefreshCw,
	Square,
} from "@lucide/svelte";
import { fade } from "svelte/transition";
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
	onOpenDocument?:
		| ((
				document: DocumentWorkspaceItem,
				options?: {
					preservePresentation?: boolean;
					presentation?: "docked" | "expanded";
				},
		  ) => void)
		| undefined;
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
let downloadMenuOpen = $state(false);
let lifecycleMessage = $state("");
let progressMessageIndex = $state(0);
let lastProgressMessageStage = $state("");

const isActive = $derived(job.status === "queued" || job.status === "running");
const isComplete = $derived(job.status === "succeeded");
const profileLabel = $derived(formatProfile(job.profile));
const acceptedSourceCount = $derived(job.sourceCounts.accepted);
const costSummary = $derived(formatCost(job.usage.costUsdMicros));
const durationLabel = $derived(formatDuration(job.createdAt, job.completedAt));
const stageLabel = $derived(formatStage(job.progress?.stage ?? job.stage));
const progressMessageStage = $derived(
	`${job.status}:${job.progress?.stage ?? job.stage ?? ""}`,
);
const progressMessageKeys = $derived(
	getProgressMessageKeys(job.status, job.progress?.stage ?? job.stage),
);
const progressMessage = $derived(
	formatProgressMessage(progressMessageKeys, progressMessageIndex),
);
const progressQueries = $derived(job.progress?.details?.queries ?? []);
const lifecyclePanelLabel = $derived(
	activePanel ? lifecycleActionLabel(activePanel) : "",
);
const progressPercent = $derived(
	Math.max(0, Math.min(100, Math.round(job.progress?.percent ?? 0))),
);
const downloadOptions = $derived(getDownloadOptions(job.outputs));

const PROGRESS_MESSAGE_INTERVAL_MS = 4200;
const PROGRESS_MESSAGE_FADE_MS = 220;

const STAGE_LABEL_KEYS: Record<string, I18nKey> = {
	decompose: "atlas.stage.decompose",
	search: "atlas.stage.search",
	curate: "atlas.stage.curate",
	synthesize: "atlas.stage.synthesize",
	integrate: "atlas.stage.integrate",
	assemble: "atlas.stage.assemble",
	audit: "atlas.stage.audit",
	render: "atlas.stage.render",
};

const STATUS_STAGE_LABEL_KEYS: Record<string, I18nKey> = {
	queued: "atlas.stage.queued",
	failed: "atlas.stage.failed",
	cancelled: "atlas.stage.cancelled",
};

const PROGRESS_MESSAGE_KEYS: Record<string, readonly I18nKey[]> = {
	queued: ["atlas.progress.queued.0", "atlas.progress.queued.1"],
	decompose: ["atlas.progress.decompose.0", "atlas.progress.decompose.1"],
	search: ["atlas.progress.search.0", "atlas.progress.search.1"],
	curate: ["atlas.progress.curate.0", "atlas.progress.curate.1"],
	synthesize: ["atlas.progress.synthesize.0", "atlas.progress.synthesize.1"],
	integrate: ["atlas.progress.integrate.0", "atlas.progress.integrate.1"],
	assemble: ["atlas.progress.assemble.0", "atlas.progress.assemble.1"],
	audit: ["atlas.progress.audit.0", "atlas.progress.audit.1"],
	render: ["atlas.progress.render.0", "atlas.progress.render.1"],
};

type DownloadOption = {
	key: "html" | "pdf" | "markdown";
	label: string;
	url: string;
};

$effect(() => {
	if (progressMessageStage !== lastProgressMessageStage) {
		lastProgressMessageStage = progressMessageStage;
		progressMessageIndex = 0;
	}
});

$effect(() => {
	if (
		!isActive ||
		progressMessageKeys.length < 2 ||
		typeof window === "undefined"
	) {
		return;
	}
	const interval = window.setInterval(() => {
		progressMessageIndex =
			(progressMessageIndex + 1) % progressMessageKeys.length;
	}, PROGRESS_MESSAGE_INTERVAL_MS);
	return () => window.clearInterval(interval);
});

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

function getProgressMessageKeys(
	status: AtlasJobCard["status"],
	stage: string | null | undefined,
): readonly I18nKey[] {
	if (status === "queued") return PROGRESS_MESSAGE_KEYS.queued;
	if (stage && PROGRESS_MESSAGE_KEYS[stage])
		return PROGRESS_MESSAGE_KEYS[stage];
	return ["atlas.stage.running", "atlas.progress.running.1"];
}

function formatProgressMessage(
	keys: readonly I18nKey[],
	index: number,
): string {
	const key = keys[index % keys.length] ?? "atlas.stage.running";
	return $t(key);
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
	onOpenDocument(
		{
			id: fileId,
			source: "chat_generated_file",
			filename: `${job.title || "atlas-report"}.html`,
			title: job.title || $t("atlas.defaultTitle"),
			mimeType: "text/html",
			conversationId: job.conversationId,
			downloadUrl: `/api/chat/files/${fileId}/download`,
			previewUrl: `/api/chat/files/${fileId}/preview`,
		},
		{ presentation: "expanded" },
	);
}

function downloadUrl(fileId: string | null | undefined): string | null {
	return fileId ? `/api/chat/files/${fileId}/download` : null;
}

function getDownloadOptions(
	outputs: AtlasJobCard["outputs"],
): DownloadOption[] {
	const options: DownloadOption[] = [];
	const htmlUrl = downloadUrl(outputs.htmlChatGeneratedFileId);
	const pdfUrl = downloadUrl(outputs.pdfChatGeneratedFileId);
	const markdownUrl = downloadUrl(outputs.markdownChatGeneratedFileId);
	if (htmlUrl) {
		options.push({
			key: "html",
			label: $t("atlas.action.downloadHtml"),
			url: htmlUrl,
		});
	}
	if (pdfUrl) {
		options.push({
			key: "pdf",
			label: $t("atlas.action.downloadPdf"),
			url: pdfUrl,
		});
	}
	if (markdownUrl) {
		options.push({
			key: "markdown",
			label: $t("atlas.action.downloadMarkdown"),
			url: markdownUrl,
		});
	}
	return options;
}

function lifecycleActionLabel(action: AtlasAction): string {
	if (action === "fork") return $t("atlas.action.fork");
	if (action === "revise") return $t("atlas.action.revise");
	if (action === "continue") return $t("atlas.action.continue");
	return $t("composerTools.atlas");
}

function togglePanel(action: AtlasAction) {
	activePanel = activePanel === action ? null : action;
	downloadMenuOpen = false;
	lifecycleMessage = "";
}

function toggleDownloadMenu() {
	downloadMenuOpen = !downloadMenuOpen;
	activePanel = null;
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
	class:atlas-card--completion-enter={isComplete}
	data-testid="atlas-card"
>
	<header class="atlas-card__header">
		<div
			class="atlas-card__mark"
			class:atlas-card__mark--queued={job.status === "queued"}
			class:atlas-card__mark--complete={isComplete}
			data-testid={isComplete ? "atlas-completion-icon" : undefined}
			aria-hidden="true"
		>
			{#if isComplete}
				<Check size={19} strokeWidth={2.4} aria-hidden="true" />
			{:else if job.status === "queued"}
				<svg
					class="atlas-card__exploration-svg"
					data-testid="atlas-exploration-svg"
					viewBox="0 0 56 56"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<g class="orbit-group">
						<circle cx="28" cy="28" r="22" opacity="0.25"></circle>
						<g transform="translate(28, 6)">
							<path
								d="M-5 -2 L4 0 L-5 2 Z"
								fill="currentColor"
								stroke="none"
							></path>
							<line x1="-9" y1="0" x2="-5" y2="0" opacity="0.5"></line>
						</g>
					</g>
					<circle cx="28" cy="28" r="15" stroke-width="2"></circle>
					<path d="M14 28 Q28 35 42 28" opacity="0.5"></path>
					<path d="M14 28 Q28 21 42 28" opacity="0.5"></path>
					<path d="M28 14 Q35 28 28 42" opacity="0.5"></path>
					<path d="M28 14 Q21 28 28 42" opacity="0.5"></path>
					<path
						d="M21 25 Q25 23 29 27 Q27 31 23 31 Z"
						fill="currentColor"
						opacity="0.35"
						stroke="none"
					></path>
					<path
						d="M33 20 Q37 22 35 28 Q31 26 33 20 Z"
						fill="currentColor"
						opacity="0.35"
						stroke="none"
					></path>
				</svg>
			{:else}
				<svg
					class="atlas-card__ring atlas-card__progress-cycle"
					data-testid="atlas-progress-cycle-icon"
					viewBox="0 0 56 56"
					fill="none"
					aria-hidden="true"
					style={`--atlas-progress: ${progressPercent}%;`}
				>
					<circle
						class="atlas-card__progress-cycle-track"
						cx="28"
						cy="28"
						r="22"
						pathLength="100"
					></circle>
					<circle
						class="atlas-card__progress-cycle-fill"
						cx="28"
						cy="28"
						r="22"
						pathLength="100"
						stroke-dasharray="100"
						style={`--atlas-progress: ${progressPercent}%; stroke-dashoffset: ${100 - progressPercent};`}
					></circle>
					<g class="atlas-card__progress-cycle-sweep">
						<path
							d="M28 4.5 L32.8 12.4 L28 10.7 L23.2 12.4 Z"
							fill="currentColor"
							stroke="none"
						></path>
					</g>
				</svg>
			{/if}
		</div>
		<div class="atlas-card__title-block">
			<div class="atlas-card__eyebrow">ATLAS</div>
			<h3 class="atlas-card__title">{job.title || $t("atlas.defaultTitle")}</h3>
			{#if isComplete}
				<div class="atlas-card__meta">
					<span>{profileLabel}</span>
					<span>{durationLabel}</span>
					<span>{$t("atlas.sourceCount", { count: acceptedSourceCount })}</span>
					<span>{costSummary}</span>
				</div>
			{/if}
		</div>
	</header>

	{#if isActive}
		<div class="atlas-card__progress" aria-label={$t("atlas.progressLabel")}>
			<div class="atlas-card__status-row">
				<span class="atlas-card__status-message-wrap" aria-live="polite">
					{#key progressMessage}
						<span
							class="atlas-card__status-message"
							transition:fade={{ duration: PROGRESS_MESSAGE_FADE_MS }}
						>
							{progressMessage}
						</span>
					{/key}
				</span>
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
			{#if progressQueries.length > 0}
				<div class="atlas-card__queries" aria-label={$t("atlas.progressQueriesLabel")}>
					<div class="atlas-card__queries-title">{$t("atlas.progressQueriesTitle")}</div>
					<ul>
						{#each progressQueries as query}
							<li>{query}</li>
						{/each}
					</ul>
				</div>
			{/if}
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
			{#if downloadOptions.length > 0}
				<div class="atlas-card__download">
					<button
						type="button"
						class="atlas-card__icon-action"
						onclick={toggleDownloadMenu}
						aria-label={$t("atlas.action.download")}
						title={$t("atlas.action.download")}
						aria-haspopup="menu"
						aria-expanded={downloadMenuOpen}
					>
						<Download size={16} strokeWidth={2} aria-hidden="true" />
						<ChevronDown
							class="atlas-card__download-chevron"
							size={11}
							strokeWidth={2.4}
							aria-hidden="true"
						/>
					</button>
					{#if downloadMenuOpen}
						<div
							class="atlas-card__download-menu"
							role="menu"
							aria-label={$t("atlas.action.download")}
						>
							{#each downloadOptions as option}
								<a
									class="atlas-card__download-option"
									href={option.url}
									role="menuitem"
									onclick={() => downloadMenuOpen = false}
								>
									{#if option.key === "markdown"}
										<FileText size={14} strokeWidth={2} aria-hidden="true" />
									{:else}
										<Download size={14} strokeWidth={2} aria-hidden="true" />
									{/if}
									<span>{option.label}</span>
								</a>
							{/each}
						</div>
					{/if}
				</div>
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

	.atlas-card--complete {
		animation: atlas-completion-card-in 420ms cubic-bezier(0.16, 1, 0.3, 1);
		border-color: color-mix(in srgb, var(--success, #2f8f5b) 36%, var(--border-default));
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--success, #2f8f5b) 10%, transparent),
			var(--shadow-sm);
	}

	.atlas-card--completion-enter .atlas-card__mark--complete {
		animation: atlas-completion-icon-pop 520ms cubic-bezier(0.16, 1, 0.3, 1);
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
		width: 2.75rem;
		height: 2.75rem;
		place-items: center;
		border-radius: 999px;
		overflow: hidden;
		background:
			color-mix(in srgb, var(--accent) 13%, transparent);
		color: var(--accent);
	}

	.atlas-card__mark--queued {
		overflow: visible;
	}

	.atlas-card__mark--complete {
		background: color-mix(in srgb, var(--success, #2f8f5b) 20%, transparent);
		color: var(--success, #2f8f5b);
	}

	.atlas-card__exploration-svg {
		width: 2.75rem;
		height: 2.75rem;
	}

	.atlas-card__exploration-svg .orbit-group {
		animation: atlas-orbit 2.6s linear infinite;
		transform-box: view-box;
		transform-origin: 28px 28px;
	}

	.atlas-card__ring {
		width: 2.75rem;
		height: 2.75rem;
		overflow: visible;
	}

	.atlas-card__progress-cycle {
		display: block;
	}

	.atlas-card__progress-cycle-track,
	.atlas-card__progress-cycle-fill {
		fill: none;
		stroke-width: 4;
	}

	.atlas-card__progress-cycle-track {
		stroke: color-mix(in srgb, currentColor 16%, transparent);
	}

	.atlas-card__progress-cycle-fill {
		stroke: currentColor;
		stroke-linecap: round;
		transform: rotate(-90deg);
		transform-origin: 50% 50%;
		transition: stroke-dashoffset 420ms ease;
	}

	.atlas-card__progress-cycle-sweep {
		animation: atlas-progress-cycle-spin 2s linear infinite;
		transform-box: view-box;
		transform-origin: 28px 28px;
		opacity: 0.82;
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

	.atlas-card__progress {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
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

	.atlas-card__status-message-wrap {
		position: relative;
		display: grid;
		min-width: 0;
		min-height: 1.25rem;
		align-items: center;
		overflow: hidden;
	}

	.atlas-card__status-message {
		grid-area: 1 / 1;
		overflow-wrap: anywhere;
	}

	.atlas-card__queries {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		border-top: 1px solid color-mix(in srgb, var(--border-default) 55%, transparent);
		padding-top: 0.55rem;
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}

	.atlas-card__queries-title {
		font-weight: 700;
		color: var(--text-primary);
	}

	.atlas-card__queries ul {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		padding-left: 1rem;
	}

	.atlas-card__queries li {
		overflow-wrap: anywhere;
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
		position: relative;
		width: 2.1rem;
		height: 2.1rem;
	}

	.atlas-card__icon-action--primary {
		background: var(--accent);
		color: var(--text-on-accent, #fff);
	}

	.atlas-card__open:hover:not(:disabled),
	.atlas-card__ghost:hover:not(:disabled),
	.atlas-card__icon-action:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow:
			0 0 0 2px color-mix(in srgb, var(--focus-ring) 20%, transparent),
			0 0.45rem 0.9rem color-mix(in srgb, var(--shadow-color, #000) 12%, transparent);
	}

	.atlas-card__open:active:not(:disabled),
	.atlas-card__ghost:active:not(:disabled),
	.atlas-card__icon-action:active:not(:disabled) {
		transform: translateY(0);
	}

	.atlas-card__open:focus-visible,
	.atlas-card__ghost:focus-visible,
	.atlas-card__icon-action:focus-visible,
	.atlas-card__download-option:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent);
	}

	.atlas-card__open,
	.atlas-card__ghost,
	.atlas-card__icon-action,
	.atlas-card__download-option {
		transition:
			transform 140ms ease,
			background-color 140ms ease,
			border-color 140ms ease,
			box-shadow 140ms ease;
	}

	.atlas-card__download {
		position: relative;
		display: inline-flex;
	}

	:global(.atlas-card__download-chevron) {
		position: absolute;
		right: 0.18rem;
		bottom: 0.18rem;
	}

	.atlas-card__download-menu {
		position: absolute;
		top: calc(100% + 0.35rem);
		right: 0;
		z-index: 5;
		display: grid;
		min-width: 11rem;
		gap: 0.15rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 84%, transparent);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		padding: 0.3rem;
		box-shadow: var(--shadow-md, 0 0.8rem 2rem rgb(0 0 0 / 16%));
	}

	.atlas-card__download-option {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		border-radius: calc(var(--radius-sm) - 2px);
		padding: 0.48rem 0.55rem;
		color: var(--text-primary);
		font-size: var(--text-sm);
		text-decoration: none;
	}

	.atlas-card__download-option:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		transform: translateX(1px);
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

	@keyframes atlas-orbit {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes atlas-progress-cycle-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes atlas-completion-card-in {
		from {
			opacity: 0;
			transform: translateY(0.35rem) scale(0.985);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@keyframes atlas-completion-icon-pop {
		0% {
			transform: scale(0.82);
		}
		62% {
			transform: scale(1.08);
		}
		100% {
			transform: scale(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.atlas-card--complete,
		.atlas-card--completion-enter .atlas-card__mark--complete,
		.atlas-card__exploration-svg .orbit-group,
		.atlas-card__progress-cycle-sweep {
			animation: none;
		}

		.atlas-card__progress-cycle-fill,
		.atlas-card__open,
		.atlas-card__ghost,
		.atlas-card__icon-action,
		.atlas-card__download-option {
			transition: none;
		}
	}
</style>
