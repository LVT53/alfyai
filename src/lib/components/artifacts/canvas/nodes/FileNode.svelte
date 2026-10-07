<script module lang="ts">
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { CanvasChatContext } from "../_lib/chat-context";
import { fileBlockWorkspaceItem } from "../_lib/file-item";
import type { LazyShell } from "../_lib/lazy-nodes";

type FileData = Extract<CanvasBlockData, { kind: "file" }>;

/** How a file block dresses the shell `LazyNode` draws: named after the file, and the shell opens it (a double-click, Enter, its Open button) where the panel can. */
export function fileShell(data: FileData, chat: CanvasChatContext): LazyShell {
	const item = fileBlockWorkspaceItem(data);
	const open = chat.openItem;
	return {
		summary: data.name,
		open: open && item ? () => open(item) : undefined,
	};
}
</script>

<script lang="ts">
/**
 * A file block's content: one compact row — the file's icon, its name, its type
 * and its size. It is a pointer to a file the chat already holds (a produced file,
 * or one the reader attached), never a copy and never a renderer: the file opens in
 * the panel's own viewer (the callback the editor was given), so no heavy preview
 * is ever drawn on the board. Where the panel cannot open a file (a board opened
 * outside a chat) it is a plain row.
 *
 * A click picks the block, as it does for every block, so it can be moved, resized
 * and deleted; what opens the file is a double-click anywhere on the block, Enter
 * while it has focus, or the Open button of its toolbar, all of which the shell
 * around it provides (`LazyNode`'s, which this module never imports: see
 * `lazy-nodes.ts`). The row says so in its tooltip.
 */
import { ExternalLink } from "@lucide/svelte";
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
</script>

<div
	class="file"
	data-testid="canvas-file"
	title={canOpen ? $t("artifacts.canvas.file.hint") : undefined}
>
	<span class="file__icon"><FileTypeIcon {category} size={18} /></span>
	<span class="file__text">
		<span class="file__name" title={data.name}>{data.name}</span>
		{#if meta}<span class="file__meta">{meta}</span>{/if}
	</span>
	<!-- A small mark that the file opens (a double-click, Enter, the toolbar's button); the tooltip on the row says how. -->
	{#if canOpen}
		<span class="file__open" aria-hidden="true"><ExternalLink size={14} strokeWidth={2} /></span>
	{/if}
</div>

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

	.file__icon {
		display: inline-flex;
		flex: none;
		color: var(--icon-muted, var(--text-muted));
	}

	.file__open {
		display: inline-flex;
		flex: none;
		color: var(--text-muted);
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
