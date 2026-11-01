<script lang="ts">
// The small lines under a write's name: where it is, when, who gets it. A word
// only where the value does not speak for itself, and a location quieter than
// the rest, because it is a footnote to the name above it.
import type { WriteCardFactLine } from "./write-card-view";

let { facts }: { facts: WriteCardFactLine[] } = $props();
</script>

{#each facts as fact (fact.key)}
	<p class="write-fact" class:write-fact--quiet={fact.quiet}>
		{#if fact.label}
			<span class="write-fact__label">{fact.label}</span>
		{/if}
		<span class="write-fact__value">{fact.value}</span>
	</p>
{/each}

<style>
	.write-fact {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.4;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.write-fact__label {
		margin-right: 0.25rem;
		color: var(--text-muted);
	}

	.write-fact--quiet {
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}
</style>
