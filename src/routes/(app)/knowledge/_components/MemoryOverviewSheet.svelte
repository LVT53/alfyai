<script lang="ts">
/**
 * The Overview of a scope (Memory part 3): a bottom sheet on a phone, a
 * centred dialog on a computer. Opening it shows the kept Overview, or writes
 * one with the local model ("Writing your overview…"), then the paragraph,
 * what it was written from, Rewrite and Done. Closing it while it is written
 * leaves the writing to finish on the server, so it is there next time.
 */
import { LoaderCircle, Sparkle, X } from "@lucide/svelte";
import { onMount } from "svelte";
import {
	fetchMemoryOverview,
	writeMemoryOverview,
} from "$lib/client/api/memory";
import { ApiError } from "$lib/client/api/http";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import type { MemoryOverview, MemoryScope } from "$lib/memory-types";
import { uiLanguage } from "$lib/stores/settings";
import { mentionedWhen } from "./memory-when";
let {
	scope,
	title,
	onClose,
}: {
	scope: MemoryScope;
	title: string;
	onClose: () => void;
} = $props();
let phase = $state<"loading" | "writing" | "written" | "failed">("loading");
let overview = $state<MemoryOverview | null>(null);
// How many entries the Overview is written from; 0 until the kept Overview's
// read has said (when that read fails it is not known, and the sheet does not
// claim a number).
let count = $state(0);
let changed = $state(false);
const abort = new AbortController();
const JUST_NOW_MS = 120_000;
function aborted(cause: unknown) {
	return cause instanceof Error && cause.name === "AbortError";
}
async function write(rewrite: boolean) {
	phase = "writing";
	changed = false;
	try {
		const result = await writeMemoryOverview(scope, rewrite, abort.signal);
		overview = result;
		count = result.currentCount;
		phase = "written";
	} catch (cause) {
		if (aborted(cause)) return;
		changed =
			cause instanceof ApiError &&
			cause.status === 409 &&
			cause.message === "overview_changed";
		phase = "failed";
	}
}
async function start() {
	try {
		const kept = await fetchMemoryOverview(scope, abort.signal);
		count = kept.currentCount;
		if (kept.state === "written") {
			overview = kept;
			phase = "written";
			return;
		}
	} catch (cause) {
		if (aborted(cause)) return;
	}
	await write(false);
}
onMount(() => {
	void start();
	return () => abort.abort();
});
const footnote = $derived.by(() => {
	if (!overview || overview.text === null) return "";
	const from = overview.writtenFrom ?? overview.currentCount;
	const partial = from < overview.currentCount;
	const writtenAt = overview.writtenAt
		? Date.parse(overview.writtenAt)
		: Number.NaN;
	if (Number.isNaN(writtenAt) || Date.now() - writtenAt < JUST_NOW_MS)
		return partial
			? $t("memorySubjects.writtenNowRecent", {
					count: from,
					total: overview.currentCount,
				})
			: $t("memorySubjects.writtenNow", { count: from });
	const when = mentionedWhen(overview.writtenAt, new Date(), $uiLanguage);
	const words =
		when === null || when.kind === "today"
			? $t("memorySubjects.today")
			: when.kind === "yesterday"
				? $t("memorySubjects.yesterday")
				: when.kind === "daysAgo"
					? $t("memorySubjects.daysAgo", { count: when.count })
					: when.text;
	return partial
		? $t("memorySubjects.writtenEarlierRecent", {
				count: from,
				total: overview.currentCount,
				when: words,
			})
		: $t("memorySubjects.writtenEarlier", { count: from, when: words });
});
</script>
<DialogShell {title} titleVisuallyHidden {onClose} maxWidthClass="max-w-[640px]" phonePresentation="sheet">
 <div class="memory-overview-sheet" data-testid="memory-overview-sheet" aria-busy={phase === "loading" || phase === "writing"}>
  <div class="memory-overview-sheet-head">
   <span class="memory-overview-mark"><Sparkle size={16} strokeWidth={1.8} aria-hidden="true"/></span>
   <span class="memory-overview-sheet-title" aria-hidden="true">{title}</span>
   <button type="button" class="memory-overview-close" aria-label={$t("common.close")} onclick={onClose}><X size={20} strokeWidth={1.8} aria-hidden="true"/></button>
  </div>
  {#if phase === "writing"}
   <div class="memory-overview-writing" role="status">
    <LoaderCircle size={28} strokeWidth={2} class="memory-overview-spinner" aria-hidden="true"/>
    <p class="memory-overview-writing-title">{$t("memorySubjects.writing")}</p>
    {#if count > 0}<p class="memory-overview-writing-from">{$t("memorySubjects.writingFrom", { count })}</p>{/if}
   </div>
  {/if}
  {#if phase === "loading" || phase === "writing"}
   <div class="memory-overview-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
  {:else if phase === "written" && overview?.text}
   <p class="memory-overview-text" data-memory-overview-text>{overview.text}</p>
   <p class="memory-overview-footnote">{footnote}</p>
   <div class="memory-overview-actions"><button type="button" class="btn-secondary memory-overview-action" onclick={() => void write(true)}>{$t("memorySubjects.rewrite")}</button><button type="button" class="btn-primary memory-overview-action" onclick={onClose}>{$t("memorySubjects.done")}</button></div>
  {:else if phase === "failed"}
   <p class="memory-overview-failed" role="alert">{$t(changed ? "memorySubjects.overviewChanged" : "memorySubjects.overviewFailed")}</p>
   <div class="memory-overview-actions"><button type="button" class="btn-secondary memory-overview-action" onclick={() => void write(false)}>{$t("memorySubjects.tryAgain")}</button><button type="button" class="btn-primary memory-overview-action" onclick={onClose}>{$t("memorySubjects.done")}</button></div>
  {/if}
 </div>
</DialogShell>
<style>
.memory-overview-sheet{font-family:var(--font-sans);color:var(--text-primary)}
.memory-overview-sheet-head{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.memory-overview-mark{display:inline-flex;flex:none;align-items:center;justify-content:center;width:40px;height:40px;border-radius:var(--radius-md);background:var(--accent-tint);color:var(--accent-text)}
.memory-overview-sheet-title{flex:1;min-width:0;font-size:20px;font-weight:600;line-height:1.35}
.memory-overview-close{display:inline-flex;flex:none;align-items:center;justify-content:center;width:40px;height:40px;margin-right:-8px;border:0;border-radius:var(--radius-md);background:transparent;color:var(--icon-muted);cursor:pointer}
.memory-overview-close:hover{background:color-mix(in srgb,var(--text-primary) 6%,transparent)}
.memory-overview-close:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.memory-overview-writing{display:flex;flex-direction:column;align-items:center;gap:6px;padding:20px 0 8px;text-align:center}
:global(.memory-overview-spinner){color:var(--accent);animation:memory-overview-spin 1s linear infinite;margin-bottom:10px}
@media (prefers-reduced-motion:reduce){:global(.memory-overview-spinner){animation:none}}
@keyframes memory-overview-spin{to{transform:rotate(360deg)}}
.memory-overview-writing-title{margin:0;font-size:17px;font-weight:600}
.memory-overview-writing-from{margin:0;font-size:15px;color:var(--text-muted)}
.memory-overview-skeleton{display:flex;flex-direction:column;gap:12px;padding:24px 0 8px}
.memory-overview-skeleton span{display:block;height:14px;border-radius:var(--radius-full);background:color-mix(in srgb,var(--text-primary) 7%,transparent)}
.memory-overview-skeleton span:nth-child(1){width:92%}.memory-overview-skeleton span:nth-child(2){width:82%}.memory-overview-skeleton span:nth-child(3){width:64%}
.memory-overview-text{margin:0;font-size:17px;line-height:1.7;overflow-wrap:anywhere}
.memory-overview-footnote{margin:16px 0 0;font-size:14px;line-height:1.55;color:var(--text-muted)}
.memory-overview-failed{margin:0;font-size:15px;line-height:1.55}
.memory-overview-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:24px}
.memory-overview-action{min-height:44px;padding:10px 22px;border-radius:var(--radius-md);font-size:15px;font-weight:600}
@media (max-width:639.98px){.memory-overview-actions{justify-content:stretch}.memory-overview-action{flex:1}}
</style>
