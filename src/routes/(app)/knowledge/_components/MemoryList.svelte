<script lang="ts">
import { ChevronRight, Plus, Search } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import type { MemoryPage, MemoryRow } from "$lib/memory-types";
let {
	page,
	query = $bindable(""),
	scopeValue,
	projects,
	loading,
	busy,
	disabled,
	onScope,
	onSearch,
	onOpen,
	onAdd,
	onMore,
}: {
	page: MemoryPage | null;
	query: string;
	scopeValue: string;
	projects: { id: string; name: string }[];
	loading: boolean;
	busy: boolean;
	disabled: boolean;
	onScope: (value: string) => void;
	onSearch: () => void;
	onOpen: (row: MemoryRow, button: HTMLButtonElement) => void;
	onAdd: () => void;
	onMore: () => void;
} = $props();
function date(value: string) {
	const d = new Date(value);
	return Number.isNaN(d.getTime())
		? $t("memoryNew.unknownDate")
		: new Intl.DateTimeFormat($uiLanguage, { dateStyle: "medium" }).format(d);
}
</script>
<section class="memory-card" aria-busy={loading} data-testid="memory-list">
 <header class="memory-card-head">
  <div class="memory-scope-copy"><select class="memory-scope" aria-label={$t('memoryNew.space')} value={scopeValue} disabled={loading||busy} onchange={event=>onScope(event.currentTarget.value)}><option value="personal">{$t('memoryNew.personal')}</option>{#each projects as project (project.id)}<option value={project.id}>{project.name} · {$t('memoryNew.project')}</option>{/each}</select><p class="memory-description">{$t(scopeValue==='personal'?'memoryNew.personalHelp':'memoryNew.projectHelp')}</p></div>
  <button class="btn-secondary memory-button" type="button" data-memory-add onclick={onAdd} {disabled}><Plus size={16} strokeWidth={1.8} aria-hidden="true"/>{$t('memoryNew.add')}</button>
 </header>
 <form class="memory-search" onsubmit={event=>{event.preventDefault();onSearch();}} role="search"><Search size={17} strokeWidth={1.8} aria-hidden="true"/><input type="search" data-memory-search aria-label={$t('memoryNew.search')} placeholder={$t('memoryNew.search')} bind:value={query} oninput={onSearch}/></form>
 {#if loading && !page}<p class="memory-empty" role="status">{$t('memoryNew.loading')}</p>
 {:else if page?.rows.length}
  <div class="memory-list-caption"><span>{$t('memoryNew.remembered')}</span><span>{page.total}</span></div>
  <div class="memory-rows">{#each page.rows as row (`${row.ref.generation}:${row.ref.rowId}`)}<button class="memory-row" type="button" data-memory-row={row.ref.rowId} onclick={event=>onOpen(row,event.currentTarget)}><span class="memory-row-copy"><span class="memory-row-text">{row.text}</span>{#if row.updatedAt}<time datetime={row.updatedAt}>{date(row.updatedAt)}</time>{/if}</span><ChevronRight size={16} strokeWidth={1.8} class="memory-row-chevron" aria-hidden="true"/></button>{/each}</div>
  {#if page.nextCursor}<div class="memory-more"><button type="button" class="btn-secondary memory-button" onclick={onMore} disabled={loading}>{$t('memoryNew.more')}</button></div>{/if}
 {:else if page}<div class="memory-empty"><h3>{$t(query?'memoryNew.noResults':'memoryNew.empty')}</h3><p class="memory-description">{query?'':$t('memoryNew.emptyHelp')}</p>{#if query}<button type="button" class="btn-secondary memory-button" onclick={()=>{query='';onSearch();}}>{$t('memoryNew.clearSearch')}</button>{/if}</div>{/if}
</section>
