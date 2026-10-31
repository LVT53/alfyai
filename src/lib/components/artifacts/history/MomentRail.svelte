<script lang="ts">
/**
 * The History rail (ruling 76, versioning.md §5.2/§5.3): a single-select listbox
 * of moments, grouped by day, newest first, with the steps of a folded moment
 * under it. Selection follows focus: ↑/↓ step one entry, Home/End jump to the
 * ends, PageUp/PageDown move a day. Every option is named by one sentence (when,
 * who did what, what changed, where it stands) and holds no interactive content:
 * the Review and From-the-chat links are buttons beside it, reached with Tab.
 *
 * One line per entry, for every kind: what happened and when, a picture's thumbnail
 * beside it. What changed, the status and the "same as" notes stay in the DOM and
 * show on the selected entry, which also lets its headline wrap, so reading the
 * list stays reading a list. A hover only adds the tooltip: growing a row under
 * the pointer would move the row the pointer is heading for. What still waits for
 * the reader keeps its dot and its Review link on every row.
 *
 * The rail owns no data. It draws the groups it is given and reports what the
 * reader chose; `HistoryMode.svelte` loads, pages and previews.
 */
import { Bookmark } from "@lucide/svelte";
import { tick } from "svelte";
import ImagePicture from "$lib/components/artifacts/image/ImagePicture.svelte";
import { t } from "$lib/i18n";
import { IMAGE_THUMB_LONG_EDGE } from "$lib/shared/artifacts/image-body";
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
	entryIsNow,
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
	conversationId = null,
	listLabel,
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
	/** The chat the panel shows: a picture's thumbnail is read in its scope, so an incognito chat's load (F25). */
	conversationId?: string | null;
	listLabel: string;
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

/** An Image moment's picture: its rail row carries the thumbnail (plan 2b T4). A folded step has none of its own. */
function thumbOf(entry: RailEntry): string | null {
	return entry.type === "moment" && entry.moment.detail.type === "image"
		? entry.moment.detail.fileId
		: null;
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
					{@const thumb = thumbOf(entry)}
					<div
						class="entry"
						class:entry-step={entry.type === 'step'}
						class:entry-quiet={entry.type === 'moment' && entry.moment.quiet}
						class:is-selected={selected}
						role="presentation"
					>
						<div
							id={optionId(entry.key)}
							class="option"
							class:selected
							role="option"
							aria-selected={selected}
							aria-label={entryA11yName(entry, ctx, artifactKind)}
							title={entryA11yName(entry, ctx, artifactKind)}
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
							{#if thumb}
								<!-- Reserved before the picture loads; it fades in (ImagePicture). -->
								<span class="rail-thumb" aria-hidden="true" data-testid="history-thumb">
									<ImagePicture
										fileId={thumb}
										width={IMAGE_THUMB_LONG_EDGE}
										height={IMAGE_THUMB_LONG_EDGE}
										alt=""
										{conversationId}
										variant="thumb"
									/>
								</span>
							{/if}
							<span class="option-body">
								<span class="line1">
									{#if momentCanReview(entry)}
										<span class="waiting-dot" aria-hidden="true"></span>
									{/if}
									{#if entry.label}
										<span class="headline named">
											<Bookmark size={12} strokeWidth={2.2} aria-hidden="true" />
											<span class="named-text">{entry.label}</span>
										</span>
									{:else}
										<span class="headline">{headline}</span>
									{/if}
									{#if entryIsNow(entry)}
										<span class="time marker-now">{$t('artifacts.history.now')}</span>
									{:else}
										<span class="time">{span ?? entryTimeLabel(entry.at, ctx)}</span>
									{/if}
								</span>
								<span class="secondary">
									{#if entry.label}
										<span class="detail">{headline}</span>
									{/if}
									{#if detail}
										<span class="detail">{detail}</span>
									{/if}
									<span class="markers">
										{#if entry.type === 'moment' && entry.moment.status}
											<span class="pill pill-{entry.moment.status}">{statusLabel(entry.moment.status, ctx.t)}</span>
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
								</span>
							</span>
						</div>
						{#if (momentCanReview(entry) && onReview) || (fromChat(entry) && onFromChat && selected)}
							<span class="links">
								{#if momentCanReview(entry) && onReview}
									<button type="button" class="link link-review" data-testid="history-review" onclick={() => onReview(entry)}>
										{$t('artifacts.history.review')} ›
									</button>
								{/if}
								{#if fromChat(entry) && onFromChat && selected}
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
		gap: 0.25rem;
		padding: 0.75rem 0.75rem 0;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.5rem;
		padding: 0 0.5rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
	}

	.chip[aria-pressed='true'] {
		background: var(--surface-elevated);
		color: var(--text-primary);
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
		padding: 0.25rem 0.5rem 1rem;
		outline: none;
	}

	.day-heading {
		padding: 1rem 0.5rem 0.375rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.entry {
		position: relative;
	}

	/* A step of a fold: the same one line, set in under its moment and a tone down. */
	.entry-step {
		margin-left: 0.75rem;
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.4375rem 0.5rem;
		border-radius: var(--radius-md);
		cursor: pointer;
		outline: none;
	}

	.option-body {
		display: flex;
		flex: 1 1 0;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		/* The line sits centred on a thumbnail. */
		min-height: 1.25rem;
		justify-content: center;
	}

	.option:has(.rail-thumb) .option-body {
		min-height: 2rem;
	}

	.rail-thumb {
		flex: 0 0 2rem;
		width: 2rem;
		height: 2rem;
		overflow: hidden;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
	}

	.rail-thumb :global(.image-picture) {
		height: 100%;
	}

	.rail-thumb :global(.image-picture-img) {
		object-fit: cover;
	}

	/* Half of the selection's tint, not `--surface-overlay`: that token is lighter than
	   `--surface-elevated` in dark mode, which made a passing hover louder than the
	   selected row. */
	.option:hover {
		background: color-mix(in srgb, var(--surface-elevated) 50%, transparent);
	}

	.option.selected {
		background: var(--surface-elevated);
	}

	.option:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.entry-quiet .option {
		opacity: 0.72;
	}

	.line1 {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.waiting-dot {
		flex: 0 0 auto;
		align-self: center;
		width: 0.375rem;
		height: 0.375rem;
		border-radius: var(--radius-full);
		background: var(--accent);
	}

	.headline {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 400;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.option.selected .headline {
		font-weight: 500;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.entry-step .headline {
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	.named {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.named :global(svg) {
		flex-shrink: 0;
		color: var(--accent-text);
	}

	.named-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.time {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.marker-now {
		color: var(--text-primary);
		font-weight: 600;
	}

	/* Off the page for every row but the selected one; a phrase in a row's text is
	   still its accessible name. Opacity alone brings it in: the height is at once. */
	.secondary {
		display: none;
	}

	.option.selected .secondary {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		animation: rail-secondary-in var(--duration-standard) var(--ease-out);
	}

	@keyframes rail-secondary-in {
		from {
			opacity: 0;
		}
	}

	.detail {
		color: var(--text-muted);
		font-size: 0.75rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.markers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
	}

	.markers:empty {
		display: none;
	}

	.pill,
	.marker {
		color: var(--text-muted);
		font-size: 0.72rem;
		white-space: nowrap;
	}

	.pill-waiting {
		color: var(--accent-text);
		font-weight: 600;
	}

	.pill-kept {
		color: var(--success);
	}

	.links {
		display: flex;
		gap: 0.75rem;
		padding: 0 0.5rem 0.25rem;
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
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 500;
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
		align-items: baseline;
		gap: 0.5rem;
		margin: 0;
		padding: 0.625rem 1rem;
		color: var(--text-muted);
		font-size: 0.72rem;
		line-height: 1.4;
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
		font-weight: 500;
		cursor: pointer;
	}

	.help-dismiss:focus-visible {
		outline: none;
		border-radius: var(--radius-sm);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@media (max-width: 639px) {
		.option {
			min-height: 2.75rem;
			align-items: center;
			padding: 0.5rem 0.75rem;
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
		.option.selected .secondary {
			animation: none;
		}
	}
</style>
