<script lang="ts">
/**
 * A frame: a dashed outline with a name chip that groups what sits inside it.
 * The chip is the frame's drag handle (the board sets `dragHandle`), and a
 * double-click on it, or Enter on the focused frame, renames it. A frame's
 * size lives on the node AND in its data; the board keeps the two equal when
 * it saves, so a resize here never has to touch the data.
 */
import { useSvelteFlow } from "@xyflow/svelte";
import { t } from "$lib/i18n";
import {
	type CanvasBlockData,
	LABEL_MAX_CHARS,
} from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META } from "../_lib/block-meta";
import { useBoardContext } from "../_lib/board-context";
import { focusWhenShown } from "../_lib/focus";
import { handsHistoryToBoard } from "../_lib/history-keys";
import NodeShell from "../NodeShell.svelte";

type FrameData = Extract<CanvasBlockData, { kind: "frame" }>;

let {
	id,
	data,
	selected = false,
}: { id: string; data: FrameData; selected?: boolean } = $props();

const board = useBoardContext();
const flow = useSvelteFlow();
const minSize = BLOCK_META.frame.minSize;

let editing = $state(false);
let input = $state<HTMLInputElement | null>(null);

$effect(() => {
	if (board.takeEditRequest(id)) editing = true;
});

$effect(() => {
	if (!editing || !input) return;
	const target = input;
	return focusWhenShown(target, () => target.select());
});

function startEditing(): void {
	if (!board.readonly) editing = true;
}

function handleKeydown(event: KeyboardEvent): void {
	if (event.key !== "Escape" && event.key !== "Enter") return;
	event.preventDefault();
	event.stopPropagation();
	const owner = input?.closest<HTMLElement>(".svelte-flow__node");
	editing = false;
	owner?.focus();
}
</script>

{#snippet chip()}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span class="chip" ondblclick={startEditing} data-testid="canvas-frame-label">
		{#if editing}
			<input
				bind:this={input}
				class="chip__input nodrag nopan"
				value={data.label}
				maxlength={LABEL_MAX_CHARS}
				placeholder={$t("artifacts.canvas.frameName")}
				aria-label={$t("artifacts.canvas.frameName")}
				size={Math.max(8, Math.min(data.label.length + 1, 40))}
				oninput={(event) => flow.updateNodeData(id, { label: event.currentTarget.value })}
				onblur={() => (editing = false)}
				onkeydown={handleKeydown}
				{@attach handsHistoryToBoard(board.history, () => (editing = false))}
			/>
		{:else}
			<span class="chip__text" class:chip__text--empty={!data.label}>
				{data.label || $t("artifacts.canvas.frameName")}
			</span>
		{/if}
	</span>
{/snippet}

<NodeShell
	{id}
	kind="frame"
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
	dropTarget={board.dropTargetId === id}
	summary={data.label}
	activate={startEditing}
	header={chip}
>
	<!-- A frame draws nothing inside its outline: what is in it is other nodes. -->
	<span class="inside"></span>
</NodeShell>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		cursor: grab;
	}

	.chip__text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip__text--empty {
		color: var(--text-muted);
		font-style: italic;
		font-weight: 400;
	}

	.chip__input {
		min-width: 6ch;
		max-width: 100%;
		padding: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: text;
	}

	.inside {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
