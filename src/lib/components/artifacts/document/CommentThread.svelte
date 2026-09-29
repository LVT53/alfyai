<script lang="ts">
/**
 * One comment thread's own card contents (Feature 2 · Artifacts, Slice 1,
 * T10; redesigned for the Artifacts redesign, redesign.md §3.2/§7.2/§8, Wave
 * 2.5 Step 6): the quote line, the root message, every reply, the shared
 * Reply/Resolve actions, the fold/peek once resolved, and the reply composer
 * that turns into Ask Alfy. `MarginPanel.svelte` owns the card's own
 * positioning/border/active-link chrome (`.margin-panel-item`) and passes
 * this component an already-resolved quote — this file never touches Tiptap,
 * a live document, or anchor resolution itself (`document/margin-layout.ts`'s
 * own boundary).
 *
 * Posting and the resolve toggle are the CALLER's own network calls
 * (`DocumentBody.svelte`'s margin block owns `createArtifactComment` /
 * `askAlfyInComment` / `resolveArtifactComment`) — this component only knows
 * "post this text to this thread", "set this thread's status", "scroll to
 * the anchor" and "scroll to a change", each already bound by the caller.
 */
import {
	Check,
	ChevronDown,
	CornerDownLeft,
	Quote,
	RotateCcw,
	Sparkles,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import CommentCard from "../CommentCard.svelte";

const ALFY_MENTION_RE = /@alfy\b/i;
const FOLDED_PREVIEW_MAX = 60;

let {
	thread,
	quote = null,
	quoteMoved = false,
	quoteStruck = false,
	changeStateByCommentId = {},
	onResolve,
	onSubmitReply,
	onGoto,
	onSeeChange,
	currentUserId = null,
	currentUserName = null,
	currentUserProfilePicture = null,
}: {
	thread: ArtifactComment;
	/** The anchor's own quote text, already resolved by the caller — `null` when this thread has no text anchor (a malformed/unparseable one; T10.9). */
	quote?: string | null;
	/** True when the anchor's words moved but were still found (`resolveTextAnchor`'s `"moved"` state) — shows "· Moved" beside the quote. */
	quoteMoved?: boolean;
	/** True for a thread rendered in the removed-text group: the quote reads struck through and the card's rule is dashed. */
	quoteStruck?: boolean;
	/** commentId -> chip state, covering the root AND any reply that itself produced a tracked change this session. */
	changeStateByCommentId?: Record<string, "pending" | "kept" | "undone">;
	onResolve: (resolved: boolean) => void | Promise<void>;
	/** Posts a reply's text to `thread.id`. May itself trigger the @Alfy hook when the text mentions Alfy — that decision lives in the caller, not here. */
	onSubmitReply: (parentId: string, body: string) => void | Promise<void>;
	/** Scrolls to and flashes this thread's own anchored words. Omitted when there is nowhere to go. */
	onGoto?: () => void;
	/** commentId -> "see the change this message made", passed through to whichever CommentCard(s) carry a changeState. */
	onSeeChange?: (commentId: string) => void;
	/** rd/review-2-5.md:272-275: the signed-in user's own id/name/profile picture, passed straight through to `CommentCard` for a real "you" avatar. `null` falls back to the placeholder. */
	currentUserId?: string | null;
	currentUserName?: string | null;
	currentUserProfilePicture?: string | null;
} = $props();

/** Alfy's own notes (spec decision 8, redesign §3.2): a thread whose FIRST message is Alfy's own, unprompted — never a reply inside a thread the user started. */
let isGuessThread = $derived(
	thread.parentId === null && thread.author === "alfy",
);

/** Resolved threads fold to one line by default (ruling 61); peeking is a one-way, per-mount reveal — Reopen (an ordinary status change) is what un-resolves a thread, not this. */
let peeked = $state(false);
let isFolded = $derived(thread.status === "resolved" && !peeked);

let replying = $state(false);
let draftText = $state("");
let posting = $state(false);
let postError = $state(false);
let mentionsAlfy = $derived(ALFY_MENTION_RE.test(draftText));

function openReply(): void {
	replying = true;
	postError = false;
}

function cancelReply(): void {
	replying = false;
	draftText = "";
	postError = false;
}

async function submitReply(): Promise<void> {
	const body = draftText.trim();
	if (!body || posting) return;
	posting = true;
	postError = false;
	try {
		await onSubmitReply(thread.id, body);
		draftText = "";
		replying = false;
	} catch {
		postError = true;
	} finally {
		posting = false;
	}
}

function handleComposerKeydown(event: KeyboardEvent): void {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		void submitReply();
	}
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
}
let foldedPreview = $derived(
	truncate(quote ?? thread.body, FOLDED_PREVIEW_MAX),
);
let foldedA11yLabel = $derived(
	`${$t("artifacts.document.comment.peekThread")}: ${foldedPreview}`,
);
</script>

<div class="comment-thread">
	{#if quote}
		<div class="comment-thread-quote-row">
			<button
				type="button"
				class="comment-thread-quote"
				class:comment-thread-quote-struck={quoteStruck}
				onclick={onGoto}
				disabled={!onGoto}
				aria-label={$t('artifacts.document.comment.quoteA11y', { quote })}
			>
				<Quote size={12} strokeWidth={2} aria-hidden="true" />
				<span class="comment-thread-quote-text">{quote}</span>
			</button>
			{#if quoteMoved}
				<span class="comment-thread-quote-moved">· {$t('artifacts.document.anchor.moved').toLowerCase()}</span>
			{/if}
		</div>
	{/if}

	<div class="comment-thread-collapsible" class:is-expanded={isFolded}>
		<div class="comment-thread-collapsible-inner">
			<!-- Rendered only while folded: an interactive element sitting in the
			     OTHER (collapsed) branch would still be a reachable, invisible tab
			     stop, and would duplicate this thread's own text for text queries. -->
			{#if isFolded}
				<button
					type="button"
					class="comment-thread-folded-line"
					onclick={() => (peeked = true)}
					aria-label={foldedA11yLabel}
				>
					<Check size={12} strokeWidth={2.5} aria-hidden="true" />
					<span class="comment-thread-folded-text">{foldedPreview}</span>
					{#if thread.replies.length > 0}
						<span class="comment-thread-folded-count">+{thread.replies.length}</span>
					{/if}
					<ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
				</button>
			{/if}
		</div>
	</div>

	<div class="comment-thread-collapsible" class:is-expanded={!isFolded}>
		<div class="comment-thread-collapsible-inner">
			{#if !isFolded}
			<div class="comment-thread-messages">
				<CommentCard
					comment={thread}
					isGuess={isGuessThread}
					changeState={changeStateByCommentId[thread.id]}
					onSeeChange={onSeeChange ? () => onSeeChange(thread.id) : undefined}
					onAskAgain={openReply}
					{currentUserId}
					{currentUserName}
					{currentUserProfilePicture}
				/>
				{#each thread.replies as reply (reply.id)}
					<div class="comment-thread-reply">
						<CommentCard
							comment={reply}
							changeState={changeStateByCommentId[reply.id]}
							onSeeChange={onSeeChange ? () => onSeeChange(reply.id) : undefined}
							onAskAgain={openReply}
							{currentUserId}
							{currentUserName}
							{currentUserProfilePicture}
						/>
					</div>
				{/each}
			</div>

			{#if !replying}
				<div class="comment-thread-actions">
					<button type="button" class="btn-ghost btn-sm" onclick={openReply}>
						<CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
						{$t('artifacts.document.comment.reply')}
					</button>
					<button
						type="button"
						class="btn-ghost btn-sm"
						onclick={() => onResolve(thread.status !== 'resolved')}
					>
						{#if thread.status === 'resolved'}
							<RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
							{$t('artifacts.document.comment.reopen')}
						{:else}
							<Check size={13} strokeWidth={2} aria-hidden="true" />
							{$t('artifacts.document.comment.resolve')}
						{/if}
					</button>
				</div>
			{/if}

			{#if replying}
				<div class="comment-thread-composer">
					<textarea
						class="comment-thread-textarea"
						placeholder={$t('artifacts.document.comment.replyPlaceholder')}
						bind:value={draftText}
						disabled={posting}
						onkeydown={handleComposerKeydown}
					></textarea>
					{#if mentionsAlfy && !posting}
						<p class="comment-thread-ask-hint">{$t('artifacts.document.comment.askAlfyHint')}</p>
					{/if}
					{#if posting && mentionsAlfy}
						<div class="comment-thread-typing" role="status">
							<span class="comment-thread-typing-dots" aria-hidden="true">
								<span></span><span></span><span></span>
							</span>
							<span>{$t('artifacts.document.comment.alfyTyping')}</span>
						</div>
					{/if}
					<div class="comment-thread-composer-actions">
						<button
							type="button"
							class="btn-secondary"
							onclick={cancelReply}
							disabled={posting}
						>
							{$t('artifacts.document.comment.cancel')}
						</button>
						<button
							type="button"
							class={mentionsAlfy ? 'btn-primary' : 'btn-secondary'}
							onclick={submitReply}
							disabled={posting || !draftText.trim()}
						>
							{#if mentionsAlfy}
								<Sparkles size={13} strokeWidth={2} aria-hidden="true" />
								{posting ? $t('artifacts.document.comment.askingAlfy') : $t('artifacts.document.comment.ask')}
							{:else}
								<CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
								{$t('artifacts.document.comment.reply')}
							{/if}
						</button>
					</div>
					{#if postError}
						<p class="comment-thread-error" role="alert">
							{$t('artifacts.document.comment.postError')}
						</p>
					{/if}
				</div>
			{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.comment-thread {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.comment-thread-quote-row {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
	}

	.comment-thread-quote {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		min-width: 0;
		border: none;
		background: none;
		padding: 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
		font-style: italic;
		cursor: pointer;
	}

	.comment-thread-quote:disabled {
		cursor: default;
	}

	.comment-thread-quote:not(:disabled):hover .comment-thread-quote-text {
		text-decoration: underline;
	}

	.comment-thread-quote:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.comment-thread-quote-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.comment-thread-quote-struck .comment-thread-quote-text {
		text-decoration: line-through;
	}

	.comment-thread-quote-moved {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: var(--text-2xs, 0.66rem);
	}

	/* A CSS-only height reveal (grid-template-rows 0fr -> 1fr): no JS
	   measurement, and it inherits the reduced-motion collapse app.css
	   already applies to every `transition` (§7.3: "instant fold"). */
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

	.comment-thread-folded-line {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		width: 100%;
		border: 1px dashed var(--border-default);
		border-radius: var(--radius-md);
		background: none;
		padding: 0.375rem 0.625rem;
		color: var(--success-text);
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.comment-thread-folded-line:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.comment-thread-folded-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
		color: var(--text-muted);
	}

	.comment-thread-folded-count {
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.comment-thread-messages {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.comment-thread-reply {
		position: relative;
		margin-left: 0.75rem;
		padding-left: 0.75rem;
		border-left: 2px solid var(--border-subtle);
	}

	.comment-thread-actions {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.375rem;
	}

	.comment-thread-composer {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-top: 0.5rem;
	}

	.comment-thread-textarea {
		min-height: 3.5rem;
		padding: 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background-color: var(--surface-page);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
		resize: vertical;
	}

	.comment-thread-ask-hint {
		margin: 0;
		color: var(--accent-text);
		font-size: var(--text-2xs, 0.66rem);
	}

	.comment-thread-typing {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-muted);
		font-size: var(--text-xs);
		font-style: italic;
	}

	.comment-thread-typing-dots {
		display: inline-flex;
		gap: 0.15rem;
	}

	.comment-thread-typing-dots span {
		width: 4px;
		height: 4px;
		border-radius: var(--radius-full, 999px);
		background-color: var(--text-muted);
		animation: comment-thread-typing-bounce 1s ease-in-out infinite;
	}

	.comment-thread-typing-dots span:nth-child(2) {
		animation-delay: 0.15s;
	}

	.comment-thread-typing-dots span:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes comment-thread-typing-bounce {
		0%,
		80%,
		100% {
			opacity: 0.3;
		}
		40% {
			opacity: 1;
		}
	}

	.comment-thread-composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.comment-thread-composer-actions button {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	.comment-thread-error {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--danger);
	}
</style>
