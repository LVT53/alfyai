<script lang="ts">
/**
 * The planned-section shimmer (Feature 2 · Artifacts, Slice 1, T8): shown at
 * a block's position while a tool call that targets it is in flight
 * (`slice-1.md` §UI states, "Alfy writing"). Purely presentational, no
 * `@tiptap/*` import — the caller (whatever knows a tool call started, and
 * against which block) decides when to mount and unmount this, and always
 * replaces it with real content rather than leaving it behind once the call
 * settles (T8.6).
 */
import { t } from "$lib/i18n";

let { label }: { label: string } = $props();
</script>

<div class="alfy-writing" data-testid="alfy-writing" aria-live="polite">
	<span class="alfy-writing-shimmer" aria-hidden="true"></span>
	<span class="alfy-writing-label">
		{$t('artifacts.document.planned.writing', { label })}
	</span>
</div>

<style>
	.alfy-writing {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-md);
		background-color: var(--surface-elevated);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.alfy-writing-shimmer {
		flex: 0 0 auto;
		width: 1rem;
		height: 1rem;
		border-radius: var(--radius-full, 999px);
		background: linear-gradient(
			90deg,
			var(--surface-page) 25%,
			var(--border-subtle) 50%,
			var(--surface-page) 75%
		);
		background-size: 200% 100%;
		animation: alfy-writing-shimmer var(--duration-emphasis, 1.2s) ease-in-out infinite;
	}

	.alfy-writing-label {
		font-style: italic;
	}

	@keyframes alfy-writing-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
</style>
