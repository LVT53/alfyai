<script lang="ts">
// Connections redesign — the head of every connect-wizard variant: the
// provider's mark, what we are about to do, and one line saying what the
// screen is asking for.
//
// The subtitle is the point. The wizard used to open with either nothing or a
// paragraph of help text buried under the first field, so the screen's actual
// question ("Where is your mailbox?", "Which of these phones is yours?") was
// never the first thing read.
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";

let {
	provider,
	title,
	subtitle = "",
}: {
	provider: string;
	title: string;
	subtitle?: string;
} = $props();
</script>

<header class="wizard-head">
	<span class="wizard-mark">
		<BrandIcon {provider} size={19} ariaHidden />
	</span>
	<span class="wizard-text">
		<span class="wizard-title">{title}</span>
		{#if subtitle}
			<span class="wizard-subtitle">{subtitle}</span>
		{/if}
	</span>
</header>

<style>
	.wizard-head {
		display: flex;
		align-items: flex-start;
		gap: 0.6875rem;
		margin-bottom: 0.875rem;
	}

	.wizard-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.125rem;
		height: 2.125rem;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		color: var(--text-secondary);
	}

	.wizard-text {
		display: flex;
		flex-direction: column;
		gap: 0.1875rem;
		min-width: 0;
	}

	.wizard-title {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.3;
	}

	.wizard-subtitle {
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--text-secondary);
	}
</style>
