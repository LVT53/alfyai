<script lang="ts">
/**
 * The shared review bar (Feature 2 · Artifacts redesign §4.2 item 5/6, §8's
 * own row: "pending count, refused count, index, prev/next, Keep all / Undo
 * all"; Wave 2.5 Step 10). Knows nothing about Tiptap or ProseMirror — a
 * Document body drives it from `pendingChanges`/`refusalNotice` (this
 * session), Canvas and Slides will drive the SAME component from their own
 * state later. Positioning ("bottom of the text column" / "bottom of the
 * board / the slide", §8) is the CALLER's job: this component lays out its
 * own content but does not place itself on the page.
 *
 * rd/review-2-5.md:217-222: a plain, non-live, NAMED `role="region"` — it
 * used to be `role="status"`, on the theory that the region's own text
 * (already populated the moment it mounts, since the caller only renders
 * this component once `pendingCount > 0`) would double as its own polite
 * landing announcement (§4.4: "Alfy changed 1 part and left 1 alone. Review
 * it below the text."). Two real problems with that: most screen readers do
 * not announce a region that already carries text at the moment of
 * insertion (only a text CHANGE on an already-mounted live region reliably
 * is), and because the stepper's own buttons live INSIDE that same live
 * region, moving `currentIndex` re-announced the WHOLE bar — buttons and
 * all — on every Prev/Next click. `DocumentBody.svelte`'s own shared,
 * always-mounted announcer now owns every one of this surface's
 * announcements (the landing summary included); this component's own region
 * is a landmark by name only.
 */
import { Check, ChevronDown, ChevronUp, Sparkles, Undo2 } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	pendingCount,
	refusedCount = 0,
	currentIndex,
	onPrev,
	onNext,
	onKeepAll,
	onUndoAll,
	onSeeRefused,
}: {
	/** Always > 0 while this component is mounted — the caller renders nothing otherwise (redesign §4.3: "no bar" once nothing is pending). */
	pendingCount: number;
	refusedCount?: number;
	/** 0-based; shown as `currentIndex + 1`. */
	currentIndex: number;
	onPrev: () => void;
	onNext: () => void;
	onKeepAll: () => void;
	onUndoAll: () => void;
	/** Omitted when nothing was refused — there is nothing to jump to. */
	onSeeRefused?: () => void;
} = $props();
</script>

<div
	class="review-bar"
	role="region"
	aria-label={$t('artifacts.document.review.regionLabel')}
>
	<div class="review-bar-msg">
		<span class="review-bar-spark" aria-hidden="true">
			<Sparkles size={14} strokeWidth={2} />
		</span>
		<span>
			{$t('artifacts.document.review.summary', { count: pendingCount })}
			{#if refusedCount > 0}
				<button
					type="button"
					class="review-bar-left-link"
					onclick={onSeeRefused}
				>
					{$t('artifacts.document.refused.reviewBarLeft', { count: refusedCount })}
				</button>
			{/if}
		</span>
	</div>
	<div class="review-bar-nav">
		<button
			type="button"
			class="btn-icon"
			aria-label={$t('artifacts.document.review.prev')}
			disabled={pendingCount < 2}
			onclick={onPrev}
		>
			<ChevronUp size={16} strokeWidth={2} aria-hidden="true" />
		</button>
		<span class="review-bar-pos">{currentIndex + 1} / {pendingCount}</span>
		<button
			type="button"
			class="btn-icon"
			aria-label={$t('artifacts.document.review.next')}
			disabled={pendingCount < 2}
			onclick={onNext}
		>
			<ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
	<div class="review-bar-actions">
		<button type="button" class="btn-secondary btn-sm" onclick={onUndoAll}>
			<Undo2 size={13} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.document.review.undoAll')}
		</button>
		<button type="button" class="btn-primary btn-sm" onclick={onKeepAll}>
			<Check size={13} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.document.review.keepAll')}
		</button>
	</div>
</div>

<style>
	/* Mirrors the mockup's `.review` exactly, minus positioning (the
	   caller's own `position: absolute` wrapper places this on the page —
	   this component only knows its own internal layout). */
	.review-bar {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-wrap: wrap;
		min-height: 3rem;
		padding: 0.4375rem 0.5rem 0.4375rem 0.875rem;
		border-radius: 0.75rem;
		background-color: var(--surface-overlay);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-default));
		box-shadow: var(--shadow-lg);
	}

	.review-bar-msg {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		flex: 1 1 16.25rem;
		font-size: var(--text-sm);
	}

	.review-bar-spark {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 1.625rem;
		height: 1.625rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--accent-tint);
		color: var(--accent-text);
	}

	.review-bar-left-link {
		border: none;
		background: none;
		padding: 0;
		margin-left: 0.25rem;
		color: var(--accent-text);
		font-family: var(--font-sans);
		font-size: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.review-bar-left-link:focus-visible {
		outline: 2px solid var(--focus-ring, var(--border-focus));
		outline-offset: 1px;
	}

	.review-bar-nav {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.review-bar-pos {
		min-width: 2.75rem;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.review-bar-actions {
		display: inline-flex;
		gap: 0.375rem;
		margin-left: auto;
	}

	/* Redesign §4.4: 44px Keep all / Undo all on phones. Review 2.5 Critical
	   finding (rd/review-2-5.md:45-56): under `flex-direction: column`, a
	   flex-basis meant for the DESKTOP row layout (`.review-bar-msg`'s own
	   `flex: 1 1 16.25rem` above) becomes a 260px HEIGHT basis instead of a
	   width one — the message row alone ballooned to ~390px, covering half
	   the document. `flex: 0 0 auto` here lets it size to its own wrapped
	   content instead. */
	@media (max-width: 480px) {
		.review-bar {
			flex-direction: column;
			align-items: stretch;
		}

		.review-bar-msg {
			flex: 0 0 auto;
		}

		.review-bar-nav {
			align-self: flex-start;
		}

		.review-bar-actions {
			margin-left: 0;
		}

		.review-bar-actions :global(button) {
			flex: 1 1 0;
			min-height: 2.75rem;
		}

		/* Review 2.5 (rd/review-2-5.md:45-56, "4b's open item #4"): the global
		   `@media (max-width: 767px) .btn-icon` rule in app.css already
		   targets 44px, but this bar's own prev/next need to hit that target
		   deterministically without depending on a cross-file cascade —
		   `min-width`/`min-height` here are the local, self-contained source
		   of truth for this specific control. */
		.review-bar-nav :global(button.btn-icon) {
			min-height: 44px;
			min-width: 44px;
		}
	}
</style>
