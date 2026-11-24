<script lang="ts">
/** One entry of an opened subject or an Earlier fold: its text, its earlier states, when it was last mentioned. */
import { t } from "$lib/i18n";
import type { MemorySubjectEntry } from "$lib/memory-types";
import { uiLanguage } from "$lib/stores/settings";
import { subjectWordKey } from "./memory-subject-words";
import { mentionedWhen, monthAndYear } from "./memory-when";
let {
	entry,
	showSubject = false,
	onOpen,
}: {
	entry: MemorySubjectEntry;
	/** Name the entry's subject (the Earlier list across subjects). */
	showSubject?: boolean;
	onOpen: (entry: MemorySubjectEntry, button: HTMLButtonElement) => void;
} = $props();
const when = $derived(
	mentionedWhen(entry.lastMentionedAt, new Date(), $uiLanguage),
);
const whenWords = $derived(
	when === null
		? null
		: when.kind === "today"
			? $t("memorySubjects.today")
			: when.kind === "yesterday"
				? $t("memorySubjects.yesterday")
				: when.kind === "daysAgo"
					? $t("memorySubjects.daysAgo", { count: when.count })
					: when.text,
);
</script>
<button type="button" class="memory-entry" data-memory-row={entry.ref.rowId} onclick={(event) => onOpen(entry, event.currentTarget)}>
 <span class="memory-entry-text">{entry.text}</span>
 {#each entry.earlierStates as state, index (index)}
  {@const said = monthAndYear(state.saidAt, $uiLanguage)}
  <span class="memory-entry-earlier">{said ? $t("memorySubjects.earlierState", { text: state.text, when: said }) : $t("memorySubjects.earlierStateUndated", { text: state.text })}</span>
 {/each}
 <span class="memory-entry-meta">
  {#if showSubject}<span>{$t(subjectWordKey(entry.subject))}</span>{/if}
  {#if whenWords}<span>{$t("memorySubjects.lastMentioned", { when: whenWords })}</span>{/if}
  {#if entry.kind === "ongoing" && entry.timeState === "current"}<span class="memory-tag">{$t("memorySubjects.active")}</span>
  {:else if entry.timeState === "quiet" && entry.quietWeeks !== null}<span class="memory-tag memory-tag-quiet">{$t("memorySubjects.quiet", { weeks: entry.quietWeeks })}</span>{/if}
 </span>
</button>
