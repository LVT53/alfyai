<script lang="ts">
/**
 * The toolbar above History's preview (ruling 76, versioning.md §5.4–§5.6): what
 * the selected moment is ("Monday 10:09 · You edited"), what it changed (with
 * the version number in fine print, the one place it is printed), the switch
 * between "This version's changes" and "Compared with now", the stepper through
 * the preview's changes, and the two things a reader does with a version: name
 * it and bring it back.
 *
 * Restore turns into its own question in place (no modal): the question, any
 * extra lines that apply, and Cancel / Restore. Naming opens an inline field.
 * The toolbar is presentational: `HistoryMode.svelte` holds the state and does
 * the work.
 */
import { Bookmark, ChevronDown, ChevronUp, RotateCcw } from "@lucide/svelte";
import { tick } from "svelte";
import { t } from "$lib/i18n";
import { VERSION_LABEL_MAX_CHARS } from "$lib/shared/artifacts/history";

type Compare = "step" | "now";

let {
	title,
	detail = null,
	fine,
	showCompare,
	compare,
	stepDisabled,
	changeCount = 0,
	changeIndex = -1,
	nowLine = false,
	sameAsNow = false,
	label = null,
	nextEditsNote = false,
	canRestore = false,
	restoreDisabledReason = null,
	restoreQuestion = null,
	restoring = false,
	restoreProblem = null,
	naming = false,
	nameDraft = $bindable(""),
	namingBusy = false,
	nameProblem = null,
	narrow = false,
	onCompare,
	onPrevChange,
	onNextChange,
	onAskRestore = undefined,
	onCancelRestore = undefined,
	onConfirmRestore = undefined,
	onStartName = undefined,
	onSaveName = undefined,
	onCancelName = undefined,
	onRemoveName = undefined,
}: {
	title: string;
	detail?: string | null;
	/** "Version 7": the only place a version number is printed. */
	fine: string;
	/** The newest moment shows only "this version's changes"; there is nothing to compare it with. */
	showCompare: boolean;
	compare: Compare;
	/** A first version has no step of its own: its preview compares with now, and the first half of the switch is disabled. */
	stepDisabled: boolean;
	changeCount?: number;
	/** 0-based; -1 before the reader has stepped to one. */
	changeIndex?: number;
	nowLine?: boolean;
	sameAsNow?: boolean;
	label?: string | null;
	/** Naming the newest version closes its burst: say that the next edits start a new one. */
	nextEditsNote?: boolean;
	canRestore?: boolean;
	/** Why Restore is not offered right now (offline, conflict): the words shown in its place. */
	restoreDisabledReason?: string | null;
	/** Set while the question is open: the lines it says (the first is the question itself). */
	restoreQuestion?: string[] | null;
	restoring?: boolean;
	/** A refusal the reader should read before asking again ("It changed while you were looking."). */
	restoreProblem?: string | null;
	naming?: boolean;
	nameDraft?: string;
	namingBusy?: boolean;
	nameProblem?: string | null;
	/** The narrow layouts stack the title above its actions. */
	narrow?: boolean;
	onCompare: (compare: Compare) => void;
	onPrevChange: () => void;
	onNextChange: () => void;
	onAskRestore?: (() => void) | undefined;
	onCancelRestore?: (() => void) | undefined;
	onConfirmRestore?: (() => void) | undefined;
	onStartName?: (() => void) | undefined;
	onSaveName?: (() => void) | undefined;
	onCancelName?: (() => void) | undefined;
	onRemoveName?: (() => void) | undefined;
} = $props();

let nameInput = $state<HTMLInputElement | null>(null);
let confirmButton = $state<HTMLButtonElement | null>(null);
let restoreButton = $state<HTMLButtonElement | null>(null);

// Focus follows the question: the confirming button when it opens, the Restore
// button again when it is cancelled (versioning.md §5.5).
let questionWasOpen = false;
$effect(() => {
	const open = restoreQuestion !== null;
	if (open && !questionWasOpen) {
		void tick().then(() => confirmButton?.focus());
	} else if (!open && questionWasOpen && !restoring) {
		void tick().then(() => restoreButton?.focus());
	}
	questionWasOpen = open;
});

$effect(() => {
	if (naming) void tick().then(() => nameInput?.select());
});

function handleNameKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		// The field's own Escape: cancel naming and leave History where it is.
		event.preventDefault();
		event.stopPropagation();
		onCancelName?.();
	}
}

function handleNameSubmit(event: SubmitEvent) {
	event.preventDefault();
	onSaveName?.();
}

const counter = $derived(
	changeCount > 0
		? $t("artifacts.history.change.count", {
				i: Math.max(1, changeIndex + 1),
				n: changeCount,
			})
		: null,
);
</script>

<div class="toolbar" class:narrow data-testid="history-toolbar">
	<div class="row row-title">
		<div class="title-block">
			{#if label}
				<span class="named">
					<Bookmark size={12} strokeWidth={2.2} aria-hidden="true" />
					{label}
				</span>
			{/if}
			<h3 class="title" data-testid="history-title">{title}</h3>
		</div>
		{#if restoreQuestion === null}
			<div class="actions">
				{#if naming}
					<form class="name-form" onsubmit={handleNameSubmit}>
						<input
							bind:this={nameInput}
							bind:value={nameDraft}
							class="name-input"
							type="text"
							maxlength={VERSION_LABEL_MAX_CHARS}
							autocomplete="off"
							spellcheck="false"
							aria-label={$t('artifacts.history.nameField')}
							placeholder={$t('artifacts.history.namePlaceholder')}
							data-testid="history-name-input"
							disabled={namingBusy}
							onkeydown={handleNameKeydown}
						/>
						<button type="submit" class="btn-secondary btn-sm" disabled={namingBusy}>
							{$t('common.save')}
						</button>
					</form>
				{:else}
					{#if onStartName}
						<button type="button" class="action" data-testid="history-name" onclick={onStartName}>
							<Bookmark size={14} strokeWidth={2} aria-hidden="true" />
							{label ? $t('artifacts.history.rename') : $t('artifacts.history.name')}
						</button>
						{#if label && onRemoveName}
							<button type="button" class="action" data-testid="history-remove-name" onclick={onRemoveName}>
								{$t('artifacts.history.removeName')}
							</button>
						{/if}
					{/if}
					{#if canRestore && onAskRestore}
						<button
							bind:this={restoreButton}
							type="button"
							class="action action-restore"
							data-testid="history-restore"
							onclick={onAskRestore}
						>
							<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							{$t('artifacts.history.restore')}
						</button>
					{:else if restoreDisabledReason}
						<span class="note" data-testid="history-restore-note">{restoreDisabledReason}</span>
					{:else if nowLine}
						<span class="note">{$t('artifacts.history.nowLine')}</span>
					{:else if sameAsNow}
						<span class="note">{$t('artifacts.history.sameAsNow')}</span>
					{/if}
				{/if}
			</div>
		{/if}
	</div>

	{#if restoreQuestion !== null}
		<div class="question" role="group" aria-label={$t('artifacts.history.restore')} data-testid="history-restore-question">
			{#each restoreQuestion as line, index (index)}
				<p class="question-line" class:question-main={index === 0}>{line}</p>
			{/each}
			{#if restoreProblem}
				<p class="question-problem" role="alert">{restoreProblem}</p>
			{/if}
			<div class="question-actions">
				<button type="button" class="btn-ghost btn-sm" data-testid="history-restore-cancel" disabled={restoring} onclick={onCancelRestore}>
					{$t('common.cancel')}
				</button>
				<button
					bind:this={confirmButton}
					type="button"
					class="btn-primary btn-sm"
					data-testid="history-restore-confirm"
					disabled={restoring}
					onclick={onConfirmRestore}
				>
					<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
					{$t('artifacts.history.restore')}
				</button>
			</div>
		</div>
	{/if}

	{#if nameProblem}
		<p class="problem" role="alert">{nameProblem}</p>
	{/if}
	{#if nextEditsNote}
		<p class="detail">{$t('artifacts.history.nextEditsNew')}</p>
	{/if}

	<div class="row row-detail">
		<p class="detail">
			{#if detail}<span>{detail}</span><span class="sep" aria-hidden="true">&nbsp;·&nbsp;</span>{/if}<span class="fine" data-testid="history-fine">{fine}</span>
		</p>
	</div>

	<div class="row row-controls">
		{#if showCompare}
			<div class="segmented" role="group" aria-label={$t('artifacts.history.compare.a11y')}>
				<button
					type="button"
					class="seg"
					data-testid="history-compare-step"
					aria-pressed={compare === 'step'}
					disabled={stepDisabled}
					onclick={() => onCompare('step')}
				>
					{$t('artifacts.history.compare.step')}
				</button>
				<button
					type="button"
					class="seg"
					data-testid="history-compare-now"
					aria-pressed={compare === 'now'}
					onclick={() => onCompare('now')}
				>
					{$t('artifacts.history.compare.now')}
				</button>
			</div>
		{/if}
		<span class="grow"></span>
		{#if counter}
			<span class="stepper" role="group" aria-label={$t('artifacts.history.change.countA11y', { i: Math.max(1, changeIndex + 1), n: changeCount })}>
				<button
					type="button"
					class="step"
					data-testid="history-prev-change"
					aria-label={$t('artifacts.history.change.prev')}
					title={$t('artifacts.history.change.prev')}
					onclick={onPrevChange}
				>
					<ChevronUp size={14} strokeWidth={2.2} aria-hidden="true" />
				</button>
				<span class="count" data-testid="history-change-count" aria-hidden="true">{counter}</span>
				<button
					type="button"
					class="step"
					data-testid="history-next-change"
					aria-label={$t('artifacts.history.change.next')}
					title={$t('artifacts.history.change.next')}
					onclick={onNextChange}
				>
					<ChevronDown size={14} strokeWidth={2.2} aria-hidden="true" />
				</button>
			</span>
		{/if}
	</div>
</div>

<style>
	.toolbar {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.75rem 1rem 0.625rem;
		border-bottom: 1px solid var(--border-default);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.row-title {
		align-items: flex-start;
		justify-content: space-between;
	}

	.title-block {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.named {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-primary);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.named :global(svg) {
		color: var(--accent-text);
	}

	.title {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.875rem;
		font-weight: 700;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.375rem;
	}

	.action {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 1.75rem;
		padding: 0 0.625rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.action:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.action-restore {
		border-color: color-mix(in srgb, var(--accent) 35%, transparent);
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.action-restore:hover {
		background: var(--accent-tint-strong);
		color: var(--accent-text);
	}

	.action:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.note {
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.name-form {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.name-input {
		width: 13rem;
		max-width: 100%;
		height: 1.75rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
	}

	.name-input:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.question {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-md);
		background: var(--accent-tint);
	}

	.question-line {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.question-main {
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.question-problem,
	.problem {
		margin: 0;
		color: var(--danger);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.question-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding-top: 0.25rem;
	}

	.question-actions :global(button) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
	}

	.detail {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.fine {
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
	}

	.row-controls {
		flex-wrap: wrap;
	}

	.grow {
		flex: 1 1 auto;
	}

	.segmented {
		display: inline-flex;
		padding: 2px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	.seg {
		height: 1.5rem;
		padding: 0 0.625rem;
		border: 0;
		border-radius: calc(var(--radius-md) - 2px);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}

	.seg[aria-pressed='true'] {
		background: var(--surface-page);
		color: var(--text-primary);
		box-shadow: 0 1px 2px color-mix(in srgb, var(--text-primary) 14%, transparent);
	}

	.seg:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.seg:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.stepper {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.step {
		display: inline-grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.step:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.step:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.count {
		min-width: 2.25rem;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	/* The comparison switch is the widest control in Hungarian (about 290 px):
	   below 520 px it wraps under the title rather than squeezing it. */
	@media (max-width: 639px) {
		.action,
		.step {
			min-height: 2.75rem;
		}

		.step {
			min-width: 2.75rem;
		}

		.seg {
			height: 2.25rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.action {
			transition: none;
		}
	}
</style>
