<script lang="ts">
/**
 * The Document's comment rail (Feature 2 · Artifacts, Slice 1, T10; rebuilt
 * as "the rail" for the Artifacts redesign, redesign.md §3.2/§7.2/§9.2, Wave
 * 2.5 Step 7 — renaming the file was optional per the brief and skipped;
 * `CommentRail` is what §8 calls this component, `MarginPanel` is what every
 * caller and test still imports): each thread appears BESIDE its anchored
 * block, never overlapping another thread, pushed down in document order
 * when two anchors sit close together. Threads whose anchor is gone
 * (orphaned, or a malformed/unparseable row) render in their own
 * clearly-labelled, foldable group instead of lying about a position they
 * don't have.
 *
 * New for the redesign, on top of the placement engine below:
 *  - **Ruling 61**: Open threads by default, with a quiet "N resolved"
 *    toggle to All — never the mockup's own "Open 4 | All 6" two-button
 *    filter. Resolved threads fold to one line either way (`CommentThread`'s
 *    own job).
 *  - **Per-tab scoping** (ruling 61's third point, "tabs show only their own
 *    section"): only comments anchored inside the ACTIVE tab's own blocks
 *    are positioned here; every other tab gets one summary row at the
 *    bottom ("in other tabs"). The removed-text group is the one exception —
 *    its text is gone, so there is no current tab to scope it to, and it
 *    always shows regardless of which tab is active.
 *  - **Two-way linking**: hover/focus on a thread's own card here links it
 *    to its words in the live text (`onActiveCommentChange`/`activeCommentId`),
 *    and a click on those words (`DocumentBody.svelte`'s own editor-side
 *    listener) asks this rail to scroll to and focus the matching card
 *    (`focusRequest`). This component only ever REPORTS its own already-
 *    resolved anchors upward (`onAnchorsChange`) — it never touches Tiptap
 *    itself (this file's own purity is load-bearing: see the header comment
 *    on the placement math below).
 *
 * The actual placement MATH is `margin-layout.ts`'s pure `layoutMarginThreads`
 * (tested on its own, DOM-free, kept exactly as the redesign brief asks).
 * This component's job is only to measure the two things that function
 * needs — each anchored block's live position, each thread's own rendered
 * height — and it stays inside the SAME scroll container as the text now
 * (the caller's `.document-content` — redesign §3.2), so the old scroll-sync
 * effect that once kept this panel's own scroll in step with the editor's is
 * gone entirely: there is only one scroll now.
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
import { ChevronRight } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import {
	ORPHANED_ANCHOR_RESOLUTION,
	type AnchorResolution,
} from "$lib/shared/artifacts/anchor";
import { resolveTextAnchor } from "$lib/shared/artifact-document/anchor";
import {
	type DocumentBlock,
	mapBlocksToTabs,
} from "$lib/shared/artifact-document/blocks";
import { prefersReducedMotion } from "$lib/utils/motion";
import CommentThread from "./CommentThread.svelte";
import { layoutMarginThreads, type MarginThreadInput } from "./margin-layout";

/**
 * One already-resolved comment thread's anchor — reported to the caller
 * (`onAnchorsChange`) so `DocumentBody.svelte` can feed it to the live
 * decoration (`extensions.ts`'s `CommentAnchorTarget`). Duplicated on
 * purpose rather than imported: this file must stay free of `@tiptap/*`
 * (its own header comment, and `document-editor.ts`'s own boundary), and
 * that module transitively pulls in Tiptap.
 */
export interface CommentAnchorTarget {
	commentId: string;
	blockId: string;
	from: number;
	to: number;
	resolved: boolean;
}

let {
	comments,
	blocks,
	contentEl,
	tabs,
	activeTabId,
	changeStateByCommentId = {},
	activeCommentId = null,
	focusRequest = null,
	onResolve,
	onSubmitReply,
	onSeeChange,
	onGotoAnchor,
	onActiveCommentChange,
	onAnchorsChange,
	onActivateTab,
}: {
	comments: ArtifactComment[];
	blocks: DocumentBlock[];
	/**
	 * The editor's own scrolling content host (`DocumentBody.svelte`'s
	 * `contentEl`) — measured against for real "beside the block" placement.
	 * Optional: without it, threads still render, just without a measured
	 * position (the narrow-width list shape).
	 */
	contentEl?: HTMLElement;
	tabs: DocumentTab[];
	activeTabId: string;
	/** commentId -> chip state, passed straight through to `CommentThread`. */
	changeStateByCommentId?: Record<string, "pending" | "kept" | "undone">;
	/** Whichever thread is currently linked to its words in the text. */
	activeCommentId?: string | null;
	/** A one-shot "scroll to and focus this thread's card" request — see this file's own header comment. */
	focusRequest?: { commentId: string; token: number } | null;
	onResolve: (commentId: string, resolved: boolean) => void | Promise<void>;
	onSubmitReply: (parentId: string, body: string) => void | Promise<void>;
	onSeeChange?: (commentId: string) => void;
	/** The quote button ("goes to the anchor") — omitted entirely for a thread with nowhere to go (orphaned). */
	onGotoAnchor?: (blockId: string, from: number, to: number) => void;
	onActiveCommentChange?: (commentId: string | null) => void;
	onAnchorsChange?: (anchors: CommentAnchorTarget[]) => void;
	/** An "in other tabs" row was clicked — switches the active tab (agent 2's own tab-switching machinery, `DocumentBody.svelte`'s `handleTabActivate`). */
	onActivateTab?: (tabId: string) => void;
} = $props();

function resolutionFor(comment: ArtifactComment): AnchorResolution {
	if (!comment.anchor || comment.anchor.kind !== "text") {
		return ORPHANED_ANCHOR_RESOLUTION;
	}
	return resolveTextAnchor(comment.anchor, blocks);
}

/** A thread's assumed height/row spacing before it has ever been measured — close enough that the first paint rarely needs a visible correction once ResizeObserver reports the real size. */
const GUESSED_THREAD_SIZE_PX = 130;
/** Below this panel width, position-syncing has no column to work with; fall back to the plain stacked list (T10's original shape, and the narrow-width contract). */
const NARROW_PANEL_WIDTH_PX = 220;

let panelEl: HTMLDivElement | undefined = $state();
let panelWidth = $state(0);
let measuredHeights = $state<Record<string, number>>({});
let blockTops = $state<Record<string, number>>({});
/** Ruling 61: Open by default. A quiet toggle (never the mockup's own two-button filter) switches to All. */
let filter = $state<"open" | "all">("open");
/** The removed-text group's own fold (motion #21) — collapsed by default. */
let orphanedGroupOpen = $state(false);

const orderIndexByBlockId = $derived(
	new Map(blocks.map((block, index) => [block.id, index])),
);
const resolutionByCommentId = $derived(
	new Map(comments.map((comment) => [comment.id, resolutionFor(comment)])),
);
const blockIdToTabId = $derived(mapBlocksToTabs(blocks, tabs));

/** True once there is more than one tab AND this comment's own (static) anchor block resolves to one of them — mirrors `DocumentBody.svelte`'s own `computeTabBadgeCounts`, the SAME `blockIdToTabId` shape (never the live-resolved blockId: a comment keeps its tab identity even while its anchor is merely "moved", not orphaned). */
function tabIdFor(comment: ArtifactComment): string | null {
	if (!comment.anchor || comment.anchor.kind !== "text") return null;
	return blockIdToTabId.get(comment.anchor.blockId) ?? null;
}

/** Every root thread whose anchor still resolves to real text, whether on this tab or another. */
const resolvableComments = $derived(
	comments.filter(
		(comment) => resolutionByCommentId.get(comment.id)?.state !== "orphaned",
	),
);
/** Ruling 61's third point: only the active tab's own threads are positioned here. Zero/one tab (`blockIdToTabId` empty) means there is only one section — everything belongs to it. */
const thisTabComments = $derived(
	blockIdToTabId.size === 0
		? resolvableComments
		: resolvableComments.filter((comment) => tabIdFor(comment) === activeTabId),
);
const resolvedThisTabCount = $derived(
	thisTabComments.filter((comment) => comment.status === "resolved").length,
);
/** Filter = Open: resolved one-liners leave (§3.3's own states table) — removed from the list entirely, not merely folded (folding is `CommentThread`'s OWN, filter-independent behavior for whichever resolved threads DO show). */
const visibleThisTabComments = $derived(
	filter === "all"
		? thisTabComments
		: thisTabComments.filter((comment) => comment.status !== "resolved"),
);
/** Comments on removed text: never tab-scoped (the text is gone, so there is no current section to belong to), but still honours the same Open/All filter. */
const allOrphanedComments = $derived(
	comments.filter(
		(comment) => resolutionByCommentId.get(comment.id)?.state === "orphaned",
	),
);
const visibleOrphanedComments = $derived(
	filter === "all"
		? allOrphanedComments
		: allOrphanedComments.filter((comment) => comment.status !== "resolved"),
);

interface OtherTabRow {
	tab: DocumentTab;
	open: number;
	resolved: number;
}
/** "In other tabs" (redesign §3.2): one row per OTHER tab, its own open/resolved counts — independent of this rail's own Open/All filter, which only ever governs the active tab's own list. */
const otherTabsSummary = $derived.by<OtherTabRow[]>(() => {
	if (blockIdToTabId.size === 0) return [];
	const counts = new Map<string, { open: number; resolved: number }>();
	for (const comment of resolvableComments) {
		const tabId = tabIdFor(comment);
		if (!tabId || tabId === activeTabId) continue;
		const entry = counts.get(tabId) ?? { open: 0, resolved: 0 };
		if (comment.status === "resolved") entry.resolved += 1;
		else entry.open += 1;
		counts.set(tabId, entry);
	}
	return tabs
		.filter((tab) => tab.id !== activeTabId && counts.has(tab.id))
		.map((tab) => ({
			tab,
			...(counts.get(tab.id) ?? { open: 0, resolved: 0 }),
		}));
});

function threadAuthorLabel(comment: ArtifactComment): string {
	return comment.author === "alfy"
		? $t("artifacts.document.versions.byAlfy")
		: $t("artifacts.document.versions.byUser");
}

/** §3.4: each thread is named "You on 'one proper concert'" — composed from already-localized fragments rather than a new sentence-shaped i18n key (a quote is arbitrary user text, not translatable content). */
function threadAriaLabel(comment: ArtifactComment): string {
	const quote = comment.anchor?.kind === "text" ? comment.anchor.quote : null;
	const preview = quote ?? comment.body.slice(0, 60);
	return `${threadAuthorLabel(comment)} — ${preview}`;
}

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

/**
 * Two-way linking's anchor -> card direction (Wave 2.5 Step 7): scrolls this
 * thread's own card into view and focuses it once `focusRequest` names it.
 * An action, not an `$effect`, because it needs to run per-item inside the
 * `{#each}` below — `update` re-runs on every `focusRequest` change, and
 * only the ONE matching commentId ever actually moves anything.
 */
function focusOnRequest(
	node: HTMLElement,
	params: {
		commentId: string;
		request: { commentId: string; token: number } | null;
	},
) {
	function apply(p: typeof params) {
		if (p.request && p.request.commentId === p.commentId) {
			node.scrollIntoView({
				block: "nearest",
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});
			node.focus();
		}
	}
	apply(params);
	return { update: apply };
}

const layoutInputs = $derived<MarginThreadInput[]>(
	visibleThisTabComments.map((comment, index) => {
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
		.map((placement) =>
			visibleThisTabComments.find((comment) => comment.id === placement.id),
		)
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

// Reports this rail's own already-resolved anchors upward, for the live
// two-way decoration (`DocumentBody.svelte`'s own `commentAnchors` state,
// fed to `extensions.ts`'s `CommentAnchors` plugin) — ALL resolvable threads,
// not just this tab's own: a hidden tab's blocks stay `display:none`
// (`buildTabSectionDecorations`), so decorating them is harmless, and this
// keeps the rail from having to re-derive anchors a second time on every
// tab switch.
$effect(() => {
	const targets: CommentAnchorTarget[] = [];
	for (const comment of resolvableComments) {
		const resolution = resolutionByCommentId.get(comment.id);
		if (!resolution || resolution.blockId === null) continue;
		targets.push({
			commentId: comment.id,
			blockId: resolution.blockId,
			from: resolution.from,
			to: resolution.to,
			resolved: comment.status === "resolved",
		});
	}
	onAnchorsChange?.(targets);
});

function toggleFilter(): void {
	filter = filter === "open" ? "all" : "open";
}

function gotoFor(comment: ArtifactComment): (() => void) | undefined {
	const resolution = resolutionByCommentId.get(comment.id);
	if (!onGotoAnchor || !resolution || resolution.blockId === null)
		return undefined;
	const blockId = resolution.blockId;
	const { from, to } = resolution;
	return () => onGotoAnchor(blockId, from, to);
}
</script>

{#snippet threadArticle(
	comment: ArtifactComment,
	resolution: AnchorResolution,
	struck: boolean,
)}
	<article
		class="margin-panel-item"
		class:margin-panel-item-positioned={!struck && useMarginLayout}
		class:is-active={activeCommentId === comment.id}
		style:top={!struck && useMarginLayout ? `${topByCommentId.get(comment.id) ?? 0}px` : undefined}
		use:measureThreadHeight={comment.id}
		use:focusOnRequest={{ commentId: comment.id, request: focusRequest }}
		tabindex="-1"
		aria-label={threadAriaLabel(comment)}
		data-testid="margin-comment"
		data-comment-id={comment.id}
		onmouseenter={() => onActiveCommentChange?.(comment.id)}
		onmouseleave={() => onActiveCommentChange?.(null)}
		onfocusin={() => onActiveCommentChange?.(comment.id)}
		onfocusout={() => onActiveCommentChange?.(null)}
	>
		<CommentThread
			thread={comment}
			quote={comment.anchor?.kind === 'text' ? comment.anchor.quote : null}
			quoteMoved={resolution.state === 'moved'}
			quoteStruck={struck}
			{changeStateByCommentId}
			onResolve={(resolved) => onResolve(comment.id, resolved)}
			{onSubmitReply}
			onGoto={struck ? undefined : gotoFor(comment)}
			onSeeChange={onSeeChange ? (commentId) => onSeeChange(commentId) : undefined}
		/>
	</article>
{/snippet}

<div
	class="margin-panel"
	bind:this={panelEl}
>
	<div class="margin-panel-header">
		<h2 class="margin-panel-title">{$t('artifacts.document.margin.title')}</h2>
		{#if resolvedThisTabCount > 0 || filter === 'all'}
			<button
				type="button"
				class="margin-panel-filter-toggle"
				aria-pressed={filter === 'all'}
				onclick={toggleFilter}
			>
				{filter === 'open'
					? $t('artifacts.document.margin.resolvedToggle', { count: resolvedThisTabCount })
					: $t('artifacts.document.margin.showOpenOnly')}
			</button>
		{/if}
	</div>

	{#if visibleThisTabComments.length === 0}
		<p class="margin-panel-empty">{$t('artifacts.document.margin.empty')}</p>
	{:else}
		<div
			class="margin-panel-positioned-area"
			class:margin-panel-positioned-area-active={useMarginLayout}
			style:min-height={useMarginLayout ? `${positionedAreaHeight}px` : undefined}
		>
			{#each positionedComments as comment (comment.id)}
				{@const resolution = resolutionByCommentId.get(comment.id) ?? ORPHANED_ANCHOR_RESOLUTION}
				{@render threadArticle(comment, resolution, false)}
			{/each}
		</div>
	{/if}

	{#if visibleOrphanedComments.length > 0}
		<div class="margin-panel-orphaned-group" data-testid="margin-orphaned-group">
			<button
				type="button"
				class="margin-panel-orphaned-toggle"
				class:is-open={orphanedGroupOpen}
				aria-expanded={orphanedGroupOpen}
				onclick={() => (orphanedGroupOpen = !orphanedGroupOpen)}
			>
				<ChevronRight
					size={13}
					strokeWidth={2}
					class="margin-panel-orphaned-chevron"
					aria-hidden="true"
				/>
				{$t('artifacts.document.margin.orphanedGroup', { count: visibleOrphanedComments.length })}
			</button>
			<div class="comment-thread-collapsible" class:is-expanded={orphanedGroupOpen}>
				<div class="comment-thread-collapsible-inner">
					{#if orphanedGroupOpen}
						<div class="margin-panel-orphaned-list">
							{#each visibleOrphanedComments as comment (comment.id)}
								{@render threadArticle(comment, ORPHANED_ANCHOR_RESOLUTION, true)}
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if otherTabsSummary.length > 0}
		<div class="margin-panel-other-tabs">
			<h3 class="margin-panel-other-tabs-heading">{$t('artifacts.document.margin.otherTabs')}</h3>
			{#each otherTabsSummary as row (row.tab.id)}
				<button
					type="button"
					class="margin-panel-other-tab-row"
					onclick={() => onActivateTab?.(row.tab.id)}
				>
					<span class="margin-panel-other-tab-title">{row.tab.title}</span>
					<span class="margin-panel-other-tab-counts">
						{$t('artifacts.document.margin.otherTabCounts', { open: row.open, resolved: row.resolved })}
					</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.margin-panel {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		height: 100%;
		padding: 0.75rem;
	}

	.margin-panel-header {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding-bottom: 0.5rem;
		background-color: var(--surface-page);
		border-bottom: 1px solid var(--border-subtle);
	}

	.margin-panel-title {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.margin-panel-filter-toggle {
		flex-shrink: 0;
		border: none;
		background: none;
		padding: 0;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-2xs, 0.66rem);
		cursor: pointer;
	}

	.margin-panel-filter-toggle:hover {
		color: var(--text-primary);
		text-decoration: underline;
	}

	.margin-panel-filter-toggle:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
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
		padding: 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
	}

	.margin-panel-item-positioned {
		position: absolute;
		left: 0;
		right: 0;
		/* Motion #16: "card top moves when layout changes". */
		transition: top var(--duration-emphasis) var(--ease-emphasis);
	}

	/* Motion #16: hover/focus on a card (or, via `activeCommentId`, its own
	   linked words) deepens the border/shadow and shifts the card 6px
	   towards the text. */
	.margin-panel-item.is-active {
		border-color: var(--comment-rule);
		box-shadow: var(--shadow-sm);
		transform: translateX(-6px);
		transition:
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.margin-panel-item:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.margin-panel-orphaned-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--border-default);
	}

	.margin-panel-orphaned-toggle {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		border: none;
		background: none;
		padding: 0;
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		cursor: pointer;
	}

	.margin-panel-orphaned-toggle:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	:global(.margin-panel-orphaned-chevron) {
		transition: transform var(--duration-emphasis) var(--ease-emphasis);
	}

	.margin-panel-orphaned-toggle.is-open :global(.margin-panel-orphaned-chevron) {
		transform: rotate(90deg);
	}

	/* A CSS-only height reveal, the same grid-template-rows technique
	   `CommentThread.svelte`'s own fold uses — inherits the reduced-motion
	   collapse app.css already applies to every `transition` (§7.3: "instant"). */
	.comment-thread-collapsible {
		display: grid;
		grid-template-rows: 0fr;
		overflow: hidden;
		transition: grid-template-rows var(--duration-emphasis) var(--ease-emphasis);
	}

	.comment-thread-collapsible.is-expanded {
		grid-template-rows: 1fr;
	}

	.comment-thread-collapsible-inner {
		min-height: 0;
	}

	.margin-panel-orphaned-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 0.5rem;
	}

	.margin-panel-other-tabs {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-subtle);
	}

	.margin-panel-other-tabs-heading {
		margin: 0 0 0.125rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.margin-panel-other-tab-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		border: none;
		background: none;
		padding: 0.25rem 0;
		color: var(--text-primary);
		font-size: var(--text-xs);
		text-align: left;
		cursor: pointer;
	}

	.margin-panel-other-tab-row:hover .margin-panel-other-tab-title {
		text-decoration: underline;
	}

	.margin-panel-other-tab-row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.margin-panel-other-tab-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.margin-panel-other-tab-counts {
		flex-shrink: 0;
		color: var(--text-muted);
	}
</style>
