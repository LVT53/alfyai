<script lang="ts">
// The portrait: the summary AlfyAI actually reads, then the facts it is built
// from. A filter sits between the two because fifty-two memories is past
// reading — one box filters every category at once by the words in a memory,
// and the chips beside it narrow to one category and carry its count.
import type {
	MemoryProfileCategory,
	MemoryProfilePublicItem,
	MemoryProfilePublicPayload,
} from "$lib/memory-profile-types";
import type { I18nKey } from "$lib/i18n";
import { t } from "$lib/i18n";
import { Search, X } from "@lucide/svelte";
import PersonaSummaryCard from "./PersonaSummaryCard.svelte";
import MemoryCategorySection from "./MemoryCategorySection.svelte";
import {
	buildMemoryCategoryViews,
	buildMemoryFilterChips,
	type MemoryCategorySelection,
} from "./memory-categories";

interface CategoryDefinition {
	category: MemoryProfileCategory;
	label: I18nKey;
	empty: I18nKey;
}

let {
	profile,
	categoryDefinitions,
	activeCount,
	summary = null,
	summaryBusy = false,
	pendingActionKey = null,
	expanded,
	filterText = "",
	selection = "all",
	onEditSummary,
	onFilterTextChange,
	onSelectionChange,
	onToggleCategory,
	onEditItem,
	onRemoveItem,
}: {
	profile: MemoryProfilePublicPayload | null;
	categoryDefinitions: readonly CategoryDefinition[];
	activeCount: number;
	summary?: {
		text: string;
		links?: Array<{ text: string; factIds: string[] }>;
		updatedAt: string;
	} | null;
	summaryBusy?: boolean;
	pendingActionKey?: string | null;
	expanded: ReadonlySet<MemoryProfileCategory>;
	filterText?: string;
	selection?: MemoryCategorySelection;
	onEditSummary: (
		text: string,
	) => boolean | undefined | Promise<boolean | undefined>;
	onFilterTextChange: (value: string) => void;
	onSelectionChange: (value: MemoryCategorySelection) => void;
	onToggleCategory: (category: MemoryProfileCategory) => void;
	onEditItem: (item: MemoryProfilePublicItem) => void;
	onRemoveItem: (item: MemoryProfilePublicItem) => void;
} = $props();

const order = $derived(
	categoryDefinitions.map((definition) => definition.category),
);

const chips = $derived(buildMemoryFilterChips({ profile, order, filterText }));

const views = $derived(
	buildMemoryCategoryViews({
		profile,
		order,
		filterText,
		selection,
		expanded,
	}),
);

const definitionFor = (category: MemoryProfileCategory) =>
	categoryDefinitions.find((definition) => definition.category === category);

function chipLabel(id: MemoryCategorySelection): string {
	if (id === "all") return $t("memoryProfile.filterAll");
	const definition = definitionFor(id);
	return definition ? $t(definition.label) : id;
}

const filtering = $derived(filterText.trim().length > 0);

// Every category empty of matches, with a filter on — say so once, at the top,
// rather than four times over. Measured against the ALL chip, not the drawn
// sections: with one category picked, `views` holds only that category, and
// "No memory matches nextcloud" would contradict the chips beside it still
// counting four that do. A picked category with nothing in it says so in its
// own section instead.
const noMatchesAnywhere = $derived(
	filtering && (chips.find((chip) => chip.id === "all")?.matching ?? 0) === 0,
);
</script>

<section class="memory-portrait" aria-labelledby="persona-summary-title">
	<PersonaSummaryCard
		flush
		factCount={activeCount}
		{summary}
		busy={summaryBusy}
		hasFacts={activeCount > 0}
		onEdit={onEditSummary}
	/>

	<div class="memory-filter-bar">
		<div class="memory-filter-row">
			<div class="memory-filter-input">
				<Search size={14} strokeWidth={2} aria-hidden="true" />
				<!-- A function binding rather than a bare `value` + `oninput`: the
				     parent owns the filter text, and binding attaches the listener
				     to the input itself the way every other search box in the app
				     does. -->
				<input
					type="search"
					bind:value={() => filterText, (value) => onFilterTextChange(value)}
					placeholder={$t("memoryProfile.filterPlaceholder")}
					aria-label={$t("memoryProfile.filterLabel")}
				/>
				{#if filtering}
					<button
						type="button"
						class="memory-filter-clear"
						onclick={() => onFilterTextChange("")}
						aria-label={$t("memoryProfile.clearFilter")}
						title={$t("memoryProfile.clearFilter")}
					>
						<X size={12} strokeWidth={2.2} aria-hidden="true" />
					</button>
				{/if}
			</div>

			<div
				class="memory-filter-chips"
				role="group"
				aria-label={$t("memoryProfile.filterByCategory")}
			>
				{#each chips as chip (chip.id)}
					<button
						type="button"
						class="memory-chip-button"
						class:is-active={selection === chip.id}
						onclick={() => onSelectionChange(chip.id)}
						aria-pressed={selection === chip.id}
						aria-label={$t("memoryProfile.filterChipLabel", {
							name: chipLabel(chip.id),
							// The same count the chip prints. Reading out the total
							// while the chip shows the matches is how a screen-reader
							// user comes to believe the filter did nothing.
							count: filtering ? chip.matching : chip.total,
						})}
						data-testid="memory-filter-chip"
					>
						<span>{chipLabel(chip.id)}</span>
						<span class="memory-chip-count">
							{filtering ? chip.matching : chip.total}
						</span>
					</button>
				{/each}
			</div>
		</div>
		<p class="memory-filter-hint">{$t("memoryProfile.filterHint")}</p>
	</div>

	{#if noMatchesAnywhere}
		<p class="memory-portrait-empty" data-testid="memory-filter-no-matches">
			{$t("memoryProfile.filterNoMatches", { query: filterText.trim() })}
		</p>
	{/if}

	{#each views as view (view.category)}
		{@const definition = definitionFor(view.category)}
		{#if definition}
			<MemoryCategorySection
				{view}
				labelKey={definition.label}
				emptyKey={definition.empty}
				{pendingActionKey}
				onToggle={() => onToggleCategory(view.category)}
				{onEditItem}
				{onRemoveItem}
			/>
		{/if}
	{/each}
</section>

<style>
	.memory-portrait {
		border: 1px solid var(--border-default);
		border-radius: var(--knowledge-card-radius, 1rem);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
		overflow: hidden;
		min-width: 0;
	}

	.memory-filter-bar {
		padding: 0.85rem 1.15rem;
		border-top: 1px solid var(--border-default);
		background: var(--surface-page);
	}

	.memory-filter-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.6rem;
	}

	.memory-filter-input {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex: 1 1 240px;
		max-width: 22rem;
		min-width: 0;
		height: 1.85rem;
		padding: 0 0.6rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-elevated);
		color: var(--text-muted);
		transition:
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	.memory-filter-input:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent 85%);
	}

	.memory-filter-input input {
		flex: 1 1 auto;
		min-width: 0;
		border: none;
		outline: none;
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.76rem;
	}

	.memory-filter-input input::placeholder {
		color: var(--text-muted);
	}

	.memory-filter-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.1rem;
		height: 1.1rem;
		border: none;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.memory-filter-clear:hover {
		color: var(--text-primary);
		background: color-mix(in srgb, var(--text-primary) 10%, transparent 90%);
	}

	/* Left-aligned, like every other row of controls on the page. Pushed to
	   the right edge they read as a stray cluster floating away from the
	   filter box they belong to. */
	.memory-filter-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		flex: 1 1 auto;
		justify-content: flex-start;
		min-width: 0;
	}

	.memory-chip-button {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		/* One height with the filter box beside it, so the row reads as a
		   single band rather than as a tall control and a short one. */
		height: 1.85rem;
		padding: 0 0.6rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-elevated);
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	/* A chip that does nothing on hover is indistinguishable from the label it
	   looks like. The fill is the same 12% step the buttons take — and it
	   carries the chip's own pill radius, restated here so the fill can never
	   be painted as a rectangle over a pill (see
	   hover-affordances.regression.test.ts). */
	.memory-chip-button:hover,
	.memory-chip-button:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated) 92%);
		color: var(--accent);
	}

	.memory-chip-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.memory-chip-button.is-active {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-default) 60%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--accent);
	}

	.memory-chip-button.is-active:hover {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--accent) 18%, var(--surface-elevated) 82%);
	}

	.memory-chip-count {
		font-variant-numeric: tabular-nums;
		opacity: 0.75;
	}

	.memory-filter-hint {
		margin: 0.6rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.68rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.memory-portrait-empty {
		margin: 0;
		padding: 0.9rem 1.15rem;
		border-top: 1px solid var(--border-default);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	@media (max-width: 720px) {
		.memory-filter-input {
			max-width: 100%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.memory-filter-input,
		.memory-chip-button {
			transition: none !important;
		}
	}
</style>
