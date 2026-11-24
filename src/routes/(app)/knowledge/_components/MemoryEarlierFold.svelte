<script lang="ts">
/**
 * A subject's own Earlier row: folded until opened, then that subject's
 * Earlier entries, read on first open. A More that fails (a stale cursor, 409,
 * once Memory moved on included) keeps the entries already shown and offers
 * Try again, which reads them from the top again, as many pages as were shown
 * and the one asked for.
 */
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
// The first read failed: nothing is shown. A later one failed: `moreFailed`.
let failed = $state(false);
let moreFailed = $state(false);
// How many pages are shown, so that a read from the top gives them back.
let pagesShown = 0;
let abort: AbortController | undefined;
/** Reads the entries after `cursor`, or from the top as many pages as `pages`. */
async function load(options: { cursor?: string; pages?: number } = {}) {
	const { cursor, pages = 1 } = options;
	abort?.abort();
	const mine = new AbortController();
	abort = mine;
	loading = true;
	failed = false;
	moreFailed = false;
	const read = (after?: string) =>
		fetchMemorySubject(
			{ scope, subject, state: "earlier", ...(after ? { cursor: after } : {}) },
			mine.signal,
		);
	try {
		let result = await read(cursor);
		let entries =
			cursor && page ? [...page.entries, ...result.entries] : result.entries;
		let count = cursor ? pagesShown + 1 : 1;
		while (!cursor && count < pages && result.nextCursor) {
			result = await read(result.nextCursor);
			entries = [...entries, ...result.entries];
			count++;
		}
		page = { ...result, entries };
		pagesShown = count;
	} catch (cause) {
		if (cause instanceof Error && cause.name === "AbortError") return;
		if (page) moreFailed = true;
		else failed = true;
	} finally {
		if (abort === mine) loading = false;
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
  <ChevronRight size={14} strokeWidth={2} class={open ? "memory-earlier-caret memory-earlier-caret-open" : "memory-earlier-caret"} aria-hidden="true"/>
  <span class="memory-earlier-copy"><span class="memory-earlier-title">{$t("memorySubjects.earlierIn", { subject: $t(subjectWordKey(subject)) })} · {count}</span> {#if !open && preview.length}<span class="memory-earlier-preview">{preview.join(", ")}</span>{/if}</span>
 </button>
 {#if open}
  <div id={listId} class="memory-earlier-entries">
   {#if failed}<p class="memory-description">{$t("memoryNew.loadFailed")}</p>
   {:else if !page}<p class="memory-description" role="status">{$t("memoryNew.loading")}</p>
   {:else}
    <ul class="memory-entries">{#each page.entries as entry (entry.ref.rowId)}<li><MemorySubjectEntry {entry} onOpen={onOpenEntry}/></li>{/each}</ul>
    {#if moreFailed}<div class="memory-more"><p class="memory-description" role="alert">{$t("memoryNew.loadFailed")}</p><button type="button" class="btn-secondary memory-button" disabled={loading} onclick={() => void load({ pages: pagesShown + 1 })}>{$t("memorySubjects.tryAgain")}</button></div>
    {:else if page.nextCursor}<div class="memory-more"><button type="button" class="btn-secondary memory-button" disabled={loading} onclick={() => void load({ cursor: page?.nextCursor ?? undefined })}>{$t("memoryNew.more")}</button></div>{/if}
   {/if}
  </div>
 {/if}
</div>
