<script module lang="ts">
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { LazyShell } from "../_lib/lazy-nodes";

type LiveWebData = Extract<CanvasBlockData, { kind: "liveweb" }>;

/** How a live-web block dresses the shell `LazyNode` draws: titled with the query it searched, which is also what a screen reader names it by. */
export function livewebShell(data: LiveWebData): LazyShell {
	return { title: data.query, summary: data.query };
}
</script>

<script lang="ts">
/**
 * A live-web block's content: what a web search returned, kept as a snapshot. The
 * header (the shell's) is the query; here are the sources as the chat shows them
 * under a search — the site's icon, the title, the host, each a link that opens the
 * page in a new tab — and, under them, how old the snapshot is and a Refresh.
 *
 * The block never searches by itself. It says "updated 5 min ago" and, past its
 * window (`isLiveWebStale`), that it is not live; only the reader's own press of
 * Refresh runs the search again, and what that runs is the query STORED on the block
 * (the server reads it from the saved board; nothing here names a query or an
 * address). The new snapshot replaces this one on the board and is saved with it; a
 * refresh that fails leaves the snapshot exactly as it was and says so.
 *
 * A source is a link only if its address is a web address (`isHttpSourceUrl`), checked
 * again here on top of the check the board makes when it stores the block: anything
 * else is shown as plain text, because a link is a thing a click runs. Every link
 * carries `noopener noreferrer`.
 *
 * The shell around this (header, anchors, resize corners) is `LazyNode`'s, and this
 * module never imports it (see `lazy-nodes.ts`).
 */
import { LoaderCircle, RefreshCw } from "@lucide/svelte";
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import { isHttpSourceUrl } from "$lib/shared/artifacts/block-urls";
import { isLiveWebStale } from "$lib/shared/artifacts/live-web";
import { formatRelativeTime } from "$lib/utils/time";
import {
	extractHostname,
	getFaviconUrl,
	stripToPlainText,
} from "$lib/utils/tool-evidence-presentation";
import { useBoardContext } from "../_lib/board-context";
import { useChatContext } from "../_lib/chat-context";

/** The tooltip of a source: its snippet (or its title) as plain words, never the markup a search provider's text can carry. */
function hint(source: LiveWebData["sources"][number]): string {
	return stripToPlainText(source.snippet || source.title).slice(0, 240);
}

/** The most sources the block draws (a search returns at most this many); the rest are a count. */
const SOURCES_SHOWN = 8;
/** How often the age is re-read. A minute's granularity, so half a minute is fine. */
const CLOCK_MS = 30_000;

let { id, data }: { id: string; data: LiveWebData } = $props();

const chat = useChatContext();
const board = useBoardContext();

let now = $state(Date.now());
onMount(() => {
	const timer = setInterval(() => (now = Date.now()), CLOCK_MS);
	return () => clearInterval(timer);
});

let shown = $derived(data.sources.slice(0, SOURCES_SHOWN));
let hidden = $derived(data.sources.length - shown.length);
let stale = $derived(isLiveWebStale(data.fetchedAt, now));
let updated = $derived.by(() => {
	// The age is read against `now`, so it moves as the clock does.
	void now;
	return $t("artifacts.canvas.liveweb.updated", {
		when: formatRelativeTime(data.fetchedAt, { t: $t }),
	});
});

type Problem = "failed" | "nothing" | "tooOften";
let refreshing = $state(false);
let problem = $state<Problem | null>(null);
let controller: AbortController | null = null;

const PROBLEM_KEY = {
	failed: "artifacts.canvas.refreshFailed",
	nothing: "artifacts.canvas.refreshNothing",
	tooOften: "artifacts.canvas.refreshTooOften",
} as const;

// A block that goes away (deleted, the panel closed) takes its search with it.
onMount(() => () => controller?.abort());

async function refresh(): Promise<void> {
	const run = chat.refreshBlock;
	if (!run || refreshing || board.readonly) return;
	refreshing = true;
	problem = null;
	controller = new AbortController();
	const mine = controller;
	try {
		const result = await run(id, mine.signal);
		if (mine.signal.aborted) return;
		if (!result.ok) {
			problem =
				result.reason === "no_results"
					? "nothing"
					: result.reason === "rate_limited"
						? "tooOften"
						: "failed";
		}
	} catch {
		if (!mine.signal.aborted) problem = "failed";
	} finally {
		if (controller === mine) controller = null;
		refreshing = false;
	}
}
</script>

<div class="web" data-testid="canvas-liveweb">
	{#if shown.length === 0}
		<p class="web__empty">{$t("artifacts.canvas.liveweb.none")}</p>
	{:else}
		<ul class="web__sources">
			{#each shown as source, index (`${index}:${source.id}:${source.url}`)}
				{@const favicon = getFaviconUrl(source.url)}
				{@const host = extractHostname(source.url)}
				<li>
					{#snippet body()}
						<span class="web__favicon" aria-hidden="true">
							{#if favicon}
								<img
									src={favicon}
									alt=""
									loading="lazy"
									decoding="async"
									draggable="false"
									referrerpolicy="no-referrer"
									onerror={(event) => {
										(event.currentTarget as HTMLImageElement).style.display = "none";
									}}
								/>
							{/if}
						</span>
						<span class="web__title">{source.title}</span>
						{#if host && host !== source.title}
							<span class="web__host">{host}</span>
						{/if}
					{/snippet}
					{#if isHttpSourceUrl(source.url)}
						<a
							class="web__source"
							href={source.url}
							target="_blank"
							rel="noopener noreferrer"
							draggable="false"
							title={hint(source)}
							data-testid="canvas-liveweb-source"
						>
							{@render body()}
						</a>
					{:else}
						<span class="web__source web__source--text" data-testid="canvas-liveweb-source">
							{@render body()}
						</span>
					{/if}
				</li>
			{/each}
		</ul>
		{#if hidden > 0}
			<p class="web__more">{$t("artifacts.canvas.liveweb.more", { count: hidden })}</p>
		{/if}
	{/if}

	<div class="web__footer">
		<span class="web__age" data-testid="canvas-liveweb-age">{updated}</span>
		{#if stale}
			<span class="web__stale" data-testid="canvas-liveweb-stale">{$t("artifacts.canvas.staleBadge")}</span>
		{/if}
		{#if chat.refreshBlock}
			<button
				type="button"
				class="web__refresh nodrag"
				data-export-skip
				data-testid="canvas-liveweb-refresh"
				aria-busy={refreshing}
				aria-disabled={refreshing || board.readonly}
				onclick={() => void refresh()}
			>
				{#if refreshing}
					<LoaderCircle class="web__spin" size={14} strokeWidth={2} aria-hidden="true" />
					<span>{$t("artifacts.canvas.refreshing")}</span>
				{:else}
					<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
					<span>{$t("artifacts.canvas.refresh")}</span>
				{/if}
			</button>
		{/if}
	</div>
	<p class="web__problem" role="status" data-export-skip data-testid="canvas-liveweb-status">
		{#if problem}{$t(PROBLEM_KEY[problem])}{/if}
	</p>
</div>

<style>
	.web {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 10px 8px;
	}

	.web__sources {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.web__source {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		margin: 0 -6px;
		padding: 4px 6px;
		border-radius: 5px;
		color: inherit;
		font-size: var(--text-sm);
		text-decoration: none;
	}

	a.web__source:hover {
		background: var(--surface-overlay);
	}

	a.web__source:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.web__favicon {
		display: inline-flex;
		flex: 0 0 14px;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		overflow: hidden;
		border-radius: 50%;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-subtle);
	}

	.web__favicon img {
		width: 14px;
		height: 14px;
		object-fit: contain;
	}

	.web__title {
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		color: var(--text-primary);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The site is what tells two results apart when their titles run long: it keeps its own room and the title gives way. */
	.web__host {
		flex: 0 0 auto;
		max-width: 45%;
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-xs);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.web__more,
	.web__empty {
		margin: 0;
		padding: 2px 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.web__footer {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 28px;
		margin-top: 2px;
		padding-top: 6px;
		border-top: 1px solid var(--border-subtle);
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.web__age {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* "Not live" is a label on the snapshot, in the warning's own text colour. */
	.web__stale {
		flex: none;
		padding: 0 6px;
		border-radius: 999px;
		background: var(--warning-tint);
		color: var(--warning-text);
		font-weight: 600;
		line-height: 1.6;
	}

	.web__refresh {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 5px;
		min-height: 28px;
		margin-left: auto;
		padding: 2px 8px;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: var(--surface-page);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.web__refresh:hover {
		background: var(--surface-elevated);
	}

	.web__refresh:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.web__refresh[aria-disabled="true"] {
		cursor: default;
		opacity: 0.65;
	}

	.web__refresh[aria-disabled="true"]:hover {
		background: var(--surface-page);
	}

	:global(.web__spin) {
		animation: web-spin 0.9s linear infinite;
	}

	@keyframes web-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.web__problem {
		margin: 0;
		color: var(--warning-text);
		font-size: var(--text-xs);
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.web__spin) {
			animation: none;
		}
	}

	@media (max-width: 767px), (pointer: coarse) {
		.web__source {
			min-height: 44px;
		}

		.web__refresh {
			min-height: 44px;
			padding: 4px 12px;
		}
	}
</style>
