<script lang="ts">
/**
 * Everything canvas-specific about how a block sits on the board (spec T2): its
 * chrome, its selection outline, the four resize corners and the four
 * connection anchors — the corners and the anchors only while the block is
 * selected — and the small toolbar above a selected block. The block's own
 * component (a note, a chart, a checklist) is what goes inside; reused chat
 * components (the chart) never gain a canvas-only prop, so whatever the board
 * needs around them lives here.
 *
 * The anchors are Svelte Flow `Handle`s and are always in the DOM, invisible
 * until the block is selected: an edge attaches to a handle, so a stored edge
 * needs one whether or not anybody is selecting anything. Two are sources and
 * two targets, so an edge stored without handle ids (the body has none) runs
 * from a block's bottom to another's top; the board connects in loose mode, so
 * a reader can still start from any side.
 */
import { Trash2 } from "@lucide/svelte";
import {
	Handle,
	NodeResizeControl,
	NodeToolbar,
	Position,
	useSvelteFlow,
} from "@xyflow/svelte";
import type { Component, Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";
import { t, type I18nKey } from "$lib/i18n";
import { type BlockChrome, metaFor } from "./_lib/block-meta";
import { useBoardContext } from "./_lib/board-context";

let {
	id,
	kind,
	selected = false,
	minWidth,
	minHeight,
	summary = "",
	title = "",
	meta = "",
	tone,
	dropTarget = false,
	activate,
	header,
	toolbar,
	children,
}: {
	id: string;
	/** A block kind. One with no meta row (a known kind this build has no component for) is drawn as the missing-kind card. */
	kind: string;
	selected?: boolean;
	/** The smallest the reader may resize this block to (its registry row's `minSize`). */
	minWidth: number;
	minHeight: number;
	/** What the block says, in a few words: the screen-reader name of the node (`Sticky note: Lunch at the market`). */
	summary?: string;
	/** A card's header title; the kind's own label when the block has none. */
	title?: string;
	/** The muted line at a card header's right end. */
	meta?: string;
	/** A note's paper (sticky tone). */
	tone?: string;
	/** A frame the block being dragged would join if it were dropped now: it wears the accent while it does. */
	dropTarget?: boolean;
	/** Enter or F2 while the block itself has focus (a text block opens for editing). */
	activate?: () => void;
	/** Replaces a card's default header, and is a frame's label chip. */
	header?: Snippet;
	/** Extra controls for the selection toolbar, before Delete. */
	toolbar?: Snippet;
	/** The block itself; a card with nothing to show but its header (the missing-kind card) has none. */
	children?: Snippet;
} = $props();

const board = useBoardContext();
const flow = useSvelteFlow();

let blockMeta = $derived(metaFor(kind));
let chrome: BlockChrome = $derived(blockMeta.chrome);
let Icon: Component = $derived(blockMeta.icon);
let kindLabel = $derived($t(blockMeta.labelKey as I18nKey));
let editable = $derived(!board.readonly);
// While a picture of the board is being taken, a block whose live content a
// picture cannot carry shows a still image of it, or a card that says it has none.
let picture = $derived(board.picture?.(id) ?? null);

const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
] as const;

// Bottom-then-right first: an edge stored with no handle id takes the first
// handle of its kind, so it leaves a block from the bottom and arrives at
// another's top.
const ANCHORS = [
	{ id: "bottom", type: "source", position: Position.Bottom },
	{ id: "right", type: "source", position: Position.Right },
	{ id: "top", type: "target", position: Position.Top },
	{ id: "left", type: "target", position: Position.Left },
] as const;

/**
 * The node's own wrapper (`.svelte-flow__node`) is the element that takes
 * focus, is announced and hears the keyboard, and it belongs to the library —
 * so its name and its Enter key are set from here.
 */
const wrapperBehaviour: Attachment<HTMLElement> = (element) => {
	const wrapper = element.closest<HTMLElement>(".svelte-flow__node");
	if (!wrapper) return;
	const roleDescription = kindLabel;
	const name = summary ? `${kindLabel}: ${summary}` : kindLabel;
	const describe = () => {
		if (wrapper.getAttribute("aria-roledescription") !== roleDescription) {
			wrapper.setAttribute("aria-roledescription", roleDescription);
		}
		if (wrapper.getAttribute("aria-label") !== name) {
			wrapper.setAttribute("aria-label", name);
		}
	};
	describe();
	// The library owns these two attributes on its wrapper and writes them itself
	// (its own "node" and no label) at moments this component cannot see, so what
	// is written here is put back whenever it is overwritten.
	const keeper = new MutationObserver(describe);
	keeper.observe(wrapper, {
		attributes: true,
		attributeFilter: ["aria-label", "aria-roledescription"],
	});
	const onKeydown = (event: KeyboardEvent) => {
		if (event.target !== wrapper || !activate || !editable) return;
		if (event.key !== "Enter" && event.key !== "F2") return;
		event.preventDefault();
		activate();
	};
	wrapper.addEventListener("keydown", onKeydown);
	return () => {
		keeper.disconnect();
		wrapper.removeEventListener("keydown", onKeydown);
	};
};

function deleteBlock(): void {
	void flow.deleteElements({ nodes: [{ id }] });
}
</script>

<div
	class="canvas-node canvas-node--{chrome}"
	class:canvas-node--selected={selected}
	class:canvas-node--drop={dropTarget}
	data-testid="canvas-node"
	data-node-id={id}
	data-kind={kind}
	data-selected={selected ? "true" : "false"}
	data-drop-target={dropTarget ? "true" : undefined}
	data-missing={blockMeta.kind === "missing" ? "true" : undefined}
	{@attach wrapperBehaviour}
>
	<div class="canvas-node__box" data-tone={tone}>
		{#if chrome === "card"}
			<div class="canvas-node__head">
				{#if header}
					{@render header()}
				{:else}
					<Icon size={13} strokeWidth={2} aria-hidden="true" />
					<b class="canvas-node__title">{title || kindLabel}</b>
					{#if meta}<span class="canvas-node__meta" title={meta}>{meta}</span>{/if}
				{/if}
			</div>
		{/if}
		<div class="canvas-node__content" class:canvas-node__content--posted={picture}>
			{@render children?.()}
			{#if picture?.kind === "poster"}
				<img class="canvas-node__poster" src={picture.url} alt="" draggable="false" data-testid="canvas-node-poster" />
			{:else if picture?.kind === "placeholder"}
				<div class="canvas-node__placeholder" data-testid="canvas-node-placeholder">
					<b>{picture.title}</b>
					<span>{picture.subtitle}</span>
				</div>
			{/if}
		</div>
	</div>

	{#if chrome === "frame"}
		<!-- A frame's own body lets pointers through to what is inside it and
		     behind it; only its label chip (the drag handle) and a thin ring
		     along its border take them, so it can still be picked and moved. -->
		{#each ["top", "right", "bottom", "left"] as side (side)}
			<span class="canvas-node__ring canvas-node__ring--{side}" aria-hidden="true"></span>
		{/each}
		{#if header}
			<div class="canvas-node__chip">
				{@render header()}
			</div>
		{/if}
	{/if}

	{#each ANCHORS as anchor (anchor.id)}
		<Handle
			id={anchor.id}
			type={anchor.type}
			position={anchor.position}
			class={["canvas-anchor", selected && editable && "canvas-anchor--shown"]}
		/>
	{/each}

	{#if selected && editable}
		{#each CORNERS as position (position)}
			<NodeResizeControl {position} {minWidth} {minHeight} class="canvas-resize" />
		{/each}
		<NodeToolbar position={Position.Top} offset={12}>
			<div class="canvas-node-toolbar" role="toolbar" aria-label={kindLabel} data-testid="canvas-node-toolbar">
				{@render toolbar?.()}
				<button
					type="button"
					class="canvas-node-toolbar__button"
					aria-label={$t("artifacts.canvas.deleteBlock")}
					title={$t("artifacts.canvas.deleteBlock")}
					data-testid="canvas-node-delete"
					onclick={deleteBlock}
				>
					<Trash2 size={15} strokeWidth={2} aria-hidden="true" />
				</button>
			</div>
		</NodeToolbar>
	{/if}
</div>

<style>
	.canvas-node {
		position: relative;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		color: var(--text-primary);
		font-family: var(--font-sans);
	}

	/* The visible box: overflow is clipped HERE, not on the node, so the resize
	   corners and the anchors (which sit half outside it) are never cut off. */
	.canvas-node__box {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		overflow: hidden;
	}

	.canvas-node__content {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
	}

	/* A picture of the board is being taken: the live content stays where it is
	   (an App's frame keeps running, the map keeps its place) and is not seen; the
	   still image, or the card that says there is none, is drawn over it. */
	.canvas-node__content--posted > :global(*:not(.canvas-node__poster):not(.canvas-node__placeholder)) {
		visibility: hidden;
	}

	.canvas-node__poster {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: var(--surface-elevated);
		visibility: visible;
	}

	.canvas-node__placeholder {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 12px;
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: var(--text-xs);
		text-align: center;
		visibility: visible;
	}

	.canvas-node__placeholder b {
		max-width: 100%;
		overflow: hidden;
		color: var(--text-primary);
		font-size: var(--text-sm);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.canvas-node--selected .canvas-node__box {
		outline: 1.5px solid var(--accent);
		outline-offset: 3px;
	}

	/* card */
	.canvas-node--card .canvas-node__box {
		background: var(--surface-page);
		border: 1px solid var(--border-default);
		border-radius: 10px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
	}

	.canvas-node__head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 9px;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: var(--text-xs);
		line-height: 1.3;
	}

	/* A card whose body is empty is just its header: no rule under it. */
	.canvas-node__head:has(+ .canvas-node__content:empty) {
		border-bottom: 0;
	}

	.canvas-node__title {
		min-width: 0;
		overflow: hidden;
		color: var(--text-primary);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The meta line gives way before the title does: a long one (a block that says it
	   has no still image) is cut short, and the block keeps its name. */
	.canvas-node__meta {
		flex: 0 100 auto;
		min-width: 0;
		overflow: hidden;
		margin-left: auto;
		padding-left: 6px;
		color: var(--text-muted);
		font-size: var(--text-2xs);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* note */
	.canvas-node--note .canvas-node__box {
		border-radius: 3px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
		background: var(--sticky-yellow);
	}

	.canvas-node--note .canvas-node__box[data-tone="mint"] {
		background: var(--sticky-mint);
	}

	.canvas-node--note .canvas-node__box[data-tone="blue"] {
		background: var(--sticky-blue);
	}

	.canvas-node--note .canvas-node__box[data-tone="plain"] {
		background: var(--sticky-plain);
	}

	/* bare: nothing but the content */
	.canvas-node--bare .canvas-node__box {
		border-radius: 4px;
	}

	/* frame */
	.canvas-node--frame .canvas-node__box {
		border: 1.5px dashed color-mix(in srgb, var(--text-primary) 22%, transparent);
		border-radius: 10px;
		pointer-events: none;
	}

	.canvas-node--frame.canvas-node--selected .canvas-node__box {
		border-color: var(--accent);
		outline: none;
	}

	/* Where a block being dragged would land: the frame lights up, so a drop is
	   never a surprise. The change is instant under reduced motion. */
	.canvas-node--frame.canvas-node--drop .canvas-node__box {
		border-style: solid;
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.canvas-node--frame .canvas-node__box {
		transition:
			background-color 120ms ease,
			border-color 120ms ease;
	}

	@media (prefers-reduced-motion: reduce) {
		.canvas-node--frame .canvas-node__box {
			transition: none;
		}
	}

	.canvas-node__chip {
		position: absolute;
		top: -12px;
		left: 10px;
		max-width: calc(100% - 20px);
		padding: 0 6px;
		background: var(--surface-page);
		font-size: var(--text-xs);
		font-weight: 700;
		line-height: 24px;
		pointer-events: auto;
	}

	.canvas-node__ring {
		position: absolute;
		pointer-events: auto;
	}

	.canvas-node__ring--top,
	.canvas-node__ring--bottom {
		left: 0;
		right: 0;
		height: 10px;
	}

	.canvas-node__ring--left,
	.canvas-node__ring--right {
		top: 0;
		bottom: 0;
		width: 10px;
	}

	.canvas-node__ring--top {
		top: -5px;
	}

	.canvas-node__ring--bottom {
		bottom: -5px;
	}

	.canvas-node__ring--left {
		left: -5px;
	}

	.canvas-node__ring--right {
		right: -5px;
	}

	/* The selection toolbar sits above the block, portalled by the library, so
	   its rules are global by necessity and namespaced by class. */
	:global(.canvas-node-toolbar) {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	:global(.canvas-node-toolbar__button) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-width: 30px;
		height: 30px;
		padding: 0 6px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
	}

	:global(.canvas-node-toolbar__button:hover) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	:global(.canvas-node-toolbar__button:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	@media (max-width: 767px), (pointer: coarse) {
		:global(.canvas-node-toolbar__button) {
			min-width: 44px;
			height: 44px;
		}
	}

	/* Anchors: real handles, so edges can attach, but only visible (and only
	   grabbable) while the block is selected. */
	:global(.svelte-flow__handle.canvas-anchor) {
		width: 9px;
		height: 9px;
		min-width: 9px;
		min-height: 9px;
		border: 1.5px solid var(--accent);
		border-radius: 50%;
		background: var(--surface-page);
		opacity: 0;
		pointer-events: none;
	}

	:global(.svelte-flow__handle.canvas-anchor.canvas-anchor--shown) {
		opacity: 1;
		pointer-events: all;
		cursor: crosshair;
	}

	/* The four resize corners: the mockup's 7px squares. Grabbable even on a
	   frame, whose own node ignores the pointer (that is inherited, so it is
	   undone here). */
	:global(.svelte-flow__resize-control.handle.canvas-resize) {
		width: 8px;
		height: 8px;
		border: 1.5px solid var(--accent);
		border-radius: 2px;
		background: var(--surface-page);
		pointer-events: auto;
	}
</style>
