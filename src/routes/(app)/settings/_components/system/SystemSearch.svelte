<script lang="ts">
// The screen's only search, and it covers the whole screen rather than one
// table: every setting, its key, and every provider.
import { Search } from "@lucide/svelte";
import { fly } from "svelte/transition";
import { t } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import { SYSTEM_PAGE_LABEL_KEY, type SystemSearchItem } from "./pages";
import "./system.css";

// The results panel opens and closes on the same helper the rest of the
// screen uses, so it never snaps in or out.
const resultsFly = reducedMotionAware(fly);

let {
	items,
	onselect,
}: {
	items: SystemSearchItem[];
	onselect: (item: SystemSearchItem) => void;
} = $props();

let query = $state("");
let open = $state(false);
let activeIndex = $state(0);

const results = $derived.by(() => {
	const needle = query.trim().toLowerCase();
	if (needle.length < 2) return [];
	return items
		.filter(
			(item) =>
				item.label.toLowerCase().includes(needle) ||
				(item.sub ?? "").toLowerCase().includes(needle),
		)
		.slice(0, 40);
});

function choose(item: SystemSearchItem) {
	onselect(item);
	open = false;
	query = "";
}

function onkeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		open = false;
		return;
	}
	if (results.length === 0) return;
	if (event.key === "ArrowDown") {
		event.preventDefault();
		activeIndex = (activeIndex + 1) % results.length;
	} else if (event.key === "ArrowUp") {
		event.preventDefault();
		activeIndex = (activeIndex - 1 + results.length) % results.length;
	} else if (event.key === "Enter") {
		event.preventDefault();
		const item = results[activeIndex];
		if (item) choose(item);
	}
}
</script>

<div class="sys-search">
	<span class="sys-search-icon">
		<Search size={14} strokeWidth={2} aria-hidden="true" />
	</span>
	<input
		class="sys-input sys-input-wide"
		type="search"
		role="combobox"
		aria-expanded={open && query.trim().length >= 2}
		aria-controls="sys-search-results"
		aria-label={$t('admin.system.search.a11y')}
		placeholder={$t('admin.system.search.placeholder')}
		data-testid="system-search"
		bind:value={query}
		oninput={() => {
			open = true;
			activeIndex = 0;
		}}
		onfocus={() => (open = true)}
		onblur={() => setTimeout(() => (open = false), 120)}
		{onkeydown}
	/>

	{#if open && query.trim().length >= 2}
		<div
			class="sys-search-results"
			id="sys-search-results"
			role="listbox"
			transition:resultsFly={{ y: -4, duration: 140 }}
		>
			{#if results.length === 0}
				<p class="sys-search-empty">{$t('admin.system.search.empty', { query })}</p>
			{:else}
				{#each results as item, index (item.id)}
					<button
						type="button"
						role="option"
						aria-selected={index === activeIndex}
						data-active={index === activeIndex}
						class="sys-search-result"
						onmousedown={(event) => {
							event.preventDefault();
							choose(item);
						}}
						onmouseenter={() => (activeIndex = index)}
					>
						<span class="sys-grow sys-truncate">{item.label}</span>
						{#if item.sub}
							<span class="sys-key">{item.sub}</span>
						{/if}
						<span class="sys-pill sys-pill-outline">
							{$t(SYSTEM_PAGE_LABEL_KEY[item.page])}
						</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>
