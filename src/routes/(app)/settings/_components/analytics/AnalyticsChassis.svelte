<script lang="ts">
// The shared chassis. Personal analytics and system analytics used to be two
// files that disagreed about almost everything they share — five equal stat
// tiles against six, a line chart against a bar chart, a comparison line that
// meant something different in each. Both now sit on one grammar: a card with
// a title, the controls that narrow it, its tabs, and a body that goes hero
// number → split bar → tiles → chart → table.
//
// The chassis owns the shell and the order; the variants supply the content,
// so nothing either of them had is dropped in the move.
import type { Snippet } from "svelte";
import "$lib/components/analytics/analytics.css";

let {
	title,
	description = "",
	controls = undefined,
	filters = undefined,
	tabs = undefined,
	children,
}: {
	title: string;
	description?: string;
	/** Month navigator and anything else that belongs on the title row. */
	controls?: Snippet;
	/** Select filters and toggles, on their own row beneath the title. */
	filters?: Snippet;
	/** The tab strip (a PageSwitcher — never a bespoke one). */
	tabs?: Snippet;
	children: Snippet;
} = $props();
</script>

<section class="settings-card analytics-chassis">
	<header class="analytics-chassis-head">
		<div class="analytics-chassis-titles">
			<h3 class="analytics-chassis-title">{title}</h3>
			{#if description}
				<p class="analytics-chassis-description">{description}</p>
			{/if}
		</div>
		{#if controls}
			<div class="analytics-chassis-controls">{@render controls()}</div>
		{/if}
	</header>

	{#if filters}
		<div class="analytics-chassis-filters">{@render filters()}</div>
	{/if}

	{#if tabs}
		<div class="analytics-chassis-tabs">{@render tabs()}</div>
	{/if}

	{@render children()}
</section>

<style>
	.analytics-chassis-head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.analytics-chassis-titles {
		min-width: 0;
	}

	.analytics-chassis-title {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.analytics-chassis-description {
		margin: 0.15rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.72rem;
		color: var(--text-muted);
	}

	.analytics-chassis-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.analytics-chassis-filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.75rem;
	}

	.analytics-chassis-tabs {
		margin-bottom: 0.9rem;
	}
</style>
