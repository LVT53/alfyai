<script lang="ts">
/**
 * The fold at the end of a comment list for threads whose anchor is gone (the
 * Document's "comments on text that was removed", the Canvas's "comments on a
 * block that was removed"): they have nowhere to sit beside, so they wait in
 * their own labelled section, collapsed by default. A CSS-only height reveal
 * (`grid-template-rows`), so it inherits the reduced-motion collapse app.css
 * already applies to every `transition` (§7.3: "instant").
 */
import { ChevronRight } from "@lucide/svelte";
import type { Snippet } from "svelte";

let {
	label,
	open,
	ontoggle,
	children,
}: {
	/** The toggle's text, already localised (it carries the count). */
	label: string;
	open: boolean;
	ontoggle: () => void;
	children: Snippet;
} = $props();
</script>

<div class="margin-panel-orphaned-group" data-testid="margin-orphaned-group">
	<button
		type="button"
		class="margin-panel-orphaned-toggle"
		class:is-open={open}
		aria-expanded={open}
		onclick={ontoggle}
	>
		<ChevronRight
			size={14}
			strokeWidth={2}
			class="margin-panel-orphaned-chevron"
			aria-hidden="true"
		/>
		{label}
	</button>
	<div class="comment-thread-collapsible" class:is-expanded={open}>
		<div class="comment-thread-collapsible-inner">
			{#if open}
				<div class="margin-panel-orphaned-list">
					{@render children()}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.margin-panel-orphaned-group {
		display: flex;
		flex-direction: column;
		flex: 0 0 auto;
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border-subtle);
	}

	.margin-panel-orphaned-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		position: relative;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		padding: 0.375rem 0.25rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.78125rem;
		text-align: left;
		cursor: pointer;
		transition:
			color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out);
	}

	.margin-panel-orphaned-toggle:hover {
		color: var(--text-primary);
		background-color: var(--surface-elevated);
	}

	.margin-panel-orphaned-toggle:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	:global(.margin-panel-orphaned-chevron) {
		flex-shrink: 0;
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.margin-panel-orphaned-toggle.is-open :global(.margin-panel-orphaned-chevron) {
		transform: rotate(90deg);
	}

	.comment-thread-collapsible {
		display: grid;
		grid-template-rows: 0fr;
		overflow: hidden;
		transition: grid-template-rows var(--duration-emphasis) var(--ease-emphasis);
	}

	.comment-thread-collapsible.is-expanded {
		grid-template-rows: 1fr;
	}

	.comment-thread-collapsible-inner {
		min-height: 0;
	}

	/* The fold clips (`overflow: hidden` on the collapsible), so the list keeps a
	   few pixels of its own on both sides: an active card's shift towards the
	   text and its shadow must not be cut off by it. */
	.margin-panel-orphaned-list {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0.5rem 0.375rem 0.5rem;
	}

	/* Phone sheet: nothing that is tapped is smaller than 44px (§3.4). */
	@media (max-width: 767px) {
		.margin-panel-orphaned-toggle::after {
			content: '';
			position: absolute;
			inset: -0.875rem -0.5rem;
		}

		.margin-panel-orphaned-toggle {
			min-height: 44px;
			align-items: center;
		}
	}
</style>
