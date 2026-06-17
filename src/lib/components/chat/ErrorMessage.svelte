<script lang="ts">
import { t } from "$lib/i18n";
import { AlertCircle, X } from "@lucide/svelte";

let {
	error,
	onRetry,
	onClose,
}: {
	error: string;
	onRetry: () => void;
	onClose: () => void;
} = $props();
</script>

<div class="error-toast" role="alert" aria-live="assertive">
	<div class="error-icon">
		<AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
	</div>
	<div class="error-content">
		<p class="error-message">{error}</p>
	</div>
	<div class="error-actions">
		<button type="button" class="error-retry" onclick={onRetry}>
			{$t('common.retry')}
		</button>
		<button type="button" class="error-close" onclick={onClose} aria-label={$t('common.close')}>
			<X size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
</div>

<style>
	.error-toast {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		margin-bottom: var(--space-lg);
		padding: var(--space-md);
		background: color-mix(in srgb, var(--danger) 12%, var(--surface-elevated) 88%);
		border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--border-default) 70%);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		animation: errorSlideIn var(--duration-standard) var(--ease-out);
	}

	.error-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--danger);
	}

	.error-content {
		flex: 1;
		min-width: 0;
	}

	.error-message {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-primary);
	}

	.error-actions {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-shrink: 0;
	}

	.error-retry {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1;
		font-weight: 500;
		min-height: 28px;
		padding: var(--space-xs) var(--space-sm);
		background: var(--danger);
		color: white;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.error-retry:hover {
		background: var(--danger-hover);
		transform: translateY(-1px);
	}

	.error-retry:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.error-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--icon-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.error-close:hover {
		background: color-mix(in srgb, var(--danger) 20%, transparent 80%);
		color: var(--danger);
	}

	.error-close:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@keyframes errorSlideIn {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.error-toast {
			animation: none;
		}
	}
</style>
