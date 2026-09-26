<script lang="ts">
/**
 * The one card every comment renders as (ruling 45): threads, status,
 * replies, all share the same `artifact_comments` row shape (ruling 11), so
 * a Document reply and a future Canvas reply look the same. Created here for
 * Slice 1 (Document, T10); Slice 3 (Canvas) consumes this file rather than
 * forking its own — the `RefusalNotice.svelte` pattern.
 *
 * Purely presentational: it never calls the network itself. `onResolve` and
 * `onReplyClick` are omitted entirely by the caller for a comment that
 * cannot carry that action (a reply has no `onResolve`; nothing here decides
 * that on its own).
 */
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import {
	ALFY_EMPTY_REPLY_MARKER,
	ALFY_PARTIAL_REFUSAL_SUFFIX,
	ALFY_REFUSED_MARKER,
} from "$lib/shared/artifact-document/alfy-reply";
import { formatRelativeTime } from "$lib/utils/time";

let {
	comment,
	onResolve,
	onReplyClick,
}: {
	comment: ArtifactComment;
	onResolve?: (resolved: boolean) => void;
	onReplyClick?: () => void;
} = $props();

let authorLabel = $derived(
	comment.author === "alfy"
		? $t("artifacts.document.versions.byAlfy")
		: $t("artifacts.document.versions.byUser"),
);

/**
 * RV-1B, coordinator item 8: `runAlfyCommentReply` appends this suffix (never
 * replacing the note, unlike the two whole-body markers below) when the SAME
 * `@Alfy` reply both applied and refused at least one op — stripped off
 * BEFORE the two `===` marker checks below, so a partial refusal on an
 * otherwise-empty note still matches `ALFY_EMPTY_REPLY_MARKER` and renders
 * its own localized text rather than leaking the raw marker.
 */
let hasPartialRefusal = $derived(
	comment.author === "alfy" &&
		comment.body.endsWith(ALFY_PARTIAL_REFUSAL_SUFFIX),
);
let bodyWithoutPartialRefusalSuffix = $derived(
	hasPartialRefusal
		? comment.body.slice(0, -ALFY_PARTIAL_REFUSAL_SUFFIX.length)
		: comment.body,
);

/**
 * The two fixed markers `runAlfyCommentReply` writes instead of literal text
 * (T10.5) resolve to their localized notice here — the ONE place a comment
 * body is rendered, so a marker can never reach the user as raw text.
 */
let displayBody = $derived.by(() => {
	if (comment.author === "alfy") {
		if (bodyWithoutPartialRefusalSuffix === ALFY_REFUSED_MARKER) {
			return $t("artifacts.document.comment.alfyRefused");
		}
		if (bodyWithoutPartialRefusalSuffix === ALFY_EMPTY_REPLY_MARKER) {
			return $t("artifacts.document.comment.alfyDone");
		}
	}
	return bodyWithoutPartialRefusalSuffix;
});

let isRefusal = $derived(
	comment.author === "alfy" && comment.body === ALFY_REFUSED_MARKER,
);
</script>

<article class="comment-card" class:comment-card-refused={isRefusal}>
	<header class="comment-card-header">
		<span class="comment-card-author">{authorLabel}</span>
		<time class="comment-card-time">{formatRelativeTime(comment.createdAt, { t: $t })}</time>
		{#if comment.status === 'resolved'}
			<span class="comment-card-badge">{$t('artifacts.document.comment.resolved')}</span>
		{/if}
	</header>
	<p class="comment-card-body">{displayBody}</p>
	{#if hasPartialRefusal}
		<p class="comment-card-partial-refusal">
			{$t('artifacts.document.comment.alfyPartialRefusal')}
		</p>
	{/if}
	{#if onResolve || onReplyClick}
		<div class="comment-card-actions">
			{#if onReplyClick}
				<button type="button" class="btn-text" onclick={onReplyClick}>
					{$t('artifacts.document.comment.reply')}
				</button>
			{/if}
			{#if onResolve}
				<button
					type="button"
					class="btn-text"
					onclick={() => onResolve?.(comment.status !== 'resolved')}
				>
					{comment.status === 'resolved'
						? $t('artifacts.document.comment.reopen')
						: $t('artifacts.document.comment.resolve')}
				</button>
			{/if}
		</div>
	{/if}
</article>

<style>
	.comment-card {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.625rem 0.75rem;
		border-radius: var(--radius-md);
		background-color: var(--surface-page);
	}

	.comment-card-refused {
		background-color: var(--surface-overlay);
	}

	.comment-card-header {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.comment-card-author {
		font-weight: 600;
		color: var(--text-primary);
	}

	.comment-card-badge {
		margin-left: auto;
		padding: 0.0625rem 0.375rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.6875rem;
	}

	.comment-card-body {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-primary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* RV-1B, coordinator item 8: a lighter-weight note than `.comment-card-refused`
	   — this reply mostly succeeded, so it never changes the card's own background,
	   it just makes the partial refusal readable instead of silent. */
	.comment-card-partial-refusal {
		margin: 0;
		font-size: 0.75rem;
		font-style: italic;
		color: var(--text-muted);
	}

	.comment-card-actions {
		display: flex;
		gap: 0.75rem;
	}

	.comment-card-actions .btn-text {
		font-size: 0.75rem;
		padding: 0;
	}
</style>
