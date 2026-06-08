<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<script lang="ts">
	import type { ArtifactSummary } from '$lib/types';
import { FileText, X } from '@lucide/svelte';

	let {
		attachment,
		removable = false,
		variant = 'compact',
		viewable = false,
		onRemove,
		onView,
	}: {
		attachment: ArtifactSummary;
		removable?: boolean;
		variant?: 'compact' | 'pending';
		viewable?: boolean;
		onRemove?: (payload: { id: string }) => void;
		onView?: (attachment: ArtifactSummary) => void;
	} = $props();

	function handleRemove() {
		onRemove?.({ id: attachment.id });
	}

	function handleClick() {
		if (viewable && onView) {
			onView(attachment);
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (viewable && onView && (event.key === 'Enter' || event.key === ' ')) {
			event.preventDefault();
			onView(attachment);
		}
	}
</script>

<div
	class="file-attachment"
	class:compact={variant === 'compact'}
	class:pending={variant === 'pending'}
	class:viewable={viewable && onView}
	role={viewable && onView ? 'button' : 'listitem'}
	onclick={handleClick}
	onkeydown={handleKeydown}
	tabindex={viewable && onView ? 0 : undefined}
	aria-label={viewable && onView ? `View ${attachment.name}` : undefined}
>
	<span class="file-icon">
		<FileText size={16} strokeWidth={2} aria-hidden="true" />
	</span>
	<span class="filename">{attachment.name}</span>
	{#if removable}
		<button
			type="button"
			class="remove-button"
			onclick={handleRemove}
			aria-label={`Remove ${attachment.name}`}
		>
			<X size={14} strokeWidth={2} aria-hidden="true" />
		</button>
	{/if}
</div>

<style lang="postcss">
	.file-attachment {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		max-width: 100%;
	}

	.compact {
		border-radius: 1.2rem;
		border: 1px solid var(--border-default);
		background-color: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
		padding: var(--space-sm) var(--space-md);
	}

	.pending {
		border-radius: 1.2rem;
		border: 1px solid var(--border-default);
		background-color: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
		padding: var(--space-sm) var(--space-md);
		animation: borderPulse 2s ease-in-out infinite;
	}

	.viewable {
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.viewable:hover {
		background-color: color-mix(in srgb, var(--surface-page) 70%, var(--surface-elevated) 30%);
		border-color: var(--accent);
	}

	.viewable:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@keyframes borderPulse {
		0%,
		100% {
			border-color: var(--border-default);
		}
		50% {
			border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		}
	}

	.file-icon {
		flex-shrink: 0;
		color: var(--icon-muted);
	}

	.filename {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.875rem; /* text-sm */
		line-height: 1.25;
		color: var(--text-primary);
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.remove-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		margin: -8px;
		background-color: transparent;
		border: none;
		border-radius: var(--radius-md);
		color: var(--icon-muted);
		cursor: pointer;
		transition:
			color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
		outline: none;
	}

	.remove-button:hover {
		color: var(--icon-primary);
		background-color: color-mix(in srgb, var(--surface-overlay) 50%, transparent);
	}

	.remove-button:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.remove-button:active {
		transform: scale(0.92);
	}

	@media (prefers-reduced-motion: reduce) {
		.pending {
			animation: none;
		}

		.remove-button {
			transition: none;
		}
	}
</style>
