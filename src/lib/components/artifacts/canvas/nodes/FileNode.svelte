<script module lang="ts">
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { CanvasChatContext } from "../_lib/chat-context";
import { fileBlockWorkspaceItem } from "../_lib/file-item";
import type { LazyShell } from "../_lib/lazy-nodes";

type FileData = Extract<CanvasBlockData, { kind: "file" }>;

/** How a file block dresses the shell `LazyNode` draws: named after the file, and Enter opens it where the panel can. */
export function shell(data: FileData, chat: CanvasChatContext): LazyShell {
	const item = fileBlockWorkspaceItem(data);
	const open = chat.openItem;
	return {
		summary: data.name,
		activate: open && item ? () => open(item) : undefined,
	};
}
</script>

<script lang="ts">
/**
 * A file block's content: one compact row — the file's icon, its name, its type
 * and its size. It is a pointer to a file the chat already holds (a produced file,
 * or one the reader attached), never a copy and never a renderer: a click opens the
 * file in the panel's own viewer (the callback the editor was given), so no heavy
 * preview is ever drawn on the board. Where the panel cannot open a file (a board
 * opened outside a chat) it is a plain row.
 *
 * The row is a real button but does not opt out of the board's drag: a click opens
 * the file and a drag moves the block, and the flow tells the two apart. The shell
 * around it is `LazyNode`'s, and this module never imports it (see
 * `lazy-nodes.ts`).
 */
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import { t } from "$lib/i18n";
import { getCategory } from "$lib/shared/file-types";
import { formatByteSize } from "$lib/utils/format";
import { useChatContext } from "../_lib/chat-context";

let { data }: { data: FileData } = $props();

const chat = useChatContext();

let category = $derived(getCategory(data.name, data.mime || null));
let meta = $derived(
	[data.label, data.bytes > 0 ? formatByteSize(data.bytes) : ""]
		.filter((part) => part.length > 0)
		.join(" · "),
);
let item = $derived(fileBlockWorkspaceItem(data));
let canOpen = $derived(Boolean(chat.openItem) && item !== null);

function open(): void {
	if (item) chat.openItem?.(item);
}
</script>

{#snippet row()}
	<span class="file__icon"><FileTypeIcon {category} size={18} /></span>
	<span class="file__text">
		<span class="file__name" title={data.name}>{data.name}</span>
		{#if meta}<span class="file__meta">{meta}</span>{/if}
	</span>
{/snippet}

{#if canOpen}
	<button
		type="button"
		class="file file--button"
		data-testid="canvas-file"
		aria-label={$t("artifacts.canvas.file.open", { name: data.name })}
		onclick={open}
	>
		{@render row()}
	</button>
{:else}
	<div class="file" data-testid="canvas-file">
		{@render row()}
	</div>
{/if}

<style>
	.file {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 44px;
		padding: 8px 12px;
		border: 1px solid var(--border-default);
		border-radius: 10px;
		background: var(--surface-page);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
		color: var(--text-primary);
		font: inherit;
		text-align: left;
	}

	.file--button {
		cursor: pointer;
	}

	.file--button:hover {
		background: var(--surface-elevated);
	}

	.file--button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.file__icon {
		display: inline-flex;
		flex: none;
		color: var(--icon-muted, var(--text-muted));
	}

	.file__text {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 1px;
	}

	.file__name {
		overflow: hidden;
		font-size: var(--text-sm);
		font-weight: 600;
		line-height: 1.3;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file__meta {
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--text-2xs);
		line-height: 1.3;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
