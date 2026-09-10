<script lang="ts">
// Connections redesign — a small labelled disclosure that animates open AND
// closed, for the things that should be reachable without being in the way:
// a provider's raw error string ("What went wrong?"), the GitHub wizard's
// custom-server field.
//
// Applied as `transition:` rather than `in:` so closing plays too, and
// wrapped in reducedMotionAware because Svelte's css transitions interpolate
// styles directly and the app-wide reduced-motion CSS override cannot reach
// them.
import { ChevronRight } from "@lucide/svelte";
import type { Snippet } from "svelte";
import { slide } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";

let {
	label,
	open = $bindable(false),
	children,
	testId,
}: {
	label: string;
	open?: boolean;
	children: Snippet;
	testId?: string;
} = $props();

const bodySlide = reducedMotionAware(slide);
// $props.id() rather than a random string: the settings page is server
// rendered, and a random id differs between the server's HTML and the
// client's first render, so `aria-controls` would mismatch on hydration.
const uid = $props.id();
const bodyId = `disclosure-${uid}`;
</script>

<div class="disclosure">
	<button
		type="button"
		class="disclosure-trigger"
		aria-expanded={open}
		aria-controls={bodyId}
		data-testid={testId}
		onclick={() => (open = !open)}
	>
		<span class="disclosure-chevron" class:open aria-hidden="true">
			<ChevronRight size={13} strokeWidth={2.2} />
		</span>
		{label}
	</button>
	{#if open}
		<div id={bodyId} class="disclosure-body" transition:bodySlide={{ duration: 180 }}>
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.disclosure-trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.375rem 0.25rem 0.125rem;
		border: none;
		background: transparent;
		border-radius: var(--radius-md);
		font-size: 0.75rem;
		color: var(--text-secondary);
		cursor: pointer;
		transition: color var(--duration-standard);
	}

	.disclosure-trigger:hover {
		color: var(--text-primary);
	}

	.disclosure-trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.disclosure-chevron {
		display: inline-flex;
		transition: transform var(--duration-standard) var(--ease-out, ease);
	}

	.disclosure-chevron.open {
		transform: rotate(90deg);
	}

	.disclosure-body {
		padding-top: 0.375rem;
	}
</style>
