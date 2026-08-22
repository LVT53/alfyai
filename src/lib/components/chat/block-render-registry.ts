import type { Component } from "svelte";
import {
	type BlockRenderStrategy,
	type MarkdownBlockKind,
	resolveBlockRenderStrategy,
} from "$lib/services/markdown-blocks";
import Chart from "./Chart.svelte";
import Checklist from "./Checklist.svelte";
import CodeBlock from "./CodeBlock.svelte";
import CsvTable from "./CsvTable.svelte";
import Mermaid from "./Mermaid.svelte";

/**
 * The render-ready block model consumed by `MarkdownRenderer.svelte`. It is the
 * typed output of `buildDisplayBlocks` — one variant per block kind, carrying
 * exactly what that kind's renderer needs (pre-rendered `html` for the prose /
 * code lanes, raw `code` for the diagram lanes, parsed `items` for checklists).
 */
export type ChecklistDisplayItem = {
	checked: boolean;
	task: boolean;
	html: string;
};

export type DisplayBlock =
	| {
			kind: "code";
			code: string;
			language?: string;
			html: string;
			isNew?: boolean;
	  }
	| { kind: "checklist"; items: ChecklistDisplayItem[]; isNew?: boolean }
	| { kind: "chart"; code: string; isNew?: boolean }
	| { kind: "csv"; code: string; isNew?: boolean }
	| { kind: "mermaid"; code: string; isNew?: boolean }
	| {
			kind: "table" | "callout" | "accordion" | "html";
			html: string;
			isNew?: boolean;
	  };

// A dynamically-dispatched block component. Concrete components have their own
// precise prop types; the registry erases them to a common shape (the template
// spreads `entry.props(block)`), so the double-cast is the price of the generic
// dispatch — with no `any`.
type BlockComponent = Component<Record<string, unknown>>;

/**
 * A component-lane registry entry: the Svelte component to instantiate, an
 * optional wrapper class, and a pure adapter mapping the display block to that
 * component's props.
 */
export type BlockRendererEntry = {
	component: BlockComponent;
	wrapperClass?: string;
	props: (block: DisplayBlock) => Record<string, unknown>;
};

function asBlockComponent(component: unknown): BlockComponent {
	return component as unknown as BlockComponent;
}

/**
 * The dispatch registry: render strategy → component-lane entry. This is the
 * ONE place block-kind → renderer-component dispatch lives; `MarkdownRenderer`
 * consumes it with a single dynamic `<Renderer />` (component lanes) plus one
 * `{@html}` (the prose lane), so its template has no per-kind switch. Adding a
 * block kind = a `BLOCK_RENDER_STRATEGIES` entry + one component + one entry
 * here — no template edits. Strategies with no entry (only `prose`) fall through
 * to the `{@html}` prose lane.
 */
export const BLOCK_RENDERERS: Partial<
	Record<BlockRenderStrategy, BlockRendererEntry>
> = {
	code: {
		component: asBlockComponent(CodeBlock),
		props: (block) => {
			const b = block as Extract<DisplayBlock, { kind: "code" }>;
			return { code: b.code, language: b.language, contentHtml: b.html };
		},
	},
	checklist: {
		component: asBlockComponent(Checklist),
		wrapperClass: "markdown-checklist-block",
		props: (block) => {
			const b = block as Extract<DisplayBlock, { kind: "checklist" }>;
			return { items: b.items };
		},
	},
	chart: {
		component: asBlockComponent(Chart),
		wrapperClass: "markdown-diagram-block",
		props: (block) => {
			const b = block as Extract<DisplayBlock, { kind: "chart" }>;
			return { code: b.code };
		},
	},
	csv: {
		component: asBlockComponent(CsvTable),
		wrapperClass: "markdown-diagram-block",
		props: (block) => {
			const b = block as Extract<DisplayBlock, { kind: "csv" }>;
			return { code: b.code };
		},
	},
	mermaid: {
		component: asBlockComponent(Mermaid),
		wrapperClass: "markdown-diagram-block",
		props: (block) => {
			const b = block as Extract<DisplayBlock, { kind: "mermaid" }>;
			return { code: b.code };
		},
	},
};

/**
 * Resolve a block kind to its component-lane renderer, or `null` when the kind
 * renders through the prose `{@html}` lane (table / callout / accordion / html).
 */
export function blockRenderer(
	kind: MarkdownBlockKind,
): BlockRendererEntry | null {
	return BLOCK_RENDERERS[resolveBlockRenderStrategy(kind)] ?? null;
}
