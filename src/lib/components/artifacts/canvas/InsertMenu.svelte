<script lang="ts">
/**
 * The rows of the Insert menu: what a reader can put on the board, in two
 * groups (what they write, and blocks that carry content of their own), as a
 * menu with one tab stop and arrow keys between the rows. The popover or sheet
 * around it, its Escape and its focus return belong to `AnchoredPopover`.
 */
import { t, type I18nKey } from "$lib/i18n";
import type { BlockRegistryEntry } from "./_lib/block-registry";
import { insertableEntries } from "./_lib/block-registry";

let { onpick }: { onpick: (row: BlockRegistryEntry) => void } = $props();

const rows = insertableEntries();
const groups = [
	rows.filter((row) => row.section === "text"),
	rows.filter((row) => row.section === "blocks"),
].filter((group) => group.length > 0);

let active = $state(0);
let items = $state<HTMLButtonElement[]>([]);

function move(to: number): void {
	const next = (to + rows.length) % rows.length;
	active = next;
	items[next]?.focus();
}

function handleKeydown(event: KeyboardEvent): void {
	const current = items.indexOf(document.activeElement as HTMLButtonElement);
	const from = current === -1 ? active : current;
	if (event.key === "ArrowDown" || event.key === "ArrowRight") {
		event.preventDefault();
		move(from + 1);
	} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
		event.preventDefault();
		move(from - 1);
	} else if (event.key === "Home") {
		event.preventDefault();
		move(0);
	} else if (event.key === "End") {
		event.preventDefault();
		move(rows.length - 1);
	}
}
</script>

<!-- The keys are the menu's own: the rows are the buttons that take them. -->
<div
	class="insert-menu"
	role="menu"
	tabindex="-1"
	aria-label={$t("artifacts.canvas.insert.block")}
	data-testid="canvas-insert-menu-list"
	onkeydown={handleKeydown}
>
	{#each groups as group, groupIndex (groupIndex)}
		<div class="insert-menu__group" role="group">
			{#each group as row (row.kind)}
				{@const index = rows.indexOf(row)}
				{@const Icon = row.icon}
				<button
					type="button"
					role="menuitem"
					class="insert-menu__row"
					tabindex={index === active ? 0 : -1}
					data-testid="canvas-insert-{row.kind}"
					bind:this={items[index]}
					onfocus={() => (active = index)}
					onclick={() => onpick(row)}
				>
					<Icon size={16} strokeWidth={1.75} aria-hidden="true" />
					<span>{$t(row.labelKey as I18nKey)}</span>
				</button>
			{/each}
		</div>
	{/each}
</div>

<style>
	.insert-menu {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 0 6px 6px;
	}

	.insert-menu__group {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
	}

	.insert-menu__group + .insert-menu__group {
		padding-top: 4px;
		border-top: 1px solid var(--border-subtle);
	}

	.insert-menu__row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 7px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-md);
		text-align: left;
		cursor: pointer;
	}

	.insert-menu__row:hover {
		background: var(--surface-elevated);
	}

	.insert-menu__row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	@media (pointer: coarse) {
		.insert-menu__row {
			min-height: 44px;
		}
	}
</style>
