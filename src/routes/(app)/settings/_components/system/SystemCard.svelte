<script lang="ts">
import type { Snippet } from "svelte";
import "./system.css";

let {
	title,
	description = "",
	id = undefined,
	testId = undefined,
	flush = false,
	actions = undefined,
	children,
}: {
	title: string;
	description?: string;
	id?: string | undefined;
	testId?: string | undefined;
	flush?: boolean;
	actions?: Snippet | undefined;
	children: Snippet;
} = $props();
</script>

<section class="sys-card" class:sys-card-flush={flush} {id} data-testid={testId}>
	<div class="sys-card-head">
		<span class="sys-grow">
			<h3 class="sys-card-title">{title}</h3>
			{#if description}
				<p class="sys-card-desc">{description}</p>
			{/if}
		</span>
		{#if actions}
			<span class="sys-card-actions">{@render actions()}</span>
		{/if}
	</div>
	{@render children()}
</section>
