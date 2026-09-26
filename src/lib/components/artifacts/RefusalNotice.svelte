<script lang="ts">
/**
 * The one refusal notice for every artifact kind's panel (Feature 2 ·
 * Artifacts; created by Slice 1's T8, consumed by Canvas and Slides —
 * `slice-1.md` File ownership: "the shared root, not the document
 * directory... a copy under `document/`, `canvas/` or `slides/` would be a
 * second notice"). "Your words win" (spec §2.4/§2.5) is only a feature if the
 * user can see it happened (Review Focus 4).
 *
 * Deliberately generic: it takes already-localised strings, never a
 * `RefusalReason` code or an i18n key. Each type owns its own reason
 * vocabulary and its own i18n namespace (the Document's is
 * `artifacts.document.refused.*`, via `marks.ts`'s `summarizeRefusals` /
 * `refusalReasonI18nKey`) and resolves it to plain text before handing it
 * here — Canvas and Slides will have their own reasons entirely, and this
 * component must not need to know either vocabulary.
 */
let {
	message,
	items = [],
	seeChangeLabel = undefined,
	onSeeChange = undefined,
}: {
	/** The ICU-pluralised, already-localised summary sentence (e.g. `artifacts.document.refused.notice`). */
	message: string;
	/** One line per refused part: its label and its already-localised reason. */
	items?: { label: string; reason: string }[];
	/** Already-localised label for the "see what Alfy did" affordance (e.g. `artifacts.document.refused.seeChange`). Required together with `onSeeChange`. */
	seeChangeLabel?: string | undefined;
	/** Omitted when nothing in this patch actually applied — there is nothing to scroll to. */
	onSeeChange?: (() => void) | undefined;
} = $props();
</script>

<div class="refusal-notice" role="status" data-testid="refusal-notice">
	<p class="refusal-notice-message">{message}</p>
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
</div>

<style>
	.refusal-notice {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background-color: var(--surface-overlay);
		color: var(--text-primary);
		font-size: var(--text-sm);
	}

	.refusal-notice-message {
		margin: 0;
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
		color: var(--accent);
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
</style>
