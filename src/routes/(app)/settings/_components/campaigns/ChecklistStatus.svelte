<script lang="ts">
import { Check, ChevronDown, TriangleAlert, X } from "@lucide/svelte";
import { slide } from "svelte/transition";
import { t } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import {
	type CampaignChecklist,
	type ChecklistFailureRow,
	checklistRuleLabelKey,
	summarizeFailures,
} from "./campaign-checklist";
import type { I18nKey } from "$lib/i18n";

const slideTransition = reducedMotionAware(slide);

let {
	checklist,
	onJumpToSlide,
}: {
	checklist: CampaignChecklist;
	onJumpToSlide?: (slideIndex: number) => void;
} = $props();

// A passing checklist stays shut; a failing one opens itself, because there is
// something to read. Either can be toggled by hand afterwards.
let userToggled = $state<boolean | null>(null);
let expanded = $derived(userToggled ?? !checklist.ready);
let rows = $derived(summarizeFailures(checklist));

function languageName(locale: "en" | "hu" | undefined): string {
	if (!locale) return "";
	return locale === "hu"
		? $t("admin.campaigns.language.hu")
		: $t("admin.campaigns.language.en");
}

function rowLabel(row: ChecklistFailureRow): string {
	return $t(row.labelKey as I18nKey, { language: languageName(row.locale) });
}
</script>

<div
	class="checklist"
	class:checklist-failing={!checklist.ready}
	data-testid="campaign-checklist"
>
	<button
		type="button"
		class="checklist-summary"
		aria-expanded={expanded}
		onclick={() => (userToggled = !expanded)}
	>
		<span class="checklist-icon">
			{#if checklist.ready}
				<Check size={14} strokeWidth={2.2} aria-hidden="true" />
			{:else}
				<TriangleAlert size={14} strokeWidth={2.2} aria-hidden="true" />
			{/if}
		</span>
		{#if checklist.ready}
			<span class="checklist-text">
				{$t('admin.campaigns.checklist.allPass', {
					passed: checklist.passedCount,
					total: checklist.totalCount,
				})}
				<strong>{$t('admin.campaigns.checklist.readyToPublish')}</strong>
			</span>
		{:else}
			<span class="checklist-text checklist-text-strong">
				{$t('admin.campaigns.checklist.failing', { count: checklist.failedCount })}
			</span>
			<span class="checklist-pass-count">
				{$t('admin.campaigns.checklist.passing', { count: checklist.passedCount })}
			</span>
		{/if}
		<span class="checklist-chevron" class:checklist-chevron-open={expanded} aria-hidden="true">
			<ChevronDown size={14} strokeWidth={2} />
		</span>
	</button>

	{#if expanded}
		<div class="checklist-body" transition:slideTransition={{ duration: 200 }}>
			{#if rows.length > 0}
				{#each rows as row (row.id)}
					<div class="check-row check-row-bad">
						<span class="check-row-icon"><X size={13} strokeWidth={2.2} aria-hidden="true" /></span>
						<span class="check-row-label">{rowLabel(row)}</span>
						{#if row.menuItem}
							<span class="check-row-hint">{$t('admin.campaigns.checklist.inSlideMenu')}</span>
						{/if}
						{#if row.slideIndex !== undefined}
							<button
								type="button"
								class="check-row-target"
								onclick={() => onJumpToSlide?.(row.slideIndex ?? 0)}
							>
								{$t('admin.campaigns.slideNumber', { number: (row.slideIndex ?? 0) + 1 })}
							</button>
						{/if}
					</div>
				{/each}
			{:else}
				{#each checklist.rules as rule (rule.id)}
					<div class="check-row">
						<span class="check-row-icon check-row-icon-ok">
							<Check size={13} strokeWidth={2.2} aria-hidden="true" />
						</span>
						<span class="check-row-label">{$t(checklistRuleLabelKey(rule.id) as I18nKey)}</span>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.checklist {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-overlay);
		padding: 0.55rem 0.875rem;
		margin-bottom: 0.75rem;
	}

	.checklist-failing {
		border-color: color-mix(in srgb, var(--danger) 32%, transparent);
		background: color-mix(in srgb, var(--danger) 6%, var(--surface-page));
	}

	.checklist-summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border: none;
		background: none;
		padding: 0.15rem 0;
		color: var(--text-primary);
		font: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.checklist-summary:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.checklist-icon {
		display: inline-flex;
		color: var(--success);
	}

	.checklist-failing .checklist-icon {
		color: var(--danger);
	}

	.checklist-text {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.84rem;
	}

	.checklist-text-strong {
		font-weight: 600;
	}

	.checklist-pass-count {
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.checklist-chevron {
		display: inline-flex;
		color: var(--text-muted);
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.checklist-chevron-open {
		transform: rotate(180deg);
	}

	.checklist-body {
		margin-top: 0.5rem;
	}

	.check-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0;
		border-top: 1px solid var(--border-subtle);
		font-size: var(--text-xs);
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.check-row:first-child {
		border-top: none;
	}

	.check-row-icon {
		flex-shrink: 0;
		display: inline-flex;
		margin-top: 1px;
		color: var(--danger);
	}

	.check-row-icon-ok {
		color: var(--success);
	}

	.check-row-bad .check-row-label {
		color: var(--text-primary);
	}

	.check-row-label {
		flex: 0 1 auto;
		min-width: 0;
	}

	.check-row-hint {
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.check-row-target {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		color: var(--text-secondary);
		font-size: var(--text-2xs);
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.check-row-target:hover {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}

	.check-row-target:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
