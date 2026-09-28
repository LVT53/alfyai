<script lang="ts">
/**
 * The dashed "planned section" box (Feature 2 · Artifacts, Slice 1, T8;
 * restyled for the Artifacts redesign, redesign.md §4.2 item 4/§9.2's
 * `AlfyWriting.svelte` row, Wave 2.5 Step 11): shown while a tool call is in
 * flight but no specific target block is known synchronously yet — the
 * T8-live chat-turn path (`DocumentBody.svelte`'s `alfyWritingLabel`), whose
 * own `DocumentAlfyActivity.patches` is deliberately empty while
 * `status === "running"` (`alfy-activity.ts`'s doc comment: "there is
 * nothing to mark until the call has settled"). The composer-driven Ask-Alfy
 * reply, whose target block IS known synchronously, gets the OTHER in-place
 * treatment instead — `alfy-writing-decoration.ts`'s own block decoration
 * (gutter bar, dimmed text, the inline tag), styled in `DocumentBody.svelte`.
 * Purely presentational, no `@tiptap/*` import — the caller decides when to
 * mount and unmount this, and always replaces it with real content rather
 * than leaving it behind once the call settles (T8.6).
 */
import { Sparkles } from "@lucide/svelte";
import { t } from "$lib/i18n";

let { label }: { label: string } = $props();
</script>

<div class="alfy-writing" data-testid="alfy-writing" aria-live="polite">
	<Sparkles size={14} strokeWidth={2} class="alfy-writing-icon" aria-hidden="true" />
	<span class="alfy-writing-label">
		{$t('artifacts.document.planned.writing', { label })}
	</span>
</div>

<style>
	/* Mirrors the approved mockup's `.planned` box exactly (colors mapped onto
	   this app's own tokens: `--accent` → `--accent-fill`/`--accent-text`). */
	.alfy-writing {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.25rem 0 0.875rem;
		padding: 0.75rem 0.875rem;
		border: 1.5px dashed color-mix(in srgb, var(--accent-fill) 45%, transparent);
		border-radius: 10px;
		background-color: color-mix(in srgb, var(--accent-fill) 5%, transparent);
		color: var(--accent-text);
		font-size: var(--text-sm);
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
