<script lang="ts">
/** A subject's own Earlier row: folded until opened, then that subject's Earlier entries, read on first open. */
import { ChevronRight } from "@lucide/svelte";
import { onDestroy } from "svelte";
import { fetchMemorySubject } from "$lib/client/api/memory";
import { t } from "$lib/i18n";
import type {
	MemoryScope,
	MemorySubject,
	MemorySubjectEntry as Entry,
	MemorySubjectPage,
} from "$lib/memory-types";
import MemorySubjectEntry from "./MemorySubjectEntry.svelte";
import { subjectWordKey } from "./memory-subject-words";
let {
	scope,
	subject,
	count,
	preview,
	onOpenEntry,
}: {
	scope: MemoryScope;
	subject: MemorySubject;
	count: number;
	preview: string[];
	onOpenEntry: (entry: Entry, button: HTMLButtonElement) => void;
} = $props();
const listId = $props.id();
let open = $state(false);
let page = $state<MemorySubjectPage | null>(null);
let loading = $state(false);
let failed = $state(false);
let abort: AbortController | undefined;
async function load(cursor?: string) {
	abort?.abort();
	abort = new AbortController();
	loading = true;
	failed = false;
	try {
		const next = await fetchMemorySubject(
			{ scope, subject, state: "earlier", ...(cursor ? { cursor } : {}) },
			abort.signal,
		);
		page =
			cursor && page
				? { ...next, entries: [...page.entries, ...next.entries] }
				: next;
	} catch (cause) {
		if (!(cause instanceof Error && cause.name === "AbortError")) failed = true;
	} finally {
		loading = false;
	}
}
function toggle() {
	open = !open;
	if (open && !page) void load();
}
onDestroy(() => abort?.abort());
</script>
<div class="memory-earlier-fold" data-testid="memory-earlier-fold">
 <button type="button" class="memory-earlier-row" aria-expanded={open} aria-controls={listId} onclick={toggle}>
  <ChevronRight size={14} strokeWidth={2} class={open ? "memory-earlier-caret memory-chevron-open" : "memory-earlier-caret"} aria-hidden="true"/>
  <span class="memory-earlier-copy"><span class="memory-earlier-title">{$t("memorySubjects.earlierIn", { subject: $t(subjectWordKey(subject)) })} · {count}</span> {#if !open && preview.length}<span class="memory-earlier-preview">{preview.join(", ")}</span>{/if}</span>
 </button>
 {#if open}
  <div id={listId} class="memory-earlier-entries">
   {#if failed}<p class="memory-description">{$t("memoryNew.loadFailed")}</p>
   {:else if !page}<p class="memory-description" role="status">{$t("memoryNew.loading")}</p>
   {:else}
    <ul class="memory-entries">{#each page.entries as entry (entry.ref.rowId)}<li><MemorySubjectEntry {entry} onOpen={onOpenEntry}/></li>{/each}</ul>
    {#if page.nextCursor}<div class="memory-more"><button type="button" class="btn-secondary memory-button" disabled={loading} onclick={() => void load(page?.nextCursor ?? undefined)}>{$t("memoryNew.more")}</button></div>{/if}
   {/if}
  </div>
 {/if}
</div>
