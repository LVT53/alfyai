<script lang="ts">
/**
 * One comment thread (Feature 2 · Artifacts, Slice 1, T10): the root plus its
 * replies, each through the shared `CommentCard.svelte`, and the reply
 * composer. Posting and the resolve toggle are the CALLER's own network
 * calls (`DocumentBody.svelte`'s margin block owns `createArtifactComment` /
 * `askAlfyInComment` / `resolveArtifactComment`) — this component only knows
 * "post this text to this thread" and "set this thread's status".
 */
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import CommentCard from "../CommentCard.svelte";

let {
	thread,
	onResolve,
	onSubmitReply,
}: {
	thread: ArtifactComment;
	onResolve: (resolved: boolean) => void | Promise<void>;
	/** Posts a reply's text to `thread.id`. May itself trigger the @Alfy hook when the text mentions Alfy — that decision lives in the caller, not here. */
	onSubmitReply: (parentId: string, body: string) => void | Promise<void>;
} = $props();

let replying = $state(false);
let draftText = $state("");
let posting = $state(false);
let postError = $state(false);

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
</script>

<div class="comment-thread">
	<CommentCard comment={thread} {onResolve} onReplyClick={openReply} />
	{#each thread.replies as reply (reply.id)}
		<div class="comment-thread-reply">
			<CommentCard comment={reply} />
		</div>
	{/each}
	{#if replying}
		<div class="comment-thread-composer">
			<textarea
				class="comment-thread-textarea"
				placeholder={$t('artifacts.document.comment.placeholder')}
				bind:value={draftText}
				disabled={posting}
			></textarea>
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
					class="btn-primary"
					onclick={submitReply}
					disabled={posting || !draftText.trim()}
				>
					{posting && /@alfy/i.test(draftText)
						? $t('artifacts.document.comment.askingAlfy')
						: $t('artifacts.document.comment.submit')}
				</button>
			</div>
			{#if postError}
				<p class="comment-thread-error" role="alert">
					{$t('artifacts.document.comment.postError')}
				</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.comment-thread {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.comment-thread-reply {
		margin-left: 1rem;
	}

	.comment-thread-composer {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-left: 1rem;
	}

	.comment-thread-textarea {
		min-height: 3.5rem;
		padding: 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background-color: var(--surface-page);
		color: var(--text-primary);
		font: inherit;
		resize: vertical;
	}

	.comment-thread-composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.comment-thread-error {
		margin: 0;
		font-size: 0.75rem;
		color: var(--status-danger, #c0392b);
	}
</style>
