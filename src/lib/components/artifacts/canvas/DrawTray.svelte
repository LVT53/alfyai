<script lang="ts">
/**
 * The drawing tools and the inks, in their own bar above the toolbar (Feature 2 ·
 * Artifacts, Slice 3, T4). The toolbar's Draw button opens it; it is drawn by the
 * toolbar, in the toolbar's own DOM, between Draw and Comment, so the keyboard
 * meets its buttons in the order they read. Loaded with the drawing layer
 * (`drawing-parts.ts`), never with the editor: what it brings is the icon of every
 * tool and the names of every ink, which a board that is never drawn on never
 * needs. Its buttons are the toolbar's own (`.tool`, styled there); the bar around
 * them is this.
 */
import {
	Circle,
	Eraser,
	Highlighter,
	MoveUpRight,
	PenLine,
	Slash,
	Square,
	Type,
} from "@lucide/svelte";
import type { Component } from "svelte";
import { type I18nKey, t } from "$lib/i18n";
import { INKS, type Tool } from "./_lib/tools";

let {
	tool,
	ink,
	ontoolchange,
	oninkchange,
}: {
	tool: Tool;
	/** The ink a new mark is drawn in (a colour token). */
	ink: string;
	ontoolchange: (tool: Tool) => void;
	oninkchange: (ink: string) => void;
} = $props();

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
const INK_CHOICES = INKS.map((entry) => ({
	...entry,
	label: INK_LABELS[entry.id],
}));
</script>

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

<style>
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
