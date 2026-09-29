<script lang="ts">
/**
 * The board's own checklist — the chat's (`chat/Checklist.svelte`) is a reply's
 * read-only rendering and is deliberately left alone. Here a tick is an edit:
 * it goes into the node's data and is saved with the board, so it is still
 * ticked after a reload, which is what the chat's read-only boxes were
 * withheld for. The items are plain text (a board note is not markdown).
 */
import { Plus, X } from "@lucide/svelte";
import { useSvelteFlow } from "@xyflow/svelte";
import { t } from "$lib/i18n";
import {
	CHECKLIST_ITEM_MAX_CHARS,
	CHECKLIST_MAX_ITEMS,
	type CanvasBlockData,
} from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META } from "../_lib/block-meta";
import { useBoardContext } from "../_lib/board-context";
import NodeShell from "../NodeShell.svelte";

type ChecklistData = Extract<CanvasBlockData, { kind: "checklist" }>;
type Item = ChecklistData["items"][number];

let {
	id,
	data,
	selected = false,
}: { id: string; data: ChecklistData; selected?: boolean } = $props();

const board = useBoardContext();
const flow = useSvelteFlow();
const minSize = BLOCK_META.checklist.minSize;

let doneCount = $derived(data.items.filter((item) => item.done).length);
let editable = $derived(!board.readonly);
let full = $derived(data.items.length >= CHECKLIST_MAX_ITEMS);
let draft = $state("");

function commit(items: Item[]): void {
	flow.updateNodeData(id, { items });
}

function toggle(itemId: string): void {
	commit(
		data.items.map((item) =>
			item.id === itemId ? { ...item, done: !item.done } : item,
		),
	);
}

function rename(itemId: string, text: string): void {
	commit(
		data.items.map((item) => (item.id === itemId ? { ...item, text } : item)),
	);
}

function remove(itemId: string): void {
	commit(data.items.filter((item) => item.id !== itemId));
}

function add(): void {
	const text = draft.trim();
	if (!text || full) return;
	commit([...data.items, { id: crypto.randomUUID(), text, done: false }]);
	draft = "";
}
</script>

<NodeShell
	{id}
	kind="checklist"
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
	title={data.label ?? ""}
	meta={data.items.length > 0 ? `${doneCount}/${data.items.length}` : ""}
	summary={data.label ?? ""}
>
	<ul class="checklist" data-testid="canvas-checklist">
		{#each data.items as item (item.id)}
			<li class="row" class:row--done={item.done}>
				<input
					type="checkbox"
					class="custom-checkbox nodrag"
					checked={item.done}
					disabled={!editable}
					aria-label={$t("artifacts.canvas.checklistToggle", { name: item.text })}
					onchange={() => toggle(item.id)}
				/>
				<input
					type="text"
					class="row__text nodrag"
					value={item.text}
					maxlength={CHECKLIST_ITEM_MAX_CHARS}
					readonly={!editable}
					aria-label={$t("artifacts.canvas.insert.checklist")}
					oninput={(event) => rename(item.id, event.currentTarget.value)}
					onchange={(event) => {
						// A cleared item is a removed item, once the reader is done with it.
						if (!event.currentTarget.value.trim()) remove(item.id);
					}}
				/>
				{#if editable}
					<button
						type="button"
						class="row__remove nodrag"
						aria-label={$t("artifacts.canvas.checklistRemove")}
						title={$t("artifacts.canvas.checklistRemove")}
						onclick={() => remove(item.id)}
					>
						<X size={13} strokeWidth={2} aria-hidden="true" />
					</button>
				{/if}
			</li>
		{/each}
	</ul>
	{#if editable && !full}
		<div class="add">
			<input
				type="text"
				class="add__input nodrag"
				bind:value={draft}
				maxlength={CHECKLIST_ITEM_MAX_CHARS}
				placeholder={$t("artifacts.canvas.checklistPlaceholder")}
				aria-label={$t("artifacts.canvas.checklistPlaceholder")}
				onkeydown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						add();
					}
				}}
			/>
			<button
				type="button"
				class="add__button nodrag"
				aria-label={$t("artifacts.canvas.checklistAdd")}
				title={$t("artifacts.canvas.checklistAdd")}
				disabled={!draft.trim()}
				onclick={add}
			>
				<Plus size={14} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
	{/if}
	{#if selected}
		<p class="note">{$t("artifacts.canvas.checklistReadOnlyNote")}</p>
	{/if}
</NodeShell>

<style>
	.checklist {
		margin: 0;
		padding: 6px 9px 2px;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 26px;
	}

	.row__text,
	.add__input {
		flex: 1 1 auto;
		min-width: 0;
		padding: 2px 4px;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
	}

	.row__text:hover,
	.add__input:hover {
		border-color: var(--border-default);
	}

	.row__text:focus-visible,
	.add__input:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 0;
	}

	.row--done .row__text {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.row__remove,
	.add__button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	/* Hidden until the row is hovered or focused; it stays reachable by keyboard. */
	.row__remove {
		opacity: 0;
	}

	.row:hover .row__remove,
	.row:focus-within .row__remove {
		opacity: 1;
	}

	.row__remove:hover,
	.add__button:hover:not(:disabled) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.add__button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.row__remove:focus-visible,
	.add__button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.add {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 2px 9px 6px 29px;
	}

	.note {
		margin: 0;
		padding: 0 9px 7px;
		color: var(--text-muted);
		font-size: var(--text-2xs);
	}

	@media (pointer: coarse) {
		.row {
			min-height: 44px;
		}

		.row__remove,
		.add__button {
			width: 44px;
			height: 44px;
		}

		.row__remove {
			opacity: 1;
		}
	}
</style>
