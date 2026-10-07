<script lang="ts">
/**
 * A text block: the same in-place field as a sticky note, with no paper and no
 * header — only the words, and (while selected) the selection's own outline.
 */
import { useSvelteFlow } from "@xyflow/svelte";
import { t } from "$lib/i18n";
import {
	type CanvasBlockData,
	TEXT_MAX_CHARS,
} from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META } from "../_lib/block-meta";
import { useBoardContext } from "../_lib/board-context";
import { excerpt } from "../_lib/excerpt";
import NodeShell from "../NodeShell.svelte";
import InlineTextField from "./InlineTextField.svelte";

type TextData = Extract<CanvasBlockData, { kind: "text" }>;

let {
	id,
	data,
	selected = false,
}: { id: string; data: TextData; selected?: boolean } = $props();

const board = useBoardContext();
const flow = useSvelteFlow();
const minSize = BLOCK_META.text.minSize;

let editing = $state(false);

$effect(() => {
	if (board.takeEditRequest(id)) editing = true;
});

function startEditing(): void {
	if (!board.readonly) editing = true;
}
</script>

<NodeShell
	{id}
	kind="text"
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
	summary={excerpt(data.text)}
	activate={startEditing}
	edit={startEditing}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="text-block" ondblclick={startEditing} data-testid="canvas-text">
		<InlineTextField
			value={data.text}
			placeholder={$t("artifacts.canvas.textPlaceholder")}
			label={$t("artifacts.canvas.insert.text")}
			maxlength={TEXT_MAX_CHARS}
			readonly={board.readonly}
			bind:editing
			onchange={(text) => flow.updateNodeData(id, { text })}
		/>
	</div>
</NodeShell>

<style>
	/* The whole block is what a double-click edits, however tall the reader made it. */
	.text-block {
		box-sizing: border-box;
		height: 100%;
		min-height: 32px;
		padding: 4px 6px;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.9rem;
		font-weight: 500;
		line-height: 1.4;
		cursor: default;
	}
</style>
