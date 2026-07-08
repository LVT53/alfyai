<script lang="ts">
import { Info } from "@lucide/svelte";

let {
	text,
	label = undefined,
	size = 15,
}: {
	text: string;
	label?: string | undefined;
	size?: number;
} = $props();

let open = $state(false);
let tooltipId = `info-tooltip-${Math.random().toString(36).slice(2, 9)}`;

function show() {
	open = true;
}

function hide() {
	open = false;
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && open) {
		event.stopPropagation();
		hide();
	}
}
</script>

<span class="info-tooltip">
	<button
		type="button"
		class="btn-icon-bare info-tooltip-trigger h-7 w-7 min-h-0 min-w-0 cursor-help rounded-full text-icon-muted hover:text-text-primary"
		aria-label={label ?? text}
		aria-describedby={open ? tooltipId : undefined}
		aria-expanded={open}
		onmouseenter={show}
		onmouseleave={hide}
		onfocus={show}
		onblur={hide}
		onkeydown={onKeydown}
	>
		<Info size={size} strokeWidth={2.1} aria-hidden="true" />
	</button>
	{#if open}
		<span id={tooltipId} role="tooltip" class="info-tooltip-bubble">
			{text}
		</span>
	{/if}
</span>

<style>
	.info-tooltip {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.info-tooltip-bubble {
		position: absolute;
		top: calc(100% + 0.4rem);
		left: 50%;
		transform: translateX(-50%);
		z-index: 60;
		width: max-content;
		max-width: min(18rem, 78vw);
		padding: 0.5rem 0.65rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		color: var(--text-primary);
		font-size: 0.75rem;
		line-height: 1.45;
		font-weight: 400;
		text-align: left;
		white-space: normal;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
		pointer-events: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.info-tooltip-trigger {
			transition: none;
		}
	}
</style>
