<script lang="ts">
/**
 * The one refusal notice for every artifact kind's panel (Feature 2 ·
 * Artifacts; created by Slice 1's T8, consumed by Canvas and Slides —
 * `slice-1.md` File ownership: "the shared root, not the document
 * directory... a copy under `document/`, `canvas/` or `slides/` would be a
 * second notice"). "Your words win" (spec §2.4/§2.5) is only a feature if the
 * user can see it happened (Review Focus 4).
 *
 * Redesigned for the Artifacts redesign (redesign.md §4.2 "Refusal", §9.2's
 * own row: "warning card variant pinned beside its line + summary line",
 * Wave 2.5 Step 11): the warning-card variant of the comment family —
 * `CircleSlash`/`--warning-tint`, matching `CommentCard.svelte`'s own
 * refusal-message treatment exactly (rd3a's hand-off: "the two should read
 * as the same family, not two different visual languages for 'Alfy
 * refused'") — with its own "Ask again"/"Dismiss" actions. `DocumentBody.svelte`
 * pins it beside the refused block (`document-editor.ts`'s `blockRect`) and
 * marks the line itself with the dashed gutter rule
 * (`alfy-writing-decoration.ts`'s `setRefusedLines`) — this component only
 * renders the card.
 *
 * Deliberately generic: it takes already-localised strings, never a
 * `RefusalReason` code or an i18n key. Each type owns its own reason
 * vocabulary and its own i18n namespace (the Document's is
 * `artifacts.document.refused.*`, via `marks.ts`'s `summarizeRefusals` /
 * `refusalReasonI18nKey`) and resolves it to plain text before handing it
 * here — Canvas and Slides will have their own reasons entirely, and this
 * component must not need to know either vocabulary.
 */
import { CircleSlash, Sparkles } from "@lucide/svelte";

let {
	message,
	items = [],
	seeChangeLabel = undefined,
	onSeeChange = undefined,
	askAgainLabel = undefined,
	onAskAgain = undefined,
	dismissLabel = undefined,
	onDismiss = undefined,
}: {
	/** The ICU-pluralised, already-localised summary sentence (e.g. `artifacts.document.refused.notice`). */
	message: string;
	/** One line per refused part: its label and its already-localised reason. */
	items?: { label: string; reason: string }[];
	/** Already-localised label for the "see what Alfy did" affordance (e.g. `artifacts.document.refused.seeChange`). Required together with `onSeeChange`. */
	seeChangeLabel?: string | undefined;
	/** Omitted when nothing in this patch actually applied — there is nothing to scroll to. */
	onSeeChange?: (() => void) | undefined;
	/** Already-localised label for "Ask again" (e.g. reusing `artifacts.document.comment.askAgain` — the same word `CommentCard`'s own refusal variant already uses). Required together with `onAskAgain`. */
	askAgainLabel?: string | undefined;
	/** Re-surfaces the ask flow at the refused line (`document-editor.ts`'s `selectAndScrollToBlock`). Omitted when the caller has no block to return to. */
	onAskAgain?: (() => void) | undefined;
	/** Already-localised label for "Dismiss" (e.g. `artifacts.document.refused.dismiss`). Required together with `onDismiss`. */
	dismissLabel?: string | undefined;
	/** Clears this notice. Omitted when the caller has no dismiss state to clear. */
	onDismiss?: (() => void) | undefined;
} = $props();
</script>

<div class="refusal-notice" role="status" data-testid="refusal-notice">
	<div class="refusal-notice-head">
		<CircleSlash size={14} strokeWidth={2} class="refusal-notice-icon" aria-hidden="true" />
		<p class="refusal-notice-message">{message}</p>
	</div>
	{#if items.length > 0}
		<ul class="refusal-notice-items">
			{#each items as item (item.label + item.reason)}
				<li><strong>{item.label}</strong> — {item.reason}</li>
			{/each}
		</ul>
	{/if}
	{#if onSeeChange && seeChangeLabel}
		<button
			type="button"
			class="refusal-notice-see-change"
			onclick={onSeeChange}
		>
			{seeChangeLabel}
		</button>
	{/if}
	{#if (onAskAgain && askAgainLabel) || (onDismiss && dismissLabel)}
		<div class="refusal-notice-actions">
			{#if onAskAgain && askAgainLabel}
				<button type="button" class="btn-ghost btn-sm" onclick={onAskAgain}>
					<Sparkles size={13} strokeWidth={2} aria-hidden="true" />
					{askAgainLabel}
				</button>
			{/if}
			{#if onDismiss && dismissLabel}
				<button type="button" class="btn-ghost btn-sm" onclick={onDismiss}>
					{dismissLabel}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* `--warning-tint`/`--warning-text` — the same pairing
	   `CommentCard.svelte`'s own `.comment-card-refused`/`.comment-card-
	   refusal-row` use, so a refusal reads as one visual language everywhere
	   it appears. */
	.refusal-notice {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background-color: var(--warning-tint);
		color: var(--text-primary);
		font-size: var(--text-sm);
	}

	.refusal-notice-head {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		color: var(--warning-text);
	}

	.refusal-notice-head :global(.refusal-notice-icon) {
		flex: 0 0 auto;
		margin-top: 0.1875rem;
	}

	.refusal-notice-message {
		margin: 0;
		color: var(--text-primary);
	}

	.refusal-notice-items {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.refusal-notice-see-change {
		align-self: flex-start;
		border: none;
		background: none;
		padding: 0;
		color: var(--accent-text);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.refusal-notice-see-change:hover {
		text-decoration: underline;
	}

	.refusal-notice-see-change:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.refusal-notice-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
</style>
