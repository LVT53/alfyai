<script lang="ts">
/**
 * The box a NEW thread is written in, for a kind whose comments do not begin
 * from a text selection (the Document's is `SelectionBubble`'s): the Canvas
 * places a comment on a block or a spot first, and its words are written here,
 * in the comments list, under a line that says what it is on. A reply is
 * `CommentThread`'s own box.
 *
 * The button is "Post" until the words mention Alfy, and then "Ask Alfy" with a
 * hint — the same turn `CommentThread`'s reply box makes, in the same words.
 * `onsubmit` does the network; a failure throws, and is answered here with the
 * words still in the box.
 */
import { CornerDownLeft, Sparkles } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { mentionsAlfy } from "$lib/shared/artifacts/comments";
import "./comment-list.css";

let {
	header,
	placeholder,
	alfyHint,
	onsubmit,
	oncancel,
}: {
	/** What the comment is on, already localised: "New comment on: Trains card". */
	header: string;
	placeholder: string;
	/** What answering Alfy will do, for this kind: shown under the box while the words mention it. */
	alfyHint: string;
	onsubmit: (body: string) => void | Promise<void>;
	oncancel: () => void;
} = $props();

/** Long enough for a dialog's own focus handling (a zero-delay timer) to have run. */
const FOCUS_RETRY_MS = 60;

let text = $state("");
let posting = $state(false);
let failed = $state(false);
let field = $state<HTMLTextAreaElement | null>(null);
let asks = $derived(mentionsAlfy(text));

// The reader placed this comment to write it: the words go straight into the box.
// A sheet or a drawer moves the focus into itself a moment after it opens (to its
// first control), so the box asks once more after that moment has passed.
$effect(() => {
	const box = field;
	if (!box) return;
	box.focus();
	const timer = setTimeout(() => {
		if (document.activeElement !== box) box.focus();
	}, FOCUS_RETRY_MS);
	return () => clearTimeout(timer);
});

async function submit(): Promise<void> {
	const body = text.trim();
	if (!body || posting) return;
	posting = true;
	failed = false;
	try {
		await onsubmit(body);
	} catch {
		failed = true;
	} finally {
		posting = false;
	}
}

function handleKeydown(event: KeyboardEvent): void {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		void submit();
	} else if (event.key === "Escape") {
		// Its own way out: a drawer's trap would otherwise take the Escape and close the list around what was typed.
		event.preventDefault();
		event.stopPropagation();
		oncancel();
	}
}
</script>

<form
	class="comment-composer comment-list-item"
	data-testid="comment-composer"
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
>
	<p class="comment-composer-header">{header}</p>
	<textarea
		class="comment-composer-field"
		bind:this={field}
		bind:value={text}
		{placeholder}
		aria-label={header}
		disabled={posting}
		onkeydown={handleKeydown}
	></textarea>
	{#if asks && !posting}
		<p class="comment-composer-hint">{alfyHint}</p>
	{/if}
	<div class="comment-composer-actions">
		<button type="button" class="btn-secondary" onclick={oncancel} disabled={posting}>
			{$t('artifacts.document.comment.cancel')}
		</button>
		<button
			type="submit"
			class={asks ? 'btn-primary' : 'btn-secondary'}
			disabled={posting || !text.trim()}
		>
			{#if asks}
				<Sparkles size={13} strokeWidth={2} aria-hidden="true" />
				{posting ? $t('artifacts.document.comment.askingAlfy') : $t('artifacts.document.comment.ask')}
			{:else}
				<CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
				{$t('artifacts.document.comment.submit')}
			{/if}
		</button>
	</div>
	{#if failed}
		<p class="comment-composer-error" role="alert">
			{$t('artifacts.document.comment.postError')}
		</p>
	{/if}
</form>

<style>
	.comment-composer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem 0.75rem;
		border-color: color-mix(in srgb, var(--accent) 55%, var(--border-default));
	}

	.comment-composer-header {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.comment-composer-field {
		width: 100%;
		min-height: 4.5rem;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-overlay);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
		line-height: 1.45;
		resize: none;
	}

	.comment-composer-field:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--accent) 60%, transparent);
		box-shadow: 0 0 0 3px var(--accent-tint);
	}

	.comment-composer-hint {
		margin: 0;
		color: var(--accent-text);
		font-size: 0.71875rem;
		line-height: 1.4;
	}

	.comment-composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.comment-composer-error {
		margin: 0;
		color: var(--danger);
		font-size: 0.75rem;
	}
</style>
