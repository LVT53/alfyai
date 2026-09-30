<script lang="ts">
/**
 * A sticky note: paper in one of four tones, its words editable in place. The
 * only block whose whole job is free text (a text block is the same field with
 * no paper). Double-click, or Enter on the focused note, opens it for editing.
 */
import { useSvelteFlow } from "@xyflow/svelte";
import { t, type I18nKey } from "$lib/i18n";
import {
	type CanvasBlockData,
	STICKY_TONES,
	TEXT_MAX_CHARS,
} from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META } from "../_lib/block-meta";
import { useBoardContext } from "../_lib/board-context";
import { excerpt } from "../_lib/excerpt";
import NodeShell from "../NodeShell.svelte";
import InlineTextField from "./InlineTextField.svelte";

type StickyData = Extract<CanvasBlockData, { kind: "sticky" }>;

let {
	id,
	data,
	selected = false,
}: { id: string; data: StickyData; selected?: boolean } = $props();

const board = useBoardContext();
const flow = useSvelteFlow();
const minSize = BLOCK_META.sticky.minSize;

let editing = $state(false);

// A note that was just inserted opens for typing at once.
$effect(() => {
	if (board.takeEditRequest(id)) editing = true;
});

function startEditing(): void {
	if (!board.readonly) editing = true;
}
</script>

{#snippet toneSwatches()}
	<div class="tones" role="group" aria-label={$t("artifacts.canvas.tone")}>
		{#each STICKY_TONES as tone (tone)}
			<button
				type="button"
				class="tone"
				style:--swatch="var(--sticky-{tone})"
				aria-label={$t(`artifacts.canvas.tone.${tone}` as I18nKey)}
				title={$t(`artifacts.canvas.tone.${tone}` as I18nKey)}
				aria-pressed={data.tone === tone}
				data-testid="canvas-sticky-tone"
				data-tone={tone}
				onclick={() => flow.updateNodeData(id, { tone })}
			></button>
		{/each}
	</div>
{/snippet}

<NodeShell
	{id}
	kind="sticky"
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
	tone={data.tone}
	summary={excerpt(data.text)}
	activate={startEditing}
	toolbar={toneSwatches}
>
	<!-- The double-click is a pointer shortcut for what Enter does on the
	     focused note (NodeShell's `activate`), so it needs no key handler here. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="sticky" ondblclick={startEditing} data-testid="canvas-sticky">
		<InlineTextField
			value={data.text}
			placeholder={$t("artifacts.canvas.stickyPlaceholder")}
			label={$t("artifacts.canvas.insert.sticky")}
			maxlength={TEXT_MAX_CHARS}
			readonly={board.readonly}
			bind:editing
			onchange={(text) => flow.updateNodeData(id, { text })}
		/>
	</div>
</NodeShell>

<style>
	.sticky {
		box-sizing: border-box;
		min-height: 64px;
		padding: 9px 10px;
		color: var(--text-primary);
		font-family: var(--font-serif);
		font-size: 12.5px;
		line-height: 1.45;
		cursor: default;
	}

	.tones {
		display: flex;
		align-items: center;
		gap: 2px;
		padding-right: 3px;
		margin-right: 3px;
		border-right: 1px solid var(--border-default);
	}

	.tone {
		position: relative;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		cursor: pointer;
	}

	/* The swatch itself is a small disc inside a full-size button, so the
	   target is as big as any other button in the toolbar. */
	.tone::before {
		content: "";
		position: absolute;
		inset: 7px;
		border: 1px solid color-mix(in srgb, var(--text-primary) 28%, transparent);
		border-radius: 50%;
		background: var(--swatch);
	}

	.tone[aria-pressed="true"]::before {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.tone:hover {
		background: var(--surface-elevated);
	}

	.tone:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.tone {
			width: 44px;
			height: 44px;
		}

		.tone::before {
			inset: 11px;
		}
	}
</style>
