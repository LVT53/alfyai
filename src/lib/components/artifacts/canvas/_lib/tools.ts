/**
 * What the board's pointer can be: the tools, and the inks the drawing tools
 * draw in. Their own module, and small on purpose: the editor's first paint needs
 * to know which tool is on (a drawing tool owns the pointer) but nothing of how a
 * mark is drawn, so the drawing layer, its geometry and the library it draws with
 * (`annotations.ts`, `AnnotationLayer.svelte`) load only when a tool that draws is
 * chosen or the board has marks (`drawing-parts.ts`).
 */
import {
	ANNOTATION_KINDS,
	type AnnotationKind,
} from "$lib/shared/artifacts/canvas";

/** The seven kinds of mark a reader can draw. */
export type DrawingTool = AnnotationKind;
/** What the toolbar's pointer does: move around, draw one of the seven, or erase. */
export type Tool = "select" | "pan" | "eraser" | "comment" | DrawingTool;

export const DRAWING_TOOLS: readonly DrawingTool[] = ANNOTATION_KINDS;

export function isDrawingTool(tool: Tool): tool is DrawingTool {
	return (DRAWING_TOOLS as readonly string[]).includes(tool);
}

/**
 * The four inks. A mark stores the CSS variable, not a hex, so it is drawn in the
 * ink of whichever theme is showing (a blue that reads on paper is not a blue
 * that reads on the dark surface). A hex from an older or foreign board draws as
 * itself.
 */
export const INKS = [
	{ id: "blue", color: "var(--ink-blue)" },
	{ id: "red", color: "var(--ink-red)" },
	{ id: "green", color: "var(--ink-green)" },
	{ id: "graphite", color: "var(--ink-graphite)" },
] as const;

export const DEFAULT_INK: string = INKS[0].color;
