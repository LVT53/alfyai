<script lang="ts">
/**
 * The floating "Ask Alfy" / "Comment" bubble a text selection raises (T10.1).
 * Purely presentational and Tiptap-free: `DocumentBody.svelte` computes
 * `position` from the live selection (`document-editor.ts`'s
 * `readSelectionAnchorContext` plus `editor.view.coordsAtPos`, run through
 * `bubble-placement.ts`'s `computeBubblePlacement`) and owns the actual
 * `createArtifactComment` call behind `onSubmit`. This file only knows "the
 * user typed this text and pressed Post" plus which side of the selection it
 * was asked to sit on.
 *
 * `placement` picks the anchor transform: "above" (the default — matches
 * this component's original, only behaviour) anchors the bubble's
 * bottom-center at `position`; "below" (computeBubblePlacement's flip for
 * when there is no room above — see that module's own header comment) anchors
 * the top-center instead. Never mutated here — a placement decision is made
 * ONCE, by the caller, from real geometry; this file only renders it.
 */
import { MessageSquare, Sparkles } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	position,
	onSubmit,
	onDismiss,
}: {
	position: { x: number; y: number; placement?: "above" | "below" };
	onSubmit: (body: string) => void | Promise<void>;
	onDismiss: () => void;
} = $props();

let anchorTransform = $derived(
	position.placement === "below"
		? "translate(-50%, 0%)"
		: "translate(-50%, -100%)",
);

let composing = $state(false);
let draftText = $state("");
let posting = $state(false);

function openComment(): void {
	draftText = "";
	composing = true;
}

function openAskAlfy(): void {
	draftText = "@Alfy ";
	composing = true;
}

function cancel(): void {
	composing = false;
	draftText = "";
	onDismiss();
}

async function submit(): Promise<void> {
	const body = draftText.trim();
	if (!body || posting) return;
	posting = true;
	try {
		await onSubmit(body);
	} finally {
		posting = false;
	}
}
</script>

<div
	class="selection-bubble"
	data-testid="selection-bubble"
	style="left: {position.x}px; top: {position.y}px; transform: {anchorTransform};"
>
	{#if !composing}
		<button type="button" class="selection-bubble-action" onclick={openAskAlfy}>
			<Sparkles size={14} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.document.comment.ask')}
		</button>
		<button type="button" class="selection-bubble-action" onclick={openComment}>
			<MessageSquare size={14} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.document.comment.add')}
		</button>
	{:else}
		<textarea
			class="selection-bubble-textarea"
			placeholder={$t('artifacts.document.comment.placeholder')}
			bind:value={draftText}
			disabled={posting}
		></textarea>
		<div class="selection-bubble-composer-actions">
			<button type="button" class="btn-secondary" onclick={cancel} disabled={posting}>
				{$t('artifacts.document.comment.cancel')}
			</button>
			<button
				type="button"
				class="btn-primary"
				onclick={submit}
				disabled={posting || !draftText.trim()}
			>
				{$t('artifacts.document.comment.submit')}
			</button>
		</div>
	{/if}
</div>

<style>
	.selection-bubble {
		position: absolute;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.375rem;
		min-width: 12rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background-color: var(--surface-overlay);
		box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
		/* `transform` is set inline (script's `anchorTransform`) so it can flip
		   between anchoring above vs. below the selection. */
	}

	.selection-bubble-action {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.5rem;
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		color: var(--text-primary);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
	}

	.selection-bubble-action:hover {
		background-color: var(--surface-elevated);
	}

	.selection-bubble-textarea {
		min-height: 3.5rem;
		min-width: 14rem;
		padding: 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background-color: var(--surface-page);
		color: var(--text-primary);
		font: inherit;
		resize: vertical;
	}

	.selection-bubble-composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
