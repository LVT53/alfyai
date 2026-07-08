<script lang="ts">
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import { t } from "$lib/i18n";
import { formatRelativeTime } from "$lib/utils/time";
import { Check, Loader, Pencil, X } from "@lucide/svelte";

let {
	summary,
	busy,
	hasFacts,
	onEdit,
}: {
	summary: {
		text: string;
		links?: Array<{ text: string; factIds: string[] }>;
		updatedAt: string;
	} | null;
	busy: boolean;
	hasFacts: boolean;
	onEdit: (text: string) => boolean | undefined | Promise<boolean | undefined>;
} = $props();

let editing = $state(false);
let draft = $state("");

function openEditor() {
	if (!summary) return;
	draft = summary.text;
	editing = true;
}

function closeEditor() {
	editing = false;
	draft = "";
}

async function save() {
	const text = draft.trim();
	if (!text || busy) return;
	const success = await onEdit(text);
	// Mirror the onAction contract: an explicit `false` means the save failed,
	// so keep the editor (and the draft) open for another attempt.
	if (success === false) return;
	closeEditor();
}

let updatedLabel = $derived(
	summary ? formatRelativeTime(Date.parse(summary.updatedAt)) : "",
);

// Break the one-blob portrait into digestible sentences so it reads as a
// short portrait rather than a wall of text. Prefer the per-sentence `links`
// pieces the backend already segments; fall back to splitting on sentence
// boundaries. Sentences are then grouped two-per-paragraph.
function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-ZÀ-Þ0-9"“])/u)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

let paragraphs = $derived.by<string[]>(() => {
	if (!summary) return [];
	const sentences =
		summary.links && summary.links.length > 0
			? summary.links.map((link) => link.text.trim()).filter(Boolean)
			: splitSentences(summary.text);
	if (sentences.length === 0) return [summary.text];
	const grouped: string[] = [];
	for (let index = 0; index < sentences.length; index += 2) {
		grouped.push(sentences.slice(index, index + 2).join(" "));
	}
	return grouped;
});
</script>

<section
	class="persona-summary-card rounded-[1rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm md:px-5"
	aria-labelledby="persona-summary-title"
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex min-w-0 items-center gap-1.5">
			<h3 id="persona-summary-title" class="text-xl font-serif text-text-primary">
				{$t("memoryProfile.summaryTitle")}
			</h3>
			<InfoTooltip
				text={$t("memoryProfile.summaryInfoTooltip")}
				label={$t("memoryProfile.summaryInfoLabel")}
			/>
		</div>
		{#if summary && !editing}
			<button
				type="button"
				class="btn-icon-bare btn-icon-sm h-11 w-11 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
				onclick={openEditor}
				aria-label={$t("memoryProfile.editSummary")}
				title={$t("memoryProfile.edit")}
			>
				<Pencil size={17} strokeWidth={2.1} aria-hidden="true" />
			</button>
		{/if}
	</div>

	{#if editing && summary}
		<textarea
			class="mt-3 min-h-32 w-full resize-y rounded-[0.75rem] border border-border bg-surface-page px-3 py-3 text-sm font-sans leading-[1.6] text-text-primary outline-none transition focus:border-primary"
			bind:value={draft}
			aria-label={$t("memoryProfile.summaryTitle")}
		></textarea>
		<div class="mt-3 flex justify-end gap-2">
			<button
				type="button"
				class="btn-icon-bare h-11 w-11 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
				onclick={closeEditor}
				aria-label={$t("memoryProfile.cancelSummaryEdit")}
				title={$t("memoryProfile.cancel")}
			>
				<X size={18} strokeWidth={2.1} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="btn-icon h-11 w-11 cursor-pointer rounded-full bg-primary text-white disabled:cursor-not-allowed disabled:opacity-50"
				onclick={save}
				disabled={busy || draft.trim().length === 0}
				aria-label={$t("memoryProfile.saveSummary")}
				title={$t("memoryProfile.save")}
			>
				{#if busy}
					<Loader size={18} strokeWidth={2.1} class="animate-spin" aria-hidden="true" />
				{:else}
					<Check size={18} strokeWidth={2.1} aria-hidden="true" />
				{/if}
			</button>
		</div>
	{:else if summary}
		<div class="persona-summary-body mt-3 flex flex-col gap-2.5">
			{#each paragraphs as paragraph, index (index)}
				<p class="break-words font-serif text-[0.98rem] leading-[1.7] text-text-primary">
					{paragraph}
				</p>
			{/each}
		</div>
		<p class="mt-3 text-xs font-sans text-text-muted">
			{$t("memoryProfile.summaryUpdated", { time: updatedLabel })}
		</p>
	{:else if hasFacts}
		<p class="mt-3 text-sm font-sans leading-[1.6] text-text-muted">
			{$t("memoryProfile.summaryPending")}
		</p>
	{:else}
		<p class="mt-3 text-sm font-sans leading-[1.6] text-text-muted">
			{$t("memoryProfile.summaryEmpty")}
		</p>
	{/if}
</section>
