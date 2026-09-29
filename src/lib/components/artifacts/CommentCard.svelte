<script lang="ts">
/**
 * The one card every comment MESSAGE renders as (ruling 45): threads,
 * replies, all share the same `artifact_comments` row shape (ruling 11), so
 * a Document reply and a future Canvas reply look the same. Redesigned for
 * the Artifacts redesign (redesign.md §3.2/§8, Wave 2.5 Step 6): avatar,
 * name, time, body with `@Alfy` highlighted, the Guess tag, and the change
 * chip. Created for Slice 1 (Document, T10); Slice 3 (Canvas) consumes this
 * file rather than forking its own — the `RefusalNotice.svelte` pattern.
 *
 * One MESSAGE, never a whole thread: `document/CommentThread.svelte` renders
 * the thread's own box (quote, connecting line, fold/peek, Reply/Resolve,
 * the composer) and calls this once per message (the root, then each
 * reply). Purely presentational and knows nothing about Tiptap or a live
 * document — `isGuess`/`changeState`/`onSeeChange`/`onAskAgain` are all
 * plain values and callbacks the caller (`CommentThread`) already resolved.
 */
import { CircleSlash, Sparkles } from "@lucide/svelte";
import AvatarCircle from "$lib/components/ui/AvatarCircle.svelte";
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
	isGuess = false,
	changeState,
	onSeeChange,
	onAskAgain,
	currentUserId = null,
	currentUserName = null,
	currentUserProfilePicture = null,
}: {
	comment: ArtifactComment;
	/**
	 * True only for a thread's ROOT message, and only when Alfy started the
	 * thread unprompted — a judgement call it made on its own (spec decision
	 * 8, redesign §3.2 "Alfy's own notes"). `CommentThread` decides this
	 * (`thread.parentId === null && thread.author === 'alfy'`); a REPLY from
	 * Alfy inside a thread the user started is never tagged Guess.
	 */
	isGuess?: boolean;
	/**
	 * Set when THIS message's own `@Alfy` reply produced an edit still
	 * tracked this session — `DocumentBody.svelte`'s `pendingChanges`, keyed
	 * by the changeId this comment produced. Ephemeral like `ChangeBar`'s own
	 * state (ruling: ADR-0066's ephemeral review state, not yet durable —
	 * rd2's own hand-off note); `undefined` renders no chip at all, which is
	 * also what a reload shows today.
	 */
	changeState?: "pending" | "kept" | "undone";
	/** "See change" — scrolls to and flashes the change this message made. Omitted together with `changeState`. */
	onSeeChange?: () => void;
	/** The refused-reply quick action ("Ask again", §3.3's "Alfy refused" row) — opens the SAME reply composer `CommentThread`'s own Reply button does. Rendered only on a refusal message. */
	onAskAgain?: () => void;
	/**
	 * rd/review-2-5.md:272-275: the signed-in user's own id/name/profile
	 * picture — the current session, i.e. whoever "you" (`authorLabel` below)
	 * refers to, since a Document has exactly one human collaborator. `null`
	 * falls back to the old literal `"user"` placeholder.
	 */
	currentUserId?: string | null;
	currentUserName?: string | null;
	currentUserProfilePicture?: string | null;
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

/** Splits the (already-resolved) body on literal `@Alfy` mentions so the template can give each one accent styling — never on the raw marker text, which never reaches here as `@Alfy`-shaped content. */
function splitMentions(text: string): { text: string; isMention: boolean }[] {
	const parts = text.split(/(@Alfy)/gi);
	return parts
		.filter((part) => part.length > 0)
		.map((part) => ({ text: part, isMention: /^@Alfy$/i.test(part) }));
}
let bodySegments = $derived(splitMentions(displayBody));

let changeChipLabel = $derived(
	changeState === "kept"
		? $t("artifacts.document.comment.changeKept")
		: changeState === "undone"
			? $t("artifacts.document.comment.changeUndone")
			: $t("artifacts.document.comment.changeEdited"),
);
</script>

<div class="comment-card" class:comment-card-refused={isRefusal}>
	<span class="comment-card-avatar">
		{#if comment.author === 'alfy'}
			<span class="comment-card-alfy-avatar" aria-hidden="true">
				<Sparkles size={12} strokeWidth={2} />
			</span>
		{:else}
			<AvatarCircle
				userId={currentUserId ?? 'user'}
				name={currentUserName}
				profilePicture={currentUserProfilePicture}
				size={22}
			/>
		{/if}
	</span>
	<header class="comment-card-header">
		<span class="comment-card-author">{authorLabel}</span>
		<time class="comment-card-time">{formatRelativeTime(comment.createdAt, { t: $t })}</time>
		{#if isGuess}
			<span class="comment-card-guess-tag">{$t('artifacts.document.comment.guessTag')}</span>
		{/if}
	</header>
	<p class="comment-card-body">
		{#each bodySegments as segment, index (index)}
			{#if segment.isMention}<span class="comment-card-mention">{segment.text}</span>{:else}{segment.text}{/if}
		{/each}
	</p>
	{#if hasPartialRefusal}
		<p class="comment-card-partial-refusal">
			{$t('artifacts.document.comment.alfyPartialRefusal')}
		</p>
	{/if}
	{#if isRefusal}
		<div class="comment-card-refusal-row">
			<CircleSlash size={13} strokeWidth={2} aria-hidden="true" />
			{#if onAskAgain}
				<button type="button" class="btn-ghost btn-sm" onclick={onAskAgain}>
					{$t('artifacts.document.comment.askAgain')}
				</button>
			{/if}
		</div>
	{/if}
	{#if changeState}
		<div class="comment-card-change-chip">
			<Sparkles size={12} strokeWidth={2} aria-hidden="true" />
			<span class="comment-card-change-label">{changeChipLabel}</span>
			{#if onSeeChange}
				<button type="button" class="comment-card-change-see" onclick={onSeeChange}>
					{$t('artifacts.document.comment.seeChange')}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* The mockup's message row: the avatar in its own narrow column, the
	   name line and the text stacked to its right, so a thread's messages
	   share one left edge for their words (redesign §3.2's anatomy). */
	.comment-card {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr);
		column-gap: 0.5625rem;
		row-gap: 0.125rem;
	}

	.comment-card > :not(.comment-card-avatar) {
		grid-column: 2;
		min-width: 0;
	}

	.comment-card-avatar {
		grid-column: 1;
		grid-row: 1 / span 6;
		align-self: start;
		margin-top: 0.0625rem;
		line-height: 0;
	}

	.comment-card-refused {
		border-radius: var(--radius-md);
		background-color: var(--warning-tint);
		padding: 0.375rem 0.5rem;
		margin: -0.375rem -0.5rem;
	}

	.comment-card-header {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		font-size: 0.78125rem;
		color: var(--text-muted);
	}

	.comment-card-alfy-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		border-radius: var(--radius-full, 999px);
		background-color: var(--accent-tint);
		color: var(--accent-text);
	}

	.comment-card-author {
		font-weight: 700;
		color: var(--text-primary);
	}

	.comment-card-time {
		font-size: 0.71875rem;
	}

	.comment-card-guess-tag {
		margin-left: auto;
		font-size: 0.65625rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--accent-text);
	}

	.comment-card-body {
		margin: 0;
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-primary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.comment-card-mention {
		color: var(--accent-text);
		font-weight: 700;
	}

	/* RV-1B, coordinator item 8: a lighter-weight note than the refusal row
	   below — this reply mostly succeeded, so it never changes the card's
	   own background, it just makes the partial refusal readable instead of
	   silent. */
	.comment-card-partial-refusal {
		margin: 0;
		font-size: var(--text-xs);
		font-style: italic;
		color: var(--text-muted);
	}

	.comment-card-refusal-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--warning-text);
	}

	.comment-card-change-chip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.25rem;
		padding: 0.375rem 0.5rem;
		border-radius: var(--radius-lg);
		background-color: var(--accent-tint);
		color: var(--accent-text);
		font-size: var(--text-xs);
	}

	.comment-card-change-label {
		font-weight: 600;
	}

	.comment-card-change-see {
		border: none;
		background: none;
		padding: 0;
		margin-left: auto;
		color: var(--accent-text);
		font-family: var(--font-sans);
		font-size: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.comment-card-change-see:hover {
		text-decoration: underline;
	}

	.comment-card-change-see:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	@media (max-width: 767px) {
		.comment-card-change-see {
			position: relative;
		}

		.comment-card-change-see::after {
			content: '';
			position: absolute;
			inset: -0.875rem -0.5rem;
		}
	}
</style>
