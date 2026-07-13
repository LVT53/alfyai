<script lang="ts">
import type { Snippet } from "svelte";
import "./analytics.css";

interface AnalyticsCardProps {
	/** Optional heading rendered at the top of the card. */
	title?: string;
	/** Optional header content (right-aligned controls, month nav, etc.). */
	header?: Snippet;
	/** Card body. */
	children?: Snippet;
}

let { title, header, children }: AnalyticsCardProps = $props();
</script>

<section class="settings-card">
	{#if title || header}
		<header class="mb-4 flex items-center justify-between gap-3">
			{#if title}
				<h3 class="text-[0.9375rem] font-semibold text-text-primary">
					{title}
				</h3>
			{/if}
			{#if header}
				<div class="flex items-center gap-2">
					{@render header()}
				</div>
			{/if}
		</header>
	{/if}
	{@render children?.()}
</section>
