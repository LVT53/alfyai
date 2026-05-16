<script lang="ts">
	import type {
		KnowledgeMemoryOverviewSource,
		KnowledgeMemoryOverviewStatus,
	} from '$lib/types';
	import { formatMediumDateTime } from '$lib/utils/time';
	import { t } from '$lib/i18n';

	let {
		memoryLoading,
		memoryLoaded,
		memoryLoadError,
		personaMemoryCount,
		focusContinuityItemCount,
		honchoEnabled,
		honchoOverview,
		honchoOverviewBullets,
		honchoOverviewSource,
		honchoOverviewStatus,
		honchoOverviewUpdatedAt,
		honchoOverviewLastAttemptAt,
		durablePersonaCount,
		activeConstraintCount,
		currentProjectContextCount,
		liveOverviewRefreshing,
		onRetryLoadMemory,
		onRetryLiveOverview,
		onOpenMemoryModal,
	}: {
		memoryLoading: boolean;
		memoryLoaded: boolean;
		memoryLoadError: string;
		personaMemoryCount: number;
		focusContinuityItemCount: number;
		honchoEnabled: boolean;
		honchoOverview: string;
		honchoOverviewBullets: string[];
		honchoOverviewSource: KnowledgeMemoryOverviewSource;
		honchoOverviewStatus: KnowledgeMemoryOverviewStatus;
		honchoOverviewUpdatedAt: number | null;
		honchoOverviewLastAttemptAt: number | null;
		durablePersonaCount: number;
		activeConstraintCount: number;
		currentProjectContextCount: number;
		liveOverviewRefreshing: boolean;
		onRetryLoadMemory: () => void | Promise<void>;
		onRetryLiveOverview: () => void | Promise<void>;
		onOpenMemoryModal: (kind: 'persona' | 'focus') => void;
	} = $props();
</script>

{#if memoryLoading && !memoryLoaded}
	<section class="rounded-[1.5rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm md:px-5 md:py-5">
		<div class="grid gap-4 lg:grid-cols-[1.35fr_0.85fr]">
			<div class="rounded-[1.3rem] border border-border bg-surface-page px-5 py-5">
				<div class="h-3 w-28 animate-pulse rounded-full bg-surface-page"></div>
				<div class="mt-5 h-8 w-52 animate-pulse rounded-full bg-surface-page"></div>
				<div class="mt-5 space-y-3">
					<div class="h-3 w-full animate-pulse rounded-full bg-surface-page"></div>
					<div class="h-3 w-11/12 animate-pulse rounded-full bg-surface-page"></div>
					<div class="h-3 w-9/12 animate-pulse rounded-full bg-surface-page"></div>
				</div>
			</div>
			<div class="space-y-4">
				<div class="grid grid-cols-2 gap-3">
					<div class="rounded-[1.3rem] border border-border bg-surface-page px-4 py-4">
						<div class="h-3 w-20 animate-pulse rounded-full bg-surface-page"></div>
						<div class="mt-3 h-7 w-12 animate-pulse rounded-full bg-surface-page"></div>
					</div>
					<div class="rounded-[1.3rem] border border-border bg-surface-page px-4 py-4">
						<div class="h-3 w-20 animate-pulse rounded-full bg-surface-page"></div>
						<div class="mt-3 h-7 w-12 animate-pulse rounded-full bg-surface-page"></div>
					</div>
				</div>
				<div class="rounded-[1.3rem] border border-border bg-surface-page px-4 py-4">
					<div class="h-3 w-28 animate-pulse rounded-full bg-surface-page"></div>
					<div class="mt-4 space-y-3">
						<div class="h-3 w-full animate-pulse rounded-full bg-surface-page"></div>
						<div class="h-3 w-10/12 animate-pulse rounded-full bg-surface-page"></div>
					</div>
				</div>
			</div>
		</div>

		<div class="mt-6 rounded-[1.2rem] border border-dashed border-border bg-surface-page px-4 py-5 text-sm font-sans text-text-muted">
			{$t('memory.loading')}
		</div>
	</section>
{:else if memoryLoadError && !memoryLoaded}
	<section class="rounded-[1.5rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm md:px-5 md:py-5">
		<div class="rounded-[1.2rem] border border-danger bg-surface-page px-4 py-5">
				<div class="text-sm font-sans font-medium text-danger">{$t('memory.failedLoad')}</div>
				<p class="mt-2 text-sm font-sans leading-[1.6] text-text-secondary">{memoryLoadError}</p>
				<button
					type="button"
					class="mt-4 cursor-pointer rounded-full border border-border px-4 py-2 text-sm font-sans font-medium text-text-primary transition hover:bg-surface-page"
					onclick={onRetryLoadMemory}
				>
					{$t('memory.tryAgain')}
				</button>
		</div>
	</section>
{:else}
	<section class="memory-section rounded-[1.5rem] border border-border bg-surface-elevated px-5 py-5 shadow-sm md:px-6">
		<div class="mb-4">
			<h2 class="text-2xl font-serif tracking-[-0.02em] text-text-primary">{$t('memory.title')}</h2>
			<p class="text-sm text-text-secondary mt-1">{$t('memory.description')}</p>
		</div>
		<div class="grid gap-4 lg:grid-cols-2">
			<div class="flex flex-col rounded-[1.3rem] border border-border bg-surface-elevated px-4 py-4">
				<div class="flex items-center justify-between gap-3">
					<div>
						<h3 class="text-lg font-sans font-semibold text-text-primary">
							{$t('memory.managePersona')}
						</h3>
					</div>
				<span class="rounded-full border border-border bg-surface-elevated px-3 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] text-text-muted">
					{personaMemoryCount}
				</span>
				</div>
				<div class="mt-4 flex flex-wrap items-center gap-3">
					<button
						type="button"
						class="cursor-pointer rounded-full border border-border px-4 py-2 text-sm font-sans font-medium text-text-primary transition hover:bg-surface-page"
						onclick={() => onOpenMemoryModal('persona')}
						disabled={!honchoEnabled}
					>
						{$t('memory.managePersonaMemory')}
					</button>
					{#if !honchoEnabled}
						<span class="text-xs font-sans text-text-muted">
							{$t('memory.unavailableHoncho')}
						</span>
					{:else if memoryLoaded && personaMemoryCount === 0}
						<span class="text-xs font-sans text-text-muted">
							{$t('memory.noPersonaMemory')}
						</span>
					{/if}
				</div>
			</div>

			<div class="flex flex-col rounded-[1.3rem] border border-border bg-surface-elevated px-4 py-4">
				<div class="flex items-center justify-between gap-3">
					<div>
						<h3 class="text-lg font-sans font-semibold text-text-primary">
							{$t('memory.manageFocus')}
						</h3>
					</div>
				<span class="rounded-full border border-border bg-surface-elevated px-3 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] text-text-muted">
					{focusContinuityItemCount}
				</span>
				</div>

				<p class="mt-4 text-sm font-sans leading-[1.6] text-text-secondary">
					{$t('memory.focusDescription')}
				</p>

				<div class="mt-auto flex flex-wrap items-center gap-3 pt-4">
					<button
						type="button"
						class="cursor-pointer rounded-full border border-border px-4 py-2 text-sm font-sans font-medium text-text-primary transition hover:bg-surface-page"
						onclick={() => onOpenMemoryModal('focus')}
					>
						{$t('memory.manageFocus')}
					</button>
					{#if memoryLoaded && focusContinuityItemCount === 0}
						<span class="text-xs font-sans text-text-muted">
							{$t('memory.noFocusContinuity')}
						</span>
					{/if}
				</div>
			</div>
		</div>

		<div class="mt-6 rounded-[1.3rem] border border-border bg-surface-page px-5 py-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 class="text-lg font-sans font-semibold text-text-primary">
						{$t('memory.overview')}
					</h2>
					{#if honchoOverviewUpdatedAt}
						<p class="mt-1 text-xs font-sans uppercase tracking-[0.08em] text-text-muted">
							{$t('memory.lastLiveOverview')} {formatMediumDateTime(honchoOverviewUpdatedAt)}
						</p>
					{:else if honchoOverviewLastAttemptAt}
						<p class="mt-1 text-xs font-sans uppercase tracking-[0.08em] text-text-muted">
							{$t('memory.lastOverviewAttempt')} {formatMediumDateTime(honchoOverviewLastAttemptAt)}
						</p>
					{/if}
				</div>
				{#if honchoEnabled && memoryLoaded}
					<button
						type="button"
						class="cursor-pointer rounded-full border border-border px-3 py-2 text-sm font-sans font-medium text-text-primary transition hover:bg-surface-elevated disabled:opacity-50"
						onclick={onRetryLiveOverview}
						disabled={liveOverviewRefreshing}
					>
						{#if liveOverviewRefreshing}
							<svg class="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
							</svg>
						{:else}
							<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
								<path d="M21 3v5h-5"/>
								<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
								<path d="M3 21v-5h5"/>
							</svg>
						{/if}
					</button>
				{/if}
			</div>
			{#if honchoOverview}
				{#if honchoOverviewSource === 'honcho_cache'}
					<p class="mt-4 text-xs font-sans uppercase tracking-[0.08em] text-text-muted">
						{$t('memory.honchoCacheNotice')}
					</p>
				{:else if honchoOverviewSource === 'persona_fallback'}
					<p class="mt-4 text-xs font-sans uppercase tracking-[0.08em] text-text-muted">
						{$t('memory.personaFallbackNotice')}
					</p>
				{/if}
				<ul class="memory-overview-list mt-4 list-disc space-y-3 pl-5 text-sm font-sans leading-[1.65] text-text-secondary">
					{#each honchoOverviewBullets as bullet (bullet)}
						<li class="pl-1">{bullet}</li>
					{/each}
				</ul>
			{:else if honchoOverviewStatus === 'temporarily_unavailable'}
				<p class="mt-4 text-sm font-sans leading-[1.6] text-text-muted">
					{$t('memory.temporarilyUnavailable', { count: durablePersonaCount })}
				</p>
			{:else if honchoEnabled}
				<p class="mt-4 text-sm font-sans leading-[1.6] text-text-muted">
					{$t('memory.notEnoughDurableMemory')}
				</p>
			{:else}
				<p class="mt-4 text-sm font-sans leading-[1.6] text-text-muted">
					{$t('memory.disabledNotice')}
				</p>
			{/if}
		</div>
	</section>
{/if}
