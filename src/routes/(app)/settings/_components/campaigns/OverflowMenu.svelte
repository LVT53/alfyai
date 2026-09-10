<script module lang="ts">
import type { EllipsisVertical } from "@lucide/svelte";

export type OverflowMenuItem = {
	id: string;
	label: string;
	icon?: typeof EllipsisVertical;
	danger?: boolean;
	disabled?: boolean;
	/** Draws the attention dot — used for unmet checklist rules. */
	attention?: boolean;
	separatorBefore?: boolean;
	onSelect: () => void;
};
</script>

<script lang="ts">
// Imported under a second name: the module block above only needs the icon's
// *type*, and Svelte forbids the same identifier in both script scopes.
import { EllipsisVertical as EllipsisIcon } from "@lucide/svelte";
import { scale } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";

// Opens AND closes with the app's standard dialog motion, collapsed to zero
// under prefers-reduced-motion by the shared wrapper.
const menuScale = reducedMotionAware(scale);

let {
	label,
	items,
	triggerLabel,
	attention = false,
	disabled = false,
	align = "right",
	testId = undefined,
}: {
	/** Small caps heading inside the menu, e.g. "Slide". */
	label: string;
	items: OverflowMenuItem[];
	/** Accessible name of the ⋯ trigger. */
	triggerLabel: string;
	attention?: boolean;
	disabled?: boolean;
	align?: "left" | "right";
	testId?: string | undefined;
} = $props();

let open = $state(false);
let root = $state<HTMLDivElement | null>(null);

function toggle() {
	open = !open;
}

function close() {
	open = false;
}

function select(item: OverflowMenuItem) {
	if (item.disabled) return;
	close();
	item.onSelect();
}

function handleWindowPointerDown(event: PointerEvent) {
	if (!open) return;
	const target = event.target;
	if (target instanceof Node && root?.contains(target)) return;
	close();
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (!open || event.key !== "Escape") return;
	event.stopPropagation();
	close();
}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div class="overflow-menu" bind:this={root}>
	<button
		type="button"
		class="menu-trigger"
		class:menu-trigger-open={open}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label={triggerLabel}
		title={triggerLabel}
		{disabled}
		data-testid={testId}
		onclick={toggle}
	>
		<EllipsisIcon size={15} strokeWidth={2} aria-hidden="true" />
		{#if attention}
			<span class="attention-dot" aria-hidden="true"></span>
		{/if}
	</button>

	{#if open}
		<div
			class="menu"
			class:menu-left={align === 'left'}
			role="menu"
			aria-label={label}
			transition:menuScale={{ duration: 130, start: 0.96 }}
		>
			<!-- role="menu" only admits menuitems and separators, so the visible
			     group heading is hidden from the tree; aria-label above carries
			     the same word. -->
			<p class="menu-head" aria-hidden="true">{label}</p>
			{#each items as item (item.id)}
				{#if item.separatorBefore}
					<span class="menu-separator" role="separator"></span>
				{/if}
				{@const Icon = item.icon}
				<button
					type="button"
					role="menuitem"
					class="menu-item"
					class:menu-item-danger={item.danger}
					disabled={item.disabled}
					onclick={() => select(item)}
				>
					{#if Icon}
						<Icon size={14} strokeWidth={2} aria-hidden="true" />
					{/if}
					<span class="menu-item-label">{item.label}</span>
					{#if item.attention}
						<span class="attention-dot attention-dot-inline" aria-hidden="true"></span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.overflow-menu {
		position: relative;
		display: inline-flex;
	}

	.menu-trigger {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 32px;
		min-height: 32px;
		padding: 0 0.35rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.menu-trigger:hover:not(:disabled),
	.menu-trigger-open {
		color: var(--text-primary);
		background: var(--surface-elevated);
		border-color: var(--border-default);
	}

	.menu-trigger:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.menu-trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.attention-dot {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 6px;
		height: 6px;
		border-radius: var(--radius-full);
		background: var(--accent);
	}

	.attention-dot-inline {
		position: static;
		margin-left: auto;
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 40;
		min-width: 15rem;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 5px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-page);
		box-shadow: var(--shadow-lg);
		transform-origin: top right;
	}

	.menu-left {
		right: auto;
		left: 0;
		transform-origin: top left;
	}

	.menu-head {
		padding: 7px 9px 3px;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		padding: 7px 9px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-primary);
		font-size: 0.8rem;
		text-align: left;
		cursor: pointer;
		transition: background var(--duration-standard) var(--ease-out);
	}

	.menu-item:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.menu-item:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.menu-item:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.menu-item-danger {
		color: var(--danger);
	}

	.menu-item-label {
		flex: 1 1 auto;
		min-width: 0;
	}

	.menu-separator {
		height: 1px;
		margin: 4px 2px;
		background: var(--border-subtle);
	}
</style>
