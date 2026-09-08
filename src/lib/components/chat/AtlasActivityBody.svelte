<script lang="ts">
// The BODY of an Atlas activity row — everything inside the opened panel.
// The row above it (status glyph, "Atlas report", the title, the right-hand
// fact, the chevron) is the shared ToolActivityRow, exactly as a produced file
// works: AtlasActivityRow builds the row's view-model and hands this component
// in as the body snippet.
//
// Three shapes, one grammar (approved mockup: atlas-mock/Main, Done, Evidence,
// FailedStopped):
//   running   — stage line, the plan as it executes, the sweep, "Then: …", Stop
//   settled   — Report / Evidence / Plan tabs; Report carries the document row
//               (Open + one Download menu) and Revise / Continue / Fork
//   failed    — the reason and Retry; cancelled — one line and Continue
//
// v1 jobs (no `details.plan`) fall back to the stage label plus the queries
// list in the same body shape, so a job started before the v2 pipeline still
// renders honestly.
import {
	Check,
	ChevronDown,
	Download,
	FileText,
	LoaderCircle,
	RotateCw,
	Split,
	Square,
} from "@lucide/svelte";
import { type I18nKey, t } from "$lib/i18n";
import type {
	AtlasAction,
	AtlasJobCard,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import {
	type AtlasActivityDetails,
	type AtlasPlanConfidence,
	type AtlasPlanEntry,
	atlasPlanProgress,
	atlasReportTitle,
} from "$lib/utils/tool-activity";

let {
	job,
	details,
	onOpenDocument = undefined,
	onCancel = undefined,
	onLifecycleAction = undefined,
}: {
	job: AtlasJobCard;
	details: AtlasActivityDetails;
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

type AtlasTab = "report" | "evidence" | "plan";

type DownloadOption = {
	key: "pdf" | "html" | "markdown";
	label: string;
	url: string;
};

type AtlasOutputDocument = DocumentWorkspaceItem & {
	atlasHtmlChatGeneratedFileId?: string | null;
	atlasPdfChatGeneratedFileId?: string | null;
	atlasMarkdownChatGeneratedFileId?: string | null;
};

const STAGE_LABEL_KEYS: Record<string, I18nKey> = {
	decompose: "atlas.stage.decompose",
	search: "atlas.stage.search",
	curate: "atlas.stage.curate",
	"coverage-review": "atlas.stage.coverageReview",
	"gap-fill": "atlas.stage.gapFill",
	synthesize: "atlas.stage.synthesize",
	integrate: "atlas.stage.integrate",
	assemble: "atlas.stage.assemble",
	audit: "atlas.stage.audit",
	render: "atlas.stage.render",
};

const PHASE_LABEL_KEYS: Record<string, I18nKey> = {
	plan: "atlasActivity.phase.plan",
	research: "atlasActivity.phase.research",
	index: "atlasActivity.phase.index",
	write: "atlasActivity.phase.write",
	verify: "atlasActivity.phase.verify",
	render: "atlasActivity.phase.render",
};

const CONFIDENCE_LABEL_KEYS: Record<AtlasPlanConfidence, I18nKey> = {
	corroborated: "atlasActivity.confidence.corroborated",
	single: "atlasActivity.confidence.single",
	mixed: "atlasActivity.confidence.mixed",
	thin: "atlasActivity.confidence.thin",
};

let activeTab = $state<AtlasTab>("report");
let downloadMenuOpen = $state(false);
let downloadMenuElement = $state<HTMLSpanElement | null>(null);
let tabListElement = $state<HTMLDivElement | null>(null);
let activePanel = $state<AtlasAction | null>(null);
let lifecycleMessage = $state("");

const isActive = $derived(job.status === "queued" || job.status === "running");
const isCancelled = $derived(job.status === "cancelled");
const isFailed = $derived(job.status === "failed");
const reportTitle = $derived(atlasReportTitle(job, details, $t));
const planProgress = $derived(atlasPlanProgress(details.plan));
// The v1 body: gap-fill rounds showed their focus list, every other round the
// queries. Preserved verbatim so a pre-v2 job reads as it always did.
const isGapFill = $derived(
	details.roundKind === "gap-fill" ||
		(job.progress?.stage ?? job.stage) === "gap-fill",
);
const fallbackItems = $derived(
	isGapFill && details.focus.length > 0 ? details.focus : details.queries,
);
const fallbackLabel = $derived(
	isGapFill
		? $t("atlas.progressGapFillFocusLabel")
		: $t("atlas.progressQueriesLabel"),
);
const evidence = $derived(details.evidence);
const availableTabs = $derived([
	"report" as const,
	...(evidence ? (["evidence"] as const) : []),
	...(details.plan.length > 0 ? (["plan"] as const) : []),
] as AtlasTab[]);
const downloadOptions = $derived(getDownloadOptions(job.outputs));
const canOpenReport = $derived(
	Boolean(job.outputs.htmlChatGeneratedFileId) && Boolean(onOpenDocument),
);
const reportMeta = $derived(
	details.sectionCount != null
		? $t("atlasActivity.reportMetaWithSections", {
				sections: details.sectionCount,
				sources: job.sourceCounts.accepted,
			})
		: $t("atlasActivity.reportMeta", { sources: job.sourceCounts.accepted }),
);
const stageLine = $derived(buildStageLine());
const hiddenSourceCount = $derived(
	evidence
		? Math.max(0, job.sourceCounts.accepted - evidence.sources.length)
		: 0,
);
const failureReason = $derived(
	job.error?.message?.trim() || $t("atlas.failed"),
);
const lifecyclePanelLabel = $derived(
	activePanel ? lifecycleActionLabel(activePanel) : "",
);

// The tab set shrinks when a job has no evidence or plan (a v1 report), so the
// selected tab can stop existing; fall back to Report rather than render an
// empty panel.
$effect(() => {
	if (!availableTabs.includes(activeTab)) {
		activeTab = "report";
	}
});

$effect(() => {
	if (!downloadMenuOpen || typeof window === "undefined") return;
	function handleMouseDown(event: MouseEvent) {
		const target = event.target;
		if (
			target instanceof Node &&
			downloadMenuElement &&
			!downloadMenuElement.contains(target)
		) {
			downloadMenuOpen = false;
		}
	}
	window.addEventListener("mousedown", handleMouseDown);
	return () => window.removeEventListener("mousedown", handleMouseDown);
});

function buildStageLine(): { label: string; detail: string | null } {
	if (details.phase) {
		const label = $t(PHASE_LABEL_KEYS[details.phase]);
		if (details.phase === "research" && details.sourcesRead != null) {
			return {
				label,
				detail: $t("atlasActivity.sourcesRead", {
					count: details.sourcesRead,
				}),
			};
		}
		if (details.phase === "write" && details.sectionCount != null) {
			return {
				label,
				detail: $t("atlasActivity.sections", { count: details.sectionCount }),
			};
		}
		return { label, detail: null };
	}
	// v1: the pipeline stage, exactly as the old card said it.
	const stage = job.progress?.stage ?? job.stage;
	const stageKey = stage ? STAGE_LABEL_KEYS[stage] : undefined;
	if (stageKey) return { label: $t(stageKey), detail: null };
	if (job.status === "queued") {
		return { label: $t("atlas.stage.queued"), detail: null };
	}
	return { label: $t("atlas.stage.running"), detail: null };
}

function planStatusLabel(status: AtlasPlanEntry["status"]): string {
	if (status === "running") return $t("atlasActivity.questionRunning");
	if (status === "done") return $t("atlasActivity.questionDone");
	return $t("atlasActivity.questionQueued");
}

function planEntryMeta(entry: AtlasPlanEntry, withConfidence: boolean): string {
	const parts: string[] = [];
	if (entry.sourceCount > 0) {
		parts.push($t("atlas.sourceCount", { count: entry.sourceCount }));
	}
	if (withConfidence && entry.confidence) {
		parts.push($t(CONFIDENCE_LABEL_KEYS[entry.confidence]));
	}
	return parts.join(" · ");
}

function faviconLetter(host: string): string {
	const cleaned = host.replace(/^www\./i, "").trim();
	return cleaned ? cleaned.slice(0, 1).toUpperCase() : "·";
}

function downloadUrl(fileId: string | null | undefined): string | null {
	return fileId ? `/api/chat/files/${fileId}/download` : null;
}

function getDownloadOptions(
	outputs: AtlasJobCard["outputs"],
): DownloadOption[] {
	const options: DownloadOption[] = [];
	const pdfUrl = downloadUrl(outputs.pdfChatGeneratedFileId);
	const htmlUrl = downloadUrl(outputs.htmlChatGeneratedFileId);
	const markdownUrl = downloadUrl(outputs.markdownChatGeneratedFileId);
	if (pdfUrl) {
		options.push({
			key: "pdf",
			label: $t("atlasActivity.format.pdf"),
			url: pdfUrl,
		});
	}
	if (htmlUrl) {
		options.push({
			key: "html",
			label: $t("atlasActivity.format.html"),
			url: htmlUrl,
		});
	}
	if (markdownUrl) {
		options.push({
			key: "markdown",
			label: $t("atlasActivity.format.markdown"),
			url: markdownUrl,
		});
	}
	return options;
}

// Unchanged from the card this row replaces: Open hands the HTML output to the
// Document Workspace, carrying the sibling PDF/Markdown ids so the workspace's
// own download menu keeps working.
function openReport() {
	const fileId = job.outputs.htmlChatGeneratedFileId;
	if (!fileId || !onOpenDocument) return;
	const document: AtlasOutputDocument = {
		id: fileId,
		source: "chat_generated_file",
		filename: `${reportTitle || "atlas-report"}.html`,
		title: reportTitle,
		mimeType: "text/html",
		conversationId: job.conversationId,
		downloadUrl: `/api/chat/files/${fileId}/download`,
		previewUrl: `/api/chat/files/${fileId}/preview`,
		atlasHtmlChatGeneratedFileId: job.outputs.htmlChatGeneratedFileId,
		atlasPdfChatGeneratedFileId: job.outputs.pdfChatGeneratedFileId,
		atlasMarkdownChatGeneratedFileId: job.outputs.markdownChatGeneratedFileId,
	};
	onOpenDocument(document, { presentation: "expanded" });
}

function lifecycleActionLabel(action: AtlasAction): string {
	if (action === "fork") return $t("atlas.action.fork");
	if (action === "revise") return $t("atlas.action.revise");
	if (action === "continue") return $t("atlas.action.continue");
	return $t("composerTools.atlas");
}

function togglePanel(action: AtlasAction, prefill = "") {
	activePanel = activePanel === action ? null : action;
	downloadMenuOpen = false;
	lifecycleMessage = activePanel ? prefill : "";
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

function selectTab(tab: AtlasTab) {
	activeTab = tab;
	downloadMenuOpen = false;
}

function focusTab(tab: AtlasTab) {
	activeTab = tab;
	const next = tabListElement?.querySelector<HTMLButtonElement>(
		`[data-atlas-tab="${tab}"]`,
	);
	next?.focus();
}

function handleTabKeydown(event: KeyboardEvent) {
	const index = availableTabs.indexOf(activeTab);
	if (index < 0) return;
	if (event.key === "ArrowRight" || event.key === "ArrowDown") {
		event.preventDefault();
		focusTab(availableTabs[(index + 1) % availableTabs.length] as AtlasTab);
	} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
		event.preventDefault();
		focusTab(
			availableTabs[
				(index - 1 + availableTabs.length) % availableTabs.length
			] as AtlasTab,
		);
	} else if (event.key === "Home") {
		event.preventDefault();
		focusTab(availableTabs[0] as AtlasTab);
	} else if (event.key === "End") {
		event.preventDefault();
		focusTab(availableTabs[availableTabs.length - 1] as AtlasTab);
	}
}
</script>

{#snippet planRow(entry: AtlasPlanEntry, withConfidence: boolean)}
	{@const meta = planEntryMeta(entry, withConfidence)}
	<div
		class="atlas-q"
		class:is-queued={entry.status === 'queued'}
		class:is-running={entry.status === 'running'}
		data-testid="atlas-plan-question"
		data-status={entry.status}
	>
		<span class="atlas-q-status" role="img" aria-label={planStatusLabel(entry.status)}>
			{#if entry.status === 'running'}
				<LoaderCircle size={13} strokeWidth={2.4} aria-hidden="true" />
			{:else}
				<Check size={13} strokeWidth={2.2} aria-hidden="true" />
			{/if}
		</span>
		<span class="atlas-q-text" title={entry.question}>{entry.question}</span>
		{#if meta}
			<span class="atlas-q-meta">{meta}</span>
		{/if}
	</div>
{/snippet}

{#snippet lifecyclePanel()}
	{#if activePanel}
		<section class="atlas-panel" aria-label={lifecyclePanelLabel} data-testid="atlas-lifecycle-panel">
			<textarea
				bind:value={lifecycleMessage}
				class="atlas-panel-input"
				placeholder={$t('atlas.lifecyclePromptPlaceholder')}
				rows="3"
				aria-label={lifecyclePanelLabel}
			></textarea>
			<div class="atlas-panel-actions">
				<button type="button" class="mini-btn" onclick={() => { activePanel = null; lifecycleMessage = ''; }}>
					{$t('common.cancel')}
				</button>
				<button
					type="button"
					class="mini-btn is-primary"
					onclick={submitLifecycleAction}
					disabled={!lifecycleMessage.trim()}
				>
					{lifecyclePanelLabel}
				</button>
			</div>
		</section>
	{/if}
{/snippet}

<div class="atlas-body" data-testid="atlas-activity-body" data-status={job.status}>
	{#if isActive}
		<div class="atlas-stage-line" data-testid="atlas-stage-line" aria-live="polite">
			<b>{stageLine.label}</b>
			{#if stageLine.detail}
				<span aria-hidden="true">·</span>
				<span>{stageLine.detail}</span>
			{/if}
		</div>
		{#if details.plan.length > 0}
			<div class="atlas-plan" aria-label={$t('atlasActivity.planLabel')} data-testid="atlas-plan">
				{#each details.plan as entry (entry.id)}
					{@render planRow(entry, false)}
				{/each}
			</div>
		{:else if fallbackItems.length > 0}
			<div class="atlas-plan" aria-label={fallbackLabel} data-testid="atlas-plan-fallback">
				{#each fallbackItems as item (item)}
					<div class="atlas-q is-queued" data-testid="atlas-plan-question">
						<span class="atlas-q-status" role="img" aria-label={$t('atlasActivity.questionQueued')}>
							<Check size={13} strokeWidth={2.2} aria-hidden="true" />
						</span>
						<span class="atlas-q-text" title={item}>{item}</span>
					</div>
				{/each}
			</div>
		{/if}
		<div class="atlas-track" aria-hidden="true"><i></i></div>
		<div class="atlas-foot">
			{#if details.next}
				<span class="atlas-next">{$t('atlasActivity.then', { next: details.next })}</span>
			{/if}
			{#if onCancel}
				<button
					type="button"
					class="mini-btn atlas-stop"
					onclick={() => onCancel?.(job.id)}
					aria-label={$t('atlas.action.cancel')}
				>
					<Square size={12} strokeWidth={2} aria-hidden="true" />
					{$t('atlasActivity.stop')}
				</button>
			{/if}
		</div>
	{:else if isFailed}
		<div class="atlas-error" data-testid="atlas-failure-reason">{failureReason}</div>
		<div class="atlas-note">{$t('atlasActivity.retryNote')}</div>
		<div class="atlas-actions">
			<button
				type="button"
				class="mini-btn"
				onclick={() => togglePanel('continue', $t('atlasActivity.retryPrompt'))}
				data-testid="atlas-retry"
			>
				<RotateCw size={12} strokeWidth={2} aria-hidden="true" />
				{$t('atlasActivity.retry')}
			</button>
		</div>
		{@render lifecyclePanel()}
	{:else if isCancelled}
		<div class="atlas-note" data-testid="atlas-stopped-note">
			{$t('atlasActivity.stoppedNote', { count: job.sourceCounts.accepted })}
		</div>
		<div class="atlas-actions">
			<button
				type="button"
				class="mini-btn"
				onclick={() => togglePanel('continue')}
				aria-label={$t('atlas.action.continue')}
				data-testid="atlas-continue"
			>
				{$t('atlasActivity.continue')}
			</button>
		</div>
		{@render lifecyclePanel()}
	{:else}
		{#if availableTabs.length > 1}
			<div
				class="atlas-tabs"
				role="tablist"
				aria-label={$t('atlasActivity.tabsLabel')}
				bind:this={tabListElement}
			>
				{#each availableTabs as tab (tab)}
					<button
						type="button"
						class="atlas-tab"
						class:is-active={activeTab === tab}
						role="tab"
						id={`atlas-tab-${job.id}-${tab}`}
						data-atlas-tab={tab}
						aria-selected={activeTab === tab}
						aria-controls={`atlas-panel-${job.id}-${tab}`}
						tabindex={activeTab === tab ? 0 : -1}
						onclick={() => selectTab(tab)}
						onkeydown={handleTabKeydown}
					>
						{$t(`atlasActivity.tab.${tab}` as I18nKey)}
					</button>
				{/each}
			</div>
		{/if}

		{#if activeTab === 'report'}
			<div
				class="atlas-tabpanel"
				role={availableTabs.length > 1 ? 'tabpanel' : undefined}
				id={`atlas-panel-${job.id}-report`}
				aria-labelledby={availableTabs.length > 1 ? `atlas-tab-${job.id}-report` : undefined}
				data-testid="atlas-report-tab"
			>
				<div class="atlas-file-row">
					<FileText class="atlas-file-icon" size={14} strokeWidth={2} aria-hidden="true" />
					<span class="atlas-file-name" title={reportTitle}>{reportTitle}</span>
					<span class="atlas-file-meta">{reportMeta}</span>
					<span class="atlas-file-actions">
						<button
							type="button"
							class="mini-btn"
							onclick={openReport}
							disabled={!canOpenReport}
							data-testid="atlas-open-report"
						>
							{$t('common.open')}
						</button>
						{#if downloadOptions.length > 0}
							<span class="atlas-dd" bind:this={downloadMenuElement}>
								<button
									type="button"
									class="mini-btn"
									aria-haspopup="menu"
									aria-expanded={downloadMenuOpen}
									onclick={() => { downloadMenuOpen = !downloadMenuOpen; activePanel = null; }}
									data-testid="atlas-download-menu-button"
								>
									<Download size={13} strokeWidth={2} aria-hidden="true" />
									{$t('atlasActivity.download')}
									<ChevronDown class="atlas-caret" size={13} strokeWidth={2} aria-hidden="true" />
								</button>
								{#if downloadMenuOpen}
									<span class="atlas-dd-menu" role="menu" aria-label={$t('atlasActivity.download')}>
										{#each downloadOptions as option (option.key)}
											<a
												class="atlas-dd-item"
												role="menuitem"
												href={option.url}
												download
												onclick={() => { downloadMenuOpen = false; }}
											>
												{option.label}
											</a>
										{/each}
									</span>
								{/if}
							</span>
						{/if}
					</span>
				</div>
				<div class="atlas-actions">
					<button
						type="button"
						class="mini-btn"
						onclick={() => togglePanel('revise')}
						title={$t('atlas.action.reviseTooltip')}
						aria-label={$t('atlas.action.revise')}
					>
						<RotateCw size={12} strokeWidth={2} aria-hidden="true" />
						{$t('atlasActivity.revise')}
					</button>
					<button
						type="button"
						class="mini-btn"
						onclick={() => togglePanel('continue')}
						title={$t('atlas.action.continueTooltip')}
						aria-label={$t('atlas.action.continue')}
					>
						{$t('atlasActivity.continue')}
					</button>
					<button
						type="button"
						class="mini-btn"
						onclick={() => togglePanel('fork')}
						title={$t('atlas.action.forkTooltip')}
						aria-label={$t('atlas.action.fork')}
					>
						<Split size={12} strokeWidth={2} aria-hidden="true" />
						{$t('atlasActivity.fork')}
					</button>
				</div>
				{@render lifecyclePanel()}
			</div>
		{:else if activeTab === 'evidence' && evidence}
			<!-- The Evidence and Plan panels are read-only lists with no focusable
			     child, so ARIA asks for the panel itself to be focusable; the
			     Report panel is not (its buttons take the focus). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="atlas-tabpanel"
				role="tabpanel"
				id={`atlas-panel-${job.id}-evidence`}
				aria-labelledby={`atlas-tab-${job.id}-evidence`}
				tabindex="0"
				data-testid="atlas-evidence-tab"
			>
				<div class="atlas-stage-line">
					<b>{$t('atlasActivity.confidence')}</b>
					<span aria-hidden="true">·</span>
					<span>
						{$t('atlasActivity.evidenceSummary', {
							corroborated: evidence.corroborated,
							single: evidence.single,
							inferred: evidence.inferred,
							cut: evidence.cut,
						})}
					</span>
				</div>
				{#if details.plan.length > 0}
					<div class="atlas-plan" aria-label={$t('atlasActivity.planLabel')}>
						{#each details.plan as entry (entry.id)}
							{@render planRow(entry, true)}
						{/each}
					</div>
				{/if}
				{#if evidence.sources.length > 0}
					<div class="atlas-eyebrow">{$t('toolActivity.sourcesEyebrow')}</div>
					{#each evidence.sources as source (source.n)}
						<div class="atlas-src" data-testid="atlas-evidence-source">
							<span class="atlas-favicon" aria-hidden="true">{faviconLetter(source.host)}</span>
							<span class="atlas-src-title" title={source.title}>{source.title}</span>
							<span class="atlas-src-host">
								{source.date ? `${source.host} · ${source.date}` : source.host}
							</span>
							{#if source.cited}
								<Check class="atlas-src-cited" size={12} strokeWidth={2.2} aria-hidden="true" />
							{/if}
						</div>
					{/each}
				{/if}
				{#if hiddenSourceCount > 0}
					<div class="atlas-note" data-testid="atlas-evidence-more">
						{evidence.filteredCount > 0
							? $t('atlasActivity.moreSourcesFiltered', {
									count: hiddenSourceCount,
									filtered: evidence.filteredCount,
								})
							: $t('atlasActivity.moreSources', { count: hiddenSourceCount })}
					</div>
				{:else if evidence.filteredCount > 0}
					<div class="atlas-note" data-testid="atlas-evidence-more">
						{$t('atlasActivity.filteredOnly', { filtered: evidence.filteredCount })}
					</div>
				{/if}
			</div>
		{:else if activeTab === 'plan'}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="atlas-tabpanel"
				role="tabpanel"
				id={`atlas-panel-${job.id}-plan`}
				aria-labelledby={`atlas-tab-${job.id}-plan`}
				tabindex="0"
				data-testid="atlas-plan-tab"
			>
				<div class="atlas-stage-line">
					<b>{$t('atlasActivity.planLabel')}</b>
					<span aria-hidden="true">·</span>
					<span>
						{$t('atlasActivity.questionsProgress', {
							done: planProgress.done,
							total: planProgress.total,
						})}
					</span>
				</div>
				<div class="atlas-plan">
					{#each details.plan as entry (entry.id)}
						{@render planRow(entry, false)}
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.atlas-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
		min-width: 0;
	}

	/* "Researching · 31 sources read so far" — the phase in the primary colour,
	   the fact beside it muted, exactly like the mockup's .stage-line. */
	.atlas-stage-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
		line-height: 1.45;
	}

	.atlas-stage-line b {
		font-weight: 500;
		color: var(--text-primary);
	}

	.atlas-plan {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	/* One line per research question: glyph, question, source count. */
	.atlas-q {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 3px 0;
	}

	.atlas-q-status {
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--success);
	}

	.atlas-q.is-running .atlas-q-status {
		color: var(--accent);
	}

	.atlas-q.is-running .atlas-q-status :global(svg) {
		animation: atlas-q-spin 0.9s linear infinite;
	}

	@keyframes atlas-q-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.atlas-q.is-queued .atlas-q-status {
		color: color-mix(in srgb, var(--text-muted) 40%, transparent);
	}

	.atlas-q-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.atlas-q.is-queued .atlas-q-text {
		color: var(--text-muted);
	}

	.atlas-q-meta {
		flex: 0 0 auto;
		margin-left: auto;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* The same 3px sweep a file being produced uses. */
	.atlas-track {
		position: relative;
		height: 3px;
		margin: 2px 0;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-muted) 18%, transparent);
		overflow: hidden;
	}

	.atlas-track i {
		position: absolute;
		top: 0;
		left: 0;
		width: 40%;
		height: 100%;
		border-radius: 999px;
		background: var(--accent);
		animation: atlas-sweep 1.6s ease-in-out infinite;
	}

	@keyframes atlas-sweep {
		0% {
			left: -40%;
		}
		100% {
			left: 100%;
		}
	}

	.atlas-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.atlas-next {
		min-width: 0;
		color: var(--text-muted);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.atlas-stop {
		flex: 0 0 auto;
		margin-left: auto;
	}

	.atlas-note {
		color: var(--text-muted);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.atlas-error {
		color: var(--danger);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.atlas-eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-muted);
	}

	/* Tabs: text labels on a hairline, the active one underlined in accent. */
	.atlas-tabs {
		display: flex;
		gap: 2px;
		margin: -2px 0 2px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.atlas-tab {
		margin-bottom: -1px;
		padding: 4px 8px 6px;
		border: none;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.atlas-tab:hover {
		color: var(--text-primary);
	}

	.atlas-tab.is-active {
		color: var(--text-primary);
		border-bottom-color: var(--accent);
	}

	.atlas-tab:focus-visible {
		outline: none;
		border-radius: 5px 5px 0 0;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.atlas-tabpanel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.atlas-tabpanel:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 5px;
	}

	.atlas-file-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		margin: 0 -6px;
		padding: 4px 6px;
		border-radius: 5px;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.atlas-file-row:hover {
		background: var(--surface-overlay);
	}

	:global(.atlas-file-icon) {
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		color: var(--text-muted);
		opacity: 0.85;
	}

	.atlas-file-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.atlas-file-meta {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.atlas-file-actions {
		margin-left: auto;
		display: inline-flex;
		gap: 2px;
	}

	.atlas-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 2px;
	}

	.atlas-dd {
		position: relative;
		display: inline-flex;
	}

	:global(.atlas-caret) {
		flex: 0 0 13px;
		margin-left: -1px;
	}

	.atlas-dd-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 20;
		display: flex;
		flex-direction: column;
		min-width: 9.5rem;
		padding: 4px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
	}

	.atlas-dd-item {
		padding: 5px 8px;
		border-radius: 5px;
		color: var(--text-primary);
		font-size: 0.72rem;
		text-decoration: none;
		white-space: nowrap;
	}

	.atlas-dd-item:hover,
	.atlas-dd-item:focus-visible {
		background: var(--surface-elevated);
	}

	.atlas-src {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		margin: 0 -6px;
		padding: 3px 6px;
		border-radius: 5px;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.atlas-src:hover {
		background: var(--surface-overlay);
	}

	.atlas-favicon {
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-subtle);
		color: var(--text-muted);
		font-size: 8px;
		font-weight: 700;
	}

	.atlas-src-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.atlas-src-host {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	:global(.atlas-src-cited) {
		flex: 0 0 auto;
		margin-left: auto;
		color: var(--success);
	}

	.atlas-panel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 2px;
	}

	.atlas-panel-input {
		width: 100%;
		padding: 6px 8px;
		border: 1px solid var(--border-default);
		border-radius: 5px;
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		resize: vertical;
	}

	.atlas-panel-input:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.atlas-panel-actions {
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

	.mini-btn.is-primary {
		border-color: var(--accent);
		color: var(--accent);
	}

	@media (prefers-reduced-motion: reduce) {
		.atlas-track i {
			animation: none;
			left: 30%;
		}

		.atlas-q.is-running .atlas-q-status :global(svg) {
			animation: none;
		}
	}
</style>
