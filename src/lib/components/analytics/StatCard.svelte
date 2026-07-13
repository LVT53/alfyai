<script lang="ts">
import "./analytics.css";

interface StatCardProps {
	/** Primary figure (already formatted). */
	value: string | number;
	/** Caption under the value. */
	label: string;
	/** Emphasize as the headline stat (accent border + larger accent value). */
	hero?: boolean;
	/** Optional secondary line (e.g. "▲ 12% vs June 2026"). */
	comparison?: string;
}

let { value, label, hero = false, comparison }: StatCardProps = $props();
</script>

<div class={hero ? "stat-card--hero" : "stat-card"}>
	<div class={hero ? "stat-value-hero" : "stat-value"}>{value}</div>
	<div class="stat-label">{label}</div>
	{#if comparison}
		<div class="stat-comparison">{comparison}</div>
	{/if}
</div>
