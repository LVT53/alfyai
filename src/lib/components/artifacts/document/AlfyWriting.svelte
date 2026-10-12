<script lang="ts">
/**
 * The quiet "Alfy is at work" strip above the text (Feature 2 · Artifacts, Slice 1,
 * T8; FB-6, F6, ruling 77): shown from the first thing a chat turn does to the open
 * Document (it reads it) until the change has landed in the panel, so the panel is
 * never silent while the chat's thought lines run. The wording is the board's
 * ("Alfy is arranging…") for a Document: the generic line, or the call's own
 * summary once the edit call is known. The composer-driven Ask-Alfy reply, whose
 * target block IS known synchronously, gets the OTHER in-place treatment instead
 * (`alfy-writing-decoration.ts`'s block decoration: gutter bar, dimmed text, the
 * inline tag). Purely presentational, no `@tiptap/*` import: the caller decides
 * when to mount and unmount this, and it always goes with a landed change, a
 * failed call or the end of the turn, never lingers.
 */
import { Sparkles } from "@lucide/svelte";
import { t } from "$lib/i18n";

let { summary = null }: { summary?: string | null } = $props();
</script>

<div class="alfy-writing" data-testid="alfy-writing" role="status" aria-live="polite">
	<Sparkles size={14} strokeWidth={2} class="alfy-writing-icon" aria-hidden="true" />
	<span class="alfy-writing-label">
		{summary
			? $t('artifacts.document.workingSummary', { summary })
			: $t('artifacts.document.working')}
	</span>
</div>

<style>
	/* One quiet line, a hairline under it: the strip makes room for itself (the slot
	   around it slides) and the text moves with it, never under it. */
	.alfy-writing {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.875rem;
		border-bottom: 1px solid var(--border-subtle);
		background-color: color-mix(in srgb, var(--accent-fill) 5%, var(--surface-page));
		color: var(--accent-text);
		font-size: var(--text-xs);
	}

	.alfy-writing-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.alfy-writing :global(.alfy-writing-icon) {
		flex: 0 0 auto;
		animation: alfy-writing-spark 1.4s ease-in-out infinite;
	}

	@keyframes alfy-writing-spark {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}
</style>
