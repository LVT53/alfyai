<script lang="ts">
/**
 * The Document's comment margin (Feature 2 · Artifacts, Slice 1, T10; rebuilt
 * as "the rail" for the Artifacts redesign, redesign.md §3.2/§7.2/§9.2, then
 * again after the owner's walk-through of the redesign: "the comments
 * themselves should scroll with the viewport, not just the section title").
 * `CommentRail` is what §8 calls this component; `MarginPanel` is what every
 * caller and test still imports.
 *
 * It is a plain list now, not a set of cards floating at their anchors'
 * heights: an evenly spaced stack of thread cards in the order their words
 * appear in the document (`comment-threads.ts`), inside its own scrolling
 * area, so it stays in view beside the text however far the text scrolls.
 * Two ways of reading it, chosen by the caller (`layout`):
 *
 *  - `rail` — the inline column beside the text: this tab's threads, then the
 *    removed-text group, then one row per OTHER tab.
 *  - `grouped` — the phone sheet and the narrow-panel drawer, where there is
 *    no text beside it to belong to: refusal note first, then every tab's
 *    threads under that tab's name, then the removed-text group.
 *
 * Ruling 61 stays: Open threads by default, a quiet "N resolved" toggle to
 * All, resolved threads fold to one line either way (`CommentThread`'s job).
 * Per-tab scoping: a rail shows only the ACTIVE tab's own threads; the
 * removed-text group is the one exception (its text is gone, so there is no
 * tab to scope it to).
 *
 * Two-way linking. Hover/focus on a card links it to its words
 * (`onActiveCommentChange`/`activeCommentId`); a click on a card scrolls the
 * text to its words (`onGotoAnchor`); a click on the words asks this list to
 * scroll to and focus the matching card (`focusRequest`). As the reader
 * scrolls the text, the caller names the thread they are reading
 * (`revealRequest`) and this list brings its card into view — never while the
 * pointer or keyboard focus is inside the list, and never taking focus: it
 * must not fight someone who is using the list.
 *
 * The refusal card ("your words win", `RefusalNotice`) is part of this list
 * so it reads as one of the comment family: at its line's position in a rail,
 * first in a sheet or drawer.
 *
 * This component never touches Tiptap and never measures the text; its
 * inputs are plain data (`comment-threads.ts` explains the rest).
 */
import { ChevronRight, X } from "@lucide/svelte";
import type { ComponentProps } from "svelte";
import { cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
import { t } from "$lib/i18n";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import {
	type AnchorResolution,
	ORPHANED_ANCHOR_RESOLUTION,
} from "$lib/shared/artifacts/anchor";
import {
	type DocumentBlock,
	mapBlocksToTabs,
} from "$lib/shared/artifact-document/blocks";
import {
	MOTION_DURATION,
	prefersReducedMotion,
	reducedMotionAware,
} from "$lib/utils/motion";
// RefusalNotice is a genuine runtime import for the <RefusalNotice /> mount in
// the template below, on top of typing MarginRefusal via
// ComponentProps<typeof RefusalNotice> — biome's import-usage check only sees
// this script block, not the template, so it reads as type-only.
// biome-ignore lint/style/useImportType: see above — import type would break the template mount
import RefusalNotice from "../RefusalNotice.svelte";
import CommentThread from "./CommentThread.svelte";
import {
	countCommentsByTab,
	groupResolvableByTab,
	orderCommentsByPosition,
	otherTabRows,
	resolveCommentAnchors,
	tabIdForComment,
} from "./comment-threads";

/** The refusal card's own data: where its line is, plus everything `RefusalNotice` renders. */
type MarginRefusal = { blockId: string | null } & ComponentProps<
	typeof RefusalNotice
>;

let {
	comments,
	blocks,
	resolutions: resolutionsProp,
	tabs,
	activeTabId,
	layout = "rail",
	refusal = null,
	changeStateByCommentId = {},
	activeCommentId = null,
	focusRequest = null,
	revealRequest = null,
	onResolve,
	onSubmitReply,
	onSeeChange,
	onGotoAnchor,
	onActiveCommentChange,
	onActivateTab,
	onClose,
	currentUserId = null,
	currentUserName = null,
	currentUserProfilePicture = null,
}: {
	comments: ArtifactComment[];
	blocks: DocumentBlock[];
	/** Every thread's anchor resolution, computed once by the caller (it needs the same numbers for the text's highlights). Computed here when omitted. */
	resolutions?: Map<string, AnchorResolution>;
	tabs: DocumentTab[];
	activeTabId: string;
	/** See this file's header comment. */
	layout?: "rail" | "grouped";
	/** "Your words win": Alfy left this line alone. `null` when there is nothing to show. */
	refusal?: MarginRefusal | null;
	/** commentId -> chip state, passed straight through to `CommentThread`. */
	changeStateByCommentId?: Record<string, "pending" | "kept" | "undone">;
	/** Whichever thread is currently linked to its words in the text. */
	activeCommentId?: string | null;
	/** A one-shot "scroll to and focus this thread's card" request — see this file's own header comment. */
	focusRequest?: { commentId: string; token: number } | null;
	/** A one-shot "bring this card into view" request that never moves focus (`force` skips the pointer/focus guard: the card was just created). */
	revealRequest?: { commentId: string; token: number; force?: boolean } | null;
	onResolve: (commentId: string, resolved: boolean) => void | Promise<void>;
	onSubmitReply: (parentId: string, body: string) => void | Promise<void>;
	onSeeChange?: (commentId: string) => void;
	/** The quote button and a click on the card ("goes to the anchor") — omitted entirely for a thread with nowhere to go (orphaned). */
	onGotoAnchor?: (blockId: string, from: number, to: number) => void;
	onActiveCommentChange?: (commentId: string | null) => void;
	/** An "in other tabs" row was clicked — switches the active tab (`DocumentBody.svelte`'s `handleTabActivate`). */
	onActivateTab?: (tabId: string) => void;
	/** Draws a close button in the header row: the narrow drawer's own way out. */
	onClose?: () => void;
	/** rd/review-2-5.md:272-275: the signed-in user's own id/name/profile picture, passed straight through to `CommentThread`/`CommentCard` for a real "you" avatar. `null` falls back to the placeholder. */
	currentUserId?: string | null;
	currentUserName?: string | null;
	currentUserProfilePicture?: string | null;
} = $props();

/** Ruling 61: Open by default. A quiet toggle (never the mockup's own two-button filter) switches to All. */
let filter = $state<"open" | "all">("open");
/** The removed-text group's own fold (motion #21) — collapsed by default. */
let orphanedGroupOpen = $state(false);
let listEl: HTMLDivElement | undefined = $state();
/** The reader is using the list: pointer over it, or focus somewhere inside it. Scroll-follow keeps its hands off then. */
let pointerInside = false;
let focusInside = false;

const resolutions = $derived(
	resolutionsProp ?? resolveCommentAnchors(comments, blocks),
);
const blockIdToTabId = $derived(mapBlocksToTabs(blocks, tabs));
const hasTabs = $derived(blockIdToTabId.size > 0);
const blockIndexById = $derived(
	new Map(blocks.map((block, index) => [block.id, index] as const)),
);
const ordered = $derived(
	orderCommentsByPosition(comments, resolutions, blocks),
);

function isPlaced(comment: ArtifactComment): boolean {
	return (resolutions.get(comment.id)?.blockId ?? null) !== null;
}
function isVisible(comment: ArtifactComment): boolean {
	return filter === "all" || comment.status !== "resolved";
}

/** A rail shows only the active tab's own threads (ruling 61's third point); a document with one section has only that one. */
const railComments = $derived(
	ordered.filter(
		(comment) =>
			isPlaced(comment) &&
			(!hasTabs ||
				tabIdForComment(
					comment,
					resolutions.get(comment.id),
					blockIdToTabId,
				) === activeTabId),
	),
);
const visibleRailComments = $derived(railComments.filter(isVisible));
const groupedTabs = $derived(
	layout === "grouped"
		? groupResolvableByTab(comments, resolutions, blocks, tabs)
				.map((group) => ({
					...group,
					comments: group.comments.filter(isVisible),
				}))
				.filter((group) => group.comments.length > 0)
		: [],
);
/** Comments on removed text: never tab-scoped (the text is gone, so there is no current section to belong to), but still honours the same Open/All filter. */
const orphanedComments = $derived(
	ordered.filter((comment) => !isPlaced(comment)),
);
const visibleOrphanedComments = $derived(orphanedComments.filter(isVisible));

const tabCounts = $derived(countCommentsByTab(comments, blocks, tabs));
/** The header's number: this tab's open threads — the very number on the tab's own badge — or every open thread of a one-section document or of the sheet/drawer's whole-document list. */
const openCount = $derived(
	layout === "rail" && hasTabs
		? (tabCounts.get(activeTabId)?.open ?? 0)
		: comments.filter((comment) => comment.status !== "resolved").length,
);
/** How many resolved threads the quiet toggle would bring back (or is showing). */
const resolvedCount = $derived(
	(layout === "rail"
		? railComments.filter((comment) => comment.status === "resolved").length
		: comments.filter(
				(comment) => isPlaced(comment) && comment.status === "resolved",
			).length) +
		orphanedComments.filter((comment) => comment.status === "resolved").length,
);
const otherTabs = $derived(
	layout === "rail" ? otherTabRows(comments, blocks, tabs, activeTabId) : [],
);

type ListItem =
	| { kind: "thread"; key: string; comment: ArtifactComment }
	| { kind: "refusal"; key: string };

/**
 * The rail's own list: this tab's threads in document order with the refusal
 * card slotted in at its line — before the first thread whose words are at
 * or below that line. A refusal whose line is in another tab (or gone) sits
 * at the top: it is the one place the notice lives, and "your words win" is
 * only a feature if the person can see it happened.
 */
const railItems = $derived.by<ListItem[]>(() => {
	const items: ListItem[] = visibleRailComments.map((comment) => ({
		kind: "thread",
		key: comment.id,
		comment,
	}));
	if (!refusal || layout !== "rail") return items;
	const refusalBlock =
		refusal.blockId !== null ? blockIndexById.get(refusal.blockId) : undefined;
	const inThisTab =
		refusalBlock !== undefined &&
		(!hasTabs ||
			(refusal.blockId !== null &&
				blockIdToTabId.get(refusal.blockId) === activeTabId));
	let at = 0;
	if (inThisTab) {
		at = items.findIndex((item) => {
			if (item.kind !== "thread") return false;
			const blockId = resolutions.get(item.comment.id)?.blockId ?? null;
			const index = blockId === null ? undefined : blockIndexById.get(blockId);
			return index !== undefined && index >= (refusalBlock ?? 0);
		});
		if (at === -1) at = items.length;
	}
	items.splice(at, 0, { kind: "refusal", key: "refusal" });
	return items;
});

/** `RefusalNotice`'s own props: everything but where the card sits. */
const noticeProps = $derived.by(() => {
	if (!refusal) return null;
	const { blockId: _placedAt, ...props } = refusal;
	return props;
});
const emptyText = $derived(
	resolvedCount > 0 && filter === "open" && openCount === 0
		? $t("artifacts.document.margin.emptyAllResolved")
		: hasTabs && layout === "rail"
			? $t("artifacts.document.margin.empty")
			: $t("artifacts.document.margin.emptyDocument"),
);

function otherTabCountsText(row: { open: number; resolved: number }): string {
	const parts: string[] = [];
	if (row.open > 0) {
		parts.push(
			$t("artifacts.document.margin.otherTabOpen", { count: row.open }),
		);
	}
	if (row.resolved > 0) {
		parts.push(
			$t("artifacts.document.margin.otherTabResolved", { count: row.resolved }),
		);
	}
	return parts.join(" · ");
}

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

function toggleFilter(): void {
	filter = filter === "open" ? "all" : "open";
}

function gotoFor(comment: ArtifactComment): (() => void) | undefined {
	const resolution = resolutions.get(comment.id);
	if (!onGotoAnchor || !resolution || resolution.blockId === null) {
		return undefined;
	}
	const blockId = resolution.blockId;
	const { from, to } = resolution;
	return () => onGotoAnchor(blockId, from, to);
}

/**
 * A click on the card itself (anywhere that is not a control of its own)
 * takes the reader to the thread's words. The quote button is the keyboard
 * route to the same place, so this adds a pointer shortcut, not a second
 * way to reach it.
 */
function handleCardClick(event: MouseEvent, comment: ArtifactComment): void {
	const target = event.target as HTMLElement | null;
	if (
		target?.closest(
			"button, a, textarea, input, select, [contenteditable='true']",
		)
	) {
		return;
	}
	if (window.getSelection()?.toString()) return;
	gotoFor(comment)?.();
}

/**
 * Two-way linking's anchor -> card direction: scrolls this thread's own card
 * into view and focuses it once `focusRequest` names it. An action, not an
 * `$effect`, because it needs to run per-item inside the `{#each}` below —
 * `update` re-runs on every `focusRequest` change, and only the ONE matching
 * commentId ever actually moves anything. A token already applied is never
 * applied again (an `update` for some other reason must not re-focus).
 */
function focusOnRequest(
	node: HTMLElement,
	params: {
		commentId: string;
		request: { commentId: string; token: number } | null;
	},
) {
	let appliedToken: number | null = null;
	function apply(p: typeof params) {
		if (
			p.request &&
			p.request.commentId === p.commentId &&
			p.request.token !== appliedToken
		) {
			appliedToken = p.request.token;
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

/** Scroll-follow's card side: bring the named card into view, leaving focus alone — and leaving the reader alone while they are using the list. */
function revealOnRequest(
	node: HTMLElement,
	params: {
		commentId: string;
		request: { commentId: string; token: number; force?: boolean } | null;
	},
) {
	let appliedToken: number | null = null;
	function apply(p: typeof params) {
		if (
			!p.request ||
			p.request.commentId !== p.commentId ||
			p.request.token === appliedToken
		) {
			return;
		}
		appliedToken = p.request.token;
		if (!p.request.force && (pointerInside || focusInside)) return;
		// A card that was just created is brought in at once, never mid-glide:
		// the new comment's own flight (`DocumentBody.svelte`) measures where
		// it lands.
		node.scrollIntoView({
			block: "nearest",
			behavior: p.request.force || prefersReducedMotion() ? "auto" : "smooth",
		});
	}
	apply(params);
	return { update: apply };
}

function handleListPointerEnter(): void {
	pointerInside = true;
}

function handleListPointerLeave(): void {
	pointerInside = false;
}

function handleListFocusIn(): void {
	focusInside = true;
}

function handleListFocusOut(event: FocusEvent): void {
	focusInside =
		event.relatedTarget instanceof Node &&
		(listEl?.contains(event.relatedTarget) ?? false);
}

const noteIn = reducedMotionAware(fly);
</script>

{#snippet threadArticle(
	comment: ArtifactComment,
	resolution: AnchorResolution,
	struck: boolean,
)}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -- a click on the card body is a pointer shortcut for the quote button inside it, which is the keyboard-accessible way to the same place -->
	<article
		class="margin-panel-item"
		class:is-active={activeCommentId === comment.id}
		class:is-resolved={comment.status === 'resolved'}
		class:is-goto={!struck && gotoFor(comment) !== undefined}
		use:focusOnRequest={{ commentId: comment.id, request: focusRequest }}
		use:revealOnRequest={{ commentId: comment.id, request: revealRequest }}
		tabindex="-1"
		aria-label={threadAriaLabel(comment)}
		data-testid="margin-comment"
		data-comment-id={comment.id}
		onclick={(event) => handleCardClick(event, comment)}
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
			{currentUserId}
			{currentUserName}
			{currentUserProfilePicture}
		/>
	</article>
{/snippet}

{#snippet refusalCard()}
	{#if noticeProps}
		<div
			class="margin-panel-note"
			in:noteIn={{ y: 6, duration: MOTION_DURATION.emphasis, easing: cubicOut }}
		>
			<RefusalNotice {...noticeProps} />
		</div>
	{/if}
{/snippet}

<div class="margin-panel" data-layout={layout}>
	<div class="margin-panel-header">
		<h2 class="margin-panel-title">{$t('artifacts.document.margin.title')}</h2>
		{#if openCount > 0}
			<span class="margin-panel-count">
				<span aria-hidden="true">{openCount}</span>
				<span class="sr-only">{$t('artifacts.document.margin.countA11y', { count: openCount })}</span>
			</span>
		{/if}
		<span class="margin-panel-header-gap"></span>
		{#if resolvedCount > 0 || filter === 'all'}
			<button
				type="button"
				class="margin-panel-filter-toggle"
				aria-pressed={filter === 'all'}
				onclick={toggleFilter}
			>
				{filter === 'open'
					? $t('artifacts.document.margin.resolvedToggle', { count: resolvedCount })
					: $t('artifacts.document.margin.showOpenOnly')}
			</button>
		{/if}
		{#if onClose}
			<button
				type="button"
				class="btn-icon-bare margin-panel-close"
				onclick={onClose}
				aria-label={$t('common.close')}
			>
				<X size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		{/if}
	</div>

	<!-- The list is the one thing in this column that scrolls. The pointer/
	     focus listeners only feed scroll-follow's "never fight the reader"
	     guard, so they are plain observers, not interactions. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="margin-panel-list"
		data-testid="margin-panel-list"
		bind:this={listEl}
		onpointerenter={handleListPointerEnter}
		onpointerleave={handleListPointerLeave}
		onfocusin={handleListFocusIn}
		onfocusout={handleListFocusOut}
	>
		{#if layout === 'grouped' && refusal}
			{@render refusalCard()}
		{/if}

		{#if layout === 'rail'}
			{#if railItems.length === 0}
				<p class="margin-panel-empty">{emptyText}</p>
			{:else}
				{#each railItems as item (item.key)}
					{#if item.kind === 'refusal'}
						{@render refusalCard()}
					{:else}
						{@const resolution = resolutions.get(item.comment.id) ?? ORPHANED_ANCHOR_RESOLUTION}
						{@render threadArticle(item.comment, resolution, false)}
					{/if}
				{/each}
			{/if}
		{:else}
			{#each groupedTabs as group (group.tab?.id ?? 'document')}
				<section class="margin-panel-group" aria-label={group.tab?.title}>
					{#if group.tab}
						<h3 class="margin-panel-eyebrow">{group.tab.title}</h3>
					{/if}
					{#each group.comments as comment (comment.id)}
						{@const resolution = resolutions.get(comment.id) ?? ORPHANED_ANCHOR_RESOLUTION}
						{@render threadArticle(comment, resolution, false)}
					{/each}
				</section>
			{/each}
			{#if groupedTabs.length === 0 && !refusal && visibleOrphanedComments.length === 0}
				<p class="margin-panel-empty">{emptyText}</p>
			{/if}
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
						size={14}
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

		{#if otherTabs.length > 0}
			<div class="margin-panel-other-tabs">
				<h3 class="margin-panel-eyebrow">{$t('artifacts.document.margin.otherTabs')}</h3>
				{#each otherTabs as row (row.tab.id)}
					<button
						type="button"
						class="margin-panel-other-tab-row"
						onclick={() => onActivateTab?.(row.tab.id)}
					>
						<span class="margin-panel-other-tab-title">{row.tab.title}</span>
						<span class="margin-panel-other-tab-counts">{otherTabCountsText(row)}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.margin-panel {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		height: 100%;
		min-height: 0;
	}

	/* The header stays put while the list under it scrolls (in the phone
	   sheet, where the sheet's own body is the scroller, `sticky` keeps it
	   in view instead). */
	.margin-panel-header {
		position: sticky;
		top: 0;
		z-index: 2;
		flex: 0 0 auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		padding: 0.75rem 0.875rem 0.625rem;
		background-color: var(--surface-page);
		border-bottom: 1px solid var(--border-subtle);
	}

	.margin-panel-title {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--text-primary);
	}

	.margin-panel-count {
		display: inline-grid;
		place-items: center;
		min-width: 1.0625rem;
		height: 1.0625rem;
		padding: 0 0.3125rem;
		border-radius: var(--radius-full);
		background-color: var(--comment-mark);
		color: var(--text-primary);
		font-size: 0.65625rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.margin-panel-header-gap {
		flex: 1 1 0;
	}

	.margin-panel-filter-toggle {
		flex-shrink: 0;
		position: relative;
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		padding: 0.125rem 0.25rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.71875rem;
		cursor: pointer;
	}

	.margin-panel-filter-toggle:hover {
		color: var(--text-primary);
		text-decoration: underline;
	}

	.margin-panel-filter-toggle:focus-visible,
	.margin-panel-orphaned-toggle:focus-visible,
	.margin-panel-other-tab-row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.margin-panel-close {
		flex-shrink: 0;
		min-height: 32px;
		min-width: 32px;
		margin: -0.25rem -0.375rem -0.25rem 0;
	}

	/* One scroll for the whole list — cards, the removed-text group, the
	   other-tab rows — with room under the last row so nothing ends up
	   hugging the panel's bottom edge. `overscroll-behavior` keeps a fling at
	   the end of the list from carrying on into the text. */
	.margin-panel-list {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		gap: 0.625rem;
		min-height: 0;
		padding: 0.75rem 0.875rem 1.5rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.margin-panel-empty {
		margin: 0;
		padding: 0.25rem 0.125rem;
		color: var(--text-muted);
		font-size: 0.78125rem;
		line-height: 1.5;
	}

	.margin-panel-group {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.margin-panel-eyebrow {
		margin: 0.375rem 0.25rem 0;
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* A thread is a real card: surface, border, radius, the same shape as
	   every other card in the panel. A resolved one recedes (dashed, one
	   tone down); the active one — hovered, focused, or the thread the
	   reader's scroll position points at — deepens its border and shadow and
	   shifts a few pixels towards the text (motion #16; colour only under
	   reduced motion). Scroll-margin keeps a card revealed by scrolling clear
	   of the sticky header in the phone sheet. */
	.margin-panel-item {
		flex: 0 0 auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-page);
		scroll-margin-block: 0.75rem;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.margin-panel[data-layout='grouped'] .margin-panel-item {
		scroll-margin-top: 4.5rem;
	}

	.margin-panel-item.is-goto {
		cursor: pointer;
	}

	.margin-panel-item:hover,
	.margin-panel-item.is-active {
		border-color: color-mix(in srgb, var(--comment-rule) 55%, var(--border-default));
		box-shadow: var(--shadow-md);
	}

	.margin-panel-item.is-active {
		transform: translateX(-6px);
	}

	.margin-panel-item.is-resolved {
		border-style: dashed;
		background-color: var(--surface-overlay);
	}

	.margin-panel-item:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.margin-panel-item.is-active {
			transform: none;
		}
	}

	.margin-panel-note {
		flex: 0 0 auto;
	}

	.margin-panel-orphaned-group {
		display: flex;
		flex-direction: column;
		flex: 0 0 auto;
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border-subtle);
	}

	.margin-panel-orphaned-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		position: relative;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		padding: 0.375rem 0.25rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.78125rem;
		text-align: left;
		cursor: pointer;
		transition:
			color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out);
	}

	.margin-panel-orphaned-toggle:hover {
		color: var(--text-primary);
		background-color: var(--surface-elevated);
	}

	:global(.margin-panel-orphaned-chevron) {
		flex-shrink: 0;
		transition: transform var(--duration-standard) var(--ease-out);
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

	/* The fold clips (`overflow: hidden` on the collapsible), so the list
	   keeps a few pixels of its own on both sides: an active card's shift
	   towards the text and its shadow must not be cut off by it. */
	.margin-panel-orphaned-list {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0.5rem 0.375rem 0.5rem;
	}

	.margin-panel-other-tabs {
		display: flex;
		flex-direction: column;
		flex: 0 0 auto;
		gap: 0.125rem;
		margin-top: 0.5rem;
		padding-top: 0.625rem;
		border-top: 1px solid var(--border-subtle);
	}

	.margin-panel-other-tab-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		position: relative;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		padding: 0.4375rem 0.5rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.78125rem;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.margin-panel-other-tab-row:hover {
		background-color: var(--surface-elevated);
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
		font-size: 0.75rem;
	}

	/* Phone sheet: nothing that is tapped is smaller than 44px (§3.4). The
	   two small text controls keep their look and grow an invisible hit area
	   instead; the rows are simply taller. */
	@media (max-width: 767px) {
		.margin-panel-filter-toggle::after,
		.margin-panel-orphaned-toggle::after {
			content: '';
			position: absolute;
			inset: -0.875rem -0.5rem;
		}

		.margin-panel-orphaned-toggle,
		.margin-panel-other-tab-row {
			min-height: 44px;
			align-items: center;
		}
	}
</style>
