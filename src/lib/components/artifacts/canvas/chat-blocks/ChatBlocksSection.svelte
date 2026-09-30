<script lang="ts">
/**
 * "From this chat", the Insert menu's second section: the files, Apps, maps and
 * charts the board's own chat made, grouped by kind, newest first. It reads the
 * chat when it mounts (the menu loads this whole component only when it opens, so
 * a board that is never given a block from the chat never pays for any of it) and
 * says quietly what it is doing: reading, nothing to insert, or could not look.
 *
 * It sits inside the menu's own `role="menu"`, so its rows are menu items and the
 * menu's arrow keys move over them; they stay out of the tab order (the menu keeps
 * one tab stop, on the rows a reader writes). A pick hands over the block kind and
 * the data of the ONE block it makes; the board places it.
 */
import type { Component } from "svelte";
import { onMount, tick } from "svelte";
import type { SearchCanvasWebResult } from "$lib/client/api/artifacts";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import { t } from "$lib/i18n";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { CanvasChatBlocks } from "$lib/shared/artifacts/chat-blocks";
import { LABEL_MAX_CHARS } from "$lib/shared/artifacts/canvas-limits";
import { getCategory } from "$lib/shared/file-types";
import { type ChatBlockKind, chatBlockGroups } from "./chat-block-data";

let {
	load,
	onpick,
	iconFor,
	search,
}: {
	load: () => Promise<CanvasChatBlocks>;
	onpick: (kind: ChatBlockKind, data: CanvasBlockData) => void;
	/**
	 * Searches the web for a query typed here and answers the snapshot a live-web
	 * block starts from. Absent where there is no chat to search for: the section then
	 * has no "Search the web…". It is the server that searches (`searchCanvasWeb`):
	 * nothing here calls a provider or names an address.
	 */
	search?: (
		query: string,
		signal?: AbortSignal,
	) => Promise<SearchCanvasWebResult>;
	/**
	 * The glyph a kind wears in the menu and on the board. Handed in by the menu
	 * (which already holds them) rather than imported here: this section is loaded
	 * on demand, and a module it shares with the editor would be split out of the
	 * editor's own chunk to make that possible.
	 */
	iconFor: (kind: ChatBlockKind) => Component | undefined;
} = $props();

type Phase =
	| { name: "loading" }
	| { name: "failed" }
	| { name: "ready"; listing: CanvasChatBlocks };

let phase = $state.raw<Phase>({ name: "loading" });
let attempt = 0;

async function read(): Promise<void> {
	attempt += 1;
	const run = attempt;
	phase = { name: "loading" };
	try {
		const listing = await load();
		if (run === attempt) phase = { name: "ready", listing };
	} catch {
		if (run === attempt) phase = { name: "failed" };
	}
}

onMount(() => {
	void read();
	return () => {
		// An answer that arrives after the menu closed is not shown.
		attempt += 1;
		// A search that is still running goes with the menu.
		webRun?.abort();
	};
});

// ---- Search the web… ------------------------------------------------------

type WebPhase = "idle" | "busy" | "failed" | "nothing" | "tooOften";
let webOpen = $state(false);
let webQuery = $state("");
let webPhase = $state<WebPhase>("idle");
let webField = $state<HTMLInputElement | null>(null);
let webRun: AbortController | null = null;

const WEB_MESSAGE = {
	busy: "artifacts.canvas.chat.webSearch.busy",
	failed: "artifacts.canvas.chat.webSearch.failed",
	nothing: "artifacts.canvas.chat.webSearch.empty",
	tooOften: "artifacts.canvas.chat.webSearch.tooOften",
} as const;

let webReady = $derived(webQuery.trim().length > 0 && webPhase !== "busy");

async function openWebSearch(): Promise<void> {
	webOpen = true;
	await tick();
	webField?.focus();
}

async function submitWebSearch(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const query = webQuery.trim();
	if (!search || query.length === 0 || webPhase === "busy") return;
	webPhase = "busy";
	const run = new AbortController();
	webRun = run;
	try {
		const result = await search(query, run.signal);
		// The menu closed while it searched: nothing is handed over.
		if (run.signal.aborted) return;
		if (result.ok) {
			webPhase = "idle";
			onpick("liveweb", result.data);
			return;
		}
		webPhase =
			result.reason === "no_results"
				? "nothing"
				: result.reason === "rate_limited"
					? "tooOften"
					: "failed";
	} catch {
		if (run.signal.aborted) return;
		webPhase = "failed";
	} finally {
		if (webRun === run) webRun = null;
	}
	// What was typed stays, with the cursor in it, for another try.
	await tick();
	webField?.focus();
}

let groups = $derived(
	phase.name === "ready" ? chatBlockGroups(phase.listing, $t) : [],
);
</script>

<div
	class="chat-blocks"
	role="group"
	aria-label={$t("artifacts.canvas.chat.title")}
	aria-busy={phase.name === "loading"}
	data-testid="canvas-chat-blocks"
>
	<div class="chat-blocks__title" aria-hidden="true">{$t("artifacts.canvas.chat.title")}</div>
	{#if search}
		{#if !webOpen}
			{@const WebIcon = iconFor("liveweb")}
			<button
				type="button"
				role="menuitem"
				class="chat-blocks__row"
				tabindex="-1"
				data-testid="canvas-chat-websearch"
				onclick={() => void openWebSearch()}
			>
				<span class="chat-blocks__icon">
					{#if WebIcon}<WebIcon size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
				</span>
				<span class="chat-blocks__name">{$t("artifacts.canvas.chat.webSearch.row")}</span>
			</button>
		{:else}
			<form class="chat-blocks__search" data-testid="canvas-chat-websearch-form" onsubmit={submitWebSearch}>
				<input
					type="text"
					class="chat-blocks__query"
					bind:this={webField}
					bind:value={webQuery}
					maxlength={LABEL_MAX_CHARS}
					autocomplete="off"
					spellcheck="false"
					aria-label={$t("artifacts.canvas.chat.webSearch.label")}
					placeholder={$t("artifacts.canvas.chat.webSearch.placeholder")}
					readonly={webPhase === "busy"}
				/>
				<button
					type="submit"
					class="btn-secondary btn-sm"
					aria-disabled={!webReady}
					aria-busy={webPhase === "busy"}
				>
					{$t("artifacts.canvas.chat.webSearch.submit")}
				</button>
				<p class="chat-blocks__status" role="status">
					{#if webPhase !== "idle"}{$t(WEB_MESSAGE[webPhase])}{/if}
				</p>
			</form>
		{/if}
	{/if}
	{#if phase.name === "loading"}
		<p class="chat-blocks__note">{$t("artifacts.canvas.chat.loading")}</p>
	{:else if phase.name === "failed"}
		<div class="chat-blocks__note">
			<p>{$t("artifacts.canvas.chat.failed")}</p>
			<button type="button" class="btn-secondary btn-sm" onclick={() => void read()}>
				{$t("artifacts.canvas.chat.retry")}
			</button>
		</div>
	{:else if groups.length === 0}
		<p class="chat-blocks__note">{$t("artifacts.canvas.chat.empty")}</p>
	{:else}
		{#each groups as group (group.kind)}
			<div class="chat-blocks__group" role="group" aria-label={group.label}>
				<div class="chat-blocks__label" aria-hidden="true">{group.label}</div>
				{#each group.rows as row (row.key)}
					{@const Icon = iconFor(row.kind)}
					<button
						type="button"
						role="menuitem"
						class="chat-blocks__row"
						tabindex="-1"
						data-testid="canvas-chat-item"
						data-kind={row.kind}
						onclick={() => onpick(row.kind, row.data)}
					>
						<span class="chat-blocks__icon">
							{#if row.kind === "file"}
								<FileTypeIcon category={getCategory(row.filename ?? "", row.mime || null)} size={16} />
							{:else if Icon}
								<Icon size={16} strokeWidth={1.75} aria-hidden="true" />
							{/if}
						</span>
						<span class="chat-blocks__name" title={row.name}>{row.name}</span>
						{#if row.meta}<span class="chat-blocks__meta">{row.meta}</span>{/if}
					</button>
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	.chat-blocks {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-top: 6px;
		border-top: 1px solid var(--border-subtle);
	}

	.chat-blocks__title {
		padding: 2px 8px 4px;
		color: var(--text-muted);
		font-size: var(--text-xs);
		font-weight: 700;
	}

	.chat-blocks__note {
		margin: 0;
		padding: 4px 8px 6px;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.chat-blocks__note p {
		margin: 0 0 6px;
	}

	.chat-blocks__group {
		display: flex;
		flex-direction: column;
	}

	.chat-blocks__label {
		padding: 6px 8px 2px;
		color: var(--text-muted);
		font-size: var(--text-2xs);
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: none;
	}

	.chat-blocks__row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 6px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-md);
		text-align: left;
		cursor: pointer;
	}

	.chat-blocks__row:hover {
		background: var(--surface-elevated);
	}

	.chat-blocks__search {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		align-items: center;
		padding: 4px 8px 6px;
	}

	.chat-blocks__query {
		box-sizing: border-box;
		min-width: 0;
		min-height: 32px;
		padding: 4px 8px;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: var(--surface-page);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-md);
	}

	.chat-blocks__query:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.chat-blocks__search [aria-disabled="true"] {
		cursor: default;
		opacity: 0.6;
	}

	.chat-blocks__status {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.chat-blocks__row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.chat-blocks__icon {
		display: inline-flex;
		flex: none;
		color: var(--icon-muted, var(--text-muted));
	}

	.chat-blocks__name {
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chat-blocks__meta {
		flex: none;
		max-width: 45%;
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-xs);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.chat-blocks__row {
			min-height: 44px;
		}

		.chat-blocks__query {
			min-height: 44px;
		}
	}
</style>
