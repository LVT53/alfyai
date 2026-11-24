<script lang="ts">
/**
 * An opened subject: its current entries, most recently mentioned first, and
 * its own Earlier row. On a phone it is a pushed screen with a back link to
 * Memory; on a computer a pane beside the index (memory-subjects.css).
 */
import { ChevronLeft } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type {
	MemoryScope,
	MemorySubjectEntry as Entry,
	MemorySubjectKey,
	MemorySubjectPage,
	MemorySubjectSummary,
} from "$lib/memory-types";
import MemoryEarlierFold from "./MemoryEarlierFold.svelte";
import MemorySubjectEntry from "./MemorySubjectEntry.svelte";
import { subjectWordKey } from "./memory-subject-words";
let {
	scope,
	subject,
	summary,
	page,
	loading,
	failed,
	onBack,
	onOpenEntry,
	onMore,
}: {
	scope: MemoryScope;
	subject: MemorySubjectKey;
	/** The subject's index row, for its Earlier fold; none for the Earlier list itself. */
	summary: MemorySubjectSummary | undefined;
	page: MemorySubjectPage | null;
	loading: boolean;
	failed: boolean;
	onBack: () => void;
	onOpenEntry: (entry: Entry, button: HTMLButtonElement) => void;
	onMore: () => void;
} = $props();
const headingId = $props.id();
</script>
<section class="memory-subject-pane" aria-labelledby={headingId} data-testid="memory-subject-pane">
 <button type="button" class="memory-subject-back" data-memory-subject-back aria-label={$t("memorySubjects.backLabel")} onclick={onBack}><ChevronLeft size={16} strokeWidth={1.8} aria-hidden="true"/>{$t("memorySubjects.back")}</button>
 <h3 id={headingId} class="memory-subject-title" tabindex="-1" data-memory-subject-heading>{$t(subjectWordKey(subject))}</h3>
 {#if failed && !page}<p class="memory-description">{$t("memoryNew.loadFailed")}</p>
 {:else if !page}<p class="memory-description" role="status">{$t("memoryNew.loading")}</p>
 {:else}
  {#if page.entries.length}
   <ul class="memory-entries">{#each page.entries as entry (entry.ref.rowId)}<li><MemorySubjectEntry {entry} showSubject={subject === "all"} onOpen={onOpenEntry}/></li>{/each}</ul>
   {#if page.nextCursor}<div class="memory-more"><button type="button" class="btn-secondary memory-button" disabled={loading} onclick={onMore}>{$t("memoryNew.more")}</button></div>{/if}
  {:else}<p class="memory-description">{$t("memorySubjects.nothingCurrent")}</p>{/if}
 {/if}
 {#if subject !== "all" && summary && summary.earlierCount > 0}
  {#key `${summary.subject}:${page?.generation ?? ""}`}<MemoryEarlierFold {scope} subject={summary.subject} count={summary.earlierCount} preview={summary.earlierPreview} {onOpenEntry}/>{/key}
 {/if}
</section>
