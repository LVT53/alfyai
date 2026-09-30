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
import { onMount } from "svelte";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import { t } from "$lib/i18n";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { CanvasChatBlocks } from "$lib/shared/artifacts/chat-blocks";
import { getCategory } from "$lib/shared/file-types";
import { BLOCK_META } from "../_lib/block-meta";
import {
	type ChatBlockKind,
	type ChatBlockRow,
	chatBlockGroups,
} from "./chat-block-data";

let {
	load,
	onpick,
}: {
	load: () => Promise<CanvasChatBlocks>;
	onpick: (kind: ChatBlockKind, data: CanvasBlockData) => void;
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
	};
});

let groups = $derived(
	phase.name === "ready" ? chatBlockGroups(phase.listing, $t) : [],
);

/** The icon the chat shows beside a kind: a file's own type, else the kind's glyph. */
function iconFor(row: ChatBlockRow): Component {
	return BLOCK_META[row.kind].icon;
}
</script>

<div
	class="chat-blocks"
	role="group"
	aria-label={$t("artifacts.canvas.chat.title")}
	aria-busy={phase.name === "loading"}
	data-testid="canvas-chat-blocks"
>
	<div class="chat-blocks__title" aria-hidden="true">{$t("artifacts.canvas.chat.title")}</div>
	{#if phase.name === "loading"}
		<p class="chat-blocks__note">{$t("artifacts.canvas.chat.loading")}</p>
	{:else if phase.name === "failed"}
		<div class="chat-blocks__note">
			<p>{$t("artifacts.canvas.chat.failed")}</p>
			<button type="button" class="chat-blocks__retry" onclick={() => void read()}>
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
					{@const Icon = iconFor(row)}
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
							{:else}
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

	.chat-blocks__retry {
		min-height: 30px;
		padding: 0 12px;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: var(--surface-elevated);
		color: var(--text-primary);
		font: inherit;
		cursor: pointer;
	}

	.chat-blocks__retry:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
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

		.chat-blocks__retry {
			min-height: 44px;
		}
	}
</style>
