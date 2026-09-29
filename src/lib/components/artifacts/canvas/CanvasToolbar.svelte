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
	Circle,
	Eraser,
	Hand,
	Highlighter,
	MousePointer2,
	MoveUpRight,
	Pencil,
	PenLine,
	Redo2,
	Slash,
	Square,
	SquarePlus,
	Type,
	Undo2,
} from "@lucide/svelte";
import { type Component, tick } from "svelte";
import AnchoredPopover from "$lib/components/artifacts/AnchoredPopover.svelte";
import {
	historyAriaKeyShortcuts,
	historyShortcutLabel,
} from "$lib/components/artifacts/document/keyboard-shortcuts";
import { type I18nKey, t } from "$lib/i18n";
import { INKS, isDrawingTool, type Tool } from "./_lib/annotations";
import type { BlockRegistryEntry } from "./_lib/block-registry";
import InsertMenu from "./InsertMenu.svelte";

let {
	tool,
	ink,
	compact = false,
	canUndo,
	canRedo,
	disabled = false,
	emphasizeInsert = false,
	ontoolchange,
	oninkchange,
	onundo,
	onredo,
	oninsert,
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
	ontoolchange: (tool: Tool) => void;
	oninkchange: (ink: string) => void;
	onundo: () => void;
	onredo: () => void;
	oninsert: (row: BlockRegistryEntry) => void;
} = $props();

let insertOpen = $state(false);

/** The tools that draw, and the eraser, in the order the tray shows them. */
const DRAW_TOOLS: readonly {
	tool: Tool;
	icon: Component;
	label: I18nKey;
}[] = [
	{ tool: "pen", icon: PenLine, label: "artifacts.canvas.tool.pen" },
	{
		tool: "highlighter",
		icon: Highlighter,
		label: "artifacts.canvas.tool.highlighter",
	},
	{ tool: "line", icon: Slash, label: "artifacts.canvas.tool.line" },
	{ tool: "arrow", icon: MoveUpRight, label: "artifacts.canvas.tool.arrow" },
	{ tool: "rect", icon: Square, label: "artifacts.canvas.tool.rect" },
	{ tool: "ellipse", icon: Circle, label: "artifacts.canvas.tool.ellipse" },
	{ tool: "text", icon: Type, label: "artifacts.canvas.tool.text" },
	{ tool: "eraser", icon: Eraser, label: "artifacts.canvas.tool.eraser" },
];

const INK_LABELS: Record<(typeof INKS)[number]["id"], I18nKey> = {
	blue: "artifacts.canvas.ink.blue",
	red: "artifacts.canvas.ink.red",
	green: "artifacts.canvas.ink.green",
	graphite: "artifacts.canvas.ink.graphite",
};

/** The inks with their names, for the swatches (a value in the script, so no tool rewrites the import as type-only). */
const INK_CHOICES = INKS.map((ink) => ({ ...ink, label: INK_LABELS[ink.id] }));

let drawing = $derived(isDrawingTool(tool) || tool === "eraser");
/** What the Draw button goes back to: the last tool the reader drew with, the pen at first. */
let lastDrawTool = $state<Tool>("pen");

$effect(() => {
	if (drawing) lastDrawTool = tool;
});

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
		class:tool--on={drawing}
		aria-pressed={drawing}
		aria-controls={drawing ? "canvas-draw-tray" : undefined}
		disabled={disabled}
		aria-label={$t("artifacts.canvas.tool.draw")}
		title={$t("artifacts.canvas.tool.draw")}
		data-testid="canvas-tool-draw"
		onclick={() => ontoolchange(drawing ? "select" : lastDrawTool)}
	>
		<Pencil size={17} strokeWidth={1.9} aria-hidden="true" />
	</button>

	{#if drawing}
		<div
			class="tray"
			id="canvas-draw-tray"
			role="group"
			aria-label={$t("artifacts.canvas.drawTools")}
			data-testid="canvas-draw-tray"
		>
			<div class="tray__group">
				{#each DRAW_TOOLS as entry (entry.tool)}
					{@const Icon = entry.icon}
					<button
						type="button"
						class="tool"
						class:tool--on={tool === entry.tool}
						aria-pressed={tool === entry.tool}
						aria-label={$t(entry.label)}
						title={$t(entry.label)}
						data-testid="canvas-tool-{entry.tool}"
						onclick={() => ontoolchange(entry.tool)}
					>
						<Icon size={17} strokeWidth={1.9} aria-hidden="true" />
					</button>
				{/each}
			</div>
			<span class="sep sep--tray" aria-hidden="true"></span>
			<div class="tray__group">
				{#each INK_CHOICES as entry (entry.id)}
					<button
						type="button"
						class="tool tool--ink"
						class:tool--on={ink === entry.color}
						aria-pressed={ink === entry.color}
						aria-label={$t(entry.label)}
						title={$t(entry.label)}
						data-testid="canvas-ink-{entry.id}"
						onclick={() => oninkchange(entry.color)}
					>
						<span class="swatch" style:background={entry.color} aria-hidden="true"></span>
					</button>
				{/each}
			</div>
		</div>
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

	@media (max-width: 767px), (pointer: coarse) {
		.tool {
			min-width: 44px;
			height: 44px;
		}
	}

	.canvas-toolbar--compact .sep {
		margin: 0 1px;
	}

	/* The drawing tools and the inks: their own bar, above the toolbar, as wide as
	   the board allows and no wider (the board tells us its width), wrapping when
	   the tools do not fit on one line. */
	.tray {
		position: absolute;
		left: 50%;
		bottom: calc(100% + 8px);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 2px 0;
		width: max-content;
		max-width: calc(var(--canvas-board-width, 100vw) - 24px);
		padding: 4px;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: 12px;
		background: var(--surface-page);
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.13);
	}

	.tray__group {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.sep--tray {
		flex: none;
	}

	.swatch {
		display: block;
		width: 18px;
		height: 18px;
		border: 1.5px solid var(--surface-page);
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--border-default);
	}

	.tool--ink.tool--on .swatch {
		box-shadow: 0 0 0 2px var(--text-primary);
	}
</style>
