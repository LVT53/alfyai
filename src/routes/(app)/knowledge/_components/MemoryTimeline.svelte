<script lang="ts">
import { t } from "$lib/i18n";
import type { MemoryTimelineReport } from "$lib/types";
import { Moon, RotateCcw } from "@lucide/svelte";

let {
	reports,
	onUndo,
	pendingActionKey = null,
}: {
	reports: MemoryTimelineReport[];
	onUndo: (reportId: string, actionIndex: number) => void;
	pendingActionKey?: string | null;
} = $props();

function undoKey(reportId: string, actionIndex: number): string {
	return `${reportId}:${actionIndex}:undo`;
}

let sortedReports = $derived(
	[...reports].sort(
		(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
	),
);

function formatReportDate(createdAt: string): string {
	const parsed = Date.parse(createdAt);
	if (!Number.isFinite(parsed)) return createdAt;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(parsed);
}
</script>

<section
	class="memory-timeline rounded-[1rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm md:px-5"
	aria-labelledby="memory-timeline-title"
>
	<div class="flex items-center gap-2">
		<Moon size={17} strokeWidth={2.1} class="text-accent" aria-hidden="true" />
		<h3 id="memory-timeline-title" class="text-xl font-serif text-text-primary">
			{$t("memoryProfile.timelineTitle")}
		</h3>
	</div>
	<p class="mt-1 text-xs font-sans leading-[1.5] text-text-muted">
		{$t("memoryProfile.timelineHint")}
	</p>

	{#if sortedReports.length === 0}
		<p class="mt-3 text-sm font-sans leading-[1.5] text-text-muted">
			{$t("memoryProfile.timelineEmpty")}
		</p>
	{:else}
		<ul class="memory-timeline-list mt-3 grid list-none gap-2 p-0">
			{#each sortedReports as report (report.id)}
				<li class="memory-timeline-row rounded-[0.75rem] border border-border bg-surface-page">
					<details>
						<summary class="flex cursor-pointer list-none items-start gap-3 px-3 py-3">
							<span
								class={`memory-timeline-dot mt-1.5 shrink-0 ${report.status === "failed" ? "memory-timeline-dot--failed" : ""}`}
								aria-hidden="true"
							></span>
							<span class="min-w-0 flex-1">
								<span class="block break-words text-sm font-sans leading-[1.55] text-text-primary">
									{report.summaryText}
								</span>
								<span class="mt-1 flex flex-wrap items-center gap-2 text-xs font-sans text-text-muted">
									<span>{formatReportDate(report.createdAt)}</span>
									{#if report.status === "failed"}
										<span class="memory-timeline-failed rounded-full px-2 py-0.5">
											{$t("memoryProfile.timelineFailed")}
										</span>
									{/if}
								</span>
							</span>
						</summary>
						{#if report.actions.length > 0}
							<div class="border-t border-border px-3 py-2">
								{#each report.actions as action, actionIndex (`${report.id}-${actionIndex}`)}
									<div class="flex items-start justify-between gap-3 py-1.5">
										<p class="min-w-0 break-words text-xs font-sans leading-[1.5] text-text-secondary">
											{action.description}
										</p>
										<button
											type="button"
											class="memory-timeline-undo inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-sans font-medium text-text-primary transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
											onclick={() => onUndo(report.id, actionIndex)}
											disabled={pendingActionKey === undoKey(report.id, actionIndex)}
											title={$t("memoryProfile.undoAction")}
										>
											<RotateCcw size={13} strokeWidth={2.1} aria-hidden="true" />
											{$t("memoryProfile.undo")}
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</details>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.memory-timeline-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
		background: var(--accent);
	}

	.memory-timeline-dot--failed {
		background: var(--danger);
	}

	.memory-timeline-failed {
		border: 1px solid
			color-mix(in srgb, var(--danger) 35%, var(--border-default) 65%);
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 7%, transparent 93%);
	}

	.memory-timeline-row summary::-webkit-details-marker {
		display: none;
	}
</style>
