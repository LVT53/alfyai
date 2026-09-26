<script lang="ts">
/**
 * The Document's comment margin (Feature 2 · Artifacts, Slice 1, T10; margin
 * placement follow-up): each thread appears BESIDE its anchored block —
 * "the margin shows it against the right block" — never overlapping another
 * thread, pushed down in document order when two anchors sit close
 * together. Threads whose anchor is gone (orphaned, or a malformed/
 * unparseable row) have nowhere to sit beside; they render in their own
 * clearly-labelled group instead of lying about a position they don't have.
 *
 * The actual placement MATH is `margin-layout.ts`'s pure `layoutMarginThreads`
 * (tested on its own, DOM-free). This component's job is only to measure
 * the two things that function needs — each anchored block's live position,
 * each thread's own rendered height — and to keep this panel's own scroll in
 * step with the editor's, so a thread placed at its block's content-space Y
 * actually lines up with it on screen (one-directional: the editor drives
 * the margin, not the other way around, so skimming every thread by
 * scrolling the margin alone stays possible).
 *
 * `contentEl` is optional and every measurement degrades gracefully without
 * it (jsdom has no real layout or ResizeObserver, and this component's own
 * tests render it with no editor mounted at all): a thread that cannot be
 * measured still gets a reasonable guessed position from its document order
 * rather than being misclassified as orphaned, and this panel falls back to
 * the plain stacked list — same as at a narrow width — the moment there is
 * no room to place things beside anything.
 *
 * A `null` or malformed anchor (T10.9 — `parseArtifactAnchor` already turned
 * an unparseable row into `null` before this component ever sees it) renders
 * exactly like a resolved-orphan: the body and thread stay visible, never a
 * crash. This is the one comment state a user cannot cause on purpose, which
 * is exactly why it must never be the one that ships broken.
 */
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import {
	anchorTone,
	ORPHANED_ANCHOR_RESOLUTION,
	type AnchorResolution,
} from "$lib/shared/artifacts/anchor";
import { resolveTextAnchor } from "$lib/shared/artifact-document/anchor";
import type { DocumentBlock } from "$lib/shared/artifact-document/blocks";
import CommentThread from "./CommentThread.svelte";
import { layoutMarginThreads, type MarginThreadInput } from "./margin-layout";

let {
	comments,
	blocks,
	contentEl,
	onResolve,
	onSubmitReply,
}: {
	comments: ArtifactComment[];
	blocks: DocumentBlock[];
	/**
	 * The editor's own scrolling content host (`DocumentBody.svelte`'s
	 * `contentEl`) — measured against, and scroll-synced with, for real
	 * "beside the block" placement. Optional: without it, threads still
	 * render, just without a measured position (the narrow-width list shape).
	 */
	contentEl?: HTMLElement;
	onResolve: (commentId: string, resolved: boolean) => void | Promise<void>;
	onSubmitReply: (parentId: string, body: string) => void | Promise<void>;
} = $props();

function resolutionFor(comment: ArtifactComment): AnchorResolution {
	if (!comment.anchor || comment.anchor.kind !== "text") {
		return ORPHANED_ANCHOR_RESOLUTION;
	}
	return resolveTextAnchor(comment.anchor, blocks);
}

function toneLabel(resolution: AnchorResolution): string {
	switch (resolution.state) {
		case "exact":
			return $t("artifacts.document.anchor.exact");
		case "moved":
			return $t("artifacts.document.anchor.moved");
		case "orphaned":
			return $t("artifacts.document.anchor.orphaned");
	}
}

/** A thread's assumed height/row spacing before it has ever been measured — close enough that the first paint rarely needs a visible correction once ResizeObserver reports the real size. */
const GUESSED_THREAD_SIZE_PX = 130;
/** Below this panel width, position-syncing has no column to work with; fall back to the plain stacked list (T10's original shape, and the narrow-width contract). */
const NARROW_PANEL_WIDTH_PX = 220;

let panelEl: HTMLDivElement | undefined = $state();
let panelWidth = $state(0);
let measuredHeights = $state<Record<string, number>>({});
let blockTops = $state<Record<string, number>>({});

const orderIndexByBlockId = $derived(
	new Map(blocks.map((block, index) => [block.id, index])),
);
const resolutionByCommentId = $derived(
	new Map(comments.map((comment) => [comment.id, resolutionFor(comment)])),
);

/**
 * RV-1B: the gap between two coalesced re-measurement passes. `blocks`
 * reassigns on every keystroke (`DocumentBody.svelte`'s `handleUpdate`), and
 * without this a fast typist's every character forced its own full
 * querySelector+`getBoundingClientRect` pass over every anchored block —
 * measured directly in `MarginPanel.test.ts`'s "re-measurement under rapid
 * edits" test: 10 rapid updates against 50 open comments cost 510 reflow
 * reads instead of one. 120 ms is short enough that a paused typist still
 * sees the margin settle as "instant" (well under the ~200 ms human
 * perception threshold) and short enough relative to the body's own 800 ms
 * autosave debounce that the margin never visibly lags behind a save, but
 * long enough to coalesce consecutive keystrokes (typical inter-keystroke
 * gaps run 80-200 ms).
 */
const MARGIN_REMEASURE_DEBOUNCE_MS = 120;

/** One querySelector per DISTINCT anchored block, never a full-document walk. */
function measureAnchorTops(): void {
	if (!contentEl) return;
	const containerTop = contentEl.getBoundingClientRect().top;
	const next: Record<string, number> = {};
	for (const blockId of orderIndexByBlockId.keys()) {
		const el = contentEl.querySelector<HTMLElement>(
			`[data-block-id="${blockId}"]`,
		);
		if (!el) continue;
		// `rect.top - containerTop + scrollTop` is invariant under scrolling
		// (the two scroll-dependent terms cancel), giving the block's position
		// within the FULL scrollable content rather than just what happens to
		// be on screen right now.
		next[blockId] =
			el.getBoundingClientRect().top - containerTop + contentEl.scrollTop;
	}
	blockTops = next;
}

// Re-measure whenever the set of blocks or comments this panel cares about
// changes — a new comment, an edit that moved or split a block, a resolved
// thread leaving the list ("re-place them on edit") — debounced so a burst
// of rapid changes (typing) coalesces into one pass instead of one per
// change; the effect's own cleanup (Svelte calls the previous run's
// returned function before the next run, and on unmount) cancels a still-
// pending timer, so a stale measurement can never land after this panel
// moved on to a different set of blocks/comments or was torn down.
$effect(() => {
	void comments;
	void blocks;
	const timer = setTimeout(measureAnchorTops, MARGIN_REMEASURE_DEBOUNCE_MS);
	return () => clearTimeout(timer);
});

// Keep this panel's own scroll in step with the editor's: without it,
// "beside the block" would only ever be true at scroll position zero.
$effect(() => {
	if (!contentEl || !panelEl) return;
	const content = contentEl;
	const panel = panelEl;
	const syncScroll = () => {
		panel.scrollTop = content.scrollTop;
	};
	content.addEventListener("scroll", syncScroll, { passive: true });
	syncScroll();
	return () => content.removeEventListener("scroll", syncScroll);
});

// Re-measure on the content column's own resize ("re-place them on
// resize" — a width change can rewrap text and shift every block below it),
// and track this panel's own width for the narrow-width fallback. Guarded:
// jsdom (this component's own tests) has no ResizeObserver, and this panel
// must render correctly without one.
$effect(() => {
	if (typeof ResizeObserver === "undefined") return;
	const observers: ResizeObserver[] = [];
	if (contentEl) {
		const target = contentEl;
		const observer = new ResizeObserver(() => measureAnchorTops());
		observer.observe(target);
		observers.push(observer);
	}
	if (panelEl) {
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (width !== undefined) panelWidth = width;
		});
		observer.observe(panelEl);
		observers.push(observer);
	}
	return () => {
		for (const observer of observers) observer.disconnect();
	};
});

/** Reports one thread card's own rendered height back into `measuredHeights`, so the SECOND layout pass (almost always the very next frame) places it without guessing. */
function reportThreadHeight(commentId: string, height: number): void {
	if (height && Math.abs((measuredHeights[commentId] ?? 0) - height) > 0.5) {
		measuredHeights = { ...measuredHeights, [commentId]: height };
	}
}

function measureThreadHeight(node: HTMLElement, commentId: string) {
	// A SYNCHRONOUS read the moment this card mounts, not just ResizeObserver's
	// own (async, next-frame) first callback: without this, the very next
	// thread's push-down math can run against a still-guessed height for this
	// one, landing it a few pixels into this card's real, larger box — this
	// action's whole reason to exist is that "no overlap" has to hold from the
	// FIRST real layout, not just once ResizeObserver eventually catches up.
	reportThreadHeight(commentId, node.offsetHeight);
	if (typeof ResizeObserver === "undefined") {
		return { destroy() {} };
	}
	// Re-reads `offsetHeight` on the node itself rather than trusting the
	// callback's own `entries[0].contentRect` — `contentRect` is the CONTENT
	// box (padding and border excluded), while every other measurement here
	// (this action's own initial read, `getBoundingClientRect` elsewhere) is
	// a border box. Using `contentRect` directly under-counted this element's
	// true height by exactly its padding-bottom + border (13px in the current
	// CSS), which under-pushed the next thread by the same amount minus the
	// gap — a real, reproducible overlap this test caught, not a timing race.
	const observer = new ResizeObserver(() => {
		reportThreadHeight(commentId, node.offsetHeight);
	});
	observer.observe(node);
	return {
		destroy() {
			observer.disconnect();
		},
	};
}

const layoutInputs = $derived<MarginThreadInput[]>(
	comments.map((comment, index) => {
		const resolution =
			resolutionByCommentId.get(comment.id) ?? ORPHANED_ANCHOR_RESOLUTION;
		const blockId = resolution.blockId;
		const order =
			blockId !== null ? (orderIndexByBlockId.get(blockId) ?? index) : index;
		const anchorTop =
			blockId === null
				? null
				: (blockTops[blockId] ?? order * GUESSED_THREAD_SIZE_PX);
		return {
			id: comment.id,
			anchorTop,
			height: measuredHeights[comment.id] ?? GUESSED_THREAD_SIZE_PX,
			order,
		};
	}),
);

const layout = $derived(layoutMarginThreads(layoutInputs));
const topByCommentId = $derived(
	new Map(layout.placed.map((placement) => [placement.id, placement.top])),
);
const positionedComments = $derived(
	layout.placed
		.map((placement) => comments.find((comment) => comment.id === placement.id))
		.filter((comment): comment is ArtifactComment => comment !== undefined),
);
const orphanedComments = $derived(
	layout.orphanedIds
		.map((id) => comments.find((comment) => comment.id === id))
		.filter((comment): comment is ArtifactComment => comment !== undefined),
);

/** Position-syncing needs a column wide enough to be worth it; below that, and whenever the width has not been measured (this component's own tests, or before the first ResizeObserver report), the plain list is the honest default. */
const useMarginLayout = $derived(panelWidth >= NARROW_PANEL_WIDTH_PX);
const positionedAreaHeight = $derived(
	layout.placed.reduce(
		(max, placement) =>
			Math.max(
				max,
				placement.top +
					(measuredHeights[placement.id] ?? GUESSED_THREAD_SIZE_PX),
			),
		0,
	),
);
</script>

{#snippet threadCard(comment: ArtifactComment, resolution: AnchorResolution)}
	<span
		class="margin-panel-tone"
		class:margin-panel-tone-warning={anchorTone(resolution.state) === 'warning'}
		class:margin-panel-tone-faint={anchorTone(resolution.state) === 'faint'}
	>
		{toneLabel(resolution)}
	</span>
	{#if comment.anchor?.kind === 'text'}
		<blockquote class="margin-panel-quote">"{comment.anchor.quote}"</blockquote>
	{/if}
	<CommentThread
		thread={comment}
		onResolve={(resolved) => onResolve(comment.id, resolved)}
		{onSubmitReply}
	/>
{/snippet}

<div
	class="margin-panel"
	bind:this={panelEl}
	aria-label={$t('artifacts.document.margin.title')}
>
	{#if comments.length === 0}
		<p class="margin-panel-empty">{$t('artifacts.document.margin.empty')}</p>
	{:else}
		<div
			class="margin-panel-positioned-area"
			class:margin-panel-positioned-area-active={useMarginLayout}
			style:min-height={useMarginLayout ? `${positionedAreaHeight}px` : undefined}
		>
			{#each positionedComments as comment (comment.id)}
				{@const resolution = resolutionByCommentId.get(comment.id) ?? ORPHANED_ANCHOR_RESOLUTION}
				<section
					class="margin-panel-item"
					class:margin-panel-item-positioned={useMarginLayout}
					style:top={useMarginLayout ? `${topByCommentId.get(comment.id) ?? 0}px` : undefined}
					use:measureThreadHeight={comment.id}
					data-testid="margin-comment"
					data-comment-id={comment.id}
				>
					{@render threadCard(comment, resolution)}
				</section>
			{/each}
		</div>

		{#if orphanedComments.length > 0}
			<div class="margin-panel-orphaned-group" data-testid="margin-orphaned-group">
				<h3 class="margin-panel-orphaned-heading">
					{$t('artifacts.document.margin.orphanedGroup')}
				</h3>
				{#each orphanedComments as comment (comment.id)}
					{@const resolution = resolutionByCommentId.get(comment.id) ?? ORPHANED_ANCHOR_RESOLUTION}
					<section class="margin-panel-item">
						{@render threadCard(comment, resolution)}
					</section>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.margin-panel {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		height: 100%;
		padding: 0.75rem;
		overflow-y: auto;
	}

	.margin-panel-empty {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.margin-panel-positioned-area {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	/* Position-synced mode: threads are placed by `top`, computed by
	   `layoutMarginThreads` from each one's anchored block position — this
	   area becomes their positioning context, tall enough (via `min-height`
	   above) to hold every thread reachable by scrolling. */
	.margin-panel-positioned-area-active {
		position: relative;
		display: block;
	}

	.margin-panel-item {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.margin-panel-item-positioned {
		position: absolute;
		left: 0;
		right: 0;
	}

	.margin-panel-orphaned-group {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--border-default);
	}

	.margin-panel-orphaned-heading {
		margin: 0;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.margin-panel-tone {
		align-self: flex-start;
		padding: 0.0625rem 0.375rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
	}

	.margin-panel-tone-warning {
		color: var(--status-warning-text, #8a6100);
		background-color: var(--status-warning-surface, #fff3cd);
	}

	.margin-panel-tone-faint {
		opacity: 0.6;
	}

	.margin-panel-quote {
		margin: 0;
		padding-left: 0.5rem;
		border-left: 2px solid var(--border-default);
		color: var(--text-muted);
		font-size: 0.75rem;
		font-style: italic;
	}
</style>
