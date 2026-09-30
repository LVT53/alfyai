<script lang="ts">
/**
 * The board's tools, along the bottom of the panel: Select and Pan, Draw (which
 * opens the drawing tools and the inks above the bar), Undo and Redo of the
 * reader's own steps, and Insert (the menu of blocks a reader can add). One
 * `role="toolbar"`, every button a real button with a name, a pressed state
 * where it is a mode, and a focus ring from the app's own token. The drawing
 * tools sit in the DOM between Draw and Undo, so the keyboard meets them in the
 * order they read. On a narrow board it is compact: Pan goes (a finger already
 * pans) and the rest stay; the tray wraps. Ask Alfy and the comment tool join it
 * in the slices that build them.
 *
 * Undo and Redo act on the reader's OWN steps (a stroke, a move, a typed note),
 * and are named so: undoing Alfy's change, or an earlier session's, is a
 * different thing (History), and ruling 16 says they must not be confusable.
 */
import {
	Hand,
	MessageSquarePlus,
	MousePointer2,
	Pencil,
	Redo2,
	Sparkles,
	SquarePlus,
	Undo2,
} from "@lucide/svelte";
import { type Component, tick } from "svelte";
import AnchoredPopover from "$lib/components/artifacts/AnchoredPopover.svelte";
import {
	historyAriaKeyShortcuts,
	historyShortcutLabel,
} from "$lib/components/artifacts/document/keyboard-shortcuts";
import { t } from "$lib/i18n";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { isDrawingTool, type Tool } from "./_lib/tools";
import {
	type BlockRegistryEntry,
	blockEntry,
	insertableEntries,
} from "./_lib/block-registry";

let {
	tool,
	ink,
	compact = false,
	canUndo,
	canRedo,
	disabled = false,
	emphasizeInsert = false,
	askBusy = false,
	Tray = null,
	onwarm,
	ontoolchange,
	oninkchange,
	onundo,
	onredo,
	oninsert,
	onask,
}: {
	tool: Tool;
	/** The ink a new mark is drawn in (a colour token). */
	ink: string;
	compact?: boolean;
	canUndo: boolean;
	canRedo: boolean;
	/** The board cannot change right now (a conflict is waiting on the reader, the item is gone). */
	disabled?: boolean;
	/** An empty board points at Insert: its button wears the focus ring's colour. */
	emphasizeInsert?: boolean;
	/** Alfy is arranging: Ask waits, and its title says why. */
	askBusy?: boolean;
	/** The tray of drawing tools and inks, once it has loaded (`drawing-parts.ts`): the board loads it before a tool that draws is set, so it is there whenever one is on. */
	Tray?: Component<{
		tool: Tool;
		ink: string;
		ontoolchange: (tool: Tool) => void;
		oninkchange: (ink: string) => void;
	}> | null;
	/** A reader reached for a button whose code loads on demand (Draw): fetch it now, so it is there when they press. */
	onwarm?: (what: "draw") => void;
	ontoolchange: (tool: Tool) => void;
	oninkchange: (ink: string) => void;
	onundo: () => void;
	onredo: () => void;
	/** A block was picked from the Insert menu; a block made from the chat comes with the data the chat made. */
	oninsert: (row: BlockRegistryEntry, data?: CanvasBlockData) => void;
	/** Ask Alfy about the selected blocks, or the whole board when none is selected. */
	onask: () => void;
} = $props();

let insertOpen = $state(false);
// The menu of blocks loads the first time it is opened (`InsertMenu.svelte`): an editor whose reader never inserts anything does not carry it.
let Menu = $state.raw<typeof import("./InsertMenu.svelte").default | null>(
	null,
);
$effect(() => {
	if (!insertOpen || Menu) return;
	let current = true;
	void import("./InsertMenu.svelte").then((module) => {
		if (current) Menu = module.default;
	});
	return () => {
		current = false;
	};
});

let drawing = $derived(isDrawingTool(tool) || tool === "eraser");
/** What the Draw button goes back to: the last tool the reader drew with, the pen at first. */
let lastDrawTool = $state<Tool>("pen");

$effect(() => {
	if (drawing) lastDrawTool = tool;
});

/** The menu's code, and the placement that ends an insert, are fetched as soon as a reader reaches for Insert, so they are there by the time it is pressed. */
function warmInsert(): void {
	void import("./InsertMenu.svelte");
	void import("./_lib/placement");
}

function closeInsert(): void {
	insertOpen = false;
}

async function pick(
	row: BlockRegistryEntry,
	data?: CanvasBlockData,
): Promise<void> {
	closeInsert();
	// The menu hands focus back to Insert as it closes; the block lands after
	// that, so a note that opens for typing is the last to take the focus.
	await tick();
	oninsert(row, data);
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
		class:tool--on={drawing}
		aria-pressed={drawing}
		aria-controls={drawing ? "canvas-draw-tray" : undefined}
		disabled={disabled}
		aria-label={$t("artifacts.canvas.tool.draw")}
		title={$t("artifacts.canvas.tool.draw")}
		data-testid="canvas-tool-draw"
		onpointerenter={() => onwarm?.("draw")}
		onfocus={() => onwarm?.("draw")}
		onclick={() => ontoolchange(drawing ? "select" : lastDrawTool)}
	>
		<Pencil size={17} strokeWidth={1.9} aria-hidden="true" />
	</button>

	{#if drawing && Tray}
		<Tray {tool} {ink} {ontoolchange} {oninkchange} />
	{/if}

	<button
		type="button"
		class="tool"
		class:tool--on={tool === "comment"}
		aria-pressed={tool === "comment"}
		disabled={disabled}
		aria-label={$t("artifacts.canvas.tool.comment")}
		title={$t("artifacts.canvas.tool.comment")}
		data-testid="canvas-tool-comment"
		onclick={() => ontoolchange(tool === "comment" ? "select" : "comment")}
	>
		<MessageSquarePlus size={17} strokeWidth={1.9} aria-hidden="true" />
	</button>

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
		onpointerenter={warmInsert}
		onfocus={warmInsert}
		onclick={() => (insertOpen = !insertOpen)}
	>
		<SquarePlus size={17} strokeWidth={1.9} aria-hidden="true" />
		<span>{$t("artifacts.canvas.insert")}</span>
	</button>

	<button
		type="button"
		class="tool"
		class:tool--labelled={!compact}
		disabled={disabled || askBusy}
		aria-label={$t("artifacts.canvas.ask")}
		title={askBusy ? $t("artifacts.canvas.ask.busy") : $t("artifacts.canvas.ask")}
		data-testid="canvas-tool-ask"
		onclick={() => {
			if (!disabled && !askBusy) onask();
		}}
	>
		<Sparkles size={17} strokeWidth={1.9} aria-hidden="true" />
		{#if !compact}<span>{$t("artifacts.canvas.ask")}</span>{/if}
	</button>
</div>

{#if insertOpen}
	<AnchoredPopover
		title={$t("artifacts.canvas.insert.block")}
		anchorTestId="canvas-insert-button"
		popoverTestId="canvas-insert-menu"
		closeLabel={$t("common.close")}
		width={320}
		maxHeight={560}
		onClose={closeInsert}
	>
		{#if Menu}
			<Menu rows={insertableEntries()} entryFor={blockEntry} onpick={pick} />
		{/if}
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
		/* Its own width, not what is left of the pane after \`left: 50%\`: a toolbar with
		   two words on it would otherwise wrap them in a narrow panel. */
		width: max-content;
		max-width: calc(100% - 24px);
		padding: 4px;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: 12px;
		background: var(--surface-page);
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.13);
	}

	/* The buttons and separators are the toolbar's own, and the drawing tray (loaded
	   apart, drawn inside this bar) wears them too. */
	.canvas-toolbar :global(.tool) {
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
		white-space: nowrap;
		cursor: pointer;
	}

	.canvas-toolbar :global(.tool:hover:not(:disabled)) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.canvas-toolbar :global(.tool--on) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.canvas-toolbar :global(.tool:disabled) {
		opacity: 0.4;
		cursor: default;
	}

	.canvas-toolbar :global(.tool:focus-visible) {
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

	.canvas-toolbar :global(.sep) {
		width: 1px;
		height: 20px;
		margin: 0 3px;
		background: var(--border-default);
	}

	@media (max-width: 767px), (pointer: coarse) {
		.canvas-toolbar :global(.tool) {
			min-width: 44px;
			height: 44px;
		}
	}

	.canvas-toolbar--compact :global(.sep) {
		margin: 0 1px;
	}
</style>
