<script lang="ts">
/**
 * What is said above a board about Alfy's change (Feature 2 · Artifacts, Slice 3,
 * T6): "Alfy is arranging…" while the call runs, the shared `RefusalNotice` for
 * what Alfy skipped (never a canvas copy), and the same card when Undo could not
 * be done, pointing to the versions. The editor renders it in its own stack of
 * notices, top-centre over the board, and it also holds the one polite live
 * region for everything the change does (landed, kept, undone), so a screen
 * reader hears it once.
 */
import { Sparkles } from "@lucide/svelte";
import { t } from "$lib/i18n";
import RefusalNotice from "../RefusalNotice.svelte";
import type { CanvasReviewController } from "./_lib/review-controller.svelte";

let { controller }: { controller: CanvasReviewController } = $props();
</script>

{#if controller.arranging}
	<div class="arranging" role="status" data-testid="canvas-arranging">
		<Sparkles size={14} strokeWidth={2} class="arranging-icon" aria-hidden="true" />
		<span class="arranging-text">
			{controller.arranging.label
				? $t('artifacts.canvas.arrangingSummary', { summary: controller.arranging.label })
				: $t('artifacts.canvas.arranging')}
		</span>
	</div>
{/if}

{#if controller.refusal}
	<div class="card">
		<RefusalNotice
			message={controller.refusal.message}
			items={controller.refusal.items}
			seeChangeLabel={controller.canSeeChange
				? $t('artifacts.document.refused.seeChange')
				: undefined}
			onSeeChange={controller.canSeeChange ? () => controller.seeChange() : undefined}
			dismissLabel={$t('artifacts.document.refused.dismiss')}
			onDismiss={() => controller.dismissRefusal()}
		/>
	</div>
{/if}

{#if controller.undoRefused}
	<div class="card">
		<RefusalNotice
			message={$t(
				controller.undoRefused === 'user_edited'
					? 'artifacts.canvas.review.undoRefused'
					: 'artifacts.canvas.review.undoFailed',
			)}
			actionLabel={$t('artifacts.canvas.review.openVersions')}
			onAction={() => controller.openHistory()}
			dismissLabel={$t('artifacts.document.refused.dismiss')}
			onDismiss={() => controller.dismissUndoRefused()}
		/>
	</div>
{/if}

<span
	class="sr-only"
	role="status"
	aria-live="polite"
	data-testid="canvas-review-live"
>{controller.announcement}</span>

<style>
	/* The notices' own stack is `pointer-events: none`; what is here is for reading and pressing. */
	.arranging {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		max-width: 100%;
		padding: 6px 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
		border-radius: var(--radius-full, 999px);
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
		color: var(--accent-text);
		font-size: var(--text-sm);
		font-weight: 600;
		pointer-events: auto;
	}

	.arranging :global(.arranging-icon) {
		flex: none;
		animation: arranging-spark 1.4s ease-in-out infinite;
	}

	.arranging-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@keyframes arranging-spark {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}

	/* The notice's own colour is a tint, made for a column of cards on the page: over a
	   board it needs a page under it, or the block and the pill behind it show through. */
	.card {
		width: min(22rem, 100%);
		pointer-events: auto;
		background-color: var(--surface-page);
		box-shadow: var(--shadow-md);
		border-radius: var(--radius-lg);
	}
</style>
