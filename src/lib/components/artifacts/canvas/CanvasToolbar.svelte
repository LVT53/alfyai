<script lang="ts">
/**
 * The board's tools, along the bottom of the panel: Select and Pan, Undo and
 * Redo of the reader's own steps, and Insert (the menu of blocks a reader can
 * add). One `role="toolbar"`, every button a real button with a name, a
 * pressed state where it is a mode, and a focus ring from the app's own token.
 * On a narrow board it is compact: Pan goes (a finger already pans) and the
 * rest stay. The drawing tools, Ask Alfy and the comment tool join it in the
 * slices that build them.
 */
import { Hand, MousePointer2, Redo2, SquarePlus, Undo2 } from "@lucide/svelte";
import { tick } from "svelte";
import AnchoredPopover from "$lib/components/artifacts/AnchoredPopover.svelte";
import {
	historyAriaKeyShortcuts,
	historyShortcutLabel,
} from "$lib/components/artifacts/document/keyboard-shortcuts";
import { t } from "$lib/i18n";
import type { BlockRegistryEntry } from "./_lib/block-registry";
import InsertMenu from "./InsertMenu.svelte";

export type BoardTool = "select" | "pan";

let {
	tool,
	compact = false,
	canUndo,
	canRedo,
	disabled = false,
	emphasizeInsert = false,
	ontoolchange,
	onundo,
	onredo,
	oninsert,
}: {
	tool: BoardTool;
	compact?: boolean;
	canUndo: boolean;
	canRedo: boolean;
	/** The board cannot change right now (a conflict is waiting on the reader, the item is gone). */
	disabled?: boolean;
	/** An empty board points at Insert: its button wears the focus ring's colour. */
	emphasizeInsert?: boolean;
	ontoolchange: (tool: BoardTool) => void;
	onundo: () => void;
	onredo: () => void;
	oninsert: (row: BlockRegistryEntry) => void;
} = $props();

let insertOpen = $state(false);

function closeInsert(): void {
	insertOpen = false;
}

async function pick(row: BlockRegistryEntry): Promise<void> {
	closeInsert();
	// The menu hands focus back to Insert as it closes; the block lands after
	// that, so a note that opens for typing is the last to take the focus.
	await tick();
	oninsert(row);
}

let undoLabel = $derived(
	`${$t("artifacts.canvas.undo")} (${historyShortcutLabel("undo")})`,
);
let redoLabel = $derived(
	`${$t("artifacts.canvas.redo")} (${historyShortcutLabel("redo")})`,
);
</script>

<div
	class="canvas-toolbar"
	class:canvas-toolbar--compact={compact}
	role="toolbar"
	aria-label={$t("artifacts.canvas.toolbar")}
	data-testid="canvas-toolbar"
>
	<button
		type="button"
		class="tool"
		class:tool--on={tool === "select"}
		aria-pressed={tool === "select"}
		aria-label={$t("artifacts.canvas.tool.select")}
		title={$t("artifacts.canvas.tool.select")}
		data-testid="canvas-tool-select"
		onclick={() => ontoolchange("select")}
	>
		<MousePointer2 size={17} strokeWidth={1.9} aria-hidden="true" />
	</button>
	{#if !compact}
		<button
			type="button"
			class="tool"
			class:tool--on={tool === "pan"}
			aria-pressed={tool === "pan"}
			aria-label={$t("artifacts.canvas.tool.pan")}
			title={$t("artifacts.canvas.tool.pan")}
			data-testid="canvas-tool-pan"
			onclick={() => ontoolchange("pan")}
		>
			<Hand size={17} strokeWidth={1.9} aria-hidden="true" />
		</button>
	{/if}

	<span class="sep" aria-hidden="true"></span>

	<button
		type="button"
		class="tool"
		disabled={!canUndo || disabled}
		aria-label={$t("artifacts.canvas.undo")}
		aria-keyshortcuts={historyAriaKeyShortcuts("undo")}
		title={undoLabel}
		data-testid="canvas-undo"
		onclick={onundo}
	>
		<Undo2 size={17} strokeWidth={1.9} aria-hidden="true" />
	</button>
	<button
		type="button"
		class="tool"
		disabled={!canRedo || disabled}
		aria-label={$t("artifacts.canvas.redo")}
		aria-keyshortcuts={historyAriaKeyShortcuts("redo")}
		title={redoLabel}
		data-testid="canvas-redo"
		onclick={onredo}
	>
		<Redo2 size={17} strokeWidth={1.9} aria-hidden="true" />
	</button>

	<span class="sep" aria-hidden="true"></span>

	<button
		type="button"
		class="tool tool--labelled"
		class:tool--hint={emphasizeInsert && !insertOpen}
		disabled={disabled}
		aria-haspopup="menu"
		aria-expanded={insertOpen}
		data-testid="canvas-insert-button"
		onclick={() => (insertOpen = !insertOpen)}
	>
		<SquarePlus size={17} strokeWidth={1.9} aria-hidden="true" />
		<span>{$t("artifacts.canvas.insert")}</span>
	</button>
</div>

{#if insertOpen}
	<AnchoredPopover
		title={$t("artifacts.canvas.insert.block")}
		anchorTestId="canvas-insert-button"
		popoverTestId="canvas-insert-menu"
		closeLabel={$t("common.close")}
		width={300}
		onClose={closeInsert}
	>
		<InsertMenu onpick={pick} />
	</AnchoredPopover>
{/if}

<style>
	.canvas-toolbar {
		position: absolute;
		left: 50%;
		bottom: 12px;
		z-index: var(--artifact-overlay-z);
		display: flex;
		align-items: center;
		gap: 2px;
		max-width: calc(100% - 24px);
		padding: 4px;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: 12px;
		background: var(--surface-page);
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.13);
	}

	.tool {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-width: 36px;
		height: 36px;
		padding: 0 8px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.tool:hover:not(:disabled) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.tool--on {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.tool:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.tool:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.tool--labelled {
		color: var(--text-primary);
	}

	/* An empty board points at where to begin. */
	.tool--hint {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.sep {
		width: 1px;
		height: 20px;
		margin: 0 3px;
		background: var(--border-default);
	}

	@media (pointer: coarse) {
		.tool {
			min-width: 44px;
			height: 44px;
		}
	}

	.canvas-toolbar--compact .sep {
		margin: 0 1px;
	}
</style>
