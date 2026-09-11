<script lang="ts">
// One memory category: its own total, how much of it is on screen, and a
// single disclosure row at the bottom. Opening a category expands it IN PLACE
// — the rows grow below this section's own heading, so the heading does not
// move and the sections above it do not either. That, and nothing else, is
// what keeps the reader where they were; see toggleKeepingPosition below.
import { slide } from "svelte/transition";
import type { MemoryProfilePublicItem } from "$lib/memory-profile-types";
import type { I18nKey } from "$lib/i18n";
import { t } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import {
	ChevronDown,
	ChevronUp,
	ShieldCheck,
	SlidersHorizontal,
	Target,
	User,
} from "@lucide/svelte";
import MemoryRow from "./MemoryRow.svelte";
import {
	MEMORY_CATEGORY_PAGE_SIZE,
	type MemoryCategoryView,
} from "./memory-categories";

// Both directions: the section eases open AND eased shut, collapsing to an
// instant change under prefers-reduced-motion (the CSS reset in app.css
// cannot reach a JS-driven Svelte transition — see motion.ts).
const revealRows = reducedMotionAware(slide);

let {
	view,
	labelKey,
	emptyKey,
	pendingActionKey = null,
	onToggle,
	onEditItem,
	onRemoveItem,
}: {
	view: MemoryCategoryView;
	labelKey: I18nKey;
	emptyKey: I18nKey;
	pendingActionKey?: string | null;
	onToggle: () => void;
	onEditItem: (item: MemoryProfilePublicItem) => void;
	onRemoveItem: (item: MemoryProfilePublicItem) => void;
} = $props();

const headingId = $derived(`memory-category-${view.category}`);
const label = $derived($t(labelKey));

// "23 remembered · showing 8" normally; "3 of 23 match" while a filter is on.
// A filtered count that looks like a total is how people come to believe the
// assistant forgot something.
const countLine = $derived(
	view.filtered
		? $t("memoryProfile.categoryFilteredCount", {
				matching: view.matching,
				total: view.total,
			})
		: $t("memoryProfile.categoryCount", {
				total: view.total,
				shown: view.visible.length,
			}),
);

const disclosureLabel = $derived(
	view.expanded
		? $t("memoryProfile.showFewer")
		: view.total === view.matching
			? $t("memoryProfile.showAll", { total: view.total })
			: $t("memoryProfile.showRemaining", { count: view.hiddenCount }),
);

/**
 * Expanding and collapsing happen IN PLACE: the rows live below this section's
 * heading, so the heading itself never moves and the sections above it never
 * move either — which is the whole of "you never lose your position".
 *
 * There used to be a scroll correction here. It measured the section's top
 * before and after the toggle and called `window.scrollBy` — on a page that
 * scrolls inside `.main-content`, so it moved nothing, and it read the
 * geometry one tick in, before the 180ms reveal had changed any of it. Worth
 * naming why it is gone rather than quietly fixed: the only case where the
 * heading DOES move is collapsing while scrolled past the rows being removed,
 * and there the container is pinned to the end of a page that just got
 * shorter. There is no scroll position left to restore — the reader asked for
 * the content they were looking at to be put away.
 */
function toggleKeepingPosition() {
	onToggle();
}
</script>

<section
	class="memory-section"
	aria-labelledby={headingId}
	data-category={view.category}
	data-expanded={view.expanded}
>
	<div class="memory-section-head">
		<span class="memory-section-icon" aria-hidden="true">
			{#if view.category === "about_you"}
				<User size={15} strokeWidth={2} />
			{:else if view.category === "preferences"}
				<SlidersHorizontal size={15} strokeWidth={2} />
			{:else if view.category === "goals_ongoing_work"}
				<Target size={15} strokeWidth={2} />
			{:else}
				<ShieldCheck size={15} strokeWidth={2} />
			{/if}
		</span>
		<h3 id={headingId} class="memory-section-title">{label}</h3>
		<span class="memory-section-count" data-testid="memory-category-count">
			{countLine}
		</span>
		<span class="memory-section-spacer"></span>
		{#if view.hiddenCount > 0 || view.expanded}
			<button
				type="button"
				class="memory-disclosure memory-disclosure--head"
				onclick={toggleKeepingPosition}
				aria-expanded={view.expanded}
				aria-controls={`${headingId}-rows`}
				aria-label={view.expanded
					? $t("memoryProfile.collapseCategory", { name: label })
					: $t("memoryProfile.expandCategory", { name: label })}
			>
				{#if view.expanded}
					<ChevronUp size={11} strokeWidth={2.2} aria-hidden="true" />
					<span>{$t("memoryProfile.collapse")}</span>
				{:else}
					<ChevronDown size={11} strokeWidth={2.2} aria-hidden="true" />
					<span>{$t("memoryProfile.expand")}</span>
				{/if}
			</button>
		{/if}
	</div>

	<div id={`${headingId}-rows`} class="memory-section-rows">
		{#if view.total === 0}
			<p class="memory-section-empty">{$t(emptyKey)}</p>
			<p class="memory-section-empty">
				{$t("memoryProfile.emptyHint")}
				<a class="memory-section-link" href="/settings?section=memory">
					{$t("memoryProfile.emptyHintLink")}
				</a>
			</p>
		{:else if view.matching === 0}
			<p class="memory-section-empty">{$t("memoryProfile.categoryNoMatch")}</p>
		{:else}
			{#each view.visible as item, index (item.id)}
				{#if index < MEMORY_CATEGORY_PAGE_SIZE}
					<MemoryRow
						{item}
						{pendingActionKey}
						first={index === 0}
						onEdit={onEditItem}
						onRemove={onRemoveItem}
					/>
				{:else}
					<div transition:revealRows={{ duration: 180 }}>
						<MemoryRow
							{item}
							{pendingActionKey}
							onEdit={onEditItem}
							onRemove={onRemoveItem}
						/>
					</div>
				{/if}
			{/each}
		{/if}
	</div>

	{#if view.hiddenCount > 0 || view.expanded}
		<div class="memory-section-foot">
			<button
				type="button"
				class="memory-disclosure"
				onclick={toggleKeepingPosition}
				aria-expanded={view.expanded}
				aria-controls={`${headingId}-rows`}
				data-testid="memory-category-disclosure"
			>
				{#if view.expanded}
					<ChevronUp size={11} strokeWidth={2.2} aria-hidden="true" />
				{:else}
					<ChevronDown size={11} strokeWidth={2.2} aria-hidden="true" />
				{/if}
				<span>{disclosureLabel}</span>
			</button>
			{#if view.hiddenCount > 0}
				<span class="memory-section-more">
					{$t("memoryProfile.moreNewestFirst", { count: view.hiddenCount })}
				</span>
			{/if}
		</div>
	{/if}
</section>

<style>
	.memory-section {
		/* One gutter for the whole section: the heading's icon, every row's
		   provenance dot and the disclosure's chevron all start here, so the
		   statements, the title and the disclosure label line up down a single
		   left edge. The dot column used to be 19.2px and the icon column 23px,
		   which put the section title 4px right of the facts under it. */
		--memory-gutter: 1.4rem;
		border-top: 1px solid var(--border-default);
		padding: 0.85rem 1.15rem;
	}

	/* Baseline, not centre: the count is 0.68rem beside a 0.86rem title, and
	   centring two different type sizes leaves neither of them on a line. */
	.memory-section-head {
		display: flex;
		align-items: baseline;
		gap: 0.35rem 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.45rem;
	}

	/* The icon owns the gutter exactly: the negative margin cancels the row's
	   own gap for this one item, so the title begins on the gutter's edge —
	   the same x the statements below it begin on. */
	.memory-section-icon {
		display: inline-flex;
		align-self: center;
		flex: 0 0 var(--memory-gutter);
		margin-right: -0.5rem;
		color: var(--accent);
	}

	.memory-section-title {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.memory-section-count {
		font-family: var(--font-sans);
		font-size: 0.68rem;
		color: var(--text-muted);
	}

	.memory-section-spacer {
		flex: 1 1 auto;
	}

	.memory-section-empty {
		margin: 0.35rem 0 0;
		padding-left: var(--memory-gutter);
		font-family: var(--font-sans);
		font-size: 0.76rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.memory-section-link {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.memory-section-link:hover {
		color: var(--accent-hover);
	}

	.memory-section-foot {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		/* The button's own border and padding are subtracted so its chevron —
		   not its border — lands on the gutter, beside the dots above it. */
		padding: 0.6rem 0 0 calc(var(--memory-gutter) - 0.55rem - 1px);
	}

	.memory-section-more {
		font-family: var(--font-sans);
		font-size: 0.68rem;
		color: var(--text-muted);
	}

	.memory-disclosure {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 1.6rem;
		padding: 0 0.55rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out);
	}

	.memory-disclosure:hover,
	.memory-disclosure:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 8%, transparent 92%);
	}

	.memory-disclosure:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.memory-disclosure--head {
		align-self: center;
	}

	@media (prefers-reduced-motion: reduce) {
		.memory-disclosure,
		.memory-section-link {
			transition: none !important;
		}
	}
</style>
