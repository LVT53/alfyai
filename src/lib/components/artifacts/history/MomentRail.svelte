<script lang="ts">
/**
 * The History rail (ruling 76, versioning.md §5.2/§5.3): a single-select listbox
 * of moments, grouped by day, newest first, with the steps of a folded moment
 * under it. Selection follows focus: ↑/↓ step one entry, Home/End jump to the
 * ends, PageUp/PageDown move a day. Every option is named by one sentence (when,
 * who did what, what changed, where it stands) and holds no interactive content:
 * the Review and From-the-chat links are buttons beside it, reached with Tab.
 *
 * The rail owns no data. It draws the groups it is given and reports what the
 * reader chose; `HistoryMode.svelte` loads, pages and previews.
 */
import { Bookmark, CornerDownRight, Info, Sparkles } from "@lucide/svelte";
import { tick } from "svelte";
import AvatarCircle from "$lib/components/ui/AvatarCircle.svelte";
import { t } from "$lib/i18n";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import {
	dayLabel,
	entryA11yName,
	entryDetail,
	entryHeadline,
	entrySpanLabel,
	entryTimeLabel,
	statusLabel,
	type TextContext,
	whenLabel,
} from "./moment-text";
import {
	findRailEntry,
	nextRailKey,
	type RailEntry,
	type RailFilter,
	type RailGroup,
	type RailKey,
} from "./rail-model";

let {
	groups,
	selectedKey,
	ctx,
	artifactKind,
	listLabel,
	currentUser = null,
	filter,
	showFilter,
	older,
	loadingOlder,
	help = null,
	chatVersionIds = null,
	onSelect,
	onActivate,
	onFilter,
	onOlder,
	onReview = undefined,
	onFromChat = undefined,
	onDismissHelp = undefined,
}: {
	groups: RailGroup[];
	selectedKey: string | null;
	ctx: TextContext;
	artifactKind: ArtifactKind;
	listLabel: string;
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
	filter: RailFilter;
	/** The chips show once any version is named. */
	showFilter: boolean;
	older: boolean;
	loadingOlder: boolean;
	/** The one-line help at the foot, until the reader dismisses it. */
	help?: string | null;
	/** Versions whose chat message this chat holds: only those get "From the chat". */
	chatVersionIds?: ReadonlySet<string> | null;
	onSelect: (key: string) => void;
	/** Enter or a click on an option: the narrow layouts push the preview over the list. */
	onActivate: (key: string) => void;
	onFilter: (filter: RailFilter) => void;
	onOlder: () => void;
	onReview?: ((entry: RailEntry) => void) | undefined;
	onFromChat?: ((entry: RailEntry) => void) | undefined;
	onDismissHelp?: (() => void) | undefined;
} = $props();

const listId = $props.id();

let listEl = $state<HTMLElement | null>(null);

function optionId(key: string): string {
	return `${listId}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Moves the DOM focus to an option by its key, once the DOM has caught up with the selection. */
export async function focusOption(key: string | null): Promise<void> {
	if (!key) return;
	await tick();
	listEl
		?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
		?.focus({ preventScroll: false });
}

/** The first option that came in with the last page, for a keyboard reader whose "Show older" button went away. */
export function optionElements(): HTMLElement[] {
	return Array.from(
		listEl?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
	);
}

function handleKeydown(event: KeyboardEvent) {
	const key = event.key;
	if (
		key !== "ArrowDown" &&
		key !== "ArrowUp" &&
		key !== "Home" &&
		key !== "End" &&
		key !== "PageDown" &&
		key !== "PageUp" &&
		key !== "Enter" &&
		key !== " "
	) {
		return;
	}
	const target = event.target;
	if (
		!(target instanceof HTMLElement) ||
		target.getAttribute("role") !== "option"
	) {
		return;
	}
	if (event.altKey || event.ctrlKey || event.metaKey) return;
	event.preventDefault();
	const current = target.dataset.key ?? selectedKey;
	if (key === "Enter" || key === " ") {
		if (current) onActivate(current);
		return;
	}
	const next = nextRailKey(groups, current ?? null, key as RailKey);
	if (next && next !== current) {
		onSelect(next);
		void focusOption(next);
	}
}

/** The tab stop: the selected option, else the first one. */
const tabStopKey = $derived(
	findRailEntry(groups, selectedKey)?.key ?? groups[0]?.entries[0]?.key ?? null,
);

function momentCanReview(entry: RailEntry): boolean {
	return entry.type === "moment" && entry.moment.status === "waiting";
}

function fromChat(entry: RailEntry): boolean {
	return (
		entry.type === "moment" &&
		entry.author === "alfy" &&
		chatVersionIds?.has(entry.versionId) === true
	);
}
</script>

<div class="rail" data-testid="artifact-history-rail-shell">
	{#if showFilter}
		<div class="rail-filter" role="group" aria-label={$t('artifacts.history.filterA11y')}>
			<button
				type="button"
				class="chip"
				data-testid="history-filter-all"
				aria-pressed={filter === 'all'}
				onclick={() => onFilter('all')}
			>
				{$t('artifacts.history.filterAll')}
			</button>
			<button
				type="button"
				class="chip"
				data-testid="history-filter-named"
				aria-pressed={filter === 'named'}
				onclick={() => onFilter('named')}
			>
				<Bookmark size={11} strokeWidth={2.2} aria-hidden="true" />
				{$t('artifacts.history.filterNamed')}
			</button>
		</div>
	{/if}

	<div
		class="rail-list"
		role="listbox"
		aria-label={listLabel}
		data-testid="artifact-history-rail"
		bind:this={listEl}
	>
		{#each groups as group (group.dayKey)}
			{@const headingId = `${listId}-day-${group.dayKey}`}
			<div class="day" role="group" aria-labelledby={headingId}>
				<div class="day-heading" id={headingId} role="presentation">
					{dayLabel(group.at, ctx)}
				</div>
				{#each group.entries as entry (entry.key)}
					{@const selected = entry.key === selectedKey}
					{@const headline = entryHeadline(entry, ctx, artifactKind)}
					{@const detail = entryDetail(entry, ctx, artifactKind)}
					{@const span = entry.type === 'moment' ? entrySpanLabel(entry.startedAt, entry.at, ctx) : null}
					<div
						class="entry"
						class:entry-step={entry.type === 'step'}
						class:entry-quiet={entry.type === 'moment' && entry.moment.quiet}
						role="presentation"
					>
						<div
							id={optionId(entry.key)}
							class="option"
							class:selected
							role="option"
							aria-selected={selected}
							aria-label={entryA11yName(entry, ctx, artifactKind)}
							tabindex={entry.key === tabStopKey ? 0 : -1}
							data-testid="history-option"
							data-key={entry.key}
							data-version-id={entry.versionId}
							data-kind={entry.kind}
							onkeydown={handleKeydown}
							onclick={() => {
								onSelect(entry.key);
								onActivate(entry.key);
							}}
						>
							{#if entry.label}
								<span class="named">
									<Bookmark size={12} strokeWidth={2.2} aria-hidden="true" />
									<span class="named-text">{entry.label}</span>
								</span>
							{/if}
							<span class="line1">
								{#if entry.type === 'step'}
									<CornerDownRight size={13} strokeWidth={2} class="step-icon" aria-hidden="true" />
								{:else}
									<span class="avatar" aria-hidden="true">
										{#if entry.author === 'alfy'}
											<span class="alfy-avatar"><Sparkles size={12} strokeWidth={2} /></span>
										{:else}
											<AvatarCircle
												userId={currentUser?.id ?? 'user'}
												name={currentUser?.displayName ?? null}
												profilePicture={currentUser?.profilePicture ?? null}
												size={22}
											/>
										{/if}
									</span>
								{/if}
								<span class="headline">{headline}</span>
								<span class="time">{span ?? entryTimeLabel(entry.at, ctx)}</span>
							</span>
							{#if detail}
								<span class="detail">{detail}</span>
							{/if}
							<span class="markers">
								{#if entry.type === 'moment' && entry.moment.status}
									<span class="pill pill-{entry.moment.status}">{statusLabel(entry.moment.status, ctx.t)}</span>
								{/if}
								{#if entry.type === 'moment' && entry.moment.containsNewest}
									<span class="marker marker-now">{$t('artifacts.history.now')}</span>
								{:else if entry.type === 'step' && entry.isNewest}
									<span class="marker marker-now">{$t('artifacts.history.now')}</span>
								{/if}
								{#if entry.sameAsNow}
									<span class="marker">{$t('artifacts.history.sameAsNow')}</span>
								{:else if entry.sameAs}
									<span class="marker">{$t('artifacts.history.sameAs', { when: whenLabel(entry.sameAs.at, ctx) })}</span>
								{/if}
								{#if entry.type === 'moment' && entry.moment.restoredHere[0]}
									<span class="marker">{$t('artifacts.history.restoredFromHere', { when: whenLabel(entry.moment.restoredHere[0].at, ctx) })}</span>
								{/if}
								{#if entry.type === 'moment' && entry.moment.undoneBy && !entry.moment.fold}
									<span class="marker">{$t('artifacts.history.undoneLater', { when: whenLabel(entry.moment.undoneBy.at, ctx) })}</span>
								{/if}
							</span>
						</div>
						{#if (momentCanReview(entry) && onReview) || (fromChat(entry) && onFromChat)}
							<span class="links">
								{#if momentCanReview(entry) && onReview}
									<button type="button" class="link link-review" data-testid="history-review" onclick={() => onReview(entry)}>
										{$t('artifacts.history.review')} ›
									</button>
								{/if}
								{#if fromChat(entry) && onFromChat}
									<button type="button" class="link" data-testid="history-from-chat" onclick={() => onFromChat(entry)}>
										{$t('artifacts.history.fromChat')} ›
									</button>
								{/if}
							</span>
						{/if}
					</div>
				{/each}
			</div>
		{/each}

		{#if older}
			<!-- aria-disabled, not disabled: a focused button that becomes disabled loses
			     the keyboard reader's place while the next page loads. -->
			<button
				type="button"
				class="older"
				data-testid="history-older"
				aria-disabled={loadingOlder}
				onclick={() => {
					if (!loadingOlder) onOlder();
				}}
			>
				{$t('artifacts.history.older')}
			</button>
		{/if}
	</div>

	{#if help}
		<div class="help" data-testid="history-help">
			<Info size={13} strokeWidth={2} aria-hidden="true" />
			<span class="help-text">{help}</span>
			{#if onDismissHelp}
				<button type="button" class="help-dismiss" onclick={onDismissHelp}>
					{$t('artifacts.history.helpDismiss')}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		height: 100%;
	}

	.rail-filter {
		display: flex;
		gap: 0.375rem;
		padding: 0.625rem 0.875rem 0.25rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.5rem;
		padding: 0 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.chip[aria-pressed='true'] {
		border-color: color-mix(in srgb, var(--accent) 35%, transparent);
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.chip:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.rail-list {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0.25rem 0.5rem 0.75rem;
		outline: none;
	}

	.day-heading {
		padding: 0.75rem 0.5rem 0.25rem;
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.entry {
		position: relative;
		margin-bottom: 0.125rem;
	}

	.entry-step {
		margin-left: 2.125rem;
	}

	.option {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		position: relative;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
		cursor: pointer;
		outline: none;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.option:hover {
		background: var(--surface-elevated);
	}

	.option.selected {
		background: var(--accent-tint);
	}

	.option.selected::before {
		content: '';
		position: absolute;
		inset: 0.375rem auto 0.375rem 0;
		width: 2px;
		border-radius: 2px;
		background: var(--accent);
	}

	.option:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.entry-quiet .option {
		opacity: 0.72;
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
		flex-shrink: 0;
	}

	.named-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.line1 {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		min-width: 0;
	}

	.line1 :global(.step-icon) {
		flex-shrink: 0;
		margin-top: 0.1875rem;
		color: var(--text-muted);
	}

	.avatar {
		display: inline-flex;
		flex-shrink: 0;
		margin-top: 0.0625rem;
	}

	.alfy-avatar {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: var(--radius-full);
		background: var(--accent-tint-strong);
		color: var(--accent-text);
	}

	.headline {
		flex: 1 1 auto;
		min-width: 0;
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.entry-step .headline {
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	.time {
		flex: 0 0 auto;
		min-width: 2.75rem;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		white-space: nowrap;
	}

	.detail {
		padding-left: 1.875rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.entry-step .detail {
		padding-left: 1.4rem;
	}

	.markers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.375rem;
		padding-left: 1.875rem;
	}

	.entry-step .markers {
		padding-left: 1.4rem;
	}

	.markers:empty {
		display: none;
	}

	.pill,
	.marker {
		display: inline-flex;
		align-items: center;
		height: 1.125rem;
		padding: 0 0.4rem;
		border-radius: var(--radius-full);
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.pill-waiting {
		background: var(--accent-tint-strong);
		color: var(--accent-text);
	}

	.pill-kept {
		background: var(--success-tint);
		color: var(--success);
	}

	.pill-undone,
	.pill-partly_kept {
		background: var(--surface-elevated);
		color: var(--text-muted);
	}

	.marker {
		padding: 0;
		height: auto;
		color: var(--text-muted);
		font-weight: 600;
	}

	.marker-now {
		color: var(--text-primary);
		font-weight: 800;
	}

	.links {
		display: flex;
		gap: 0.75rem;
		padding: 0 0.625rem 0.375rem 2.5rem;
	}

	.link {
		min-height: 1.5rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.link-review {
		color: var(--accent-text);
	}

	.link:hover {
		text-decoration: underline;
	}

	.link:focus-visible {
		outline: none;
		border-radius: var(--radius-sm);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.older {
		display: block;
		width: 100%;
		margin-top: 0.5rem;
		min-height: 2rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
	}

	.older:hover:not([aria-disabled='true']) {
		background: var(--surface-elevated);
	}

	.older[aria-disabled='true'] {
		opacity: 0.6;
		cursor: progress;
	}

	.older:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.help {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		margin: 0;
		padding: 0.625rem 0.875rem;
		border-top: 1px solid var(--border-default);
		color: var(--text-muted);
		font-size: 0.72rem;
		line-height: 1.4;
	}

	.help :global(svg) {
		flex-shrink: 0;
		margin-top: 0.125rem;
	}

	.help-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.help-dismiss {
		flex-shrink: 0;
		padding: 0.125rem 0.25rem;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.help-dismiss:focus-visible {
		outline: none;
		border-radius: var(--radius-sm);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@media (max-width: 639px) {
		.option {
			min-height: 3.5rem;
			padding: 0.625rem 0.75rem;
		}

		.link {
			min-height: 2.75rem;
			min-width: 2.75rem;
		}

		.chip {
			height: 2rem;
		}

		.older {
			min-height: 2.75rem;
		}

		.help-dismiss {
			min-height: 2.75rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.option,
		.chip {
			transition: none;
		}
	}
</style>
