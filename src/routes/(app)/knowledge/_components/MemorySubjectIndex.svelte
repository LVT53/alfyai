<script lang="ts">
/**
 * The Memory page once an account's labels are verified (layout C): the
 * scope, Add, the Overview row, search, and the subject index with its
 * Earlier row; an opened subject beside it on a computer, in its place on a
 * phone. A search shows today's result rows. Presentational: the view that
 * mounts it owns every read and every change (KnowledgeMemoryView).
 */
import { ChevronRight, Plus, Search, Sparkle } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type {
	MemoryPage,
	MemoryRow,
	MemorySubjectEntry as Entry,
	MemorySubjectIndex,
	MemorySubjectKey,
	MemorySubjectPage,
} from "$lib/memory-types";
import { uiLanguage } from "$lib/stores/settings";
import MemorySubjectPane from "./MemorySubjectPane.svelte";
import { subjectWordKey } from "./memory-subject-words";
import "./memory-subjects.css";
let {
	index,
	page,
	query = $bindable(""),
	scopeValue,
	projects,
	loading,
	indexFailed,
	disabled,
	opened,
	subjectPage,
	subjectLoading,
	subjectFailed,
	onScope,
	onSearch,
	onOpen,
	onAdd,
	onMore,
	onOpenSubject,
	onCloseSubject,
	onSubjectMore,
	onOpenOverview,
}: {
	index: MemorySubjectIndex | null;
	/** Search results: today's list. */
	page: MemoryPage | null;
	query: string;
	scopeValue: string;
	projects: { id: string; name: string }[];
	loading: boolean;
	indexFailed: boolean;
	disabled: boolean;
	opened: MemorySubjectKey | null;
	subjectPage: MemorySubjectPage | null;
	subjectLoading: boolean;
	subjectFailed: boolean;
	onScope: (value: string) => void;
	onSearch: () => void;
	onOpen: (row: MemoryRow, button: HTMLButtonElement) => void;
	onAdd: () => void;
	onMore: () => void;
	onOpenSubject: (subject: MemorySubjectKey, button: HTMLButtonElement) => void;
	onCloseSubject: () => void;
	onSubjectMore: () => void;
	onOpenOverview: () => void;
} = $props();
const searching = $derived(query.trim().length > 0);
const showOpened = $derived(opened !== null && !searching);
const openedSummary = $derived(
	index?.subjects.find((item) => item.subject === opened),
);
function date(value: string) {
	const d = new Date(value);
	return Number.isNaN(d.getTime())
		? $t("memoryNew.unknownDate")
		: new Intl.DateTimeFormat($uiLanguage, { dateStyle: "medium" }).format(d);
}
function openEntry(entry: Entry, button: HTMLButtonElement) {
	onOpen(
		{
			ref: entry.ref,
			text: entry.text,
			updatedAt: entry.lastMentionedAt,
			sourceCount: 0,
		},
		button,
	);
}
</script>
<section class="memory-card memory-subjects" class:memory-subjects-has-subject={showOpened} aria-busy={loading} data-testid="memory-subjects">
 <div class="memory-subjects-top">
  <select class="memory-scope memory-subjects-scope" aria-label={$t("memoryNew.space")} value={scopeValue} disabled={loading} onchange={(event) => onScope(event.currentTarget.value)}><option value="personal">{$t("memoryNew.personal")}</option>{#each projects as project (project.id)}<option value={project.id}>{project.name} · {$t("memoryNew.project")}</option>{/each}</select>
  <button class="btn-secondary memory-button memory-subjects-add" type="button" data-memory-add onclick={onAdd} {disabled}><Plus size={16} strokeWidth={1.8} aria-hidden="true"/>{$t("memorySubjects.add")}</button>
  {#if !searching && index && index.currentCount > 0}
   <button class="memory-overview-row" type="button" data-memory-overview onclick={onOpenOverview}>
    <span class="memory-overview-mark"><Sparkle size={16} strokeWidth={1.8} aria-hidden="true"/></span>
    <span class="memory-overview-copy"><span class="memory-overview-title">{$t(scopeValue === "personal" ? "memorySubjects.overviewPersonal" : "memorySubjects.overviewProject")}</span><span class="memory-overview-hint">{$t("memorySubjects.overviewHint")}</span></span>
    <ChevronRight size={16} strokeWidth={1.8} class="memory-overview-chevron" aria-hidden="true"/>
   </button>
  {/if}
  <form class="memory-search memory-subjects-search" onsubmit={(event) => { event.preventDefault(); onSearch(); }} role="search"><Search size={17} strokeWidth={1.8} aria-hidden="true"/><input type="search" data-memory-search aria-label={$t("memorySubjects.search")} placeholder={$t("memorySubjects.search")} bind:value={query} oninput={onSearch}/></form>
 </div>
 {#if searching}
  {#if loading && !page}<p class="memory-empty" role="status">{$t("memoryNew.loading")}</p>
  {:else if page?.rows.length}
   <div class="memory-list-caption"><span>{$t("memoryNew.remembered")}</span><span>{page.total}</span></div>
   <div class="memory-rows">{#each page.rows as row (`${row.ref.generation}:${row.ref.rowId}`)}<button class="memory-row" type="button" data-memory-row={row.ref.rowId} onclick={(event) => onOpen(row, event.currentTarget)}><span class="memory-row-copy"><span class="memory-row-text">{row.text}</span>{#if row.updatedAt}<time datetime={row.updatedAt}>{date(row.updatedAt)}</time>{/if}</span><ChevronRight size={16} strokeWidth={1.8} class="memory-row-chevron" aria-hidden="true"/></button>{/each}</div>
   {#if page.nextCursor}<div class="memory-more"><button type="button" class="btn-secondary memory-button" onclick={onMore} disabled={loading}>{$t("memoryNew.more")}</button></div>{/if}
  {:else if page}<div class="memory-empty"><h3>{$t("memoryNew.noResults")}</h3><button type="button" class="btn-secondary memory-button" onclick={() => { query = ""; onSearch(); }}>{$t("memoryNew.clearSearch")}</button></div>{/if}
 {:else if !index}
  {#if indexFailed}<p class="memory-empty">{$t("memoryNew.loadFailed")}</p>{:else}<p class="memory-empty" role="status">{$t("memoryNew.loading")}</p>{/if}
 {:else if index.subjects.length === 0 && index.earlier.count === 0}
  <div class="memory-empty"><h3>{$t("memoryNew.empty")}</h3><p class="memory-description">{$t("memoryNew.emptyHelp")}</p></div>
 {:else}
  <div class="memory-subjects-body">
   <nav class="memory-subject-index" aria-label={$t("memorySubjects.subjects")}>
    {#each index.subjects as item (item.subject)}
     <button type="button" class="memory-subject-row" class:memory-subject-current={opened === item.subject} aria-current={opened === item.subject ? "true" : undefined} data-memory-subject={item.subject} onclick={(event) => onOpenSubject(item.subject, event.currentTarget)}>
      <span class="memory-subject-head"><span class="memory-subject-name">{$t(subjectWordKey(item.subject))}</span> {#if item.active}<span class="memory-tag">{$t("memorySubjects.active")}</span>{/if}</span>
      <span class="memory-subject-count">{item.count}<ChevronRight size={14} strokeWidth={1.8} class="memory-subject-chevron" aria-hidden="true"/></span>
      <span class="memory-subject-preview">{item.preview}</span>
     </button>
    {/each}
    {#if index.earlier.count > 0}
     <button type="button" class="memory-earlier-row memory-index-earlier" class:memory-subject-current={opened === "all"} aria-current={opened === "all" ? "true" : undefined} data-memory-subject="all" onclick={(event) => onOpenSubject("all", event.currentTarget)}>
      <ChevronRight size={14} strokeWidth={2} class="memory-earlier-caret" aria-hidden="true"/>
      <span class="memory-earlier-copy"><span class="memory-earlier-title">{$t("memorySubjects.earlier")} <span class="memory-earlier-dot">·</span> <span class="memory-earlier-count">{index.earlier.count}</span></span> {#if index.earlier.preview.length}<span class="memory-earlier-preview">{index.earlier.preview.join(", ")}</span>{/if}</span>
     </button>
    {/if}
   </nav>
   {#if showOpened && opened}
    <MemorySubjectPane scope={index.scope} subject={opened} summary={openedSummary} page={subjectPage} loading={subjectLoading} failed={subjectFailed} onBack={onCloseSubject} onOpenEntry={openEntry} onMore={onSubjectMore}/>
   {/if}
  </div>
 {/if}
</section>
