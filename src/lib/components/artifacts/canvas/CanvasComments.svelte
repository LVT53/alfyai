<script lang="ts">
/**
 * The board's comment list (Feature 2 · Artifacts, Slice 3): the Document's
 * own comment feature on a board, in the Document's own parts. The cards are
 * `CommentThread`'s, the header (title, count, the quiet Open/All toggle) and
 * the fold for threads whose block is gone are the shared ones, and where the
 * list is shown is the same three places: a column beside the board when the
 * panel has room for one, a drawer over the board when it has not, and the
 * phone sheet (`CommentsSurface`). What is the board's is only what a thread is
 * ABOUT: its quote line names a block ("Trains card") or "a spot on the board",
 * each card wears the number of its pin, and a thread whose block is gone is
 * dimmed and says so instead of pointing anywhere. `MarginPanel` is the
 * Document's own (blocks, tabs, text anchors) and is not reused here.
 *
 * No thread state lives here: the controller holds it, because the pins and
 * this list are two places that show one thing. Two-way linking is the
 * controller's fields: a pressed pin becomes `focus` (this list brings its card
 * into view), and a card's "show on the board" becomes `goto` (the layer
 * centres the camera and rings the pin).
 */
import { tick, untrack } from "svelte";
import { type I18nKey, t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { prefersReducedMotion } from "$lib/utils/motion";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import CommentComposer from "../CommentComposer.svelte";
import CommentFoldedGroup from "../CommentFoldedGroup.svelte";
import CommentListHeader from "../CommentListHeader.svelte";
import CommentsSurface from "../CommentsSurface.svelte";
import "../comment-list.css";
import { commentRailWidth } from "../document/comment-threads";
import CommentThread from "../document/CommentThread.svelte";
import { metaFor } from "./_lib/block-meta";
import { isOrphaned, nodeWords, pinLabel, threadCounts } from "./_lib/comments";
import type { CanvasCommentsController } from "./_lib/comments-controller.svelte";

let {
	controller,
	panelWidth,
	currentUser = null,
}: {
	controller: CanvasCommentsController;
	/** How wide the editor is: whether a column fits beside the board (`commentRailWidth`, the Document's own rule) or the list is a drawer. */
	panelWidth: number;
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
} = $props();

let isPhone = $state(isPhoneViewport());
let listEl = $state<HTMLDivElement | null>(null);
let appliedFocus = -1;

$effect(() => watchPhoneViewport((phone) => (isPhone = phone)));

let railWidth = $derived(commentRailWidth(panelWidth));
let presentation = $derived<"rail" | "drawer" | "sheet">(
	isPhone ? "sheet" : railWidth === null ? "drawer" : "rail",
);

let rows = $derived(
	controller.threads.map((thread) => ({
		thread,
		orphaned: isOrphaned(thread, controller.nodes),
	})),
);
function isShown(thread: ArtifactComment): boolean {
	return controller.filter === "all" || thread.status !== "resolved";
}
let placed = $derived(
	rows.filter((row) => !row.orphaned && isShown(row.thread)),
);
let orphans = $derived(
	rows.filter((row) => row.orphaned && isShown(row.thread)),
);
let resolvedCount = $derived(threadCounts(controller.threads).resolved);
let emptyText = $derived(
	resolvedCount > 0 &&
		controller.filter === "open" &&
		controller.openCount === 0
		? $t("artifacts.document.margin.emptyAllResolved")
		: $t("artifacts.canvas.comment.empty"),
);

/** What a comment is on, in words: the block's own, else its kind ("Sticky note"), else "a spot on the board". */
function targetName(anchor: Anchor | null): string {
	if (anchor?.kind !== "node") return $t("artifacts.canvas.comment.spot");
	const node = controller.nodes.find(
		(candidate) => candidate.id === anchor.nodeId,
	);
	if (!node) return $t("artifacts.canvas.comment.spot");
	return nodeWords(node) ?? $t(metaFor(node.type).labelKey as I18nKey);
}

function quoteOf(thread: ArtifactComment, orphaned: boolean): string {
	return orphaned
		? $t("artifacts.canvas.comment.blockGone")
		: targetName(thread.anchor);
}

/** Shows a thread on the board. Where the list covers the board (a drawer, a sheet) it closes first: the board is what they came for. */
function goTo(commentId: string): void {
	controller.goToThread(commentId);
	if (presentation !== "rail") controller.hide();
}

/**
 * A click on the card itself (anywhere that is not a control of its own) takes
 * the reader to the thread's pin. The quote button is the keyboard route to the
 * same place, so this adds a pointer shortcut, not a second way to reach it.
 */
function handleCardClick(
	event: MouseEvent,
	commentId: string,
	orphaned: boolean,
): void {
	if (orphaned) return;
	const target = event.target as HTMLElement | null;
	if (
		target?.closest(
			"button, a, textarea, input, select, [contenteditable='true']",
		)
	) {
		return;
	}
	if (window.getSelection()?.toString()) return;
	goTo(commentId);
}

// A pressed pin asks for its card: scroll it into view and focus it, once per request.
$effect(() => {
	const request = controller.focus;
	if (!request || request.token === appliedFocus) return;
	untrack(() => {
		void tick().then(() => {
			const card = [
				...(listEl?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? []),
			].find((candidate) => candidate.dataset.commentId === request.commentId);
			if (!card) return;
			appliedFocus = request.token;
			card.scrollIntoView({
				block: "nearest",
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});
			card.focus();
		});
	});
});
</script>

{#snippet card(thread: ArtifactComment, orphaned: boolean)}
	<!-- A click on the card body is a pointer shortcut for the quote button inside
	     it, which is the keyboard-accessible way to the same place — so the card
	     itself deliberately has no key handler. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
	<article
		class="comment-list-item"
		class:is-active={controller.activeId === thread.id}
		class:is-resolved={thread.status === 'resolved'}
		class:is-goto={!orphaned}
		class:is-orphaned={orphaned}
		tabindex="-1"
		aria-label={quoteOf(thread, orphaned)}
		data-testid="canvas-comment"
		data-comment-id={thread.id}
		onclick={(event) => handleCardClick(event, thread.id, orphaned)}
		onmouseenter={() => controller.hover(thread.id)}
		onmouseleave={() => controller.hover(null)}
		onfocusin={() => controller.hover(thread.id)}
		onfocusout={() => controller.hover(null)}
	>
		<CommentThread
			{thread}
			kind="canvas"
			quote={quoteOf(thread, orphaned)}
			quoteLabel={orphaned
				? null
				: $t('artifacts.canvas.comment.quoteA11y', { target: quoteOf(thread, orphaned) })}
			badge={orphaned ? null : pinLabel(controller.threads, thread.id)}
			alfyBusy={controller.asking === thread.id}
			replyPlaceholder={$t('artifacts.canvas.comment.replyPlaceholder')}
			askAlfyHint={$t('artifacts.canvas.comment.alfyHint')}
			onResolve={(resolved) => controller.resolve(thread.id, resolved)}
			onSubmitReply={(parentId, body) => controller.reply(parentId, body)}
			onGoto={orphaned ? undefined : () => goTo(thread.id)}
			currentUserId={currentUser?.id ?? null}
			currentUserName={currentUser?.displayName ?? null}
			currentUserProfilePicture={currentUser?.profilePicture ?? null}
		/>
	</article>
{/snippet}

{#snippet list(shape: 'rail' | 'drawer' | 'sheet')}
	<div class="canvas-comments" data-layout={shape}>
		<CommentListHeader
			openCount={controller.openCount}
			{resolvedCount}
			filter={controller.filter}
			ontogglefilter={() => (controller.filter = controller.filter === 'open' ? 'all' : 'open')}
			onClose={shape === 'drawer' ? () => controller.hide() : undefined}
		/>
		<div class="canvas-comments-list" data-testid="canvas-comments-list" bind:this={listEl}>
			{#if controller.draft}
				{@const anchor = controller.draft}
				<CommentComposer
					header={$t('artifacts.canvas.comment.newOn', { target: targetName(anchor) })}
					placeholder={$t('artifacts.canvas.comment.placeholder')}
					alfyHint={$t('artifacts.canvas.comment.alfyHint')}
					onsubmit={(body) => controller.post(anchor, body)}
					oncancel={() => controller.cancelDraft()}
				/>
			{/if}
			{#if controller.notice}
				<p class="canvas-comments-notice" role="alert">{controller.notice}</p>
			{/if}
			{#each placed as row (row.thread.id)}
				{@render card(row.thread, false)}
			{/each}
			{#if placed.length === 0 && orphans.length === 0 && !controller.draft}
				<p class="canvas-comments-empty">{emptyText}</p>
			{/if}
			{#if orphans.length > 0}
				<CommentFoldedGroup
					label={$t('artifacts.canvas.comment.orphanedGroup', { count: orphans.length })}
					open={controller.orphanedOpen}
					ontoggle={() => (controller.orphanedOpen = !controller.orphanedOpen)}
				>
					{#each orphans as row (row.thread.id)}
						{@render card(row.thread, true)}
					{/each}
				</CommentFoldedGroup>
			{/if}
		</div>
		<span class="sr-only" role="status" aria-live="polite">{controller.status}</span>
	</div>
{/snippet}

{#if controller.open}
	{#if presentation === 'rail'}
		<aside
			class="canvas-comments-rail"
			style:width="{railWidth}px"
			aria-label={$t('artifacts.document.margin.title')}
			data-testid="canvas-comments-rail"
		>
			{@render list('rail')}
		</aside>
	{:else}
		<CommentsSurface
			{presentation}
			title={$t('artifacts.document.margin.title')}
			onClose={() => controller.hide()}
		>
			{#snippet children({ presentation: shown })}
				{@render list(shown)}
			{/snippet}
		</CommentsSurface>
	{/if}
{/if}

<style>
	/* Beside the board, the way the Document's column is beside its text: as tall
	   as the board, its own scroll, a hairline between. */
	.canvas-comments-rail {
		display: flex;
		flex: 0 0 auto;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		border-left: 1px solid var(--border-subtle);
		background-color: var(--surface-page);
	}

	.canvas-comments {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	/* One scroll for the whole list — the composer, the cards, the removed-block
	   fold — with room under the last row so nothing ends up hugging the bottom
	   edge. `overscroll-behavior` keeps a fling at the end from carrying on. */
	.canvas-comments-list {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 0.625rem;
		min-height: 0;
		padding: 0.75rem 0.875rem 1.5rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.canvas-comments[data-layout='sheet'] :global(.comment-list-item) {
		scroll-margin-top: 4.5rem;
	}

	.canvas-comments-empty {
		margin: 0;
		padding: 0.25rem 0.125rem;
		color: var(--text-muted);
		font-size: 0.78125rem;
		line-height: 1.5;
	}

	.canvas-comments-notice {
		margin: 0;
		padding: 0.5rem 0.625rem;
		border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
		border-radius: var(--radius-md);
		background: var(--warning-tint);
		color: var(--warning-text);
		font-size: var(--text-xs);
		line-height: 1.4;
	}
</style>
